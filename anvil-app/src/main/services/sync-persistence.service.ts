import { createHash, randomUUID } from 'node:crypto';
import {
  SYNC_PUSH_DEFAULTS,
  type DeviceEnrollment,
  type NextBatchOptions,
  type PendingChange,
  type PushResult,
  type RecordLocalChangeInput,
  type SyncBinding,
  type SyncConflict,
  type SyncConflictResolution,
  type SyncEnrollmentState,
  type SyncOperation,
  type SyncOutboxRow,
  type SyncScope,
  type SyncStateRow,
} from '../../shared/sync-mesh.js';
import { getDb } from '../db/database.js';

const SCOPE_WHERE = 'backend_id = ? AND account_id = ? AND dataset_epoch = ?';

function scopeParams(scope: SyncScope): [string, string, string] {
  return [scope.backendId, scope.accountId, scope.datasetEpoch];
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Canonical JSON: sorted object keys recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface PayloadHashInput {
  operation: SyncOperation;
  entityType: string;
  entityId: string;
  schemaVersion: number;
  baseRevision: number | null;
  payload: unknown;
}

/**
 * sha256 over the canonical serialization of all immutable mutation content,
 * including operation, identity, base, and payload.
 */
export function computePayloadHash(input: PayloadHashInput): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        baseRevision: input.baseRevision,
        entityType: input.entityType,
        entityId: input.entityId,
        operation: input.operation,
        payload: input.payload ?? null,
        schemaVersion: input.schemaVersion,
      }),
    )
    .digest('hex');
}

