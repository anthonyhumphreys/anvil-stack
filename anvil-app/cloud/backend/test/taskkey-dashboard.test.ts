import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { isRpcError, type RpcResponse } from '../../contract/envelope';
import type {
  AttemptReportResult,
  ExecutionManifest,
  JobClaimResult,
  JobCreateParams,
  JobCreateResult,
  JobGetResult,
} from '../../contract/jobs';
import type {
  DashboardDecideResult,
  DashboardRequestsResult,
  DashboardRevokeResult,
  HostedDashboardStatus,
  KeyringReportResult,
} from '../../contract/dashboard';
import type {
  DashboardGrantPayload,
  SealedDashboardSnapshot,
  SealedTaskPayload,
  TaskKeyDeliverResult,
  TaskKeyPullResult,
  TaskKeyWrapPayload,
} from '../../contract/sealed';
import type { DevicePolicy, WorkerConnectResult } from '../../contract/workers';
import { expectSuccess, postRpc, spikeBearer, uniqueIds } from './helpers';

function accountStub(accountId: string) {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId));
}

/** Source device + worker device on one account, like jobs.test.ts. */
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

const SEALED_INPUTS: SealedTaskPayload = {
  enc: 'aes-256-gcm',
  nonce: btoa('0123456789ab'),
  ct: btoa('sealed-task-inputs-payload'),
};

const SEALED_RESULT: SealedTaskPayload = {
  enc: 'aes-256-gcm',
  nonce: btoa('ba9876543210'),
  ct: btoa('sealed-task-result-payload'),
};

