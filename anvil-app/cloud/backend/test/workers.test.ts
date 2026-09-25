import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { DeviceSession, EnrollmentCodeIssueResult } from '../../contract/auth';
import { isRpcError } from '../../contract/envelope';
import { WORKER_LEASE_MS } from '../../contract/version';
import type {
  DevicePolicy,
  DevicePolicyPublishResult,
  WorkerConnectResult,
  WorkerDescribeResult,
} from '../../contract/workers';
import type { AccountCoordinator } from '../src/account-coordinator';
import { expectSuccess, nextFrameOfType, postRpc, spikeBearer, uniqueIds } from './helpers';

const ADMIN_TOKEN = 'test-admin-credential';
const WORKER_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function accountStub(accountId: string) {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId));
}

function allowJobsPolicy(): DevicePolicy {
  return {
    worker: {
      allowJobs: true,
      allowedSources: ['same-account'],
      maxConcurrentJobs: 2,
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

async function revokeEnrollmentInternal(accountId: string, enrollmentId: string) {
  const response = await accountStub(accountId).fetch(
    new Request('https://internal.anvil/internal/revoke-enrollment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollmentId }),
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { closed: number; workerRevoked: boolean };
}

function workerRow(accountId: string, enrollmentId: string) {
  return runInDurableObject(accountStub(accountId), (_i: AccountCoordinator, state) => {
    return (
      state.storage.sql
        .exec<{
          incarnation: string | null;
          revoked_at: number | null;
          last_seen_at: number | null;
        }>(
          'SELECT incarnation, revoked_at, last_seen_at FROM workers WHERE enrollment_id = ?',
          enrollmentId,
        )
        .toArray()[0] ?? null
    );
  });
}

async function issueCode(accountId: string): Promise<EnrollmentCodeIssueResult> {
  const response = await SELF.fetch('https://spike.test/v1/enrollment-codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ accountId }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as EnrollmentCodeIssueResult;
}

async function enroll(code: string): Promise<DeviceSession> {
  const response = await SELF.fetch('https://spike.test/v1/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proof: { method: 'enrollment-code', code },
      installationId: 'install-worker-test',
      displayName: 'Worker device',
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as DeviceSession;
}

describe('worker policy gate', () => {
  it('issues a bootstrap code through the supported admin HTTP route', async () => {
    env.ENROLLMENT_ADMIN_TOKEN = ADMIN_TOKEN;
    const response = await SELF.fetch('https://spike.test/v1/enrollment-codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ accountId: uniqueIds('page-bootstrap').accountId }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      code: expect.any(String),
      accountId: expect.stringContaining('page-bootstrap'),
      expiresAt: expect.any(String),
    }));
  });

  it('fails closed until the enrollment publishes an allowing policy', async () => {
    const ids = uniqueIds('gate');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);

    // No worker record at all: sync enrollment alone never authorizes mesh.
    for (const op of [
      'worker.connect',
      'worker.describe',
      'worker.capabilities.publish',
      'worker.replica.publish',
    ]) {
      const denied = await postRpc(op, {}, auth);
      expect(denied.status).toBe(403);
      if (isRpcError(denied.body)) {
        expect(denied.body.error.code).toBe('forbidden');
        expect(denied.body.error.details?.['reason']).toBe('worker-policy-required');
      }
    }

    // An explicit opt-out policy still fails closed.
    await publishPolicy(auth, { worker: { allowJobs: false } });
    const optedOut = await postRpc('worker.connect', {}, auth);
    expect(optedOut.status).toBe(403);
    if (isRpcError(optedOut.body)) {
      expect(optedOut.body.error.details?.['reason']).toBe('jobs-not-allowed');
    }

    // The local opt-in opens the gate.
    const published = await publishPolicy(auth);
    expect(published.published).toBe(true);

    // describe works before first connect: no incarnation, not available.
    const described = expectSuccess<WorkerDescribeResult>(
      await postRpc('worker.describe', {}, auth),
    );
    expect(described.enrollmentId).toBe(ids.enrollmentId);
    expect(described.workerIncarnation).toBeNull();
    expect(described.available).toBe(false);
    expect(described.policy.worker.allowJobs).toBe(true);
    expect(described.policy.worker.allowedSources).toEqual(['same-account']);
    expect(described.capabilities).toBeNull();
    expect(described.replicas).toEqual([]);

    // Capability publishes require a live incarnation, not just a policy.
    const early = await postRpc(
      'worker.capabilities.publish',
      { os: 'macos', arch: 'arm64', capabilities: ['git'] },
      auth,
    );
    expect(early.status).toBe(403);
    if (isRpcError(early.body)) {
      expect(early.body.error.details?.['reason']).toBe('worker-not-connected');
    }

    const connected = await connectWorker(auth);
    expect(connected.workerIncarnation).toMatch(UUID_PATTERN);
    expect(Date.parse(connected.leaseExpiresAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(connected.leaseExpiresAt)).toBeLessThanOrEqual(Date.now() + WORKER_LEASE_MS);
  });

  it('rejects malformed policy and replica payloads', async () => {
    const ids = uniqueIds('malformed');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);

    const missingWorker = await postRpc('device.policy.publish', {}, auth);
    expect(missingWorker.status).toBe(400);

    const badAllowJobs = await postRpc(
      'device.policy.publish',
      { worker: { allowJobs: 'yes' } },
      auth,
    );
    expect(badAllowJobs.status).toBe(400);

    await publishPolicy(auth);
    await connectWorker(auth);

    const badReadiness = await postRpc(
      'worker.replica.publish',
      {
        replicas: [
          {
            workspaceId: 'ws-1',
            definitionRevision: 'rev-1',
            readiness: 'half-baked',
            observedAt: new Date().toISOString(),
          },
        ],
      },
      auth,
    );
    expect(badReadiness.status).toBe(400);
    if (isRpcError(badReadiness.body)) {
      expect(badReadiness.body.error.code).toBe('malformed-request');
    }

    const badCaps = await postRpc(
      'worker.capabilities.publish',
      { os: 'macos', capabilities: 'not-an-array' },
      auth,
    );
    expect(badCaps.status).toBe(400);
  });
});

describe('worker incarnation lifecycle', () => {
  it('reuses the live incarnation on heartbeat connect and re-incarnates after staleness', async () => {
    const ids = uniqueIds('incarnation');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    await publishPolicy(auth);

    const first = await connectWorker(auth);
    const second = await connectWorker(auth);
    expect(second.workerIncarnation).toBe(first.workerIncarnation);
    expect(Date.parse(second.leaseExpiresAt)).toBeGreaterThanOrEqual(
      Date.parse(first.leaseExpiresAt),
    );

    // Let the lease lapse: the worker record keeps the incarnation but is
    // stale, so describe reports unavailable and reconnect mints a new one.
    const staleAt = Date.now() - WORKER_LEASE_MS - 1000;
    await runInDurableObject(accountStub(ids.accountId), (_i: AccountCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE workers SET last_seen_at = ?, lease_expires_at = ? WHERE enrollment_id = ?',
        staleAt,
        staleAt,
        ids.enrollmentId,
      );
    });
    const described = expectSuccess<WorkerDescribeResult>(
      await postRpc('worker.describe', {}, auth),
    );
    expect(described.workerIncarnation).toBe(first.workerIncarnation);
    expect(described.available).toBe(false);
    expect(Date.parse(described.lastSeenAt as string)).toBeLessThan(Date.now() - WORKER_LEASE_MS);

    const third = await connectWorker(auth);
    expect(third.workerIncarnation).not.toBe(first.workerIncarnation);
  });

  it('rejects worker ops while revoked and mints a fresh incarnation after re-opt-in', async () => {
    const ids = uniqueIds('revoke');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    await publishPolicy(auth);
    const first = await connectWorker(auth);

    const revoked = await revokeEnrollmentInternal(ids.accountId, ids.enrollmentId);
    expect(revoked.workerRevoked).toBe(true);

    const denied = await postRpc('worker.describe', {}, auth);
    expect(denied.status).toBe(403);
    if (isRpcError(denied.body)) {
      expect(denied.body.error.details?.['reason']).toBe('worker-revoked');
    }
    const deniedConnect = await postRpc('worker.connect', {}, auth);
    expect(deniedConnect.status).toBe(403);

    // A fresh local opt-in re-arms the enrollment: the revoked incarnation is
    // dropped and the next connect mints a new one.
    await publishPolicy(auth);
    const reconnected = await connectWorker(auth);
    expect(reconnected.workerIncarnation).not.toBe(first.workerIncarnation);
    const described = expectSuccess<WorkerDescribeResult>(
      await postRpc('worker.describe', {}, auth),
    );
    expect(described.available).toBe(true);
  });

  it('round-trips capabilities and replica summaries through worker.describe', async () => {
    const ids = uniqueIds('roundtrip');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    await publishPolicy(auth);
    const connected = await connectWorker(auth);

    const capabilities = {
      os: 'macos',
      arch: 'arm64',
      memoryMb: 32768,
      capabilities: ['git', 'node22', 'docker'],
      maxConcurrentJobs: 3,
    };
    expectSuccess(await postRpc('worker.capabilities.publish', capabilities, auth));

    const observedAt = new Date().toISOString();
    expectSuccess(
      await postRpc(
        'worker.replica.publish',
        {
          replicas: [
            {
              workspaceId: 'ws-alpha',
              definitionRevision: 'rev-7',
              readiness: 'ready',
              observedAt,
            },
            {
              workspaceId: 'ws-beta',
              definitionRevision: 'rev-2',
              readiness: 'cloning',
              observedAt,
            },
          ],
        },
        auth,
      ),
    );

    const described = expectSuccess<WorkerDescribeResult>(
      await postRpc('worker.describe', {}, auth),
    );
    expect(described.workerIncarnation).toBe(connected.workerIncarnation);
    expect(described.available).toBe(true);
    expect(described.capabilities).toEqual(capabilities);
    expect(described.replicas).toEqual([
      {
        workspaceId: 'ws-alpha',
        definitionRevision: 'rev-7',
        readiness: 'ready',
        observedAt,
      },
      {
        workspaceId: 'ws-beta',
        definitionRevision: 'rev-2',
        readiness: 'cloning',
        observedAt,
      },
    ]);
    expect(described.connectedAt).not.toBeNull();
    expect(described.lastSeenAt).not.toBeNull();

    // Upsert semantics: a second publish updates one replica, keeps the other.
    const later = new Date(Date.now() + 1000).toISOString();
    expectSuccess(
      await postRpc(
        'worker.replica.publish',
        {
          replicas: [
            {
              workspaceId: 'ws-beta',
              definitionRevision: 'rev-3',
              readiness: 'error',
              observedAt: later,
            },
          ],
        },
        auth,
      ),
    );
    const updated = expectSuccess<WorkerDescribeResult>(await postRpc('worker.describe', {}, auth));
    expect(updated.replicas).toEqual([
      {
        workspaceId: 'ws-alpha',
        definitionRevision: 'rev-7',
        readiness: 'ready',
        observedAt,
      },
      {
        workspaceId: 'ws-beta',
        definitionRevision: 'rev-3',
        readiness: 'error',
        observedAt: later,
      },
    ]);

    // Ops counters reflect the worker activity.
    const counters = await runInDurableObject(
      accountStub(ids.accountId),
      (_i: AccountCoordinator, state) => {
        const rows = state.storage.sql
          .exec<{ key: string; value: number }>('SELECT key, value FROM counters')
          .toArray();
        return Object.fromEntries(rows.map((row) => [row.key, row.value]));
      },
    );
    expect(counters['worker_connects']).toBe(1);
    expect(counters['capability_publishes']).toBe(1);
    expect(counters['replica_publishes']).toBe(2);
    expect(counters['policy_publishes']).toBe(1);
  });
});

describe('worker mailbox', () => {
  it('delivers worker.available to the account’s other sockets, not the connector’s', async () => {
    const ids = uniqueIds('mailbox');
    const workerAuth = spikeBearer(ids.accountId, ids.enrollmentId);
    const observerAuth = spikeBearer(ids.accountId, `enr-observer-${crypto.randomUUID()}`);

    const workerSocket = await openSocket(workerAuth);
    const observerSocket = await openSocket(observerAuth);

    // The session `hello` opens every socket — skip it when waiting on a
    // specific frame, and exclude it from the silence assertion.
    const observerFrame = nextFrameOfType(observerSocket, 'worker.available');
    let workerHeard: string | null = null;
    workerSocket.addEventListener('message', (event) => {
      const text = String(event.data);
      try {
        if ((JSON.parse(text) as { type?: string }).type === 'hello') return;
      } catch {
        // Non-JSON noise still counts as "heard".
      }
      workerHeard ??= text;
    });

    await publishPolicy(workerAuth);
    const connected = await connectWorker(workerAuth);

    const frame = (await observerFrame) as {
      type: string;
      version: number;
      id: string;
      enrollmentId: string;
      incarnation: string;
    };
    expect(frame.type).toBe('worker.available');
    expect(frame.version).toBe(1);
    expect(frame.enrollmentId).toBe(ids.enrollmentId);
    expect(frame.incarnation).toBe(connected.workerIncarnation);

    // The connector's own socket hears nothing.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(workerHeard).toBeNull();

    workerSocket.close(1000, 'done');
    observerSocket.close(1000, 'done');
  });
});

describe('worker revocation and retention', () => {
  it('session revocation marks the worker record revoked through the account object', async () => {
    env.ENROLLMENT_ADMIN_TOKEN = ADMIN_TOKEN;
    const accountId = `acct-${crypto.randomUUID()}`;
    const session = await enroll((await issueCode(accountId)).code);
    const auth = `Bearer ${session.accessToken}`;

    await publishPolicy(auth);
    await connectWorker(auth);

    const revoke = await SELF.fetch('https://spike.test/v1/session/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enrollmentId: session.enrollmentId,
        refreshToken: session.refreshToken,
      }),
    });
    expect(revoke.status).toBe(200);

    const row = await workerRow(accountId, session.enrollmentId);
    expect(row).not.toBeNull();
    expect(row?.revoked_at).not.toBeNull();

    // The dead bearer cannot reach worker ops at all (401), and the revoked
    // marker is durable inside the account object.
    const after = await postRpc('worker.describe', {}, auth);
    expect(after.status).toBe(401);
  });

  it('sweep deletes revoked worker rows and their replicas past the audit window', async () => {
    const ids = uniqueIds('sweep');
    const auth = spikeBearer(ids.accountId, ids.enrollmentId);
    await publishPolicy(auth);
    await connectWorker(auth);
    expectSuccess(
      await postRpc(
        'worker.replica.publish',
        {
          replicas: [
            {
              workspaceId: 'ws-swept',
              definitionRevision: 'rev-1',
              readiness: 'ready',
              observedAt: new Date().toISOString(),
            },
          ],
        },
        auth,
      ),
    );

    await revokeEnrollmentInternal(ids.accountId, ids.enrollmentId);

    // Recently revoked rows are audit state and must survive the sweep.
    const kept = await accountStub(ids.accountId).fetch(
      new Request('https://internal.anvil/internal/sweep', { method: 'POST' }),
    );
    const keptStats = (await kept.json()) as { deletedWorkers: number };
    expect(keptStats.deletedWorkers).toBe(0);
    expect(await workerRow(ids.accountId, ids.enrollmentId)).not.toBeNull();

    // Age the revocation past the 30-day audit window and sweep again.
    const aged = Date.now() - WORKER_AUDIT_RETENTION_MS - 1000;
    await runInDurableObject(accountStub(ids.accountId), (_i: AccountCoordinator, state) => {
      state.storage.sql.exec(
        'UPDATE workers SET revoked_at = ? WHERE enrollment_id = ?',
        aged,
        ids.enrollmentId,
      );
    });
    const swept = await accountStub(ids.accountId).fetch(
      new Request('https://internal.anvil/internal/sweep', { method: 'POST' }),
    );
    const stats = (await swept.json()) as { deletedWorkers: number };
    expect(stats.deletedWorkers).toBe(1);

    const remaining = await runInDurableObject(
      accountStub(ids.accountId),
      (_i: AccountCoordinator, state) => ({
        workers: state.storage.sql
          .exec<{
            n: number;
          }>('SELECT COUNT(*) AS n FROM workers WHERE enrollment_id = ?', ids.enrollmentId)
          .one().n,
        replicas: state.storage.sql
          .exec<{
            n: number;
          }>('SELECT COUNT(*) AS n FROM worker_replicas WHERE enrollment_id = ?', ids.enrollmentId)
          .one().n,
      }),
    );
    expect(remaining).toEqual({ workers: 0, replicas: 0 });
  });
});
