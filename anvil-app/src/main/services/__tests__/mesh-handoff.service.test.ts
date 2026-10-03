import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import type { HandoffRecord } from '../../../../cloud/contract/handoff';

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
let handoffRecordsForTests = new Map<string, HandoffRecord>();

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

const interruptTurnMock = vi.fn();
const stopSessionMock = vi.fn();
const activationInputs: Array<Record<string, unknown>> = [];
let loseActivationResponse = false;
let targetTrustState: 'trusted' | 'pending' | 'revoked' | null = 'trusted';
const submitPreparedJobMock = vi.fn(async (params: { kind: string; requestId: string }) => {
  if (params.kind === 'start-session' && loseActivationResponse) {
    loseActivationResponse = false;
    throw new Error('activation response lost after ownership transfer');
  }
  return {
    id: `${params.kind}-job`,
    requestId: params.requestId,
    state: 'completed',
  };
});
vi.mock('../codex-session.service.js', () => ({
  getCodexSession: () => ({ mode: 'workspace-auto' }),
  getCodexSessionModel: () => 'model-test',
  interruptTurn: (...args: unknown[]) => interruptTurnMock(...args),
  stopSessionAndWait: (...args: unknown[]) => stopSessionMock(...args),
}));

vi.mock('../mesh-worker.service.js', () => ({
  preparePrepareWorkspaceJob: vi.fn(async (input: { requestId: string; workspaceId: string }) => {
    const definitions = db
      .prepare(
        `SELECT d.portable_id AS repositoryId, r.path FROM workspace_repo_definitions d
           JOIN repos r ON r.id = d.mapped_repo_id WHERE d.workspace_id = ?`,
      )
      .all(input.workspaceId) as Array<{ repositoryId: string; path: string }>;
    return {
      requestId: input.requestId,
      kind: 'prepare-workspace',
      inputManifest: {
        workspaceDefinitionRevision: 'workspace-rev',
        repositories: definitions.map((repo) => ({
          repositoryId: repo.repositoryId,
          commit: git(repo.path, 'rev-parse', 'HEAD'),
        })),
        bootstrapDigest: 'none',
      },
    };
  }),
  prepareStartSessionJob: vi.fn(
    async (input: {
      requestId: string;
      handoffCheckpoint?: Record<string, unknown>;
      manifestPin?: {
        workspaceDefinitionRevision: string;
        repositories: Array<{ repositoryId: string; commit: string }>;
        bootstrapDigest: string;
      };
    }) => {
      activationInputs.push(input);
      return {
        requestId: input.requestId,
        kind: 'start-session',
        inputManifest: input.manifestPin,
      };
    },
  ),
  submitPreparedJob: (params: { kind: string; requestId: string }) => submitPreparedJobMock(params),
}));
vi.mock('../sync-keyring.service.js', () => ({
  deviceTrustState: () => targetTrustState,
  sealScopedJson: vi.fn(),
}));

import {
  captureSessionCheckpoint,
  configureMeshHandoffContext,
  evaluateHandoffReadiness,
  initiateHandoff,
  reconcileHandoffsOnBoot,
  resetMeshHandoffForTests,
} from '../mesh-handoff.service';
import { assertSessionTurnAllowed, writeSessionOwnership } from '../mesh-ownership.service';
import {
  configureRemoteChatContext,
  listRemoteChats,
  resetRemoteChatForTests,
} from '../remote-chat.service';

const CTX = { apiUrl: 'https://backend.test/v1', accessToken: 'tok', enrollmentId: 'enr-1' };

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString().trim();
}

/** A real repo pushed to a local bare remote so `tracking`/`ahead` resolve. */
function makeRepoWithRemote(suffix: string): { repoDir: string; head: string } {
  const base = mkdtempSync(join(tmpdir(), `anvil-handoff-${suffix}-`));
  const repoDir = join(base, 'repo');
  const remoteDir = join(base, 'remote.git');
  // Pin the initial branch to 'main' — ambient init.defaultBranch differs
  // between dev machines and CI, and push.default=simple refuses to push a
  // branch whose upstream name doesn't match.
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remoteDir]);
  execFileSync('git', ['init', '--initial-branch=main', repoDir]);
  git(
    repoDir,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '--allow-empty',
    '-m',
    'init',
  );
  git(repoDir, 'remote', 'add', 'origin', remoteDir);
  git(repoDir, 'push', '-u', 'origin', 'HEAD:main');
  const head = git(repoDir, 'rev-parse', 'HEAD');
  return { repoDir, head };
}

