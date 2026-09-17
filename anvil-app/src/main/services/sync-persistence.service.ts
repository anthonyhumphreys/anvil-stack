import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_LIMITS } from '../../../cloud/contract/version.js';
import {
  canonicalizeJson,
  hashChange,
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
  type SyncEntitlementRecord,
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
  return canonicalizeJson(value);
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
  return hashChange(input, (canonical) => createHash('sha256').update(canonical).digest('hex'));
}

interface EnrollmentRow {
  id: string;
  backend_id: string;
  account_id: string;
  dataset_epoch: string;
  installation_id: string;
  enrollment_generation: number;
  next_sequence: number;
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
  sealed_json: string | null;
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

function mapScope(row: {
  backend_id: string;
  account_id: string;
  dataset_epoch: string;
}): SyncScope {
  return { backendId: row.backend_id, accountId: row.account_id, datasetEpoch: row.dataset_epoch };
}

function mapEnrollment(row: EnrollmentRow): DeviceEnrollment {
  return {
    id: row.id,
    scope: mapScope(row),
    installationId: row.installation_id,
    enrollmentGeneration: row.enrollment_generation,
    nextSequence: row.next_sequence,
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
    sealedJson: row.sealed_json,
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

/**
 * First upload of an unbound entity must be `create` with a null base
 * (BACKEND-01 rejects `update` when baseRevision is null). Domain writers
 * often pass `update` because the local SQLite row already exists.
 */
function syncOperationForBinding(
  baseRevision: number | null,
  operation: SyncOperation,
): SyncOperation {
  if (operation === 'delete') return 'delete';
  if (baseRevision === null) return 'create';
  return operation;
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
export function hasActiveBinding(scope: SyncScope, entityType: string, entityId: string): boolean {
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

/** Every scope that has any sync metadata — bindings, outbox, state, or conflicts. */
export function listSyncScopes(): SyncScope[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT backend_id, account_id, dataset_epoch FROM (
         SELECT backend_id, account_id, dataset_epoch FROM sync_bindings
         UNION SELECT backend_id, account_id, dataset_epoch FROM sync_outbox
         UNION SELECT backend_id, account_id, dataset_epoch FROM sync_state
         UNION SELECT backend_id, account_id, dataset_epoch FROM sync_conflicts
       )`,
    )
    .all() as Array<{ backend_id: string; account_id: string; dataset_epoch: string }>;
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
          : syncOperationForBinding(binding.baseRevision, 'update')
        : syncOperationForBinding(binding.baseRevision, pending.operation);
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
  // Do not coerce that successor to create; the in-flight row already created it.
  const baseRevision = dispatched ? null : binding.baseRevision;
  const operation = dispatched
    ? input.operation
    : syncOperationForBinding(binding.baseRevision, input.operation);
  const hash = computePayloadHash({
    baseRevision,
    entityId: input.entityId,
    entityType: input.entityType,
    operation,
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
    operation,
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
  if (row.enrollment_sequence === null)
    throw new Error(`Change ${row.change_id} was not sequenced.`);
  // The wire payload is sealed_json when dispatch produced one (the sealed
  // envelope for domain entities); rows dispatched before sealing existed
  // fall back to the stored plaintext payload.
  const wireJson = row.sealed_json ?? row.payload_json;
  return {
    baseRevision: row.base_revision,
    changeId: row.change_id,
    enrollmentSequence: row.enrollment_sequence,
    entityId: row.entity_id,
    entityType: row.entity_type,
    operation: row.operation,
    payload:
      row.operation === 'delete' || wireJson === null
        ? undefined
        : (JSON.parse(wireJson) as unknown),
    payloadHash: row.payload_hash,
    schemaVersion: row.schema_version,
  };
}

/**
 * Fences dispatched rows recorded under a different enrollment: their receipts
 * live in that enrollment's namespace, so the current enrollment can never
 * resolve them. Each is preserved as a reviewable conflict (the intended local
 * version is kept in the row's payload) and marked rejected.
 */
function fenceOrphanedDispatches(scope: SyncScope, enrollmentId: string): void {
  const db = getDb();
  const params = scopeParams(scope);
  const orphaned = db
    .prepare(
      `SELECT * FROM sync_outbox WHERE ${SCOPE_WHERE} AND state = 'dispatched' AND enrollment_id <> ?`,
    )
    .all(...params, enrollmentId) as OutboxRow[];
  for (const row of orphaned) {
    db.prepare(
      "UPDATE sync_outbox SET state = 'rejected', result_json = ? WHERE change_id = ?",
    ).run(JSON.stringify({ status: 'rejected', reason: 'enrollment-superseded' }), row.change_id);
    const unresolved = db
      .prepare(
        `SELECT id FROM sync_conflicts
         WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ? AND resolved_at IS NULL
         LIMIT 1`,
      )
      .get(...params, row.entity_type, row.entity_id) as { id: string } | undefined;
    if (unresolved) continue;
    const binding = getBinding(scope, row.entity_type, row.entity_id);
    db.prepare(
      `INSERT INTO sync_conflicts
         (id, backend_id, account_id, dataset_epoch, entity_type, entity_id,
          base_payload_json, local_payload_json, remote_payload_json, base_revision,
          remote_revision, kind, created_at, resolved_at, resolution)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL, NULL)`,
    ).run(
      randomUUID(),
      scope.backendId,
      scope.accountId,
      scope.datasetEpoch,
      row.entity_type,
      row.entity_id,
      binding?.basePayloadJson ?? null,
      row.payload_json,
      binding?.baseRevision ?? row.base_revision,
      row.operation === 'delete' ? 'delete-edit' : 'edit-edit',
      nowIso(),
    );
  }
}

/**
 * Builds the next push batch inside one transaction.
 *
 * Dispatch rules (spec §5):
 * - Outstanding `dispatched` rows under this enrollment form the replay batch:
 *   they are returned unchanged so a retry reuses the original
 *   enrollment_sequence and payload_hash after transport failure or restart.
 * - Dispatched rows under a different enrollment are fenced into conflicts.
 * - Pending rows are immutable only once dispatched: at dispatch time each row
 *   is rebased onto the current binding base, its operation normalized
 *   (null-base edits become `create`; a keep-local `create` re-queued after a
 *   conflict becomes `update`), and `payload_hash` recomputed over the exact
 *   wire content.
 * - Entities with an unresolved conflict are skipped; one row per entity;
 *   batch count and serialized-request bytes honor negotiated limits; an
 *   entity over `entityBytes` is rejected locally instead of poisoning a batch.
 */
export function nextBatch(
  scope: SyncScope,
  enrollmentId: string,
  options?: NextBatchOptions,
): PendingChange[] {
  const maxChanges = options?.maxChanges ?? SYNC_PUSH_DEFAULTS.maxChanges;
  const maxBytes = options?.maxBytes ?? SYNC_PUSH_DEFAULTS.maxBytes;
  const entityBytes = options?.entityBytes ?? DEFAULT_LIMITS.entityBytes;
  const run = getDb().transaction((): PendingChange[] => {
    const db = getDb();
    const params = scopeParams(scope);
    const now = nowIso();

    fenceOrphanedDispatches(scope, enrollmentId);

    const dispatched = db
      .prepare(
        `SELECT * FROM sync_outbox WHERE ${SCOPE_WHERE} AND state = 'dispatched' AND enrollment_id = ?
         ORDER BY enrollment_sequence ASC`,
      )
      .all(...params, enrollmentId) as OutboxRow[];
    if (dispatched.length > 0) {
      return dispatched.map(toPendingChange);
    }

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
    ).filter((row) => !conflictedEntities.has(`${row.entity_type}\0${row.entity_id}`));

    const enrollment = db
      .prepare('SELECT next_sequence FROM device_enrollments WHERE id = ?')
      .get(enrollmentId) as { next_sequence: number } | undefined;
    if (!enrollment) {
      throw new Error(`Unknown enrollment ${enrollmentId}.`);
    }
    let nextSequence = enrollment.next_sequence;

    const seen = new Set<string>();
    const batch: OutboxRow[] = [];
    let bytes = 0;
    const reject = (changeId: string, reason: string): void => {
      db.prepare(
        "UPDATE sync_outbox SET state = 'rejected', result_json = ? WHERE change_id = ?",
      ).run(JSON.stringify({ status: 'rejected', reason }), changeId);
    };
    for (const row of candidates) {
      const key = `${row.entity_type}\0${row.entity_id}`;
      if (seen.has(key)) continue;
      const binding = getBinding(scope, row.entity_type, row.entity_id);
      const baseRevision = binding?.baseRevision ?? null;
      let operation = row.operation;
      if (baseRevision === null) {
        if (operation === 'delete') {
          // Nothing to delete remotely; the intent is already realized.
          db.prepare('DELETE FROM sync_outbox WHERE change_id = ?').run(row.change_id);
          continue;
        }
        operation = 'create';
      } else if (operation === 'create') {
        // A create re-queued onto a known remote base is a keep-local update.
        operation = 'update';
      }
      const payload = row.payload_json === null ? null : (JSON.parse(row.payload_json) as unknown);
      // Deletes carry no payload on the wire; the hash input must match the
      // exact wire content or the backend rejects it as changed. When a seal
      // hook is configured, the wire payload is its output (a sealed
      // envelope); returning undefined defers the row until key material
      // arrives — it stays pending and is never sent as plaintext.
      let wirePayload: unknown = operation === 'delete' ? null : payload;
      if (operation !== 'delete' && payload !== null && options?.seal !== undefined) {
        wirePayload = options.seal({
          entityType: row.entity_type,
          entityId: row.entity_id,
          operation,
          schemaVersion: row.schema_version,
          payload,
        });
        if (wirePayload === undefined) continue;
      }
      const sealedJson =
        operation === 'delete' || wirePayload === null ? null : canonicalJson(wirePayload);
      const payloadHash = computePayloadHash({
        baseRevision,
        entityId: row.entity_id,
        entityType: row.entity_type,
        operation,
        payload: wirePayload,
        schemaVersion: row.schema_version,
      });
      if (Buffer.byteLength(sealedJson ?? row.payload_json ?? '', 'utf8') > entityBytes) {
        reject(row.change_id, 'entity-too-large');
        continue;
      }
      const serialized = JSON.stringify({
        baseRevision,
        changeId: row.change_id,
        enrollmentSequence: nextSequence,
        entityId: row.entity_id,
        entityType: row.entity_type,
        operation,
        payloadHash,
        schemaVersion: row.schema_version,
        ...(wirePayload === null ? {} : { payload: wirePayload }),
      });
      const size = Buffer.byteLength(serialized, 'utf8');
      if (size > maxBytes) {
        reject(row.change_id, 'change-too-large');
        continue;
      }
      if (batch.length >= maxChanges) break;
      if (bytes + size > maxBytes) continue;
      seen.add(key);
      row.operation = operation;
      row.base_revision = baseRevision;
      row.payload_hash = payloadHash;
      row.enrollment_sequence = nextSequence;
      row.sealed_json = sealedJson;
      batch.push(row);
      bytes += size;
      nextSequence += 1;
    }

    if (batch.length > 0) {
      db.prepare(
        'UPDATE device_enrollments SET next_sequence = ?, updated_at = ? WHERE id = ?',
      ).run(nextSequence, now, enrollmentId);
      const dispatch = db.prepare(
        `UPDATE sync_outbox
         SET enrollment_id = ?, enrollment_sequence = ?, state = 'dispatched', dispatched_at = ?,
             base_revision = ?, operation = ?, payload_hash = ?, sealed_json = ?
         WHERE change_id = ?`,
      );
      for (const row of batch) {
        dispatch.run(
          enrollmentId,
          row.enrollment_sequence,
          now,
          row.base_revision,
          row.operation,
          row.payload_hash,
          row.sealed_json,
          row.change_id,
        );
      }
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
      const row = db
        .prepare('SELECT * FROM sync_outbox WHERE change_id = ?')
        .get(result.changeId) as OutboxRow | undefined;
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
          // Advance the base only forward: a scan/reset may already have moved
          // the binding past this stale acknowledgement.
          db.prepare(
            `UPDATE sync_bindings
             SET base_revision = CASE
                   WHEN base_revision IS NULL OR base_revision < ? THEN ?
                   ELSE base_revision END,
                 base_payload_json = CASE
                   WHEN base_revision IS NULL OR base_revision < ? THEN ?
                   ELSE base_payload_json END,
                 acknowledged_generation = MAX(acknowledged_generation, ?),
                 updated_at = ?
             WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ?`,
          ).run(
            revision,
            revision,
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
          ).run(
            result.revision !== undefined ? JSON.stringify({ revision: result.revision }) : null,
            result.changeId,
          );
          // Pending successors keep their recorded payload; their base and hash
          // are recomputed from the binding at dispatch time.
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
          // Dedupe: an unresolved conflict for this entity already captures the
          // pending review; a second one must not stack up on replays.
          const unresolved = db
            .prepare(
              `SELECT id FROM sync_conflicts
               WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ? AND resolved_at IS NULL
               LIMIT 1`,
            )
            .get(...scopeParams(scope), row.entity_type, row.entity_id) as
            | { id: string }
            | undefined;
          if (!unresolved) {
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
          }
          db.prepare(
            "UPDATE sync_outbox SET state = 'conflict', result_json = ? WHERE change_id = ?",
          ).run(
            JSON.stringify({
              remoteRevision: result.remoteRevision ?? null,
              status: result.status,
            }),
            result.changeId,
          );
          break;
        }
        case 'rejected': {
          db.prepare(
            "UPDATE sync_outbox SET state = 'rejected', result_json = ? WHERE change_id = ?",
          ).run(
            JSON.stringify({ status: result.status, reason: result.reason ?? null }),
            result.changeId,
          );
          break;
        }
        case 'reset-required':
        case 'receipt-expired': {
          updateSyncState(scope, { resetRequired: true });
          // Terminal receipt: the server answered without applying the change.
          // The entity stays dirty (local generation > acknowledged) so the
          // scan/reset reconciliation preserves the local edit.
          db.prepare(
            "UPDATE sync_outbox SET state = 'rejected', result_json = ? WHERE change_id = ?",
          ).run(JSON.stringify({ status: 'rejected', reason: result.status }), result.changeId);
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
      patch.resetRequired === undefined
        ? existing.resetRequired
          ? 1
          : 0
        : patch.resetRequired
          ? 1
          : 0,
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

/**
 * Stable per-profile installation identity, persisted once in
 * `sync_installation`. Enrollments reference it; replacing or revoking an
 * enrollment never changes the installation id.
 */
export function getOrCreateInstallationId(): string {
  const row = getDb()
    .prepare('SELECT installation_id FROM sync_installation WHERE id = 1')
    .get() as { installation_id: string } | undefined;
  if (row) return row.installation_id;
  const id = randomUUID();
  getDb()
    .prepare('INSERT INTO sync_installation (id, installation_id, created_at) VALUES (1, ?, ?)')
    .run(id, nowIso());
  return id;
}

export function listBindings(scope: SyncScope): SyncBinding[] {
  const rows = getDb()
    .prepare(`SELECT * FROM sync_bindings WHERE ${SCOPE_WHERE}`)
    .all(...scopeParams(scope)) as BindingRow[];
  return rows.map(mapBinding);
}

/** Outbox rows that can still change outcome: pending, dispatched, conflict. */
export function listMutableOutboxRows(
  scope: SyncScope,
  entityType: string,
  entityId: string,
): SyncOutboxRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM sync_outbox
       WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ?
         AND state IN ('pending', 'dispatched', 'conflict')
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(...scopeParams(scope), entityType, entityId) as OutboxRow[];
  return rows.map(mapOutboxRow);
}

export function deleteMutableOutboxRows(
  scope: SyncScope,
  entityType: string,
  entityId: string,
): void {
  getDb()
    .prepare(
      `DELETE FROM sync_outbox
       WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ?
         AND state IN ('pending', 'dispatched', 'conflict')`,
    )
    .run(...scopeParams(scope), entityType, entityId);
}

export function deletePendingOutboxRows(
  scope: SyncScope,
  entityType: string,
  entityId: string,
): void {
  getDb()
    .prepare(
      `DELETE FROM sync_outbox
       WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ? AND state = 'pending'`,
    )
    .run(...scopeParams(scope), entityType, entityId);
}

/** Terminal rejection for dispatched rows whose outcome is no longer needed. */
export function rejectDispatchedRows(
  scope: SyncScope,
  entityType: string,
  entityId: string,
  reason: string,
): void {
  getDb()
    .prepare(
      `UPDATE sync_outbox SET state = 'rejected', result_json = ?
       WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ? AND state = 'dispatched'`,
    )
    .run(
      JSON.stringify({ status: 'rejected', reason }),
      ...scopeParams(scope),
      entityType,
      entityId,
    );
}

export function deleteBinding(scope: SyncScope, entityType: string, entityId: string): void {
  getDb()
    .prepare(`DELETE FROM sync_bindings WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ?`)
    .run(...scopeParams(scope), entityType, entityId);
}

/** Sets the acknowledged base; allows NULL so reset can rebase to "absent". */
export function setBindingBase(
  scope: SyncScope,
  entityType: string,
  entityId: string,
  baseRevision: number | null,
  basePayloadJson: string | null,
): void {
  const binding = getBinding(scope, entityType, entityId);
  if (!binding) {
    upsertBinding(scope, entityType, entityId, { baseRevision, basePayloadJson });
    return;
  }
  getDb()
    .prepare(
      `UPDATE sync_bindings
       SET base_revision = ?, base_payload_json = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(baseRevision, basePayloadJson, nowIso(), binding.id);
}

export function setBindingQuarantine(
  scope: SyncScope,
  entityType: string,
  entityId: string,
  quarantineJson: string | null,
): void {
  const binding = getBinding(scope, entityType, entityId);
  if (!binding) {
    upsertBinding(scope, entityType, entityId, { quarantineJson });
    return;
  }
  getDb()
    .prepare('UPDATE sync_bindings SET quarantine_json = ?, updated_at = ? WHERE id = ?')
    .run(quarantineJson, nowIso(), binding.id);
}

/** Marks the current local edit generation as acknowledged. */
export function acknowledgeBindingLocalEdits(
  scope: SyncScope,
  entityType: string,
  entityId: string,
): void {
  getDb()
    .prepare(
      `UPDATE sync_bindings
       SET acknowledged_generation = local_edit_generation, updated_at = ?
       WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ?`,
    )
    .run(nowIso(), ...scopeParams(scope), entityType, entityId);
}

export interface InsertConflictInput {
  entityType: string;
  entityId: string;
  basePayloadJson: string | null;
  localPayloadJson: string | null;
  remotePayloadJson: string | null;
  baseRevision: number | null;
  remoteRevision: number | null;
  kind: SyncConflict['kind'];
}

/**
 * Inserts an unresolved conflict unless one already exists for the entity.
 * Returns the existing-or-new conflict, or null when already resolved state.
 */
export function insertUnresolvedConflict(
  scope: SyncScope,
  input: InsertConflictInput,
): SyncConflict {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT * FROM sync_conflicts
       WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ? AND resolved_at IS NULL
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(...scopeParams(scope), input.entityType, input.entityId) as ConflictRow | undefined;
  if (existing) return mapConflict(existing);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO sync_conflicts
       (id, backend_id, account_id, dataset_epoch, entity_type, entity_id,
        base_payload_json, local_payload_json, remote_payload_json, base_revision,
        remote_revision, kind, created_at, resolved_at, resolution)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(
    id,
    scope.backendId,
    scope.accountId,
    scope.datasetEpoch,
    input.entityType,
    input.entityId,
    input.basePayloadJson,
    input.localPayloadJson,
    input.remotePayloadJson,
    input.baseRevision,
    input.remoteRevision,
    input.kind,
    nowIso(),
  );
  const row = db.prepare('SELECT * FROM sync_conflicts WHERE id = ?').get(id) as ConflictRow;
  return mapConflict(row);
}

/* ------------------------------------------------------------------ */
/* Scan staging (SYNC-02/03 reset semantics)                            */
/* ------------------------------------------------------------------ */

export interface StagedScanEntity {
  entityType: string;
  entityId: string;
  revision: number;
  schemaVersion: number;
  payloadJson: string | null;
}

interface ScanStagingRow {
  entity_type: string;
  entity_id: string;
  revision: number;
  schema_version: number;
  payload_json: string | null;
}

interface ScanRunRow {
  scan_id: string;
  watermark_start: number;
  started_at: string;
}

/**
 * Starts a staged scan for the scope: discards any incomplete prior run and
 * records the new scan's start watermark. Staging is durable so an interrupted
 * scan never produces partial visible state; a restart simply discards it.
 */
export function beginScanStaging(scope: SyncScope, scanId: string, watermarkStart: number): void {
  const db = getDb();
  const params = scopeParams(scope);
  db.prepare(`DELETE FROM sync_scan_staging WHERE ${SCOPE_WHERE}`).run(...params);
  db.prepare(`DELETE FROM sync_scan_runs WHERE ${SCOPE_WHERE}`).run(...params);
  db.prepare(
    `INSERT INTO sync_scan_runs
       (backend_id, account_id, dataset_epoch, scan_id, watermark_start, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(scope.backendId, scope.accountId, scope.datasetEpoch, scanId, watermarkStart, nowIso());
}

export function getScanRun(
  scope: SyncScope,
): { scanId: string; watermarkStart: number; startedAt: string } | null {
  const row = getDb()
    .prepare(`SELECT scan_id, watermark_start, started_at FROM sync_scan_runs WHERE ${SCOPE_WHERE}`)
    .get(...scopeParams(scope)) as ScanRunRow | undefined;
  if (!row) return null;
  return { scanId: row.scan_id, watermarkStart: row.watermark_start, startedAt: row.started_at };
}

export function stageScanEntities(scope: SyncScope, entities: StagedScanEntity[]): void {
  if (entities.length === 0) return;
  const db = getDb();
  const params = scopeParams(scope);
  const insert = db.prepare(
    `INSERT INTO sync_scan_staging
       (backend_id, account_id, dataset_epoch, entity_type, entity_id, revision, schema_version, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(backend_id, account_id, dataset_epoch, entity_type, entity_id) DO UPDATE SET
       revision = excluded.revision,
       schema_version = excluded.schema_version,
       payload_json = excluded.payload_json`,
  );
  for (const entity of entities) {
    insert.run(
      ...params,
      entity.entityType,
      entity.entityId,
      entity.revision,
      entity.schemaVersion,
      entity.payloadJson,
    );
  }
}

/** Applies one catch-up change (from pull between watermarks) to staging. */
export function stageScanChange(
  scope: SyncScope,
  change: {
    entityType: string;
    entityId: string;
    revision: number;
    schemaVersion: number;
    operation: SyncOperation;
    payloadJson: string | null;
  },
): void {
  const db = getDb();
  const params = scopeParams(scope);
  if (change.operation === 'delete') {
    db.prepare(
      `DELETE FROM sync_scan_staging
       WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ?`,
    ).run(...params, change.entityType, change.entityId);
    return;
  }
  db.prepare(
    `INSERT INTO sync_scan_staging
       (backend_id, account_id, dataset_epoch, entity_type, entity_id, revision, schema_version, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(backend_id, account_id, dataset_epoch, entity_type, entity_id) DO UPDATE SET
       revision = excluded.revision,
       schema_version = excluded.schema_version,
       payload_json = excluded.payload_json`,
  ).run(
    ...params,
    change.entityType,
    change.entityId,
    change.revision,
    change.schemaVersion,
    change.payloadJson,
  );
}

export function listScanStaging(scope: SyncScope): StagedScanEntity[] {
  const rows = getDb()
    .prepare(
      `SELECT entity_type, entity_id, revision, schema_version, payload_json
       FROM sync_scan_staging WHERE ${SCOPE_WHERE}
       ORDER BY entity_type ASC, entity_id ASC`,
    )
    .all(...scopeParams(scope)) as ScanStagingRow[];
  return rows.map((row) => ({
    entityType: row.entity_type,
    entityId: row.entity_id,
    revision: row.revision,
    schemaVersion: row.schema_version,
    payloadJson: row.payload_json,
  }));
}

/** Clears staging and the scan-run marker after activation or discard. */
export function clearScanStaging(scope: SyncScope): void {
  const db = getDb();
  const params = scopeParams(scope);
  db.prepare(`DELETE FROM sync_scan_staging WHERE ${SCOPE_WHERE}`).run(...params);
  db.prepare(`DELETE FROM sync_scan_runs WHERE ${SCOPE_WHERE}`).run(...params);
}

interface EntitlementDbRow {
  backend_id: string;
  account_id: string;
  state: string;
  source: string;
  plan_key: string | null;
  preview_ends_at: string | null;
  access_until: string | null;
  grace_until: string | null;
  checked_at: string;
  revision: number;
  reason: string;
  restricted: number;
  updated_at: string;
}

function mapEntitlement(row: EntitlementDbRow): SyncEntitlementRecord {
  return {
    backendId: row.backend_id,
    accountId: row.account_id,
    state: row.state,
    source: row.source,
    planKey: row.plan_key,
    previewEndsAt: row.preview_ends_at,
    accessUntil: row.access_until,
    graceUntil: row.grace_until,
    checkedAt: row.checked_at,
    revision: row.revision,
    reason: row.reason,
    restricted: row.restricted === 1,
    updatedAt: row.updated_at,
  };
}

/**
 * Last-known hosted entitlement for a (backend, account) pair — deliberately
 * not keyed by dataset epoch. Null means the backend does not report hosted
 * entitlements (self-host) or no check has completed yet; it is never a
 * restriction signal.
 */
export function getSyncEntitlement(
  backendId: string,
  accountId: string,
): SyncEntitlementRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM sync_entitlement WHERE backend_id = ? AND account_id = ?')
    .get(backendId, accountId) as EntitlementDbRow | undefined;
  return row ? mapEntitlement(row) : null;
}

export type UpsertSyncEntitlementInput = Omit<SyncEntitlementRecord, 'updatedAt'>;

/** Stores the entitlement exactly as reported; `restricted` is authoritative. */
export function upsertSyncEntitlement(input: UpsertSyncEntitlementInput): SyncEntitlementRecord {
  getDb()
    .prepare(
      `INSERT INTO sync_entitlement
         (backend_id, account_id, state, source, plan_key, preview_ends_at,
          access_until, grace_until, checked_at, revision, reason, restricted, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(backend_id, account_id) DO UPDATE SET
         state = excluded.state,
         source = excluded.source,
         plan_key = excluded.plan_key,
         preview_ends_at = excluded.preview_ends_at,
         access_until = excluded.access_until,
         grace_until = excluded.grace_until,
         checked_at = excluded.checked_at,
         revision = excluded.revision,
         reason = excluded.reason,
         restricted = excluded.restricted,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.backendId,
      input.accountId,
      input.state,
      input.source,
      input.planKey,
      input.previewEndsAt,
      input.accessUntil,
      input.graceUntil,
      input.checkedAt,
      input.revision,
      input.reason,
      input.restricted ? 1 : 0,
      nowIso(),
    );
  const row = getSyncEntitlement(input.backendId, input.accountId);
  if (!row) throw new Error('Failed to persist sync entitlement.');
  return row;
}

/**
 * Deletes the row entirely — used when a backend stops reporting entitlements
 * (self-host) so a stale hosted row can never keep gating sync writes.
 */
export function clearSyncEntitlement(backendId: string, accountId: string): void {
  getDb()
    .prepare('DELETE FROM sync_entitlement WHERE backend_id = ? AND account_id = ?')
    .run(backendId, accountId);
}

/**
 * Local retention window for terminal sync metadata (spec §5, OPS-01):
 * acknowledged/rejected outbox rows and resolved conflicts are kept for
 * review/diagnostics, then compacted. Mutable rows (pending, dispatched,
 * conflict, unresolved) are never swept.
 */
export const LOCAL_SYNC_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export function sweepLocalSyncRetention(now: number = Date.now()): {
  outboxRows: number;
  conflicts: number;
} {
  const cutoff = new Date(now - LOCAL_SYNC_RETENTION_MS).toISOString();
  const db = getDb();
  const outboxRows = db
    .prepare(
      `DELETE FROM sync_outbox
       WHERE state IN ('acknowledged', 'rejected')
         AND COALESCE(dispatched_at, created_at) < ?`,
    )
    .run(cutoff).changes;
  const conflicts = db
    .prepare(`DELETE FROM sync_conflicts WHERE resolved_at IS NOT NULL AND resolved_at < ?`)
    .run(cutoff).changes;
  return { outboxRows, conflicts };
}