interface EnrollmentRow {
  id: string;
  backend_id: string;
  account_id: string;
  dataset_epoch: string;
  installation_id: string;
  enrollment_generation: number;
  display_name: string;
  state: SyncEnrollmentState;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

interface BindingRow {
  id: string;
  backend_id: string;
  account_id: string;
  dataset_epoch: string;
  entity_type: string;
  entity_id: string;
  base_revision: number | null;
  base_payload_json: string | null;
  local_edit_generation: number;
  acknowledged_generation: number;
  quarantine_json: string | null;
  created_at: string;
  updated_at: string;
}

interface OutboxRow {
  change_id: string;
  backend_id: string;
  account_id: string;
  dataset_epoch: string;
  enrollment_id: string;
  enrollment_sequence: number | null;
  entity_type: string;
  entity_id: string;
  schema_version: number;
  base_revision: number | null;
  operation: SyncOperation;
  payload_json: string | null;
  payload_hash: string;
  local_edit_generation: number;
  state: SyncOutboxRow['state'];
  created_at: string;
  dispatched_at: string | null;
  result_json: string | null;
}

interface SyncStateDbRow {
  backend_id: string;
  account_id: string;
  dataset_epoch: string;
  cursor: string | null;
  last_pull_at: string | null;
  last_push_at: string | null;
  consumed_sequence_high_water: number;
  retention_floor_sequence: number | null;
  protocol_version: string | null;
  server_limits_json: string | null;
  reset_required: number;
  updated_at: string;
}

interface ConflictRow {
  id: string;
  backend_id: string;
  account_id: string;
  dataset_epoch: string;
  entity_type: string;
  entity_id: string;
  base_payload_json: string | null;
  local_payload_json: string | null;
  remote_payload_json: string | null;
  base_revision: number | null;
  remote_revision: number | null;
  kind: SyncConflict['kind'];
  created_at: string;
  resolved_at: string | null;
  resolution: SyncConflict['resolution'];
}

function mapScope(row: { backend_id: string; account_id: string; dataset_epoch: string }): SyncScope {
  return { backendId: row.backend_id, accountId: row.account_id, datasetEpoch: row.dataset_epoch };
}

function mapEnrollment(row: EnrollmentRow): DeviceEnrollment {
  return {
    id: row.id,
    scope: mapScope(row),
    installationId: row.installation_id,
    enrollmentGeneration: row.enrollment_generation,
    displayName: row.display_name,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

function mapBinding(row: BindingRow): SyncBinding {
  return {
    id: row.id,
    scope: mapScope(row),
    entityType: row.entity_type,
    entityId: row.entity_id,
    baseRevision: row.base_revision,
    basePayloadJson: row.base_payload_json,
    localEditGeneration: row.local_edit_generation,
    acknowledgedGeneration: row.acknowledged_generation,
    quarantineJson: row.quarantine_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOutboxRow(row: OutboxRow): SyncOutboxRow {
  return {
    changeId: row.change_id,
    scope: mapScope(row),
    enrollmentId: row.enrollment_id,
    enrollmentSequence: row.enrollment_sequence,
    entityType: row.entity_type,
    entityId: row.entity_id,
    schemaVersion: row.schema_version,
    baseRevision: row.base_revision,
    operation: row.operation,
    payloadJson: row.payload_json,
    payloadHash: row.payload_hash,
    localEditGeneration: row.local_edit_generation,
    state: row.state,
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    resultJson: row.result_json,
  };
}

function mapSyncState(row: SyncStateDbRow): SyncStateRow {
  return {
    scope: mapScope(row),
    cursor: row.cursor,
    lastPullAt: row.last_pull_at,
    lastPushAt: row.last_push_at,
    consumedSequenceHighWater: row.consumed_sequence_high_water,
    retentionFloorSequence: row.retention_floor_sequence,
    protocolVersion: row.protocol_version,
    serverLimitsJson: row.server_limits_json,
    resetRequired: row.reset_required === 1,
    updatedAt: row.updated_at,
  };
}

function mapConflict(row: ConflictRow): SyncConflict {
  return {
    id: row.id,
    scope: mapScope(row),
    entityType: row.entity_type,
    entityId: row.entity_id,
    basePayloadJson: row.base_payload_json,
    localPayloadJson: row.local_payload_json,
    remotePayloadJson: row.remote_payload_json,
    baseRevision: row.base_revision,
    remoteRevision: row.remote_revision,
    kind: row.kind,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
  };
}

export function getActiveEnrollment(scope: SyncScope): DeviceEnrollment | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM device_enrollments WHERE ${SCOPE_WHERE} AND state = 'active' ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(...scopeParams(scope)) as EnrollmentRow | undefined;
  return row ? mapEnrollment(row) : null;
}

export interface UpsertEnrollmentInput {
  id: string;
  scope: SyncScope;
  installationId: string;
  displayName: string;
  state: SyncEnrollmentState;
  enrollmentGeneration?: number;
}

export function upsertEnrollment(input: UpsertEnrollmentInput): DeviceEnrollment {
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO device_enrollments
         (id, backend_id, account_id, dataset_epoch, installation_id, enrollment_generation,
          display_name, state, created_at, updated_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         backend_id = excluded.backend_id,
         account_id = excluded.account_id,
         dataset_epoch = excluded.dataset_epoch,
         installation_id = excluded.installation_id,
         enrollment_generation = excluded.enrollment_generation,
         display_name = excluded.display_name,
         state = excluded.state,
         updated_at = excluded.updated_at,
         revoked_at = CASE WHEN excluded.state = 'revoked' THEN excluded.updated_at ELSE NULL END`,
    )
    .run(
      input.id,
      input.scope.backendId,
      input.scope.accountId,
      input.scope.datasetEpoch,
      input.installationId,
      input.enrollmentGeneration ?? 1,
      input.displayName,
      input.state,
      now,
      now,
    );
  const row = getDb().prepare('SELECT * FROM device_enrollments WHERE id = ?').get(input.id) as
    | EnrollmentRow
    | undefined;
  if (!row) throw new Error(`Failed to persist enrollment ${input.id}.`);
  return mapEnrollment(row);
}

export function revokeEnrollment(id: string): void {
  const now = nowIso();
  const result = getDb()
    .prepare(
      "UPDATE device_enrollments SET state = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(now, now, id);
  if (result.changes === 0) throw new Error(`Unknown enrollment ${id}.`);
}

export function getBinding(
  scope: SyncScope,
  entityType: string,
  entityId: string,
): SyncBinding | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM sync_bindings WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ?`,
    )
    .get(...scopeParams(scope), entityType, entityId) as BindingRow | undefined;
  return row ? mapBinding(row) : null;
}

export interface UpsertBindingPatch {
  baseRevision?: number | null;
  basePayloadJson?: string | null;
  quarantineJson?: string | null;
}

export function upsertBinding(
  scope: SyncScope,
  entityType: string,
  entityId: string,
  patch?: UpsertBindingPatch,
): SyncBinding {
  const existing = getBinding(scope, entityType, entityId);
  const now = nowIso();
  if (!existing) {
    const id = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO sync_bindings
           (id, backend_id, account_id, dataset_epoch, entity_type, entity_id, base_revision,
            base_payload_json, local_edit_generation, acknowledged_generation, quarantine_json,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
      )
      .run(
        id,
        scope.backendId,
        scope.accountId,
        scope.datasetEpoch,
        entityType,
        entityId,
        patch?.baseRevision ?? null,
        patch?.basePayloadJson ?? null,
        patch?.quarantineJson ?? null,
        now,
        now,
      );
  } else if (patch) {
    getDb()
      .prepare(
        `UPDATE sync_bindings
         SET base_revision = COALESCE(?, base_revision),
             base_payload_json = COALESCE(?, base_payload_json),
             quarantine_json = COALESCE(?, quarantine_json),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.baseRevision ?? null,
        patch.basePayloadJson ?? null,
        patch.quarantineJson ?? null,
        now,
        existing.id,
      );
  }
  const binding = getBinding(scope, entityType, entityId);
  if (!binding) throw new Error(`Failed to persist binding for ${entityType}:${entityId}.`);
  return binding;
}

/** A binding row means the entity is adopted for sync in that scope. */
export function hasActiveBinding(
  scope: SyncScope,
  entityType: string,
  entityId: string,
): boolean {
  return getBinding(scope, entityType, entityId) !== null;
}

/**
 * Every scope where the entity has a binding. An entity with no binding in any
 * scope is UNSYNCED and must save normally without any outbox row.
 */
export function listSyncScopesForEntity(entityType: string, entityId: string): SyncScope[] {
  const rows = getDb()
    .prepare(
      'SELECT DISTINCT backend_id, account_id, dataset_epoch FROM sync_bindings WHERE entity_type = ? AND entity_id = ?',
    )
    .all(entityType, entityId) as Array<{
    backend_id: string;
    account_id: string;
    dataset_epoch: string;
  }>;
  return rows.map(mapScope);
}

/**
 * Records the sync intent for one local domain write.
 *
 * MUST be called from inside the caller's SQLite transaction, immediately after
 * the domain write, so the domain row and its dirty intent commit atomically
 * (spec invariant 1). This function never opens its own transaction.
 *
 * Coalescing (spec section 5, undispatched rows only):
 * - create + update stays create; any op + delete becomes delete.
 * - pending create + delete removes the outbox row entirely (net no-op).
 * - a dispatched row is immutable: a new pending successor is added whose
 *   base_revision stays NULL until the dispatch is acknowledged.
 *
 * Returns the changeId, or null when a pending create + delete cancelled out.
 */
export function recordLocalChange(scope: SyncScope, input: RecordLocalChangeInput): string | null {
  const db = getDb();
  const now = nowIso();
  let binding = getBinding(scope, input.entityType, input.entityId);
  if (!binding) {
    binding = upsertBinding(scope, input.entityType, input.entityId);
  }
  const generation = binding.localEditGeneration + 1;
  db.prepare('UPDATE sync_bindings SET local_edit_generation = ?, updated_at = ? WHERE id = ?').run(
    generation,
    now,
    binding.id,
  );

  const payloadJson = input.payload === undefined ? null : canonicalJson(input.payload);
  const pending = db
    .prepare(
      `SELECT * FROM sync_outbox WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ?
       AND state = 'pending' ORDER BY created_at ASC LIMIT 1`,
    )
    .get(...scopeParams(scope), input.entityType, input.entityId) as OutboxRow | undefined;

  if (pending) {
    if (pending.operation === 'create' && input.operation === 'delete') {
      db.prepare('DELETE FROM sync_outbox WHERE change_id = ?').run(pending.change_id);
      return null;
    }
    const operation =
      pending.operation === 'delete' || input.operation === 'delete'
        ? input.operation === 'delete'
          ? ('delete' as const)
          : binding.baseRevision === null
            ? ('create' as const)
            : ('update' as const)
        : pending.operation;
    const finalPayloadJson = input.operation === 'delete' ? null : payloadJson;
    const hash = computePayloadHash({
      baseRevision: pending.base_revision,
      entityId: input.entityId,
      entityType: input.entityType,
      operation,
      payload: finalPayloadJson === null ? null : JSON.parse(finalPayloadJson),
      schemaVersion: input.schemaVersion,
    });
    db.prepare(
      `UPDATE sync_outbox
       SET operation = ?, payload_json = ?, payload_hash = ?, local_edit_generation = ?
       WHERE change_id = ?`,
    ).run(operation, finalPayloadJson, hash, generation, pending.change_id);
    return pending.change_id;
  }

  const dispatched = db
    .prepare(
      `SELECT change_id FROM sync_outbox WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ?
       AND state = 'dispatched' LIMIT 1`,
    )
    .get(...scopeParams(scope), input.entityType, input.entityId) as
    | { change_id: string }
    | undefined;

  const changeId = randomUUID();
  // A dispatched row is immutable: the successor stays pending with a NULL
  // base_revision placeholder that applyPushResults resolves after the ack.
  const baseRevision = dispatched ? null : binding.baseRevision;
  const hash = computePayloadHash({
    baseRevision,
    entityId: input.entityId,
    entityType: input.entityType,
    operation: input.operation,
    payload: payloadJson === null ? null : JSON.parse(payloadJson),
    schemaVersion: input.schemaVersion,
  });
  db.prepare(
    `INSERT INTO sync_outbox
       (change_id, backend_id, account_id, dataset_epoch, enrollment_id, enrollment_sequence,
        entity_type, entity_id, schema_version, base_revision, operation, payload_json,
        payload_hash, local_edit_generation, state, created_at, dispatched_at, result_json)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)`,
  ).run(
    changeId,
    scope.backendId,
    scope.accountId,
    scope.datasetEpoch,
    getActiveEnrollment(scope)?.id ?? '',
    input.entityType,
    input.entityId,
    input.schemaVersion,
    baseRevision,
    input.operation,
    payloadJson,
    hash,
    generation,
    now,
  );
  return changeId;
}

export function listOutboxRows(scope: SyncScope): SyncOutboxRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM sync_outbox WHERE ${SCOPE_WHERE} ORDER BY created_at ASC, rowid ASC`)
    .all(...scopeParams(scope)) as OutboxRow[];
  return rows.map(mapOutboxRow);
}

function toPendingChange(row: OutboxRow): PendingChange {
  if (row.enrollment_sequence === null) throw new Error(`Change ${row.change_id} was not sequenced.`);
  return {
    baseRevision: row.base_revision,
    changeId: row.change_id,
    enrollmentSequence: row.enrollment_sequence,
    entityId: row.entity_id,
    entityType: row.entity_type,
    operation: row.operation,
    payload: row.payload_json === null ? undefined : (JSON.parse(row.payload_json) as unknown),
    payloadHash: row.payload_hash,
    schemaVersion: row.schema_version,
  };
}

/**
 * Builds the next push batch: pending rows in created_at order, at most one
 * per entity, skipping entities with a dispatched row or an unresolved
 * conflict. Assigns increasing enrollment_sequence values and marks the rows
 * dispatched atomically (own transaction is fine here).
 */
export function nextBatch(
  scope: SyncScope,
  enrollmentId: string,
  options?: NextBatchOptions,
): PendingChange[] {
  const maxChanges = options?.maxChanges ?? SYNC_PUSH_DEFAULTS.maxChanges;
  const maxBytes = options?.maxBytes ?? SYNC_PUSH_DEFAULTS.maxBytes;
  const run = getDb().transaction((): PendingChange[] => {
    const db = getDb();
    const params = scopeParams(scope);
    // Entities with an in-flight dispatch are blocked. Conflict blocking comes
    // from unresolved sync_conflicts rows (not the historic 'conflict' outbox
    // row), so resolving a conflict unblocks the entity's next mutation.
    const blockedEntities = new Set(
      (
        db
          .prepare(
            `SELECT entity_type, entity_id FROM sync_outbox
             WHERE ${SCOPE_WHERE} AND state = 'dispatched'`,
          )
          .all(...params) as Array<{ entity_type: string; entity_id: string }>
      ).map((row) => `${row.entity_type}\0${row.entity_id}`),
    );
    const conflictedEntities = new Set(
      (
        db
          .prepare(
            `SELECT entity_type, entity_id FROM sync_conflicts
             WHERE ${SCOPE_WHERE} AND resolved_at IS NULL`,
          )
          .all(...params) as Array<{ entity_type: string; entity_id: string }>
      ).map((row) => `${row.entity_type}\0${row.entity_id}`),
    );
    const candidates = (
      db
        .prepare(
          `SELECT * FROM sync_outbox WHERE ${SCOPE_WHERE} AND state = 'pending' ORDER BY created_at ASC, rowid ASC`,
        )
        .all(...params) as OutboxRow[]
    ).filter((row) => {
      const key = `${row.entity_type}\0${row.entity_id}`;
      return !blockedEntities.has(key) && !conflictedEntities.has(key);
    });

    const seen = new Set<string>();
    const batch: OutboxRow[] = [];
    let bytes = 0;
    for (const row of candidates) {
      const key = `${row.entity_type}\0${row.entity_id}`;
      if (seen.has(key)) continue;
      const size = Buffer.byteLength(row.payload_json ?? '', 'utf8');
      if (batch.length >= maxChanges) break;
      if (batch.length > 0 && bytes + size > maxBytes) continue;
      seen.add(key);
      batch.push(row);
      bytes += size;
    }

    const sequenceRow = db
      .prepare(
        `SELECT MAX(enrollment_sequence) AS max_sequence FROM sync_outbox
         WHERE ${SCOPE_WHERE} AND enrollment_id = ?`,
      )
      .get(...params, enrollmentId) as { max_sequence: number | null };
    let sequence = sequenceRow.max_sequence ?? 0;
    const now = nowIso();
    const dispatch = db.prepare(
      `UPDATE sync_outbox
       SET enrollment_id = ?, enrollment_sequence = ?, state = 'dispatched', dispatched_at = ?
       WHERE change_id = ?`,
    );
    for (const row of batch) {
      sequence += 1;
      dispatch.run(enrollmentId, sequence, now, row.change_id);
      row.enrollment_id = enrollmentId;
      row.enrollment_sequence = sequence;
      row.state = 'dispatched';
      row.dispatched_at = now;
    }
    if (batch.length > 0) {
      updateSyncState(scope, { lastPushAt: now });
    }
    return batch.map(toPendingChange);
  });
  return run();
}

/**
 * Applies one backend push response page. Accepted rows advance the binding
 * base and unblock pending successors; conflicts preserve base/local/remote
 * and block only that entity; rejected rows are recorded; reset-required and
 * receipt-expired leave the row and flag sync_state for recovery.
 */
export function applyPushResults(scope: SyncScope, results: PushResult[]): void {
  const run = getDb().transaction(() => {
    const db = getDb();
    for (const result of results) {
      const row = db.prepare('SELECT * FROM sync_outbox WHERE change_id = ?').get(result.changeId) as
        | OutboxRow
        | undefined;
      if (!row) throw new Error(`Unknown change ${result.changeId}.`);
      if (
        row.backend_id !== scope.backendId ||
        row.account_id !== scope.accountId ||
        row.dataset_epoch !== scope.datasetEpoch
      ) {
        throw new Error(`Change ${result.changeId} does not belong to this sync scope.`);
      }
      switch (result.status) {
        case 'accepted': {
          const revision = result.revision ?? row.base_revision;
          db.prepare(
            `UPDATE sync_bindings
             SET base_revision = ?, base_payload_json = ?, acknowledged_generation = ?,
                 updated_at = ?
             WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ?`,
          ).run(
            revision,
            row.payload_json,
            row.local_edit_generation,
            nowIso(),
            ...scopeParams(scope),
            row.entity_type,
            row.entity_id,
          );
          db.prepare(
            "UPDATE sync_outbox SET state = 'acknowledged', result_json = ? WHERE change_id = ?",
          ).run(result.revision !== undefined ? JSON.stringify({ revision: result.revision }) : null, result.changeId);
          db.prepare(
            `UPDATE sync_outbox SET base_revision = ?
             WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ? AND state = 'pending'`,
          ).run(revision, ...scopeParams(scope), row.entity_type, row.entity_id);
          break;
        }
        case 'conflict': {
          const binding = getBinding(scope, row.entity_type, row.entity_id);
          const remotePayloadJson =
            result.remotePayload === undefined ? null : canonicalJson(result.remotePayload);
          const kind =
            row.operation === 'delete'
              ? ('delete-edit' as const)
              : remotePayloadJson === null
                ? ('edit-delete' as const)
                : ('edit-edit' as const);
          db.prepare(
            `INSERT INTO sync_conflicts
               (id, backend_id, account_id, dataset_epoch, entity_type, entity_id,
                base_payload_json, local_payload_json, remote_payload_json, base_revision,
                remote_revision, kind, created_at, resolved_at, resolution)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
          ).run(
            randomUUID(),
            scope.backendId,
            scope.accountId,
            scope.datasetEpoch,
            row.entity_type,
            row.entity_id,
            binding?.basePayloadJson ?? null,
            row.payload_json,
            remotePayloadJson,
            binding?.baseRevision ?? row.base_revision,
            result.remoteRevision ?? null,
            kind,
            nowIso(),
          );
          db.prepare("UPDATE sync_outbox SET state = 'conflict', result_json = ? WHERE change_id = ?").run(
            JSON.stringify({
              remoteRevision: result.remoteRevision ?? null,
              status: result.status,
            }),
            result.changeId,
          );
          break;
        }
        case 'rejected': {
          db.prepare("UPDATE sync_outbox SET state = 'rejected', result_json = ? WHERE change_id = ?").run(
            JSON.stringify({ status: result.status }),
            result.changeId,
          );
          break;
        }
        case 'reset-required':
        case 'receipt-expired': {
          updateSyncState(scope, { resetRequired: true });
          db.prepare('UPDATE sync_outbox SET result_json = ? WHERE change_id = ?').run(
            JSON.stringify({ status: result.status }),
            result.changeId,
          );
          break;
        }
        default: {
          const unhandled: never = result.status;
          throw new Error(`Unhandled push result status: ${String(unhandled)}`);
        }
      }
    }
  });
  run();
}

export function getSyncState(scope: SyncScope): SyncStateRow | null {
  const row = getDb()
    .prepare(`SELECT * FROM sync_state WHERE ${SCOPE_WHERE}`)
    .get(...scopeParams(scope)) as SyncStateDbRow | undefined;
  return row ? mapSyncState(row) : null;
}

export interface SyncStatePatch {
  cursor?: string | null;
  lastPullAt?: string | null;
  lastPushAt?: string | null;
  consumedSequenceHighWater?: number;
  retentionFloorSequence?: number | null;
  protocolVersion?: string | null;
  serverLimitsJson?: string | null;
  resetRequired?: boolean;
}

export function updateSyncState(scope: SyncScope, patch: SyncStatePatch): SyncStateRow {
  const db = getDb();
  const existing = getSyncState(scope);
  const now = nowIso();
  if (!existing) {
    db.prepare(
      `INSERT INTO sync_state
         (backend_id, account_id, dataset_epoch, cursor, last_pull_at, last_push_at,
          consumed_sequence_high_water, retention_floor_sequence, protocol_version,
          server_limits_json, reset_required, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      scope.backendId,
      scope.accountId,
      scope.datasetEpoch,
      patch.cursor ?? null,
      patch.lastPullAt ?? null,
      patch.lastPushAt ?? null,
      patch.consumedSequenceHighWater ?? 0,
      patch.retentionFloorSequence ?? null,
      patch.protocolVersion ?? null,
      patch.serverLimitsJson ?? null,
      patch.resetRequired === true ? 1 : 0,
      now,
    );
  } else {
    db.prepare(
      `UPDATE sync_state
       SET cursor = COALESCE(?, cursor),
           last_pull_at = COALESCE(?, last_pull_at),
           last_push_at = COALESCE(?, last_push_at),
           consumed_sequence_high_water = COALESCE(?, consumed_sequence_high_water),
           retention_floor_sequence = COALESCE(?, retention_floor_sequence),
           protocol_version = COALESCE(?, protocol_version),
           server_limits_json = COALESCE(?, server_limits_json),
           reset_required = ?,
           updated_at = ?
       WHERE backend_id = ? AND account_id = ? AND dataset_epoch = ?`,
    ).run(
      patch.cursor ?? null,
      patch.lastPullAt ?? null,
      patch.lastPushAt ?? null,
      patch.consumedSequenceHighWater ?? null,
      patch.retentionFloorSequence ?? null,
      patch.protocolVersion ?? null,
      patch.serverLimitsJson ?? null,
      patch.resetRequired === undefined ? (existing.resetRequired ? 1 : 0) : patch.resetRequired ? 1 : 0,
      now,
      ...scopeParams(scope),
    );
  }
  const updated = getSyncState(scope);
  if (!updated) throw new Error('Failed to persist sync state.');
  return updated;
}

/** Unresolved conflicts for the scope, oldest first. */
export function listConflicts(scope: SyncScope): SyncConflict[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM sync_conflicts WHERE ${SCOPE_WHERE} AND resolved_at IS NULL ORDER BY created_at ASC`,
    )
    .all(...scopeParams(scope)) as ConflictRow[];
  return rows.map(mapConflict);
}

/**
 * Marks a conflict resolved. The caller produces the actual new conditional
 * mutation via recordLocalChange; resolution unblocks the entity for dispatch.
 */
export function resolveConflict(id: string, resolution: SyncConflictResolution): SyncConflict {
  const db = getDb();
  const row = db.prepare('SELECT * FROM sync_conflicts WHERE id = ?').get(id) as
    | ConflictRow
    | undefined;
  if (!row) throw new Error(`Unknown conflict ${id}.`);
  if (row.resolved_at !== null) throw new Error(`Conflict ${id} is already resolved.`);
  db.prepare('UPDATE sync_conflicts SET resolved_at = ?, resolution = ? WHERE id = ?').run(
    nowIso(),
    resolution,
    id,
  );
  const updated = db.prepare('SELECT * FROM sync_conflicts WHERE id = ?').get(id) as ConflictRow;
  return mapConflict(updated);
}

/**
 * Domain hook: runs the domain write, then records a local change in every
 * scope with an active binding for the entity. With no bindings it only runs
 * the domain write, so unsynced entities save normally without an outbox row.
 *
 * MUST be called inside the caller's transaction (see recordLocalChange).
 */
export function withSyncedEntityWrite(
  entityType: string,
  entityId: string,
  schemaVersion: number,
  operation: SyncOperation,
  buildPayload: () => unknown | null,
  domainWrite: () => void,
): void {
  domainWrite();
  const scopes = listSyncScopesForEntity(entityType, entityId).filter((scope) =>
    hasActiveBinding(scope, entityType, entityId),
  );
  for (const scope of scopes) {
    const payload = buildPayload();
    recordLocalChange(scope, {
      entityId,
      entityType,
      operation,
      payload: payload ?? undefined,
      schemaVersion,
    });
  }
}
