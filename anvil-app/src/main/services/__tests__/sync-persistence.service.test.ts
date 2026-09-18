import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION } from '../../db/schema';
import { DEFAULT_ORCHESTRATION } from '../../../shared/workflow-orchestration';
import type { WorkflowNode } from '../../../shared/types';
import {
  SYNC_ENTITY_WORKFLOW_TEMPLATE,
  type RecordLocalChangeInput,
  type SyncScope,
} from '../../../shared/sync-mesh';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../persona.service.js', () => ({
  getPersonaById: (id: string) => (id === 'coder' ? { id } : null),
  buildSystemPrompt: () => '',
}));

import {
  applyPushResults,
  canonicalJson,
  clearSyncEntitlement,
  computePayloadHash,
  getActiveEnrollment,
  getBinding,
  getSyncEntitlement,
  getSyncState,
  hasActiveBinding,
  insertUnresolvedConflict,
  listConflicts,
  listOutboxRows,
  listSyncScopesForEntity,
  nextBatch,
  recordLocalChange,
  resolveConflict,
  revokeEnrollment,
  sweepLocalSyncRetention,
  updateSyncState,
  upsertBinding,
  upsertEnrollment,
  upsertSyncEntitlement,
  withSyncedEntityWrite,
} from '../sync-persistence.service';
import {
  deleteWorkflowTemplate,
  getWorkflowTemplate,
  saveWorkflowTemplate,
} from '../workflow.service';
import { getDb } from '../../db/database.js';

const SCOPE: SyncScope = { backendId: 'backend-1', accountId: 'account-1', datasetEpoch: '1' };
const ET = SYNC_ENTITY_WORKFLOW_TEMPLATE;

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
    description: 'Sync test workflow',
    orchestration: { ...DEFAULT_ORCHESTRATION },
    nodes: [node('step-1')],
    edges: [],
  };
}

function activateEnrollment(id = 'enrollment-1'): void {
  upsertEnrollment({
    displayName: 'Test device',
    id,
    installationId: 'installation-1',
    scope: SCOPE,
    state: 'active',
  });
}

function change(input: RecordLocalChangeInput): string | null {
  return getDb().transaction(() => recordLocalChange(SCOPE, input))();
}

function applyMigrationSql(target: Database.Database, migration: string): void {
  for (const statement of migration
    .replace(/^[ \t]*--[^\r\n]*/gm, '')
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)) {
    target.exec(statement);
  }
}

beforeEach(() => {
  db.exec(
    `DELETE FROM sync_outbox; DELETE FROM sync_bindings; DELETE FROM sync_conflicts;
     DELETE FROM sync_state; DELETE FROM device_enrollments; DELETE FROM workflow_templates;
     DELETE FROM sync_scan_runs; DELETE FROM sync_scan_staging; DELETE FROM sync_installation;
     DELETE FROM sync_backends; DELETE FROM sync_entitlement; DELETE FROM sync_keyring;
     DELETE FROM sync_device_keys; DELETE FROM sync_pairing; DELETE FROM sync_keyring_deliveries;`,
  );
});

