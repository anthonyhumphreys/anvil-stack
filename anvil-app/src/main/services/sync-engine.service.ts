import { randomUUID } from 'node:crypto';
import { DEFAULT_LIMITS } from '../../../cloud/contract/version.js';
import type {
  SyncCursor,
  SyncPullParams,
  SyncPullResult,
  SyncPushItemResult,
  SyncPushResult,
  SyncedChange,
} from '../../../cloud/contract/sync.js';
import {
  SYNC_ENTITY_WORKFLOW_TEMPLATE,
  type PushResult,
  type SyncConflictKind,
  type SyncScope,
} from '../../shared/sync-mesh.js';
import {
  applyPushResults,
  canonicalJson,
  getBinding,
  getSyncState,
  listOutboxRows,
  nextBatch,
  updateSyncState,
  upsertBinding,
} from './sync-persistence.service.js';
import {
  BackendRpcError,
  rpc as defaultRpc,
  type BackendConnection,
  type RpcResult,
} from './sync-backend-client.service.js';
import { getDb } from '../db/database.js';

const SCOPE_WHERE = 'backend_id = ? AND account_id = ? AND dataset_epoch = ?';
const DEFAULT_RETRY_MS = 1_000;

export type SyncEngineRpc = <R = unknown>(
  connection: Pick<BackendConnection, 'apiUrl'>,
  operation: string,
  params: unknown,
  accessToken: string,
) => Promise<RpcResult<R>>;

export interface SyncEngineConnection extends Pick<BackendConnection, 'apiUrl'> {
  limits?: Pick<typeof DEFAULT_LIMITS, 'pageBytes'>;
}

export interface RunSyncCycleInput {
  scope: SyncScope;
  /** Active device enrollment; required for push sequencing. */
  enrollmentId: string;
  connection: SyncEngineConnection;
  accessToken: string;
  rpc?: SyncEngineRpc;
}

export interface SyncEngineSnapshot {
  lastPushAt: string | null;
  lastPullAt: string | null;
  inFlight: boolean;
  pendingCount: number;
}

