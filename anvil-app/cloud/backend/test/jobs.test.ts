import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { isRpcError } from '../../contract/envelope';
import {
  LEASE_DURATION_MS,
  USER_JOB_DEADLINE_MS,
} from '../../contract/version';
import type {
  AttemptRenewResult,
  AttemptReportResult,
  ExecutionManifest,
  JobCancelResult,
  JobClaimResult,
  JobCreateParams,
  JobCreateResult,
  JobGetResult,
  JobListResult,
} from '../../contract/jobs';
import type {
  DevicePolicy,
  DevicePolicyPublishResult,
  WorkerCapabilities,
  WorkerConnectResult,
} from '../../contract/workers';
import type { AccountCoordinator } from '../src/account-coordinator';
import type { SealedTaskPayload } from '../../contract/sealed';
import { expectSuccess, nextFrameOfType, postRpc, spikeBearer, uniqueIds } from './helpers';

/** Valid-shaped sealed envelope — opaque to the backend, no real keying. */
const SEALED_INPUTS: SealedTaskPayload = {
  enc: 'aes-256-gcm',
  nonce: btoa('0123456789ab'),
  ct: btoa('sealed-task-inputs-payload'),
};

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

function allowJobsPolicy(overrides?: {
  allowedSources?: string[];
  maxConcurrentJobs?: number;
}): DevicePolicy {
  return {
    worker: {
      allowJobs: true,
      allowedSources: overrides?.allowedSources ?? ['same-account'],
      maxConcurrentJobs: overrides?.maxConcurrentJobs ?? 2,
    },
  };
}

async function publishPolicy(auth: string, policy: DevicePolicy = allowJobsPolicy()) {
  return expectSuccess<DevicePolicyPublishResult>(
    await postRpc('device.policy.publish', policy, auth),
  );
}

async function connectWorker(auth: string) {
  return expectSuccess<WorkerConnectResult>(await postRpc('worker.connect', {}, auth));
}

