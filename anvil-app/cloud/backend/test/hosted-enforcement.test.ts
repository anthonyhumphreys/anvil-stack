import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import type { HostedEntitlement } from '../../contract/entitlements';
import type { ExecutionManifest, JobCreateParams, JobCreateResult } from '../../contract/jobs';
import type { SyncPushResult } from '../../contract/sync';
import type { AccountCoordinator } from '../src/account-coordinator';
import { checkHostedAccess, hostedConfigIssues, resolveAccountEntitlement } from '../src/hosted/enforcement';
import { PREVIEW_END_MS } from '../src/hosted/policy';
import { expectSuccess, hashedChange, postRpc, spikeBearer, uniqueIds } from './helpers';

const DAY = 86_400_000;

function hostedDb(): D1Database {
  const db = env.HOSTED_DB;
  if (db === undefined) throw new Error('HOSTED_DB binding missing in test env');
  return db;
}

function fixture(label: string) {
  const ids = uniqueIds(label);
  const enrollmentId = `${ids.enrollmentId}-source`;
  return {
    accountId: ids.accountId,
    enrollmentId,
    auth: spikeBearer(ids.accountId, enrollmentId),
  };
}

async function linkBillingAccount(accountId: string, lifecycle = 'active'): Promise<string> {
  const now = Date.now();
  const id = `ba_${crypto.randomUUID().replaceAll('-', '')}`;
  await hostedDb()
    .prepare(
      `INSERT INTO billing_accounts
         (id, workos_client_id, workos_user_id, sync_account_id, generation,
          lifecycle, preview_eligible, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, 0, ?, ?)`,
    )
    .bind(id, `client_${id}`, `user_${id}`, accountId, lifecycle, now, now)
    .run();
  return id;
}

