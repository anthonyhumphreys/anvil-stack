import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import { DEFAULT_ORCHESTRATION } from '../../../shared/workflow-orchestration';
import type { WorkflowNode } from '../../../shared/types';
import { SYNC_ENTITY_WORKFLOW_TEMPLATE, type SyncScope } from '../../../shared/sync-mesh';
import type { SyncScanPageResult } from '../../../../cloud/contract/sync';
import { FakeAccountCoordinator } from './fake-account-coordinator';

/**
 * Focused failure-injection coverage for the Step 1–3 repair invariants:
 * durable dispatch replay (including process restart over a file-backed db),
 * immutable retry identity, scan staging boundaries, and account/backend
 * scope isolation.
 */

const { active } = vi.hoisted(() => ({
  active: { db: null as unknown as InstanceType<typeof Database> },
}));

vi.mock('../../db/database.js', () => ({ getDb: () => active.db }));
vi.mock('../persona.service.js', () => ({
  getPersonaById: (id: string) => (id === 'coder' ? { id } : null),
  buildSystemPrompt: () => '',
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
}));

import {
  rpc,
  type BackendConnection,
  type RpcResult,
} from '../sync-backend-client.service';
import {
  resetSyncEngineForTests,
  runSyncCycle,
  SyncEngineError,
  type SyncEngineRpc,
} from '../sync-engine.service';
import {
  beginScanStaging,
  computePayloadHash,
  getBinding,
  getScanRun,
  getSyncState,
  listConflicts,
  listOutboxRows,
  listScanStaging,
  recordLocalChange,
  stageScanEntities,
  updateSyncState,
  upsertBinding,
  upsertEnrollment,
} from '../sync-persistence.service';
import { getWorkflowTemplate, saveWorkflowTemplate } from '../workflow.service';

const SCOPE: SyncScope = {
  backendId: 'backend-1',
  accountId: 'account-1',
  datasetEpoch: 'spike-epoch-1',
};
const OTHER_SCOPE: SyncScope = {
  backendId: 'backend-1',
  accountId: 'account-2',
  datasetEpoch: 'spike-epoch-1',
};
const ET = SYNC_ENTITY_WORKFLOW_TEMPLATE;
const CONNECTION = { apiUrl: 'https://example.test/api/' };
const ENROLLMENT = 'enrollment-1';

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
    description: '',
    orchestration: { ...DEFAULT_ORCHESTRATION },
    nodes: [node('step-1')],
    edges: [],
  };
}

function templatePayload(id: string, name: string) {
  return {
    id,
    name,
    description: '',
    nodes: [node('step-1')],
    edges: [],
    orchestration: { ...DEFAULT_ORCHESTRATION },
  };
}

function spikeToken(enrollmentId: string, scope: SyncScope = SCOPE): string {
  return `spike:${scope.accountId}:${enrollmentId}`;
}

function activateEnrollment(enrollmentId: string, scope: SyncScope = SCOPE): void {
  upsertEnrollment({
    displayName: `Device ${enrollmentId}`,
    id: enrollmentId,
    installationId: 'installation-1',
    scope,
    state: 'active',
  });
}

function injectRpc(account: FakeAccountCoordinator): SyncEngineRpc {
  return (connection, operation, params, accessToken) =>
    rpc(connection, operation, params, accessToken, { fetchFn: account.fetch });
}

function cycle(
  account: FakeAccountCoordinator,
  options: {
    enrollmentId?: string;
    guard?: () => boolean;
    rpc?: SyncEngineRpc;
    scope?: SyncScope;
    token?: string;
  } = {},
) {
  const enrollmentId = options.enrollmentId ?? ENROLLMENT;
  const scope = options.scope ?? SCOPE;
  return runSyncCycle({
    accessToken: options.token ?? spikeToken(enrollmentId, scope),
    connection: CONNECTION,
    enrollmentId,
    rpc: options.rpc ?? injectRpc(account),
    scope,
    ...(options.guard === undefined ? {} : { guard: options.guard }),
  });
}