async function publishCapabilities(
  auth: string,
  overrides?: Partial<WorkerCapabilities>,
) {
  return expectSuccess(
    await postRpc(
      'worker.capabilities.publish',
      { os: 'macos', arch: 'arm64', memoryMb: 32768, capabilities: ['git', 'node22'], ...overrides },
      auth,
    ),
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

function deviceTarget(enrollmentId: string): JobCreateParams['requestedTarget'] {
  return { kind: 'device', enrollmentId };
}

async function createJob(
  auth: string,
  overrides: Partial<JobCreateParams> = {},
): Promise<JobCreateResult> {
  return expectSuccess<JobCreateResult>(await postRpc('job.create', createParams(overrides), auth));
}

async function getJob(auth: string, jobId: string): Promise<JobGetResult> {
  return expectSuccess<JobGetResult>(await postRpc('job.get', { jobId }, auth));
}

function attemptRow(accountId: string, attemptId: string) {
  return runInDurableObject(accountStub(accountId), (_i: AccountCoordinator, state) => {
    return (
      state.storage.sql
        .exec<{
          state: string;
          late_result: string | null;
          lease_expires_at: number;
        }>(
          'SELECT state, late_result, lease_expires_at FROM attempts WHERE attempt_id = ?',
          attemptId,
        )
        .toArray()[0] ?? null
    );
  });
}

async function openSocket(authorization: string): Promise<WebSocket> {
  const upgrade = await SELF.fetch('https://spike.test/v1/connect', {
    headers: { Upgrade: 'websocket', Authorization: authorization },
  });
  expect(upgrade.status).toBe(101);
  const socket = upgrade.webSocket;
  if (socket == null) {
    throw new Error('expected hibernatable WebSocket');
  }
  socket.accept();
  return socket;
}

describe('job lifecycle', () => {
  it('runs create→claim→renew→report to completion across two enrollments', async () => {
    const f = fixture('happy');
    await publishPolicy(f.workerAuth);
    const connected = await connectWorker(f.workerAuth);

    const created = await createJob(f.sourceAuth, {
      requestedTarget: deviceTarget(f.workerEnrollmentId),
    });
    const job = created.job;
    expect(job.state).toBe('queued');
    expect(job.targetEnrollmentId).toBe(f.workerEnrollmentId);
    expect(job.sourceEnrollmentId).toBe(f.sourceEnrollmentId);
    expect(job.placementExplanation).toMatch(/device:/);
    expect(job.retryPolicy).toBe('inspect-before-retry');
    expect(Date.parse(job.queueDeadline)).toBeGreaterThan(
      Date.now() + USER_JOB_DEADLINE_MS - 60_000,
    );
    expect(Date.parse(job.queueDeadline)).toBeLessThanOrEqual(
      Date.now() + USER_JOB_DEADLINE_MS + 5_000,
    );

    const claimed = expectSuccess<JobClaimResult>(
      await postRpc('job.claim', { jobId: job.id }, f.workerAuth),
    );
    expect(claimed.job.state).toBe('running');
    expect(claimed.fence).toBe(1);
    expect(claimed.attempt.jobId).toBe(job.id);
    expect(claimed.attempt.state).toBe('claimed');
    expect(claimed.attempt.workerIncarnation).toBe(connected.workerIncarnation);
    expect(Date.parse(claimed.attempt.leaseExpiresAt)).toBeGreaterThan(Date.now());
    expect(claimed.manifest.provider).toBe('codex');

    const renewed = expectSuccess<AttemptRenewResult>(
      await postRpc(
        'attempt.renew',
        {
          renewals: [
            {
              attemptId: claimed.attempt.id,
              incarnation: connected.workerIncarnation,
              fence: claimed.fence,
            },
          ],
        },
        f.workerAuth,
      ),
    );
    expect(renewed.results).toHaveLength(1);
    expect(renewed.results[0]?.status).toBe('renewed');
    expect(Date.parse(renewed.results[0]?.leaseExpiresAt as string)).toBeGreaterThan(
      Date.now() + LEASE_DURATION_MS - 30_000,
    );

    const reported = expectSuccess<AttemptReportResult>(
      await postRpc(
        'attempt.report',
        {
          attemptId: claimed.attempt.id,
          incarnation: connected.workerIncarnation,
          fence: claimed.fence,
          outcome: 'completed',
          result: { summary: 'all good' },
        },
        f.workerAuth,
      ),
    );
    expect(reported.status).toBe('applied');
    expect(reported.job.state).toBe('completed');
    expect(reported.attempt.state).toBe('completed');

    const fetched = await getJob(f.sourceAuth, job.id);
    expect(fetched.job.state).toBe('completed');
    expect(fetched.attempts).toHaveLength(1);
    expect(fetched.attempts[0]?.state).toBe('completed');
  });

  it('returns the stored job on same requestId+hash and conflicts on a different hash', async () => {
    const f = fixture('idem');
    await publishPolicy(f.workerAuth);
    await connectWorker(f.workerAuth);
    const params = createParams({
      requestedTarget: deviceTarget(f.workerEnrollmentId),
    });

    const first = expectSuccess<JobCreateResult>(
      await postRpc('job.create', params, f.sourceAuth),
    );
    const replay = expectSuccess<JobCreateResult>(
      await postRpc('job.create', params, f.sourceAuth),
    );
    expect(replay.job.id).toBe(first.job.id);
    expect(replay.job.state).toBe('queued');

    const clash = await postRpc(
      'job.create',
      { ...params, payloadHash: 'b'.repeat(64) },
      f.sourceAuth,
    );
    expect(clash.status).toBe(409);
    if (isRpcError(clash.body)) {
      expect(clash.body.error.code).toBe('conflict');
      expect(clash.body.error.details?.['reason']).toBe('request-id-hash-mismatch');
    }
  });

  it('rejects malformed create params', async () => {
    const f = fixture('malformed');
    const auth = f.sourceAuth;
    for (const params of [
      { requestId: 'r', payloadHash: 'zz', kind: 'diagnostic', requestedTarget: { kind: 'auto' }, inputManifest: manifest() },
      { requestId: 'r', payloadHash: 'a'.repeat(64), kind: 'bogus', requestedTarget: { kind: 'auto' }, inputManifest: manifest() },
      { requestId: 'r', payloadHash: 'a'.repeat(64), kind: 'diagnostic', requestedTarget: { kind: 'sideways' }, inputManifest: manifest() },
      { requestId: 'r', payloadHash: 'a'.repeat(64), kind: 'diagnostic', requestedTarget: { kind: 'auto' }, inputManifest: { provider: 'x' } },
      { requestId: 'r', payloadHash: 'a'.repeat(64), kind: 'diagnostic', requestedTarget: { kind: 'auto' }, inputManifest: manifest(), queueDeadline: 'not-a-date' },
      { requestId: 'r', payloadHash: 'a'.repeat(64), kind: 'diagnostic', requestedTarget: { kind: 'auto' }, inputManifest: manifest(), retryPolicy: 'sometimes' },
    ]) {
      const denied = await postRpc('job.create', params, auth);
      expect(denied.status).toBe(400);
      if (isRpcError(denied.body)) {
        expect(denied.body.error.code).toBe('malformed-request');
      }
    }
  });
});

describe('claim gating', () => {
  it('rejects workers without a live incarnation and leaves auto jobs unresolved', async () => {
    const f = fixture('gate-live');
    await publishPolicy(f.workerAuth);

    const created = await createJob(f.sourceAuth, {
      requestedTarget: { kind: 'auto' },
    });
    // No live worker qualified: queued, unresolved, with the explanation.
    expect(created.job.state).toBe('queued');
    expect(created.job.targetEnrollmentId).toBeUndefined();
    expect(created.job.placementExplanation).toMatch(/no eligible live worker/);

    const denied = await postRpc('job.claim', { jobId: created.job.id }, f.workerAuth);
    expect(denied.status).toBe(403);
    if (isRpcError(denied.body)) {
      expect(denied.body.error.details?.['reason']).toBe('worker-not-connected');
    }
  });

  it('rejects claims when the worker policy disallows the source', async () => {
    const f = fixture('gate-policy');
    // The only worker publishes a policy that excludes the source enrollment.
    await publishPolicy(f.workerAuth, allowJobsPolicy({ allowedSources: ['enr-unrelated'] }));
    await connectWorker(f.workerAuth);

    const created = await createJob(f.sourceAuth, { requestedTarget: { kind: 'auto' } });
    expect(created.job.targetEnrollmentId).toBeUndefined();

    const denied = await postRpc('job.claim', { jobId: created.job.id }, f.workerAuth);
    expect(denied.status).toBe(403);
    if (isRpcError(denied.body)) {
      expect(denied.body.error.details?.['reason']).toBe('source-not-allowed');
    }
  });

  it('rejects claims past the queue deadline and marks the job failed', async () => {
    const f = fixture('gate-deadline');
    await publishPolicy(f.workerAuth);
    await connectWorker(f.workerAuth);
    const created = await createJob(f.sourceAuth, {
      requestedTarget: deviceTarget(f.workerEnrollmentId),
    });

    const past = Date.now() - 1_000;
    await runInDurableObject(accountStub(f.accountId), (_i: AccountCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE jobs SET queue_deadline = ? WHERE job_id = ?',
        past,
        created.job.id,
      );
    });

    const denied = await postRpc('job.claim', { jobId: created.job.id }, f.workerAuth);
    expect(denied.status).toBe(409);
    if (isRpcError(denied.body)) {
      expect(denied.body.error.details?.['reason']).toBe('queue-deadline');
    }

    const fetched = await getJob(f.sourceAuth, created.job.id);
    expect(fetched.job.state).toBe('failed');
    expect(fetched.job.stateReason).toBe('queue-deadline');
  });

  it('enforces the concurrency cap at claim', async () => {
    const f = fixture('gate-capacity');
    await publishPolicy(f.workerAuth, allowJobsPolicy({ maxConcurrentJobs: 1 }));
    await connectWorker(f.workerAuth);

    const first = await createJob(f.sourceAuth, {
      requestedTarget: deviceTarget(f.workerEnrollmentId),
    });
    expectSuccess(await postRpc('job.claim', { jobId: first.job.id }, f.workerAuth));

    const second = await createJob(f.sourceAuth, {
      requestedTarget: deviceTarget(f.workerEnrollmentId),
    });
    const denied = await postRpc('job.claim', { jobId: second.job.id }, f.workerAuth);
    expect(denied.status).toBe(409);
    if (isRpcError(denied.body)) {
      expect(denied.body.error.details?.['reason']).toBe('worker-at-capacity');
    }
  });

  it('rejects claims by a different enrollment than the resolved target', async () => {
    const f = fixture('gate-target');
    const third = spikeBearer(f.accountId, `enr-third-${crypto.randomUUID()}`);
    await publishPolicy(f.workerAuth);
    await connectWorker(f.workerAuth);
    await publishPolicy(third);
    await connectWorker(third);

    const created = await createJob(f.sourceAuth, {
      requestedTarget: deviceTarget(f.workerEnrollmentId),
    });
    const denied = await postRpc('job.claim', { jobId: created.job.id }, third);
    expect(denied.status).toBe(403);
    if (isRpcError(denied.body)) {
      expect(denied.body.error.details?.['reason']).toBe('not-the-target');
    }
  });
});

describe('fence semantics', () => {
  it('rejects stale fences/incarnations on renew and retains late reports', async () => {
    const f = fixture('fence');
    await publishPolicy(f.workerAuth);
    const connected = await connectWorker(f.workerAuth);
    const created = await createJob(f.sourceAuth, {
      requestedTarget: deviceTarget(f.workerEnrollmentId),
    });
    const claimed = expectSuccess<JobClaimResult>(
      await postRpc('job.claim', { jobId: created.job.id }, f.workerAuth),
    );

    const renewed = expectSuccess<AttemptRenewResult>(
      await postRpc(
        'attempt.renew',
        {
          renewals: [
            // Stale fence.
            {
              attemptId: claimed.attempt.id,
              incarnation: connected.workerIncarnation,
              fence: claimed.fence + 10,
            },
            // Stale incarnation.
            {
              attemptId: claimed.attempt.id,
              incarnation: 'incarnation-not-current',
              fence: claimed.fence,
            },
            // Unknown attempt.
            { attemptId: 'attempt-nope', incarnation: connected.workerIncarnation, fence: 1 },
            // The real one still renews: per-item failures never fail the batch.
            {
              attemptId: claimed.attempt.id,
              incarnation: connected.workerIncarnation,
              fence: claimed.fence,
            },
          ],
        },
        f.workerAuth,
      ),
    );
    expect(renewed.results.map((r) => [r.status, r.reason ?? null])).toEqual([
      ['rejected', 'stale-fence'],
      ['rejected', 'stale-incarnation'],
      ['rejected', 'not-found'],
      ['renewed', null],
    ]);

    // A report with a stale fence is rejected but its recoverable result is
    // retained on the attempt row; job and attempt states do not move.
    const late = expectSuccess<AttemptReportResult>(
      await postRpc(
        'attempt.report',
        {
          attemptId: claimed.attempt.id,
          incarnation: connected.workerIncarnation,
          fence: claimed.fence + 10,
          outcome: 'completed',
          result: { partial: 'late evidence' },
        },
        f.workerAuth,
      ),
    );
    expect(late.status).toBe('late-result-retained');
    expect(late.job.state).toBe('running');
    expect(late.attempt.state).toBe('claimed');

    const stored = await attemptRow(f.accountId, claimed.attempt.id);
    expect(stored?.state).toBe('claimed');
    expect(stored?.late_result).not.toBeNull();
    expect(stored?.late_result).toContain('late evidence');

    // The fence-matched report still applies afterwards.
    const reported = expectSuccess<AttemptReportResult>(
      await postRpc(
        'attempt.report',
        {
          attemptId: claimed.attempt.id,
          incarnation: connected.workerIncarnation,
          fence: claimed.fence,
          outcome: 'completed',
        },
        f.workerAuth,
      ),
    );
    expect(reported.status).toBe('applied');
    expect(reported.job.state).toBe('completed');
  });
});

describe('cancellation', () => {
  it('cancels a queued job directly and stays idempotent', async () => {
    const f = fixture('cancel-queued');
    await publishPolicy(f.workerAuth);
    await connectWorker(f.workerAuth);
    const created = await createJob(f.sourceAuth, {
      requestedTarget: deviceTarget(f.workerEnrollmentId),
    });

    const cancelled = expectSuccess<JobCancelResult>(
      await postRpc('job.cancel', { jobId: created.job.id }, f.sourceAuth),
    );
    expect(cancelled.job.state).toBe('cancelled');

    const again = expectSuccess<JobCancelResult>(
      await postRpc('job.cancel', { jobId: created.job.id }, f.sourceAuth),
    );
    expect(again.job.state).toBe('cancelled');

    const denied = await postRpc('job.claim', { jobId: created.job.id }, f.workerAuth);
    expect(denied.status).toBe(409);
  });

  it('moves a running job to cancel-requested and masks a later completion', async () => {
    const f = fixture('cancel-running');
    await publishPolicy(f.workerAuth);
    const connected = await connectWorker(f.workerAuth);
    const created = await createJob(f.sourceAuth, {
      requestedTarget: deviceTarget(f.workerEnrollmentId),
    });
    const claimed = expectSuccess<JobClaimResult>(
      await postRpc('job.claim', { jobId: created.job.id }, f.workerAuth),
    );

    const cancelling = expectSuccess<JobCancelResult>(
      await postRpc('job.cancel', { jobId: created.job.id }, f.sourceAuth),
    );
    expect(cancelling.job.state).toBe('cancel-requested');

    const mid = await getJob(f.sourceAuth, created.job.id);
    expect(mid.job.state).toBe('cancel-requested');
    expect(mid.attempts[0]?.state).toBe('stopping');

    // The verified stop: the report is applied but completion is masked —
    // cancellation wins, the job confirms cancelled instead of completed.
    const reported = expectSuccess<AttemptReportResult>(
      await postRpc(
        'attempt.report',
        {
          attemptId: claimed.attempt.id,
          incarnation: connected.workerIncarnation,
          fence: claimed.fence,
          outcome: 'completed',
          result: { partial: 'work done before stop' },
        },
        f.workerAuth,
      ),
    );
    expect(reported.status).toBe('applied');
    expect(reported.job.state).toBe('cancelled');
    expect(reported.attempt.state).toBe('cancelled');

    const fetched = await getJob(f.sourceAuth, created.job.id);
    expect(fetched.job.state).toBe('cancelled');
  });
});

describe('partition and stale completion', () => {
  it('never reassigns on lease expiry; the stale attempt ages to unknown-outcome', async () => {
    const f = fixture('partition');
    const secondWorkerAuth = spikeBearer(f.accountId, `enr-second-${crypto.randomUUID()}`);
    await publishPolicy(f.workerAuth);
    const connected = await connectWorker(f.workerAuth);
    await publishPolicy(secondWorkerAuth);
    await connectWorker(secondWorkerAuth);

    const created = await createJob(f.sourceAuth, {
      requestedTarget: deviceTarget(f.workerEnrollmentId),
    });
    const claimed = expectSuccess<JobClaimResult>(
      await postRpc('job.claim', { jobId: created.job.id }, f.workerAuth),
    );

    // Partition: worker A's attempt lease lapses.
    await runInDurableObject(accountStub(f.accountId), (_i: AccountCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE attempts SET lease_expires_at = ? WHERE attempt_id = ?',
        Date.now() - 1_000,
        claimed.attempt.id,
      );
    });

    // Worker B cannot take over: the job is running, not queued — no
    // reassignment merely because a lease expired.
    const denied = await postRpc('job.claim', { jobId: created.job.id }, secondWorkerAuth);
    expect(denied.status).toBe(409);
    if (isRpcError(denied.body)) {
      expect(denied.body.error.details?.['reason']).toBe('job-not-queued');
    }

    // Worker A cannot renew a lapsed lease.
    const renew = expectSuccess<AttemptRenewResult>(
      await postRpc(
        'attempt.renew',
        {
          renewals: [
            {
              attemptId: claimed.attempt.id,
              incarnation: connected.workerIncarnation,
              fence: claimed.fence,
            },
          ],
        },
        f.workerAuth,
      ),
    );
    expect(renew.results[0]?.status).toBe('rejected');
    expect(renew.results[0]?.reason).toBe('lease-expired');

    // Well past expiry, the bounded sweep marks the attempt unknown-outcome;
    // the job stays running until explicitly reconciled.
    await runInDurableObject(accountStub(f.accountId), (_i: AccountCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE attempts SET lease_expires_at = ? WHERE attempt_id = ?',
        Date.now() - LEASE_DURATION_MS - 1_000,
        claimed.attempt.id,
      );
    });
    const sweep = await accountStub(f.accountId).fetch(
      new Request('https://internal.anvil/internal/sweep', { method: 'POST' }),
    );
    const stats = (await sweep.json()) as { staleAttempts: number };
    expect(stats.staleAttempts).toBe(1);

    const fetched = await getJob(f.sourceAuth, created.job.id);
    expect(fetched.job.state).toBe('running');
    expect(fetched.attempts[0]?.state).toBe('unknown-outcome');

    // A late report from the stale attempt is retained for forensics but
    // transitions nothing.
    const late = expectSuccess<AttemptReportResult>(
      await postRpc(
        'attempt.report',
        {
          attemptId: claimed.attempt.id,
          incarnation: connected.workerIncarnation,
          fence: claimed.fence,
          outcome: 'completed',
          result: { finished: 'during partition' },
        },
        f.workerAuth,
      ),
    );
    expect(late.status).toBe('late-result-retained');
    expect(late.job.state).toBe('running');

    const stored = await attemptRow(f.accountId, claimed.attempt.id);
    expect(stored?.state).toBe('unknown-outcome');
    expect(stored?.late_result).toContain('during partition');
  });
});

