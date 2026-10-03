import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);

vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
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
vi.mock('../settings.service.js', () => ({
  getSettings: () => ({ openaiApiKey: undefined, openaiModel: 'gpt-5' }),
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
      return { result: rpcHandler(operation, params), serverTime: '' };
    },
  };
});

const downloadMock = vi.fn(async (_id: string): Promise<Uint8Array> => new Uint8Array());
vi.mock('../mesh-artifact.service.js', () => ({
  downloadMeshArtifact: (id: string) => downloadMock(id),
}));

import {
  cancelNodeDispatch,
  configureMeshDispatchContext,
  dispatchWorkflowNode,
  reconcileDispatchesOnBoot,
  refreshDispatch,
  resetMeshDispatchForTests,
} from '../mesh-dispatch.service';
import { configureMeshWorkerContext, resetMeshWorkerForTests } from '../mesh-worker.service';
import type { SyncScope } from '../../../shared/sync-mesh';
import { mintTaskKey, sealTaskResult, storeTaskKey } from '../sync-keyring.service';

const SCOPE: SyncScope = { backendId: 'backend-1', accountId: 'account-1', datasetEpoch: '1' };
const CTX = { apiUrl: 'https://backend.test/v1', accessToken: 'tok', enrollmentId: 'enr-1' };
// The worker context carries the sync scope — sealed job inputs mint a
// TCK under it and the dispatch stores the sealed request for replay.
const WORKER_CTX = { ...CTX, scope: SCOPE };

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString().trim();
}

/**
 * Seeds a parent checkout + workspace fixture. `parentRepo` is a clone of
 * the source repo taken BEFORE the worker produced its result commits —
 * exactly the precondition a thin bundle transfer relies on.
 */
