import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import { DEFAULT_ORCHESTRATION } from '../../../shared/workflow-orchestration';
import type { WorkflowNode } from '../../../shared/types';
import {
  SYNC_ENTITY_EDITABLE_AGENT,
  SYNC_ENTITY_SETTINGS,
  SYNC_ENTITY_WORKFLOW_TEMPLATE,
  SYNC_ENTITY_WORKSPACE_DEFINITION,
  SYNC_SETTINGS_ENTITY_ID,
  type SyncScope,
} from '../../../shared/sync-mesh';
import type {
  SyncCursor,
  SyncPullResult,
  SyncPushParams,
  SyncPushResult,
  SyncScanBeginResult,
  SyncScanFinishResult,
  SyncScanPageResult,
  SyncedChange,
} from '../../../../cloud/contract/sync';
import {
  BackendRpcError,
  type BackendConnection,
  type RpcResult,
} from '../sync-backend-client.service';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../persona.service.js', () => ({
  getPersonaById: (id: string) => (id === 'coder' ? { id } : null),
  buildSystemPrompt: () => '',
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
}));

import {
  getSyncEngineSnapshot,
  resetSyncEngineForTests,
  resolveSyncConflict,
  runSyncCycle,
  SyncEngineError,
  type SyncEngineRpc,
} from '../sync-engine.service';
import {
  canonicalJson,
  getBinding,
  getSyncState,
  listConflicts,
  listOutboxRows,
  nextBatch,
  updateSyncState,
  upsertBinding,
  upsertEnrollment,
} from '../sync-persistence.service';
import { getWorkflowTemplate, saveWorkflowTemplate } from '../workflow.service';
import { getEditableAgent, saveEditableAgent } from '../editable-agent.service';
import { getSettings } from '../settings.service';

const SCOPE: SyncScope = { backendId: 'backend-1', accountId: 'account-1', datasetEpoch: '1' };
const ET = SYNC_ENTITY_WORKFLOW_TEMPLATE;
const ENROLLMENT = 'enrollment-1';
const CONNECTION = { apiUrl: 'https://example.test/api/' };
const TOKEN = 'access-token';
const EMPTY_CURSOR = 'cursor-empty' as SyncCursor;

function node(id: string): WorkflowNode {
  return {
    id,
    name: id,
    prompt: `Run ${id}`,
    personaId: 'coder',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'medium',
    executionStrategy: 'adaptive',
    position: { x: 0, y: 0 },
  };
}

function templateInput(name: string) {
  return {
    name,
    description: 'Sync engine test workflow',
    orchestration: { ...DEFAULT_ORCHESTRATION },
    nodes: [node('step-1')],
    edges: [],
  };
}

function templatePayload(id: string, name: string) {
  return {
    id,
    name,
    description: 'Sync engine test workflow',
    nodes: [node('step-1')],
    edges: [],
    orchestration: { ...DEFAULT_ORCHESTRATION },
  };
}

function activateEnrollment(id = ENROLLMENT): void {
  upsertEnrollment({
    displayName: 'Test device',
    id,
    installationId: 'installation-1',
    scope: SCOPE,
    state: 'active',
  });
}

function emptyPull(nextCursor: string = EMPTY_CURSOR): SyncPullResult {
  return { changes: [], hasMore: false, nextCursor: nextCursor as SyncCursor };
}

function acceptPush(params: unknown, revision = 1): SyncPushResult {
  const { changes } = params as SyncPushParams;
  return {
    results: changes.map((change) => ({
      changeId: change.changeId,
      revision,
      status: 'accepted' as const,
    })),
  };
}

function rpcResult<T>(result: T): RpcResult<T> {
  return { result, serverTime: '2026-09-11T10:00:00.000Z' };
}

