import { randomUUID } from 'node:crypto';
import { DEFAULT_LIMITS, type ContractLimits } from '../../../cloud/contract/version.js';
import type {
  SyncCursor,
  SyncPullParams,
  SyncPullResult,
  SyncPushItemResult,
  SyncPushResult,
  SyncScanBeginResult,
  SyncScanFinishResult,
  SyncScanPageResult,
  SyncedChange,
} from '../../../cloud/contract/sync.js';
import {
  SYNC_ENTITY_WORKFLOW_TEMPLATE,
  type PushResult,
  type SyncConflict,
  type SyncConflictKind,
  type SyncConflictResolution,
  type SyncOperation,
  type SyncScope,
} from '../../shared/sync-mesh.js';
import {
  acknowledgeBindingLocalEdits,
  applyPushResults,
  beginScanStaging,
  canonicalJson,
  clearScanStaging,
  deleteBinding,
  deleteMutableOutboxRows,
  deletePendingOutboxRows,
  getBinding,
  getSyncState,
  insertUnresolvedConflict,
  listBindings,
  listMutableOutboxRows,
  listScanStaging,
  listSyncScopesForEntity,
  nextBatch,
  recordLocalChange,
  rejectDispatchedRows,
  resolveConflict,
  setBindingBase,
  setBindingQuarantine,
  stageScanChange,
  stageScanEntities,
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
const PULL_PAGE_LIMIT = 100;
const SCAN_PAGE_LIMIT = 500;
const CATCHUP_PAGE_LIMIT = 500;

export type SyncEngineRpc = <R = unknown>(
  connection: Pick<BackendConnection, 'apiUrl'>,
  operation: string,
  params: unknown,
  accessToken: string,
) => Promise<RpcResult<R>>;

export interface SyncEngineConnection extends Pick<BackendConnection, 'apiUrl'> {
  limits?: Partial<ContractLimits>;
}

export interface RunSyncCycleInput {
  scope: SyncScope;
  /** Active device enrollment; required for push sequencing. */
  enrollmentId: string;
  connection: SyncEngineConnection;
  accessToken: string;
  rpc?: SyncEngineRpc;
  /**
   * Account/backend fence: evaluated before every durable write that follows an
   * asynchronous boundary. Returning false aborts the cycle non-retryably so a
   * sign-out or backend switch cannot let stale in-flight work land.
   */
  guard?: () => boolean;
}

export interface SyncEngineSnapshot {
  lastPushAt: string | null;
  lastPullAt: string | null;
  inFlight: boolean;
  pendingCount: number;
  dispatchedCount: number;
  /** Terminal-rejected outbox rows needing user attention. */
  rejectedCount: number;
  /** reset_required is set: the next cycle re-scans from the server. */
  recovering: boolean;
  /** At least one rejection was the account history quota (OPS-01). */
  quotaExceeded: boolean;
}

export class SyncEngineError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly code?: string;

  constructor(
    message: string,
    options: { retryable: boolean; retryAfterMs?: number; code?: string },
  ) {
    super(message);
    this.name = 'SyncEngineError';
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.code = options.code;
  }
}

interface QueuedCycle {
  input: RunSyncCycleInput;
  settle: (error: unknown) => void;
}