function wrapFor(jobId: string, targetEnrollmentId: string): TaskKeyWrapPayload {
  return {
    v: 1,
    enc: 'x25519-aes-256-gcm',
    jobId,
    targetEnrollmentId,
    ephPub: btoa('0123456789abcdef0123456789abcdef'),
    nonce: btoa('0123456789ab'),
    ct: btoa('wrapped-task-key-material'),
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

function createParams(overrides: Partial<JobCreateParams> = {}): JobCreateParams {
  return {
    requestId: crypto.randomUUID(),
    payloadHash: 'a'.repeat(64),
    kind: 'diagnostic',
    requestedTarget: { kind: 'auto' },
    inputManifest: manifest(),
    sealedInputs: SEALED_INPUTS,
    ...overrides,
  };
}

function sealedInputsOfSize(plaintextBytes: number): SealedTaskPayload {
  return {
    enc: 'aes-256-gcm',
    nonce: btoa('0123456789ab'),
    ct: btoa('x'.repeat(plaintextBytes)),
  };
}

async function publishPolicy(auth: string) {
  const policy: DevicePolicy = {
    worker: { allowJobs: true, allowedSources: ['same-account'], maxConcurrentJobs: 2 },
  };
  return expectSuccess(await postRpc('device.policy.publish', policy, auth));
}

async function connectWorker(auth: string) {
  return expectSuccess<WorkerConnectResult>(await postRpc('worker.connect', {}, auth));
}

/** A live worker plus a job resolved onto it. */
async function setupTargetedJob(fx: ReturnType<typeof fixture>) {
  await publishPolicy(fx.workerAuth);
  await connectWorker(fx.workerAuth);
  const created = expectSuccess<JobCreateResult>(
    await postRpc(
      'job.create',
      createParams({ requestedTarget: { kind: 'device', enrollmentId: fx.workerEnrollmentId } }),
      fx.sourceAuth,
    ),
  );
  return created.job;
}

describe('manifest input allowlist', () => {
  it('rejects a non-public key in manifest.inputs', async () => {
    const fx = fixture('allowlist');
    const response = await postRpc(
      'job.create',
      createParams({
        inputManifest: { ...manifest(), inputs: { workspaceId: 'ws-1', prompt: 'secret' } },
      }),
      fx.sourceAuth,
    );
    expect(response.status).toBe(400);
    expect(isRpcError(response.body)).toBe(true);
  });

  it('stores sealedInputs opaquely and reports pending key delivery', async () => {
    const fx = fixture('sealed-create');
    const created = expectSuccess<JobCreateResult>(
      await postRpc('job.create', createParams(), fx.sourceAuth),
    );
    expect(created.job.sealedInputs).toEqual(SEALED_INPUTS);
    expect(created.job.keyDelivery).toBe('pending');
    // The public manifest stays public — no sensitive keys leak through.
    expect(Object.keys(created.job.inputManifest.inputs)).toEqual(['workspaceId']);
  });

  it('accepts sealed private inputs larger than the coordinator-visible input limit', async () => {
    const fx = fixture('large-sealed-create');
    const sealedInputs = sealedInputsOfSize(256 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(sealedInputs)).byteLength).toBeGreaterThan(
      32 * 1024,
    );

    const created = expectSuccess<JobCreateResult>(
      await postRpc('job.create', createParams({ sealedInputs }), fx.sourceAuth),
    );
    expect(created.job.sealedInputs).toEqual(sealedInputs);
    expect(created.job.inputManifest.inputs).toEqual({ workspaceId: 'ws-1' });
  });

  it('rejects sealed private inputs above 512 KiB while retaining the 32 KiB public-input limit', async () => {
    const fx = fixture('too-large-sealed-create');
    const tooLargeSealedInputs = sealedInputsOfSize(400 * 1024);
    expect(
      new TextEncoder().encode(JSON.stringify(tooLargeSealedInputs)).byteLength,
    ).toBeGreaterThan(512 * 1024);
    const sealedResponse = await postRpc(
      'job.create',
      createParams({ sealedInputs: tooLargeSealedInputs }),
      fx.sourceAuth,
    );
    expect(sealedResponse.status).toBe(413);
    expect(isRpcError(sealedResponse.body)).toBe(true);
    if (isRpcError(sealedResponse.body)) {
      expect(sealedResponse.body.error.code).toBe('payload-too-large');
      expect(sealedResponse.body.error.details).toMatchObject({
        field: 'sealedInputs',
        limitBytes: 512 * 1024,
      });
    }

    const manifestResponse = await postRpc(
      'job.create',
      createParams({
        inputManifest: { ...manifest(), inputs: { workspaceId: 'x'.repeat(33 * 1024) } },
      }),
      fx.sourceAuth,
    );
    expect(manifestResponse.status).toBe(413);
    expect(isRpcError(manifestResponse.body)).toBe(true);
    if (isRpcError(manifestResponse.body)) {
      expect(manifestResponse.body.error.code).toBe('payload-too-large');
      expect(manifestResponse.body.error.details).toMatchObject({
        field: 'manifest.inputs',
        limitBytes: 32 * 1024,
      });
    }
  });

  it('reports none keyDelivery when no sealed inputs exist', async () => {
    const fx = fixture('unsealed');
    const created = expectSuccess<JobCreateResult>(
      await postRpc('job.create', createParams({ sealedInputs: undefined }), fx.sourceAuth),
    );
    expect(created.job.keyDelivery).toBe('none');
  });
});

describe('taskkey deliver/pull', () => {
  it('delivers a wrap to the resolved target and the target pulls it', async () => {
    const fx = fixture('deliver-pull');
    const job = await setupTargetedJob(fx);
    const delivered = expectSuccess<TaskKeyDeliverResult>(
      await postRpc(
        'taskkey.deliver',
        { jobId: job.id, wraps: [wrapFor(job.id, fx.workerEnrollmentId)] },
        fx.sourceAuth,
      ),
    );
    expect(delivered.delivered).toBe(1);
    const fetched = expectSuccess<JobGetResult>(
      await postRpc('job.get', { jobId: job.id }, fx.sourceAuth),
    );
    expect(fetched.job.keyDelivery).toBe('delivered');
    const pulled = expectSuccess<TaskKeyPullResult>(
      await postRpc('taskkey.pull', { jobId: job.id }, fx.workerAuth),
    );
    expect(pulled.wraps).toHaveLength(1);
    expect(pulled.wraps[0]?.targetEnrollmentId).toBe(fx.workerEnrollmentId);
  });

  it('returns no wraps to an enrollment that is not a target', async () => {
    const fx = fixture('pull-empty');
    const job = await setupTargetedJob(fx);
    expectSuccess<TaskKeyDeliverResult>(
      await postRpc(
        'taskkey.deliver',
        { jobId: job.id, wraps: [wrapFor(job.id, fx.workerEnrollmentId)] },
        fx.sourceAuth,
      ),
    );
    // The source is not a wrap target — it holds the TCK locally already.
    const pulled = expectSuccess<TaskKeyPullResult>(
      await postRpc('taskkey.pull', { jobId: job.id }, fx.sourceAuth),
    );
    expect(pulled.wraps).toHaveLength(0);
  });

  it('rejects delivery from a non-source enrollment', async () => {
    const fx = fixture('deliver-forbidden');
    const job = await setupTargetedJob(fx);
    const response = await postRpc(
      'taskkey.deliver',
      { jobId: job.id, wraps: [wrapFor(job.id, fx.workerEnrollmentId)] },
      fx.workerAuth,
    );
    expect(response.status).toBe(403);
    expect(isRpcError(response.body)).toBe(true);
  });

  it('rejects a wrap addressed outside the resolved target + result recipients', async () => {
    const fx = fixture('wrap-target');
    const job = await setupTargetedJob(fx);
    const response = await postRpc(
      'taskkey.deliver',
      { jobId: job.id, wraps: [wrapFor(job.id, 'enr-stranger')] },
      fx.sourceAuth,
    );
    expect(response.status).toBe(403);
    expect(isRpcError(response.body)).toBe(true);
  });

  it('allows wraps to declared result recipients', async () => {
    const fx = fixture('result-recipient');
    await publishPolicy(fx.workerAuth);
    await connectWorker(fx.workerAuth);
    const observer = `${fx.workerEnrollmentId}-obs`;
    const created = expectSuccess<JobCreateResult>(
      await postRpc(
        'job.create',
        createParams({
          requestedTarget: { kind: 'device', enrollmentId: fx.workerEnrollmentId },
          resultRecipients: [observer],
        }),
        fx.sourceAuth,
      ),
    );
    const delivered = expectSuccess<TaskKeyDeliverResult>(
      await postRpc(
        'taskkey.deliver',
        {
          jobId: created.job.id,
          wraps: [
            wrapFor(created.job.id, fx.workerEnrollmentId),
            wrapFor(created.job.id, observer),
          ],
        },
        fx.sourceAuth,
      ),
    );
    expect(delivered.delivered).toBe(2);
    const observerAuth = spikeBearer(fx.accountId, observer);
    const pulled = expectSuccess<TaskKeyPullResult>(
      await postRpc('taskkey.pull', { jobId: created.job.id }, observerAuth),
    );
    expect(pulled.wraps).toHaveLength(1);
  });
});

describe('sealed execution path', () => {
  it('echoes sealedInputs on claim and stores sealedResult on report', async () => {
    const fx = fixture('sealed-exec');
    const job = await setupTargetedJob(fx);
    const claimed = expectSuccess<JobClaimResult>(
      await postRpc('job.claim', { jobId: job.id }, fx.workerAuth),
    );
    expect(claimed.sealedInputs).toEqual(SEALED_INPUTS);
    const reported = expectSuccess<AttemptReportResult>(
      await postRpc(
        'attempt.report',
        {
          attemptId: claimed.attempt.id,
          incarnation: claimed.attempt.workerIncarnation,
          fence: claimed.fence,
          outcome: 'completed',
          result: { commits: ['abc123'] },
          sealedResult: SEALED_RESULT,
        },
        fx.workerAuth,
      ),
    );
    expect(reported.attempt.sealedResult).toEqual(SEALED_RESULT);
    const fetched = expectSuccess<JobGetResult>(
      await postRpc('job.get', { jobId: job.id }, fx.sourceAuth),
    );
    expect(fetched.attempts[0]?.sealedResult).toEqual(SEALED_RESULT);
  });
});

describe('keyring.report', () => {
  it('records a rotation report idempotently', async () => {
    const fx = fixture('keyring-report');
    const params = {
      rotationId: 'rot-1',
      revokedEnrollmentIds: ['enr-old-device'],
      toVersion: 7,
    };
    const first = expectSuccess<KeyringReportResult>(
      await postRpc('keyring.report', params, fx.sourceAuth),
    );
    const replay = expectSuccess<KeyringReportResult>(
      await postRpc('keyring.report', params, fx.sourceAuth),
    );
    expect(first.recorded).toBe(true);
    expect(replay.recorded).toBe(true);
  });
});

describe('dashboard grants', () => {
  const BROWSER_PUB = btoa('0123456789abcdef0123456789abcdef');
  const CHALLENGE = 'browser-challenge-1';

  function snapshot(seq: number): SealedDashboardSnapshot {
    return {
      enc: 'aes-256-gcm',
      seq,
      nonce: btoa('0123456789ab'),
      ct: btoa(`sealed-dashboard-snapshot-${seq}`),
    };
  }

  function grant(
    requestId: string,
    expiresAt = new Date(Date.now() + 3_600_000).toISOString(),
  ): DashboardGrantPayload {
    return {
      v: 1,
      enc: 'x25519-aes-256-gcm',
      requestId,
      browserPub: BROWSER_PUB,
      expiresAt,
      ephPub: btoa('fedcba9876543210fedcba9876543210'),
      nonce: btoa('0123456789ab'),
      ct: btoa('sealed-dashboard-session-key'),
    };
  }

  /** Upserts a browser request through the worker-internal DO route. */
  async function postHostedDashboardRequest(
    accountId: string,
    requestId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ status: number; body: RpcResponse }> {
    const response = await accountStub(accountId).fetch(
      new Request('https://internal.anvil/internal/dashboard-request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId,
          accountId,
          browserPub: BROWSER_PUB,
          challenge: CHALLENGE,
          scopes: ['read-dashboard'],
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          ...overrides,
        }),
      }),
    );
    return { status: response.status, body: (await response.json()) as RpcResponse };
  }

  async function postHostedStatus(accountId: string, requestId: string) {
    const response = await accountStub(accountId).fetch(
      new Request('https://internal.anvil/internal/dashboard-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId }),
      }),
    );
    return { status: response.status, body: (await response.json()) as RpcResponse };
  }

  it('lists a pending browser request for a trusted device', async () => {
    const fx = fixture('dash-pending');
    const requestId = crypto.randomUUID();
    const created = await postHostedDashboardRequest(fx.accountId, requestId);
    expect(created.status).toBe(200);
    const listed = expectSuccess<DashboardRequestsResult>(
      await postRpc('dashboard.requests', {}, fx.sourceAuth),
    );
    const entry = listed.requests.find((r) => r.requestId === requestId);
    expect(entry).toBeDefined();
    expect(entry?.state).toBe('pending');
    expect(entry?.browserPub).toBe(BROWSER_PUB);
    expect(entry?.scopes).toEqual(['read-dashboard']);
  });

  it('routes a machine-targeted request only to that enrollment and rejects other decisions', async () => {
    const fx = fixture('dash-targeted');
    const requestId = crypto.randomUUID();
    const created = await postHostedDashboardRequest(fx.accountId, requestId, {
      targetEnrollmentId: fx.sourceEnrollmentId,
    });
    expect(created.status).toBe(200);
    const retargeted = await postHostedDashboardRequest(fx.accountId, requestId, {
      targetEnrollmentId: fx.workerEnrollmentId,
    });
    expect(retargeted.status).toBe(409);

    const targetQueue = expectSuccess<DashboardRequestsResult>(
      await postRpc('dashboard.requests', {}, fx.sourceAuth),
    );
    expect(targetQueue.requests.find((request) => request.requestId === requestId)).toMatchObject({
      requestId,
      targetEnrollmentId: fx.sourceEnrollmentId,
    });

    const otherQueue = expectSuccess<DashboardRequestsResult>(
      await postRpc('dashboard.requests', {}, fx.workerAuth),
    );
    expect(otherQueue.requests.some((request) => request.requestId === requestId)).toBe(false);

    const otherLookup = await postRpc('dashboard.requests', { requestId }, fx.workerAuth);
    expect(otherLookup.status).toBe(403);
    expect(isRpcError(otherLookup.body)).toBe(true);

    const otherDecision = await postRpc(
      'dashboard.decide',
      { requestId, decision: 'denied' },
      fx.workerAuth,
    );
    expect(otherDecision.status).toBe(403);
    expect(isRpcError(otherDecision.body)).toBe(true);

    const targetDecision = await postRpc(
      'dashboard.decide',
      { requestId, decision: 'denied' },
      fx.sourceAuth,
    );
    expect(targetDecision.status).toBe(200);
    expect(isRpcError(targetDecision.body)).toBe(false);
  });

  it('issuer-bound lookup returns live decision and workspace authorization', async () => {
    const fx = fixture('dash-request-lookup');
    const requestId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const workspaceBindings = [{ workspaceId: 'workspace-1', repositoryIds: ['repo-1'] }];
    await postHostedDashboardRequest(fx.accountId, requestId, {
      scopes: ['read-dashboard', 'workspace-read'],
      workspaceBindings,
      expiresAt,
    });
    await postRpc(
      'dashboard.decide',
      {
        requestId,
        decision: 'approved',
        grant: { ...grant(requestId), expiresAt },
        snapshot: snapshot(1),
        workspaceBindings,
        grantedScopes: ['workspace-read'],
      },
      fx.sourceAuth,
    );

    const lookedUp = expectSuccess<DashboardRequestsResult>(
      await postRpc('dashboard.requests', { requestId }, fx.sourceAuth),
    );
    expect(lookedUp.requests).toEqual([]);
    expect(lookedUp.request).toMatchObject({
      requestId,
      state: 'approved',
      decidedBy: fx.sourceEnrollmentId,
      workspaceBindings,
      grantedScopes: ['workspace-read'],
    });

    const foreign = await postRpc('dashboard.requests', { requestId }, fx.workerAuth);
    expect(foreign.status).toBe(403);
    expect(isRpcError(foreign.body)).toBe(true);
  });

  it('approval stores the sealed grant + snapshot; status returns them', async () => {
    const fx = fixture('dash-approve');
    const requestId = crypto.randomUUID();
    await postHostedDashboardRequest(fx.accountId, requestId);
    const decided = expectSuccess<DashboardDecideResult>(
      await postRpc(
        'dashboard.decide',
        {
          requestId,
          decision: 'approved',
          grant: grant(requestId),
          snapshot: snapshot(1),
        },
        fx.sourceAuth,
      ),
    );
    expect(decided.request.state).toBe('approved');
    expect(decided.request.decidedBy).toBe(fx.sourceEnrollmentId);
    const result = expectSuccess<HostedDashboardStatus>(
      await postHostedStatus(fx.accountId, requestId),
    );
    expect(result.state).toBe('approved');
    expect(result.grant?.requestId).toBe(requestId);
    expect(result.snapshotSeq).toBe(1);
  });

  it('rejects a grant bound to a different browser pub', async () => {
    const fx = fixture('dash-grant-bind');
    const requestId = crypto.randomUUID();
    await postHostedDashboardRequest(fx.accountId, requestId);
    const wrong = { ...grant(requestId), browserPub: btoa('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz') };
    const response = await postRpc(
      'dashboard.decide',
      { requestId, decision: 'approved', grant: wrong, snapshot: snapshot(1) },
      fx.sourceAuth,
    );
    expect(response.status).toBe(400);
    expect(isRpcError(response.body)).toBe(true);
  });

  it('publish requires increasing seq and the approving enrollment', async () => {
    const fx = fixture('dash-publish');
    const requestId = crypto.randomUUID();
    await postHostedDashboardRequest(fx.accountId, requestId);
    await postRpc(
      'dashboard.decide',
      { requestId, decision: 'approved', grant: grant(requestId), snapshot: snapshot(1) },
      fx.sourceAuth,
    );
    // Stale seq → conflict.
    const stale = await postRpc(
      'dashboard.publish',
      { requestId, snapshot: snapshot(1) },
      fx.sourceAuth,
    );
    expect(stale.status).toBe(409);
    // Wrong device → forbidden.
    const foreign = await postRpc(
      'dashboard.publish',
      { requestId, snapshot: snapshot(2) },
      fx.workerAuth,
    );
    expect(foreign.status).toBe(403);
    // Fresh seq from the approver → published.
    const published = expectSuccess<{ published: boolean; seq: number }>(
      await postRpc('dashboard.publish', { requestId, snapshot: snapshot(2) }, fx.sourceAuth),
    );
    expect(published).toEqual({ published: true, seq: 2 });
  });

  it('revoke drops the grant and snapshot', async () => {
    const fx = fixture('dash-revoke');
    const requestId = crypto.randomUUID();
    await postHostedDashboardRequest(fx.accountId, requestId);
    await postRpc(
      'dashboard.decide',
      { requestId, decision: 'approved', grant: grant(requestId), snapshot: snapshot(1) },
      fx.sourceAuth,
    );
    const revoked = expectSuccess<DashboardRevokeResult>(
      await postRpc('dashboard.revoke', { requestId }, fx.sourceAuth),
    );
    expect(revoked.request.state).toBe('revoked');
    const result = expectSuccess<HostedDashboardStatus>(
      await postHostedStatus(fx.accountId, requestId),
    );
    expect(result.state).toBe('revoked');
    expect(result.grant).toBeUndefined();
    expect(result.snapshotSeq).toBeUndefined();
  });

  it('rejects a request-id reuse with different metadata', async () => {
    const fx = fixture('dash-reuse');
    const requestId = crypto.randomUUID();
    await postHostedDashboardRequest(fx.accountId, requestId);
    const reused = await postHostedDashboardRequest(fx.accountId, requestId, {
      challenge: 'different-challenge',
    });
    expect(reused.status).toBe(409);
  });

  it('hydrates remembered renewals from the trust ceiling and rejects replay or widening', async () => {
    const fx = fixture('dash-trust-renewal');
    const trustId = crypto.randomUUID();
    const origin = 'https://workspace.example';
    const bindings = [{ workspaceId: 'workspace-1', repositoryIds: ['repo-1'] }];
    const grantedScopes = ['workspace-read'] as const;
    const initialRequestId = crypto.randomUUID();
    const initialExpiresAt = new Date(Date.now() + 600_000).toISOString();
    const initial = await postHostedDashboardRequest(fx.accountId, initialRequestId, {
      targetEnrollmentId: fx.sourceEnrollmentId,
      scopes: [],
      workspaceBindings: [],
      origin,
      expiresAt: initialExpiresAt,
    });
    expect(initial.status).toBe(200);

    const remembered = await postRpc(
      'dashboard.decide',
      {
        requestId: initialRequestId,
        decision: 'approved',
        grant: grant(initialRequestId, initialExpiresAt),
        snapshot: snapshot(1),
        workspaceBindings: bindings,
        grantedScopes: grantedScopes,
        browserTrust: {
          trustId,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        },
      },
      fx.sourceAuth,
    );
    expect(remembered.status).toBe(200);

    const requestId = crypto.randomUUID();
    const renewalProof = btoa('renewal-proof-012345678901234567');
    const expiresAt = new Date(Date.now() + 3_000_000).toISOString();
    const renewal = await postHostedDashboardRequest(fx.accountId, requestId, {
      targetEnrollmentId: fx.sourceEnrollmentId,
      trustId,
      renewalProof,
      scopes: [],
      workspaceBindings: [],
      origin,
      challenge: 'fresh-renewal-challenge',
      expiresAt,
    });
    expect(renewal.status).toBe(200);

    const pending = expectSuccess<DashboardRequestsResult>(
      await postRpc('dashboard.requests', {}, fx.sourceAuth),
    ).requests.find((entry) => entry.requestId === requestId);
    expect(pending).toMatchObject({
      trustId,
      renewalProof,
      targetEnrollmentId: fx.sourceEnrollmentId,
      scopes: grantedScopes,
      workspaceBindings: bindings,
    });

    const replay = await postHostedDashboardRequest(fx.accountId, crypto.randomUUID(), {
      targetEnrollmentId: fx.sourceEnrollmentId,
      trustId,
      renewalProof,
      scopes: [],
      workspaceBindings: [],
      origin,
      challenge: 'replayed-proof',
      expiresAt,
    });
    expect(replay.status).toBe(409);

    const widened = await postHostedDashboardRequest(fx.accountId, crypto.randomUUID(), {
      targetEnrollmentId: fx.sourceEnrollmentId,
      trustId,
      renewalProof: btoa('different-proof-0123456789012345'),
      scopes: ['workspace-write'],
      workspaceBindings: [],
      origin,
      challenge: 'widened-renewal',
      expiresAt,
    });
    expect(widened.status).toBe(403);

    const approvedRenewal = await postRpc(
      'dashboard.decide',
      {
        requestId,
        decision: 'approved',
        grant: grant(requestId, expiresAt),
        snapshot: snapshot(1),
        workspaceBindings: bindings,
        grantedScopes: grantedScopes,
      },
      fx.sourceAuth,
    );
    expect(approvedRenewal.status).toBe(200);
  });

  it('revokes every session of a remembered browser, clears command results, and purges trust on account deletion', async () => {
    const fx = fixture('dash-trust-revoke');
    const trustId = crypto.randomUUID();
    const origin = 'https://workspace.example';
    const bindings = [{ workspaceId: 'workspace-1', repositoryIds: ['repo-1'] }];
    const scopes = ['workspace-read'] as const;
    const firstRequestId = crypto.randomUUID();
    const firstExpiresAt = new Date(Date.now() + 600_000).toISOString();
    await postHostedDashboardRequest(fx.accountId, firstRequestId, {
      targetEnrollmentId: fx.sourceEnrollmentId,
      scopes: [],
      workspaceBindings: [],
      origin,
      expiresAt: firstExpiresAt,
    });
    const firstDecision = await postRpc(
      'dashboard.decide',
      {
        requestId: firstRequestId,
        decision: 'approved',
        grant: grant(firstRequestId, firstExpiresAt),
        snapshot: snapshot(1),
        workspaceBindings: bindings,
        grantedScopes: scopes,
        browserTrust: {
          trustId,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        },
      },
      fx.sourceAuth,
    );
    expect(firstDecision.status).toBe(200);

    const secondRequestId = crypto.randomUUID();
    const secondExpiresAt = new Date(Date.now() + 3_000_000).toISOString();
    await postHostedDashboardRequest(fx.accountId, secondRequestId, {
      targetEnrollmentId: fx.sourceEnrollmentId,
      trustId,
      renewalProof: btoa('second-renewal-proof-01234567890'),
      scopes: [],
      workspaceBindings: [],
      origin,
      challenge: 'second-renewal-challenge',
      expiresAt: secondExpiresAt,
    });
    const secondDecision = await postRpc(
      'dashboard.decide',
      {
        requestId: secondRequestId,
        decision: 'approved',
        grant: grant(secondRequestId, secondExpiresAt),
        snapshot: snapshot(1),
        workspaceBindings: bindings,
        grantedScopes: scopes,
      },
      fx.sourceAuth,
    );
    expect(secondDecision.status).toBe(200);

    const thirdRequestId = crypto.randomUUID();
    const thirdExpiresAt = new Date(Date.now() + 3_000_000).toISOString();
    await postHostedDashboardRequest(fx.accountId, thirdRequestId, {
      targetEnrollmentId: fx.sourceEnrollmentId,
      trustId,
      renewalProof: btoa('third-renewal-proof-012345678901'),
      scopes: [],
      workspaceBindings: [],
      origin,
      challenge: 'third-renewal-challenge',
      expiresAt: thirdExpiresAt,
    });
    const thirdDecision = await postRpc(
      'dashboard.decide',
      {
        requestId: thirdRequestId,
        decision: 'approved',
        grant: grant(thirdRequestId, thirdExpiresAt),
        snapshot: snapshot(1),
        workspaceBindings: bindings,
        grantedScopes: scopes,
      },
      fx.sourceAuth,
    );
    expect(thirdDecision.status).toBe(200);

    const completedCommandId = crypto.randomUUID();
    const completedCommand = {
      v: 1,
      enc: 'aes-256-gcm',
      requestId: firstRequestId,
      commandId: completedCommandId,
      operation: 'file.read',
      workspaceId: 'workspace-1',
      repositoryId: 'repo-1',
      expiresAt: firstExpiresAt,
      nonce: btoa('0123456789ab'),
      ct: btoa('opaque-dashboard-command-ciphertext'),
    };
    const completedSubmit = await accountStub(fx.accountId).fetch(
      new Request('https://internal.anvil/internal/dashboard-command-submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accountId: fx.accountId,
          requestId: firstRequestId,
          command: completedCommand,
        }),
      }),
    );
    expect(completedSubmit.status).toBe(200);
    const claimed = expectSuccess<{ commands: Array<{ claimFence: number }> }>(
      await postRpc('dashboard.command.claim', { requestId: firstRequestId }, fx.sourceAuth),
    );
    expect(claimed.commands).toHaveLength(1);
    await postRpc(
      'dashboard.command.complete',
      {
        requestId: firstRequestId,
        commandId: completedCommandId,
        claimFence: claimed.commands[0]?.claimFence,
        outcome: 'completed',
        result: { ...completedCommand, ct: btoa('opaque-dashboard-result-ciphertext') },
      },
      fx.sourceAuth,
    );

    const commandExpiresAt = new Date(Date.now() + 300_000).toISOString();
    const claimedCommandId = crypto.randomUUID();
    const claimedCommand = {
      ...completedCommand,
      requestId: secondRequestId,
      commandId: claimedCommandId,
      expiresAt: commandExpiresAt,
    };
    const claimedSubmit = await accountStub(fx.accountId).fetch(
      new Request('https://internal.anvil/internal/dashboard-command-submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accountId: fx.accountId,
          requestId: secondRequestId,
          command: claimedCommand,
        }),
      }),
    );
    expect(claimedSubmit.status).toBe(200);
    const secondClaimed = expectSuccess<{ commands: Array<{ commandId: string }> }>(
      await postRpc('dashboard.command.claim', { requestId: secondRequestId }, fx.sourceAuth),
    );
    expect(secondClaimed.commands.map((command) => command.commandId)).toEqual([claimedCommandId]);

    const queuedCommandId = crypto.randomUUID();
    const queuedCommand = {
      ...completedCommand,
      requestId: thirdRequestId,
      commandId: queuedCommandId,
      expiresAt: commandExpiresAt,
    };
    const queuedSubmit = await accountStub(fx.accountId).fetch(
      new Request('https://internal.anvil/internal/dashboard-command-submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accountId: fx.accountId,
          requestId: thirdRequestId,
          command: queuedCommand,
        }),
      }),
    );
    expect(queuedSubmit.status).toBe(200);

    const revokeResponse = await accountStub(fx.accountId).fetch(
      new Request('https://internal.anvil/internal/dashboard-trust-revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: fx.accountId, trustId, origin }),
      }),
    );
    expect(revokeResponse.status).toBe(200);
    expect(await revokeResponse.json()).toMatchObject({ result: { revoked: true } });

    for (const requestId of [firstRequestId, secondRequestId, thirdRequestId]) {
      const status = expectSuccess<HostedDashboardStatus>(
        await postHostedStatus(fx.accountId, requestId),
      );
      expect(status.state).toBe('revoked');
      expect(status.grant).toBeUndefined();
    }
    const completedStatusResponse = await accountStub(fx.accountId).fetch(
      new Request('https://internal.anvil/internal/dashboard-command-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: firstRequestId, commandId: completedCommandId }),
      }),
    );
    const completedStatus = (await completedStatusResponse.json()) as Record<string, unknown>;
    expect(completedStatus).toMatchObject({ state: 'completed' });
    expect(completedStatus['result']).toBeUndefined();
    const claimedStatusResponse = await accountStub(fx.accountId).fetch(
      new Request('https://internal.anvil/internal/dashboard-command-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: secondRequestId, commandId: claimedCommandId }),
      }),
    );
    expect(await claimedStatusResponse.json()).toMatchObject({ state: 'unknown-outcome' });
    const queuedStatusResponse = await accountStub(fx.accountId).fetch(
      new Request('https://internal.anvil/internal/dashboard-command-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: thirdRequestId, commandId: queuedCommandId }),
      }),
    );
    expect(await queuedStatusResponse.json()).toMatchObject({ state: 'revoked' });

    const purge = await accountStub(fx.accountId).fetch(
      new Request('https://internal.anvil/internal/delete-account', { method: 'POST' }),
    );
    expect(purge.status).toBe(200);
    const deletedRevoke = await accountStub(fx.accountId).fetch(
      new Request('https://internal.anvil/internal/dashboard-trust-revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: fx.accountId, trustId, origin }),
      }),
    );
    expect(await deletedRevoke.json()).toMatchObject({ result: { revoked: false } });
  });
});