function fakeRpc(handlers: {
  push?: (params: unknown) => SyncPushResult | Promise<SyncPushResult>;
  pull?: (params: unknown) => SyncPullResult | Promise<SyncPullResult>;
  scanBegin?: () => SyncScanBeginResult | Promise<SyncScanBeginResult>;
  scanPage?: (params: unknown) => SyncScanPageResult | Promise<SyncScanPageResult>;
  scanFinish?: (params: unknown) => SyncScanFinishResult | Promise<SyncScanFinishResult>;
  onPush?: () => void | Promise<void>;
}): SyncEngineRpc {
  return async <R = unknown>(
    _connection: Pick<BackendConnection, 'apiUrl'>,
    operation: string,
    params: unknown,
    _accessToken: string,
  ): Promise<RpcResult<R>> => {
    switch (operation) {
      case 'sync.push': {
        await handlers.onPush?.();
        const result = handlers.push ? await handlers.push(params) : { results: [] };
        return rpcResult(result) as RpcResult<R>;
      }
      case 'sync.pull': {
        const result = handlers.pull ? await handlers.pull(params) : emptyPull();
        return rpcResult(result) as RpcResult<R>;
      }
      case 'sync.scan.begin': {
        if (!handlers.scanBegin) throw new Error('unexpected RPC operation sync.scan.begin');
        return rpcResult(await handlers.scanBegin()) as RpcResult<R>;
      }
      case 'sync.scan.page': {
        if (!handlers.scanPage) throw new Error('unexpected RPC operation sync.scan.page');
        return rpcResult(await handlers.scanPage(params)) as RpcResult<R>;
      }
      case 'sync.scan.finish': {
        if (!handlers.scanFinish) throw new Error('unexpected RPC operation sync.scan.finish');
        return rpcResult(await handlers.scanFinish(params)) as RpcResult<R>;
      }
      default:
        throw new Error(`unexpected RPC operation ${operation}`);
    }
  };
}

function cycle(rpc: SyncEngineRpc) {
  return runSyncCycle({
    accessToken: TOKEN,
    connection: CONNECTION,
    enrollmentId: ENROLLMENT,
    rpc,
    scope: SCOPE,
  });
}

beforeEach(() => {
  resetSyncEngineForTests();
  db.exec(
    `DELETE FROM sync_outbox; DELETE FROM sync_bindings; DELETE FROM sync_conflicts;
     DELETE FROM sync_state; DELETE FROM device_enrollments; DELETE FROM workflow_templates;
     DELETE FROM sync_scan_runs; DELETE FROM sync_scan_staging; DELETE FROM sync_installation;
     DELETE FROM editable_agents; DELETE FROM workspaces; DELETE FROM workspace_repos;
     DELETE FROM workspace_repo_definitions; DELETE FROM workspace_preferences;
     DELETE FROM repos;`,
  );
  db.prepare('INSERT OR IGNORE INTO settings (id) VALUES (1)').run();
});