describe('schema migrations', () => {
  it('leaves SCHEMA_VERSION at the current schema after later packets', () => {
    expect(SCHEMA_VERSION).toBe(84);
  });

  it('migration 70 adds the sequence allocator, review flag, and scan staging', () => {
    const fresh = new Database(':memory:');
    try {
      applyMigrationSql(fresh, MIGRATIONS[68]);
      applyMigrationSql(fresh, MIGRATIONS[69]);
      applyMigrationSql(fresh, MIGRATIONS[70]);
      const enrollmentColumns = new Set(
        (
          fresh.prepare('PRAGMA table_info(device_enrollments)').all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
      expect(enrollmentColumns.has('next_sequence')).toBe(true);
      const backendColumns = new Set(
        (fresh.prepare('PRAGMA table_info(sync_backends)').all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      );
      expect(backendColumns.has('identity_review_required')).toBe(true);
      const tables = new Set(
        (
          fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      );
      for (const table of ['sync_installation', 'sync_scan_runs', 'sync_scan_staging']) {
        expect(tables.has(table), `Missing table ${table}`).toBe(true);
      }
    } finally {
      fresh.close();
    }
  });

  it('creates the five sync tables from the migration SQL alone', () => {
    const fresh = new Database(':memory:');
    try {
      applyMigrationSql(fresh, MIGRATIONS[68]);
      // Re-running is a safe no-op.
      applyMigrationSql(fresh, MIGRATIONS[68]);
      const tables = new Set(
        (
          fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      );
      for (const table of [
        'device_enrollments',
        'sync_bindings',
        'sync_outbox',
        'sync_state',
        'sync_conflicts',
      ]) {
        expect(tables.has(table), `Missing table ${table}`).toBe(true);
      }
      const outboxColumns = new Set(
        (fresh.prepare('PRAGMA table_info(sync_outbox)').all() as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      );
      for (const column of ['change_id', 'enrollment_sequence', 'payload_hash', 'result_json']) {
        expect(outboxColumns.has(column), `Missing sync_outbox.${column}`).toBe(true);
      }
    } finally {
      fresh.close();
    }
  });
});

describe('enrollments', () => {
  it('returns the active enrollment and honours revocation', () => {
    expect(getActiveEnrollment(SCOPE)).toBeNull();
    activateEnrollment();
    expect(getActiveEnrollment(SCOPE)?.id).toBe('enrollment-1');
    revokeEnrollment('enrollment-1');
    expect(getActiveEnrollment(SCOPE)).toBeNull();
  });

  it('rejects revoking an unknown enrollment', () => {
    expect(() => revokeEnrollment('missing')).toThrow('Unknown enrollment');
  });
});

describe('bindings and scopes', () => {
  it('treats entities without bindings as unsynced', () => {
    expect(hasActiveBinding(SCOPE, ET, 'ghost')).toBe(false);
    expect(listSyncScopesForEntity(ET, 'ghost')).toEqual([]);
  });

  it('lists scopes once a binding exists', () => {
    upsertBinding(SCOPE, ET, 'tpl-1');
    expect(hasActiveBinding(SCOPE, ET, 'tpl-1')).toBe(true);
    expect(listSyncScopesForEntity(ET, 'tpl-1')).toEqual([SCOPE]);
  });
});

describe('recordLocalChange coalescing', () => {
  it('coalesces two saves into one pending create with the latest payload', () => {
    activateEnrollment();
    upsertBinding(SCOPE, ET, 'e1');
    const first = change({
      entityId: 'e1',
      entityType: ET,
      operation: 'create',
      payload: { v: 1 },
      schemaVersion: 1,
    });
    const second = change({
      entityId: 'e1',
      entityType: ET,
      operation: 'update',
      payload: { v: 2 },
      schemaVersion: 1,
    });
    expect(second).toBe(first);
    const rows = listOutboxRows(SCOPE);
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe('create');
    expect(rows[0].payloadJson).toBe(canonicalJson({ v: 2 }));
    expect(getBinding(SCOPE, ET, 'e1')?.localEditGeneration).toBe(2);
  });

  it('removes the pending row when a create is deleted before dispatch', () => {
    activateEnrollment();
    upsertBinding(SCOPE, ET, 'e2');
    change({
      entityId: 'e2',
      entityType: ET,
      operation: 'create',
      payload: { v: 1 },
      schemaVersion: 1,
    });
    expect(
      change({ entityId: 'e2', entityType: ET, operation: 'delete', schemaVersion: 1 }),
    ).toBeNull();
    expect(listOutboxRows(SCOPE)).toEqual([]);
  });

  it('turns an update followed by delete into a single delete', () => {
    activateEnrollment();
    upsertBinding(SCOPE, ET, 'e3', { basePayloadJson: canonicalJson({ v: 0 }), baseRevision: 5 });
    change({
      entityId: 'e3',
      entityType: ET,
      operation: 'update',
      payload: { v: 1 },
      schemaVersion: 1,
    });
    change({ entityId: 'e3', entityType: ET, operation: 'delete', schemaVersion: 1 });
    const rows = listOutboxRows(SCOPE);
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe('delete');
    expect(rows[0].payloadJson).toBeNull();
    expect(rows[0].baseRevision).toBe(5);
  });

  it('records a create when an already-saved template is bound then saved again', () => {
    activateEnrollment();
    const saved = saveWorkflowTemplate(templateInput('Existing'));
    expect(listOutboxRows(SCOPE)).toEqual([]);
    upsertBinding(SCOPE, ET, saved.id);
    saveWorkflowTemplate({ ...templateInput('Existing renamed') }, saved.id);
    const rows = listOutboxRows(SCOPE);
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe('create');
    expect(rows[0].baseRevision).toBeNull();
  });

  it('leaves the dispatched row untouched and adds a pending successor', () => {
    activateEnrollment();
    upsertBinding(SCOPE, ET, 'e4');
    const dispatchedId = change({
      entityId: 'e4',
      entityType: ET,
      operation: 'create',
      payload: { v: 1 },
      schemaVersion: 1,
    });
    const [dispatched] = nextBatch(SCOPE, 'enrollment-1');
    expect(dispatched.changeId).toBe(dispatchedId);
    const successorId = change({
      entityId: 'e4',
      entityType: ET,
      operation: 'update',
      payload: { v: 2 },
      schemaVersion: 1,
    });
    expect(successorId).not.toBe(dispatchedId);
    const rows = listOutboxRows(SCOPE);
    expect(rows).toHaveLength(2);
    const dispatchedRow = rows.find((row) => row.changeId === dispatchedId);
    expect(dispatchedRow?.state).toBe('dispatched');
    expect(dispatchedRow?.payloadJson).toBe(canonicalJson({ v: 1 }));
    const successor = rows.find((row) => row.changeId === successorId);
    expect(successor?.state).toBe('pending');
    expect(successor?.baseRevision).toBeNull();
    // An undelivered dispatch replays verbatim: same change, sequence, hash —
    // the pending successor waits behind it.
    const replay = nextBatch(SCOPE, 'enrollment-1');
    expect(replay).toHaveLength(1);
    expect(replay[0].changeId).toBe(dispatchedId);
    expect(replay[0].enrollmentSequence).toBe(dispatched.enrollmentSequence);
    expect(replay[0].payloadHash).toBe(dispatched.payloadHash);
  });
});

describe('workflow template sync integration', () => {
  it('produces zero outbox rows for unsynced templates', () => {
    activateEnrollment();
    const saved = saveWorkflowTemplate(templateInput('Unsynced'));
    expect(getWorkflowTemplate(saved.id)?.name).toBe('Unsynced');
    deleteWorkflowTemplate(saved.id);
    expect(getWorkflowTemplate(saved.id)).toBeNull();
    expect(listOutboxRows(SCOPE)).toEqual([]);
  });

  it('records a create when a bound existing template is saved, then cancels it on delete', () => {
    activateEnrollment();
    const saved = saveWorkflowTemplate(templateInput('Original'));
    expect(listOutboxRows(SCOPE)).toEqual([]);
    upsertBinding(SCOPE, ET, saved.id);
    saveWorkflowTemplate({ ...templateInput('Renamed') }, saved.id);
    const rows = listOutboxRows(SCOPE);
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe('create');
    expect(rows[0].payloadJson).toContain('Renamed');
    expect(rows[0].schemaVersion).toBe(1);
    deleteWorkflowTemplate(saved.id);
    expect(listOutboxRows(SCOPE)).toEqual([]);
    expect(getWorkflowTemplate(saved.id)).toBeNull();
  });

  it('commits neither the template nor the outbox row when the transaction fails', () => {
    activateEnrollment();
    upsertBinding(SCOPE, ET, 'tpl-boom');
    const timestamp = new Date().toISOString();
    const graphJson = JSON.stringify({ nodes: [], edges: [] });
    expect(() =>
      getDb().transaction(() => {
        withSyncedEntityWrite(
          ET,
          'tpl-boom',
          1,
          'create',
          () => {
            throw new Error('boom');
          },
          () => {
            db.prepare(
              'INSERT INTO workflow_templates (id, name, description, graph_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
            ).run('tpl-boom', 'Boom', '', graphJson, timestamp, timestamp);
          },
        );
      })(),
    ).toThrow('boom');
    expect(getWorkflowTemplate('tpl-boom')).toBeNull();
    expect(listOutboxRows(SCOPE)).toEqual([]);
  });

  it('commits both together on success', () => {
    activateEnrollment();
    upsertBinding(SCOPE, ET, 'tpl-ok');
    const timestamp = new Date().toISOString();
    getDb().transaction(() => {
      withSyncedEntityWrite(
        ET,
        'tpl-ok',
        1,
        'create',
        () => ({ id: 'tpl-ok' }),
        () => {
          db.prepare(
            'INSERT INTO workflow_templates (id, name, description, graph_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          ).run('tpl-ok', 'Ok', '', JSON.stringify({ nodes: [], edges: [] }), timestamp, timestamp);
        },
      );
    })();
    expect(getWorkflowTemplate('tpl-ok')?.name).toBe('Ok');
    expect(listOutboxRows(SCOPE)).toHaveLength(1);
  });
});

describe('nextBatch', () => {
  it('dispatches one change per entity with strictly increasing sequences', () => {
    activateEnrollment();
    for (const id of ['a', 'b', 'c']) {
      upsertBinding(SCOPE, ET, id);
      change({
        entityId: id,
        entityType: ET,
        operation: 'create',
        payload: { id },
        schemaVersion: 1,
      });
    }
    const first = nextBatch(SCOPE, 'enrollment-1', { maxChanges: 1 });
    expect(first.map((item) => item.entityId)).toEqual(['a']);
    // Acknowledge the dispatched row so the next batch moves past it.
    applyPushResults(SCOPE, [{ changeId: first[0].changeId, revision: 1, status: 'accepted' }]);
    const rest = nextBatch(SCOPE, 'enrollment-1');
    expect(rest.map((item) => item.entityId)).toEqual(['b', 'c']);
    const sequences = [...first, ...rest].map((item) => item.enrollmentSequence);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(new Set(sequences).size).toBe(3);
  });

  it('respects the byte budget', () => {
    activateEnrollment();
    for (const id of ['a', 'b']) {
      upsertBinding(SCOPE, ET, id);
      change({
        entityId: id,
        entityType: ET,
        operation: 'create',
        payload: { id },
        schemaVersion: 1,
      });
    }
    // Serialized request bytes are budgeted: each change carries ~250 bytes of
    // identity/hash overhead, so 400 fits exactly one.
    const limited = nextBatch(SCOPE, 'enrollment-1', { maxBytes: 400 });
    expect(limited.map((item) => item.entityId)).toEqual(['a']);
    applyPushResults(SCOPE, [{ changeId: limited[0].changeId, revision: 1, status: 'accepted' }]);
    const remainder = nextBatch(SCOPE, 'enrollment-1');
    expect(remainder.map((item) => item.entityId)).toEqual(['b']);
  });

  it('rejects an entity that can never fit the negotiated limits without blocking others', () => {
    activateEnrollment();
    upsertBinding(SCOPE, ET, 'big');
    upsertBinding(SCOPE, ET, 'small');
    change({
      entityId: 'big',
      entityType: ET,
      operation: 'create',
      payload: { blob: 'x'.repeat(5000) },
      schemaVersion: 1,
    });
    change({
      entityId: 'small',
      entityType: ET,
      operation: 'create',
      payload: { id: 'small' },
      schemaVersion: 1,
    });
    const batch = nextBatch(SCOPE, 'enrollment-1', { entityBytes: 1000 });
    expect(batch.map((item) => item.entityId)).toEqual(['small']);
    const rows = listOutboxRows(SCOPE);
    const bigRow = rows.find((row) => row.entityId === 'big');
    expect(bigRow?.state).toBe('rejected');
    expect(bigRow?.resultJson).toContain('entity-too-large');
    // The rejection does not poison the batch: the small entity dispatched.
    expect(rows.find((row) => row.entityId === 'small')?.state).toBe('dispatched');
  });

  it('returns parsed payloads with matching hashes', () => {
    activateEnrollment();
    upsertBinding(SCOPE, ET, 'e');
    change({
      entityId: 'e',
      entityType: ET,
      operation: 'create',
      payload: { v: 1 },
      schemaVersion: 1,
    });
    const [item] = nextBatch(SCOPE, 'enrollment-1');
    expect(item.payload).toEqual({ v: 1 });
    expect(item.baseRevision).toBeNull();
    expect(item.payloadHash).toBe(
      computePayloadHash({
        baseRevision: null,
        entityId: 'e',
        entityType: ET,
        operation: 'create',
        payload: { v: 1 },
        schemaVersion: 1,
      }),
    );
  });
});

describe('applyPushResults', () => {
  it('advances the base and unblocks the pending successor on accept', () => {
    activateEnrollment();
    upsertBinding(SCOPE, ET, 'e');
    change({
      entityId: 'e',
      entityType: ET,
      operation: 'create',
      payload: { v: 1 },
      schemaVersion: 1,
    });
    const [dispatched] = nextBatch(SCOPE, 'enrollment-1');
    change({
      entityId: 'e',
      entityType: ET,
      operation: 'update',
      payload: { v: 2 },
      schemaVersion: 1,
    });
    applyPushResults(SCOPE, [{ changeId: dispatched.changeId, revision: 7, status: 'accepted' }]);
    const binding = getBinding(SCOPE, ET, 'e');
    expect(binding?.baseRevision).toBe(7);
    expect(binding?.basePayloadJson).toBe(canonicalJson({ v: 1 }));
    expect(binding?.acknowledgedGeneration).toBe(1);
    const rows = listOutboxRows(SCOPE);
    expect(rows.find((row) => row.changeId === dispatched.changeId)?.state).toBe('acknowledged');
    const successor = rows.find((row) => row.state === 'pending');
    expect(successor?.payloadJson).toBe(canonicalJson({ v: 2 }));
    // The successor's base and hash are derived at dispatch time: it dispatches
    // rebased onto revision 7 with a hash the backend verifier accepts.
    const [next] = nextBatch(SCOPE, 'enrollment-1');
    expect(next.changeId).toBe(successor?.changeId);
    expect(next.baseRevision).toBe(7);
    expect(next.operation).toBe('update');
    expect(next.payloadHash).toBe(
      computePayloadHash({
        baseRevision: 7,
        entityId: 'e',
        entityType: ET,
        operation: 'update',
        payload: { v: 2 },
        schemaVersion: 1,
      }),
    );
  });

  it('preserves base, local, and remote on conflict and blocks only that entity', () => {
    activateEnrollment();
    upsertBinding(SCOPE, ET, 'e1', { basePayloadJson: canonicalJson({ v: 0 }), baseRevision: 4 });
    upsertBinding(SCOPE, ET, 'e2');
    change({
      entityId: 'e1',
      entityType: ET,
      operation: 'update',
      payload: { v: 1 },
      schemaVersion: 1,
    });
    change({
      entityId: 'e2',
      entityType: ET,
      operation: 'create',
      payload: { w: 1 },
      schemaVersion: 1,
    });
    const batch = nextBatch(SCOPE, 'enrollment-1', { maxChanges: 1 });
    expect(batch.map((item) => item.entityId)).toEqual(['e1']);
    const e1Change = batch.find((item) => item.entityId === 'e1');
    applyPushResults(SCOPE, [
      {
        changeId: e1Change!.changeId,
        remotePayload: { v: 9 },
        remoteRevision: 6,
        status: 'conflict',
      },
    ]);
    const conflicts = listConflicts(SCOPE);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('edit-edit');
    expect(conflicts[0].basePayloadJson).toBe(canonicalJson({ v: 0 }));
    expect(conflicts[0].localPayloadJson).toBe(canonicalJson({ v: 1 }));
    expect(conflicts[0].remotePayloadJson).toBe(canonicalJson({ v: 9 }));
    expect(conflicts[0].remoteRevision).toBe(6);
    // Only the conflicted entity is blocked; e2 still dispatches.
    const next = nextBatch(SCOPE, 'enrollment-1');
    expect(next.map((item) => item.entityId)).toEqual(['e2']);
    // Resolving unblocks the entity for its next conditional mutation.
    resolveConflict(conflicts[0].id, 'keep-local');
    expect(listConflicts(SCOPE)).toEqual([]);
    change({
      entityId: 'e1',
      entityType: ET,
      operation: 'update',
      payload: { v: 10 },
      schemaVersion: 1,
    });
    // e2's earlier dispatch is still outstanding, so it replays first.
    const replay = nextBatch(SCOPE, 'enrollment-1');
    expect(replay.map((item) => item.entityId)).toEqual(['e2']);
    applyPushResults(SCOPE, [{ changeId: replay[0].changeId, revision: 7, status: 'accepted' }]);
    const retry = nextBatch(SCOPE, 'enrollment-1');
    expect(retry.map((item) => item.entityId)).toEqual(['e1']);
    expect(() => resolveConflict(conflicts[0].id, 'use-remote')).toThrow('already resolved');
  });

  it('records rejections without advancing the base', () => {
    activateEnrollment();
    upsertBinding(SCOPE, ET, 'e');
    change({
      entityId: 'e',
      entityType: ET,
      operation: 'create',
      payload: { v: 1 },
      schemaVersion: 1,
    });
    const [dispatched] = nextBatch(SCOPE, 'enrollment-1');
    applyPushResults(SCOPE, [{ changeId: dispatched.changeId, status: 'rejected' }]);
    const rows = listOutboxRows(SCOPE);
    expect(rows[0].state).toBe('rejected');
    expect(rows[0].resultJson).toContain('rejected');
    expect(getBinding(SCOPE, ET, 'e')?.baseRevision).toBeNull();
  });

  it('flags reset-required and receipt-expired as terminal rejections on sync state', () => {
    activateEnrollment();
    upsertBinding(SCOPE, ET, 'e');
    change({
      entityId: 'e',
      entityType: ET,
      operation: 'create',
      payload: { v: 1 },
      schemaVersion: 1,
    });
    const [dispatched] = nextBatch(SCOPE, 'enrollment-1');
    applyPushResults(SCOPE, [{ changeId: dispatched.changeId, status: 'reset-required' }]);
    const rows = listOutboxRows(SCOPE);
    // The receipt is terminal: the row is rejected with its reason preserved so
    // replay cannot resurrect a mutation the server already declined.
    expect(rows[0].state).toBe('rejected');
    expect(rows[0].resultJson).toContain('reset-required');
    expect(getSyncState(SCOPE)?.resetRequired).toBe(true);
    expect(getBinding(SCOPE, ET, 'e')?.localEditGeneration).toBeGreaterThan(
      getBinding(SCOPE, ET, 'e')?.acknowledgedGeneration ?? -1,
    );
  });

  it('rejects results for unknown changes', () => {
    expect(() => applyPushResults(SCOPE, [{ changeId: 'missing', status: 'accepted' }])).toThrow(
      'Unknown change',
    );
  });
});

describe('nextBatch sealing', () => {
  const fakeEnvelope = { enc: 'aes-256-gcm', keyVersion: 1, nonce: 'AA==', ct: 'BB==' };

  it('dispatches the sealed wire payload and hashes the envelope, not the plaintext', () => {
    activateEnrollment();
    upsertBinding(SCOPE, ET, 'e');
    change({
      entityId: 'e',
      entityType: ET,
      operation: 'create',
      payload: { v: 1 },
      schemaVersion: 1,
    });
    const [item] = nextBatch(SCOPE, 'enrollment-1', {
      seal: () => fakeEnvelope,
    });
    expect(item.payload).toEqual(fakeEnvelope);
    const row = listOutboxRows(SCOPE)[0];
    expect(row.sealedJson).toBe(canonicalJson(fakeEnvelope));
    expect(row.payloadHash).toBe(
      computePayloadHash({
        baseRevision: null,
        entityId: 'e',
        entityType: ET,
        operation: 'create',
        payload: fakeEnvelope,
        schemaVersion: 1,
      }),
    );
    // The local source payload stays plaintext for conflict/merge logic.
    expect(row.payloadJson).toBe(canonicalJson({ v: 1 }));
  });

  it('replays the identical sealed ciphertext and hash on redispatch', () => {
    activateEnrollment();
    upsertBinding(SCOPE, ET, 'e');
    change({
      entityId: 'e',
      entityType: ET,
      operation: 'create',
      payload: { v: 1 },
      schemaVersion: 1,
    });
    let calls = 0;
    const seal = () => {
      calls += 1;
      return { ...fakeEnvelope, nonce: `nonce-${calls}` };
    };
    const first = nextBatch(SCOPE, 'enrollment-1', { seal });
    // An unacked dispatched row replays through nextBatch — the stored
    // sealed_json wins, so the seal hook is never invoked again and the
    // wire payload (and its hash) is byte-identical to the first attempt.
    const replay = nextBatch(SCOPE, 'enrollment-1', { seal });
    expect(calls).toBe(1);
    expect(replay[0].payload).toEqual(first[0].payload);
    expect(replay[0].payloadHash).toBe(first[0].payloadHash);
  });

  it('defers the row instead of sending plaintext when the seal hook declines', () => {
    activateEnrollment();
    upsertBinding(SCOPE, ET, 'e');
    change({
      entityId: 'e',
      entityType: ET,
      operation: 'create',
      payload: { v: 1 },
      schemaVersion: 1,
    });
    const batch = nextBatch(SCOPE, 'enrollment-1', { seal: () => undefined });
    expect(batch).toEqual([]);
    expect(listOutboxRows(SCOPE)[0].state).toBe('pending');
  });

  it('does not invoke the seal hook for deletes', () => {
    activateEnrollment();
    upsertBinding(SCOPE, ET, 'e');
    getDb().prepare("UPDATE sync_bindings SET base_revision = 3 WHERE entity_id = 'e'").run();
    change({ entityId: 'e', entityType: ET, operation: 'delete', schemaVersion: 1 });
    const seal = vi.fn(() => fakeEnvelope);
    const [item] = nextBatch(SCOPE, 'enrollment-1', { seal });
    expect(seal).not.toHaveBeenCalled();
    expect(item.operation).toBe('delete');
    expect(item.payload).toBeUndefined();
  });
});

describe('sync state', () => {
  it('upserts cursor and watermarks', () => {
    expect(getSyncState(SCOPE)).toBeNull();
    const created = updateSyncState(SCOPE, {
      consumedSequenceHighWater: 5,
      cursor: 'cursor-1',
      protocolVersion: '1',
    });
    expect(created.cursor).toBe('cursor-1');
    expect(created.consumedSequenceHighWater).toBe(5);
    expect(created.resetRequired).toBe(false);
    const updated = updateSyncState(SCOPE, { lastPullAt: '2026-09-11T00:00:00.000Z' });
    expect(updated.cursor).toBe('cursor-1');
    expect(updated.lastPullAt).toBe('2026-09-11T00:00:00.000Z');
  });
});

describe('payload hashing', () => {
  it('is deterministic regardless of payload key order', () => {
    const first = computePayloadHash({
      baseRevision: 3,
      entityId: 'e',
      entityType: ET,
      operation: 'update',
      payload: { b: 1, a: 2 },
      schemaVersion: 1,
    });
    const second = computePayloadHash({
      baseRevision: 3,
      entityId: 'e',
      entityType: ET,
      operation: 'update',
      payload: { a: 2, b: 1 },
      schemaVersion: 1,
    });
    expect(second).toBe(first);
    expect(
      computePayloadHash({
        baseRevision: 3,
        entityId: 'e',
        entityType: ET,
        operation: 'update',
        payload: { a: 2, b: 999 },
        schemaVersion: 1,
      }),
    ).not.toBe(first);
  });

  it('canonicalizes nested objects with sorted keys', () => {
    expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
  });
});

describe('local retention sweep (OPS-01)', () => {
  const OLD = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();

  it('compacts terminal outbox rows and resolved conflicts, never mutable rows', () => {
    activateEnrollment();
    const acked = saveWorkflowTemplate(templateInput('Old acknowledged'));
    change({
      entityType: ET,
      entityId: acked.id,
      operation: 'create',
      payload: { name: 'Old acknowledged' },
      schemaVersion: 1,
    });
    db.prepare(
      `UPDATE sync_outbox SET state = 'acknowledged', created_at = ? WHERE entity_id = ?`,
    ).run(OLD, acked.id);

    const pending = saveWorkflowTemplate(templateInput('Old but pending'));
    change({
      entityType: ET,
      entityId: pending.id,
      operation: 'create',
      payload: { name: 'Old but pending' },
      schemaVersion: 1,
    });
    db.prepare(`UPDATE sync_outbox SET created_at = ? WHERE entity_id = ?`).run(OLD, pending.id);

    const resolved = insertUnresolvedConflict(SCOPE, {
      entityType: ET,
      entityId: 'tpl-resolved',
      kind: 'edit-edit',
      basePayloadJson: '{"name":"base"}',
      baseRevision: 1,
      localPayloadJson: '{"name":"local"}',
      remotePayloadJson: '{"name":"remote"}',
      remoteRevision: 2,
    });
    resolveConflict(resolved.id, 'use-remote');
    db.prepare(`UPDATE sync_conflicts SET resolved_at = ? WHERE id = ?`).run(OLD, resolved.id);

    const open = insertUnresolvedConflict(SCOPE, {
      entityType: ET,
      entityId: 'tpl-open',
      kind: 'edit-edit',
      basePayloadJson: '{"name":"base"}',
      baseRevision: 1,
      localPayloadJson: '{"name":"local"}',
      remotePayloadJson: '{"name":"remote"}',
      remoteRevision: 3,
    });
    db.prepare(`UPDATE sync_conflicts SET created_at = ? WHERE id = ?`).run(OLD, open.id);

    const swept = sweepLocalSyncRetention();
    expect(swept.outboxRows).toBe(1);
    expect(swept.conflicts).toBe(1);

    // Mutable state survives: the aged pending row and the unresolved conflict.
    const remaining = listOutboxRows(SCOPE);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.entityId).toBe(pending.id);
    expect(listConflicts(SCOPE).map((conflict) => conflict.id)).toEqual([open.id]);
  });
});

describe('sync entitlement (BILL-05)', () => {
  const ENTITLEMENT = {
    backendId: 'backend-1',
    accountId: 'account-1',
    state: 'preview',
    source: 'preview',
    planKey: null,
    previewEndsAt: '2026-11-01T00:00:00Z',
    accessUntil: null,
    graceUntil: null,
    checkedAt: '2026-09-11T10:00:00Z',
    revision: 3,
    reason: 'preview',
    restricted: false,
  };

  it('round-trips an upserted row including nulls and the restricted flag', () => {
    const stored = upsertSyncEntitlement(ENTITLEMENT);
    expect(stored.updatedAt).toBeTruthy();

    const read = getSyncEntitlement('backend-1', 'account-1');
    expect(read).toMatchObject({
      ...ENTITLEMENT,
      restricted: false,
    });

    upsertSyncEntitlement({
      ...ENTITLEMENT,
      state: 'restricted',
      source: 'none',
      reason: 'subscription-required',
      restricted: true,
      revision: 4,
    });
    const paused = getSyncEntitlement('backend-1', 'account-1');
    expect(paused?.state).toBe('restricted');
    expect(paused?.restricted).toBe(true);
    expect(paused?.reason).toBe('subscription-required');
    expect(paused?.revision).toBe(4);
  });

  it('returns null for a missing row and clears by (backend, account)', () => {
    expect(getSyncEntitlement('backend-1', 'account-1')).toBeNull();
    upsertSyncEntitlement(ENTITLEMENT);
    clearSyncEntitlement('backend-1', 'account-1');
    expect(getSyncEntitlement('backend-1', 'account-1')).toBeNull();
  });

  it('keeps the same account on a different backend isolated', () => {
    upsertSyncEntitlement(ENTITLEMENT);
    upsertSyncEntitlement({ ...ENTITLEMENT, backendId: 'backend-2', restricted: true });

    clearSyncEntitlement('backend-1', 'account-1');
    expect(getSyncEntitlement('backend-1', 'account-1')).toBeNull();
    const other = getSyncEntitlement('backend-2', 'account-1');
    expect(other?.restricted).toBe(true);
    clearSyncEntitlement('backend-2', 'account-1');
    expect(getSyncEntitlement('backend-2', 'account-1')).toBeNull();
  });
});