describe('job.available fanout', () => {
  it('delivers job.available only to the resolved target enrollment sockets', async () => {
    const f = fixture('fanout');
    const thirdAuth = spikeBearer(f.accountId, `enr-third-${crypto.randomUUID()}`);
    await publishPolicy(f.workerAuth);
    await connectWorker(f.workerAuth);

    const workerSocket = await openSocket(f.workerAuth);
    const sourceSocket = await openSocket(f.sourceAuth);
    const thirdSocket = await openSocket(thirdAuth);

    // The session `hello` opens every socket — skip it when waiting on a
    // specific frame, and exclude it from the silence assertions.
    const workerFrame = nextFrameOfType(workerSocket, 'job.available');
    let sourceHeard: string | null = null;
    let thirdHeard: string | null = null;
    const nonHello = (data: unknown): string | null => {
      const text = String(data);
      try {
        if ((JSON.parse(text) as { type?: string }).type === 'hello') return null;
      } catch {
        // Non-JSON noise still counts as "heard".
      }
      return text;
    };
    sourceSocket.addEventListener('message', (event) => {
      sourceHeard ??= nonHello(event.data);
    });
    thirdSocket.addEventListener('message', (event) => {
      thirdHeard ??= nonHello(event.data);
    });

    const created = await createJob(f.sourceAuth, {
      requestedTarget: deviceTarget(f.workerEnrollmentId),
    });

    const frame = (await workerFrame) as {
      type: string;
      version: number;
      id: string;
      jobId: string;
    };
    expect(frame.type).toBe('job.available');
    expect(frame.version).toBe(1);
    expect(frame.jobId).toBe(created.job.id);

    // Source and unrelated enrollments hear nothing.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(sourceHeard).toBeNull();
    expect(thirdHeard).toBeNull();

    workerSocket.close(1000, 'done');
    sourceSocket.close(1000, 'done');
    thirdSocket.close(1000, 'done');
  });
});