function seedSession(suffix: string, repoDir: string): { sessionId: string; repoId: string } {
  const sessionId = `sess-${suffix}`;
  const repoId = `repo-${suffix}`;
  const threadId = `thr-${suffix}`;
  const workspaceId = `w-${suffix}`;
  db.prepare(
    `INSERT INTO repos (id, name, path, status, created_at, updated_at)
     VALUES (?, 'repo', ?, 'connected', datetime('now'), datetime('now'))`,
  ).run(repoId, repoDir);
  db.prepare(
    `INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, 'W', datetime('now'), datetime('now'))`,
  ).run(workspaceId);
  db.prepare(
    `INSERT INTO chat_threads (id, workspace_id, persona_id, title, repo_ids_json, created_at, updated_at)
     VALUES (?, ?, 'persona', 'T', ?, datetime('now'), datetime('now'))`,
  ).run(threadId, workspaceId, JSON.stringify([repoId]));
  db.prepare(
    `INSERT INTO workspace_repo_definitions
     (workspace_id, portable_id, name, mapped_repo_id, created_at, updated_at)
     VALUES (?, ?, 'repo', ?, datetime('now'), datetime('now'))`,
  ).run(workspaceId, repoId, repoId);
  db.prepare(
    `INSERT INTO chat_sessions (id, thread_id, repo_id, provider, started_at)
     VALUES (?, ?, ?, 'codex', datetime('now'))`,
  ).run(sessionId, threadId, repoId);
  return { sessionId, repoId };
}

/**
 * Backend-shaped fake: handoff rows advance through the real transition
 * table; failures can be injected by throwing from `advance`.
 */
function installHandoffFake(
  options: {
    failAdvanceTo?: string;
    afterPreparation?: () => void;
  } = {},
): void {
  let afterPreparation = options.afterPreparation;
  const states = new Map<string, string>();
  const records = new Map<string, HandoffRecord>();
  handoffRecordsForTests = records;
  rpcHandler = (op, rawParams) => {
    const params = rawParams as Record<string, unknown>;
    if (op === 'device.list')
      return { devices: [{ enrollmentId: 'enr-2', revoked: false, enrollmentClass: 'device' }] };
    if (op === 'job.get') {
      if (afterPreparation !== undefined) {
        const callback = afterPreparation;
        afterPreparation = undefined;
        callback();
      }
      return { job: { state: 'completed' }, attempts: [] };
    }
    if (op === 'handoff.create') {
      const id = params['handoffId'] as string;
      const existing = records.get(id);
      if (existing !== undefined) return { handoff: existing };
      const handoff: HandoffRecord = {
        id,
        sessionId: params['sessionId'] as string,
        state: 'requested',
        sourceEnrollmentId: params['sourceEnrollmentId'] as string,
        targetEnrollmentId: params['targetEnrollmentId'] as string,
        sourceGeneration: params['sourceGeneration'] as number,
        targetGeneration: null,
        checkpoint: null,
        cancelledFrom: null,
        cancelReason: null,
        createdAt: '',
        updatedAt: '',
      };
      records.set(id, handoff);
      states.set(id, 'requested');
      return { handoff };
    }
    if (op === 'handoff.advance') {
      const id = params['handoffId'] as string;
      const to = params['to'] as string;
      const record = records.get(id);
      if (record === undefined) throw new Error('not-found');
      if (options.failAdvanceTo === to) throw new Error('injected-advance-failure');
      states.set(id, to);
      record.state = to as HandoffRecord['state'];
      if (to === 'source-relinquished-and-checkpointed') {
        record.checkpoint = params['checkpoint'] as HandoffRecord['checkpoint'];
      }
      if (to === 'ownership-transferred') {
        record.targetGeneration = record.sourceGeneration + 1;
      }
      return { handoff: record };
    }
    if (op === 'handoff.cancel') {
      const id = params['handoffId'] as string;
      const record = records.get(id);
      if (record === undefined) throw new Error('not-found');
      record.state = 'cancelled';
      record.cancelledFrom = states.get(id) as HandoffRecord['cancelledFrom'];
      return { handoff: record };
    }
    if (op === 'handoff.get') {
      const record = records.get(params['handoffId'] as string);
      if (record === undefined) throw new Error('not-found');
      return { handoff: record };
    }
    return {};
  };
}

