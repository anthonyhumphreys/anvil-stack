import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { isRpcError, type RpcResponse } from '../../contract/envelope';
import { PROTOCOL } from '../../contract/version';
import type {
  ExecutionManifest,
  JobClaimResult,
  JobCreateParams,
  JobCreateResult,
  JobGetResult,
} from '../../contract/jobs';
import type {
  EnvironmentGetResult,
  EnvironmentListResult,
  EnvironmentReapResult,
  EnvironmentReportResult,
} from '../../contract/environment';
import type {
  DevicePolicy,
  DevicePolicyPublishResult,
  WorkerConnectResult,
} from '../../contract/workers';
import { expectSuccess, postRpc, spikeBearer, uniqueIds } from './helpers';

function accountStub(accountId: string) {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId));
}

/**
 * Direct account-object RPC with worker-verified headers — the path the
 * public Worker takes after session validation. Lets tests drive
 * ephemeral-class enrollments and environment bindings that the spike
 * bearer cannot express.
 */
async function stubRpc(
  accountId: string,
  auth: {
    enrollmentId: string;
    enrollmentClass?: 'device' | 'ephemeral';
    environmentId?: string;
  },
  operation: string,
  params: unknown,
): Promise<{ status: number; body: RpcResponse }> {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set('x-anvil-account', accountId);
  headers.set('x-anvil-enrollment', auth.enrollmentId);
  headers.set('x-anvil-enrollment-class', auth.enrollmentClass ?? 'device');
  if (auth.environmentId !== undefined) {
    headers.set('x-anvil-environment-id', auth.environmentId);
  }
  const response = await accountStub(accountId).fetch(
    new Request('https://internal.anvil/v1/rpc', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        protocol: PROTOCOL,
        requestId: crypto.randomUUID(),
        operation,
        params,
      }),
    }),
  );
  const body = (await response.json()) as RpcResponse;
  return { status: response.status, body };
}

function fixture(label: string) {
  const ids = uniqueIds(label);
  const provisionerEnrollmentId = `${ids.enrollmentId}-prov`;
  const envEnrollmentId = `${ids.enrollmentId}-env`;
  return {
    accountId: ids.accountId,
    provisionerEnrollmentId,
    envEnrollmentId,
    provisionerAuth: spikeBearer(ids.accountId, provisionerEnrollmentId),
    envAuth: {
      enrollmentId: envEnrollmentId,
      enrollmentClass: 'ephemeral' as const,
      environmentId: `env_${label}`,
    },
    environmentId: `env_${label}`,
  };
}

function allowJobsPolicy(): DevicePolicy {
  return { worker: { allowJobs: true, allowedSources: ['same-account'], maxConcurrentJobs: 4 } };
}

async function publishPolicy(auth: string, policy: DevicePolicy = allowJobsPolicy()) {
  return expectSuccess<DevicePolicyPublishResult>(
    await postRpc('device.policy.publish', policy, auth),
  );
}

async function connectWorker(auth: string) {
  return expectSuccess<WorkerConnectResult>(await postRpc('worker.connect', {}, auth));
}

async function envConnect(fx: ReturnType<typeof fixture>) {
  // The env's boot sequence: publish its own worker policy (ephemeral-
  // allowed), connect, then report enrolled.
  expectSuccess(
    await stubRpc(fx.accountId, fx.envAuth, 'device.policy.publish', allowJobsPolicy()),
  );
  expectSuccess<WorkerConnectResult>(
    await stubRpc(fx.accountId, fx.envAuth, 'worker.connect', {}),
  );
}

function manifest(): ExecutionManifest {
  return {
    workspaceDefinitionRevision: 'wsdef-rev-1',
    repositories: [{ repositoryId: 'repo-1', commit: '0123456789abcdef' }],
    bootstrapDigest: 'sha256:bootstrap-1',
    provider: 'codex',
    model: 'gpt-5',
    configVersions: { 'agent-settings': 'v3' },
    inputs: { prompt: 'diagnose the workspace' },
  };
}

async function createJob(
  auth: string,
  overrides: Partial<JobCreateParams> = {},
): Promise<JobCreateResult> {
  return expectSuccess<JobCreateResult>(
    await postRpc(
      'job.create',
      {
        requestId: crypto.randomUUID(),
        payloadHash: 'a'.repeat(64),
        kind: 'diagnostic',
        requestedTarget: { kind: 'auto' },
        inputManifest: manifest(),
        ...overrides,
      } satisfies JobCreateParams,
      auth,
    ),
  );
}