function seedDispatchFixture(suffix: string): {
  workspaceId: string;
  portableId: string;
  parentRepo: string;
  sourceRepo: string;
  base: string;
} {
  const sourceRepo = mkdtempSync(join(tmpdir(), `anvil-disp-src-${suffix}-`));
  git(sourceRepo, 'init');
  git(
    sourceRepo,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '--allow-empty',
    '-m',
    'base',
  );
  const base = git(sourceRepo, 'rev-parse', 'HEAD');
  const parentRepo = mkdtempSync(join(tmpdir(), `anvil-disp-par-${suffix}-`));
  execFileSync('git', ['clone', sourceRepo, parentRepo]);

  const workspaceId = `w-${suffix}`;
  const portableId = `p-${suffix}`;
  db.prepare(
    `INSERT INTO repos (id, name, path, status, created_at, updated_at)
     VALUES (?, 'repo', ?, 'connected', datetime('now'), datetime('now'))`,
  ).run(`repo-${suffix}`, parentRepo);
  db.prepare(
    `INSERT INTO workspaces (id, name, created_at, updated_at)
     VALUES (?, 'W', datetime('now'), datetime('now'))`,
  ).run(workspaceId);
  db.prepare(
    `INSERT INTO workspace_repo_definitions
     (workspace_id, portable_id, name, mapped_repo_id, created_at, updated_at)
     VALUES (?, ?, 'repo', ?, datetime('now'), datetime('now'))`,
  ).run(workspaceId, portableId, `repo-${suffix}`);
  return { workspaceId, portableId, parentRepo, sourceRepo, base };
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

beforeEach(() => {
  db.exec('DELETE FROM mesh_node_dispatches;');
  db.exec('DELETE FROM workspace_repo_definitions; DELETE FROM workspaces; DELETE FROM repos;');
  rpcCalls.length = 0;
  rpcHandler = () => ({});
  downloadMock.mockReset();
  db.exec('DELETE FROM mesh_task_keys;');
  resetMeshDispatchForTests();
  resetMeshWorkerForTests();
  configureMeshDispatchContext(() => CTX);
  // The job creators live in the worker module and use its context — in
  // production both resolve to the same session.
  configureMeshWorkerContext(() => WORKER_CTX);
});

describe('dispatchWorkflowNode', () => {
  it('persists the dispatch and creates the job with a stable requestId', async () => {
    const { workspaceId, portableId, parentRepo, sourceRepo, base } = seedDispatchFixture('create');
    try {
      rpcHandler = (op, params) =>
        op === 'job.create'
          ? {
              job: {
                id: 'job-1',
                state: 'queued',
                inputManifest: (params as { inputManifest: unknown }).inputManifest,
              },
            }
          : {};
      const dispatch = await dispatchWorkflowNode({
        dispatchId: 'disp-1',
        runId: 'run-1',
        nodeId: 'node-1',
        workspaceId,
        prompt: 'do node work',
        targetEnrollmentId: 'enr-2',
      });
      expect(dispatch.jobId).toBe('job-1');
      expect(dispatch.state).toBe('queued');
      const create = rpcCalls.find((c) => c.operation === 'job.create');
      expect((create!.params as { requestId: string }).requestId).toBe('node-dispatch/disp-1');
      expect(
        (create!.params as { inputManifest: { repositories: unknown[] } }).inputManifest
          .repositories,
      ).toEqual([{ repositoryId: portableId, commit: base }]);
      // Disclosure: the coordinator-visible manifest carries only
      // allowlisted routing keys — prompt/dispatch context rides the
      // opaque sealedInputs envelope instead.
      const inputs = (create!.params as { inputManifest: { inputs: Record<string, unknown> } })
        .inputManifest.inputs;
      expect(Object.keys(inputs)).toEqual(['workspaceId']);
      expect((create!.params as { sealedInputs?: { enc: string } }).sealedInputs?.enc).toBe(
        'aes-256-gcm',
      );
    } finally {
      cleanup(parentRepo, sourceRepo);
    }
  });

  it('forwards capability requirements to auto placement', async () => {
    const { workspaceId, parentRepo, sourceRepo } = seedDispatchFixture('reqs');
    try {
      rpcHandler = (op, params) =>
        op === 'job.create'
          ? {
              job: {
                id: 'job-1',
                state: 'queued',
                inputManifest: (params as { inputManifest: unknown }).inputManifest,
              },
            }
          : {};
      await dispatchWorkflowNode({
        dispatchId: 'disp-1',
        runId: 'run-1',
        nodeId: 'node-1',
        workspaceId,
        prompt: 'gpu work',
        requirements: { capabilities: ['gpu'], memoryMb: 65536 },
      });
      const create = rpcCalls.find((c) => c.operation === 'job.create');
      expect((create!.params as { requestedTarget: unknown }).requestedTarget).toEqual({
        kind: 'auto',
        requirements: { capabilities: ['gpu'], memoryMb: 65536 },
      });
    } finally {
      cleanup(parentRepo, sourceRepo);
    }
  });

  it('decrypts sealed attempt results before persisting the workflow handoff', async () => {
    const { workspaceId, parentRepo, sourceRepo } = seedDispatchFixture('sealed-result');
    try {
      rpcHandler = (op, params) => {
        if (op === 'job.create') {
          return {
            job: {
              id: 'job-1',
              state: 'queued',
              keyDelivery: 'delivered',
              inputManifest: (params as { inputManifest: unknown }).inputManifest,
            },
          };
        }
        if (op === 'job.get') {
          const key = taskKeyForTest;
          return {
            job: { id: 'job-1', state: 'completed', keyDelivery: 'delivered' },
            attempts: [
              {
                id: 'attempt-1',
                state: 'completed',
                sealedResult: sealTaskResult(SCOPE, 'job-1', 'attempt-1', key, {
                  providerThreadId: 'thread-1',
                  resultManifest: {
                    schemaVersion: 1,
                    jobId: 'job-1',
                    attemptId: 'attempt-1',
                    repositories: [],
                    verification: [
                      {
                        repositoryId: 'p-sealed-result',
                        command: 'pnpm test',
                        exitCode: 0,
                        timedOut: false,
                        durationMs: 12,
                      },
                    ],
                    artifacts: [],
                    provenance: {
                      workerEnrollmentId: 'enr-2',
                      workerIncarnation: 'inc-1',
                      cliVersion: null,
                      startedAt: '2026-09-19T00:00:00.000Z',
                      completedAt: '2026-09-19T00:00:01.000Z',
                    },
                  },
                }),
              },
            ],
          };
        }
        return {};
      };
      configureMeshDispatchContext(() => ({ ...CTX, scope: SCOPE }));
      const taskKeyForTest = mintTaskKey();
      storeTaskKey(SCOPE, 'job-1', taskKeyForTest);
      const created = await dispatchWorkflowNode({
        dispatchId: 'disp-sealed-result',
        runId: 'run-1',
        nodeId: 'node-1',
        workspaceId,
        prompt: 'do node work',
      });
      expect(created.state).toBe('queued');
      const refreshed = await refreshDispatch('disp-sealed-result');
      expect(refreshed.state).toBe('completed');
      expect(refreshed.output?.result?.providerThreadId).toBe('thread-1');
      expect(refreshed.output?.resultManifest.verification[0]?.exitCode).toBe(0);
    } finally {
      cleanup(parentRepo, sourceRepo);
    }
  });

  it('re-dispatch with the same id re-binds — no second job is created', async () => {
    const { workspaceId, parentRepo, sourceRepo } = seedDispatchFixture('idem');
    try {
      rpcHandler = (op, params) =>
        op === 'job.create'
          ? {
              job: {
                id: 'job-1',
                state: 'queued',
                inputManifest: (params as { inputManifest: unknown }).inputManifest,
              },
            }
          : {};
      const first = await dispatchWorkflowNode({
        dispatchId: 'disp-1',
        runId: 'run-1',
        nodeId: 'node-1',
        workspaceId,
        prompt: 'do node work',
      });
      const createsAfterFirst = rpcCalls.filter((c) => c.operation === 'job.create').length;
      const second = await dispatchWorkflowNode({
        dispatchId: 'disp-1',
        runId: 'run-1',
        nodeId: 'node-1',
        workspaceId,
        prompt: 'do node work',
      });
      expect(second.jobId).toBe(first.jobId);
      expect(rpcCalls.filter((c) => c.operation === 'job.create').length).toBe(createsAfterFirst);
    } finally {
      cleanup(parentRepo, sourceRepo);
    }
  });
});

describe('refreshDispatch result import', () => {
  it('fetches the worker bundle into the local repo as a result ref', async () => {
    const { workspaceId, portableId, parentRepo, sourceRepo, base } = seedDispatchFixture('import');
    try {
      // Worker side: a result commit on its attempt branch, thin-bundled
      // against the base the parent provably holds.
      const branch = 'mesh/attempt/att-1';
      git(sourceRepo, 'checkout', '-b', branch);
      writeFileSync(join(sourceRepo, 'out.ts'), 'export const done = true;');
      git(sourceRepo, 'add', 'out.ts');
      git(sourceRepo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'node result');
      const resultCommit = git(sourceRepo, 'rev-parse', 'HEAD');
      const bundlePath = join(tmpdir(), `anvil-disp-bundle-${Date.now()}.bundle`);
      git(sourceRepo, 'bundle', 'create', bundlePath, `${base}..${branch}`);
      downloadMock.mockImplementation(async () => new Uint8Array(readFileSync(bundlePath)));

      db.prepare(
        `INSERT INTO mesh_node_dispatches
         (dispatch_id, run_id, node_id, job_id, request_id, workspace_id,
          manifest_json, state, cancel_requested, output_json, created_at, updated_at)
         VALUES ('disp-1', 'run-1', 'node-1', 'job-1', 'node-dispatch/disp-1', ?, '{}', 'running', 0, NULL, datetime('now'), datetime('now'))`,
      ).run(workspaceId);
      rpcHandler = (op) =>
        op === 'job.get'
          ? {
              job: { id: 'job-1', state: 'completed' },
              attempts: [
                {
                  id: 'att-1',
                  jobId: 'job-1',
                  workerIncarnation: 'inc-1',
                  fence: 1,
                  leaseExpiresAt: '',
                  state: 'completed',
                  result: {
                    resultManifest: {
                      schemaVersion: 1,
                      jobId: 'job-1',
                      attemptId: 'att-1',
                      repositories: [
                        {
                          repositoryId: portableId,
                          baseCommit: base,
                          resultCommit,
                          branch,
                          changed: true,
                        },
                      ],
                      verification: [],
                      artifacts: [{ artifactId: 'art-bundle', label: `bundle:${portableId}` }],
                      provenance: {
                        workerEnrollmentId: 'enr-2',
                        workerIncarnation: 'inc-1',
                        cliVersion: '0.44.0',
                        startedAt: '',
                        completedAt: '',
                      },
                    },
                  },
                },
              ],
            }
          : {};

      const record = await refreshDispatch('disp-1');
      expect(record.state).toBe('completed');
      expect(record.output).not.toBeNull();
      const adopted = record.output!.adoptedRefs[0]!;
      expect(adopted.repositoryId).toBe(portableId);
      expect(adopted.commit).toBe(resultCommit);
      // The result commit landed in the parent's object store via the
      // bundle — inspectable as a ref without touching the working tree.
      expect(git(parentRepo, 'rev-parse', adopted.ref)).toBe(resultCommit);
      expect(git(parentRepo, 'status', '--porcelain')).toBe('');
    } finally {
      cleanup(parentRepo, sourceRepo);
    }
  });
});

describe('cancelNodeDispatch', () => {
  it('persists intent and propagates job.cancel', async () => {
    const { workspaceId, parentRepo, sourceRepo } = seedDispatchFixture('cancel');
    try {
      db.prepare(
        `INSERT INTO mesh_node_dispatches
         (dispatch_id, run_id, node_id, job_id, request_id, workspace_id,
          manifest_json, state, cancel_requested, output_json, created_at, updated_at)
         VALUES ('disp-1', 'run-1', 'node-1', 'job-1', 'r', ?, '{}', 'running', 0, NULL, datetime('now'), datetime('now'))`,
      ).run(workspaceId);
      rpcHandler = (op) =>
        op === 'job.cancel' ? { job: { id: 'job-1', state: 'cancel-requested' } } : {};
      const record = await cancelNodeDispatch('disp-1');
      expect(record.cancelRequested).toBe(true);
      expect(record.state).toBe('cancel-requested');
      expect(rpcCalls.some((c) => c.operation === 'job.cancel')).toBe(true);
    } finally {
      cleanup(parentRepo, sourceRepo);
    }
  });
});

describe('dispatch durability', () => {
  it('replays the persisted job.create after a crash between persist and submit', async () => {
    const { workspaceId, parentRepo, sourceRepo } = seedDispatchFixture('replay');
    try {
      // First submit dies mid-flight — the dispatch row (with the
      // byte-exact request) is already durable.
      rpcHandler = () => {
        throw new Error('connection lost');
      };
      await expect(
        dispatchWorkflowNode({
          dispatchId: 'disp-1',
          runId: 'run-1',
          nodeId: 'node-1',
          workspaceId,
          prompt: 'do node work',
          targetEnrollmentId: 'enr-2',
        }),
      ).rejects.toThrow('connection lost');
      const crashed = db
        .prepare(
          'SELECT job_id, state, request_json FROM mesh_node_dispatches WHERE dispatch_id = ?',
        )
        .get('disp-1') as { job_id: string | null; state: string; request_json: string };
      expect(crashed.job_id).toBeNull();
      expect(crashed.state).toBe('submitting');
      expect(JSON.parse(crashed.request_json)).toMatchObject({
        requestId: 'node-dispatch/disp-1',
      });

      // Recovery replays the stored request — same requestId re-binds to
      // the same backend job rather than minting a second one.
      rpcHandler = (op, params) =>
        op === 'job.create'
          ? {
              job: {
                id: 'job-1',
                state: 'queued',
                requestId: (params as { requestId: string }).requestId,
                inputManifest: (params as { inputManifest: unknown }).inputManifest,
              },
            }
          : {};
      const record = await refreshDispatch('disp-1');
      expect(record.jobId).toBe('job-1');
      expect(record.state).toBe('queued');
      const creates = rpcCalls.filter((c) => c.operation === 'job.create');
      // The crashed attempt and the replay both carry the dispatch-derived
      // requestId — the backend re-binds rather than duplicating the job.
      expect(creates).toHaveLength(2);
      for (const create of creates) {
        expect((create.params as { requestId: string }).requestId).toBe('node-dispatch/disp-1');
      }
    } finally {
      cleanup(parentRepo, sourceRepo);
    }
  });

  it('replays persisted cancel intent until the job lands terminal', async () => {
    const { workspaceId, parentRepo, sourceRepo } = seedDispatchFixture('cancel-replay');
    try {
      db.prepare(
        `INSERT INTO mesh_node_dispatches
         (dispatch_id, run_id, node_id, job_id, request_id, workspace_id,
          manifest_json, state, cancel_requested, output_json, created_at, updated_at)
         VALUES ('disp-1', 'run-1', 'node-1', 'job-1', 'r', ?, '{}', 'running', 1, NULL, datetime('now'), datetime('now'))`,
      ).run(workspaceId);
      rpcHandler = (op) =>
        op === 'job.cancel' ? { job: { id: 'job-1', state: 'cancel-requested' } } : {};
      await reconcileDispatchesOnBoot();
      expect(rpcCalls.some((c) => c.operation === 'job.cancel')).toBe(true);
      expect(rpcCalls.some((c) => c.operation === 'job.get')).toBe(false);
      const row = db
        .prepare('SELECT state FROM mesh_node_dispatches WHERE dispatch_id = ?')
        .get('disp-1') as { state: string };
      expect(row.state).toBe('cancel-requested');
    } finally {
      cleanup(parentRepo, sourceRepo);
    }
  });

  it('applies a cancel persisted while the job was still unsubmitted', async () => {
    const { workspaceId, parentRepo, sourceRepo } = seedDispatchFixture('cancel-pending');
    try {
      const request = {
        requestId: 'node-dispatch/disp-1',
        payloadHash: 'hash',
        kind: 'workflow-node',
        requestedTarget: { kind: 'auto' },
        inputManifest: {
          workspaceDefinitionRevision: 'r1',
          repositories: [],
          bootstrapDigest: 'none',
          provider: 'codex',
          model: 'm',
          configVersions: {},
          inputs: { workspaceId },
        },
        retryPolicy: 'inspect-before-retry',
      };
      db.prepare(
        `INSERT INTO mesh_node_dispatches
         (dispatch_id, run_id, node_id, job_id, request_id, workspace_id,
          manifest_json, request_json, state, cancel_requested, output_json,
          created_at, updated_at)
         VALUES ('disp-1', 'run-1', 'node-1', NULL, 'r', ?, '{}', ?, 'submitting', 1, NULL, datetime('now'), datetime('now'))`,
      ).run(workspaceId, JSON.stringify(request));
      rpcHandler = (op, params) =>
        op === 'job.create'
          ? {
              job: {
                id: 'job-1',
                state: 'queued',
                requestId: (params as { requestId: string }).requestId,
                inputManifest: (params as { inputManifest: unknown }).inputManifest,
              },
            }
          : op === 'job.cancel'
            ? { job: { id: 'job-1', state: 'cancel-requested' } }
            : {};
      const record = await refreshDispatch('disp-1');
      // The stored request submits first, then the persisted cancel
      // intent replays against the newly bound job.
      expect(record.jobId).toBe('job-1');
      expect(record.state).toBe('cancel-requested');
      const ops = rpcCalls.map((c) => c.operation);
      expect(ops.indexOf('job.create')).toBeLessThan(ops.indexOf('job.cancel'));
    } finally {
      cleanup(parentRepo, sourceRepo);
    }
  });

  it('cancelNodeDispatch on an unsubmitted dispatch persists intent without a job.cancel', async () => {
    const { workspaceId, parentRepo, sourceRepo } = seedDispatchFixture('cancel-null');
    try {
      db.prepare(
        `INSERT INTO mesh_node_dispatches
         (dispatch_id, run_id, node_id, job_id, request_id, workspace_id,
          manifest_json, request_json, state, cancel_requested, output_json,
          created_at, updated_at)
         VALUES ('disp-1', 'run-1', 'node-1', NULL, 'r', ?, '{}', '{}', 'submitting', 0, NULL, datetime('now'), datetime('now'))`,
      ).run(workspaceId);
      const record = await cancelNodeDispatch('disp-1');
      expect(record.cancelRequested).toBe(true);
      expect(rpcCalls.some((c) => c.operation === 'job.cancel')).toBe(false);
    } finally {
      cleanup(parentRepo, sourceRepo);
    }
  });
});

describe('reconcileDispatchesOnBoot', () => {
  it('re-adopts persisted jobs — never recreates them', async () => {
    const { workspaceId, parentRepo, sourceRepo } = seedDispatchFixture('boot');
    try {
      db.prepare(
        `INSERT INTO mesh_node_dispatches
         (dispatch_id, run_id, node_id, job_id, request_id, workspace_id,
          manifest_json, state, cancel_requested, output_json, created_at, updated_at)
         VALUES ('disp-1', 'run-1', 'node-1', 'job-1', 'r', ?, '{}', 'running', 0, NULL, datetime('now'), datetime('now'))`,
      ).run(workspaceId);
      rpcHandler = (op) =>
        op === 'job.get' ? { job: { id: 'job-1', state: 'failed' }, attempts: [] } : {};
      await reconcileDispatchesOnBoot();
      expect(rpcCalls.some((c) => c.operation === 'job.create')).toBe(false);
      const row = db
        .prepare('SELECT state FROM mesh_node_dispatches WHERE dispatch_id = ?')
        .get('disp-1') as { state: string };
      expect(row.state).toBe('failed');
    } finally {
      cleanup(parentRepo, sourceRepo);
    }
  });
});