async function addLegacySubscription(
  billingAccountId: string,
  status: 'active' | 'past_due' | 'canceled' | 'unpaid' | 'incomplete',
): Promise<void> {
  const now = Date.now();
  await hostedDb()
    .prepare(
      `INSERT INTO stripe_subscriptions
         (stripe_subscription_id, stripe_customer_id, billing_account_id, status,
          plan_key, interval, current_period_end, paid_through, paid_seat_quantity,
          cancel_at_period_end, has_paid_invoice, first_failed_renewal_at,
          verified_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'sync_personal', 'month', ?, ?, 1, 0, 1, NULL, ?, ?, ?)`,
    )
    .bind(
      `sub_${crypto.randomUUID().replaceAll('-', '')}`,
      `cus_${crypto.randomUUID().replaceAll('-', '')}`,
      billingAccountId,
      status,
      now - DAY,
      now - DAY,
      now,
      now,
      now,
    )
    .run();
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

function expectForbidden(response: { status: number; body: unknown }, reason: string): void {
  expect(response.status).toBe(403);
  expect(response.body).toMatchObject({ error: { code: 'forbidden', details: { reason } } });
}

describe('hosted Sync and Mesh access', () => {
  it('allows writes after preview expiry with a canceled legacy Sync subscription', async () => {
    const f = fixture('free-after-preview');
    const billingAccountId = await linkBillingAccount(f.accountId);
    await addLegacySubscription(billingAccountId, 'canceled');
    const now = PREVIEW_END_MS + DAY;
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const change = await hashedChange({ enrollmentSequence: 1, entityId: 'ws-free' });
      const pushed = expectSuccess<SyncPushResult>(
        await postRpc('sync.push', { changes: [change] }, f.auth),
      );
      expect(pushed.results[0]?.status).toBe('accepted');

      const params: JobCreateParams = {
        requestId: crypto.randomUUID(),
        payloadHash: 'a'.repeat(64),
        kind: 'diagnostic',
        requestedTarget: { kind: 'auto' },
        inputManifest: manifest(),
      };
      const created = expectSuccess<JobCreateResult>(await postRpc('job.create', params, f.auth));
      expect(created.job.state).toBe('queued');

      const targetEnrollmentId = `${f.enrollmentId}-target`;
      expectSuccess(
        await postRpc(
          'sync.push',
          { changes: [] },
          spikeBearer(f.accountId, targetEnrollmentId),
        ),
      );
      expectSuccess(
        await postRpc(
          'handoff.create',
          {
            handoffId: crypto.randomUUID(),
            sessionId: `session-${crypto.randomUUID()}`,
            sourceEnrollmentId: f.enrollmentId,
            targetEnrollmentId,
            sourceGeneration: 1,
          },
          f.auth,
        ),
      );
    } finally {
      dateNow.mockRestore();
    }
  });

  it.each(['active', 'past_due', 'canceled', 'unpaid', 'incomplete'] as const)(
    'returns free capabilities for legacy subscription status %s',
    async (status) => {
      const ids = uniqueIds(`legacy-${status}`);
      const billingAccountId = await linkBillingAccount(ids.accountId);
      await addLegacySubscription(billingAccountId, status);
      const future = PREVIEW_END_MS + DAY;
      const entitlement = await resolveAccountEntitlement(env, ids.accountId, future);
      expect(entitlement).toMatchObject({
        state: 'active',
        source: 'none',
        planKey: null,
        fundedBy: 'none',
        capabilities: { syncWrite: true, meshSubmit: true },
        accessUntil: null,
        reason: 'free',
      });
    },
  );

  it('keeps access available when billing storage is unavailable', async () => {
    const unavailableDb = {
      prepare: () => {
        throw new Error('D1 unavailable');
      },
    } as unknown as D1Database;
    const bindingEnv = env as unknown as Record<string, unknown>;
    const originalDb = bindingEnv['HOSTED_DB'];
    bindingEnv['HOSTED_DB'] = unavailableDb;
    try {
      const access = await checkHostedAccess(
        {} as DurableObjectStorage,
        { HOSTED_DB: unavailableDb, HOSTED_BILLING_ENFORCEMENT: 'true' } as unknown as Env,
        'acct-billing-outage',
        PREVIEW_END_MS + DAY,
      );
      expect(access).toEqual({ allowed: true, entitlement: null });

      // Exercise the normal mutation gates too: they must not consult D1
      // merely to authorize free Sync writes or provider-neutral Mesh jobs.
      const ids = fixture('billing-outage-writes');
      const change = await hashedChange({ enrollmentSequence: 1, entityId: 'ws-outage' });
      const pushed = expectSuccess<SyncPushResult>(
        await postRpc('sync.push', { changes: [change] }, ids.auth),
      );
      expect(pushed.results[0]?.status).toBe('accepted');

      const created = expectSuccess<JobCreateResult>(
        await postRpc(
          'job.create',
          {
            requestId: crypto.randomUUID(),
            payloadHash: 'b'.repeat(64),
            kind: 'diagnostic',
            requestedTarget: { kind: 'auto' },
            inputManifest: manifest(),
          } satisfies JobCreateParams,
          ids.auth,
        ),
      );
      expect(created.job.state).toBe('queued');
    } finally {
      bindingEnv['HOSTED_DB'] = originalDb;
    }
  });

  it('keeps operator fair-use restrictions and deletion recovery in force', async () => {
    const ids = fixture('fair-use');
    const first = await hashedChange({ enrollmentSequence: 1, entityId: 'workspace-to-delete' });
    expectSuccess<SyncPushResult>(await postRpc('sync.push', { changes: [first] }, ids.auth));
    const now = Date.now();
    await runInDurableObject(
      env.ACCOUNT.get(env.ACCOUNT.idFromName(ids.accountId)),
      (_instance: AccountCoordinator, state) => {
        state.storage.sql.exec(
          `INSERT INTO sync_meta (key, value) VALUES ('fair_use_restriction', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          JSON.stringify({
            code: 'storage-usage',
            message: 'Reduce retained data or contact support.',
            noticeAt: new Date(now - DAY).toISOString(),
            restrictAt: new Date(now - 1_000).toISOString(),
            emergency: false,
          }),
        );
      },
    );

    const blocked = await postRpc(
      'sync.push',
      { changes: [await hashedChange({ enrollmentSequence: 2, entityId: 'new-workspace' })] },
      ids.auth,
    );
    expectForbidden(blocked, 'fair-use-restricted');

    const deletion = await hashedChange({
      enrollmentSequence: 2,
      entityId: 'workspace-to-delete',
      operation: 'delete',
    });
    const removed = expectSuccess<SyncPushResult>(
      await postRpc('sync.push', { changes: [deletion] }, ids.auth),
    );
    expect(removed.results[0]?.status).toBe('accepted');
    expect((await postRpc('sync.pull', { cursor: null, maxBytes: 16384 }, ids.auth)).status).toBe(
      200,
    );
  });

  it('preserves lifecycle denial when the billing account is deleting or deleted', async () => {
    for (const lifecycle of ['deleting', 'deleted'] as const) {
      const ids = uniqueIds(`lifecycle-${lifecycle}`);
      const billingAccountId = await linkBillingAccount(ids.accountId, lifecycle);
      const entitlement = await resolveAccountEntitlement(env, ids.accountId, Date.now());
      expect(entitlement).toMatchObject({
        state: 'restricted',
        capabilities: { syncWrite: false, meshSubmit: false },
        reason: 'account-deleted',
      } satisfies Partial<HostedEntitlement>);
      expect(billingAccountId).toBeTruthy();
    }
  });
});

describe('hostedConfigIssues', () => {
  it('is quiet when device-limit enforcement is off and requires its hosted bindings when on', () => {
    expect(hostedConfigIssues({} as unknown as Env)).toEqual([]);
    expect(hostedConfigIssues({ HOSTED_BILLING_ENFORCEMENT: 'true' } as unknown as Env)).toEqual([
      'HOSTED_DB',
      'HOSTED_SERVICE_KEYS',
    ]);
    expect(
      hostedConfigIssues({
        HOSTED_BILLING_ENFORCEMENT: 'true',
        HOSTED_DB: hostedDb(),
      } as unknown as Env),
    ).toEqual(['HOSTED_SERVICE_KEYS']);
  });
});