async function reportEnvironment(
  auth: string,
  params: Record<string, unknown>,
): Promise<EnvironmentReportResult> {
  return expectSuccess<EnvironmentReportResult>(
    await postRpc('environment.report', params, auth),
  );
}

describe('environment lifecycle', () => {
  it('creates, reads, and lists environment records', async () => {
    const fx = fixture('lifecycle');
    await publishPolicy(fx.provisionerAuth);
    await connectWorker(fx.provisionerAuth);

    const created = await reportEnvironment(fx.provisionerAuth, {
      environmentId: fx.environmentId,
      provider: 'aws-lambda-microvm',
      state: 'provisioning',
      handle: { microvmId: 'mvm-1' },
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    });
    expect(created.environment.environmentId).toBe(fx.environmentId);
    expect(created.environment.state).toBe('provisioning');
    expect(created.environment.createdBy).toBe(fx.provisionerEnrollmentId);

    const got = expectSuccess<EnvironmentGetResult>(
      await postRpc('environment.get', { environmentId: fx.environmentId }, fx.provisionerAuth),
    );
    expect(got.environment.handle?.['microvmId']).toBe('mvm-1');
    expect(got.environment.expiresAt).toBeDefined();

    const listed = expectSuccess<EnvironmentListResult>(
      await postRpc('environment.list', {}, fx.provisionerAuth),
    );
    expect(listed.environments.map((env) => env.environmentId)).toContain(fx.environmentId);
  });

  it('rejects reports from unrelated workers', async () => {
    const fx = fixture('unrelated');
    const stranger = `${fx.envEnrollmentId}-stranger`;
    const strangerAuth = spikeBearer(fx.accountId, stranger);
    await publishPolicy(fx.provisionerAuth);
    await connectWorker(fx.provisionerAuth);
    await publishPolicy(strangerAuth);
    await connectWorker(strangerAuth);

    await reportEnvironment(fx.provisionerAuth, {
      environmentId: fx.environmentId,
      provider: 'aws-lambda-microvm',
      state: 'provisioning',
    });
    const denied = await postRpc(
      'environment.report',
      { environmentId: fx.environmentId, provider: 'aws-lambda-microvm', state: 'running' },
      strangerAuth,
    );
    expect(isRpcError(denied.body)).toBe(true);
  });

  it('enroll resolves environment-targeted jobs onto the env enrollment', async () => {
    const fx = fixture('resolve');
    await publishPolicy(fx.provisionerAuth);
    await connectWorker(fx.provisionerAuth);
    await envConnect(fx);

    // Record exists, still provisioning — the env-targeted job queues
    // unresolved.
    await reportEnvironment(fx.provisionerAuth, {
      environmentId: fx.environmentId,
      provider: 'aws-lambda-microvm',
      state: 'provisioning',
    });
    const created = await createJob(fx.provisionerAuth, {
      requestedTarget: { kind: 'environment', environmentId: fx.environmentId },
    });
    expect(created.job.targetEnrollmentId).toBeUndefined();

    // The env self-reports enrolled (authorized by its bound
    // environment_id); the queued job resolves onto it.
    const enrolled = expectSuccess<EnvironmentReportResult>(
      await stubRpc(fx.accountId, fx.envAuth, 'environment.report', {
        environmentId: fx.environmentId,
        provider: 'aws-lambda-microvm',
        state: 'enrolled',
        enrollmentId: fx.envEnrollmentId,
      }),
    );
    expect(enrolled.environment.state).toBe('enrolled');
    expect(enrolled.environment.enrollmentId).toBe(fx.envEnrollmentId);

    // The env claims its job through the ordinary claim path.
    const claim = expectSuccess<JobClaimResult>(
      await stubRpc(fx.accountId, fx.envAuth, 'job.claim', { jobId: created.job.id }),
    );
    expect(claim.job.id).toBe(created.job.id);
    expect(claim.attempt.jobId).toBe(created.job.id);
  });

  it('rejects an env report bound to a different environment', async () => {
    const fx = fixture('bound');
    await publishPolicy(fx.provisionerAuth);
    await connectWorker(fx.provisionerAuth);
    await envConnect(fx);
    await reportEnvironment(fx.provisionerAuth, {
      environmentId: fx.environmentId,
      provider: 'aws-lambda-microvm',
      state: 'provisioning',
    });
    const denied = await stubRpc(fx.accountId, fx.envAuth, 'environment.report', {
      environmentId: 'env_someone_else',
      provider: 'aws-lambda-microvm',
      state: 'provisioning',
    });
    expect(isRpcError(denied.body)).toBe(true);
  });

  it('reap intent is durable and idempotent; terminate closes the record', async () => {
    const fx = fixture('reap');
    await publishPolicy(fx.provisionerAuth);
    await connectWorker(fx.provisionerAuth);
    await reportEnvironment(fx.provisionerAuth, {
      environmentId: fx.environmentId,
      provider: 'aws-lambda-microvm',
      state: 'provisioning',
    });

    const reaped = expectSuccess<EnvironmentReapResult>(
      await postRpc('environment.reap', { environmentId: fx.environmentId }, fx.provisionerAuth),
    );
    expect(reaped.environment.state).toBe('reap-requested');
    expect(reaped.environment.reapRequestedAt).toBeDefined();

    const reapedAgain = expectSuccess<EnvironmentReapResult>(
      await postRpc('environment.reap', { environmentId: fx.environmentId }, fx.provisionerAuth),
    );
    expect(reapedAgain.environment.state).toBe('reap-requested');

    const terminated = await reportEnvironment(fx.provisionerAuth, {
      environmentId: fx.environmentId,
      provider: 'aws-lambda-microvm',
      state: 'terminated',
      reaped: true,
    });
    expect(terminated.environment.state).toBe('terminated');
    expect(terminated.environment.reapedAt).toBeDefined();

    // Terminal envs disappear from the default list but remain on
    // includeTerminal for audit.
    const defaultList = expectSuccess<EnvironmentListResult>(
      await postRpc('environment.list', {}, fx.provisionerAuth),
    );
    expect(defaultList.environments).toHaveLength(0);
    const all = expectSuccess<EnvironmentListResult>(
      await postRpc('environment.list', { includeTerminal: true }, fx.provisionerAuth),
    );
    expect(all.environments.map((env) => env.environmentId)).toContain(fx.environmentId);
  });

  it('environment target on a missing record is not-found', async () => {
    const fx = fixture('missing');
    const response = await postRpc(
      'job.create',
      {
        requestId: crypto.randomUUID(),
        payloadHash: 'b'.repeat(64),
        kind: 'diagnostic',
        requestedTarget: { kind: 'environment', environmentId: 'env_missing' },
        inputManifest: manifest(),
      } satisfies JobCreateParams,
      fx.provisionerAuth,
    );
    expect(isRpcError(response.body)).toBe(true);
  });
});