describe('runSyncCycle push', () => {
  it('does not upload an unsynced template (nextBatch is empty; push RPC is not invoked)', async () => {
    activateEnrollment();
    saveWorkflowTemplate(templateInput('Unsynced'));
    expect(nextBatch(SCOPE, ENROLLMENT)).toEqual([]);

    let pushCalls = 0;
    await cycle(
      fakeRpc({
        push: (params) => {
          pushCalls += 1;
          return acceptPush(params);
        },
      }),
    );

    expect(pushCalls).toBe(0);
    expect(listOutboxRows(SCOPE)).toEqual([]);
    expect(getSyncEngineSnapshot(SCOPE).pendingCount).toBe(0);
  });

  it('pushes a synced save, advances the binding base, and acknowledges the outbox', async () => {
    activateEnrollment();
    const saved = saveWorkflowTemplate(templateInput('Original'));
    upsertBinding(SCOPE, ET, saved.id);
    saveWorkflowTemplate({ ...templateInput('Renamed') }, saved.id);
    expect(listOutboxRows(SCOPE)).toHaveLength(1);
    expect(listOutboxRows(SCOPE)[0].state).toBe('pending');

    await cycle(fakeRpc({ push: (params) => acceptPush(params, 1) }));

    const binding = getBinding(SCOPE, ET, saved.id);
    expect(binding?.baseRevision).toBe(1);
    expect(binding?.basePayloadJson).toContain('Renamed');
    const rows = listOutboxRows(SCOPE);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('acknowledged');
    const snapshot = getSyncEngineSnapshot(SCOPE);
    expect(snapshot.inFlight).toBe(false);
    expect(snapshot.pendingCount).toBe(0);
    expect(snapshot.lastPushAt).not.toBeNull();
    expect(snapshot.lastPullAt).not.toBeNull();
  });

  it('keeps dispatched rows durably replayable when push RPC throws', async () => {
    activateEnrollment();
    const saved = saveWorkflowTemplate(templateInput('Original'));
    upsertBinding(SCOPE, ET, saved.id);
    saveWorkflowTemplate({ ...templateInput('Renamed') }, saved.id);

    let thrown: unknown;
    try {
      await cycle(
        fakeRpc({
          push: () => {
            throw new BackendRpcError({ code: 'unavailable', retryable: true });
          },
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SyncEngineError);
    expect((thrown as SyncEngineError).retryable).toBe(true);

    const rows = listOutboxRows(SCOPE);
    expect(rows).toHaveLength(1);
    // The dispatch stays durable: the same identity replays on the next cycle.
    expect(rows[0].state).toBe('dispatched');
    expect(rows[0].enrollmentSequence).toBe(1);
    expect(rows[0].dispatchedAt).not.toBeNull();

    const seen: Array<{ changeId: string; enrollmentSequence: number; payloadHash: string }> = [];
    resetSyncEngineForTests();
    await cycle(
      fakeRpc({
        push: (params) => {
          const { changes } = params as SyncPushParams;
          for (const change of changes) {
            seen.push({
              changeId: change.changeId,
              enrollmentSequence: change.enrollmentSequence,
              payloadHash: change.payloadHash,
            });
          }
          return acceptPush(params, 1);
        },
      }),
    );
    expect(seen).toEqual([
      {
        changeId: rows[0].changeId,
        enrollmentSequence: rows[0].enrollmentSequence,
        payloadHash: rows[0].payloadHash,
      },
    ]);
    expect(listOutboxRows(SCOPE)[0].state).toBe('acknowledged');
  });

  it('coalesces overlapping runSyncCycle calls onto one extra run after the in-flight cycle', async () => {
    activateEnrollment();
    const saved = saveWorkflowTemplate(templateInput('Original'));
    upsertBinding(SCOPE, ET, saved.id);
    saveWorkflowTemplate({ ...templateInput('Renamed') }, saved.id);

    let releasePush!: () => void;
    const holdPush = new Promise<void>((resolve) => {
      releasePush = resolve;
    });
    let sawPush!: () => void;
    const pushEntered = new Promise<void>((resolve) => {
      sawPush = resolve;
    });
    let pushCalls = 0;
    let pullCalls = 0;
    const rpc = fakeRpc({
      onPush: async () => {
        pushCalls += 1;
        sawPush();
        await holdPush;
      },
      push: (params) => acceptPush(params, 1),
      pull: () => {
        pullCalls += 1;
        return emptyPull(`cursor-${pullCalls}`);
      },
    });

    const first = cycle(rpc);
    await pushEntered;
    expect(getSyncEngineSnapshot(SCOPE).inFlight).toBe(true);
    const second = cycle(rpc);
    releasePush();
    await Promise.all([first, second]);

    // First cycle dispatched the only pending row. The coalesced extra run finds
    // an empty nextBatch, so push RPC is invoked once per coalesced wave. Pull
    // runs once per cycle, so twice (in-flight + extra).
    expect(pushCalls).toBe(1);
    expect(pullCalls).toBe(2);
    expect(listOutboxRows(SCOPE)[0].state).toBe('acknowledged');
    expect(getSyncEngineSnapshot(SCOPE).inFlight).toBe(false);
  });

  it('resolves a displaced queue waiter only when the replacement cycle runs', async () => {
    activateEnrollment();
    const saved = saveWorkflowTemplate(templateInput('T'));
    upsertBinding(SCOPE, ET, saved.id);
    saveWorkflowTemplate({ ...templateInput('T') }, saved.id);

    let releasePush!: () => void;
    const holdPush = new Promise<void>((resolve) => {
      releasePush = resolve;
    });
    let sawPush!: () => void;
    const pushEntered = new Promise<void>((resolve) => {
      sawPush = resolve;
    });
    let pushCalls = 0;
    const rpc = fakeRpc({
      onPush: async () => {
        pushCalls += 1;
        sawPush();
        await holdPush;
      },
      push: (params) => acceptPush(params, 1),
      pull: () => emptyPull('cursor-1'),
    });

    const first = cycle(rpc);
    await pushEntered;
    const second = cycle(rpc);
    // A third caller arrives while the first is still held: it displaces the
    // second, which must NOT resolve until the replacement cycle completes.
    const third = cycle(rpc);
    let secondResolved = false;
    void second.then(() => {
      secondResolved = true;
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false);
    releasePush();
    await Promise.all([first, second, third]);
    expect(secondResolved).toBe(true);
    expect(pushCalls).toBe(1);
  });
});

describe('runSyncCycle pull', () => {
  it('applies a remote create into workflow_templates and creates a binding', async () => {
    activateEnrollment();
    const remote = templatePayload('remote-tpl', 'From remote');
    const change: SyncedChange = {
      entityType: ET,
      entityId: 'remote-tpl',
      operation: 'create',
      payload: remote,
      revision: 3,
      schemaVersion: 1,
      sequence: 10,
    };

    await cycle(
      fakeRpc({
        pull: () => ({
          changes: [change],
          hasMore: false,
          nextCursor: 'cursor-3' as SyncCursor,
        }),
      }),
    );

    const template = getWorkflowTemplate('remote-tpl');
    expect(template?.name).toBe('From remote');
    const binding = getBinding(SCOPE, ET, 'remote-tpl');
    expect(binding?.baseRevision).toBe(3);
    expect(binding?.basePayloadJson).toContain('From remote');
    expect(binding?.localEditGeneration).toBe(0);
    expect(listOutboxRows(SCOPE)).toEqual([]);
  });

  it('records a sync_conflicts row when local is dirty and keeps the local template name', async () => {
    activateEnrollment();
    const saved = saveWorkflowTemplate(templateInput('Local name'));
    upsertBinding(SCOPE, ET, saved.id, {
      basePayloadJson: canonicalJson(templatePayload(saved.id, 'Local name')),
      baseRevision: 1,
    });
    saveWorkflowTemplate({ ...templateInput('Local dirty') }, saved.id);
    const binding = getBinding(SCOPE, ET, saved.id);
    expect(binding?.localEditGeneration).toBeGreaterThan(binding?.acknowledgedGeneration ?? 0);
    // Dispatch first so this cycle's nextBatch skips the dirty entity and we
    // exercise pull-while-dirty instead of acknowledging the local save.
    expect(nextBatch(SCOPE, ENROLLMENT)).toHaveLength(1);

    const remote = templatePayload(saved.id, 'Remote name');
    await cycle(
      fakeRpc({
        pull: () => ({
          changes: [
            {
              entityType: ET,
              entityId: saved.id,
              operation: 'update' as const,
              payload: remote,
              revision: 9,
              schemaVersion: 1,
              sequence: 11,
            },
          ],
          hasMore: false,
          nextCursor: 'cursor-conflict' as SyncCursor,
        }),
      }),
    );

    const conflicts = listConflicts(SCOPE);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('edit-edit');
    expect(conflicts[0].remoteRevision).toBe(9);
    expect(getWorkflowTemplate(saved.id)?.name).toBe('Local dirty');
  });

  it('drains pull pages until hasMore is false', async () => {
    activateEnrollment();
    let pulls = 0;
    await cycle(
      fakeRpc({
        pull: () => {
          pulls += 1;
          if (pulls === 1) {
            return {
              changes: [
                {
                  entityType: ET,
                  entityId: 'page-1',
                  operation: 'create' as const,
                  payload: templatePayload('page-1', 'Page one'),
                  revision: 1,
                  schemaVersion: 1,
                  sequence: 1,
                },
              ],
              hasMore: true,
              nextCursor: 'cursor-page-1' as SyncCursor,
            };
          }
          return {
            changes: [
              {
                entityType: ET,
                entityId: 'page-2',
                operation: 'create' as const,
                payload: templatePayload('page-2', 'Page two'),
                revision: 2,
                schemaVersion: 1,
                sequence: 2,
              },
            ],
            hasMore: false,
            nextCursor: 'cursor-page-2' as SyncCursor,
          };
        },
      }),
    );
    expect(pulls).toBe(2);
    expect(getWorkflowTemplate('page-1')?.name).toBe('Page one');
    expect(getWorkflowTemplate('page-2')?.name).toBe('Page two');
  });

  it('scans when reset_required is set, then pulls', async () => {
    activateEnrollment();
    updateSyncState(SCOPE, { resetRequired: true });
    let scanned = false;
    await cycle(
      fakeRpc({
        scanBegin: () => ({
          scanId: 'scan-1',
          watermarkStart: 4,
          resumeCursor: '4' as SyncCursor,
          epoch: '1',
        }),
        scanPage: () => ({
          entities: [
            {
              entityType: ET,
              entityId: 'scanned-tpl',
              revision: 4,
              schemaVersion: 1,
              payload: templatePayload('scanned-tpl', 'From scan'),
            },
          ],
          nextCursor: null,
          done: true,
        }),
        scanFinish: () => ({
          scanId: 'scan-1',
          complete: true,
          watermarkEnd: 4,
          epoch: '1',
          nextCursor: '4' as SyncCursor,
        }),
        pull: () => {
          scanned = true;
          return emptyPull('4');
        },
      }),
    );
    expect(scanned).toBe(true);
    expect(getWorkflowTemplate('scanned-tpl')?.name).toBe('From scan');
    expect(getBinding(SCOPE, ET, 'scanned-tpl')?.baseRevision).toBe(4);
  });

  it('applies use-remote and drops the conflict', async () => {
    activateEnrollment();
    const saved = saveWorkflowTemplate(templateInput('Local name'));
    upsertBinding(SCOPE, ET, saved.id, {
      basePayloadJson: canonicalJson(templatePayload(saved.id, 'Local name')),
      baseRevision: 1,
    });
    saveWorkflowTemplate({ ...templateInput('Local dirty') }, saved.id);
    expect(nextBatch(SCOPE, ENROLLMENT)).toHaveLength(1);
    const remote = templatePayload(saved.id, 'Remote name');
    await cycle(
      fakeRpc({
        pull: () => ({
          changes: [
            {
              entityType: ET,
              entityId: saved.id,
              operation: 'update' as const,
              payload: remote,
              revision: 9,
              schemaVersion: 1,
              sequence: 11,
            },
          ],
          hasMore: false,
          nextCursor: 'cursor-conflict' as SyncCursor,
        }),
      }),
    );
    const conflict = listConflicts(SCOPE)[0];
    resolveSyncConflict({ conflictId: conflict.id, resolution: 'use-remote' });
    expect(listConflicts(SCOPE)).toEqual([]);
    expect(getWorkflowTemplate(saved.id)?.name).toBe('Remote name');
    expect(listOutboxRows(SCOPE).filter((row) => row.state !== 'acknowledged')).toEqual([]);
  });

  it('save-copy applies remote to the canonical entity and preserves local as a new entity', async () => {
    activateEnrollment();
    const saved = saveWorkflowTemplate(templateInput('Local name'));
    upsertBinding(SCOPE, ET, saved.id, {
      basePayloadJson: canonicalJson(templatePayload(saved.id, 'Local name')),
      baseRevision: 1,
    });
    saveWorkflowTemplate({ ...templateInput('Local dirty') }, saved.id);
    const remote = templatePayload(saved.id, 'Remote name');
    await cycle(
      fakeRpc({
        pull: () => ({
          changes: [
            {
              entityType: ET,
              entityId: saved.id,
              operation: 'update' as const,
              payload: remote,
              revision: 9,
              schemaVersion: 1,
              sequence: 11,
            },
          ],
          hasMore: false,
          nextCursor: 'cursor-conflict' as SyncCursor,
        }),
      }),
    );
    const conflict = listConflicts(SCOPE)[0];
    resolveSyncConflict({ conflictId: conflict.id, resolution: 'save-copy' });

    // Remote wins the canonical id; conflict is resolved.
    expect(listConflicts(SCOPE)).toEqual([]);
    expect(getWorkflowTemplate(saved.id)?.name).toBe('Remote name');

    // The local version survives as a new bound entity queued for create.
    const creates = listOutboxRows(SCOPE).filter(
      (row) => row.state === 'pending' && row.operation === 'create' && row.entityId !== saved.id,
    );
    expect(creates).toHaveLength(1);
    const copyId = creates[0].entityId;
    expect(copyId).not.toBe(saved.id);
    expect(getWorkflowTemplate(copyId)?.name).toBe('Local dirty (local copy)');
    expect(getBinding(SCOPE, ET, copyId)).toBeDefined();

    // The copy syncs to the account like any other local create.
    await cycle(fakeRpc({ push: (params) => acceptPush(params, 2) }));
    expect(listOutboxRows(SCOPE).filter((row) => row.state === 'pending')).toEqual([]);
    expect(getBinding(SCOPE, ET, copyId)?.baseRevision).toBe(2);
  });
});

describe('runSyncCycle pull — ENTITY-01 types', () => {
  it('applies a remote editable-agent create', async () => {
    activateEnrollment();
    const change: SyncedChange = {
      entityType: SYNC_ENTITY_EDITABLE_AGENT,
      entityId: 'agent-remote',
      operation: 'create',
      payload: {
        id: 'agent-remote',
        name: 'Reviewer',
        description: 'Reviews diffs',
        icon: 'Search',
        colour: '#22d3ee',
        promptBody: 'Review the diff for {{repoName}}.',
        capabilities: { canWriteFiles: false, canRunCommands: false, canReadFiles: true },
      },
      revision: 2,
      schemaVersion: 1,
      sequence: 5,
    };
    await cycle(
      fakeRpc({
        pull: () => ({
          changes: [change],
          hasMore: false,
          nextCursor: 'cursor-a' as SyncCursor,
        }),
      }),
    );

    const agent = getEditableAgent('agent-remote');
    expect(agent?.name).toBe('Reviewer');
    expect(agent?.promptBody).toBe('Review the diff for {{repoName}}.');
    expect(getBinding(SCOPE, SYNC_ENTITY_EDITABLE_AGENT, 'agent-remote')?.baseRevision).toBe(
      2,
    );
  });

  it('applies a remote workspace definition and marks it needs-setup', async () => {
    activateEnrollment();
    const change: SyncedChange = {
      entityType: SYNC_ENTITY_WORKSPACE_DEFINITION,
      entityId: 'ws-remote',
      operation: 'create',
      payload: {
        id: 'ws-remote',
        name: 'Shared workspace',
        repos: [{ id: 'portable-1', name: 'anvil-app' }],
        preferences: { workitems: { personaId: 'coder' } },
      },
      revision: 4,
      schemaVersion: 1,
      sequence: 6,
    };
    await cycle(
      fakeRpc({
        pull: () => ({
          changes: [change],
          hasMore: false,
          nextCursor: 'cursor-w' as SyncCursor,
        }),
      }),
    );

    const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get('ws-remote') as {
      name: string;
      definition_state: string;
    };
    expect(ws.name).toBe('Shared workspace');
    expect(ws.definition_state).toBe('needs-setup');
    expect(
      db
        .prepare('SELECT portable_id FROM workspace_repo_definitions WHERE workspace_id = ?')
        .all('ws-remote'),
    ).toHaveLength(1);
    expect(
      getBinding(SCOPE, SYNC_ENTITY_WORKSPACE_DEFINITION, 'ws-remote')?.baseRevision,
    ).toBe(4);
  });

  it('applies a remote settings update to allowlisted fields only', async () => {
    activateEnrollment();
    upsertBinding(SCOPE, SYNC_ENTITY_SETTINGS, SYNC_SETTINGS_ENTITY_ID, {
      basePayloadJson: canonicalJson({ id: SYNC_SETTINGS_ENTITY_ID, fields: { theme: 'system' } }),
      baseRevision: 1,
    });
    const change: SyncedChange = {
      entityType: SYNC_ENTITY_SETTINGS,
      entityId: SYNC_SETTINGS_ENTITY_ID,
      operation: 'update',
      payload: {
        id: SYNC_SETTINGS_ENTITY_ID,
        fields: { theme: 'dark', githubPat: 'attacker-controlled' },
      },
      revision: 2,
      schemaVersion: 1,
      sequence: 7,
    };
    await cycle(
      fakeRpc({
        pull: () => ({
          changes: [change],
          hasMore: false,
          nextCursor: 'cursor-s' as SyncCursor,
        }),
      }),
    );

    expect(getSettings().theme).toBe('dark');
    const row = db.prepare('SELECT github_pat FROM settings WHERE id = 1').get() as {
      github_pat: Buffer | null;
    };
    expect(row.github_pat).toBeNull();
  });

  it('quarantines a malformed editable-agent payload and keeps syncing other entities', async () => {
    activateEnrollment();
    const bad: SyncedChange = {
      entityType: SYNC_ENTITY_EDITABLE_AGENT,
      entityId: 'agent-bad',
      operation: 'create',
      payload: { id: 'agent-bad', promptBody: 42 },
      revision: 1,
      schemaVersion: 1,
      sequence: 8,
    };
    const good: SyncedChange = {
      entityType: SYNC_ENTITY_EDITABLE_AGENT,
      entityId: 'agent-good',
      operation: 'create',
      payload: { id: 'agent-good', name: 'Fine', promptBody: 'x' },
      revision: 1,
      schemaVersion: 1,
      sequence: 9,
    };
    await cycle(
      fakeRpc({
        pull: () => ({
          changes: [bad, good],
          hasMore: false,
          nextCursor: 'cursor-q' as SyncCursor,
        }),
      }),
    );

    expect(getEditableAgent('agent-bad')).toBeNull();
    // The un-understood payload is held on the binding for later revisions.
    const quarantined = getBinding(SCOPE, SYNC_ENTITY_EDITABLE_AGENT, 'agent-bad');
    expect(quarantined?.quarantineJson).toContain('agent-bad');
    expect(getEditableAgent('agent-good')?.name).toBe('Fine');
  });

  it('applies a remote workspace delete', async () => {
    activateEnrollment();
    const change: SyncedChange = {
      entityType: SYNC_ENTITY_WORKSPACE_DEFINITION,
      entityId: 'ws-remote',
      operation: 'create',
      payload: { id: 'ws-remote', name: 'Doomed', repos: [] },
      revision: 1,
      schemaVersion: 1,
      sequence: 3,
    };
    await cycle(
      fakeRpc({
        pull: () => ({
          changes: [change],
          hasMore: false,
          nextCursor: 'cursor-1' as SyncCursor,
        }),
      }),
    );
    expect(db.prepare('SELECT id FROM workspaces WHERE id = ?').get('ws-remote')).toBeDefined();

    await cycle(
      fakeRpc({
        pull: () => ({
          changes: [
            {
              entityType: SYNC_ENTITY_WORKSPACE_DEFINITION,
              entityId: 'ws-remote',
              operation: 'delete' as const,
              revision: 2,
              schemaVersion: 1,
              sequence: 4,
            },
          ],
          hasMore: false,
          nextCursor: 'cursor-2' as SyncCursor,
        }),
      }),
    );
    expect(
      db.prepare('SELECT id FROM workspaces WHERE id = ?').get('ws-remote'),
    ).toBeUndefined();
  });

  it('save-copy on an editable-agent conflict preserves the local version', async () => {
    activateEnrollment();
    const saved = saveEditableAgent({ name: 'Mine', promptBody: 'local body' });
    upsertBinding(SCOPE, SYNC_ENTITY_EDITABLE_AGENT, saved.id, {
      basePayloadJson: canonicalJson({ id: saved.id, name: 'Mine', promptBody: 'local body' }),
      baseRevision: 1,
    });
    saveEditableAgent({ name: 'Mine', promptBody: 'local dirty body' }, saved.id);
    expect(nextBatch(SCOPE, ENROLLMENT)).toHaveLength(1); // dispatch the dirty row

    await cycle(
      fakeRpc({
        pull: () => ({
          changes: [
            {
              entityType: SYNC_ENTITY_EDITABLE_AGENT,
              entityId: saved.id,
              operation: 'update' as const,
              payload: {
                id: saved.id,
                name: 'Mine',
                promptBody: 'remote body',
              },
              revision: 5,
              schemaVersion: 1,
              sequence: 12,
            },
          ],
          hasMore: false,
          nextCursor: 'cursor-c' as SyncCursor,
        }),
      }),
    );

    const conflict = listConflicts(SCOPE)[0];
    expect(conflict.entityType).toBe(SYNC_ENTITY_EDITABLE_AGENT);
    resolveSyncConflict({ conflictId: conflict.id, resolution: 'save-copy' });

    expect(getEditableAgent(saved.id)?.promptBody).toBe('remote body');
    const creates = listOutboxRows(SCOPE).filter(
      (row) =>
        row.state === 'pending' &&
        row.operation === 'create' &&
        row.entityType === SYNC_ENTITY_EDITABLE_AGENT &&
        row.entityId !== saved.id,
    );
    expect(creates).toHaveLength(1);
    expect(getEditableAgent(creates[0].entityId)?.name).toBe('Mine (local copy)');
  });
});

describe('runSyncCycle BILL-05 hosted write gate', () => {
  it('a gated cycle never pushes, still pulls, and skips the rescan', async () => {
    activateEnrollment();
    const saved = saveWorkflowTemplate(templateInput('Original'));
    upsertBinding(SCOPE, ET, saved.id);
    saveWorkflowTemplate({ ...templateInput('Renamed') }, saved.id);
    updateSyncState(SCOPE, { resetRequired: true });
    expect(listOutboxRows(SCOPE)[0].state).toBe('pending');

    let pushCalls = 0;
    let pullCalls = 0;
    let scanCalls = 0;
    await runSyncCycle({
      accessToken: TOKEN,
      connection: CONNECTION,
      enrollmentId: ENROLLMENT,
      scope: SCOPE,
      writeGate: () => ({ allowed: false }),
      rpc: fakeRpc({
        push: (params) => {
          pushCalls += 1;
          return acceptPush(params);
        },
        pull: () => {
          pullCalls += 1;
          return emptyPull('cursor-gated');
        },
        scanBegin: () => {
          scanCalls += 1;
          return {
            scanId: 'scan-1',
            watermarkStart: 0,
            resumeCursor: '0' as SyncCursor,
            epoch: '1',
          };
        },
      }),
    });

    expect(pushCalls).toBe(0);
    expect(scanCalls).toBe(0);
    expect(pullCalls).toBe(1);
    // Nothing was consumed or rejected: the pending row and the rescan flag
    // both survive for the cycle that runs after access resumes.
    expect(listOutboxRows(SCOPE)[0].state).toBe('pending');
    expect(listOutboxRows(SCOPE)[0].enrollmentSequence).toBeNull();
    expect(getSyncState(SCOPE)?.resetRequired).toBe(true);
  });

  it('re-opens the gate transparently on the next cycle', async () => {
    activateEnrollment();
    const saved = saveWorkflowTemplate(templateInput('Original'));
    upsertBinding(SCOPE, ET, saved.id);
    saveWorkflowTemplate({ ...templateInput('Renamed') }, saved.id);

    let allowed = false;
    const gate = () => ({ allowed });
    let pushCalls = 0;
    const rpc = fakeRpc({
      push: (params) => {
        pushCalls += 1;
        return acceptPush(params, 1);
      },
    });
    await runSyncCycle({
      accessToken: TOKEN,
      connection: CONNECTION,
      enrollmentId: ENROLLMENT,
      scope: SCOPE,
      writeGate: gate,
      rpc,
    });
    expect(pushCalls).toBe(0);

    allowed = true;
    resetSyncEngineForTests();
    await runSyncCycle({
      accessToken: TOKEN,
      connection: CONNECTION,
      enrollmentId: ENROLLMENT,
      scope: SCOPE,
      writeGate: gate,
      rpc,
    });
    expect(pushCalls).toBe(1);
    expect(listOutboxRows(SCOPE)[0].state).toBe('acknowledged');
  });

  it('a 403 forbidden push still pulls, keeps outbox rows, and propagates with details', async () => {
    activateEnrollment();
    const saved = saveWorkflowTemplate(templateInput('Original'));
    upsertBinding(SCOPE, ET, saved.id);
    saveWorkflowTemplate({ ...templateInput('Renamed') }, saved.id);

    let pullCalls = 0;
    let thrown: unknown;
    try {
      await cycle(
        fakeRpc({
          push: () => {
            throw new BackendRpcError({
              code: 'forbidden',
              retryable: false,
              details: { reason: 'subscription-required' },
            });
          },
          pull: () => {
            pullCalls += 1;
            return emptyPull('cursor-after-denial');
          },
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SyncEngineError);
    expect((thrown as SyncEngineError).code).toBe('forbidden');
    expect((thrown as SyncEngineError).details).toEqual({ reason: 'subscription-required' });
    // Control ops ran, and the denial is a pause: rows stay dispatched, never rejected.
    expect(pullCalls).toBe(1);
    const rows = listOutboxRows(SCOPE);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('dispatched');
    expect(rows[0].resultJson).toBeNull();
    expect(getSyncState(SCOPE)?.cursor).toBe('cursor-after-denial');
  });
});