beforeEach(() => {
  db.exec(
    `DELETE FROM mesh_session_ownership; DELETE FROM mesh_handoff_journal; DELETE FROM remote_chats;
     DELETE FROM chat_messages; DELETE FROM chat_sessions; DELETE FROM chat_threads;
     DELETE FROM workspace_repo_definitions;
     DELETE FROM repos; DELETE FROM workspaces;`,
  );
  rpcCalls.length = 0;
  activationInputs.length = 0;
  handoffRecordsForTests = new Map();
  rpcHandler = () => ({});
  interruptTurnMock.mockReset();
  stopSessionMock.mockReset();
  submitPreparedJobMock.mockClear();
  loseActivationResponse = false;
  targetTrustState = 'trusted';
  resetMeshHandoffForTests();
  configureMeshHandoffContext(() => CTX);
  resetRemoteChatForTests();
  configureRemoteChatContext(() => ({
    ...CTX,
    scope: { backendId: 'backend-1', accountId: 'account-1', datasetEpoch: '1' },
  }));
});

describe('session ownership gate', () => {
  it('opens for sessions with no row or owned state, fails closed when relinquished', () => {
    expect(() => assertSessionTurnAllowed('sess-none')).not.toThrow();
    writeSessionOwnership('sess-a', 1, 'enr-1', 'owned');
    expect(() => assertSessionTurnAllowed('sess-a')).not.toThrow();
    writeSessionOwnership('sess-b', 1, 'enr-1', 'relinquished');
    expect(() => assertSessionTurnAllowed('sess-b')).toThrow('session-relinquished');
  });
});

describe('evaluateHandoffReadiness', () => {
  it('passes a clean checkout whose commits are pushed', async () => {
    const { repoDir } = makeRepoWithRemote('clean');
    const { sessionId } = seedSession('clean', repoDir);
    const result = await evaluateHandoffReadiness(sessionId);
    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
    rmSync(join(repoDir, '..'), { recursive: true, force: true });
  });

  it('blocks dirty tracked state, untracked inputs, and unpushed commits with remediation', async () => {
    const { repoDir } = makeRepoWithRemote('dirty');
    const { sessionId } = seedSession('dirty', repoDir);
    writeFileSync(join(repoDir, 'untracked.txt'), 'scratch');
    git(
      repoDir,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '--allow-empty',
      '-m',
      'unpushed',
    );
    const result = await evaluateHandoffReadiness(sessionId);
    expect(result.ok).toBe(false);
    const codes = result.blockers.map((b) => b.code);
    expect(codes).toContain('untracked-inputs');
    expect(codes).toContain('unpushed-commits');
    for (const blocker of result.blockers) {
      expect(blocker.remediation.length).toBeGreaterThan(0);
    }
    rmSync(join(repoDir, '..'), { recursive: true, force: true });
  });

  it('blocks a dirty tree separately from untracked inputs', async () => {
    const { repoDir } = makeRepoWithRemote('tracked');
    const { sessionId } = seedSession('tracked', repoDir);
    writeFileSync(join(repoDir, 'file.txt'), 'v1');
    git(repoDir, 'add', 'file.txt');
    git(repoDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'add file');
    // Explicit refspec: a bare `git push` depends on push.default matching the
    // configured upstream, which varies with ambient git config on CI.
    git(repoDir, 'push', 'origin', 'HEAD');
    writeFileSync(join(repoDir, 'file.txt'), 'modified');
    const result = await evaluateHandoffReadiness(sessionId);
    expect(result.blockers.map((b) => b.code)).toEqual(['dirty-tree']);
    rmSync(join(repoDir, '..'), { recursive: true, force: true });
  });
});