describe('ephemeral enrollment restrictions', () => {
  it('ephemeral sessions cannot create jobs or list devices', async () => {
    const fx = fixture('restrict');
    await envConnect(fx);
    const createDenied = await stubRpc(fx.accountId, fx.envAuth, 'job.create', {
      requestId: crypto.randomUUID(),
      payloadHash: 'c'.repeat(64),
      kind: 'diagnostic',
      requestedTarget: { kind: 'auto' },
      inputManifest: manifest(),
    });
    expect(isRpcError(createDenied.body)).toBe(true);
    const listDenied = await stubRpc(fx.accountId, fx.envAuth, 'device.list', {});
    expect(isRpcError(listDenied.body)).toBe(true);
  });

  it('ephemeral class pins on first sight — a dropped header cannot widen it', async () => {
    const fx = fixture('pin');
    await envConnect(fx);
    // Same enrollment, but the class header now claims 'device' — the
    // pinned enrollment row still says ephemeral.
    const denied = await stubRpc(
      fx.accountId,
      { enrollmentId: fx.envEnrollmentId, enrollmentClass: 'device' },
      'job.create',
      {
        requestId: crypto.randomUUID(),
        payloadHash: 'd'.repeat(64),
        kind: 'diagnostic',
        requestedTarget: { kind: 'auto' },
        inputManifest: manifest(),
      },
    );
    expect(isRpcError(denied.body)).toBe(true);
  });
});