describe('retry policy and listing', () => {
  it('re-queues a safe-retry job exactly once, then fails', async () => {
    const f = fixture('retry');
    await publishPolicy(f.workerAuth);
    const connected = await connectWorker(f.workerAuth);
    const created = await createJob(f.sourceAuth, {
      requestedTarget: deviceTarget(f.workerEnrollmentId),
      retryPolicy: 'safe',
    });

    const first = expectSuccess<JobClaimResult>(
      await postRpc('job.claim', { jobId: created.job.id }, f.workerAuth),
    );
    const failed = expectSuccess<AttemptReportResult>(
      await postRpc(
        'attempt.report',
        {
          attemptId: first.attempt.id,
          incarnation: connected.workerIncarnation,
          fence: first.fence,
          outcome: 'failed',
          error: 'transient',
        },
        f.workerAuth,
      ),
    );
    expect(failed.status).toBe('applied');
    expect(failed.job.state).toBe('queued');
    expect(failed.job.stateReason).toBe('retry-safe');
    expect(failed.attempt.state).toBe('failed');

    // Re-claim allocates the next fence on the same job.
    const second = expectSuccess<JobClaimResult>(
      await postRpc('job.claim', { jobId: created.job.id }, f.workerAuth),
    );
    expect(second.fence).toBe(2);
    expect(second.attempt.id).not.toBe(first.attempt.id);

    const failedAgain = expectSuccess<AttemptReportResult>(
      await postRpc(
        'attempt.report',
        {
          attemptId: second.attempt.id,
          incarnation: connected.workerIncarnation,
          fence: second.fence,
          outcome: 'failed',
          error: 'again',
        },
        f.workerAuth,
      ),
    );
    expect(failedAgain.job.state).toBe('failed');
    expect(failedAgain.job.stateReason).toBe('attempt-failed');
  });

  it('lists jobs with a state filter and a bounded limit', async () => {
    const f = fixture('list');
    await publishPolicy(f.workerAuth);
    await connectWorker(f.workerAuth);
    const a = await createJob(f.sourceAuth, {
      requestedTarget: deviceTarget(f.workerEnrollmentId),
    });
    const b = await createJob(f.sourceAuth, { requestedTarget: { kind: 'auto' } });

    const all = expectSuccess<JobListResult>(
      await postRpc('job.list', {}, f.sourceAuth),
    );
    expect(all.jobs.map((job) => job.id).sort()).toEqual([a.job.id, b.job.id].sort());

    const queued = expectSuccess<JobListResult>(
      await postRpc('job.list', { state: 'queued' }, f.sourceAuth),
    );
    expect(queued.jobs).toHaveLength(2);
    const completed = expectSuccess<JobListResult>(
      await postRpc('job.list', { state: 'completed' }, f.sourceAuth),
    );
    expect(completed.jobs).toHaveLength(0);
    const limited = expectSuccess<JobListResult>(
      await postRpc('job.list', { limit: 1 }, f.sourceAuth),
    );
    expect(limited.jobs).toHaveLength(1);

    const found = expectSuccess<JobListResult>(
      await postRpc('job.list', { requestId: a.job.requestId, limit: 1 }, f.sourceAuth),
    );
    expect(found.jobs).toHaveLength(1);
    expect(found.jobs[0]?.id).toBe(a.job.id);
    const stateMismatch = expectSuccess<JobListResult>(
      await postRpc(
        'job.list',
        { requestId: a.job.requestId, state: 'completed' },
        f.sourceAuth,
      ),
    );
    expect(stateMismatch.jobs).toHaveLength(0);
    const missing = expectSuccess<JobListResult>(
      await postRpc('job.list', { requestId: 'missing-request' }, f.sourceAuth),
    );
    expect(missing.jobs).toHaveLength(0);
    const otherSource = expectSuccess<JobListResult>(
      await postRpc('job.list', { requestId: a.job.requestId }, f.workerAuth),
    );
    expect(otherSource.jobs).toHaveLength(0);

    const overLimit = await postRpc('job.list', { limit: 101 }, f.sourceAuth);
    expect(overLimit.status).toBe(400);
  });
});

