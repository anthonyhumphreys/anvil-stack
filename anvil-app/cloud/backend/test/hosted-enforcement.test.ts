import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type {
  ArtifactFinalizeResult,
  ArtifactReserveResult,
} from '../../contract/artifacts';
import type {
  DeviceSession,
  EnrollmentCodeIssueResult,
  SessionDescribeResult,
} from '../../contract/auth';
import type { DataExportBeginResult } from '../../contract/data';
import { isRpcError } from '../../contract/envelope';
import type { HandoffRecord } from '../../contract/handoff';
import type {
  AttemptReportResult,
  ExecutionManifest,
  JobCancelResult,
  JobClaimResult,
  JobCreateParams,
  JobCreateResult,
  JobListResult,
} from '../../contract/jobs';
import type { SyncPullResult, SyncPushResult } from '../../contract/sync';
import type { DevicePolicy, WorkerConnectResult } from '../../contract/workers';
import type { AccountCoordinator } from '../src/account-coordinator';
import {
  checkHostedAccess,
  ENTITLEMENT_CACHE_TTL_MS,
  hostedConfigIssues,
} from '../src/hosted/enforcement';
import { PREVIEW_END_MS } from '../src/hosted/policy';
import { sha256Hex } from '../src/hash';
import { expectSuccess, hashedChange, postRpc, spikeBearer, uniqueIds } from './helpers';

const ADMIN_TOKEN = 'test-admin-credential';
const DAY = 86_400_000;
const HOUR = 3_600_000;

function hostedDb(): D1Database {
  const db = env.HOSTED_DB;
  if (db === undefined) throw new Error('HOSTED_DB binding missing in test env');
  return db;
}

function accountStub(accountId: string) {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId));
}

/** Two-enrollment fixture: a source device plus a worker device, one account. */
function fixture(label: string) {
  const ids = uniqueIds(label);
  const sourceEnrollmentId = `${ids.enrollmentId}-src`;
  const workerEnrollmentId = `${ids.enrollmentId}-wrk`;
  return {
    accountId: ids.accountId,
    sourceEnrollmentId,
    workerEnrollmentId,
    sourceAuth: spikeBearer(ids.accountId, sourceEnrollmentId),
    workerAuth: spikeBearer(ids.accountId, workerEnrollmentId),
  };
}

type Fixture = ReturnType<typeof fixture>;

/**
 * Links a hosted billing account to the sync account. `previewEligible: 0`
 * with no subscription rows is the restricted state: pre-cutoff the policy
 * answers `subscription-required`, post-cutoff `preview-ended`.
 */
async function linkBilling(accountId: string, previewEligible: 0 | 1): Promise<string> {
  const now = Date.now();
  const id = `ba_${crypto.randomUUID().replaceAll('-', '')}`;
  await hostedDb()
    .prepare(
      `INSERT INTO billing_accounts
         (id, workos_client_id, workos_user_id, sync_account_id, generation,
          lifecycle, preview_eligible, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 'active', ?, ?, ?)`,
    )
    .bind(id, `client_${id}`, `user_${id}`, accountId, previewEligible, now, now)
    .run();
  return id;
}

async function addActiveSubscription(billingAccountId: string, paidThrough: number): Promise<void> {
  const now = Date.now();
  await hostedDb()
    .prepare(
      `INSERT INTO stripe_subscriptions
         (stripe_subscription_id, stripe_customer_id, billing_account_id, status,
          plan_key, interval, current_period_end, cancel_at_period_end,
          has_paid_invoice, first_failed_renewal_at, verified_at, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 'sync_personal', 'month', ?, 0, 1, NULL, ?, ?, ?)`,
    )
    .bind(
      `sub_${crypto.randomUUID().replaceAll('-', '')}`,
      `cus_${crypto.randomUUID().replaceAll('-', '')}`,
      billingAccountId,
      paidThrough,
      now,
      now,
      now,
    )
    .run();
}

/** Forces the account object's next access check past the cache TTL. */
async function expireEntitlementCache(accountId: string): Promise<void> {
  await runInDurableObject(accountStub(accountId), (_i: AccountCoordinator, state) => {
    state.storage.sql.exec('UPDATE hosted_entitlement_cache SET fetched_at = 0 WHERE id = 1');
  });
}

