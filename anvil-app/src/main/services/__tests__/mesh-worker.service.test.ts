import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import type { ExecutionAttempt, MeshJob } from '../../../../cloud/contract/jobs';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);

vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
}));

interface RpcCall {
  operation: string;
  params: unknown;
}

const rpcCalls: RpcCall[] = [];
let rpcHandler: (operation: string, params: unknown) => unknown = () => ({});

vi.mock('../sync-backend-client.service.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../sync-backend-client.service.js')>();
  return {
    ...original,
    rpc: async (
      _connection: unknown,
      operation: string,
      params: unknown,
    ): Promise<{ result: unknown; serverTime: string }> => {
      rpcCalls.push({ operation, params });
      return { result: rpcHandler(operation, params), serverTime: '' };
    },
  };
});

import {
  configureMeshWorkerContext,
  getMeshWorkerStatus,
  handleJobAvailable,
  isMeshWorkerEnabled,
  meshWorkerHeartbeatForTests,
  meshWorkerOnSyncGone,
  meshWorkerOnSyncReady,
  reconcileMeshAttemptsOnBoot,
  resetMeshWorkerForTests,
  setMeshWorkerEnabled,
} from '../mesh-worker.service';
import { BackendRpcError } from '../sync-backend-client.service';

const CTX = { apiUrl: 'https://backend.test/v1', accessToken: 'tok', enrollmentId: 'enr-1' };

function makeJob(id: string, kind = 'diagnostic'): MeshJob {
  return {
    id,
    requestId: `req-${id}`,
    payloadHash: 'h',
    kind: kind as MeshJob['kind'],
    sourceEnrollmentId: 'enr-source',
    requestedTarget: { kind: 'device', enrollmentId: 'enr-1' },
    targetEnrollmentId: 'enr-1',
    inputManifest: {
      workspaceDefinitionRevision: 'rev-1',
      repositories: [{ repositoryId: 'r1', commit: 'abc' }],
      bootstrapDigest: 'd',
      provider: 'p',
      model: 'm',
      configVersions: {},
      inputs: {},
    },
    state: 'running',
    queueDeadline: new Date(Date.now() + 600_000).toISOString(),
    retryPolicy: 'never',
  };
}

function makeAttempt(jobId: string): ExecutionAttempt {
  return {
    id: `att-${jobId}`,
    jobId,
    workerIncarnation: 'inc-1',
    fence: 1,
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    state: 'claimed',
  };
}

beforeEach(() => {
  db.exec('DELETE FROM mesh_worker_state; DELETE FROM mesh_attempts;');
  rpcCalls.length = 0;
  rpcHandler = () => ({});
  resetMeshWorkerForTests();
  configureMeshWorkerContext(() => CTX);
});

describe('mesh worker opt-in', () => {
  it('publishes an allowing policy, connects, and publishes capabilities on enable', async () => {
    rpcHandler = (op) => {
      if (op === 'worker.connect') {
        return {
          workerIncarnation: 'inc-1',
          leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
        };
      }
      return {};
    };
    const status = await setMeshWorkerEnabled(true);
    expect(status.enabled).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.workerIncarnation).toBe('inc-1');
    const ops = rpcCalls.map((c) => c.operation);
    expect(ops).toEqual([
      'device.policy.publish',
      'worker.connect',
      'worker.capabilities.publish',
    ]);
    const policy = rpcCalls[0].params as { worker: { allowJobs: boolean } };
    expect(policy.worker.allowJobs).toBe(true);
  });

  it('publishes a denying policy and drops the incarnation on disable', async () => {
    db.prepare(
      `INSERT INTO mesh_worker_state (id, enabled, incarnation, lease_expires_at, connected_at, updated_at)
       VALUES (1, 1, 'inc-1', ?, ?, ?)`,
    ).run(
      new Date(Date.now() + 90_000).toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
    );
    const status = await setMeshWorkerEnabled(false);
    expect(status.enabled).toBe(false);
    expect(status.workerIncarnation).toBeNull();
    expect(rpcCalls[0].operation).toBe('device.policy.publish');
    expect((rpcCalls[0].params as { worker: { allowJobs: boolean } }).worker.allowJobs).toBe(false);
  });
});

