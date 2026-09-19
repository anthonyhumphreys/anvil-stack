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
          wraps: [wrapFor(created.job.id, fx.workerEnrollmentId), wrapFor(created.job.id, observer)],
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

  function grant(requestId: string): DashboardGrantPayload {
    return {
      v: 1,
      enc: 'x25519-aes-256-gcm',
      requestId,
      browserPub: BROWSER_PUB,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
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
});