describe('credential grants', () => {
  function grantEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      v: 1,
      enc: 'x25519-aes-256-gcm',
      jobId: 'job_x',
      attemptId: 'att_x',
      fence: 1,
      targetEnrollmentId: 'enr_x',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ephPub: Buffer.alloc(32, 1).toString('base64'),
      nonce: Buffer.alloc(12, 2).toString('base64'),
      ct: Buffer.from('sealed-test', 'utf8').toString('base64'),
      ...overrides,
    };
  }

  async function claimedAttempt(fx: ReturnType<typeof fixture>) {
    await publishPolicy(fx.provisionerAuth);
    await connectWorker(fx.provisionerAuth);
    await envConnect(fx);
    await reportEnvironment(fx.provisionerAuth, {
      environmentId: fx.environmentId,
      provider: 'aws-lambda-microvm',
      state: 'provisioning',
    });
    const created = await createJob(fx.provisionerAuth, {
      requestedTarget: { kind: 'environment', environmentId: fx.environmentId },
    });
    expectSuccess<EnvironmentReportResult>(
      await stubRpc(fx.accountId, fx.envAuth, 'environment.report', {
        environmentId: fx.environmentId,
        provider: 'aws-lambda-microvm',
        state: 'enrolled',
        enrollmentId: fx.envEnrollmentId,
      }),
    );
    const claim = expectSuccess<JobClaimResult>(
      await stubRpc(fx.accountId, fx.envAuth, 'job.claim', { jobId: created.job.id }),
    );
    return { job: created.job, attempt: claim.attempt, fence: claim.fence };
  }

  it('deliver + pull round-trips a bound grant envelope', async () => {
    const fx = fixture('grant');
    const { job, attempt } = await claimedAttempt(fx);
    const grant = grantEnvelope({
      jobId: job.id,
      attemptId: attempt.id,
      fence: attempt.fence,
      targetEnrollmentId: fx.envEnrollmentId,
    });
    const delivered = expectSuccess<{ delivered: boolean }>(
      await postRpc('credential.deliver', { grant }, fx.provisionerAuth),
    );
    expect(delivered.delivered).toBe(true);

    const pulled = expectSuccess<{ grants: Record<string, unknown>[] }>(
      await stubRpc(fx.accountId, fx.envAuth, 'credential.pull', {
        attemptId: attempt.id,
        fence: attempt.fence,
      }),
    );
    expect(pulled.grants).toHaveLength(1);
    expect(pulled.grants[0]?.['attemptId']).toBe(attempt.id);
  });

  it('rejects delivery on a stale fence and pulls by non-claimants', async () => {
    const fx = fixture('grant-fence');
    const { job, attempt } = await claimedAttempt(fx);
    const stale = await postRpc(
      'credential.deliver',
      {
        grant: grantEnvelope({
          jobId: job.id,
          attemptId: attempt.id,
          fence: attempt.fence + 1,
          targetEnrollmentId: fx.envEnrollmentId,
        }),
      },
      fx.provisionerAuth,
    );
    expect(isRpcError(stale.body)).toBe(true);

    const wrongTarget = await postRpc(
      'credential.deliver',
      {
        grant: grantEnvelope({
          jobId: job.id,
          attemptId: attempt.id,
          fence: attempt.fence,
          targetEnrollmentId: 'enr_other',
        }),
      },
      fx.provisionerAuth,
    );
    expect(isRpcError(wrongTarget.body)).toBe(true);

    // The provisioner is not the attempt's claimant — it cannot pull.
    const pullDenied = await postRpc(
      'credential.pull',
      { attemptId: attempt.id, fence: attempt.fence },
      fx.provisionerAuth,
    );
    expect(isRpcError(pullDenied.body)).toBe(true);
  });
});

