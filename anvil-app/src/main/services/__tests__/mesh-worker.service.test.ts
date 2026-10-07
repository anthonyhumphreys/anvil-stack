import { bootstrapManifestPolicy } from '../../../../cloud/contract/permissions';
import { computeBootstrapDigest, setWorkspaceBootstrap } from '../bootstrap-policy.service';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import type { ExecutionAttempt, MeshJob } from '../../../../cloud/contract/jobs';
import type { AgentProvider } from '../../../shared/types';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);

const meshVerificationDialog = vi.hoisted(() => ({
  showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
}));
const browserSessionOwnership = vi.hoisted(() => ({
  interruptBrowserWorkspaceTurnsAbove: vi.fn(),
}));

vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test', isReady: () => true },
  BrowserWindow: {
    getFocusedWindow: () => ({ isVisible: () => true, isMinimized: () => false }),
    getAllWindows: () => [{ isVisible: () => true, isMinimized: () => false }],
  },
  dialog: { showMessageBox: meshVerificationDialog.showMessageBox },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString('utf-8');
      if (!text.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext.');
      return text.slice('enc:'.length);
    },
  },
}));

interface RpcCall {
  operation: string;
  params: unknown;
}

const rpcCalls: RpcCall[] = [];
let rpcHandler: (operation: string, params: unknown) => unknown = () => ({});

vi.mock('../sync-backend-client.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../sync-backend-client.service.js')>();
  return {
    ...original,
    rpc: async (
      _connection: unknown,
      operation: string,
      params: unknown,
    ): Promise<{ result: unknown; serverTime: string }> => {
      rpcCalls.push({ operation, params });
      const result = rpcHandler(operation, params);
      // Scoped claims pull credential grants and task-key wraps — default
      // to empty collections unless the test's handler supplies its own.
      const normalized =
        result !== null && typeof result === 'object'
          ? {
              ...(operation === 'credential.pull' ? { grants: [] } : {}),
              ...(operation === 'taskkey.pull' ? { wraps: [] } : {}),
              ...result,
            }
          : result;
      return { result: normalized, serverTime: '' };
    },
  };
});

vi.mock('../mesh-artifact.service.js', () => ({
  uploadAttemptArtifact: vi.fn(async () => ({ id: 'art-test' })),
}));
vi.mock('../browser-session-ownership.service.js', () => browserSessionOwnership);

vi.mock('../sync-keyring.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../sync-keyring.service.js')>();
  return {
    ...original,
    unsealCredentialGrant: vi.fn(() => ({
      v: 1,
      kind: 'credential-name',
      env: { OPENAI_API_KEY: 'sealed-test-key' },
    })),
  };
});

vi.mock('../mesh-session.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../mesh-session.service.js')>();
  return {
    ...original,
    probeSessionCli: vi.fn(async () => '0.44.0'),
    runRemoteSessionTurn: vi.fn(),
  };
});

import {
  configureMeshWorkerContext,
  createCodeTaskJob,
  createPrepareWorkspaceJob,
  createStartSessionJob,
  getMeshWorkerStatus,
  handleJobAvailable,
  isMeshWorkerEnabled,
  meshWorkerHeartbeatForTests,
  meshWorkerOnSyncGone,
  meshWorkerOnSyncReady,
  notifyMeshWorkerAttemptEvent,
  reconcileMeshAttemptsOnBoot,
  requestApprovalForTests,
  resetMeshWorkerForTests,
  setMeshWorkerEnabled,
  setMeshMaximumPermissionMode,
  buildDevicePolicy,
} from '../mesh-worker.service';
import { BackendRpcError } from '../sync-backend-client.service';
import {
  taskKeyFor,
  unsealTaskInputs,
  storeTaskKey,
  unsealTaskResult,
} from '../sync-keyring.service';
import { workspaceDefinitionRevision } from '../sync-entity-domain';
import { unsealCredentialGrant } from '../sync-keyring.service';
import { probeSessionCli, runRemoteSessionTurn } from '../mesh-session.service';
import type { RemoteSessionHooks, RemoteSessionSpec } from '../mesh-session.service';

const SCOPE = { backendId: 'backend-1', accountId: 'account-1', datasetEpoch: '1' } as const;
const CTX = {
  apiUrl: 'https://backend.test/v1',
  accessToken: 'tok',
  enrollmentId: 'enr-1',
  scope: SCOPE,
};

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
  db.exec('DELETE FROM mesh_worker_state; DELETE FROM mesh_attempts; DELETE FROM mesh_task_keys;');
  rpcCalls.length = 0;
  rpcHandler = () => ({});
  meshVerificationDialog.showMessageBox.mockClear().mockResolvedValue({ response: 0 });
  resetMeshWorkerForTests();
  configureMeshWorkerContext(() => CTX);
});