describe('initiateHandoff', () => {
  it.each(['source-quiescing', 'source-relinquished-and-checkpointed'] as const)(
    'recovers a durably stopped source from its scoped private checkpoint at %s',
    async (initialState) => {
      installHandoffFake();
      const scoped = {
        ...CTX,
        scope: { backendId: 'backend-1', accountId: 'account-1', datasetEpoch: '1' },
      };
      configureMeshHandoffContext(() => scoped);
      const checkpoint = {
        sessionId: 'session-recovery',
        schemaVersion: 1,
        sourceGeneration: 3,
        repositories: [{ repositoryId: 'local-repo', commit: 'commit-a' }],
        provider: 'codex',
        model: 'gpt-test',
        artifactRefs: [],
        unresolvedApprovals: [],
      };
      handoffRecordsForTests.set('handoff-recovery', {
        id: 'handoff-recovery',
        sessionId: checkpoint.sessionId,
        state: initialState,
        sourceEnrollmentId: 'enr-1',
        targetEnrollmentId: 'enr-2',
        sourceGeneration: 3,
        targetGeneration: null,
        checkpoint: null,
        cancelledFrom: null,
        cancelReason: null,
        createdAt: '',
        updatedAt: '',
      });
      db.prepare(
        `INSERT INTO mesh_handoff_journal
       (handoff_id, session_id, role, state, created_at, updated_at, backend_id, account_id, scope_epoch,
        source_checkpoint_json, preparation_request_json, preparation_job_id,
        activation_workspace_id, activation_target_enrollment_id, activation_provider,
        activation_model, activation_permission_mode, activation_auth_mode)
       VALUES (?, ?, 'source', 'source-quiescing', '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'handoff-recovery',
        checkpoint.sessionId,
        scoped.scope.backendId,
        scoped.scope.accountId,
        scoped.scope.datasetEpoch,
        JSON.stringify(checkpoint),
        JSON.stringify({
          requestId: 'prepare-recovery',
          inputManifest: {
            workspaceDefinitionRevision: 'workspace-rev',
            repositories: [{ repositoryId: 'repo-portable', commit: 'commit-a' }],
            bootstrapDigest: 'none',
          },
        }),
        'prepare-job-recovery',
        'workspace-recovery',
        'enr-2',
        'codex',
        'gpt-test',
        'on-request',
        'codex-account',
      );
      writeSessionOwnership(checkpoint.sessionId, 3, 'enr-1', 'relinquished');

      configureMeshHandoffContext(() => ({
        ...scoped,
        scope: { ...scoped.scope, accountId: 'account-other' },
      }));
      await reconcileHandoffsOnBoot();
      expect(rpcCalls.some((call) => call.operation === 'handoff.get')).toBe(false);

      configureMeshHandoffContext(() => scoped);
      await reconcileHandoffsOnBoot();

      expect(handoffRecordsForTests.get('handoff-recovery')?.state).toBe('ownership-transferred');
      expect(activationInputs[0]?.handoffCheckpoint).toMatchObject({
        sessionId: checkpoint.sessionId,
        sourceGeneration: 3,
        repositories: [{ repositoryId: 'repo-portable', commit: 'commit-a' }],
      });
      expect(listRemoteChats('workspace-recovery')).toEqual([
        expect.objectContaining({ handoffId: 'handoff-recovery', state: 'starting' }),
      ]);
    },
  );

  it('drives create→prepare→quiesce→relinquish→transfer with durable local markers', async () => {
    const { repoDir, head } = makeRepoWithRemote('flow');
    const { sessionId } = seedSession('flow', repoDir);
    installHandoffFake();

    const result = await initiateHandoff({ sessionId, targetEnrollmentId: 'enr-2' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.handoff.state).toBe('ownership-transferred');

    // Durable markers: source is relinquished; journal shows the final state.
    const ownership = db
      .prepare('SELECT state, generation FROM mesh_session_ownership WHERE session_id = ?')
      .get(sessionId) as { state: string; generation: number };
    expect(ownership.state).toBe('relinquished');
    const journal = db.prepare('SELECT role, state FROM mesh_handoff_journal').get() as {
      role: string;
      state: string;
    };
    expect(journal).toEqual({ role: 'source', state: 'ownership-transferred' });

    // Quiescence happened between durable reject and checkpoint advance.
    expect(interruptTurnMock).toHaveBeenCalledWith(sessionId);
    expect(stopSessionMock).toHaveBeenCalledWith(sessionId);
    expect(
      rpcCalls.find(
        (c) =>
          c.operation === 'handoff.advance' &&
          (c.params as { to: string }).to === 'target-prepared-without-execution',
      ),
    ).toBeDefined();
    expect(
      db.prepare('SELECT preparation_job_id, activation_job_id FROM mesh_handoff_journal').get(),
    ).toEqual({
      preparation_job_id: 'prepare-workspace-job',
      activation_job_id: 'start-session-job',
    });
    expect(submitPreparedJobMock.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'start-session',
      inputManifest: {
        repositories: [{ repositoryId: 'repo-flow', commit: head }],
      },
    });
    expect(activationInputs[0]?.handoffCheckpoint).toMatchObject({
      sessionId,
      sourceGeneration: 1,
      repositories: [{ repositoryId: 'repo-flow', commit: head }],
    });
    expect(listRemoteChats('w-flow')).toEqual([
      expect.objectContaining({
        sourceSessionId: sessionId,
        targetEnrollmentId: 'enr-2',
        handoffId: expect.any(String),
        state: 'starting',
        prepareJobId: 'prepare-workspace-job',
        jobId: 'start-session-job',
      }),
    ]);

    // The checkpoint advance carried the exact-commit manifest.
    const relinquish = rpcCalls.find(
      (c) =>
        c.operation === 'handoff.advance' &&
        (c.params as { to: string }).to === 'source-relinquished-and-checkpointed',
    );
    const checkpoint = (
      relinquish!.params as { checkpoint: { repositories: Array<{ commit: string }> } }
    ).checkpoint;
    expect(checkpoint.repositories[0]?.commit).toBe(head);
    rmSync(join(repoDir, '..'), { recursive: true, force: true });
  });

  it('does not let periodic reconciliation race an active source handoff', async () => {
    const { repoDir } = makeRepoWithRemote('active-reconcile');
    const { sessionId } = seedSession('active-reconcile', repoDir);
    installHandoffFake();
    let finishStop!: () => void;
    stopSessionMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );

    const initiating = initiateHandoff({ sessionId, targetEnrollmentId: 'enr-2' });
    await vi.waitFor(() => expect(stopSessionMock).toHaveBeenCalledTimes(1));
    const getsBefore = rpcCalls.filter((call) => call.operation === 'handoff.get').length;
    await reconcileHandoffsOnBoot();
    expect(rpcCalls.filter((call) => call.operation === 'handoff.get')).toHaveLength(getsBefore);
    finishStop();
    await initiating;
    rmSync(join(repoDir, '..'), { recursive: true, force: true });
  });

  it('cancels before stopping the source when its HEAD changes during target preparation', async () => {
    const { repoDir, head } = makeRepoWithRemote('changed-during-prep');
    const { sessionId } = seedSession('changed-during-prep', repoDir);
    installHandoffFake({
      afterPreparation: () => {
        writeFileSync(join(repoDir, 'late-edit.txt'), 'changed while target prepared');
        git(repoDir, 'add', 'late-edit.txt');
        git(
          repoDir,
          '-c',
          'user.email=t@t',
          '-c',
          'user.name=t',
          'commit',
          '-m',
          'late source edit',
        );
      },
    });

    await expect(initiateHandoff({ sessionId, targetEnrollmentId: 'enr-2' })).rejects.toThrow(
      /source checkout changed|source HEAD changed/,
    );
    expect(interruptTurnMock).not.toHaveBeenCalled();
    expect(stopSessionMock).not.toHaveBeenCalled();
    expect(git(repoDir, 'rev-parse', 'HEAD')).not.toBe(head);
    expect(
      db.prepare('SELECT state FROM mesh_session_ownership WHERE session_id = ?').get(sessionId),
    ).toEqual({ state: 'owned' });
    rmSync(join(repoDir, '..'), { recursive: true, force: true });
  });

  it('replays the sealed activation request after transfer and adopts it after restart', async () => {
    const { repoDir } = makeRepoWithRemote('activation-replay');
    const { sessionId } = seedSession('activation-replay', repoDir);
    installHandoffFake();
    loseActivationResponse = true;

    const result = await initiateHandoff({ sessionId, targetEnrollmentId: 'enr-2' });
    expect(result.ok).toBe(true);
    expect(listRemoteChats('w-activation-replay')).toEqual([]);
    const pending = db
      .prepare('SELECT activation_request_json, activation_job_id FROM mesh_handoff_journal')
      .get() as { activation_request_json: string | null; activation_job_id: string | null };
    expect(pending.activation_request_json).toBeTruthy();
    expect(pending.activation_job_id).toBeNull();
    const handoffId = (
      db.prepare('SELECT handoff_id FROM mesh_handoff_journal').get() as { handoff_id: string }
    ).handoff_id;
    const backendHandoff = handoffRecordsForTests.get(handoffId)!;
    backendHandoff.state = 'completed';
    backendHandoff.targetGeneration = 2;

    await reconcileHandoffsOnBoot();
    expect(listRemoteChats('w-activation-replay')).toEqual([
      expect.objectContaining({
        sourceSessionId: sessionId,
        handoffId: expect.any(String),
        state: 'starting',
        jobId: 'start-session-job',
      }),
    ]);
    await reconcileHandoffsOnBoot();
    expect(listRemoteChats('w-activation-replay')).toHaveLength(1);
    expect(db.prepare('SELECT activation_job_id FROM mesh_handoff_journal').get()).toEqual({
      activation_job_id: 'start-session-job',
    });
    rmSync(join(repoDir, '..'), { recursive: true, force: true });
  });

  it('blocks before any backend call when readiness fails', async () => {
    const { repoDir } = makeRepoWithRemote('gate');
    const { sessionId } = seedSession('gate', repoDir);
    writeFileSync(join(repoDir, 'scratch.txt'), 'uncommitted');
    const result = await initiateHandoff({ sessionId, targetEnrollmentId: 'enr-2' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blockers.length).toBeGreaterThan(0);
    expect(rpcCalls.filter((c) => c.operation.startsWith('handoff.'))).toEqual([]);
    rmSync(join(repoDir, '..'), { recursive: true, force: true });
  });

  it('rejects an enrolled but pending target before creating a handoff checkpoint', async () => {
    const { repoDir } = makeRepoWithRemote('pending-target');
    const { sessionId } = seedSession('pending-target', repoDir);
    targetTrustState = 'pending';
    installHandoffFake();
    configureMeshHandoffContext(() => ({
      ...CTX,
      scope: { backendId: 'backend-1', accountId: 'account-1', datasetEpoch: '1' },
    }));
    await expect(initiateHandoff({ sessionId, targetEnrollmentId: 'enr-2' })).rejects.toThrow(
      /must be trusted/,
    );
    expect(rpcCalls.map((call) => call.operation)).toEqual(['device.list']);
    expect(stopSessionMock).not.toHaveBeenCalled();
    rmSync(join(repoDir, '..'), { recursive: true, force: true });
  });

  it('restores local ownership and cancels when a pre-transfer step fails', async () => {
    const { repoDir } = makeRepoWithRemote('prefail');
    const { sessionId } = seedSession('prefail', repoDir);
    installHandoffFake({ failAdvanceTo: 'source-quiescing' });

    await expect(initiateHandoff({ sessionId, targetEnrollmentId: 'enr-2' })).rejects.toThrow(
      'injected-advance-failure',
    );

    // Local mirror restored — the source may resume under still-valid ownership.
    const ownership = db
      .prepare('SELECT state FROM mesh_session_ownership WHERE session_id = ?')
      .get(sessionId) as { state: string };
    expect(ownership.state).toBe('owned');
    // The backend saw a cancel.
    expect(rpcCalls.some((c) => c.operation === 'handoff.cancel')).toBe(true);
    rmSync(join(repoDir, '..'), { recursive: true, force: true });
  });
});

describe('reconcileHandoffsOnBoot', () => {
  it('restores ownership when the backend shows a pre-transfer cancel', async () => {
    const { repoDir } = makeRepoWithRemote('reconcile');
    const { sessionId } = seedSession('reconcile', repoDir);
    writeSessionOwnership(sessionId, 1, 'enr-1', 'relinquished');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO mesh_handoff_journal (handoff_id, session_id, role, state, created_at, updated_at)
       VALUES ('ho-1', ?, 'source', 'source-quiescing', ?, ?)`,
    ).run(sessionId, now, now);

    rpcHandler = (op) =>
      op === 'handoff.get'
        ? {
            handoff: {
              id: 'ho-1',
              sessionId,
              state: 'cancelled',
              cancelledFrom: 'source-quiescing',
              targetGeneration: null,
              sourceEnrollmentId: 'enr-1',
              targetEnrollmentId: 'enr-2',
              sourceGeneration: 1,
              checkpoint: null,
              cancelReason: null,
              createdAt: '',
              updatedAt: '',
            },
          }
        : {};
    await reconcileHandoffsOnBoot();

    const ownership = db
      .prepare('SELECT state FROM mesh_session_ownership WHERE session_id = ?')
      .get(sessionId) as { state: string };
    expect(ownership.state).toBe('owned');
    rmSync(join(repoDir, '..'), { recursive: true, force: true });
  });

  it('keeps the relinquish when ownership already transferred', async () => {
    const sessionId = 'sess-transferred';
    writeSessionOwnership(sessionId, 1, 'enr-1', 'relinquished');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO mesh_handoff_journal (handoff_id, session_id, role, state, created_at, updated_at)
       VALUES ('ho-2', ?, 'source', 'ownership-transferred', ?, ?)`,
    ).run(sessionId, now, now);
    rpcHandler = (op) =>
      op === 'handoff.get'
        ? {
            handoff: {
              id: 'ho-2',
              sessionId,
              state: 'target-activating',
              cancelledFrom: null,
              targetGeneration: 2,
              sourceEnrollmentId: 'enr-1',
              targetEnrollmentId: 'enr-2',
              sourceGeneration: 1,
              checkpoint: null,
              cancelReason: null,
              createdAt: '',
              updatedAt: '',
            },
          }
        : {};
    await reconcileHandoffsOnBoot();
    const ownership = db
      .prepare('SELECT state FROM mesh_session_ownership WHERE session_id = ?')
      .get(sessionId) as { state: string };
    expect(ownership.state).toBe('relinquished');
  });
});

describe('captureSessionCheckpoint', () => {
  it('pins exact commits and carries a bounded message tail', async () => {
    const { repoDir, head } = makeRepoWithRemote('capture');
    const { sessionId, repoId } = seedSession('capture', repoDir);
    const threadId = 'thr-capture';
    for (let i = 0; i < 30; i += 1) {
      db.prepare(
        `INSERT INTO chat_messages (id, thread_id, role, content, kind, timestamp)
         VALUES (?, ?, ?, ?, 'user', datetime('now', '+' || ? || ' seconds'))`,
      ).run(`m-${i}`, threadId, i % 2 === 0 ? 'user' : 'assistant', `message ${i}`, i);
    }
    const checkpoint = await captureSessionCheckpoint(sessionId, 1);
    expect(checkpoint.permissionMode).toBe('workspace-auto');
    expect(checkpoint.repositories).toEqual([{ repositoryId: repoId, commit: head }]);
    expect(checkpoint.messages?.length).toBeLessThanOrEqual(20);
    expect(checkpoint.summary).toBe('message 29');
    expect(checkpoint.provider).toBe('codex');
    rmSync(join(repoDir, '..'), { recursive: true, force: true });
  });
});