export class SyncEngineError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(message: string, options: { retryable: boolean; retryAfterMs?: number }) {
    super(message);
    this.name = 'SyncEngineError';
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

interface ScopeLoop {
  inFlight: Promise<void> | null;
  queued: boolean;
  queuedInput: RunSyncCycleInput | null;
}

const loops = new Map<string, ScopeLoop>();
const backoffUntil = new Map<string, number>();

function nowIso(): string {
  return new Date().toISOString();
}

function scopeKey(scope: SyncScope): string {
  return `${scope.backendId}\0${scope.accountId}\0${scope.datasetEpoch}`;
}

function scopeParams(scope: SyncScope): [string, string, string] {
  return [scope.backendId, scope.accountId, scope.datasetEpoch];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getLoop(key: string): ScopeLoop {
  const existing = loops.get(key);
  if (existing) return existing;
  const created: ScopeLoop = { inFlight: null, queued: false, queuedInput: null };
  loops.set(key, created);
  return created;
}

/**
 * Test helper: clears per-scope mutex, coalesce queue, and in-memory backoff.
 * Does not touch SQLite.
 */
export function resetSyncEngineForTests(): void {
  loops.clear();
  backoffUntil.clear();
}

export function getSyncEngineSnapshot(scope: SyncScope): SyncEngineSnapshot {
  const state = getSyncState(scope);
  const loop = loops.get(scopeKey(scope));
  return {
    lastPushAt: state?.lastPushAt ?? null,
    lastPullAt: state?.lastPullAt ?? null,
    inFlight: loop?.inFlight != null,
    pendingCount: listOutboxRows(scope).filter((row) => row.state === 'pending').length,
  };
}

/**
 * One serialized push/pull cycle per SyncScope. Overlapping callers coalesce to
 * a single extra run after the in-flight cycle (not a parallel loop).
 */
export async function runSyncCycle(input: RunSyncCycleInput): Promise<void> {
  const key = scopeKey(input.scope);
  const loop = getLoop(key);
  if (loop.inFlight) {
    loop.queued = true;
    loop.queuedInput = input;
    await loop.inFlight;
    return;
  }

  const run = (async () => {
    let current = input;
    try {
      for (;;) {
        loop.queued = false;
        loop.queuedInput = null;
        await executeOneCycle(current);
        if (!loop.queued || loop.queuedInput === null) {
          break;
        }
        current = loop.queuedInput;
      }
    } finally {
      loop.inFlight = null;
    }
  })();

  loop.inFlight = run;
  await run;
}

async function executeOneCycle(input: RunSyncCycleInput): Promise<void> {
  const key = scopeKey(input.scope);
  const until = backoffUntil.get(key);
  if (until !== undefined && Date.now() < until) {
    throw new SyncEngineError('sync engine is backing off', {
      retryable: true,
      retryAfterMs: until - Date.now(),
    });
  }
  if (input.enrollmentId.trim() === '') {
    throw new SyncEngineError('sync push requires an active enrollment id', { retryable: false });
  }

  const rpcFn = input.rpc ?? defaultRpc;
  try {
    await pushCycle(input, rpcFn);
    await pullCycle(input, rpcFn);
    backoffUntil.delete(key);
  } catch (error) {
    const mapped = toSyncEngineError(error);
    if (mapped.retryable) {
      backoffUntil.set(key, Date.now() + (mapped.retryAfterMs ?? DEFAULT_RETRY_MS));
    }
    throw mapped;
  }
}

async function pushCycle(input: RunSyncCycleInput, rpcFn: SyncEngineRpc): Promise<void> {
  const batch = nextBatch(input.scope, input.enrollmentId);
  if (batch.length === 0) return;
  const changeIds = batch.map((change) => change.changeId);
  try {
    const { result } = await rpcFn<SyncPushResult>(
      input.connection,
      'sync.push',
      { changes: batch },
      input.accessToken,
    );
    if (!isRecord(result) || !Array.isArray(result.results)) {
      throw new SyncEngineError('sync.push returned a malformed result', { retryable: false });
    }
    applyPushResults(input.scope, result.results.map(mapPushItemResult));
  } catch (error) {
    requeueDispatched(input.scope, changeIds);
    throw error;
  }
}

async function pullCycle(input: RunSyncCycleInput, rpcFn: SyncEngineRpc): Promise<void> {
  const maxBytes = input.connection.limits?.pageBytes ?? DEFAULT_LIMITS.pageBytes;
  const cursor = (getSyncState(input.scope)?.cursor ?? null) as SyncCursor | null;
  const params: SyncPullParams = { cursor, maxBytes };
  const { result } = await rpcFn<SyncPullResult>(
    input.connection,
    'sync.pull',
    params,
    input.accessToken,
  );
  if (
    !isRecord(result) ||
    !Array.isArray(result.changes) ||
    typeof result.nextCursor !== 'string'
  ) {
    throw new SyncEngineError('sync.pull returned a malformed result', { retryable: false });
  }
  applyPullPage(input.scope, result);
}

/**
 * Reverts dispatched outbox rows so a failed transport does not consume
 * enrollment sequences. nextBatch has already marked the batch dispatched.
 */
function requeueDispatched(scope: SyncScope, changeIds: string[]): void {
  if (changeIds.length === 0) return;
  const placeholders = changeIds.map(() => '?').join(', ');
  getDb()
    .prepare(
      `UPDATE sync_outbox
       SET state = 'pending', enrollment_sequence = NULL, dispatched_at = NULL
       WHERE ${SCOPE_WHERE} AND state = 'dispatched' AND change_id IN (${placeholders})`,
    )
    .run(...scopeParams(scope), ...changeIds);
}

function mapPushItemResult(item: SyncPushItemResult): PushResult {
  switch (item.status) {
    case 'accepted':
      return { changeId: item.changeId, revision: item.revision, status: 'accepted' };
    case 'conflict':
      return {
        changeId: item.changeId,
        remotePayload: item.remoteContent,
        remoteRevision: item.remoteRevision,
        status: 'conflict',
      };
    case 'rejected':
      return { changeId: item.changeId, status: 'rejected' };
    case 'reset-required':
      return { changeId: item.changeId, status: 'reset-required' };
    case 'receipt-expired':
      return { changeId: item.changeId, status: 'receipt-expired' };
    default: {
      const unhandled: never = item;
      throw new SyncEngineError(`Unhandled push item status: ${String(unhandled)}`, {
        retryable: false,
      });
    }
  }
}

function applyPullPage(scope: SyncScope, page: SyncPullResult): void {
  const run = getDb().transaction(() => {
    for (const change of page.changes) {
      applySyncedChange(scope, change);
    }
    updateSyncState(scope, { cursor: page.nextCursor, lastPullAt: nowIso() });
  });
  run();
}

function applySyncedChange(scope: SyncScope, change: SyncedChange): void {
  const binding = getBinding(scope, change.entityType, change.entityId);
  const payloadJson = change.payload === undefined ? null : canonicalJson(change.payload);
  if (binding) {
    if (binding.baseRevision !== null && change.revision <= binding.baseRevision) {
      return;
    }
    const dirty = binding.localEditGeneration > binding.acknowledgedGeneration;
    const differsFromBase =
      change.revision !== binding.baseRevision || payloadJson !== (binding.basePayloadJson ?? null);
    if (dirty && differsFromBase) {
      insertEditConflict(scope, change, binding.basePayloadJson, binding.baseRevision, payloadJson);
      return;
    }
    writeBindingBase(scope, change.entityType, change.entityId, change.revision, payloadJson);
    applyDomainProjection(change);
    return;
  }

  upsertBinding(scope, change.entityType, change.entityId, {
    baseRevision: change.revision,
    basePayloadJson: payloadJson,
  });
  applyDomainProjection(change);
}

function writeBindingBase(
  scope: SyncScope,
  entityType: string,
  entityId: string,
  revision: number,
  payloadJson: string | null,
): void {
  const existing = getBinding(scope, entityType, entityId);
  const now = nowIso();
  if (!existing) {
    upsertBinding(scope, entityType, entityId, {
      baseRevision: revision,
      basePayloadJson: payloadJson,
    });
    return;
  }
  getDb()
    .prepare(
      `UPDATE sync_bindings
       SET base_revision = ?,
           base_payload_json = ?,
           acknowledged_generation = local_edit_generation,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(revision, payloadJson, now, existing.id);
}

function insertEditConflict(
  scope: SyncScope,
  change: SyncedChange,
  basePayloadJson: string | null,
  baseRevision: number | null,
  remotePayloadJson: string | null,
): void {
  const unresolved = getDb()
    .prepare(
      `SELECT id FROM sync_conflicts
       WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ? AND resolved_at IS NULL
       LIMIT 1`,
    )
    .get(...scopeParams(scope), change.entityType, change.entityId) as { id: string } | undefined;
  if (unresolved) return;

  const kind: SyncConflictKind = 'edit-edit';
  getDb()
    .prepare(
      `INSERT INTO sync_conflicts
         (id, backend_id, account_id, dataset_epoch, entity_type, entity_id,
          base_payload_json, local_payload_json, remote_payload_json, base_revision,
          remote_revision, kind, created_at, resolved_at, resolution)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(
      randomUUID(),
      scope.backendId,
      scope.accountId,
      scope.datasetEpoch,
      change.entityType,
      change.entityId,
      basePayloadJson,
      readLocalPayloadJson(change.entityType, change.entityId),
      remotePayloadJson,
      baseRevision,
      change.revision,
      kind,
      nowIso(),
    );
}

function readLocalPayloadJson(entityType: string, entityId: string): string | null {
  if (entityType !== SYNC_ENTITY_WORKFLOW_TEMPLATE) return null;
  const row = getDb()
    .prepare('SELECT id, name, description, graph_json FROM workflow_templates WHERE id = ?')
    .get(entityId) as
    | { id: string; name: string; description: string; graph_json: string }
    | undefined;
  if (!row) return null;
  const graph = parseGraphJson(row.graph_json);
  return canonicalJson({
    id: row.id,
    name: row.name,
    description: row.description,
    nodes: graph.nodes,
    edges: graph.edges,
    orchestration: graph.orchestration,
  });
}

function applyDomainProjection(change: SyncedChange): void {
  if (change.entityType !== SYNC_ENTITY_WORKFLOW_TEMPLATE) return;
  switch (change.operation) {
    case 'create':
    case 'update': {
      upsertWorkflowTemplateFromPayload(change.entityId, change.payload);
      break;
    }
    case 'delete': {
      getDb().prepare('DELETE FROM workflow_templates WHERE id = ?').run(change.entityId);
      break;
    }
    default: {
      const unhandled: never = change.operation;
      throw new SyncEngineError(`Unhandled synced operation: ${String(unhandled)}`, {
        retryable: false,
      });
    }
  }
}

function upsertWorkflowTemplateFromPayload(entityId: string, payload: unknown): void {
  if (!isRecord(payload)) return;
  if (!Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) return;
  const name = typeof payload.name === 'string' ? payload.name : '';
  const description = typeof payload.description === 'string' ? payload.description : '';
  const graphJson = JSON.stringify({
    nodes: payload.nodes,
    edges: payload.edges,
    orchestration: payload.orchestration,
  });
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO workflow_templates (id, name, description, graph_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         graph_json = excluded.graph_json,
         updated_at = excluded.updated_at`,
    )
    .run(entityId, name, description, graphJson, now, now);
}

function parseGraphJson(graphJson: string): {
  nodes: unknown;
  edges: unknown;
  orchestration: unknown;
} {
  const parsed: unknown = JSON.parse(graphJson);
  if (!isRecord(parsed)) {
    return { nodes: [], edges: [], orchestration: undefined };
  }
  return {
    nodes: parsed.nodes,
    edges: parsed.edges,
    orchestration: parsed.orchestration,
  };
}

function toSyncEngineError(error: unknown): SyncEngineError {
  if (error instanceof SyncEngineError) return error;
  if (error instanceof BackendRpcError) {
    return new SyncEngineError(error.message, {
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  const httpMatch = /HTTP (\d+)/.exec(message);
  const status = httpMatch ? Number(httpMatch[1]) : undefined;
  const retryable = status === undefined || status >= 500;
  return new SyncEngineError(message, { retryable });
}