interface ScopeLoop {
  inFlight: Promise<void> | null;
  queued: QueuedCycle | null;
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

function isSyncOperation(value: unknown): value is SyncOperation {
  return value === 'create' || value === 'update' || value === 'delete';
}

function getLoop(key: string): ScopeLoop {
  const existing = loops.get(key);
  if (existing) return existing;
  const created: ScopeLoop = { inFlight: null, queued: null };
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
  const rows = listMutableCounts(scope);
  const quota = getDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM sync_outbox
       WHERE ${SCOPE_WHERE} AND state = 'rejected'
         AND result_json LIKE '%"quota-exceeded"%'`,
    )
    .get(...scopeParams(scope)) as { count: number };
  return {
    lastPushAt: state?.lastPushAt ?? null,
    lastPullAt: state?.lastPullAt ?? null,
    inFlight: loop?.inFlight != null,
    pendingCount: rows.pending,
    dispatchedCount: rows.dispatched,
    rejectedCount: rows.rejected,
    recovering: state?.resetRequired ?? false,
    quotaExceeded: quota.count > 0,
  };
}

function listMutableCounts(scope: SyncScope): {
  pending: number;
  dispatched: number;
  rejected: number;
} {
  const rows = getDb()
    .prepare(
      `SELECT state, COUNT(*) AS count FROM sync_outbox
       WHERE ${SCOPE_WHERE} AND state IN ('pending', 'dispatched', 'rejected') GROUP BY state`,
    )
    .all(...scopeParams(scope)) as Array<{ state: string; count: number }>;
  let pending = 0;
  let dispatched = 0;
  let rejected = 0;
  for (const row of rows) {
    if (row.state === 'pending') pending = row.count;
    if (row.state === 'dispatched') dispatched = row.count;
    if (row.state === 'rejected') rejected = row.count;
  }
  return { pending, dispatched, rejected };
}

/**
 * One serialized push/pull cycle per SyncScope. Overlapping callers coalesce to
 * a single extra run after the in-flight cycle (not a parallel loop).
 */
export async function runSyncCycle(input: RunSyncCycleInput): Promise<void> {
  const key = scopeKey(input.scope);
  const loop = getLoop(key);
  if (loop.inFlight !== null) {
    // A cycle for this scope is already running. This caller takes the queue
    // slot and receives the outcome of ITS OWN cycle — a predecessor's
    // superseded/backoff error must not propagate into this call. A caller
    // displaced by a newer request resolves as coalesced rather than hanging.
    return new Promise<void>((resolve, reject) => {
      loop.queued?.settle(null);
      loop.queued = {
        input,
        settle: (error) => (error === null ? resolve() : reject(error)),
      };
    });
  }

  const outcome = new Promise<void>((resolve, reject) => {
    const run = (async () => {
      let current: QueuedCycle = {
        input,
        settle: (error) => (error === null ? resolve() : reject(error)),
      };
      try {
        for (;;) {
          try {
            await executeOneCycle(current.input);
            current.settle(null);
          } catch (error) {
            current.settle(error);
          }
          const next = loop.queued;
          loop.queued = null;
          if (next === null) {
            break;
          }
          current = next;
        }
      } finally {
        loop.inFlight = null;
      }
    })();
    loop.inFlight = run;
    // `run` never rejects — every outcome routes through `settle` — but guard
    // the invariant so a defect can never surface as an unhandled rejection.
    void run.catch(() => undefined);
  });
  await outcome;
}

function assertCurrent(input: RunSyncCycleInput): void {
  if (input.guard !== undefined && !input.guard()) {
    throw new SyncEngineError('sync operation superseded by an account or backend change', {
      retryable: false,
      code: 'superseded',
    });
  }
}

function negotiatedLimits(input: RunSyncCycleInput): Required<ContractLimits> {
  return {
    entityBytes: input.connection.limits?.entityBytes ?? DEFAULT_LIMITS.entityBytes,
    pageBytes: input.connection.limits?.pageBytes ?? DEFAULT_LIMITS.pageBytes,
    batchChanges: input.connection.limits?.batchChanges ?? DEFAULT_LIMITS.batchChanges,
    liveFrameBytes: input.connection.limits?.liveFrameBytes ?? DEFAULT_LIMITS.liveFrameBytes,
  };
}

async function executeOneCycle(input: RunSyncCycleInput): Promise<void> {
  const key = scopeKey(input.scope);
  const until = backoffUntil.get(key);
  if (until !== undefined && Date.now() < until) {
    throw new SyncEngineError('sync engine is backing off', {
      retryable: true,
      retryAfterMs: until - Date.now(),
      code: 'backoff',
    });
  }
  if (input.enrollmentId.trim() === '') {
    throw new SyncEngineError('sync push requires an active enrollment id', {
      retryable: false,
      code: 'enrollment-required',
    });
  }

  const rpcFn = input.rpc ?? defaultRpc;
  try {
    // Fence before any durable write: a superseded cycle must not even mark
    // outbox rows dispatched under the dead scope.
    assertCurrent(input);
    try {
      await pushCycle(input, rpcFn);
    } catch (error) {
      // A top-level reset/receipt-expired/epoch answer cannot be retried into
      // success; flag the scope and continue into the scan recovery path.
      const mapped = toSyncEngineError(error);
      if (
        mapped.code === 'reset-required' ||
        mapped.code === 'receipt-expired' ||
        mapped.code === 'epoch-mismatch'
      ) {
        updateSyncState(input.scope, { resetRequired: true });
      } else {
        throw mapped;
      }
    }
    if (getSyncState(input.scope)?.resetRequired === true) {
      await scanCycle(input, rpcFn);
    }
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
  const limits = negotiatedLimits(input);
  const batch = nextBatch(input.scope, input.enrollmentId, {
    entityBytes: limits.entityBytes,
    maxBytes: limits.pageBytes,
    maxChanges: limits.batchChanges,
  });
  if (batch.length === 0) return;
  const { result } = await rpcFn<SyncPushResult>(
    input.connection,
    'sync.push',
    { changes: batch, epoch: input.scope.datasetEpoch },
    input.accessToken,
  );
  assertCurrent(input);
  if (!isRecord(result) || !Array.isArray(result.results)) {
    throw new SyncEngineError('sync.push returned a malformed result', {
      retryable: false,
      code: 'malformed',
    });
  }
  applyPushResults(input.scope, result.results.map(mapPushItemResult));
  updateSyncState(input.scope, { lastPushAt: nowIso() });
}

async function pullCycle(input: RunSyncCycleInput, rpcFn: SyncEngineRpc): Promise<void> {
  const limits = negotiatedLimits(input);
  for (let page = 0; page < PULL_PAGE_LIMIT; page += 1) {
    const cursor = (getSyncState(input.scope)?.cursor ?? null) as SyncCursor | null;
    const params: SyncPullParams = { cursor, maxBytes: limits.pageBytes };
    const { result } = await rpcFn<SyncPullResult>(
      input.connection,
      'sync.pull',
      params,
      input.accessToken,
    );
    assertCurrent(input);
    if (
      !isRecord(result) ||
      !Array.isArray(result.changes) ||
      typeof result.nextCursor !== 'string' ||
      typeof result.hasMore !== 'boolean'
    ) {
      throw new SyncEngineError('sync.pull returned a malformed result', {
        retryable: false,
        code: 'malformed',
      });
    }
    applyPullPage(input, result);
    if (!result.hasMore) return;
  }
  throw new SyncEngineError('sync.pull exceeded the page safety limit', {
    retryable: true,
    code: 'malformed',
  });
}

/**
 * Staged rebuild (spec §5): stage scan pages, catch up changes in
 * (watermarkStart, watermarkEnd], then activate atomically. No page touches
 * visible domain state; an interrupted scan leaves durable staging that the
 * next begin discards safely.
 */
async function scanCycle(input: RunSyncCycleInput, rpcFn: SyncEngineRpc): Promise<void> {
  const limits = negotiatedLimits(input);
  const { result: begin } = await rpcFn<SyncScanBeginResult>(
    input.connection,
    'sync.scan.begin',
    { epoch: input.scope.datasetEpoch },
    input.accessToken,
  );
  if (
    !isRecord(begin) ||
    typeof begin.scanId !== 'string' ||
    typeof begin.watermarkStart !== 'number' ||
    !Number.isInteger(begin.watermarkStart) ||
    typeof begin.epoch !== 'string' ||
    typeof begin.resumeCursor !== 'string'
  ) {
    throw new SyncEngineError('sync.scan.begin returned a malformed result', {
      retryable: false,
      code: 'malformed',
    });
  }
  if (begin.epoch !== input.scope.datasetEpoch) {
    throw new SyncEngineError('backend dataset epoch changed', {
      retryable: false,
      code: 'epoch-mismatch',
    });
  }
  assertCurrent(input);
  beginScanStaging(input.scope, begin.scanId, begin.watermarkStart);

  let cursor: string | null = null;
  for (let page = 0; page < SCAN_PAGE_LIMIT; page += 1) {
    const pageResponse = await rpcFn<SyncScanPageResult>(
      input.connection,
      'sync.scan.page',
      { scanId: begin.scanId, cursor, maxBytes: limits.pageBytes },
      input.accessToken,
    );
    const scanned: SyncScanPageResult = pageResponse.result;
    if (
      !isRecord(scanned) ||
      !Array.isArray(scanned.entities) ||
      typeof scanned.done !== 'boolean'
    ) {
      throw new SyncEngineError('sync.scan.page returned a malformed result', {
        retryable: false,
        code: 'malformed',
      });
    }
    assertCurrent(input);
    stageScanEntities(input.scope, toStagedEntities(scanned.entities));
    if (scanned.done) break;
    if (typeof scanned.nextCursor !== 'string') {
      throw new SyncEngineError('sync.scan.page omitted nextCursor before done', {
        retryable: false,
        code: 'malformed',
      });
    }
    cursor = scanned.nextCursor;
    if (page === SCAN_PAGE_LIMIT - 1) {
      throw new SyncEngineError('sync.scan.page exceeded the page safety limit', {
        retryable: true,
        code: 'malformed',
      });
    }
  }

  const { result: finish } = await rpcFn<SyncScanFinishResult>(
    input.connection,
    'sync.scan.finish',
    { scanId: begin.scanId },
    input.accessToken,
  );
  if (
    !isRecord(finish) ||
    typeof finish.nextCursor !== 'string' ||
    typeof finish.watermarkEnd !== 'number' ||
    !Number.isInteger(finish.watermarkEnd) ||
    typeof finish.epoch !== 'string'
  ) {
    throw new SyncEngineError('sync.scan.finish returned a malformed result', {
      retryable: false,
      code: 'malformed',
    });
  }
  if (finish.epoch !== input.scope.datasetEpoch) {
    throw new SyncEngineError('backend dataset epoch changed during scan', {
      retryable: false,
      code: 'epoch-mismatch',
    });
  }

  // Catch-up: apply every change in (watermarkStart, watermarkEnd] onto the
  // staged snapshot so activation reflects state at the end watermark.
  let catchUpCursor = begin.resumeCursor;
  for (let page = 0; page < CATCHUP_PAGE_LIMIT; page += 1) {
    const { result: catchUp } = await rpcFn<SyncPullResult>(
      input.connection,
      'sync.pull',
      { cursor: catchUpCursor, maxBytes: limits.pageBytes },
      input.accessToken,
    );
    assertCurrent(input);
    if (
      !isRecord(catchUp) ||
      !Array.isArray(catchUp.changes) ||
      typeof catchUp.nextCursor !== 'string' ||
      typeof catchUp.hasMore !== 'boolean'
    ) {
      throw new SyncEngineError('sync.pull (scan catch-up) returned a malformed result', {
        retryable: false,
        code: 'malformed',
      });
    }
    let reachedEnd = false;
    for (const change of catchUp.changes) {
      const validated = toSyncedChange(change);
      if (validated === null) {
        throw new SyncEngineError('sync.pull returned a malformed change', {
          retryable: false,
          code: 'malformed',
        });
      }
      if (validated.sequence > finish.watermarkEnd) {
        reachedEnd = true;
        break;
      }
      stageScanChange(input.scope, {
        entityType: validated.entityType,
        entityId: validated.entityId,
        operation: validated.operation,
        payloadJson:
          validated.payload === undefined ? null : canonicalJson(validated.payload),
        revision: validated.revision,
        schemaVersion: validated.schemaVersion,
      });
    }
    catchUpCursor = catchUp.nextCursor;
    if (reachedEnd || !catchUp.hasMore) break;
    if (page === CATCHUP_PAGE_LIMIT - 1) {
      throw new SyncEngineError('scan catch-up exceeded the page safety limit', {
        retryable: true,
        code: 'malformed',
      });
    }
  }

  assertCurrent(input);
  activateStagedScan(input.scope, finish.nextCursor);
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
      return { changeId: item.changeId, reason: item.reason, status: 'rejected' };
    case 'reset-required':
      return { changeId: item.changeId, status: 'reset-required' };
    case 'receipt-expired':
      return { changeId: item.changeId, status: 'receipt-expired' };
    default: {
      const unhandled: never = item;
      throw new SyncEngineError(`Unhandled push item status: ${String(unhandled)}`, {
        retryable: false,
        code: 'malformed',
      });
    }
  }
}

function applyPullPage(input: RunSyncCycleInput, page: SyncPullResult): void {
  const run = getDb().transaction(() => {
    for (const raw of page.changes) {
      const change = toSyncedChange(raw);
      if (change === null) {
        throw new SyncEngineError('sync.pull returned a malformed change', {
          retryable: false,
          code: 'malformed',
        });
      }
      applySyncedChange(input.scope, change);
    }
    updateSyncState(input.scope, { cursor: page.nextCursor, lastPullAt: nowIso() });
  });
  run();
}

/**
 * Structural validation of a wire change. Returns null when the entity cannot
 * even be identified; unsupported-but-well-formed content is quarantined later.
 */
function toSyncedChange(value: unknown): SyncedChange | null {
  if (!isRecord(value)) return null;
  if (typeof value.entityType !== 'string' || value.entityType.length === 0) return null;
  if (typeof value.entityId !== 'string' || value.entityId.length === 0) return null;
  if (typeof value.revision !== 'number' || !Number.isInteger(value.revision)) return null;
  if (typeof value.schemaVersion !== 'number' || !Number.isInteger(value.schemaVersion)) {
    return null;
  }
  if (typeof value.sequence !== 'number' || !Number.isInteger(value.sequence)) return null;
  if (!isSyncOperation(value.operation)) return null;
  const change: SyncedChange = {
    entityType: value.entityType,
    entityId: value.entityId,
    operation: value.operation,
    revision: value.revision,
    schemaVersion: value.schemaVersion,
    sequence: value.sequence,
  };
  if (Object.prototype.hasOwnProperty.call(value, 'payload')) {
    change.payload = value.payload;
  }
  return change;
}

function toStagedEntities(value: unknown[]): Array<{
  entityType: string;
  entityId: string;
  revision: number;
  schemaVersion: number;
  payloadJson: string | null;
}> {
  const entities: Array<{
    entityType: string;
    entityId: string;
    revision: number;
    schemaVersion: number;
    payloadJson: string | null;
  }> = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.entityType !== 'string' || item.entityType.length === 0) continue;
    if (typeof item.entityId !== 'string' || item.entityId.length === 0) continue;
    if (typeof item.revision !== 'number' || !Number.isInteger(item.revision)) continue;
    if (typeof item.schemaVersion !== 'number' || !Number.isInteger(item.schemaVersion)) continue;
    entities.push({
      entityType: item.entityType,
      entityId: item.entityId,
      payloadJson: item.payload === undefined ? null : canonicalJson(item.payload),
      revision: item.revision,
      schemaVersion: item.schemaVersion,
    });
  }
  return entities;
}

/**
 * Why a remote entity cannot be applied as a domain projection. Unknown types
 * and unsupported/malformed payloads are quarantined on the binding with their
 * revision so later, understood revisions can flow normally.
 */
function entityQuarantineReason(
  entityType: string,
  schemaVersion: number,
  payloadJson: string | null,
): string | null {
  if (entityType !== SYNC_ENTITY_WORKFLOW_TEMPLATE) return 'unsupported-entity-type';
  if (schemaVersion !== 1) return 'unsupported-schema-version';
  if (payloadJson === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return 'malformed-payload';
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    return 'malformed-payload';
  }
  return null;
}

/**
 * Atomically activates the staged rebuild: adopts the remote base for clean
 * entities, preserves local dirty work (conflict or queued mutation), applies
 * remote deletes to clean entities only, and reconciles remote/local ID
 * collisions without overwriting either version.
 */
function activateStagedScan(scope: SyncScope, nextCursor: string): void {
  const run = getDb().transaction(() => {
    const staged = listScanStaging(scope);
    const stagedKeys = new Map(staged.map((entity) => [
      `${entity.entityType}\0${entity.entityId}`,
      entity,
    ]));
    const bindings = new Map(
      listBindings(scope).map((binding) => [
        `${binding.entityType}\0${binding.entityId}`,
        binding,
      ]),
    );

    for (const entity of staged) {
      const key = `${entity.entityType}\0${entity.entityId}`;
      const binding = bindings.get(key);
      const quarantineReason = entityQuarantineReason(
        entity.entityType,
        entity.schemaVersion,
        entity.payloadJson,
      );
      if (binding === undefined) {
        if (quarantineReason !== null) {
          upsertBinding(scope, entity.entityType, entity.entityId, {
            baseRevision: entity.revision,
            basePayloadJson: entity.payloadJson,
            quarantineJson: entity.payloadJson,
          });
          continue;
        }
        const domainJson = readLocalPayloadJson(entity.entityType, entity.entityId);
        const foreignBound =
          listSyncScopesForEntity(entity.entityType, entity.entityId).length > 0;
        if (domainJson === null && !foreignBound) {
          upsertBinding(scope, entity.entityType, entity.entityId, {
            baseRevision: entity.revision,
            basePayloadJson: entity.payloadJson,
          });
          applyDomainProjection({
            entityType: entity.entityType,
            entityId: entity.entityId,
            operation: 'create',
            payload: entity.payloadJson === null ? undefined : JSON.parse(entity.payloadJson),
            revision: entity.revision,
            schemaVersion: entity.schemaVersion,
            sequence: entity.revision,
          });
          continue;
        }
        upsertBinding(scope, entity.entityType, entity.entityId, {
          baseRevision: entity.revision,
          basePayloadJson: entity.payloadJson,
        });
        if (domainJson === null || domainJson === entity.payloadJson) {
          // Same content or a foreign-scope entity with no local row: adopt the
          // base without touching the domain row.
          continue;
        }
        // Collision: the same entity id holds different content locally. Keep
        // both versions under review; never overwrite either.
        insertUnresolvedConflict(scope, {
          basePayloadJson: null,
          baseRevision: null,
          entityId: entity.entityId,
          entityType: entity.entityType,
          kind: 'edit-edit',
          localPayloadJson: domainJson,
          remotePayloadJson: entity.payloadJson,
          remoteRevision: entity.revision,
        });
        continue;
      }

      if (quarantineReason !== null) {
        setBindingBase(scope, entity.entityType, entity.entityId, entity.revision, entity.payloadJson);
        setBindingQuarantine(scope, entity.entityType, entity.entityId, entity.payloadJson);
        continue;
      }

      const domainJson = readLocalPayloadJson(entity.entityType, entity.entityId);
      const dirty =
        binding.localEditGeneration > binding.acknowledgedGeneration ||
        listMutableOutboxRows(scope, entity.entityType, entity.entityId).length > 0;
      if (!dirty) {
        setBindingBase(scope, entity.entityType, entity.entityId, entity.revision, entity.payloadJson);
        setBindingQuarantine(scope, entity.entityType, entity.entityId, null);
        if (domainJson !== entity.payloadJson) {
          applyDomainProjection({
            entityType: entity.entityType,
            entityId: entity.entityId,
            operation: domainJson === null ? 'create' : 'update',
            payload:
              entity.payloadJson === null ? undefined : JSON.parse(entity.payloadJson),
            revision: entity.revision,
            schemaVersion: entity.schemaVersion,
            sequence: entity.revision,
          });
        }
        continue;
      }
      if (domainJson !== null && domainJson === entity.payloadJson) {
        // Converged: remote state equals the local edit. Adopt the base and
        // retire the queued intent without sending a no-op mutation.
        setBindingBase(scope, entity.entityType, entity.entityId, entity.revision, entity.payloadJson);
        acknowledgeBindingLocalEdits(scope, entity.entityType, entity.entityId);
        deletePendingOutboxRows(scope, entity.entityType, entity.entityId);
        rejectDispatchedRows(scope, entity.entityType, entity.entityId, 'reset-uncertain');
        continue;
      }
      // Dirty and differing: adopt the staged remote as the new base and keep
      // the local intent under review. Pending mutations stay queued (blocked
      // by the conflict) and rebase onto the new base when it resolves.
      insertUnresolvedConflict(scope, {
        basePayloadJson: binding.basePayloadJson,
        baseRevision: binding.baseRevision,
        entityId: entity.entityId,
        entityType: entity.entityType,
        kind: domainJson === null ? 'delete-edit' : 'edit-edit',
        localPayloadJson: domainJson,
        remotePayloadJson: entity.payloadJson,
        remoteRevision: entity.revision,
      });
      setBindingBase(scope, entity.entityType, entity.entityId, entity.revision, entity.payloadJson);
    }

    // Bound entities absent from the rebuilt remote state.
    for (const binding of bindings.values()) {
      const key = `${binding.entityType}\0${binding.entityId}`;
      if (stagedKeys.has(key)) continue;
      const domainJson = readLocalPayloadJson(binding.entityType, binding.entityId);
      const dirty =
        binding.localEditGeneration > binding.acknowledgedGeneration ||
        listMutableOutboxRows(scope, binding.entityType, binding.entityId).length > 0;
      if (!dirty) {
        deleteBinding(scope, binding.entityType, binding.entityId);
        if (listSyncScopesForEntity(binding.entityType, binding.entityId).length === 0) {
          deleteDomainRow(binding.entityType, binding.entityId);
        }
        continue;
      }
      if (domainJson === null) {
        // Local row is already gone (a pending delete); remote absence means
        // both sides converged on deletion.
        deleteMutableOutboxRows(scope, binding.entityType, binding.entityId);
        deleteBinding(scope, binding.entityType, binding.entityId);
        continue;
      }
      // Remote deleted it while local edits were unacknowledged: preserve the
      // local version for an explicit decision. No silent resurrection.
      insertUnresolvedConflict(scope, {
        basePayloadJson: binding.basePayloadJson,
        baseRevision: binding.baseRevision,
        entityId: binding.entityId,
        entityType: binding.entityType,
        kind: 'edit-delete',
        localPayloadJson: domainJson,
        remotePayloadJson: null,
        remoteRevision: null,
      });
      setBindingBase(scope, binding.entityType, binding.entityId, null, null);
      rejectDispatchedRows(scope, binding.entityType, binding.entityId, 'reset-uncertain');
    }

    updateSyncState(scope, { cursor: nextCursor, resetRequired: false });
    clearScanStaging(scope);
  });
  run();
}

export interface ResolveSyncConflictInput {
  conflictId: string;
  resolution: SyncConflictResolution;
  /** When set, the conflict must belong to this scope (ownership check). */
  scope?: SyncScope;
}

/**
 * Keep-local: the observed remote state becomes the acknowledged base and the
 * recorded local intent redispatches — the pending successor (or the re-queued
 * conflicted row) is rebased and re-hashed at dispatch. Use-remote: replace the
 * local row with the remote payload and drop queued mutations for that entity.
 * Save-copy: the remote state takes the canonical entity (as use-remote) and
 * the local version is preserved as a new, separately synced entity.
 */
export function resolveSyncConflict(input: ResolveSyncConflictInput): void {
  const row = getConflictById(input.conflictId);
  if (!row) throw new SyncEngineError(`Unknown conflict ${input.conflictId}`, { retryable: false });
  if (row.resolvedAt !== null) {
    throw new SyncEngineError(`Conflict ${input.conflictId} is already resolved`, {
      retryable: false,
    });
  }
  if (
    input.scope !== undefined &&
    (row.scope.backendId !== input.scope.backendId ||
      row.scope.accountId !== input.scope.accountId ||
      row.scope.datasetEpoch !== input.scope.datasetEpoch)
  ) {
    throw new SyncEngineError(`Conflict ${input.conflictId} belongs to a different sync scope`, {
      retryable: false,
      code: 'scope-mismatch',
    });
  }

  const run = getDb().transaction(() => {
    if (input.resolution === 'keep-local') {
      requeueEntityForKeepLocal(row.scope, row.entityType, row.entityId, row);
      resolveConflict(row.id, 'keep-local');
      return;
    }
    if (input.resolution === 'use-remote' || input.resolution === 'save-copy') {
      if (input.resolution === 'save-copy') {
        saveLocalConflictCopy(row);
      }
      deleteMutableOutboxRows(row.scope, row.entityType, row.entityId);
      if (row.remotePayloadJson === null) {
        deleteBinding(row.scope, row.entityType, row.entityId);
        if (listSyncScopesForEntity(row.entityType, row.entityId).length === 0) {
          deleteDomainRow(row.entityType, row.entityId);
        }
      } else {
        const payload: unknown = JSON.parse(row.remotePayloadJson);
        applyDomainProjection({
          entityType: row.entityType,
          entityId: row.entityId,
          operation: 'update',
          payload,
          revision: row.remoteRevision ?? 0,
          schemaVersion: 1,
          sequence: row.remoteRevision ?? 0,
        });
        writeBindingBase(row.scope, row.entityType, row.entityId, row.remoteRevision ?? 0, row.remotePayloadJson);
      }
      resolveConflict(row.id, input.resolution);
      return;
    }
    const unhandled: never = input.resolution;
    throw new SyncEngineError(`Unhandled conflict resolution: ${String(unhandled)}`, {
      retryable: false,
    });
  });
  run();
}

function getConflictById(id: string): SyncConflict | null {
  const row = getDb().prepare('SELECT * FROM sync_conflicts WHERE id = ?').get(id) as
    | {
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
        kind: SyncConflictKind;
        created_at: string;
        resolved_at: string | null;
        resolution: SyncConflictResolution | null;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    scope: {
      backendId: row.backend_id,
      accountId: row.account_id,
      datasetEpoch: row.dataset_epoch,
    },
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

/**
 * Save-copy resolution: writes the local version out as a brand-new entity
 * under a fresh id, bound to the same scope and queued as a create so it
 * syncs to the account like any other local workflow. The caller then applies
 * the remote state to the canonical entity id.
 */
function saveLocalConflictCopy(conflict: SyncConflict): void {
  if (conflict.entityType !== SYNC_ENTITY_WORKFLOW_TEMPLATE) {
    throw new SyncEngineError(
      `save-copy is not supported for entity type ${conflict.entityType}`,
      { retryable: false },
    );
  }
  const localJson =
    conflict.localPayloadJson ?? readLocalPayloadJson(conflict.entityType, conflict.entityId);
  if (localJson === null) {
    throw new SyncEngineError('save-copy requires a local version to preserve', {
      retryable: false,
    });
  }
  const payload: unknown = JSON.parse(localJson);
  if (!isRecord(payload)) {
    throw new SyncEngineError('Local payload is not an object', { retryable: false });
  }
  const copyId = randomUUID();
  const baseName =
    typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : 'Workflow';
  const copyPayload = { ...payload, name: `${baseName} (local copy)` };
  upsertWorkflowTemplateFromPayload(copyId, copyPayload);
  upsertBinding(conflict.scope, conflict.entityType, copyId);
  recordLocalChange(conflict.scope, {
    entityType: conflict.entityType,
    entityId: copyId,
    operation: 'create',
    payload: copyPayload,
    schemaVersion: 1,
  });
}

/**
 * Keep-local resolution: the remote observation becomes the acknowledged base;
 * the newest pending successor (if any) keeps carrying the local intent, else
 * the conflicted row itself is re-queued. Either way the dispatched content is
 * normalized and re-hashed against the new base at dispatch time.
 */
function requeueEntityForKeepLocal(
  scope: SyncScope,
  entityType: string,
  entityId: string,
  conflict: SyncConflict,
): void {
  const db = getDb();
  setBindingBase(scope, entityType, entityId, conflict.remoteRevision, conflict.remotePayloadJson);
  const pending = db
    .prepare(
      `SELECT change_id FROM sync_outbox
       WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ? AND state = 'pending'
       LIMIT 1`,
    )
    .get(...scopeParams(scope), entityType, entityId) as { change_id: string } | undefined;
  if (pending !== undefined) {
    // The pending successor already carries the latest local content; the
    // conflicted row is superseded by it.
    db.prepare(
      `UPDATE sync_outbox SET state = 'rejected', result_json = ?
       WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ? AND state = 'conflict'`,
    ).run(
      JSON.stringify({ status: 'rejected', reason: 'superseded-by-local-edit' }),
      ...scopeParams(scope),
      entityType,
      entityId,
    );
    return;
  }
  // No newer local edit: the conflicted row's payload IS the local intent.
  // When the local intent was a delete and the remote is absent there is
  // nothing left to send.
  const conflicted = db
    .prepare(
      `SELECT operation FROM sync_outbox
       WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ? AND state = 'conflict'`,
    )
    .all(...scopeParams(scope), entityType, entityId) as Array<{ operation: SyncOperation }>;
  for (const row of conflicted) {
    if (row.operation === 'delete' && conflict.remotePayloadJson === null) {
      db.prepare(
        `DELETE FROM sync_outbox
         WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ? AND state = 'conflict'`,
      ).run(...scopeParams(scope), entityType, entityId);
      continue;
    }
    db.prepare(
      `UPDATE sync_outbox SET state = 'pending', enrollment_sequence = NULL, dispatched_at = NULL
       WHERE ${SCOPE_WHERE} AND entity_type = ? AND entity_id = ? AND state = 'conflict'`,
    ).run(...scopeParams(scope), entityType, entityId);
  }
  if (conflicted.length === 0 && conflict.localPayloadJson !== null) {
    // Collision-style conflict with no queued mutation (e.g. a local-only
    // entity whose id collided with remote content): re-record the local intent
    // so keep-local actually uploads it.
    recordLocalChange(scope, {
      entityId,
      entityType,
      operation: conflict.remotePayloadJson === null ? 'create' : 'update',
      payload: JSON.parse(conflict.localPayloadJson),
      schemaVersion: 1,
    });
  }
}

function applySyncedChange(scope: SyncScope, change: SyncedChange): void {
  const binding = getBinding(scope, change.entityType, change.entityId);
  const payloadJson = change.payload === undefined ? null : canonicalJson(change.payload);
  const quarantineReason =
    change.operation === 'delete'
      ? change.entityType === SYNC_ENTITY_WORKFLOW_TEMPLATE
        ? null
        : 'unsupported-entity-type'
      : entityQuarantineReason(change.entityType, change.schemaVersion, payloadJson);
  if (binding) {
    if (binding.baseRevision !== null && change.revision <= binding.baseRevision) {
      return;
    }
    const dirty =
      binding.localEditGeneration > binding.acknowledgedGeneration ||
      listMutableOutboxRows(scope, change.entityType, change.entityId).length > 0;
    const differsFromBase =
      change.revision !== binding.baseRevision || payloadJson !== (binding.basePayloadJson ?? null);
    if (dirty && differsFromBase) {
      insertEditConflict(scope, change, binding.basePayloadJson, binding.baseRevision, payloadJson);
      return;
    }
    writeBindingBase(scope, change.entityType, change.entityId, change.revision, payloadJson);
    if (quarantineReason !== null) {
      setBindingQuarantine(scope, change.entityType, change.entityId, payloadJson);
      return;
    }
    setBindingQuarantine(scope, change.entityType, change.entityId, null);
    applyDomainProjection(change);
    return;
  }

  // No binding in this scope. Deletes of unbound entities are no-ops.
  if (change.operation === 'delete') return;
  if (quarantineReason !== null) {
    upsertBinding(scope, change.entityType, change.entityId, {
      baseRevision: change.revision,
      basePayloadJson: payloadJson,
      quarantineJson: payloadJson,
    });
    return;
  }

  const domainJson = readLocalPayloadJson(change.entityType, change.entityId);
  const foreignBound = listSyncScopesForEntity(change.entityType, change.entityId).length > 0;
  if (domainJson === null && !foreignBound) {
    upsertBinding(scope, change.entityType, change.entityId, {
      baseRevision: change.revision,
      basePayloadJson: payloadJson,
    });
    applyDomainProjection(change);
    return;
  }
  // The entity id is already claimed by local-only content or another scope's
  // association: record the remote base and preserve both versions for review
  // instead of overwriting the local row.
  upsertBinding(scope, change.entityType, change.entityId, {
    baseRevision: change.revision,
    basePayloadJson: payloadJson,
  });
  if (domainJson !== null && domainJson !== payloadJson) {
    insertUnresolvedConflict(scope, {
      basePayloadJson: null,
      baseRevision: null,
      entityId: change.entityId,
      entityType: change.entityType,
      kind: 'edit-edit',
      localPayloadJson: domainJson,
      remotePayloadJson: payloadJson,
      remoteRevision: change.revision,
    });
  }
}

function writeBindingBase(
  scope: SyncScope,
  entityType: string,
  entityId: string,
  revision: number,
  payloadJson: string | null,
): void {
  setBindingBase(scope, entityType, entityId, revision, payloadJson);
  acknowledgeBindingLocalEdits(scope, entityType, entityId);
}

function insertEditConflict(
  scope: SyncScope,
  change: SyncedChange,
  basePayloadJson: string | null,
  baseRevision: number | null,
  remotePayloadJson: string | null,
): void {
  const localPayloadJson = readLocalPayloadJson(change.entityType, change.entityId);
  let kind: SyncConflictKind = 'edit-edit';
  if (remotePayloadJson === null && localPayloadJson !== null) kind = 'edit-delete';
  if (remotePayloadJson !== null && localPayloadJson === null) kind = 'delete-edit';
  insertUnresolvedConflict(scope, {
    basePayloadJson,
    baseRevision,
    entityId: change.entityId,
    entityType: change.entityType,
    kind,
    localPayloadJson,
    remotePayloadJson,
    remoteRevision: change.revision,
  });
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

function deleteDomainRow(entityType: string, entityId: string): void {
  if (entityType !== SYNC_ENTITY_WORKFLOW_TEMPLATE) return;
  getDb().prepare('DELETE FROM workflow_templates WHERE id = ?').run(entityId);
}

function applyDomainProjection(change: {
  entityType: string;
  entityId: string;
  operation: SyncOperation;
  payload?: unknown;
  revision: number;
  schemaVersion: number;
  sequence: number;
}): void {
  if (change.entityType !== SYNC_ENTITY_WORKFLOW_TEMPLATE) return;
  switch (change.operation) {
    case 'create':
    case 'update': {
      upsertWorkflowTemplateFromPayload(change.entityId, change.payload);
      break;
    }
    case 'delete': {
      deleteDomainRow(change.entityType, change.entityId);
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
      code: error.code,
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
