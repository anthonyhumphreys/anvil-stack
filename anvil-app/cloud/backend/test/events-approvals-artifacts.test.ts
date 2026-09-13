import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { isRpcError } from '../../contract/envelope';
import type {
  ArtifactDeleteResult,
  ArtifactFinalizeResult,
  ArtifactGetResult,
  ArtifactListResult,
  ArtifactReserveResult,
} from '../../contract/artifacts';
import type {
  ApprovalDecideResult,
  ApprovalGetResult,
  EventPullResult,
  ExecutionManifest,
  JobClaimResult,
  JobCreateParams,
  JobCreateResult,
  JobGetResult,
} from '../../contract/jobs';
import type {
  DevicePolicy,
  DevicePolicyPublishResult,
  WorkerConnectResult,
} from '../../contract/workers';
import type { AccountCoordinator } from '../src/account-coordinator';
import { sha256Hex, utf8ByteLength } from '../src/hash';
import { expectSuccess, postRpc, spikeBearer, uniqueIds } from './helpers';

const JOB_EVENT_BUDGET_BYTES = 1024 * 1024;
const ACCOUNT_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
const ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

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

function allowJobsPolicy(): DevicePolicy {
  return {
    worker: { allowJobs: true, allowedSources: ['same-account'], maxConcurrentJobs: 2 },
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

function createParams(overrides: Partial<JobCreateParams> = {}): JobCreateParams {
  return {
    requestId: crypto.randomUUID(),
    payloadHash: 'a'.repeat(64),
    kind: 'diagnostic',
    requestedTarget: { kind: 'auto' },
    inputManifest: manifest(),
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

interface RunningJob {
  jobId: string;
  attemptId: string;
  fence: number;
  workerIncarnation: string;
}

/** Policy + live worker + created + claimed job: the attempt is active. */
async function runningJob(f: Fixture): Promise<RunningJob> {
  await publishPolicy(f.workerAuth);
  const connected = await connectWorker(f.workerAuth);
  const created = await createJob(f.sourceAuth, {
    requestedTarget: deviceTarget(f.workerEnrollmentId),
  });
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

interface Frame {
  type?: string;
  [key: string]: unknown;
}

function collectFrames(socket: WebSocket): Frame[] {
  const frames: Frame[] = [];
  socket.addEventListener('message', (event) => {
    frames.push(JSON.parse(String(event.data)) as Frame);
  });
  return frames;
}

async function waitForFrame<T>(
  frames: Frame[],
  pick: (frame: Frame) => T | null,
  timeoutMs = 4_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of frames) {
      const hit = pick(frame);
      if (hit !== null) {
        return hit;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for socket frame');
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 4_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!predicate(last)) {
    if (Date.now() > deadline) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    last = await fn();
  }
  return last;
}

function send(socket: WebSocket, frame: Frame): void {
  socket.send(JSON.stringify(frame));
}

function activityFrame(
  attemptId: string,
  generation: number,
  sequence: number,
  text: string,
  streamId = 'stdout',
): Frame {
  return {
    type: 'activity',
    version: 1,
    id: crypto.randomUUID(),
    attemptId,
    generation,
    streamId,
    sequence,
    payload: { kind: 'stdout', text, byteLength: utf8ByteLength(text), truncated: false },
  };
}

function controlFrame(
  attemptId: string,
  generation: number,
  doc: Record<string, unknown>,
): Frame {
  const text = JSON.stringify(doc);
  return {
    type: 'activity',
    version: 1,
    id: crypto.randomUUID(),
    attemptId,
    generation,
    streamId: 'control',
    sequence: 1,
    payload: { kind: 'status', text, byteLength: utf8ByteLength(text), truncated: false },
  };
}

function subscribeFrame(id: string, scope: string, afterSequence?: number): Frame {
  return {
    type: 'subscribe',
    version: 1,
    id,
    scope,
    ...(afterSequence === undefined ? {} : { afterSequence }),
  };
}

/** Sends a worker `control` approval request; resolves with the approval id. */
async function requestApproval(
  workerSocket: WebSocket,
  workerFrames: Frame[],
  job: RunningJob,
  doc?: Record<string, unknown>,
): Promise<string> {
  send(
    workerSocket,
    controlFrame(job.attemptId, job.fence, {
      request: 'approval',
      actionDigest: `sha256:${'a'.repeat(8)}`,
      ...doc,
    }),
  );
  const ack = await waitForFrame(workerFrames, (frame) => {
    if (frame['type'] === 'activity' && frame['streamId'] === 'control') {
      const payload = frame['payload'] as { kind: string; text: string };
      if (payload.kind === 'status') {
        const parsed = JSON.parse(payload.text) as Record<string, unknown>;
        if (parsed['type'] === 'approval.requested') {
          return parsed;
        }
      }
    }
    return null;
  });
  return ack['approvalId'] as string;
}

async function pullEvents(
  auth: string,
  scope: string,
  afterSequence = 0,
  limit?: number,
): Promise<EventPullResult> {
  return expectSuccess<EventPullResult>(
    await postRpc(
      'event.pull',
      { scope, afterSequence, ...(limit === undefined ? {} : { limit }) },
      auth,
    ),
  );
}

async function putArtifact(path: string, auth: string, body: Uint8Array): Promise<Response> {
  return SELF.fetch(`https://spike.test${path}`, {
    method: 'PUT',
    headers: { Authorization: auth, 'content-type': 'application/octet-stream' },
    body,
  });
}

async function getArtifactBytes(path: string, auth: string | null): Promise<Response> {
  return SELF.fetch(`https://spike.test${path}`, {
    headers: auth === null ? {} : { Authorization: auth },
  });
}

describe('durable event journal', () => {
  it('journals lifecycle transitions in cursor order and resumes at afterSequence', async () => {
    const f = fixture('ev-order');
    const job = await runningJob(f);
    expectSuccess(
      await postRpc(
        'attempt.report',
        {
          attemptId: job.attemptId,
          incarnation: job.workerIncarnation,
          fence: job.fence,
          outcome: 'completed',
          result: { ok: true },
        },
        f.workerAuth,
      ),
    );

    const page = await pullEvents(f.sourceAuth, job.jobId);
    expect(page.scopeKind).toBe('job');
    expect(page.scopeId).toBe(job.jobId);
    expect(page.hasMore).toBe(false);
    expect(page.hasGap).toBe(false);
    expect(page.events.map((e) => e.kind)).toEqual([
      'job.created',
      'attempt.created',
      'job.state',
      'attempt.state',
      'job.state',
    ]);
    const cursors = page.events.map((e) => e.cursor);
    expect([...cursors].sort((a, b) => a - b)).toEqual(cursors);
    expect(page.nextCursor).toBe(cursors[cursors.length - 1]);
    const first = page.events[0];
    expect(first?.payload).toMatchObject({ state: 'queued' });
    const running = page.events[2];
    expect(running?.payload).toMatchObject({ from: 'queued', to: 'running' });
    const done = page.events[4];
    expect(done?.payload).toMatchObject({ from: 'running', to: 'completed' });

    // Resume mid-stream: only later rows return.
    const resumed = await pullEvents(f.sourceAuth, job.jobId, first?.cursor ?? 0);
    expect(resumed.events.map((e) => e.kind)).toEqual([
      'attempt.created',
      'job.state',
      'attempt.state',
      'job.state',
    ]);
    expect(resumed.events.every((e) => e.cursor > (first?.cursor ?? 0))).toBe(true);

    // Attempt scope carries only attempt-scoped rows.
    const attemptScoped = await pullEvents(f.sourceAuth, job.attemptId);
    expect(attemptScoped.scopeKind).toBe('attempt');
    expect(attemptScoped.jobId).toBe(job.jobId);
    expect(attemptScoped.events.map((e) => e.kind)).toEqual(['attempt.created', 'attempt.state']);
    expect(attemptScoped.events.every((e) => e.attemptId === job.attemptId)).toBe(true);
  });

  it('enforces account ownership and existence of the pull scope', async () => {
    const f = fixture('ev-scope');
    const job = await runningJob(f);
    const other = fixture('ev-scope-other');

    for (const scope of [job.jobId, job.attemptId]) {
      const denied = await postRpc('event.pull', { scope }, other.sourceAuth);
      expect(denied.status).toBe(404);
      if (isRpcError(denied.body)) {
        expect(denied.body.error.code).toBe('not-found');
      }
    }
    const missing = await postRpc('event.pull', { scope: 'no-such-scope' }, f.sourceAuth);
    expect(missing.status).toBe(404);
  });

  it('bounds pages by limit with hasMore/nextCursor', async () => {
    const f = fixture('ev-page');
    const job = await runningJob(f); // three events: created, attempt.created, job.state

    const first = await pullEvents(f.sourceAuth, job.jobId, 0, 2);
    expect(first.events).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(first.events[1]?.cursor);

    const rest = await pullEvents(f.sourceAuth, job.jobId, first.nextCursor, 2);
    expect(rest.events).toHaveLength(1);
    expect(rest.hasMore).toBe(false);

    const over = await postRpc('event.pull', { scope: job.jobId, limit: 999 }, f.sourceAuth);
    expect(over.status).toBe(400);
    if (isRpcError(over.body)) {
      expect(over.body.error.code).toBe('malformed-request');
    }
  });

  it('journals worker activity and dedupes on (attempt, stream, sequence)', async () => {
    const f = fixture('ev-activity');
    const job = await runningJob(f);
    const workerSocket = await openSocket(f.workerAuth);

    send(workerSocket, activityFrame(job.attemptId, job.fence, 1, 'line-1\n'));
    send(workerSocket, activityFrame(job.attemptId, job.fence, 2, 'line-2\n'));
    // A replayed (attempt, stream, sequence) triple is a deduped no-op.
    send(workerSocket, activityFrame(job.attemptId, job.fence, 2, 'line-2-DUP\n'));

    const page = await pollUntil(
      () => pullEvents(f.sourceAuth, job.jobId),
      (p) => p.events.filter((e) => e.kind === 'activity').length >= 2,
    );
    const activity = page.events.filter((e) => e.kind === 'activity');
    expect(activity).toHaveLength(2);
    expect(activity.map((e) => e.sequence)).toEqual([1, 2]);
    expect((activity[1]?.payload as { text: string }).text).toBe('line-2\n');
    expect(activity.every((e) => e.streamId === 'stdout' && e.attemptId === job.attemptId)).toBe(
      true,
    );
    workerSocket.close(1000, 'done');
  });

  it('materializes over-budget activity as gap rows, reports hasGap, resumes when budget frees', async () => {
    const f = fixture('ev-gap');
    const job = await runningJob(f);
    const workerSocket = await openSocket(f.workerAuth);

    send(workerSocket, activityFrame(job.attemptId, job.fence, 1, 'kept\n'));

    // Exhaust the per-job activity budget so subsequent frames drop to gaps.
    await runInDurableObject(accountStub(f.accountId), (_i: AccountCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE job_event_meta SET activity_bytes = ? WHERE job_id = ?',
        JOB_EVENT_BUDGET_BYTES,
        job.jobId,
      );
    });
    send(workerSocket, activityFrame(job.attemptId, job.fence, 2, 'dropped-a\n'));
    send(workerSocket, activityFrame(job.attemptId, job.fence, 3, 'dropped-b\n'));

    const page = await pollUntil(
      () => pullEvents(f.sourceAuth, job.jobId),
      (p) =>
        p.events
          .filter((e) => e.kind === 'gap')
          .reduce(
            (n, e) => n + (e.payload as { droppedEvents: number }).droppedEvents,
            0,
          ) >= 2,
    );
    const gapRows = page.events.filter((e) => e.kind === 'gap');
    expect(gapRows).toHaveLength(1);
    const gap = gapRows[0]?.payload as {
      streamId: string;
      fromSequence: number;
      toSequence: number;
      droppedEvents: number;
    };
    expect(gap.streamId).toBe('stdout');
    expect(gap.fromSequence).toBe(2);
    expect(gap.toSequence).toBe(3);
    expect(gap.droppedEvents).toBe(2);
    expect(page.hasGap).toBe(true);
    // Dropped sequences never materialize as activity rows.
    expect(page.events.some((e) => e.kind === 'activity' && e.sequence >= 2)).toBe(false);

    // A cursor inside the covered range still reports hasGap.
    const midGap = await pullEvents(f.sourceAuth, job.jobId, gapRows[0]?.cursor ?? 0);
    expect(midGap.hasGap).toBe(true);

    // Freeing budget resumes journaling — including a replayed dropped
    // sequence (gap rows are excluded from the dedupe domain).
    await runInDurableObject(accountStub(f.accountId), (_i: AccountCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE job_event_meta SET activity_bytes = 0 WHERE job_id = ?',
        job.jobId,
      );
    });
    send(workerSocket, activityFrame(job.attemptId, job.fence, 2, 'replay-2\n'));
    send(workerSocket, activityFrame(job.attemptId, job.fence, 4, 'resumed\n'));
    const after = await pollUntil(
      () => pullEvents(f.sourceAuth, job.jobId),
      (p) => p.events.filter((e) => e.kind === 'activity').length >= 3,
    );
    const texts = after.events
      .filter((e) => e.kind === 'activity')
      .map((e) => (e.payload as { text: string }).text);
    expect(texts).toContain('replay-2\n');
    expect(texts).toContain('resumed\n');
    workerSocket.close(1000, 'done');
  });
});

describe('approvals', () => {
  it('parks the job on a control request and resumes on approval, all journaled', async () => {
    const f = fixture('ap-happy');
    const job = await runningJob(f);
    const workerSocket = await openSocket(f.workerAuth);
    const workerFrames = collectFrames(workerSocket);

    const approvalId = await requestApproval(workerSocket, workerFrames, job, {
      actionDigest: 'sha256:danger-op',
    });

    const parked = await getJob(f.sourceAuth, job.jobId);
    expect(parked.job.state).toBe('awaiting-approval');
    expect(parked.job.stateReason).toBe('approval-required');

    const got = expectSuccess<ApprovalGetResult>(
      await postRpc('approval.get', { jobId: job.jobId }, f.sourceAuth),
    );
    expect(got.approvals).toHaveLength(1);
    expect(got.approvals[0]?.id).toBe(approvalId);
    expect(got.approvals[0]?.state).toBe('pending');
    expect(got.approvals[0]?.attemptId).toBe(job.attemptId);
    expect(got.approvals[0]?.generation).toBe(job.fence);
    expect(got.approvals[0]?.actionDigest).toBe('sha256:danger-op');

    const decided = expectSuccess<ApprovalDecideResult>(
      await postRpc('approval.decide', { approvalId, decision: 'approved' }, f.sourceAuth),
    );
    expect(decided.duplicate).toBe(false);
    expect(decided.approval.state).toBe('approved');
    expect(decided.approval.decidedBy).toBe(f.sourceEnrollmentId);
    expect(decided.job.state).toBe('running');

    const events = await pullEvents(f.sourceAuth, job.jobId);
    expect(events.events.map((e) => e.kind)).toEqual([
      'job.created',
      'attempt.created',
      'job.state',
      'job.state',
      'approval.requested',
      'approval.decided',
      'job.state',
    ]);
    expect(events.events[3]?.payload).toMatchObject({ to: 'awaiting-approval' });
    expect(events.events[4]?.payload).toMatchObject({
      approvalId,
      actionDigest: 'sha256:danger-op',
    });
    expect(events.events[5]?.payload).toMatchObject({ approvalId, decision: 'approved' });
    expect(events.events[6]?.payload).toMatchObject({ to: 'running' });
    workerSocket.close(1000, 'done');
  });

  it('fails the attempt and job on denial', async () => {
    const f = fixture('ap-deny');
    const job = await runningJob(f);
    const workerSocket = await openSocket(f.workerAuth);
    const workerFrames = collectFrames(workerSocket);
    const approvalId = await requestApproval(workerSocket, workerFrames, job);

    const decided = expectSuccess<ApprovalDecideResult>(
      await postRpc(
        'approval.decide',
        { approvalId, decision: 'denied', reason: 'policy violation' },
        f.sourceAuth,
      ),
    );
    expect(decided.approval.state).toBe('denied');
    expect(decided.job.state).toBe('failed');
    expect(decided.job.stateReason).toBe('approval-denied');

    const fetched = await getJob(f.sourceAuth, job.jobId);
    expect(fetched.job.state).toBe('failed');
    expect(fetched.attempts[0]?.state).toBe('failed');
    workerSocket.close(1000, 'done');
  });

  it('replays identical decisions idempotently and conflicts on a changed decision', async () => {
    const f = fixture('ap-idem');
    const job = await runningJob(f);
    const workerSocket = await openSocket(f.workerAuth);
    const workerFrames = collectFrames(workerSocket);
    const approvalId = await requestApproval(workerSocket, workerFrames, job);

    const first = expectSuccess<ApprovalDecideResult>(
      await postRpc('approval.decide', { approvalId, decision: 'approved' }, f.sourceAuth),
    );
    expect(first.duplicate).toBe(false);

    const replay = expectSuccess<ApprovalDecideResult>(
      await postRpc('approval.decide', { approvalId, decision: 'approved' }, f.sourceAuth),
    );
    expect(replay.duplicate).toBe(true);
    expect(replay.approval.state).toBe('approved');

    const clash = await postRpc(
      'approval.decide',
      { approvalId, decision: 'denied' },
      f.sourceAuth,
    );
    expect(clash.status).toBe(409);
    if (isRpcError(clash.body)) {
      expect(clash.body.error.details?.['reason']).toBe('approval-already-decided');
    }
    workerSocket.close(1000, 'done');
  });

  it('expires a pending approval past its deadline; decide then conflicts as expired', async () => {
    const f = fixture('ap-expire');
    const job = await runningJob(f);
    const workerSocket = await openSocket(f.workerAuth);
    const workerFrames = collectFrames(workerSocket);
    const approvalId = await requestApproval(workerSocket, workerFrames, job, {
      expiresInMs: 1_000,
    });

    await runInDurableObject(accountStub(f.accountId), (_i: AccountCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE approvals SET expires_at = ? WHERE approval_id = ?',
        Date.now() - 1_000,
        approvalId,
      );
    });

    // decide observes the deadline itself (no lazy read first).
    const denied = await postRpc(
      'approval.decide',
      { approvalId, decision: 'approved' },
      f.sourceAuth,
    );
    expect(denied.status).toBe(409);
    if (isRpcError(denied.body)) {
      expect(denied.body.error.details?.['reason']).toBe('approval-expired');
    }

    const got = expectSuccess<ApprovalGetResult>(
      await postRpc('approval.get', { approvalId }, f.sourceAuth),
    );
    expect(got.approvals[0]?.state).toBe('expired');

    const events = await pullEvents(f.sourceAuth, job.jobId);
    const decidedPayloads = events.events
      .filter((e) => e.kind === 'approval.decided')
      .map((e) => e.payload as { outcome?: string });
    expect(decidedPayloads.some((p) => p.outcome === 'expired')).toBe(true);
    workerSocket.close(1000, 'done');
  });

  it('forbids the executing worker from deciding and honors a pinned approver', async () => {
    const f = fixture('ap-actor');
    const job = await runningJob(f);
    const thirdAuth = spikeBearer(f.accountId, `enr-third-${crypto.randomUUID()}`);
    const workerSocket = await openSocket(f.workerAuth);
    const workerFrames = collectFrames(workerSocket);
    const approvalId = await requestApproval(workerSocket, workerFrames, job, {
      approverEnrollmentId: f.sourceEnrollmentId,
    });

    // The executing worker can never approve its own request.
    const byWorker = await postRpc(
      'approval.decide',
      { approvalId, decision: 'approved' },
      f.workerAuth,
    );
    expect(byWorker.status).toBe(403);
    if (isRpcError(byWorker.body)) {
      expect(byWorker.body.error.details?.['reason']).toBe('worker-cannot-decide');
    }

    // An unpinned enrollment is not the pinned approver.
    const byThird = await postRpc(
      'approval.decide',
      { approvalId, decision: 'approved' },
      thirdAuth,
    );
    expect(byThird.status).toBe(403);
    if (isRpcError(byThird.body)) {
      expect(byThird.body.error.details?.['reason']).toBe('not-permitted-approver');
    }

    const bySource = expectSuccess<ApprovalDecideResult>(
      await postRpc('approval.decide', { approvalId, decision: 'approved' }, f.sourceAuth),
    );
    expect(bySource.approval.state).toBe('approved');
    workerSocket.close(1000, 'done');
  });

  it('rejects malformed control requests and a worker self-pin', async () => {
    const f = fixture('ap-validate');
    const job = await runningJob(f);
    const workerSocket = await openSocket(f.workerAuth);
    const workerFrames = collectFrames(workerSocket);

    send(
      workerSocket,
      controlFrame(job.attemptId, job.fence, {
        request: 'approval',
        actionDigest: 'sha256:x',
        approverEnrollmentId: f.workerEnrollmentId,
      }),
    );
    const selfPin = await waitForFrame(workerFrames, (fr) =>
      fr['type'] === 'error' ? fr : null,
    );
    expect(selfPin['code']).toBe('conflict');
    expect(selfPin['message']).toBe('invalid-approver');

    send(workerSocket, controlFrame(job.attemptId, job.fence, { request: 'approval' }));
    const missingDigest = await waitForFrame(workerFrames, (fr) =>
      fr['type'] === 'error' && fr['id'] !== selfPin['id'] ? fr : null,
    );
    expect(missingDigest['code']).toBe('malformed-request');
    expect(missingDigest['message']).toBe('actionDigest');

    send(workerSocket, controlFrame(job.attemptId, job.fence, { request: 'bogus' }));
    const badRequest = await waitForFrame(
      workerFrames,
      (fr) =>
        fr['type'] === 'error' && fr['id'] !== selfPin['id'] && fr['id'] !== missingDigest['id']
          ? fr
          : null,
    );
    expect(badRequest['code']).toBe('malformed-request');
    expect(badRequest['message']).toBe('control-request');
    workerSocket.close(1000, 'done');
  });

  it('cancels pending approvals when the job is cancelled', async () => {
    const f = fixture('ap-cancel');
    const job = await runningJob(f);
    const workerSocket = await openSocket(f.workerAuth);
    const workerFrames = collectFrames(workerSocket);
    const approvalId = await requestApproval(workerSocket, workerFrames, job);

    const cancelled = expectSuccess<{ job: { state: string } }>(
      await postRpc('job.cancel', { jobId: job.jobId }, f.sourceAuth),
    );
    expect(cancelled.job.state).toBe('cancelled');

    const got = expectSuccess<ApprovalGetResult>(
      await postRpc('approval.get', { approvalId }, f.sourceAuth),
    );
    expect(got.approvals[0]?.state).toBe('cancelled');

    const late = await postRpc(
      'approval.decide',
      { approvalId, decision: 'approved' },
      f.sourceAuth,
    );
    expect(late.status).toBe(409);
    if (isRpcError(late.body)) {
      expect(late.body.error.details?.['reason']).toBe('approval-already-decided');
    }

    const events = await pullEvents(f.sourceAuth, job.jobId);
    const decidedPayloads = events.events
      .filter((e) => e.kind === 'approval.decided')
      .map((e) => e.payload as { outcome?: string });
    expect(decidedPayloads.some((p) => p.outcome === 'cancelled')).toBe(true);
    workerSocket.close(1000, 'done');
  });

  it('cancels rather than decides when the attempt fence moved on', async () => {
    const f = fixture('ap-stale');
    const job = await runningJob(f);
    const workerSocket = await openSocket(f.workerAuth);
    const workerFrames = collectFrames(workerSocket);
    const approvalId = await requestApproval(workerSocket, workerFrames, job);

    // Move the attempt fence past the approval's pinned generation.
    await runInDurableObject(accountStub(f.accountId), (_i: AccountCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE attempts SET fence = fence + 1 WHERE attempt_id = ?',
        job.attemptId,
      );
    });

    const denied = await postRpc(
      'approval.decide',
      { approvalId, decision: 'approved' },
      f.sourceAuth,
    );
    expect(denied.status).toBe(409);
    if (isRpcError(denied.body)) {
      expect(denied.body.error.code).toBe('stale-generation');
    }

    const got = expectSuccess<ApprovalGetResult>(
      await postRpc('approval.get', { approvalId }, f.sourceAuth),
    );
    expect(got.approvals[0]?.state).toBe('cancelled');
    workerSocket.close(1000, 'done');
  });
});

describe('artifacts', () => {
  it('round-trips reserve → upload → finalize → download → list → delete', async () => {
    const f = fixture('art-happy');
    const job = await runningJob(f);
    const bodyText = 'artifact body ✓';
    const body = new TextEncoder().encode(bodyText);
    const sha = await sha256Hex(bodyText);

    const reserved = expectSuccess<ArtifactReserveResult>(
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
    expect(reserved.uploadPath).toBe(`/v1/artifacts/${reserved.artifactId}`);

    const put = await putArtifact(reserved.uploadPath, f.workerAuth, body);
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { state: string; byteLength: number };
    expect(putBody.state).toBe('uploaded');
    expect(putBody.byteLength).toBe(body.byteLength);

    const finalized = expectSuccess<ArtifactFinalizeResult>(
      await postRpc(
        'artifact.finalize',
        { artifactId: reserved.artifactId, byteLength: body.byteLength, sha256: sha },
        f.workerAuth,
      ),
    );
    expect(finalized.manifest.state).toBe('published');
    expect(finalized.manifest.attemptId).toBe(job.attemptId);
    expect(finalized.manifest.byteLength).toBe(body.byteLength);

    const got = expectSuccess<ArtifactGetResult>(
      await postRpc('artifact.get', { artifactId: reserved.artifactId }, f.sourceAuth),
    );
    expect(got.artifact.state).toBe('published');
    expect(got.artifact.jobId).toBe(job.jobId);
    expect(got.artifact.publishedAt).not.toBeNull();
    expect(got.artifact.expiresAt).not.toBeNull();
    expect(got.downloadPath).toBe(`/v1/artifacts/${reserved.artifactId}`);

    const download = await getArtifactBytes(got.downloadPath as string, f.sourceAuth);
    expect(download.status).toBe(200);
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(download.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(body);

    const listed = expectSuccess<ArtifactListResult>(
      await postRpc('artifact.list', { jobId: job.jobId }, f.sourceAuth),
    );
    expect(listed.artifacts.map((a) => a.id)).toEqual([reserved.artifactId]);
    const byAttempt = expectSuccess<ArtifactListResult>(
      await postRpc('artifact.list', { attemptId: job.attemptId, state: 'published' }, f.sourceAuth),
    );
    expect(byAttempt.artifacts).toHaveLength(1);

    // The owning worker may not delete; the user role may.
    const workerDelete = await postRpc(
      'artifact.delete',
      { artifactId: reserved.artifactId },
      f.workerAuth,
    );
    expect(workerDelete.status).toBe(403);
    if (isRpcError(workerDelete.body)) {
      expect(workerDelete.body.error.details?.['reason']).toBe('worker-role-not-permitted');
    }

    const deleted = expectSuccess<ArtifactDeleteResult>(
      await postRpc('artifact.delete', { artifactId: reserved.artifactId }, f.sourceAuth),
    );
    expect(deleted.artifact.state).toBe('deleted');
    const again = expectSuccess<ArtifactDeleteResult>(
      await postRpc('artifact.delete', { artifactId: reserved.artifactId }, f.sourceAuth),
    );
    expect(again.artifact.state).toBe('deleted');

    const gone = await getArtifactBytes(`/v1/artifacts/${reserved.artifactId}`, f.sourceAuth);
    expect(gone.status).toBe(404);
    expect(await env.ARTIFACTS.head(`${f.accountId}/${reserved.artifactId}`)).toBeNull();

    const events = await pullEvents(f.sourceAuth, job.jobId);
    const kinds = events.events.map((e) => e.kind);
    expect(kinds).toContain('artifact.reserved');
    expect(kinds).toContain('artifact.published');
    expect(kinds).toContain('artifact.deleted');
  });

  it('enforces reservation validation, actor rules, and quotas', async () => {
    const f = fixture('art-guard');
    const job = await runningJob(f);
    const sha = 'b'.repeat(64);
    const base = {
      attemptId: job.attemptId,
      byteLength: 16,
      sha256: sha,
      mediaType: 'application/octet-stream',
    };

    // Per-artifact byte ceiling.
    const tooBig = await postRpc(
      'artifact.reserve',
      { ...base, byteLength: ARTIFACT_MAX_BYTES + 1 },
      f.workerAuth,
    );
    expect(tooBig.status).toBe(413);
    if (isRpcError(tooBig.body)) {
      expect(tooBig.body.error.code).toBe('payload-too-large');
    }

    // A non-worker enrollment cannot reserve.
    const bySource = await postRpc('artifact.reserve', base, f.sourceAuth);
    expect(bySource.status).toBe(403);

    // A different worker cannot reserve on this attempt.
    const otherAuth = spikeBearer(f.accountId, `enr-other-${crypto.randomUUID()}`);
    await publishPolicy(otherAuth);
    await connectWorker(otherAuth);
    const byOther = await postRpc('artifact.reserve', base, otherAuth);
    expect(byOther.status).toBe(403);
    if (isRpcError(byOther.body)) {
      expect(byOther.body.error.details?.['reason']).toBe('not-attempt-owner');
    }

    // Malformed digests and retention windows reject up front.
    for (const params of [
      { ...base, sha256: 'zz' },
      { ...base, byteLength: 0 },
      { ...base, retentionDays: 0 },
      { ...base, retentionDays: 31 },
      { ...base, attemptId: 'missing-attempt' },
    ]) {
      const denied = await postRpc('artifact.reserve', params, f.workerAuth);
      expect([400, 404]).toContain(denied.status);
    }

    // Account byte quota: a seeded near-cap artifact leaves no headroom.
    await runInDurableObject(accountStub(f.accountId), (_i: AccountCoordinator, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO artifacts (
           artifact_id, account_id, job_id, attempt_id, byte_length, sha256,
           media_type, retention_days, state, r2_key, upload_expires_at,
           created_at, updated_at, published_at, expires_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'application/octet-stream', 7, 'published', ?, ?, ?, ?, ?, ?, NULL)`,
        crypto.randomUUID(),
        f.accountId,
        job.jobId,
        job.attemptId,
        ACCOUNT_ARTIFACT_MAX_BYTES - 10,
        'c'.repeat(64),
        `${f.accountId}/seeded`,
        now + 60_000,
        now,
        now,
        now,
        now + 7 * 24 * 60 * 60 * 1000,
      );
    });
    const overQuota = await postRpc(
      'artifact.reserve',
      { ...base, byteLength: 100 },
      f.workerAuth,
    );
    expect(overQuota.status).toBe(413);
    if (isRpcError(overQuota.body)) {
      expect(overQuota.body.error.code).toBe('quota-exceeded');
    }
  });

  it('verifies uploaded bytes on finalize; mismatches discard the object', async () => {
    const f = fixture('art-verify');
    const job = await runningJob(f);
    const goodText = 'good-bytes';
    const badText = 'bad!-bytes'; // same length, different digest
    const goodSha = await sha256Hex(goodText);

    // Finalize without an upload conflicts.
    const first = expectSuccess<ArtifactReserveResult>(
      await postRpc(
        'artifact.reserve',
        {
          attemptId: job.attemptId,
          byteLength: goodText.length,
          sha256: goodSha,
          mediaType: 'application/octet-stream',
        },
        f.workerAuth,
      ),
    );
    const early = await postRpc(
      'artifact.finalize',
      { artifactId: first.artifactId, byteLength: goodText.length, sha256: goodSha },
      f.workerAuth,
    );
    expect(early.status).toBe(409);
    if (isRpcError(early.body)) {
      expect(early.body.error.details?.['reason']).toBe('artifact-not-uploaded');
    }

    // A size-mismatched body rejects and stores nothing.
    const short = new TextEncoder().encode('tiny');
    const shortPut = await putArtifact(first.uploadPath, f.workerAuth, short);
    expect(shortPut.status).toBe(409);
    expect(await env.ARTIFACTS.head(`${f.accountId}/${first.artifactId}`)).toBeNull();

    // Same-length but wrong bytes fail verification on finalize.
    const put = await putArtifact(first.uploadPath, f.workerAuth, new TextEncoder().encode(badText));
    expect(put.status).toBe(200);
    const mismatch = await postRpc(
      'artifact.finalize',
      { artifactId: first.artifactId, byteLength: goodText.length, sha256: goodSha },
      f.workerAuth,
    );
    expect(mismatch.status).toBe(409);
    if (isRpcError(mismatch.body)) {
      expect(mismatch.body.error.details?.['reason']).toBe('checksum-mismatch');
    }
    expect(await env.ARTIFACTS.head(`${f.accountId}/${first.artifactId}`)).toBeNull();
    const row = expectSuccess<ArtifactGetResult>(
      await postRpc('artifact.get', { artifactId: first.artifactId }, f.sourceAuth),
    );
    expect(row.artifact.state).toBe('deleted');
  });

  it('sweeps orphaned reservations into deleted rows with a journaled event', async () => {
    const f = fixture('art-sweep');
    const job = await runningJob(f);
    const reserved = expectSuccess<ArtifactReserveResult>(
      await postRpc(
        'artifact.reserve',
        {
          attemptId: job.attemptId,
          byteLength: 8,
          sha256: 'd'.repeat(64),
          mediaType: 'application/octet-stream',
        },
        f.workerAuth,
      ),
    );

    // Age the reservation past its upload window.
    await runInDurableObject(accountStub(f.accountId), (_i: AccountCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE artifacts SET upload_expires_at = ? WHERE artifact_id = ?',
        Date.now() - 1_000,
        reserved.artifactId,
      );
    });

    const sweep = await accountStub(f.accountId).fetch(
      new Request('https://internal.anvil/internal/sweep', { method: 'POST' }),
    );
    const stats = (await sweep.json()) as { reconciledArtifacts: number };
    expect(stats.reconciledArtifacts).toBeGreaterThanOrEqual(1);

    const row = expectSuccess<ArtifactGetResult>(
      await postRpc('artifact.get', { artifactId: reserved.artifactId }, f.sourceAuth),
    );
    expect(row.artifact.state).toBe('deleted');
    expect(row.downloadPath).toBeNull();

    const events = await pullEvents(f.sourceAuth, job.jobId);
    const deletedPayloads = events.events
      .filter((e) => e.kind === 'artifact.deleted')
      .map((e) => e.payload as { reason?: string });
    expect(deletedPayloads.some((p) => p.reason === 'sweep-reconciled')).toBe(true);
  });

  it('authenticates byte routes and isolates them per account', async () => {
    const f = fixture('art-iso');
    const job = await runningJob(f);
    const body = new TextEncoder().encode('iso-bytes');
    const reserved = expectSuccess<ArtifactReserveResult>(
      await postRpc(
        'artifact.reserve',
        {
          attemptId: job.attemptId,
          byteLength: body.byteLength,
          sha256: await sha256Hex('iso-bytes'),
          mediaType: 'application/octet-stream',
        },
        f.workerAuth,
      ),
    );

    // No credentials → 401.
    expect((await getArtifactBytes(reserved.uploadPath, null)).status).toBe(401);

    // Another account's credentials route to their own object → not found.
    const other = fixture('art-iso-other');
    const crossPut = await putArtifact(reserved.uploadPath, other.sourceAuth, body);
    expect(crossPut.status).toBe(404);
    const crossGet = await getArtifactBytes(reserved.uploadPath, other.sourceAuth);
    expect(crossGet.status).toBe(404);
    const crossMeta = await postRpc(
      'artifact.get',
      { artifactId: reserved.artifactId },
      other.sourceAuth,
    );
    expect(crossMeta.status).toBe(404);

    // The source device is not a worker: PUT is forbidden.
    const sourcePut = await putArtifact(reserved.uploadPath, f.sourceAuth, body);
    expect(sourcePut.status).toBe(403);

    // Reserved-but-unpublished objects never download.
    const earlyGet = await getArtifactBytes(reserved.uploadPath, f.sourceAuth);
    expect(earlyGet.status).toBe(404);
  });
});

describe('socket observation', () => {
  it('replays journaled rows on subscribe and streams live activity to subscribers', async () => {
    const f = fixture('obs-live');
    const job = await runningJob(f);
    const observer = await openSocket(f.sourceAuth);
    const frames = collectFrames(observer);

    send(observer, subscribeFrame('sub-1', job.jobId));
    // Replay arrives immediately: lifecycle rows surface as status frames.
    const replayed = await waitForFrame(frames, (fr) => {
      if (fr['type'] === 'activity' && fr['streamId'] === 'lifecycle') {
        const payload = fr['payload'] as { kind: string; text: string };
        const doc = JSON.parse(payload.text) as { type?: string };
        if (doc.type === 'job.created') {
          return fr;
        }
      }
      return null;
    });
    // Job-scope lifecycle rows replay with an empty attemptId.
    expect(replayed['attemptId']).toBe('');

    const workerSocket = await openSocket(f.workerAuth);
    send(workerSocket, activityFrame(job.attemptId, job.fence, 1, 'hello-observer\n'));

    const live = await waitForFrame(frames, (fr) => {
      if (fr['type'] === 'activity' && fr['streamId'] === 'stdout') {
        const payload = fr['payload'] as { kind: string; text: string };
        if (payload.text.includes('hello-observer')) {
          return fr;
        }
      }
      return null;
    });
    expect(live['attemptId']).toBe(job.attemptId);
    expect(live['generation']).toBe(job.fence);
    expect(live['sequence']).toBe(1);

    observer.close(1000, 'done');
    workerSocket.close(1000, 'done');
  });

  it('keeps non-subscribed sockets silent and stops delivery after unsubscribe', async () => {
    const f = fixture('obs-off');
    const job = await runningJob(f);
    const observer = await openSocket(f.sourceAuth);
    const frames = collectFrames(observer);
    const workerSocket = await openSocket(f.workerAuth);

    // No subscription → nothing delivered.
    send(workerSocket, activityFrame(job.attemptId, job.fence, 1, 'silent\n'));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(frames.filter((fr) => fr['type'] === 'activity')).toHaveLength(0);

    send(observer, subscribeFrame('sub-1', job.attemptId));
    // Wait for replay to prove the subscription registered.
    await waitForFrame(frames, (fr) => fr['type'] === 'activity' ? fr : null);
    send(workerSocket, activityFrame(job.attemptId, job.fence, 2, 'heard-1\n'));
    await waitForFrame(frames, (fr) => {
      const payload = fr['payload'] as { text?: string } | undefined;
      return fr['type'] === 'activity' && payload?.text?.includes('heard-1') === true ? fr : null;
    });

    send(observer, {
      type: 'unsubscribe',
      version: 1,
      id: 'u-1',
      subscriptionId: 'sub-1',
    });
    // Deterministic: wait until the attachment's subscriptions are gone.
    await pollUntil(
      () =>
        runInDurableObject(accountStub(f.accountId), (_i: AccountCoordinator, state) =>
          state
            .getWebSockets()
            .map((s) => s.deserializeAttachment() as { subscriptions?: unknown[] } | null)
            .filter((a): a is { subscriptions: unknown[] } =>
              a !== null && Array.isArray(a.subscriptions),
            )
            .reduce((n, a) => n + a.subscriptions.length, 0),
        ),
      (n) => n === 0,
    );

    send(workerSocket, activityFrame(job.attemptId, job.fence, 3, 'after-unsub\n'));
    await new Promise((resolve) => setTimeout(resolve, 800));
    const heard = frames.filter((fr) => {
      const payload = fr['payload'] as { text?: string } | undefined;
      return fr['type'] === 'activity' && payload?.text?.includes('after-unsub') === true;
    });
    expect(heard).toHaveLength(0);

    observer.close(1000, 'done');
    workerSocket.close(1000, 'done');
  });

  it('delivers a live gap frame when activity is budget-dropped', async () => {
    const f = fixture('obs-gap');
    const job = await runningJob(f);
    const observer = await openSocket(f.sourceAuth);
    const frames = collectFrames(observer);
    const workerSocket = await openSocket(f.workerAuth);

    send(observer, subscribeFrame('sub-1', job.attemptId));
    await waitForFrame(frames, (fr) => fr['type'] === 'activity' ? fr : null);

    await runInDurableObject(accountStub(f.accountId), (_i: AccountCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE job_event_meta SET activity_bytes = ? WHERE job_id = ?',
        JOB_EVENT_BUDGET_BYTES,
        job.jobId,
      );
    });
    send(workerSocket, activityFrame(job.attemptId, job.fence, 7, 'lost\n'));

    const gap = await waitForFrame(frames, (fr) => (fr['type'] === 'gap' ? fr : null));
    expect(gap['attemptId']).toBe(job.attemptId);
    expect(gap['streamId']).toBe('stdout');
    expect(gap['fromSequence']).toBe(7);
    expect(gap['toSequence']).toBe(7);

    observer.close(1000, 'done');
    workerSocket.close(1000, 'done');
  });

  it('replays a gap then the live tail when the cursor sits inside a dropped range', async () => {
    const f = fixture('obs-resume');
    const job = await runningJob(f);
    const workerSocket = await openSocket(f.workerAuth);

    // Two dropped frames → one gap row covering two cursors.
    await runInDurableObject(accountStub(f.accountId), (_i: AccountCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE job_event_meta SET activity_bytes = ? WHERE job_id = ?',
        JOB_EVENT_BUDGET_BYTES,
        job.jobId,
      );
    });
    send(workerSocket, activityFrame(job.attemptId, job.fence, 2, 'drop-1\n'));
    send(workerSocket, activityFrame(job.attemptId, job.fence, 3, 'drop-2\n'));
    await pollUntil(
      () => pullEvents(f.sourceAuth, job.jobId),
      (p) => p.events.some((e) => e.kind === 'gap'),
    );
    const withGap = await pullEvents(f.sourceAuth, job.jobId);
    const gapRow = withGap.events.find((e) => e.kind === 'gap');
    expect(gapRow).toBeDefined();

    // Resume journaling and land a frame after the covered range.
    await runInDurableObject(accountStub(f.accountId), (_i: AccountCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE job_event_meta SET activity_bytes = 0 WHERE job_id = ?',
        job.jobId,
      );
    });
    send(workerSocket, activityFrame(job.attemptId, job.fence, 4, 'tail\n'));
    await pollUntil(
      () => pullEvents(f.sourceAuth, job.jobId),
      (p) => p.events.some((e) => e.kind === 'activity' && e.sequence === 4),
    );

    // Subscribe with the cursor inside the gap's covered range.
    const observer = await openSocket(f.sourceAuth);
    const frames = collectFrames(observer);
    send(observer, subscribeFrame('sub-1', job.attemptId, gapRow?.cursor ?? 0));

    const gapFrame = await waitForFrame(frames, (fr) => (fr['type'] === 'gap' ? fr : null));
    expect(gapFrame['fromSequence']).toBe(2);
    const tail = await waitForFrame(frames, (fr) => {
      const payload = fr['payload'] as { text?: string } | undefined;
      return fr['type'] === 'activity' && payload?.text?.includes('tail') === true ? fr : null;
    });
    // The gap frame precedes the live tail in the replay order.
    expect(frames.indexOf(gapFrame)).toBeLessThan(frames.indexOf(tail));

    observer.close(1000, 'done');
    workerSocket.close(1000, 'done');
  });

  it('answers forbidden, stale-generation, and terminal frames with typed errors', async () => {
    const f = fixture('obs-errors');
    const job = await runningJob(f);
    const workerSocket = await openSocket(f.workerAuth);
    const workerFrames = collectFrames(workerSocket);
    const sourceSocket = await openSocket(f.sourceAuth);
    const sourceFrames = collectFrames(sourceSocket);

    // A non-owning enrollment cannot emit activity for the attempt.
    send(sourceSocket, activityFrame(job.attemptId, job.fence, 1, 'x'));
    const notOwner = await waitForFrame(sourceFrames, (fr) =>
      fr['type'] === 'error' ? fr : null,
    );
    expect(notOwner['code']).toBe('forbidden');
    expect(notOwner['message']).toBe('not-attempt-owner');

    // A stale generation on the owning worker is fenced out.
    send(workerSocket, activityFrame(job.attemptId, job.fence + 5, 1, 'x'));
    const stale = await waitForFrame(workerFrames, (fr) => (fr['type'] === 'error' ? fr : null));
    expect(stale['code']).toBe('stale-generation');

    // Unknown attempts are not-found.
    send(workerSocket, activityFrame('attempt-missing', job.fence, 1, 'x'));
    const missing = await waitForFrame(
      workerFrames,
      (fr) => (fr['type'] === 'error' && fr['id'] !== stale['id'] ? fr : null),
    );
    expect(missing['code']).toBe('not-found');

    // Terminal attempts reject further activity.
    expectSuccess(
      await postRpc(
        'attempt.report',
        {
          attemptId: job.attemptId,
          incarnation: job.workerIncarnation,
          fence: job.fence,
          outcome: 'completed',
        },
        f.workerAuth,
      ),
    );
    send(workerSocket, activityFrame(job.attemptId, job.fence, 5, 'late\n'));
    const terminal = await waitForFrame(
      workerFrames,
      (fr) =>
        fr['type'] === 'error' && fr['id'] !== stale['id'] && fr['id'] !== missing['id']
          ? fr
          : null,
    );
    expect(terminal['code']).toBe('conflict');
    expect(terminal['message']).toBe('attempt-terminal');

    workerSocket.close(1000, 'done');
    sourceSocket.close(1000, 'done');
  });

  it('refuses foreign-account and unknown subscription scopes', async () => {
    const f = fixture('obs-iso');
    const job = await runningJob(f);
    const other = fixture('obs-iso-other');

    const alien = await openSocket(other.sourceAuth);
    const alienFrames = collectFrames(alien);
    send(alien, subscribeFrame('s-1', job.jobId));
    const crossAccount = await waitForFrame(alienFrames, (fr) =>
      fr['type'] === 'error' ? fr : null,
    );
    expect(crossAccount['code']).toBe('not-found');

    const observer = await openSocket(f.sourceAuth);
    const frames = collectFrames(observer);
    send(observer, subscribeFrame('s-2', 'no-such-scope'));
    const missing = await waitForFrame(frames, (fr) => (fr['type'] === 'error' ? fr : null));
    expect(missing['code']).toBe('not-found');

    alien.close(1000, 'done');
    observer.close(1000, 'done');
  });

  it('throttles inbound frame bursts with a typed retryable error', async () => {
    const f = fixture('obs-rate');
    await runningJob(f);
    const socket = await openSocket(f.sourceAuth);
    const frames = collectFrames(socket);

    for (let i = 0; i < 70; i++) {
      send(socket, { type: 'unsubscribe', version: 1, id: `u-${i}`, subscriptionId: 'none' });
    }
    const throttled = await waitForFrame(frames, (fr) =>
      fr['type'] === 'error' && fr['code'] === 'throttled' ? fr : null,
    );
    expect(throttled['retryable']).toBe(true);
    socket.close(1000, 'done');
  });
});