describe('node permission ceiling', () => {
  it('defaults to approval and persists independently of worker opt-in', async () => {
    expect(getMeshWorkerStatus().maxPermissionMode).toBe('on-request');
    await setMeshMaximumPermissionMode('full-access');
    await setMeshWorkerEnabled(false);
    expect(getMeshWorkerStatus().maxPermissionMode).toBe('full-access');
  });
  it('saves the local ceiling when the coordinator is unreachable', async () => {
    rpcHandler = (operation) =>
      operation === 'worker.connect'
        ? {
            workerIncarnation: 'inc-1',
            leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
          }
        : {};
    await setMeshWorkerEnabled(true);
    rpcHandler = () => {
      throw new Error('offline');
    };
    expect(await setMeshMaximumPermissionMode('read-only')).toMatchObject({
      maxPermissionMode: 'read-only',
      lastError: expect.stringContaining('saved locally'),
    });
  });
  it('stops active work when the maximum is lowered', async () => {
    await setMeshMaximumPermissionMode('full-access');
    db.prepare(
      `INSERT INTO mesh_attempts (id, job_id, enrollment_id, incarnation, fence, kind, state, manifest_json, journal_json, created_at, updated_at)
      VALUES ('att-policy', 'job-policy', 'enr-1', 'inc-1', 1, 'code-task', 'running', '{}', '[]', datetime('now'), datetime('now'))`,
    ).run();
    await setMeshMaximumPermissionMode('read-only');
    expect(
      db.prepare('SELECT cancel_requested FROM mesh_attempts WHERE id = ?').get('att-policy'),
    ).toEqual({ cancel_requested: 1 });
    expect(rpcCalls).toContainEqual({ operation: 'job.cancel', params: { jobId: 'job-policy' } });
    expect(browserSessionOwnership.interruptBrowserWorkspaceTurnsAbove).toHaveBeenCalledWith(
      'read-only',
    );
  });
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
    expect(ops).toEqual(['device.policy.publish', 'worker.connect', 'worker.capabilities.publish']);
    const policy = rpcCalls[0].params as { worker: { allowJobs: boolean } };
    expect(policy.worker.allowJobs).toBe(true);
  });

  it('keeps a retryable failed opt-in enabled and reconnects on heartbeat', async () => {
    let unavailable = true;
    rpcHandler = (operation) => {
      if (operation === 'worker.connect') {
        if (unavailable) throw new BackendRpcError({ code: 'unavailable', retryable: true });
        return {
          workerIncarnation: 'inc-recovered',
          leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
        };
      }
      return {};
    };

    const first = await setMeshWorkerEnabled(true);
    expect(first.enabled).toBe(true);
    expect(first.connected).toBe(false);
    expect(first.lastError).toContain('unavailable');

    unavailable = false;
    rpcCalls.length = 0;
    await meshWorkerHeartbeatForTests();
    expect(rpcCalls.map((call) => call.operation)).toEqual([
      'device.policy.publish',
      'worker.connect',
      'worker.capabilities.publish',
    ]);
    expect(getMeshWorkerStatus()).toMatchObject({
      enabled: true,
      connected: true,
      lastError: null,
    });
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

    const row = db.prepare('SELECT * FROM mesh_attempts WHERE id = ?').get('att-job-1') as {
      state: string;
      journal_json: string;
      result_json: string;
    };
    expect(row.state).toBe('completed');
    const journal = JSON.parse(row.journal_json) as Array<{ event: string }>;
    // Journal shows claim → preparing → running → artifact → completed ordering.
    expect(journal.map((j) => j.event)).toEqual([
      'claimed',
      'preparing',
      'running',
      'diagnostic.manifest',
      'diagnostic.environment',
      'artifact-uploaded',
      'completed',
    ]);
    expect(JSON.parse(row.result_json)).toMatchObject({ ok: true });

    const report = rpcCalls.find((c) => c.operation === 'attempt.report');
    expect(report).toBeDefined();
    expect((report!.params as { outcome: string }).outcome).toBe('completed');
    expect((report!.params as { fence: number }).fence).toBe(1);
  });

  it('does nothing when the claim is not granted', async () => {
    rpcHandler = (op, _params) => {
      if (op === 'job.claim') {
        throw new BackendRpcError({ code: 'conflict', retryable: false });
      }
      return {};
    };
    await handleJobAvailable('job-x');
    expect(db.prepare('SELECT COUNT(*) AS n FROM mesh_attempts').get()).toEqual({ n: 0 });
  });

  it('reports failure for an unsupported job kind', async () => {
    rpcHandler = (op, params) => {
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
      if (op === 'event.append') {
        const events = (params as { events: Array<{ streamId: string; sequence: number }> }).events;
        return {
          results: events.map((event) => ({ ...event, status: 'journaled' })),
        };
      }
      return {};
    };
    await handleJobAvailable('job-2');
    const row = db.prepare('SELECT state FROM mesh_attempts WHERE id = ?').get('att-job-2') as {
      state: string;
    };
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
      const row = db.prepare('SELECT state FROM mesh_attempts WHERE job_id = ?').get('job-rec') as
        | { state: string }
        | undefined;
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
    rpcHandler = (op, params) => {
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
      if (op === 'event.append') {
        const events = (params as { events: Array<{ streamId: string; sequence: number }> }).events;
        return { results: events.map((event) => ({ ...event, status: 'journaled' })) };
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
    const appends = rpcCalls.filter((call) => call.operation === 'event.append');
    expect(appends).toHaveLength(1);
    expect((appends[0]!.params as { events: unknown[] }).events).toHaveLength(activities.length);
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

  it('observes a cancel-requested job from the fenced renewal and avoids a job.get per attempt', async () => {
    rpcHandler = (op) => {
      if (op === 'attempt.renew') {
        return {
          results: [
            { attemptId: 'att-live', status: 'renewed', cancelRequested: true },
          ],
        };
      }
      return {};
    };
    await meshWorkerHeartbeatForTests();
    const row = db
      .prepare('SELECT state, cancel_requested FROM mesh_attempts WHERE id = ?')
      .get('att-live') as { state: string; cancel_requested: number };
    expect(row.state).toBe('stopping');
    expect(row.cancel_requested).toBe(1);
    expect(rpcCalls.filter((call) => call.operation === 'job.get')).toHaveLength(0);
  });

  it('marks an attempt unknown-outcome when its lease renewal is rejected', async () => {
    rpcHandler = (op) => {
      if (op === 'attempt.renew') {
        return {
          results: [
            {
              attemptId: 'att-live',
              status: 'rejected',
              reason: 'stale-fence',
              cancelRequested: false,
            },
          ],
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

describe('createPrepareWorkspaceJob (SESSION-02)', () => {
  it('rejects when a definition has no resolved commit on this device', async () => {
    db.prepare(
      `INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('w1', 'W', datetime('now'), 'rev-1')`,
    ).run();
    db.prepare(
      `INSERT INTO workspace_repo_definitions (workspace_id, portable_id, name, created_at, updated_at)
       VALUES ('w1', 'p1', 'repo', datetime('now'), datetime('now'))`,
    ).run();
    await expect(
      createPrepareWorkspaceJob({ requestId: 'req-1', workspaceId: 'w1' }),
    ).rejects.toThrow('no resolved commit');
    expect(rpcCalls.find((c) => c.operation === 'job.create')).toBeUndefined();
  });

  it('pins resolved HEAD commits and the definition revision in the manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-mesh-prepare-'));
    try {
      execFileSync('git', ['init'], { cwd: dir });
      execFileSync(
        'git',
        ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'],
        { cwd: dir },
      );
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
      db.prepare(
        `INSERT INTO repos (id, name, path, status, created_at, updated_at)
         VALUES ('repo-1', 'repo', ?, 'connected', datetime('now'), datetime('now'))`,
      ).run(dir);
      db.prepare(
        `INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('w2', 'W', datetime('now'), 'rev-2')`,
      ).run();
      db.prepare(
        `INSERT INTO workspace_repo_definitions (workspace_id, portable_id, name, mapped_repo_id, created_at, updated_at)
         VALUES ('w2', 'p1', 'repo', 'repo-1', datetime('now'), datetime('now'))`,
      ).run();

      rpcHandler = (op) =>
        op === 'job.create' ? { job: { id: 'job-p', kind: 'prepare-workspace' } } : {};
      const job = await createPrepareWorkspaceJob({
        requestId: 'req-2',
        workspaceId: 'w2',
        targetEnrollmentId: 'enr-9',
      });
      expect(job.id).toBe('job-p');
      const create = rpcCalls.find((c) => c.operation === 'job.create');
      expect(create).toBeDefined();
      const params = create!.params as {
        kind: string;
        requestedTarget: { kind: string; enrollmentId?: string };
        inputManifest: {
          workspaceDefinitionRevision: string;
          repositories: Array<{ repositoryId: string; commit: string }>;
          bootstrapDigest: string;
          inputs: Record<string, unknown>;
        };
      };
      expect(params.kind).toBe('prepare-workspace');
      expect(params.requestedTarget).toEqual({ kind: 'device', enrollmentId: 'enr-9' });
      // The revision pin is the canonical payload content digest — both
      // sides recompute it; `updated_at` is a local clock and can't pin.
      expect(params.inputManifest.workspaceDefinitionRevision).toMatch(/^[0-9a-f]{64}$/);
      expect(params.inputManifest.workspaceDefinitionRevision).toBe(
        workspaceDefinitionRevision('w2'),
      );
      expect(params.inputManifest.repositories).toEqual([{ repositoryId: 'p1', commit: head }]);
      expect(params.inputManifest.bootstrapDigest).toBe('none');
      expect(params.inputManifest.inputs['workspaceId']).toBe('w2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('remote approval wait (SESSION-02)', () => {
  const sentFrames: unknown[] = [];
  const LIVE_CTX = {
    ...CTX,
    sendFrame: (frame: unknown) => {
      sentFrames.push(frame);
    },
    isLive: () => true,
  };

  function insertAttempt(id = 'att-approval'): void {
    db.prepare(
      `INSERT INTO mesh_attempts (id, job_id, enrollment_id, incarnation, fence, kind, state, manifest_json, created_at, updated_at)
       VALUES (?, 'job-approval', 'enr-1', 'inc-1', 1, 'prepare-workspace', 'running', '{}', ?, ?)`,
    ).run(id, new Date().toISOString(), new Date().toISOString());
  }

  beforeEach(() => {
    sentFrames.length = 0;
    configureMeshWorkerContext(() => LIVE_CTX);
  });

  it('sends the request on the reserved control stream and approves on a decided row', async () => {
    insertAttempt();
    rpcHandler = (op, _params) => {
      if (op === 'approval.get') {
        return {
          approvals: [
            {
              id: 'ap-1',
              jobId: 'job-approval',
              attemptId: 'att-approval',
              actionDigest: 'digest-1',
              generation: 1,
              approverRole: 'user',
              state: 'approved',
              expiresAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            },
          ],
        };
      }
      if (op === 'job.get') return { job: { state: 'running' } };
      return {};
    };
    const decision = await requestApprovalForTests(
      makeJob('job-approval', 'prepare-workspace'),
      { ...makeAttempt('job-approval'), id: 'att-approval' },
      'digest-1',
      5,
      500,
    );
    expect(decision).toBe('approved');
    const control = sentFrames.find((f) => (f as { streamId: string }).streamId === 'control') as {
      type: string;
      streamId: string;
      payload: { kind: string; text: string };
    };
    expect(control).toBeDefined();
    expect(control.type).toBe('activity');
    expect(JSON.parse(control.payload.text)).toEqual({
      request: 'approval',
      actionDigest: 'digest-1',
    });
    const row = db
      .prepare('SELECT journal_json FROM mesh_attempts WHERE id = ?')
      .get('att-approval') as { journal_json: string };
    expect(row.journal_json).toContain('approval-requested');
    expect(row.journal_json).toContain('approval-approved');
  });

  it('uses a scoped push event to wake the durable approval read before its fallback', async () => {
    insertAttempt();
    let state: 'pending' | 'approved' = 'pending';
    let approvalReads = 0;
    rpcHandler = (op) => {
      if (op === 'approval.get') {
        approvalReads += 1;
        return {
          approvals: [
            {
              id: 'ap-push',
              jobId: 'job-approval',
              attemptId: 'att-approval',
              actionDigest: 'digest-1',
              generation: 1,
              approverRole: 'user',
              state,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              createdAt: new Date().toISOString(),
            },
          ],
        };
      }
      return { job: { state: 'awaiting-approval' } };
    };
    const decisionPromise = requestApprovalForTests(
      makeJob('job-approval'),
      { ...makeAttempt('job-approval'), id: 'att-approval' },
      'digest-1',
      1_000,
      2_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    state = 'approved';
    notifyMeshWorkerAttemptEvent('att-approval');
    await expect(decisionPromise).resolves.toBe('approved');
    expect(approvalReads).toBe(2);
  });

  it('denies on a denied/expired approval row', async () => {
    insertAttempt();
    rpcHandler = (op) => {
      if (op === 'approval.get') {
        return {
          approvals: [
            {
              id: 'ap-1',
              jobId: 'job-approval',
              attemptId: 'att-approval',
              actionDigest: 'digest-1',
              generation: 1,
              approverRole: 'user',
              state: 'denied',
              expiresAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            },
          ],
        };
      }
      return { job: { state: 'failed' } };
    };
    const decision = await requestApprovalForTests(
      makeJob('job-approval'),
      { ...makeAttempt('job-approval'), id: 'att-approval' },
      'digest-1',
      5,
      500,
    );
    expect(decision).toBe('denied');
  });

  it('denies when the job leaves running/awaiting-approval while still pending', async () => {
    insertAttempt();
    rpcHandler = (op) =>
      op === 'approval.get' ? { approvals: [] } : { job: { state: 'cancelled' } };
    const decision = await requestApprovalForTests(
      makeJob('job-approval'),
      { ...makeAttempt('job-approval'), id: 'att-approval' },
      'digest-1',
      5,
      500,
    );
    expect(decision).toBe('denied');
  });

  it('fails closed when the request never lands (job still running, no approval row)', async () => {
    insertAttempt();
    rpcHandler = (op) =>
      op === 'approval.get' ? { approvals: [] } : { job: { state: 'running' } };
    const decision = await requestApprovalForTests(
      makeJob('job-approval'),
      { ...makeAttempt('job-approval'), id: 'att-approval' },
      'digest-1',
      5,
      60,
    );
    expect(decision).toBe('denied');
    const row = db
      .prepare('SELECT journal_json FROM mesh_attempts WHERE id = ?')
      .get('att-approval') as { journal_json: string };
    expect(row.journal_json).toContain('approval-expired');
  });

  it('fails closed without sending when the socket never comes up', async () => {
    insertAttempt();
    configureMeshWorkerContext(() => ({
      ...CTX,
      sendFrame: (frame: unknown) => {
        sentFrames.push(frame);
      },
      isLive: () => false,
    }));
    rpcHandler = (op) =>
      op === 'approval.get' ? { approvals: [] } : { job: { state: 'running' } };
    const decision = await requestApprovalForTests(
      makeJob('job-approval'),
      { ...makeAttempt('job-approval'), id: 'att-approval' },
      'digest-1',
      5,
      60,
    );
    expect(decision).toBe('denied');
    // Status activity may still be emitted; the CONTROL request must not be.
    expect(
      sentFrames.filter((f) => (f as { streamId: string }).streamId === 'control'),
    ).toHaveLength(0);
  });

  it('retries the control send until the approval row proves it landed', async () => {
    insertAttempt();
    let approvalReads = 0;
    rpcHandler = (op) => {
      if (op === 'approval.get') {
        approvalReads += 1;
        // Row appears only on the third read — earlier sends "missed".
        if (approvalReads < 3) return { approvals: [] };
        return {
          approvals: [
            {
              id: 'ap-1',
              jobId: 'job-approval',
              attemptId: 'att-approval',
              actionDigest: 'digest-1',
              generation: 1,
              approverRole: 'user',
              state: 'approved',
              expiresAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            },
          ],
        };
      }
      return { job: { state: 'awaiting-approval' } };
    };
    const decision = await requestApprovalForTests(
      makeJob('job-approval'),
      { ...makeAttempt('job-approval'), id: 'att-approval' },
      'digest-1',
      5,
      500,
    );
    expect(decision).toBe('approved');
    // One send per poll until the row was seen — idempotent on the backend.
    const controlSends = sentFrames.filter(
      (f) => (f as { streamId: string }).streamId === 'control',
    );
    expect(controlSends.length).toBeGreaterThanOrEqual(2);
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

const runTurnMock = vi.mocked(runRemoteSessionTurn);
const probeMock = vi.mocked(probeSessionCli);

describe('start-session executor (SESSION-02)', () => {
  it.each(['on-request', 'workspace-auto', 'full-access', 'read-only'] as const)(
    'caps a full-access request at the node maximum %s',
    async (mode) => {
      const { workspaceId, portableId, repoDir, head } = seedSessionWorkspace(`cap-${mode}`);
      try {
        await setMeshMaximumPermissionMode(mode);
        const job = makeSessionJob('job-cap', workspaceId, portableId, head, {
          permissionMode: 'full-access',
        });
        claimWith(job);
        await handleJobAvailable(job.id);
        expect(runTurnMock.mock.calls.at(-1)?.[0]).toMatchObject({
          permissionMode: mode,
          sandbox:
            mode === 'full-access'
              ? 'danger-full-access'
              : mode === 'read-only'
                ? 'read-only'
                : 'workspace-write',
        });
        expect(buildDevicePolicy().worker.maxPermissionMode).toBe(mode);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    },
  );

  function seedSessionWorkspace(
    suffix: string,
    mapped = true,
  ): {
    workspaceId: string;
    portableId: string;
    repoDir: string;
    head: string;
  } {
    const repoDir = mkdtempSync(join(tmpdir(), `anvil-mesh-sess-${suffix}-`));
    execFileSync('git', ['init'], { cwd: repoDir });
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'],
      { cwd: repoDir },
    );
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim();
    const workspaceId = `w-sess-${suffix}`;
    const portableId = `p-${suffix}`;
    db.prepare(
      `INSERT INTO repos (id, name, path, status, created_at, updated_at)
       VALUES (?, 'repo', ?, 'connected', datetime('now'), datetime('now'))`,
    ).run(`repo-${suffix}`, repoDir);
    db.prepare(
      `INSERT INTO workspaces (id, name, created_at, updated_at)
       VALUES (?, 'W', datetime('now'), datetime('now'))`,
    ).run(workspaceId);
    db.prepare(
      `INSERT INTO workspace_repo_definitions
       (workspace_id, portable_id, name, mapped_repo_id, created_at, updated_at)
       VALUES (?, ?, 'repo', ?, datetime('now'), datetime('now'))`,
    ).run(workspaceId, portableId, mapped ? `repo-${suffix}` : null);
    return { workspaceId, portableId, repoDir, head };
  }

  function makeSessionJob(
    id: string,
    workspaceId: string,
    portableId: string,
    commit: string,
    inputs: Record<string, unknown> = {},
  ): MeshJob {
    const job = makeJob(id, 'start-session');
    job.inputManifest = {
      workspaceDefinitionRevision: workspaceDefinitionRevision(workspaceId)!,
      repositories: [{ repositoryId: portableId, commit }],
      bootstrapDigest: 'none',
      provider: (inputs['provider'] as AgentProvider | undefined) ?? 'codex',
      model: 'gpt-5',
      configVersions: {},
      inputs: { workspaceId, prompt: 'do the thing', ...inputs },
    };
    return job;
  }

  function claimWith(
    job: MeshJob,
    extra?: (operation: string, params: unknown) => unknown,
    attemptOverrides: Partial<ExecutionAttempt> = {},
  ): void {
    rpcHandler = (op, params) => {
      if (op === 'job.claim') {
        return {
          job,
          attempt: { ...makeAttempt(job.id), ...attemptOverrides },
          fence: 1,
          manifest: job.inputManifest,
        };
      }
      if (op === 'attempt.report') {
        return { status: 'applied' };
      }
      if (extra !== undefined) return extra(op, params);
      return {};
    };
  }

  function insertPriorAttempt(jobId: string, journal: Array<Record<string, unknown>>): void {
    db.prepare(
      `INSERT INTO mesh_attempts
       (id, job_id, enrollment_id, incarnation, fence, kind, state, manifest_json, journal_json, created_at, updated_at)
       VALUES (?, ?, 'enr-1', 'inc-1', 1, 'start-session', 'failed', '{}', ?, ?, ?)`,
    ).run(
      `prior-${jobId}`,
      jobId,
      JSON.stringify(journal),
      new Date(Date.now() - 60_000).toISOString(),
      new Date().toISOString(),
    );
  }

  beforeEach(async () => {
    db.exec('DELETE FROM mesh_session_ownership; DELETE FROM mesh_handoff_journal;');
    probeMock.mockReset().mockResolvedValue('0.44.0');
    vi.mocked(unsealCredentialGrant).mockReturnValue({
      v: 1,
      kind: 'credential-name',
      env: { OPENAI_API_KEY: 'sealed-test-key' },
    });
    runTurnMock.mockReset();
    runTurnMock.mockImplementation(async (_spec: RemoteSessionSpec, hooks: RemoteSessionHooks) => {
      hooks.onThreadStarted('thr-mock');
      return {
        providerThreadId: 'thr-mock',
        turnId: 'turn-1',
        turnStatus: 'completed' as const,
        cliVersion: '0.44.0',
        cancelled: false,
        assistantOutput: 'answer',
        resumeHandle: 'thr-mock',
      };
    });
    rpcHandler = (op) =>
      op === 'worker.connect'
        ? {
            workerIncarnation: 'inc-1',
            leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
          }
        : {};
    await setMeshWorkerEnabled(true);
    rpcCalls.length = 0;
  });

  it('spawns the provider, journals the lifecycle, and reports completed', async () => {
    const { workspaceId, portableId, repoDir, head } = seedSessionWorkspace('ok');
    try {
      const job = makeSessionJob('job-sess', workspaceId, portableId, head);
      claimWith(job);
      await handleJobAvailable('job-sess');

      const row = db
        .prepare('SELECT state, journal_json, result_json FROM mesh_attempts WHERE id = ?')
        .get('att-job-sess') as { state: string; journal_json: string; result_json: string };
      expect(row.state).toBe('completed');
      const journal = JSON.parse(row.journal_json) as Array<{ event: string }>;
      const events = journal.map((j) => j.event);
      // Spawn intent precedes the thread record; turn markers bracket the run.
      expect(events).toContain('provider-spawn');
      expect(events).toContain('provider-thread');
      expect(events.indexOf('provider-spawn')).toBeLessThan(events.indexOf('provider-thread'));
      const result = JSON.parse(row.result_json) as Record<string, unknown>;
      expect(result).toMatchObject({
        ok: true,
        providerThreadId: 'thr-mock',
        turnId: 'turn-1',
        cliVersion: '0.44.0',
      });

      const spec = runTurnMock.mock.calls[0]?.[0];
      expect(spec).toMatchObject({
        provider: 'codex',
        model: 'gpt-5',
        cwd: repoDir,
        prompt: 'do the thing',
        sandbox: 'workspace-write',
      });
      const report = rpcCalls.find((c) => c.operation === 'attempt.report');
      expect((report!.params as { outcome: string }).outcome).toBe('completed');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('resumes a provider session in its persisted checkout after the provider commits changes', async () => {
    const { workspaceId, portableId, repoDir, head } = seedSessionWorkspace('resume-checkout');
    try {
      let turn = 0;
      runTurnMock.mockImplementation(async (spec, hooks) => {
        turn += 1;
        hooks.onThreadStarted('thr-resume-checkout');
        if (turn === 1) {
          writeFileSync(join(repoDir, 'provider-work.txt'), 'kept across turns');
          execFileSync('git', ['add', 'provider-work.txt'], { cwd: repoDir });
          execFileSync(
            'git',
            ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'provider work'],
            { cwd: repoDir },
          );
        }
        return {
          providerThreadId: spec.resumeThreadId ?? 'thr-resume-checkout',
          turnId: `turn-${turn}`,
          turnStatus: 'completed' as const,
          cliVersion: '0.44.0',
          cancelled: false,
          assistantOutput: `answer ${turn}`,
          resumeHandle: 'thr-resume-checkout',
        };
      });

      const first = makeSessionJob('job-resume-first', workspaceId, portableId, head);
      claimWith(first);
      await handleJobAvailable(first.id);
      const changedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })
        .toString()
        .trim();
      expect(changedHead).not.toBe(head);

      const followup = makeSessionJob('job-resume-followup', workspaceId, portableId, head, {
        resumeThreadId: 'thr-resume-checkout',
      });
      claimWith(followup);
      await handleJobAvailable(followup.id);

      expect(runTurnMock).toHaveBeenCalledTimes(2);
      expect(runTurnMock.mock.calls[1]?.[0]).toMatchObject({
        cwd: repoDir,
        resumeThreadId: 'thr-resume-checkout',
      });
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim()).toBe(
        changedHead,
      );
      expect(readFileSync(join(repoDir, 'provider-work.txt'), 'utf8')).toBe('kept across turns');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('waits for a late API-key grant before probing or starting the provider', async () => {
    const { workspaceId, portableId, repoDir, head } = seedSessionWorkspace('late-grant');
    try {
      const job = makeSessionJob('job-late-grant', workspaceId, portableId, head, {
        authMode: 'openai-api-key',
      });
      vi.mocked(unsealCredentialGrant).mockReturnValue({
        v: 1,
        kind: 'remote-codex-api-key',
        env: { OPENAI_API_KEY: 'real-api-key-grant' },
      });
      let pulls = 0;
      claimWith(job, (operation) => {
        if (operation === 'credential.pull') {
          pulls += 1;
          return {
            grants:
              pulls >= 3
                ? [
                    {
                      jobId: job.id,
                      attemptId: `att-${job.id}`,
                      fence: 1,
                      targetEnrollmentId: 'enr-1',
                      expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    },
                  ]
                : [],
          };
        }
        return {};
      });

      await handleJobAvailable(job.id);
      expect(pulls).toBeGreaterThanOrEqual(3);
      expect(probeMock).toHaveBeenCalledTimes(1);
      expect(runTurnMock.mock.calls[0]?.[0].extraEnv).toMatchObject({
        OPENAI_API_KEY: 'real-api-key-grant',
      });
      const row = db
        .prepare('SELECT journal_json FROM mesh_attempts WHERE id = ?')
        .get(`att-${job.id}`) as { journal_json: string };
      expect(row.journal_json).toContain('credential-grants-applied');
      expect(row.journal_json).not.toContain('real-api-key-grant');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('waits for and scopes a cloud provider grant to the provider and stable Devin session home', async () => {
    const { workspaceId, portableId, repoDir, head } = seedSessionWorkspace('cloud-provider-devin');
    const userDataDir = mkdtempSync(join(tmpdir(), 'anvil-provider-auth-home-'));
    const credentialsToml = 'access_token = "private-devin-token"\n';
    try {
      configureMeshWorkerContext(() => ({ ...CTX, userDataDir }));
      const job = makeSessionJob('job-cloud-provider-devin', workspaceId, portableId, head, {
        provider: 'devin',
        authMode: 'cloud-provider',
        authSessionId: 'stable-devin-session',
      });
      vi.mocked(unsealCredentialGrant).mockReturnValue({
        v: 1,
        kind: 'remote-provider-auth',
        provider: 'devin',
        env: {},
        devinCredentialsToml: credentialsToml,
      });
      let pulls = 0;
      claimWith(job, (operation) => {
        if (operation !== 'credential.pull') return {};
        pulls += 1;
        return {
          grants:
            pulls >= 3
              ? [
                  {
                    jobId: job.id,
                    attemptId: `att-${job.id}`,
                    fence: 1,
                    targetEnrollmentId: 'enr-1',
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                  },
                ]
              : [],
        };
      });

      await handleJobAvailable(job.id);

      expect(pulls).toBeGreaterThanOrEqual(3);
      const spec = runTurnMock.mock.calls[0]?.[0];
      expect(spec).toMatchObject({
        provider: 'devin',
        authMode: 'cloud-provider',
        devinCredentialsToml: credentialsToml,
        extraEnv: {
          XDG_DATA_HOME: expect.stringMatching(/\/mesh-provider-data\/[a-f0-9]{64}$/),
        },
      });
      expect(
        spec?.extraEnv?.XDG_DATA_HOME?.startsWith(join(userDataDir, 'mesh-provider-data')),
      ).toBe(true);
      const journal = (
        db.prepare('SELECT journal_json FROM mesh_attempts WHERE id = ?').get(`att-${job.id}`) as {
          journal_json: string;
        }
      ).journal_json;
      expect(journal).not.toContain('private-devin-token');
      expect(journal).not.toContain(credentialsToml);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('rejects a cloud provider grant bound to a different provider before provider startup', async () => {
    const { workspaceId, portableId, repoDir, head } =
      seedSessionWorkspace('provider-auth-mismatch');
    try {
      const job = makeSessionJob('job-provider-auth-mismatch', workspaceId, portableId, head, {
        provider: 'cursor',
        authMode: 'cloud-provider',
        authSessionId: 'stable-cursor-session',
      });
      vi.mocked(unsealCredentialGrant).mockReturnValue({
        v: 1,
        kind: 'remote-provider-auth',
        provider: 'devin',
        env: {},
        devinCredentialsToml: 'private-token = "secret"',
      });
      claimWith(job, (operation) =>
        operation === 'credential.pull'
          ? {
              grants: [
                {
                  jobId: job.id,
                  attemptId: `att-${job.id}`,
                  fence: 1,
                  targetEnrollmentId: 'enr-1',
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                },
              ],
            }
          : {},
      );

      await handleJobAvailable(job.id);

      expect(probeMock).not.toHaveBeenCalled();
      expect(runTurnMock).not.toHaveBeenCalled();
      const journal = (
        db.prepare('SELECT journal_json FROM mesh_attempts WHERE id = ?').get(`att-${job.id}`) as {
          journal_json: string;
        }
      ).journal_json;
      expect(journal).toContain('provider-auth-grant-provider-mismatch');
      expect(journal).not.toContain('private-token');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('accepts only supported LLMGateway billing modes from a cloud provider grant', async () => {
    const { workspaceId, portableId, repoDir, head } =
      seedSessionWorkspace('provider-auth-gateway');
    try {
      const job = makeSessionJob('job-provider-auth-gateway', workspaceId, portableId, head, {
        provider: 'llmgateway',
        authMode: 'cloud-provider',
        authSessionId: 'stable-gateway-session',
      });
      vi.mocked(unsealCredentialGrant).mockReturnValue({
        v: 1,
        kind: 'remote-provider-auth',
        provider: 'llmgateway',
        env: {
          LLMGATEWAY_API_KEY: 'private-gateway-key',
          LLMGATEWAY_BILLING_MODE: 'devpass',
        },
      });
      claimWith(job, (operation) =>
        operation === 'credential.pull'
          ? {
              grants: [
                {
                  jobId: job.id,
                  attemptId: `att-${job.id}`,
                  fence: 1,
                  targetEnrollmentId: 'enr-1',
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                },
              ],
            }
          : {},
      );

      await handleJobAvailable(job.id);

      expect(runTurnMock.mock.calls[0]?.[0]).toMatchObject({
        provider: 'llmgateway',
        authMode: 'cloud-provider',
        extraEnv: {
          LLMGATEWAY_API_KEY: 'private-gateway-key',
          LLMGATEWAY_BILLING_MODE: 'devpass',
        },
      });
      const journal = (
        db.prepare('SELECT journal_json FROM mesh_attempts WHERE id = ?').get(`att-${job.id}`) as {
          journal_json: string;
        }
      ).journal_json;
      expect(journal).not.toContain('private-gateway-key');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('stops waiting for an API-key grant when the claimed job is cancelled', async () => {
    const { workspaceId, portableId, repoDir, head } = seedSessionWorkspace('grant-cancel');
    try {
      const job = makeSessionJob('job-grant-cancel', workspaceId, portableId, head, {
        authMode: 'openai-api-key',
      });
      let pulls = 0;
      claimWith(job, (operation) => {
        if (operation === 'credential.pull') {
          pulls += 1;
          return { grants: [] };
        }
        return {};
      });

      const executing = handleJobAvailable(job.id);
      await vi.waitFor(() => expect(pulls).toBeGreaterThanOrEqual(2));
      db.prepare('UPDATE mesh_attempts SET cancel_requested = 1 WHERE id = ?').run(`att-${job.id}`);
      await executing;
      expect(probeMock).not.toHaveBeenCalled();
      expect(runTurnMock).not.toHaveBeenCalled();
      const row = db
        .prepare('SELECT state, journal_json FROM mesh_attempts WHERE id = ?')
        .get(`att-${job.id}`) as { state: string; journal_json: string };
      expect(row.state).toBe('failed');
      expect(row.journal_json).toContain('provider-credential-wait-cancelled');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('waits for a late launch-host Codex auth grant and passes a stable private home to the runner', async () => {
    const { workspaceId, portableId, repoDir, head } = seedSessionWorkspace('codex-host-auth');
    const userDataDir = mkdtempSync(join(tmpdir(), 'anvil-codex-auth-home-'));
    try {
      configureMeshWorkerContext(() => ({ ...CTX, userDataDir }));
      const job = makeSessionJob('job-codex-host-auth', workspaceId, portableId, head, {
        authMode: 'codex-host-auth',
        authSessionId: 'remote-session-stable',
      });
      const privateAuthJson = '{"tokens":{"access_token":"host-secret"},"accountId":"acct-1"}';
      vi.mocked(unsealCredentialGrant).mockReturnValue({
        v: 1,
        kind: 'remote-codex-host-auth',
        env: {},
        codexAuthJson: privateAuthJson,
      });
      let pulls = 0;
      claimWith(job, (operation) => {
        if (operation === 'credential.pull') {
          pulls += 1;
          return {
            grants:
              pulls >= 3
                ? [
                    {
                      jobId: job.id,
                      attemptId: `att-${job.id}`,
                      fence: 1,
                      targetEnrollmentId: 'enr-1',
                      expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    },
                  ]
                : [],
          };
        }
        return {};
      });

      await handleJobAvailable(job.id);

      expect(pulls).toBeGreaterThanOrEqual(3);
      expect(probeMock).toHaveBeenCalledTimes(1);
      expect(runTurnMock.mock.calls[0]?.[0]).toMatchObject({
        authMode: 'codex-host-auth',
        codexAuthJson: privateAuthJson,
        codexAuthHome: expect.stringMatching(/\/mesh-codex-auth\/[a-f0-9]{64}$/),
      });
      const authHome = runTurnMock.mock.calls[0]?.[0].codexAuthHome;
      expect(authHome).toBeDefined();
      expect(authHome?.startsWith(join(userDataDir, 'mesh-codex-auth'))).toBe(true);
      expect(existsSync(authHome!)).toBe(true);
      const row = db
        .prepare('SELECT journal_json FROM mesh_attempts WHERE id = ?')
        .get(`att-${job.id}`) as { journal_json: string };
      expect(row.journal_json).not.toContain('host-secret');
      expect(row.journal_json).not.toContain(privateAuthJson);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('does not let an API-key credential grant satisfy launch-host Codex auth', async () => {
    const { workspaceId, portableId, repoDir, head } = seedSessionWorkspace(
      'codex-host-auth-wrong-kind',
    );
    try {
      const job = makeSessionJob('job-codex-host-auth-wrong-kind', workspaceId, portableId, head, {
        authMode: 'codex-host-auth',
        authSessionId: 'remote-session-wrong-kind',
      });
      vi.mocked(unsealCredentialGrant).mockReturnValue({
        v: 1,
        kind: 'remote-codex-api-key',
        env: { OPENAI_API_KEY: 'api-key-secret' },
      });
      claimWith(
        job,
        (operation) => {
          if (operation === 'credential.pull') {
            return {
              grants: [
                {
                  jobId: job.id,
                  attemptId: `att-${job.id}`,
                  fence: 1,
                  targetEnrollmentId: 'enr-1',
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                },
              ],
            };
          }
          return {};
        },
        { leaseExpiresAt: new Date(Date.now() + 100).toISOString() },
      );

      await handleJobAvailable(job.id);

      expect(probeMock).not.toHaveBeenCalled();
      expect(runTurnMock).not.toHaveBeenCalled();
      const row = db
        .prepare('SELECT state, journal_json FROM mesh_attempts WHERE id = ?')
        .get(`att-${job.id}`) as { state: string; journal_json: string };
      expect(row.state).toBe('failed');
      expect(row.journal_json).toContain('provider-codex-host-auth-grant-not-delivered');
      expect(row.journal_json).not.toContain('api-key-secret');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it.each(['attempt-id', 'expired'] as const)(
    'rejects Codex host-auth grants with an invalid %s before unsealing',
    async (invalidBinding) => {
      const { workspaceId, portableId, repoDir, head } = seedSessionWorkspace(
        `codex-host-auth-${invalidBinding}`,
      );
      try {
        const job = makeSessionJob(
          `job-codex-host-auth-${invalidBinding}`,
          workspaceId,
          portableId,
          head,
          { authMode: 'codex-host-auth', authSessionId: `session-${invalidBinding}` },
        );
        const opened = vi.mocked(unsealCredentialGrant);
        opened.mockClear().mockReturnValue({
          v: 1,
          kind: 'remote-codex-host-auth',
          env: {},
          codexAuthJson: '{"tokens":{}}',
        });
        claimWith(
          job,
          (operation) => {
            if (operation !== 'credential.pull') return {};
            return {
              grants: [
                {
                  jobId: job.id,
                  attemptId: invalidBinding === 'attempt-id' ? `other-${job.id}` : `att-${job.id}`,
                  fence: 1,
                  targetEnrollmentId: 'enr-1',
                  expiresAt:
                    invalidBinding === 'expired'
                      ? new Date(Date.now() - 1_000).toISOString()
                      : new Date(Date.now() + 60_000).toISOString(),
                },
              ],
            };
          },
          { leaseExpiresAt: new Date(Date.now() + 100).toISOString() },
        );

        await handleJobAvailable(job.id);

        expect(opened).not.toHaveBeenCalled();
        expect(probeMock).not.toHaveBeenCalled();
        expect(runTurnMock).not.toHaveBeenCalled();
        const row = db
          .prepare('SELECT state, journal_json FROM mesh_attempts WHERE id = ?')
          .get(`att-${job.id}`) as { state: string; journal_json: string };
        expect(row.state).toBe('failed');
        expect(row.journal_json).toContain('binding-or-expiry-mismatch');
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    },
  );

  it('fails before provider probing when a launch-host Codex auth grant is missing', async () => {
    const { workspaceId, portableId, repoDir, head } =
      seedSessionWorkspace('codex-host-auth-missing');
    try {
      const job = makeSessionJob('job-codex-host-auth-missing', workspaceId, portableId, head, {
        authMode: 'codex-host-auth',
        authSessionId: 'remote-session-missing',
      });
      vi.mocked(unsealCredentialGrant).mockReturnValue({
        v: 1,
        kind: 'remote-codex-host-auth',
        env: {},
        codexAuthJson: '{"tokens":{}}',
      });
      let pulls = 0;
      claimWith(
        job,
        (operation) => {
          if (operation === 'credential.pull') {
            pulls += 1;
            return { grants: [] };
          }
          return {};
        },
        { leaseExpiresAt: new Date(Date.now() + 100).toISOString() },
      );

      await handleJobAvailable(job.id);

      expect(pulls).toBeGreaterThanOrEqual(2);
      expect(probeMock).not.toHaveBeenCalled();
      expect(runTurnMock).not.toHaveBeenCalled();
      const row = db
        .prepare('SELECT state, journal_json FROM mesh_attempts WHERE id = ?')
        .get(`att-${job.id}`) as { state: string; journal_json: string };
      expect(row.state).toBe('failed');
      expect(row.journal_json).toContain('provider-codex-host-auth-grant-not-delivered');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('reuses the same Codex auth home across native follow-up attempts', async () => {
    const { workspaceId, portableId, repoDir, head } = seedSessionWorkspace(
      'codex-host-auth-followup',
    );
    const userDataDir = mkdtempSync(join(tmpdir(), 'anvil-codex-auth-followup-'));
    try {
      configureMeshWorkerContext(() => ({ ...CTX, userDataDir }));
      const stableSessionId = 'remote-followup-session';
      const authJson = '{"tokens":{"access_token":"session-secret"},"accountId":"acct-1"}';
      vi.mocked(unsealCredentialGrant).mockReturnValue({
        v: 1,
        kind: 'remote-codex-host-auth',
        env: {},
        codexAuthJson: authJson,
      });
      const firstJob = makeSessionJob(
        'job-codex-host-auth-followup-a',
        workspaceId,
        portableId,
        head,
        {
          authMode: 'codex-host-auth',
          authSessionId: stableSessionId,
        },
      );
      claimWith(firstJob, (operation) =>
        operation === 'credential.pull'
          ? {
              grants: [
                {
                  jobId: firstJob.id,
                  attemptId: `att-${firstJob.id}`,
                  fence: 1,
                  targetEnrollmentId: 'enr-1',
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                },
              ],
            }
          : {},
      );
      await handleJobAvailable(firstJob.id);
      const firstHome = runTurnMock.mock.calls[0]?.[0].codexAuthHome;

      const secondJob = makeSessionJob(
        'job-codex-host-auth-followup-b',
        workspaceId,
        portableId,
        head,
        {
          authMode: 'codex-host-auth',
          authSessionId: stableSessionId,
          resumeThreadId: 'thr-mock',
        },
      );
      claimWith(secondJob, (operation) =>
        operation === 'credential.pull'
          ? {
              grants: [
                {
                  jobId: secondJob.id,
                  attemptId: `att-${secondJob.id}`,
                  fence: 1,
                  targetEnrollmentId: 'enr-1',
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                },
              ],
            }
          : {},
      );
      await handleJobAvailable(secondJob.id);
      const secondSpec = runTurnMock.mock.calls[1]?.[0];

      expect(firstHome).toBeDefined();
      expect(secondSpec?.codexAuthHome).toBe(firstHome);
      expect(secondSpec?.resumeThreadId).toBe('thr-mock');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('refuses a second spawn when a prior attempt journaled spawn without a thread', async () => {
    const { workspaceId, portableId, repoDir, head } = seedSessionWorkspace('orphan');
    try {
      insertPriorAttempt('job-sess', [{ event: 'provider-spawn', detail: {} }]);
      const job = makeSessionJob('job-sess', workspaceId, portableId, head);
      claimWith(job);
      await handleJobAvailable('job-sess');

      expect(runTurnMock).not.toHaveBeenCalled();
      const row = db
        .prepare('SELECT state, journal_json FROM mesh_attempts WHERE id = ?')
        .get('att-job-sess') as { state: string; journal_json: string };
      expect(row.state).toBe('failed');
      expect(row.journal_json).toContain('prior-spawn-unresolved');
      const report = rpcCalls.find((c) => c.operation === 'attempt.report');
      expect((report!.params as { outcome: string }).outcome).toBe('failed');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('resumes the provider thread recorded by a prior attempt', async () => {
    const { workspaceId, portableId, repoDir, head } = seedSessionWorkspace('resume');
    try {
      insertPriorAttempt('job-sess', [
        { event: 'provider-spawn', detail: {} },
        { event: 'provider-thread', detail: { threadId: 'thr-9' } },
      ]);
      const job = makeSessionJob('job-sess', workspaceId, portableId, head);
      claimWith(job);
      await handleJobAvailable('job-sess');

      const spec = runTurnMock.mock.calls[0]?.[0];
      expect(spec?.resumeThreadId).toBe('thr-9');
      const row = db
        .prepare('SELECT state FROM mesh_attempts WHERE id = ?')
        .get('att-job-sess') as { state: string };
      expect(row.state).toBe('completed');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('fails closed when the installed CLI is below the pinned minimum', async () => {
    const { workspaceId, portableId, repoDir, head } = seedSessionWorkspace('clipin');
    try {
      const job = makeSessionJob('job-sess', workspaceId, portableId, head, {
        cliMinVersion: '99.0.0',
      });
      claimWith(job);
      await handleJobAvailable('job-sess');

      expect(runTurnMock).not.toHaveBeenCalled();
      const row = db
        .prepare('SELECT state, journal_json FROM mesh_attempts WHERE id = ?')
        .get('att-job-sess') as { state: string; journal_json: string };
      expect(row.state).toBe('failed');
      expect(row.journal_json).toContain('cli-version-pin-violation');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('fails workspace-not-prepared when an unmapped repo has no managed checkout', async () => {
    const { workspaceId, portableId, repoDir, head } = seedSessionWorkspace('unmapped', false);
    try {
      const job = makeSessionJob('job-sess', workspaceId, portableId, head);
      claimWith(job);
      await handleJobAvailable('job-sess');

      expect(runTurnMock).not.toHaveBeenCalled();
      const row = db
        .prepare('SELECT state, journal_json FROM mesh_attempts WHERE id = ?')
        .get('att-job-sess') as { state: string; journal_json: string };
      expect(row.state).toBe('failed');
      expect(row.journal_json).toContain('workspace-not-prepared');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('activates a transferred handoff and records local ownership', async () => {
    const { workspaceId, portableId, repoDir, head } = seedSessionWorkspace('ho');
    const extraRepos: Array<{ portableId: string; repoDir: string; head: string }> = [];
    try {
      for (const suffix of ['ho-extra-a', 'ho-extra-b']) {
        const extraDir = mkdtempSync(join(tmpdir(), `anvil-mesh-sess-${suffix}-`));
        execFileSync('git', ['init'], { cwd: extraDir });
        execFileSync(
          'git',
          ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'],
          { cwd: extraDir },
        );
        const extraHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: extraDir })
          .toString()
          .trim();
        const extraPortableId = `p-${suffix}`;
        db.prepare(
          `INSERT INTO repos (id, name, path, status, created_at, updated_at)
           VALUES (?, 'repo', ?, 'connected', datetime('now'), datetime('now'))`,
        ).run(`repo-${suffix}`, extraDir);
        db.prepare(
          `INSERT INTO workspace_repo_definitions
           (workspace_id, portable_id, name, mapped_repo_id, created_at, updated_at)
           VALUES (?, ?, 'repo', ?, datetime('now'), datetime('now'))`,
        ).run(workspaceId, extraPortableId, `repo-${suffix}`);
        extraRepos.push({ portableId: extraPortableId, repoDir: extraDir, head: extraHead });
      }
      const job = makeSessionJob('job-sess', workspaceId, portableId, head, {
        handoffId: 'ho-1',
        handoffCheckpoint: {
          sessionId: 'sess-logical',
          schemaVersion: 1,
          sourceGeneration: 1,
          // Source session pin order differs from the workspace manifest,
          // and the source only used a subset of the workspace repositories.
          repositories: [
            { repositoryId: extraRepos[0]!.portableId, commit: extraRepos[0]!.head },
            { repositoryId: portableId, commit: head },
          ],
          provider: 'codex',
          model: 'gpt-5',
          summary: 'private cloud checkpoint',
          artifactRefs: [],
          unresolvedApprovals: [],
        },
      });
      job.inputManifest.repositories = [
        { repositoryId: portableId, commit: head },
        ...extraRepos.map(({ portableId: repositoryId, head: commit }) => ({
          repositoryId,
          commit,
        })),
      ];
      const handoff: Record<string, unknown> = {
        id: 'ho-1',
        sessionId: 'sess-logical',
        state: 'ownership-transferred',
        sourceEnrollmentId: 'enr-source',
        targetEnrollmentId: 'enr-1',
        sourceGeneration: 1,
        targetGeneration: 2,
        // Cloud ephemeral workers do not receive the account data key.
        // The checkpoint must come from the task-key sealed private inputs.
        checkpoint: null,
        cancelledFrom: null,
        cancelReason: null,
        createdAt: '',
        updatedAt: '',
      };
      rpcHandler = (op, rawParams) => {
        const params = rawParams as Record<string, unknown>;
        if (op === 'job.claim') {
          return { job, attempt: makeAttempt(job.id), fence: 1, manifest: job.inputManifest };
        }
        if (op === 'attempt.report') return { status: 'applied' };
        if (op === 'handoff.get') return { handoff };
        if (op === 'handoff.advance') {
          handoff['state'] = params['to'];
          return { handoff };
        }
        return {};
      };
      await handleJobAvailable('job-sess');

      // The executor advanced ownership-transferred → target-activating → completed.
      const advances = rpcCalls
        .filter((c) => c.operation === 'handoff.advance')
        .map((c) => (c.params as { to: string }).to);
      expect(advances).toEqual(['target-activating', 'completed']);

      // The continuation prompt carries the checkpoint summary.
      const spec = runTurnMock.mock.calls[0]?.[0];
      expect(spec?.prompt).toContain('private cloud checkpoint');
      expect(spec?.prompt).toContain('do the thing');

      // Local ownership mirror now shows this device owning generation 2.
      const ownership = db
        .prepare('SELECT generation, state FROM mesh_session_ownership WHERE session_id = ?')
        .get('sess-logical') as { generation: number; state: string };
      expect(ownership).toEqual({ generation: 2, state: 'owned' });

      const row = db
        .prepare('SELECT state, journal_json FROM mesh_attempts WHERE id = ?')
        .get('att-job-sess') as { state: string; journal_json: string };
      expect(row.state).toBe('completed');
      expect(row.journal_json).toContain('handoff-activating');
      expect(row.journal_json).toContain('handoff-completed');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      for (const extra of extraRepos) rmSync(extra.repoDir, { recursive: true, force: true });
    }
  });

  it('fails closed when the handoff has not transferred ownership', async () => {
    const { workspaceId, portableId, repoDir, head } = seedSessionWorkspace('ho-gate');
    try {
      const job = makeSessionJob('job-sess', workspaceId, portableId, head, {
        handoffId: 'ho-2',
      });
      rpcHandler = (op) => {
        if (op === 'job.claim') {
          return { job, attempt: makeAttempt(job.id), fence: 1, manifest: job.inputManifest };
        }
        if (op === 'attempt.report') return { status: 'applied' };
        if (op === 'handoff.get') {
          return {
            handoff: {
              id: 'ho-2',
              sessionId: 'sess-x',
              state: 'source-quiescing',
              sourceEnrollmentId: 'enr-source',
              targetEnrollmentId: 'enr-1',
              sourceGeneration: 1,
              targetGeneration: null,
              checkpoint: null,
              cancelledFrom: null,
              cancelReason: null,
              createdAt: '',
              updatedAt: '',
            },
          };
        }
        return {};
      };
      await handleJobAvailable('job-sess');

      expect(runTurnMock).not.toHaveBeenCalled();
      const row = db
        .prepare('SELECT state, journal_json FROM mesh_attempts WHERE id = ?')
        .get('att-job-sess') as { state: string; journal_json: string };
      expect(row.state).toBe('failed');
      expect(row.journal_json).toContain('handoff-not-transferred');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('keeps target ownership and allows a fresh checkpoint retry after activation fails', async () => {
    const { workspaceId, portableId, repoDir, head } = seedSessionWorkspace('ho-fail');
    try {
      let job = makeSessionJob('job-sess', workspaceId, portableId, head, {
        handoffId: 'ho-3',
      });
      let turn = 0;
      const handoff: Record<string, unknown> = {
        id: 'ho-3',
        sessionId: 'sess-y',
        state: 'ownership-transferred',
        sourceEnrollmentId: 'enr-source',
        targetEnrollmentId: 'enr-1',
        sourceGeneration: 1,
        targetGeneration: 2,
        checkpoint: null,
        cancelledFrom: null,
        cancelReason: null,
        createdAt: '',
        updatedAt: '',
      };
      runTurnMock.mockImplementation(async (spec, hooks) => {
        turn += 1;
        hooks.onThreadStarted(turn === 1 ? 'thr-failed' : 'thr-retry');
        if (turn === 1) {
          writeFileSync(join(repoDir, 'partial-work.txt'), 'preserved for retry');
          execFileSync('git', ['add', 'partial-work.txt'], { cwd: repoDir });
          execFileSync(
            'git',
            ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'partial provider work'],
            { cwd: repoDir },
          );
        }
        return {
          providerThreadId: spec.resumeThreadId ?? (turn === 1 ? 'thr-failed' : 'thr-retry'),
          turnId: `turn-${turn}`,
          turnStatus: turn === 1 ? ('failed' as const) : ('completed' as const),
          cliVersion: '0.44.0',
          cancelled: false,
          assistantOutput: 'answer',
          resumeHandle: turn === 1 ? 'thr-failed' : 'thr-retry',
        };
      });
      rpcHandler = (op, rawParams) => {
        const params = rawParams as Record<string, unknown>;
        if (op === 'job.claim') {
          return { job, attempt: makeAttempt(job.id), fence: 1, manifest: job.inputManifest };
        }
        if (op === 'attempt.report') return { status: 'applied' };
        if (op === 'handoff.get') return { handoff };
        if (op === 'handoff.advance') {
          handoff['state'] = params['to'];
          return { handoff };
        }
        return {};
      };
      await handleJobAvailable('job-sess');

      const advances = rpcCalls
        .filter((c) => c.operation === 'handoff.advance')
        .map((c) => (c.params as { to: string }).to);
      expect(advances).toEqual(['target-activating']);
      const row = db
        .prepare('SELECT state FROM mesh_attempts WHERE id = ?')
        .get('att-job-sess') as { state: string };
      expect(row.state).toBe('failed');
      // The target ownership mirror is durable before provider startup.
      const ownership = db
        .prepare(
          'SELECT state, generation, owner_enrollment_id FROM mesh_session_ownership WHERE session_id = ?',
        )
        .get('sess-y') as { state: string; generation: number; owner_enrollment_id: string };
      expect(ownership).toEqual({ state: 'owned', generation: 2, owner_enrollment_id: 'enr-1' });

      const partialHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })
        .toString()
        .trim();
      expect(partialHead).not.toBe(head);
      job = makeSessionJob('job-sess-retry', workspaceId, portableId, head, {
        handoffId: 'ho-3',
      });
      rpcHandler = (op, rawParams) => {
        const params = rawParams as Record<string, unknown>;
        if (op === 'job.claim') {
          return { job, attempt: makeAttempt(job.id), fence: 1, manifest: job.inputManifest };
        }
        if (op === 'attempt.report') return { status: 'applied' };
        if (op === 'handoff.get') return { handoff };
        if (op === 'handoff.advance') {
          handoff['state'] = params['to'];
          return { handoff };
        }
        return {};
      };
      await handleJobAvailable(job.id);
      expect(runTurnMock).toHaveBeenCalledTimes(2);
      expect(runTurnMock.mock.calls[1]?.[0]).toMatchObject({ cwd: repoDir });
      expect(runTurnMock.mock.calls[1]?.[0].resumeThreadId).toBeUndefined();
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim()).toBe(
        partialHead,
      );
      expect(readFileSync(join(repoDir, 'partial-work.txt'), 'utf8')).toBe('preserved for retry');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('pins commits, provider, model, and inputs in the created job manifest', async () => {
    const { workspaceId, portableId, repoDir, head } = seedSessionWorkspace('create');
    try {
      rpcHandler = (op) =>
        op === 'job.create' ? { job: { id: 'job-s', kind: 'start-session' } } : {};
      const job = await createStartSessionJob({
        requestId: 'req-s',
        workspaceId,
        prompt: 'review the diff',
        targetEnrollmentId: 'enr-9',
        provider: 'codex',
        model: 'gpt-5',
        cliMinVersion: '0.40.0',
        turnTimeoutMs: 120_000,
      });
      expect(job.id).toBe('job-s');
      const create = rpcCalls.find((c) => c.operation === 'job.create');
      const params = create!.params as {
        kind: string;
        inputManifest: {
          workspaceDefinitionRevision: string;
          repositories: Array<{ repositoryId: string; commit: string }>;
          provider: string;
          model: string;
          inputs: Record<string, unknown>;
        };
      };
      expect(params.kind).toBe('start-session');
      expect(params.inputManifest.workspaceDefinitionRevision).toBe(
        workspaceDefinitionRevision(workspaceId),
      );
      expect(params.inputManifest.repositories).toEqual([
        { repositoryId: portableId, commit: head },
      ]);
      expect(params.inputManifest.provider).toBe('codex');
      expect(params.inputManifest.model).toBe('gpt-5');
      // Disclosure: the public manifest carries only allowlisted routing
      // keys — the prompt and execution context seal under the job TCK.
      expect(Object.keys(params.inputManifest.inputs)).toEqual(['workspaceId']);
      const sealed = (params as { sealedInputs?: { enc: string; nonce: string; ct: string } })
        .sealedInputs;
      expect(sealed?.enc).toBe('aes-256-gcm');
      const taskKey = taskKeyFor(SCOPE, 'req:req-s');
      expect(taskKey).not.toBeNull();
      const opened = unsealTaskInputs(SCOPE, 'req-s', taskKey!, sealed);
      expect(opened['cliMinVersion']).toBe('0.40.0');
      expect(opened['turnTimeoutMs']).toBe(120_000);
      expect(opened['prompt']).toBe('review the diff');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('code-task executor (FLOW-01)', () => {
  let userDataDir = '';

  function seedTaskWorkspace(suffix: string): {
    workspaceId: string;
    portableId: string;
    repoDir: string;
    head: string;
  } {
    const repoDir = mkdtempSync(join(tmpdir(), `anvil-mesh-task-${suffix}-`));
    execFileSync('git', ['init'], { cwd: repoDir });
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'],
      { cwd: repoDir },
    );
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim();
    const workspaceId = `w-task-${suffix}`;
    const portableId = `p-${suffix}`;
    db.prepare(
      `INSERT INTO repos (id, name, path, status, created_at, updated_at)
       VALUES (?, 'repo', ?, 'connected', datetime('now'), datetime('now'))`,
    ).run(`repo-task-${suffix}`, repoDir);
    db.prepare(
      `INSERT INTO workspaces (id, name, created_at, updated_at)
       VALUES (?, 'W', datetime('now'), datetime('now'))`,
    ).run(workspaceId);
    db.prepare(
      `INSERT INTO workspace_repo_definitions
       (workspace_id, portable_id, name, mapped_repo_id, created_at, updated_at)
       VALUES (?, ?, 'repo', ?, datetime('now'), datetime('now'))`,
    ).run(workspaceId, portableId, `repo-task-${suffix}`);
    return { workspaceId, portableId, repoDir, head };
  }

  function makeCodeTaskJob(
    id: string,
    workspaceId: string,
    portableId: string,
    commit: string,
    inputs: Record<string, unknown> = {},
  ): MeshJob {
    const job = makeJob(id, 'code-task');
    job.inputManifest = {
      workspaceDefinitionRevision: workspaceDefinitionRevision(workspaceId)!,
      repositories: [{ repositoryId: portableId, commit }],
      bootstrapDigest: 'none',
      provider: 'codex',
      model: 'gpt-5',
      configVersions: {},
      inputs: { workspaceId, prompt: 'implement the thing', ...inputs },
    };
    return job;
  }

  function claimWith(job: MeshJob): void {
    rpcHandler = (op) => {
      if (op === 'job.claim') {
        return {
          job,
          attempt: makeAttempt(job.id),
          fence: 1,
          manifest: job.inputManifest,
        };
      }
      if (op === 'attempt.report') {
        return { status: 'applied' };
      }
      return {};
    };
  }

  beforeEach(async () => {
    db.exec('DELETE FROM mesh_session_ownership; DELETE FROM mesh_handoff_journal;');
    userDataDir = mkdtempSync(join(tmpdir(), 'anvil-mesh-udata-'));
    configureMeshWorkerContext(() => ({ ...CTX, userDataDir }));
    probeMock.mockReset().mockResolvedValue('0.44.0');
    runTurnMock.mockReset();
    runTurnMock.mockImplementation(async (_spec: RemoteSessionSpec, hooks: RemoteSessionHooks) => {
      hooks.onThreadStarted('thr-mock');
      return {
        providerThreadId: 'thr-mock',
        turnId: 'turn-1',
        turnStatus: 'completed' as const,
        cliVersion: '0.44.0',
        cancelled: false,
        assistantOutput: 'answer',
        resumeHandle: 'thr-mock',
      };
    });
    rpcHandler = (op) =>
      op === 'worker.connect'
        ? {
            workerIncarnation: 'inc-1',
            leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
          }
        : {};
    await setMeshWorkerEnabled(true);
    rpcCalls.length = 0;
  });

  it.each(['full-access', 'on-request'] as const)(
    'bootstraps ordinary and shell commands under %s authorization',
    async (permissionMode) => {
      const { workspaceId, portableId, repoDir, head } = seedTaskWorkspace(
        `bootstrap-${permissionMode}`,
      );
      const recipe = {
        schemaVersion: 1 as const,
        steps: [
          {
            id: 'argv',
            kind: 'command' as const,
            workingDirectory: '.',
            argv: ['sh', '-c', 'printf argv > bootstrap-argv'],
            timeoutMs: 5_000,
            envNames: [],
            retry: 'safe' as const,
          },
          {
            id: 'shell',
            kind: 'command' as const,
            workingDirectory: '.',
            shell: 'printf shell > bootstrap-shell',
            timeoutMs: 5_000,
            envNames: [],
            retry: 'safe' as const,
          },
        ],
      };
      try {
        await setMeshMaximumPermissionMode(permissionMode);
        setWorkspaceBootstrap(workspaceId, recipe);
        const job = makeCodeTaskJob('job-bootstrap', workspaceId, portableId, head, {
          permissionMode,
        });
        job.kind = 'prepare-workspace';
        job.inputManifest.bootstrapDigest = computeBootstrapDigest({
          recipe,
          repositoryCommits: { [portableId]: head },
          executionPolicy: bootstrapManifestPolicy(),
        });
        storeTaskKey(SCOPE, job.id, Buffer.alloc(32, 9));
        claimWith(job);
        const previous = rpcHandler;
        let request: { actionDigest: string; sealedDetails: unknown } | undefined;
        configureMeshWorkerContext(() => ({
          ...CTX,
          userDataDir,
          sendFrame: (frame) => {
            const activity = frame as {
              type: string;
              streamId: string;
              payload: { kind: string; text: string };
            };
            if (
              activity.type === 'activity' &&
              activity.streamId === 'control' &&
              activity.payload.kind === 'status'
            )
              request = JSON.parse(activity.payload.text);
          },
        }));
        rpcHandler = (operation, params) =>
          operation === 'approval.get' && request !== undefined
            ? {
                approvals: [
                  {
                    id: 'approved-bootstrap',
                    actionDigest: request.actionDigest,
                    state: 'approved',
                  },
                ],
              }
            : previous(operation, params);
        await handleJobAvailable(job.id);
        expect(
          db.prepare('SELECT state FROM mesh_attempts WHERE id = ?').get('att-job-bootstrap'),
        ).toEqual({ state: 'completed' });
        expect(existsSync(join(repoDir, 'bootstrap-argv'))).toBe(true);
        expect(existsSync(join(repoDir, 'bootstrap-shell'))).toBe(true);
        if (permissionMode === 'on-request') {
          expect(request).toBeDefined();
          expect(JSON.stringify(request)).not.toContain('printf');
          expect(
            unsealTaskResult(
              SCOPE,
              job.id,
              'att-job-bootstrap',
              Buffer.alloc(32, 9),
              request!.sealedDetails,
            ),
          ).toMatchObject({
            actionDigest: request!.actionDigest,
            details: expect.stringContaining('printf shell'),
          });
        } else expect(request).toBeUndefined();
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    },
  );

  it('publishes cancellation before reporting a provider stopped by a ceiling downgrade', async () => {
    const { workspaceId, portableId, repoDir, head } = seedTaskWorkspace('ceiling-stop');
    try {
      await setMeshMaximumPermissionMode('full-access');
      const job = makeCodeTaskJob('job-stop', workspaceId, portableId, head, {
        permissionMode: 'full-access',
      });
      claimWith(job);
      runTurnMock.mockImplementation(async () => {
        await setMeshMaximumPermissionMode('read-only');
        return {
          providerThreadId: 'thread-stop',
          turnId: null,
          turnStatus: 'interrupted',
          cliVersion: '0.44.0',
          cancelled: true,
          assistantOutput: '',
          resumeHandle: null,
        };
      });
      await handleJobAvailable(job.id);
      const cancellation = rpcCalls.findIndex((call) => call.operation === 'job.cancel');
      const report = rpcCalls.findIndex((call) => call.operation === 'attempt.report');
      expect(cancellation).toBeGreaterThanOrEqual(0);
      expect(report).toBeGreaterThan(cancellation);
      expect(
        db.prepare('SELECT state FROM mesh_attempts WHERE id = ?').get('att-job-stop'),
      ).toEqual({ state: 'cancelled' });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('runs the turn in a per-attempt worktree and publishes a result manifest', async () => {
    const { workspaceId, portableId, repoDir, head } = seedTaskWorkspace('happy');
    try {
      const job = makeCodeTaskJob('job-task', workspaceId, portableId, head);
      // The "provider" edits the attempt worktree — executor must commit it.
      runTurnMock.mockImplementation(async (spec: RemoteSessionSpec, hooks: RemoteSessionHooks) => {
        hooks.onThreadStarted('thr-mock');
        writeFileSync(join(spec.cwd, 'feature.ts'), 'export const task = 1;');
        return {
          providerThreadId: 'thr-mock',
          turnId: 'turn-1',
          turnStatus: 'completed' as const,
          cliVersion: '0.44.0',
          cancelled: false,
          assistantOutput: 'answer',
          resumeHandle: 'thr-mock',
        };
      });
      claimWith(job);
      await handleJobAvailable('job-task');

      const row = db
        .prepare('SELECT state, journal_json, result_json FROM mesh_attempts WHERE id = ?')
        .get('att-job-task') as {
        state: string;
        journal_json: string;
        result_json: string;
      };
      expect(row.state).toBe('completed');
      expect(row.journal_json).toContain('worktree-allocated');
      expect(row.journal_json).toContain('result-commit');
      expect(row.journal_json).toContain('result-manifest');

      const result = JSON.parse(row.result_json) as {
        resultManifest: {
          repositories: Array<{
            repositoryId: string;
            baseCommit: string;
            resultCommit: string;
            branch: string;
            changed: boolean;
          }>;
          provenance: { workerEnrollmentId: string };
        };
        worktrees: Array<{ worktreePath: string }>;
      };
      const repoResult = result.resultManifest.repositories[0]!;
      expect(repoResult.repositoryId).toBe(portableId);
      expect(repoResult.baseCommit).toBe(head);
      expect(repoResult.changed).toBe(true);
      expect(repoResult.branch).toBe('mesh/attempt/att-job-task');
      expect(result.resultManifest.provenance.workerEnrollmentId).toBe('enr-1');

      // The turn ran inside the attempt worktree, NOT the source checkout —
      // and the residue commit is inspectable on the source repo's refs.
      const spec = runTurnMock.mock.calls[0]?.[0];
      expect(spec?.cwd).toBe(
        join(userDataDir, 'mesh-worktrees', 'att-job-task', `0-${portableId}`),
      );
      expect(
        execFileSync('git', ['show', `${repoResult.resultCommit}:feature.ts`], {
          cwd: repoDir,
        }).toString(),
      ).toContain('export const task = 1');
      // Source checkout HEAD + tree untouched.
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim()).toBe(
        head,
      );
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoDir }).toString()).toBe('');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('records declared verification outcomes in full access without a desktop approval', async () => {
    await setMeshMaximumPermissionMode('full-access');
    const { workspaceId, portableId, repoDir, head } = seedTaskWorkspace('verify');
    try {
      const job = makeCodeTaskJob('job-task', workspaceId, portableId, head, {
        verification: ['exit 0', 'exit 2'],
        permissionMode: 'full-access',
      });
      claimWith(job);
      await handleJobAvailable('job-task');

      const row = db
        .prepare('SELECT result_json, journal_json FROM mesh_attempts WHERE id = ?')
        .get('att-job-task') as { result_json: string; journal_json: string };
      const result = JSON.parse(row.result_json) as {
        resultManifest: {
          verification: Array<{ command: string; exitCode: number | null; timedOut: boolean }>;
        };
      };
      expect(meshVerificationDialog.showMessageBox).not.toHaveBeenCalled();
      expect(result.resultManifest.verification).toMatchObject([
        { repositoryId: portableId, command: 'exit 0', exitCode: 0, timedOut: false },
        { repositoryId: portableId, command: 'exit 2', exitCode: 2, timedOut: false },
      ]);
      expect(row.journal_json).toContain('"verification"');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('preserves the attempt worktrees when the turn fails', async () => {
    const { workspaceId, portableId, repoDir, head } = seedTaskWorkspace('fail');
    try {
      const job = makeCodeTaskJob('job-task', workspaceId, portableId, head);
      runTurnMock.mockImplementation(async () => ({
        providerThreadId: 'thr-mock',
        turnId: 'turn-1',
        turnStatus: 'failed' as const,
        cliVersion: '0.44.0',
        cancelled: false,
        assistantOutput: 'answer',
        resumeHandle: 'thr-mock',
      }));
      claimWith(job);
      await handleJobAvailable('job-task');

      const row = db
        .prepare('SELECT state, journal_json FROM mesh_attempts WHERE id = ?')
        .get('att-job-task') as { state: string; journal_json: string };
      expect(row.state).toBe('failed');
      expect(row.journal_json).toContain('worktrees-preserved');
      // The tree + branch survive as inspectable evidence.
      const wtPath = join(userDataDir, 'mesh-worktrees', 'att-job-task', `0-${portableId}`);
      expect(existsSync(wtPath)).toBe(true);
      expect(
        execFileSync('git', ['branch', '--list', 'mesh/attempt/*'], { cwd: repoDir }).toString(),
      ).toContain('mesh/attempt/att-job-task');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('publishes bundle artifacts for a workflow-node dispatch', async () => {
    const { workspaceId, portableId, repoDir, head } = seedTaskWorkspace('node');
    try {
      const job = makeCodeTaskJob('job-node', workspaceId, portableId, head, {
        resultTransfer: 'bundle-artifacts',
        dispatchId: 'disp-1',
      });
      job.kind = 'workflow-node';
      // A node that produced output has commits to transfer.
      runTurnMock.mockImplementation(async (spec: RemoteSessionSpec, hooks: RemoteSessionHooks) => {
        hooks.onThreadStarted('thr-mock');
        writeFileSync(join(spec.cwd, 'node-out.ts'), 'export const n = 1;');
        return {
          providerThreadId: 'thr-mock',
          turnId: 'turn-1',
          turnStatus: 'completed' as const,
          cliVersion: '0.44.0',
          cancelled: false,
          assistantOutput: 'answer',
          resumeHandle: 'thr-mock',
        };
      });
      claimWith(job);
      await handleJobAvailable('job-node');

      const row = db
        .prepare('SELECT state, journal_json, result_json FROM mesh_attempts WHERE id = ?')
        .get('att-job-node') as {
        state: string;
        journal_json: string;
        result_json: string;
      };
      expect(row.state).toBe('completed');
      expect(row.journal_json).toContain('result-bundle-published');
      const result = JSON.parse(row.result_json) as {
        resultManifest: { artifacts: Array<{ artifactId: string; label: string }> };
      };
      expect(result.resultManifest.artifacts).toEqual([
        { artifactId: 'art-test', label: `bundle:${portableId}` },
      ]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('rejects a non-local ref policy — remote refs need explicit policy', async () => {
    const { workspaceId, portableId, repoDir, head } = seedTaskWorkspace('policy');
    try {
      const job = makeCodeTaskJob('job-task', workspaceId, portableId, head, {
        refPolicy: 'push-to-origin',
      });
      claimWith(job);
      await handleJobAvailable('job-task');
      const row = db
        .prepare('SELECT state, journal_json FROM mesh_attempts WHERE id = ?')
        .get('att-job-task') as { state: string; journal_json: string };
      expect(row.state).toBe('failed');
      expect(row.journal_json).toContain('ref-policy-unsupported');
      expect(runTurnMock).not.toHaveBeenCalled();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('pins commits, verification, and local-branches policy in the job manifest', async () => {
    const { workspaceId, portableId, repoDir, head } = seedTaskWorkspace('create');
    try {
      rpcHandler = (op) => (op === 'job.create' ? { job: { id: 'job-c', kind: 'code-task' } } : {});
      const job = await createCodeTaskJob({
        requestId: 'req-c',
        workspaceId,
        prompt: 'implement the thing',
        targetEnrollmentId: 'enr-9',
        verification: ['pnpm test'],
      });
      expect(job.id).toBe('job-c');
      const create = rpcCalls.find((c) => c.operation === 'job.create');
      const params = create!.params as {
        kind: string;
        inputManifest: {
          repositories: Array<{ repositoryId: string; commit: string }>;
          inputs: Record<string, unknown>;
        };
        retryPolicy: string;
      };
      expect(params.kind).toBe('code-task');
      expect(params.inputManifest.repositories).toEqual([
        { repositoryId: portableId, commit: head },
      ]);
      // Verification commands and ref policy are sensitive execution
      // context — they ride the sealed envelope, not the public manifest.
      expect(Object.keys(params.inputManifest.inputs)).toEqual(['workspaceId']);
      const sealed = (params as { sealedInputs?: { enc: string; nonce: string; ct: string } })
        .sealedInputs;
      expect(sealed?.enc).toBe('aes-256-gcm');
      const taskKey = taskKeyFor(SCOPE, 'req:req-c');
      expect(taskKey).not.toBeNull();
      const opened = unsealTaskInputs(SCOPE, 'req-c', taskKey!, sealed);
      expect(opened['verification']).toEqual(['pnpm test']);
      expect(opened['refPolicy']).toBe('local-branches');
      expect(opened['prompt']).toBe('implement the thing');
      expect(params.retryPolicy).toBe('inspect-before-retry');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