function seedSyncedTemplate(name = 'Synced'): { id: string } {
  const saved = saveWorkflowTemplate(templateInput(name));
  upsertBinding(SCOPE, ET, saved.id);
  recordLocalChange(SCOPE, {
    entityId: saved.id,
    entityType: ET,
    operation: 'create',
    payload: templatePayload(saved.id, name),
    schemaVersion: 1,
  });
  return saved;
}

let tmpDir: string;
let account: FakeAccountCoordinator;

function openFileDb(): InstanceType<typeof Database> {
  const db = new Database(join(tmpDir, 'sync-test.db'));
  db.exec(SCHEMA_SQL);
  return db;
}

/** Simulates a process restart boundary: in-memory engine state is gone. */
function restart(): void {
  resetSyncEngineForTests();
}

beforeEach(() => {
  resetSyncEngineForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'sync-failure-'));
  active.db = openFileDb();
  account = new FakeAccountCoordinator();
});

afterEach(() => {
  active.db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('durable dispatch and retry identity', () => {
  it('replays the same change after the server committed but the response was lost', async () => {
    activateEnrollment(ENROLLMENT);
    const saved = seedSyncedTemplate('Lost ack');

    // Server commits the mutation; the client only sees a transport error.
    account.injectFailure('sync.push', 'drop-response');
    await expect(cycle(account)).rejects.toBeInstanceOf(SyncEngineError);

    const dispatched = listOutboxRows(SCOPE).find((row) => row.entityId === saved.id);
    expect(dispatched?.state).toBe('dispatched');
    const identity = {
      changeId: dispatched?.changeId,
      enrollmentSequence: dispatched?.enrollmentSequence,
      payloadHash: dispatched?.payloadHash,
    };

    // Process restart: close and reopen the same SQLite file.
    active.db.close();
    active.db = openFileDb();
    restart();

    await cycle(account);

    const rows = listOutboxRows(SCOPE);
    const resolved = rows.find((row) => row.entityId === saved.id);
    expect(resolved?.state).toBe('acknowledged');
    // The replayed dispatch kept its original identity — the backend receipt
    // deduplicated on (enrollment, sequence) instead of applying twice.
    expect(resolved?.changeId).toBe(identity.changeId);
    expect(resolved?.enrollmentSequence).toBe(identity.enrollmentSequence);
    expect(resolved?.payloadHash).toBe(identity.payloadHash);
    expect(getBinding(SCOPE, ET, saved.id)?.baseRevision).toBe(1);
  });

  it('keeps a local edit that lands while the dispatch is in flight', async () => {
    activateEnrollment(ENROLLMENT);
    const saved = seedSyncedTemplate('Original');
    account.injectFailure('sync.push', 'drop-response');
    await expect(cycle(account)).rejects.toBeInstanceOf(SyncEngineError);
    restart();

    // Local edit while the first dispatch's outcome is unknown.
    saveWorkflowTemplate({ ...templateInput('Renamed') }, saved.id);

    const rows = listOutboxRows(SCOPE);
    const dispatched = rows.find((row) => row.state === 'dispatched');
    const pending = rows.find((row) => row.state === 'pending');
    expect(dispatched?.payloadJson).toContain('Original');
    expect(pending?.payloadJson).toContain('Renamed');

    await cycle(account); // replay resolves via the stored receipt
    restart();
    await cycle(account); // the pending successor dispatches

    const after = listOutboxRows(SCOPE);
    expect(after.every((row) => row.state === 'acknowledged')).toBe(true);
    const binding = getBinding(SCOPE, ET, saved.id);
    expect(binding?.basePayloadJson).toContain('Renamed');
  });

  it('never replays a dispatch orphaned under a different enrollment', async () => {
    activateEnrollment(ENROLLMENT);
    const saved = seedSyncedTemplate('Orphaned');
    account.injectFailure('sync.push', 'drop-response');
    await expect(cycle(account)).rejects.toBeInstanceOf(SyncEngineError);
    restart();

    // The enrollment is replaced (re-enrollment): the old receipt namespace is
    // unreachable, so the dispatched row must be fenced, not replayed.
    upsertEnrollment({
      displayName: 'Device enrollment-2',
      id: 'enrollment-2',
      installationId: 'installation-1',
      scope: SCOPE,
      state: 'active',
    });

    const sent: string[] = [];
    await cycle(account, {
      enrollmentId: 'enrollment-2',
      rpc: (connection, operation, params, accessToken) => {
        if (operation === 'sync.push') {
          const { changes } = params as { changes: Array<{ entityId: string }> };
          for (const change of changes) sent.push(change.entityId);
        }
        return rpc(connection, operation, params, accessToken, {
          fetchFn: account.fetch,
        });
      },
      token: spikeToken('enrollment-2'),
    });

    expect(sent).not.toContain(saved.id);
    const row = listOutboxRows(SCOPE).find((item) => item.entityId === saved.id);
    expect(row?.state).toBe('rejected');
    expect(row?.resultJson).toContain('enrollment-superseded');
    expect(listConflicts(SCOPE).some((conflict) => conflict.entityId === saved.id)).toBe(true);
  });

  it('rejects a replay whose stored content no longer matches the original dispatch', async () => {
    activateEnrollment(ENROLLMENT);
    const saved = seedSyncedTemplate('Tamper check');
    account.injectFailure('sync.push', 'drop-response');
    await expect(cycle(account)).rejects.toBeInstanceOf(SyncEngineError);
    restart();

    // Corrupt the durable row before replay: same sequence, different content.
    const tampered = { tampered: true };
    active.db
      .prepare('UPDATE sync_outbox SET payload_json = ?, payload_hash = ? WHERE entity_id = ?')
      .run(
        JSON.stringify(tampered),
        computePayloadHash({
          baseRevision: null,
          entityId: saved.id,
          entityType: ET,
          operation: 'create',
          payload: tampered,
          schemaVersion: 1,
        }),
        saved.id,
      );

    await cycle(account);

    const row = listOutboxRows(SCOPE).find((item) => item.entityId === saved.id);
    // The receipt exists for that sequence with different content: the fake
    // returns a changed-content rejection and the row resolves as rejected.
    expect(row?.state).toBe('rejected');
    expect(row?.resultJson).toContain('changed-content');
  });
});

describe('reset and scan boundaries', () => {
  it('flags reset when the backend epoch rotated and keeps the local edit safe', async () => {
    activateEnrollment(ENROLLMENT);
    const saved = seedSyncedTemplate('Local edit');
    // Server dataset was restored: its epoch rotated under our scope.
    account.rotateEpoch('spike-epoch-2');

    await expect(cycle(account)).rejects.toBeInstanceOf(SyncEngineError);
    expect(getSyncState(SCOPE)?.resetRequired).toBe(true);
    // The local row is preserved; nothing was overwritten by remote state.
    expect(getWorkflowTemplate(saved.id)?.name).toBe('Local edit');
  });

  it('leaves no partial state when a scan is interrupted mid-page', async () => {
    activateEnrollment(ENROLLMENT);
    const remote = seedSyncedTemplate('Remote copy');
    await cycle(account);
    expect(getBinding(SCOPE, ET, remote.id)?.baseRevision).toBe(1);

    updateSyncState(SCOPE, { resetRequired: true });
    account.injectFailure('sync.scan.page', 'reject');
    await expect(cycle(account)).rejects.toBeInstanceOf(SyncEngineError);

    // The interrupted scan changed nothing visible: the domain row and binding
    // are untouched and reset stays flagged for the next attempt.
    expect(getWorkflowTemplate(remote.id)?.name).toBe('Remote copy');
    expect(getBinding(SCOPE, ET, remote.id)?.baseRevision).toBe(1);
    expect(getSyncState(SCOPE)?.resetRequired).toBe(true);
    // Staging is durable-but-incomplete; a restarted scan discards it.
    expect(getScanRun(SCOPE)).not.toBeNull();

    restart();
    await cycle(account);
    expect(getSyncState(SCOPE)?.resetRequired).toBe(false);
    expect(getScanRun(SCOPE)).toBeNull();
    expect(listScanStaging(SCOPE)).toEqual([]);
  });

  it('discards incomplete prior staging when a new scan begins', () => {
    beginScanStaging(SCOPE, 'scan-stale', 10);
    stageScanEntities(SCOPE, [
      {
        entityType: ET,
        entityId: 'stale-entity',
        revision: 9,
        schemaVersion: 1,
        payloadJson: '{"stale":true}',
      },
    ]);
    expect(listScanStaging(SCOPE)).toHaveLength(1);

    beginScanStaging(SCOPE, 'scan-fresh', 20);
    expect(listScanStaging(SCOPE)).toEqual([]);
    expect(getScanRun(SCOPE)?.scanId).toBe('scan-fresh');
    expect(getScanRun(SCOPE)?.watermarkStart).toBe(20);
  });

  it('does not activate when the scan cannot finish', async () => {
    activateEnrollment(ENROLLMENT);
    const remote = seedSyncedTemplate('Paged');
    await cycle(account);
    updateSyncState(SCOPE, { resetRequired: true });
    account.injectFailure('sync.scan.finish', 'reject');
    await expect(cycle(account)).rejects.toBeInstanceOf(SyncEngineError);
    expect(getSyncState(SCOPE)?.resetRequired).toBe(true);
    expect(getWorkflowTemplate(remote.id)?.name).toBe('Paged');
  });

  it('does not activate when catch-up pulls fail after scan finish', async () => {
    activateEnrollment(ENROLLMENT);
    const remote = seedSyncedTemplate('Catchup target');
    await cycle(account);
    const baseBefore = getBinding(SCOPE, ET, remote.id)?.baseRevision;

    updateSyncState(SCOPE, { resetRequired: true });
    account.injectFailure('sync.pull', 'reject');
    await expect(cycle(account)).rejects.toBeInstanceOf(SyncEngineError);

    // Cursor is only written on successful activation; staging survives for
    // diagnosis but nothing became visible or was cleared prematurely.
    expect(getSyncState(SCOPE)?.resetRequired).toBe(true);
    expect(getBinding(SCOPE, ET, remote.id)?.baseRevision).toBe(baseBefore);
    expect(getScanRun(SCOPE)).not.toBeNull();

    restart();
    await cycle(account);
    expect(getSyncState(SCOPE)?.resetRequired).toBe(false);
  });

  it('aborts when the backend epoch rotates mid-scan', async () => {
    activateEnrollment(ENROLLMENT);
    seedSyncedTemplate('Epoch probe');
    await cycle(account);

    updateSyncState(SCOPE, { resetRequired: true });
    const rotateAfterLastPage: SyncEngineRpc = async <R = unknown>(
      connection: Pick<BackendConnection, 'apiUrl'>,
      operation: string,
      params: unknown,
      token: string,
    ): Promise<RpcResult<R>> => {
      const response = await injectRpc(account)<R>(connection, operation, params, token);
      if (operation === 'sync.scan.page') {
        const page = response.result as unknown as SyncScanPageResult;
        if (page.done) {
          account.rotateEpoch('spike-epoch-2');
        }
      }
      return response;
    };
    await expect(cycle(account, { rpc: rotateAfterLastPage })).rejects.toBeInstanceOf(
      SyncEngineError,
    );
    // Finish observed the rotated epoch: no activation, reset still flagged.
    expect(getSyncState(SCOPE)?.resetRequired).toBe(true);
  });
});

describe('scope isolation and guard fencing', () => {
  it('writes nothing when the scope is superseded while a push is in flight', async () => {
    activateEnrollment(ENROLLMENT);
    const saved = seedSyncedTemplate('Guarded');
    let current = true;
    const flipDuringPush: SyncEngineRpc = async <R = unknown>(
      connection: Pick<BackendConnection, 'apiUrl'>,
      operation: string,
      params: unknown,
      token: string,
    ): Promise<RpcResult<R>> => {
      const response = await injectRpc(account)<R>(connection, operation, params, token);
      if (operation === 'sync.push') {
        // The account/backend switch lands between dispatch and response.
        current = false;
      }
      return response;
    };
    await expect(cycle(account, { guard: () => current, rpc: flipDuringPush })).rejects
      .toBeInstanceOf(SyncEngineError);

    // The acknowledgement arrived for the dead scope: it was NOT applied.
    const row = listOutboxRows(SCOPE).find((item) => item.entityId === saved.id);
    expect(row?.state).toBe('dispatched');
    expect(getBinding(SCOPE, ET, saved.id)?.baseRevision).toBeNull();
    expect(getWorkflowTemplate(saved.id)).not.toBeNull();

    // Nothing is lost: the same row replays and resolves under the live scope.
    current = true;
    restart();
    await cycle(account);
    expect(listOutboxRows(SCOPE)[0]?.state).toBe('acknowledged');
  });

  it('refuses to start a cycle when the guard is already superseded', async () => {
    activateEnrollment(ENROLLMENT);
    seedSyncedTemplate('Never sent');
    const ops: string[] = [];
    await expect(
      cycle(account, {
        guard: () => false,
        rpc: (connection, operation, params, token) => {
          ops.push(operation);
          return injectRpc(account)(connection, operation, params, token);
        },
      }),
    ).rejects.toBeInstanceOf(SyncEngineError);
    expect(ops).toEqual([]);
    // Not even the durable dispatch marking happened under the dead scope.
    expect(listOutboxRows(SCOPE)[0]?.state).toBe('pending');
  });

  it('keeps outbox, bindings, and cursors isolated between two account scopes', async () => {
    activateEnrollment(ENROLLMENT, SCOPE);
    activateEnrollment('enrollment-b', OTHER_SCOPE);
    const aOwned = saveWorkflowTemplate(templateInput('A owned'));
    upsertBinding(SCOPE, ET, aOwned.id);
    recordLocalChange(SCOPE, {
      entityId: aOwned.id,
      entityType: ET,
      operation: 'create',
      payload: templatePayload(aOwned.id, 'A owned'),
      schemaVersion: 1,
    });
    const bOwned = saveWorkflowTemplate(templateInput('B owned'));
    upsertBinding(OTHER_SCOPE, ET, bOwned.id);
    recordLocalChange(OTHER_SCOPE, {
      entityId: bOwned.id,
      entityType: ET,
      operation: 'create',
      payload: templatePayload(bOwned.id, 'B owned'),
      schemaVersion: 1,
    });

    await cycle(account, { enrollmentId: ENROLLMENT, scope: SCOPE });

    // A's scope resolved; B's row is untouched and never left its scope.
    const aRows = listOutboxRows(SCOPE);
    const bRows = listOutboxRows(OTHER_SCOPE);
    expect(aRows.every((row) => row.state === 'acknowledged')).toBe(true);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].state).toBe('pending');
    expect(bRows[0].entityId).toBe(bOwned.id);
    expect(getBinding(OTHER_SCOPE, ET, bOwned.id)?.baseRevision).toBeNull();
    // A cursor state exists under A's scope only.
    expect(getSyncState(SCOPE)?.cursor).not.toBeNull();
    expect(getSyncState(OTHER_SCOPE)).toBeNull();
  });
});
