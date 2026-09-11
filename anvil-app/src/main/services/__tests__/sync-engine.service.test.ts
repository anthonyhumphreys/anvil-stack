import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import { DEFAULT_ORCHESTRATION } from '../../../shared/workflow-orchestration';
import type { WorkflowNode } from '../../../shared/types';
import { SYNC_ENTITY_WORKFLOW_TEMPLATE, type SyncScope } from '../../../shared/sync-mesh';
import type {
  SyncCursor,
  SyncPullResult,
  SyncPushParams,
  SyncPushResult,
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
  runSyncCycle,
  SyncEngineError,
  type SyncEngineRpc,
} from '../sync-engine.service';
import {
  canonicalJson,
  getBinding,
  listConflicts,
  listOutboxRows,
  nextBatch,
  upsertBinding,
  upsertEnrollment,
} from '../sync-persistence.service';
import { getWorkflowTemplate, saveWorkflowTemplate } from '../workflow.service';

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
    'DELETE FROM sync_outbox; DELETE FROM sync_bindings; DELETE FROM sync_conflicts; DELETE FROM sync_state; DELETE FROM device_enrollments; DELETE FROM workflow_templates;',
  );
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

  it('reverts dispatched rows to pending when push RPC throws', async () => {
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
    expect(rows[0].state).toBe('pending');
    expect(rows[0].enrollmentSequence).toBeNull();
    expect(rows[0].dispatchedAt).toBeNull();
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
});