describe('auto placement workspace readiness (PLACE-01)', () => {
  async function publishReplicas(
    auth: string,
    replicas: Array<{
      workspaceId: string;
      definitionRevision: string;
      readiness: 'ready' | 'cloning' | 'error' | 'not-ready';
    }>,
  ) {
    return expectSuccess(
      await postRpc(
        'worker.replica.publish',
        {
          replicas: replicas.map((r) => ({ ...r, observedAt: new Date().toISOString() })),
        },
        auth,
      ),
    );
  }

  function workspaceManifest(): ExecutionManifest {
    return {
      ...manifest(),
      inputs: { workspaceId: 'ws-1' },
    };
  }

  it('leaves a workspace-consuming auto job unresolved when no ready replica exists', async () => {
    const f = fixture('ready-none');
    await publishPolicy(f.workerAuth);
    await connectWorker(f.workerAuth);
    const created = await createJob(f.sourceAuth, {
      kind: 'code-task',
      inputManifest: workspaceManifest(),
      requestedTarget: { kind: 'auto' },
    });
    expect(created.job.targetEnrollmentId).toBeUndefined();
    expect(created.job.placementExplanation).toMatch(/workspace readiness/);

    const denied = await postRpc('job.claim', { jobId: created.job.id }, f.workerAuth);
    expect(denied.status).toBe(409);
    if (isRpcError(denied.body)) {
      expect(denied.body.error.details?.['reason']).toBe('target-not-eligible');
    }

    // A later ready publication makes the still-queued job eligible. Claim
    // resolves and persists the target inside its transaction.
    await publishReplicas(f.workerAuth, [
      { workspaceId: 'ws-1', definitionRevision: 'wsdef-rev-1', readiness: 'ready' },
    ]);
    const claimed = expectSuccess<JobClaimResult>(
      await postRpc('job.claim', { jobId: created.job.id }, f.workerAuth),
    );
    expect(claimed.job.targetEnrollmentId).toBe(f.workerEnrollmentId);
  });

  it('does not let an underqualified worker claim an unresolved auto job', async () => {
    const f = fixture('requirements-unresolved');
    await publishPolicy(f.workerAuth);
    await connectWorker(f.workerAuth);
    await publishCapabilities(f.workerAuth);

    const created = await createJob(f.sourceAuth, {
      requestedTarget: { kind: 'auto', requirements: { capabilities: ['docker'] } },
    });
    expect(created.job.targetEnrollmentId).toBeUndefined();

    const denied = await postRpc('job.claim', { jobId: created.job.id }, f.workerAuth);
    expect(denied.status).toBe(409);
    if (isRpcError(denied.body)) {
      expect(denied.body.error.details?.['reason']).toBe('target-not-eligible');
    }
  });

  it('resolves to the worker with a ready replica at the pinned revision', async () => {
    const f = fixture('ready-match');
    await publishPolicy(f.workerAuth);
    await connectWorker(f.workerAuth);
    await publishReplicas(f.workerAuth, [
      { workspaceId: 'ws-1', definitionRevision: 'wsdef-rev-1', readiness: 'ready' },
    ]);
    const created = await createJob(f.sourceAuth, {
      kind: 'code-task',
      inputManifest: workspaceManifest(),
      requestedTarget: { kind: 'auto' },
    });
    expect(created.job.targetEnrollmentId).toBe(f.workerEnrollmentId);
    expect(created.job.placementExplanation).toMatch(/auto: least-loaded/);
  });

  it('rejects a replica that is ready at a stale definition revision', async () => {
    const f = fixture('ready-stale');
    await publishPolicy(f.workerAuth);
    await connectWorker(f.workerAuth);
    // Ready at rev-0 does not satisfy a job pinned at rev-1.
    await publishReplicas(f.workerAuth, [
      { workspaceId: 'ws-1', definitionRevision: 'wsdef-rev-0', readiness: 'ready' },
    ]);
    const created = await createJob(f.sourceAuth, {
      kind: 'code-task',
      inputManifest: workspaceManifest(),
      requestedTarget: { kind: 'auto' },
    });
    expect(created.job.targetEnrollmentId).toBeUndefined();
  });

  it('prepare-workspace and diagnostic jobs do not require readiness', async () => {
    const f = fixture('ready-free');
    await publishPolicy(f.workerAuth);
    await connectWorker(f.workerAuth);
    const prep = await createJob(f.sourceAuth, {
      kind: 'prepare-workspace',
      inputManifest: workspaceManifest(),
      requestedTarget: { kind: 'auto' },
    });
    expect(prep.job.targetEnrollmentId).toBe(f.workerEnrollmentId);
    const diag = await createJob(f.sourceAuth, { requestedTarget: { kind: 'auto' } });
    expect(diag.job.targetEnrollmentId).toBe(f.workerEnrollmentId);
  });

  it('an explicit device target still overrides readiness', async () => {
    const f = fixture('ready-explicit');
    await publishPolicy(f.workerAuth);
    await connectWorker(f.workerAuth);
    const created = await createJob(f.sourceAuth, {
      kind: 'code-task',
      inputManifest: workspaceManifest(),
      requestedTarget: deviceTarget(f.workerEnrollmentId),
    });
    expect(created.job.targetEnrollmentId).toBe(f.workerEnrollmentId);
  });
});