async function cacheRow(accountId: string): Promise<{ fetched_at: number } | null> {
  return runInDurableObject(accountStub(accountId), (_i: AccountCoordinator, state) => {
    return (
      state.storage.sql
        .exec<{ fetched_at: number }>(
          'SELECT fetched_at FROM hosted_entitlement_cache WHERE id = 1',
        )
        .toArray()[0] ?? null
    );
  });
}

/** Restrict the account now and age any previously cached decision out. */
async function restrict(accountId: string): Promise<void> {
  await linkBilling(accountId, 0);
  await expireEntitlementCache(accountId);
}

function expectForbidden(
  response: { status: number; body: Parameters<typeof isRpcError>[0] },
  reason?: string,
): void {
  expect(response.status).toBe(403);
  if (!isRpcError(response.body)) {
    throw new Error(`expected RPC error body, got ${JSON.stringify(response.body)}`);
  }
  expect(response.body.error.code).toBe('forbidden');
  if (reason !== undefined) {
    expect(response.body.error.details?.['reason']).toBe(reason);
  }
}

async function issueCode(accountId: string): Promise<EnrollmentCodeIssueResult> {
  const response = await SELF.fetch('https://spike.test/v1/enrollment-codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ accountId }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as EnrollmentCodeIssueResult;
}

async function enroll(accountId: string): Promise<DeviceSession> {
  env.ENROLLMENT_ADMIN_TOKEN = ADMIN_TOKEN;
  const issued = await issueCode(accountId);
  const response = await SELF.fetch('https://spike.test/v1/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      proof: { method: 'enrollment-code', code: issued.code },
      installationId: `install-${crypto.randomUUID()}`,
      displayName: 'Test device',
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as DeviceSession;
}

function allowJobsPolicy(): DevicePolicy {
  return {
    worker: { allowJobs: true, allowedSources: ['same-account'], maxConcurrentJobs: 2 },
  };
}

function manifest(): ExecutionManifest {
  return {
    workspaceDefinitionRevision: 'wsdef-rev-1',
    repositories: [{ repositoryId: 'repo-1', commit: '0123456789abcdef' }],
    bootstrapDigest: 'sha256:bootstrap-1',
    provider: 'codex',
    model: 'gpt-5',
    configVersions: { 'agent-settings': 'v3' },
    inputs: { workspaceId: 'ws-1' },
  };
}

interface RunningJob {
  jobId: string;
  attemptId: string;
  fence: number;
  workerIncarnation: string;
}

/** Policy + live worker + created + claimed job: the attempt is active. */
async function runningJob(f: Fixture): Promise<RunningJob> {
  expectSuccess(await postRpc('device.policy.publish', allowJobsPolicy(), f.workerAuth));
  const connected = expectSuccess<WorkerConnectResult>(
    await postRpc('worker.connect', {}, f.workerAuth),
  );
  const params: JobCreateParams = {
    requestId: crypto.randomUUID(),
    payloadHash: 'a'.repeat(64),
    kind: 'diagnostic',
    requestedTarget: { kind: 'device', enrollmentId: f.workerEnrollmentId },
    inputManifest: manifest(),
  };
  const created = expectSuccess<JobCreateResult>(
    await postRpc('job.create', params, f.sourceAuth),
  );
  const claimed = expectSuccess<JobClaimResult>(
    await postRpc('job.claim', { jobId: created.job.id }, f.workerAuth),
  );
  return {
    jobId: created.job.id,
    attemptId: claimed.attempt.id,
    fence: claimed.fence,
    workerIncarnation: connected.workerIncarnation,
  };
}

async function putArtifact(path: string, auth: string, body: Uint8Array): Promise<Response> {
  return SELF.fetch(`https://spike.test${path}`, {
    method: 'PUT',
    headers: { Authorization: auth, 'content-type': 'application/octet-stream' },
    body,
  });
}

describe('hosted enforcement — restricted account', () => {
  it('denies sync.push / job.create / artifact.reserve / handoff.create with forbidden', async () => {
    const f = fixture('restricted');
    await restrict(f.accountId);

    const change = await hashedChange({ enrollmentSequence: 1, entityId: 'ws-1' });
    const push = await postRpc('sync.push', { changes: [change] }, f.sourceAuth);
    expectForbidden(push, 'subscription-required');

    const pull = await postRpc('sync.pull', { cursor: null, maxBytes: 16384 }, f.sourceAuth);
    expect(pull.status).toBe(200);

    const created = await postRpc(
      'job.create',
      {
        requestId: crypto.randomUUID(),
        payloadHash: 'a'.repeat(64),
        kind: 'diagnostic',
        requestedTarget: { kind: 'auto' },
        inputManifest: manifest(),
      },
      f.sourceAuth,
    );
    expectForbidden(created, 'subscription-required');

    const listed = await postRpc('job.list', {}, f.sourceAuth);
    expect(listed.status).toBe(200);
    expectSuccess<JobListResult>(listed);

    const exported = await postRpc('data.export.begin', {}, f.sourceAuth);
    expect(exported.status).toBe(200);
    expect(expectSuccess<DataExportBeginResult>(exported).operationId).toMatch(/^exp_/);
  });

  it('keeps running-attempt completion available while denying renew and new work', async () => {
    const f = fixture('restricted-attempt');
    const job = await runningJob(f);
    const second = expectSuccess<JobCreateResult>(
      await postRpc(
        'job.create',
        {
          requestId: crypto.randomUUID(),
          payloadHash: 'b'.repeat(64),
          kind: 'diagnostic',
          requestedTarget: { kind: 'auto' },
          inputManifest: manifest(),
        },
        f.sourceAuth,
      ),
    );
    await restrict(f.accountId);

    const renewed = await postRpc(
      'attempt.renew',
      {
        renewals: [
          { attemptId: job.attemptId, incarnation: job.workerIncarnation, fence: job.fence },
        ],
      },
      f.workerAuth,
    );
    expectForbidden(renewed, 'subscription-required');

    const reported = expectSuccess<AttemptReportResult>(
      await postRpc(
        'attempt.report',
        {
          attemptId: job.attemptId,
          incarnation: job.workerIncarnation,
          fence: job.fence,
          outcome: 'completed',
          result: { summary: 'finished before the cutoff' },
        },
        f.workerAuth,
      ),
    );
    expect(reported.attempt.state).toBe('completed');

    const cancelled = expectSuccess<JobCancelResult>(
      await postRpc('job.cancel', { jobId: second.job.id }, f.sourceAuth),
    );
    expect(['cancelled', 'cancel-requested']).toContain(cancelled.job.state);
  });

  it('denies artifact bytes PUT and reserve, but finalizes a pre-restriction reservation', async () => {
    const f = fixture('restricted-artifact');
    const job = await runningJob(f);
    const body = new TextEncoder().encode('artifact bytes');
    const sha = await sha256Hex('artifact bytes');

    const finalizeable = expectSuccess<ArtifactReserveResult>(
      await postRpc(
        'artifact.reserve',
        {
          attemptId: job.attemptId,
          byteLength: body.byteLength,
          sha256: sha,
          mediaType: 'application/octet-stream',
          retentionDays: 7,
        },
        f.workerAuth,
      ),
    );
    const uploaded = await putArtifact(finalizeable.uploadPath, f.workerAuth, body);
    expect(uploaded.status).toBe(200);

    const blocked = expectSuccess<ArtifactReserveResult>(
      await postRpc(
        'artifact.reserve',
        {
          attemptId: job.attemptId,
          byteLength: body.byteLength,
          sha256: sha,
          mediaType: 'application/octet-stream',
          retentionDays: 7,
        },
        f.workerAuth,
      ),
    );

    await restrict(f.accountId);

    const deniedReserve = await postRpc(
      'artifact.reserve',
      {
        attemptId: job.attemptId,
        byteLength: body.byteLength,
        sha256: sha,
        mediaType: 'application/octet-stream',
        retentionDays: 7,
      },
      f.workerAuth,
    );
    expectForbidden(deniedReserve, 'subscription-required');

    // The reserved row is still open, but landing new bytes is denied.
    const deniedPut = await putArtifact(
      `/v1/artifacts/${blocked.artifactId}`,
      f.workerAuth,
      body,
    );
    expect(deniedPut.status).toBe(403);

    // …while a reservation whose bytes were already stored may publish.
    const finalized = expectSuccess<ArtifactFinalizeResult>(
      await postRpc(
        'artifact.finalize',
        { artifactId: finalizeable.artifactId, byteLength: body.byteLength, sha256: sha },
        f.workerAuth,
      ),
    );
    expect(finalized.manifest.state).toBe('published');
  });

  it('denies handoff.create while handoff.cancel and account.delete stay available', async () => {
    const f = fixture('restricted-handoff');
    await postRpc('sync.push', { changes: [] }, f.sourceAuth).then(expectSuccess);
    await postRpc('sync.push', { changes: [] }, f.workerAuth).then(expectSuccess);
    const created = expectSuccess<{ handoff: HandoffRecord }>(
      await postRpc(
        'handoff.create',
        {
          handoffId: crypto.randomUUID(),
          sessionId: `sess-${crypto.randomUUID()}`,
          sourceEnrollmentId: f.sourceEnrollmentId,
          targetEnrollmentId: f.workerEnrollmentId,
          sourceGeneration: 1,
        },
        f.sourceAuth,
      ),
    );

    await restrict(f.accountId);

    const denied = await postRpc(
      'handoff.create',
      {
        handoffId: crypto.randomUUID(),
        sessionId: `sess-${crypto.randomUUID()}`,
        sourceEnrollmentId: f.sourceEnrollmentId,
        targetEnrollmentId: f.workerEnrollmentId,
        sourceGeneration: 1,
      },
      f.sourceAuth,
    );
    expectForbidden(denied, 'subscription-required');

    const cancelled = await postRpc(
      'handoff.cancel',
      { handoffId: created.handoff.id, reason: 'user' },
      f.sourceAuth,
    );
    expect(cancelled.status).toBe(200);
  });

  it('account.delete still works on a restricted account', async () => {
    const ids = uniqueIds('restricted-delete');
    const session = await enroll(ids.accountId);
    await restrict(ids.accountId);

    const deleted = await postRpc(
      'account.delete',
      {},
      `Bearer ${session.accessToken}`,
    );
    expect(deleted.status).toBe(200);
  });
});

describe('hosted enforcement — session.describe', () => {
  it('surfaces restricted entitlement for a linked unpaid account', async () => {
    const ids = uniqueIds('describe-restricted');
    const session = await enroll(ids.accountId);
    await linkBilling(ids.accountId, 0);

    const described = await postRpc(
      'session.describe',
      {},
      `Bearer ${session.accessToken}`,
    );
    expect(described.status).toBe(200);
    const result = expectSuccess<SessionDescribeResult>(described);
    expect(result.entitlement?.state).toBe('restricted');
    expect(result.entitlement?.reason).toBe('subscription-required');
  });

  it('surfaces preview entitlement for an unlinked account', async () => {
    const ids = uniqueIds('describe-preview');
    const session = await enroll(ids.accountId);

    const described = await postRpc(
      'session.describe',
      {},
      `Bearer ${session.accessToken}`,
    );
    const result = expectSuccess<SessionDescribeResult>(described);
    expect(result.entitlement?.state).toBe('preview');
    expect(result.entitlement?.reason).toBe('preview');
  });
});

describe('hosted enforcement — paid and preview accounts', () => {
  it('allows mutating ops for a linked account with an active paid subscription', async () => {
    const f = fixture('paid');
    const billingId = await linkBilling(f.accountId, 0);
    await addActiveSubscription(billingId, Date.now() + 30 * DAY);
    await expireEntitlementCache(f.accountId);

    const change = await hashedChange({ enrollmentSequence: 1, entityId: 'ws-paid' });
    const push = await postRpc('sync.push', { changes: [change] }, f.sourceAuth);
    expect(push.status).toBe(200);
    expectSuccess<SyncPushResult>(push);

    const created = await postRpc(
      'job.create',
      {
        requestId: crypto.randomUUID(),
        payloadHash: 'c'.repeat(64),
        kind: 'diagnostic',
        requestedTarget: { kind: 'auto' },
        inputManifest: manifest(),
      },
      f.sourceAuth,
    );
    expect(created.status).toBe(200);
  });

  it('allows mutating ops for an unlinked account inside the preview window', async () => {
    const f = fixture('unlinked');
    const change = await hashedChange({ enrollmentSequence: 1, entityId: 'ws-free' });
    const push = await postRpc('sync.push', { changes: [change] }, f.sourceAuth);
    expect(push.status).toBe(200);
  });
});

describe('hosted enforcement — cache bound', () => {
  it('reuses a cached decision inside the TTL and reloads once it is stale', async () => {
    const f = fixture('cache-bound');
    const change = await hashedChange({ enrollmentSequence: 1, entityId: 'ws-cache' });
    const first = await postRpc('sync.push', { changes: [change] }, f.sourceAuth);
    expect(first.status).toBe(200);
    expect(await cacheRow(f.accountId)).not.toBeNull();

    // Flipping the billing row mid-TTL must not change the cached decision.
    await linkBilling(f.accountId, 0);
    const second = await postRpc(
      'sync.push',
      { changes: [await hashedChange({ enrollmentSequence: 2, entityId: 'ws-cache-2' })] },
      f.sourceAuth,
    );
    expect(second.status).toBe(200);

    // Aging the row past the TTL forces a reload → restricted.
    await expireEntitlementCache(f.accountId);
    const third = await postRpc(
      'sync.push',
      { changes: [await hashedChange({ enrollmentSequence: 3, entityId: 'ws-cache-3' })] },
      f.sourceAuth,
    );
    expectForbidden(third, 'subscription-required');

    // The denied decision is itself cached: flipping back inside the TTL
    // stays denied until the cache ages out.
    await hostedDb()
      .prepare('UPDATE billing_accounts SET preview_eligible = 1 WHERE sync_account_id = ?')
      .bind(f.accountId)
      .run();
    const fourth = await postRpc(
      'sync.push',
      { changes: [await hashedChange({ enrollmentSequence: 4, entityId: 'ws-cache-4' })] },
      f.sourceAuth,
    );
    expectForbidden(fourth, 'subscription-required');
  });
});

describe('checkHostedAccess — outage and deployment paths', () => {
  const throwingDb = (): D1Database =>
    ({
      prepare: () => {
        throw new Error('d1 unavailable');
      },
    }) as unknown as D1Database;

  function enforcementEnv(db: D1Database | undefined): Env {
    return { HOSTED_DB: db, HOSTED_BILLING_ENFORCEMENT: 'true' } as unknown as Env;
  }

  it('is inert with no HOSTED_DB (self-host) or with the flag off', async () => {
    const storage = {} as DurableObjectStorage;
    const selfHost = await checkHostedAccess(
      storage,
      { HOSTED_BILLING_ENFORCEMENT: 'true' } as unknown as Env,
      'acct-anything',
      Date.now(),
    );
    expect(selfHost.allowed).toBe(true);
    expect(selfHost.entitlement).toBeNull();

    const flagOff = await checkHostedAccess(
      storage,
      { HOSTED_DB: throwingDb() } as unknown as Env,
      'acct-anything',
      Date.now(),
    );
    expect(flagOff.allowed).toBe(true);
  });

  it('serves bounded outage grace from a paid cache entry', async () => {
    const ids = uniqueIds('outage-paid');
    const now = Date.now();
    const paidThrough = now - HOUR; // expired an hour ago
    await runInDurableObject(accountStub(ids.accountId), async (_i: AccountCoordinator, state) => {
      state.storage.sql.exec(
        `INSERT INTO hosted_entitlement_cache
           (id, state, source, reason, access_until, paid_through, revision, fetched_at)
         VALUES (1, 'active', 'subscription', 'paid', ?, ?, 1, ?)`,
        paidThrough,
        paidThrough,
        now - ENTITLEMENT_CACHE_TTL_MS - 1_000,
      );
      const access = await checkHostedAccess(
        state.storage,
        enforcementEnv(throwingDb()),
        ids.accountId,
        now,
      );
      expect(access.allowed).toBe(true);
      expect(access.entitlement?.state).toBe('grace');
      expect(access.entitlement?.source).toBe('outage-grace');
      expect(access.entitlement?.reason).toBe('billing-outage');
      expect(Date.parse(access.entitlement?.accessUntil ?? '')).toBe(
        paidThrough + 24 * HOUR,
      );
    });
  });

  it('denies when the paid cache is past its 24h outage bound', async () => {
    const ids = uniqueIds('outage-expired');
    const now = Date.now();
    const paidThrough = now - 25 * HOUR;
    await runInDurableObject(accountStub(ids.accountId), async (_i: AccountCoordinator, state) => {
      state.storage.sql.exec(
        `INSERT INTO hosted_entitlement_cache
           (id, state, source, reason, access_until, paid_through, revision, fetched_at)
         VALUES (1, 'active', 'subscription', 'paid', ?, ?, 1, ?)`,
        paidThrough,
        paidThrough,
        now - ENTITLEMENT_CACHE_TTL_MS - 1_000,
      );
      const access = await checkHostedAccess(
        state.storage,
        enforcementEnv(throwingDb()),
        ids.accountId,
        now,
      );
      expect(access.allowed).toBe(false);
      if (!access.allowed) {
        expect(access.reason).toBe('billing-unavailable');
        expect(access.entitlement?.state).toBe('unknown');
      }
    });
  });

  it('never extends a preview cache entry past the absolute cutoff', async () => {
    const ids = uniqueIds('outage-preview');
    const now = Date.now();
    await runInDurableObject(accountStub(ids.accountId), async (_i: AccountCoordinator, state) => {
      state.storage.sql.exec(
        `INSERT INTO hosted_entitlement_cache
           (id, state, source, reason, access_until, paid_through, revision, fetched_at)
         VALUES (1, 'preview', 'preview', 'preview', ?, NULL, 0, ?)`,
        PREVIEW_END_MS,
        now - ENTITLEMENT_CACHE_TTL_MS - 1_000,
      );
      const env = enforcementEnv(throwingDb());
      // Pre-cutoff the cached absolute deadline still allows.
      const before = await checkHostedAccess(state.storage, env, ids.accountId, now);
      expect(before.allowed).toBe(true);
      expect(before.entitlement?.state).toBe('preview');
      // Simulated post-cutoff: the outage does not extend preview access.
      const after = await checkHostedAccess(
        state.storage,
        env,
        ids.accountId,
        PREVIEW_END_MS + 1,
      );
      expect(after.allowed).toBe(false);
    });
  });

  it('denies unknown when billing is down and nothing is cached', async () => {
    const ids = uniqueIds('outage-empty');
    await runInDurableObject(accountStub(ids.accountId), async (_i: AccountCoordinator, state) => {
      const access = await checkHostedAccess(
        state.storage,
        enforcementEnv(throwingDb()),
        ids.accountId,
        Date.now(),
      );
      expect(access.allowed).toBe(false);
      if (!access.allowed) {
        expect(access.reason).toBe('billing-unavailable');
        expect(access.entitlement?.state).toBe('unknown');
      }
    });
  });
});

describe('hostedConfigIssues', () => {
  it('is quiet when enforcement is off and lists missing bindings when on', () => {
    expect(hostedConfigIssues({} as unknown as Env)).toEqual([]);
    expect(
      hostedConfigIssues({ HOSTED_BILLING_ENFORCEMENT: 'true' } as unknown as Env),
    ).toEqual(['HOSTED_DB', 'HOSTED_SERVICE_KEYS']);
    expect(
      hostedConfigIssues({
        HOSTED_BILLING_ENFORCEMENT: 'true',
        HOSTED_DB: hostedDb(),
      } as unknown as Env),
    ).toEqual(['HOSTED_SERVICE_KEYS']);
  });
});