describe('managed environments (ENV-09)', () => {
  const MANAGED_PAIRING = 'anvil-pair-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF';

  function managedManifest(environmentId: string, ttlSeconds: number): ExecutionManifest {
    return {
      ...manifest(),
      inputs: { environmentId, provider: 'anvil-managed', ttlSeconds },
    };
  }

  function createManagedJob(
    auth: string,
    environmentId: string,
    ttlSeconds = 1800,
    requestId = crypto.randomUUID(),
  ) {
    return postRpc(
      'job.create',
      {
        requestId,
        payloadHash: 'e'.repeat(64),
        kind: 'provision-environment',
        requestedTarget: {
          kind: 'auto',
          requirements: { capabilities: ['provision:anvil-managed'] },
        },
        inputManifest: managedManifest(environmentId, ttlSeconds),
      } satisfies JobCreateParams,
      auth,
    );
  }

  async function sweepAccount(accountId: string) {
    const response = await accountStub(accountId).fetch(
      new Request('https://internal.anvil/internal/sweep', { method: 'POST' }),
    );
    return (await response.json()) as Record<string, number>;
  }

  /** The stub binding is always injected by vitest.config.ts for this suite. */
  function provisioner(): Fetcher {
    if (!env.MANAGED_PROVISIONER) throw new Error('MANAGED_PROVISIONER stub missing');
    return env.MANAGED_PROVISIONER;
  }

  async function provisionerEnqueue(rule: {
    method: string;
    path: string;
    status?: number;
    body?: unknown;
  }) {
    await provisioner().fetch(
      new Request('https://provisioner.stub/__provisioner-stub/enqueue', {
        method: 'POST',
        body: JSON.stringify(rule),
      }),
    );
  }

  async function provisionerReset() {
    await provisioner().fetch(
      new Request('https://provisioner.stub/__provisioner-stub/reset', { method: 'POST' }),
    );
  }

  async function provisionerLast(): Promise<{
    method: string;
    path: string;
    body: { bootstrap?: Record<string, unknown>; environmentId?: string } | null;
  } | null> {
    const response = await provisioner().fetch(
      new Request('https://provisioner.stub/__provisioner-stub/last'),
    );
    return (await response.json()) as never;
  }

  async function waitJobTerminal(
    auth: string,
    jobId: string,
  ): Promise<JobGetResult> {
    for (let i = 0; i < 60; i++) {
      const got = expectSuccess<JobGetResult>(
        await postRpc('job.get', { jobId }, auth),
      );
      if (got.job.state === 'completed' || got.job.state === 'failed') return got;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`job ${jobId} never reached a terminal state`);
  }

  it('stages a bootstrap payload and rejects malformed ones', async () => {
    const fx = fixture('bootstrap');
    const staged = expectSuccess<{ ok: true }>(
      await postRpc(
        'environment.bootstrap',
        { environmentId: fx.environmentId, payload: MANAGED_PAIRING },
        fx.provisionerAuth,
      ),
    );
    expect(staged.ok).toBe(true);

    const missing = await postRpc(
      'environment.bootstrap',
      { environmentId: fx.environmentId },
      fx.provisionerAuth,
    );
    expect(isRpcError(missing.body)).toBe(true);
    const oversized = await postRpc(
      'environment.bootstrap',
      { environmentId: fx.environmentId, payload: 'x'.repeat(5000) },
      fx.provisionerAuth,
    );
    expect(isRpcError(oversized.body)).toBe(true);
  });

  it('enforces free-tier caps: TTL bound and concurrency 1', async () => {
    const fx = fixture('caps');
    // Free entitlement (unlinked account): 30-minute TTL cap.
    const overTtl = await createManagedJob(fx.provisionerAuth, 'env_c1', 1801);
    expect(isRpcError(overTtl.body)).toBe(true);
    const underMin = await createManagedJob(fx.provisionerAuth, 'env_c2', 30);
    expect(isRpcError(underMin.body)).toBe(true);

    // A first provision at the cap succeeds — the env record it leaves is
    // live, so the next managed create trips the concurrency cap.
    await postRpc(
      'environment.bootstrap',
      { environmentId: 'env_c3', payload: MANAGED_PAIRING },
      fx.provisionerAuth,
    );
    const firstRequestId = crypto.randomUUID();
    const first = expectSuccess<JobCreateResult>(
      await createManagedJob(fx.provisionerAuth, 'env_c3', 1800, firstRequestId),
    );
    await sweepAccount(fx.accountId);
    await waitJobTerminal(fx.provisionerAuth, first.job.id);

    const second = await createManagedJob(fx.provisionerAuth, 'env_c4', 1800);
    expect(isRpcError(second.body)).toBe(true);

    // Replaying the first request returns the stored job, not a cap
    // rejection — the slot was already accounted when the job was born.
    const replay = expectSuccess<JobCreateResult>(
      await createManagedJob(fx.provisionerAuth, 'env_c3', 1800, firstRequestId),
    );
    expect(replay.job.id).toBe(first.job.id);
  });

  it('skips managed caps for BYO providers', async () => {
    const fx = fixture('byo');
    const response = await postRpc(
      'job.create',
      {
        requestId: crypto.randomUUID(),
        payloadHash: 'f'.repeat(64),
        kind: 'provision-environment',
        requestedTarget: {
          kind: 'auto',
          requirements: { capabilities: ['provision:aws-lambda-microvm'] },
        },
        inputManifest: {
          ...manifest(),
          inputs: {
            environmentId: 'env_byo',
            provider: 'aws-lambda-microvm',
            ttlSeconds: 86_400,
          },
        },
      } satisfies JobCreateParams,
      fx.provisionerAuth,
    );
    expect(isRpcError(response.body)).toBe(false);
  });

  it('claims, consumes the bootstrap payload, calls the provisioner, records the env', async () => {
    const fx = fixture('claim');
    await provisionerReset();
    await postRpc(
      'environment.bootstrap',
      { environmentId: fx.environmentId, payload: MANAGED_PAIRING },
      fx.provisionerAuth,
    );
    const created = expectSuccess<JobCreateResult>(
      await createManagedJob(fx.provisionerAuth, fx.environmentId, 1800),
    );
    await sweepAccount(fx.accountId);
    const terminal = await waitJobTerminal(fx.provisionerAuth, created.job.id);
    expect(terminal.job.state).toBe('completed');

    // The provisioner received the staged pairing inside the bootstrap doc —
    // never journaled, never returned to a client.
    const last = await provisionerLast();
    expect(last?.method).toBe('POST');
    expect(last?.path).toBe('/v1/environments');
    expect(last?.body?.environmentId).toBe(fx.environmentId);
    expect(last?.body?.bootstrap?.['pairing']).toBe(MANAGED_PAIRING);
    expect(last?.body?.bootstrap?.['provider']).toBe('anvil-managed');
    expect(last?.body?.bootstrap?.['backendUrl']).toBe('https://api.anvil.test');

    const record = expectSuccess<EnvironmentGetResult>(
      await postRpc('environment.get', { environmentId: fx.environmentId }, fx.provisionerAuth),
    );
    expect(record.environment.provider).toBe('anvil-managed');
    expect(record.environment.state).toBe('provisioning');
    expect(record.environment.handle?.['providerRef']).toBe(`sb-${fx.environmentId}`);
    expect(record.environment.jobId).toBe(created.job.id);
  });

  it('fails the job honestly when no bootstrap payload was staged', async () => {
    const fx = fixture('noboot');
    await provisionerReset();
    const created = expectSuccess<JobCreateResult>(
      await createManagedJob(fx.provisionerAuth, fx.environmentId, 1800),
    );
    await sweepAccount(fx.accountId);
    const terminal = await waitJobTerminal(fx.provisionerAuth, created.job.id);
    expect(terminal.job.state).toBe('failed');
    // No provisioner call happened — nothing was staged to consume.
    expect(await provisionerLast()).toBeNull();
  });

  it('fails the job when the provisioner rejects', async () => {
    const fx = fixture('procfail');
    await provisionerReset();
    await provisionerEnqueue({
      method: 'POST',
      path: '/v1/environments',
      status: 500,
      body: { error: 'boom' },
    });
    await postRpc(
      'environment.bootstrap',
      { environmentId: fx.environmentId, payload: MANAGED_PAIRING },
      fx.provisionerAuth,
    );
    const created = expectSuccess<JobCreateResult>(
      await createManagedJob(fx.provisionerAuth, fx.environmentId, 1800),
    );
    await sweepAccount(fx.accountId);
    const terminal = await waitJobTerminal(fx.provisionerAuth, created.job.id);
    expect(terminal.job.state).toBe('failed');
  });

  it('enacts provider teardown for managed envs holding reap intent', async () => {
    const fx = fixture('mreap');
    await provisionerReset();
    await postRpc(
      'environment.bootstrap',
      { environmentId: fx.environmentId, payload: MANAGED_PAIRING },
      fx.provisionerAuth,
    );
    const created = expectSuccess<JobCreateResult>(
      await createManagedJob(fx.provisionerAuth, fx.environmentId, 1800),
    );
    await sweepAccount(fx.accountId);
    await waitJobTerminal(fx.provisionerAuth, created.job.id);

    await provisionerReset();
    const reaped = expectSuccess<EnvironmentReapResult>(
      await postRpc('environment.reap', { environmentId: fx.environmentId }, fx.provisionerAuth),
    );
    expect(reaped.environment.state).toBe('reap-requested');

    await sweepAccount(fx.accountId);
    const last = await provisionerLast();
    expect(last?.method).toBe('DELETE');
    expect(last?.path).toBe(`/v1/environments/sb-${fx.environmentId}`);

    const record = expectSuccess<EnvironmentGetResult>(
      await postRpc('environment.get', { environmentId: fx.environmentId }, fx.provisionerAuth),
    );
    expect(record.environment.reapedAt).toBeDefined();
  });
});