describe('job claim + diagnostic execution', () => {
  beforeEach(async () => {
    rpcHandler = (op) => {
      if (op === 'worker.connect') {
        return {
          workerIncarnation: 'inc-1',
          leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
        };
      }
      return {};
    };
    await setMeshWorkerEnabled(true);
    rpcCalls.length = 0;
  });

  it('journals before work, runs the diagnostic, and reports completed', async () => {
    rpcHandler = (op) => {
      if (op === 'job.claim') {
        const job = makeJob('job-1');
        return {
          job,
          attempt: makeAttempt('job-1'),
          fence: 1,
          manifest: job.inputManifest,
        };
      }
      if (op === 'attempt.report') {
        return { status: 'applied' };
      }
      return {};
    };
    await handleJobAvailable('job-1');

    const row = db
      .prepare('SELECT * FROM mesh_attempts WHERE id = ?')
      .get('att-job-1') as { state: string; journal_json: string; result_json: string };
    expect(row.state).toBe('completed');
    const journal = JSON.parse(row.journal_json) as Array<{ event: string }>;
    // Journal shows claim → preparing → running → completed ordering.
    expect(journal.map((j) => j.event)).toEqual([
      'claimed',
      'preparing',
      'running',
      'diagnostic.manifest',
      'diagnostic.environment',
      'completed',
    ]);
    expect(JSON.parse(row.result_json)).toMatchObject({ ok: true });

    const report = rpcCalls.find((c) => c.operation === 'attempt.report');
    expect(report).toBeDefined();
    expect((report!.params as { outcome: string }).outcome).toBe('completed');
    expect((report!.params as { fence: number }).fence).toBe(1);
  });

  it('does nothing when the claim is not granted', async () => {
    rpcHandler = (op) => {
      if (op === 'job.claim') {
        throw new BackendRpcError({ code: 'conflict', retryable: false });
      }
      return {};
    };
    await handleJobAvailable('job-x');
    expect(db.prepare('SELECT COUNT(*) AS n FROM mesh_attempts').get()).toEqual({ n: 0 });
  });

  it('reports failure for an unsupported job kind', async () => {
    rpcHandler = (op) => {
      if (op === 'job.claim') {
        const job = makeJob('job-2', 'workflow-node');
        return {
          job,
          attempt: makeAttempt('job-2'),
          fence: 1,
          manifest: job.inputManifest,
        };
      }
      if (op === 'attempt.report') {
        return { status: 'applied' };
      }
      return {};
    };
    await handleJobAvailable('job-2');
    const row = db
      .prepare('SELECT state FROM mesh_attempts WHERE id = ?')
      .get('att-job-2') as { state: string };
    expect(row.state).toBe('failed');
    const report = rpcCalls.find((c) => c.operation === 'attempt.report');
    expect((report!.params as { outcome: string }).outcome).toBe('failed');
  });

  it('recovers a queued job via the durable sweep when the frame was missed', async () => {
    const job = makeJob('job-rec');
    job.state = 'queued';
    rpcHandler = (op) => {
      if (op === 'worker.connect') {
        return {
          workerIncarnation: 'inc-1',
          leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
        };
      }
      if (op === 'job.list') {
        return { jobs: [{ ...job, placementExplanation: 'explicit-target' }] };
      }
      if (op === 'job.claim') {
        return { job, attempt: makeAttempt('job-rec'), fence: 1, manifest: job.inputManifest };
      }
      if (op === 'attempt.report') {
        return { status: 'applied' };
      }
      return {};
    };
    meshWorkerOnSyncReady();
    const deadline = Date.now() + 5_000;
    let state: string | null = null;
    while (Date.now() < deadline) {
      const row = db
        .prepare('SELECT state FROM mesh_attempts WHERE job_id = ?')
        .get('job-rec') as { state: string } | undefined;
      state = row?.state ?? null;
      if (state === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(state).toBe('completed');
    expect(rpcCalls.some((c) => c.operation === 'job.list')).toBe(true);
  });

  it('respects the capacity bound — a second claim while one is active is skipped', async () => {
    db.prepare(
      `INSERT INTO mesh_attempts (id, job_id, enrollment_id, incarnation, fence, kind, state, manifest_json, created_at, updated_at)
       VALUES ('att-busy', 'job-busy', 'enr-1', 'inc-1', 1, 'diagnostic', 'running', '{}', ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());
    rpcHandler = () => ({});
    await handleJobAvailable('job-3');
    expect(rpcCalls.find((c) => c.operation === 'job.claim')).toBeUndefined();
  });

  it('emits bounded activity frames over the live socket, per-attempt sequenced', async () => {
    const sentFrames: Array<Record<string, unknown>> = [];
    configureMeshWorkerContext(() => ({
      ...CTX,
      sendFrame: (frame: unknown) => sentFrames.push(frame as Record<string, unknown>),
    }));
    rpcHandler = (op) => {
      if (op === 'job.claim') {
        const job = makeJob('job-act');
        return {
          job,
          attempt: makeAttempt('job-act'),
          fence: 1,
          manifest: job.inputManifest,
        };
      }
      if (op === 'attempt.report') {
        return { status: 'applied' };
      }
      return {};
    };
    await handleJobAvailable('job-act');
    const activities = sentFrames.filter((f) => f.type === 'activity');
    expect(activities.length).toBeGreaterThanOrEqual(2);
    activities.forEach((frame, i) => {
      expect(frame.attemptId).toBe('att-job-act');
      expect(frame.streamId).toBe('attempt:att-job-act');
      expect(frame.generation).toBe(1);
      expect(frame.sequence).toBe(i + 1);
      const payload = frame.payload as { kind: string; text: string; byteLength: number };
      expect(payload.kind).toBe('status');
      expect(payload.byteLength).toBe(payload.text.length);
    });
  });

  it('treats a failing frame sender as best-effort — execution still completes', async () => {
    configureMeshWorkerContext(() => ({
      ...CTX,
      sendFrame: () => {
        throw new Error('socket gone');
      },
    }));
    rpcHandler = (op) => {
      if (op === 'job.claim') {
        const job = makeJob('job-noframe');
        return {
          job,
          attempt: makeAttempt('job-noframe'),
          fence: 1,
          manifest: job.inputManifest,
        };
      }
      if (op === 'attempt.report') {
        return { status: 'applied' };
      }
      return {};
    };
    await handleJobAvailable('job-noframe');
    const row = db
      .prepare('SELECT state FROM mesh_attempts WHERE id = ?')
      .get('att-job-noframe') as { state: string };
    expect(row.state).toBe('completed');
  });
});

describe('boot reconciliation', () => {
  it('marks interrupted active attempts unknown-outcome', async () => {
    db.prepare(
      `INSERT INTO mesh_attempts (id, job_id, enrollment_id, incarnation, fence, kind, state, manifest_json, created_at, updated_at)
       VALUES ('att-dead', 'job-dead', 'enr-1', 'inc-old', 5, 'diagnostic', 'running', '{}', ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());
    await reconcileMeshAttemptsOnBoot();
    const row = db
      .prepare('SELECT state, journal_json FROM mesh_attempts WHERE id = ?')
      .get('att-dead') as { state: string; journal_json: string };
    expect(row.state).toBe('unknown-outcome');
    expect(row.journal_json).toContain('reconciled-on-boot');
  });
});

describe('attempt heartbeat', () => {
  beforeEach(async () => {
    rpcHandler = (op) =>
      op === 'worker.connect'
        ? {
            workerIncarnation: 'inc-1',
            leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
          }
        : {};
    await setMeshWorkerEnabled(true);
    rpcCalls.length = 0;
    db.prepare(
      `INSERT INTO mesh_attempts (id, job_id, enrollment_id, incarnation, fence, kind, state, manifest_json, created_at, updated_at)
       VALUES ('att-live', 'job-live', 'enr-1', 'inc-1', 3, 'diagnostic', 'running', '{}', ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());
  });

  it('observes a cancel-requested job via job.get and marks the attempt stopping', async () => {
    rpcHandler = (op) => {
      if (op === 'attempt.renew') {
        return { results: [{ attemptId: 'att-live', status: 'renewed' }] };
      }
      if (op === 'job.get') {
        return { job: { ...makeJob('job-live'), state: 'cancel-requested' }, attempts: [] };
      }
      return {};
    };
    await meshWorkerHeartbeatForTests();
    const row = db
      .prepare('SELECT state, cancel_requested FROM mesh_attempts WHERE id = ?')
      .get('att-live') as { state: string; cancel_requested: number };
    expect(row.state).toBe('stopping');
    expect(row.cancel_requested).toBe(1);
  });

  it('marks an attempt unknown-outcome when its lease renewal is rejected', async () => {
    rpcHandler = (op) => {
      if (op === 'attempt.renew') {
        return {
          results: [{ attemptId: 'att-live', status: 'rejected', reason: 'stale-fence' }],
        };
      }
      if (op === 'job.get') {
        return { job: makeJob('job-live'), attempts: [] };
      }
      return {};
    };
    await meshWorkerHeartbeatForTests();
    const row = db
      .prepare('SELECT state, journal_json FROM mesh_attempts WHERE id = ?')
      .get('att-live') as { state: string; journal_json: string };
    expect(row.state).toBe('unknown-outcome');
    expect(row.journal_json).toContain('lease-renewal-rejected');
  });
});

describe('sync lifecycle hooks', () => {
  it('meshWorkerOnSyncGone drops the live incarnation but keeps the opt-in', async () => {
    rpcHandler = (op) =>
      op === 'worker.connect'
        ? {
            workerIncarnation: 'inc-1',
            leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
          }
        : {};
    await setMeshWorkerEnabled(true);
    meshWorkerOnSyncGone();
    const status = getMeshWorkerStatus();
    expect(status.enabled).toBe(true);
    expect(status.connected).toBe(false);
    expect(status.workerIncarnation).toBeNull();
    expect(isMeshWorkerEnabled()).toBe(true);
  });
});
