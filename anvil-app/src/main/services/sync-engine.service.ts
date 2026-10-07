import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DEFAULT_LIMITS, type ContractLimits } from '../../../cloud/contract/version.js';
import type {
  SyncCursor,
  SyncPullParams,
  SyncPullResult,
  SyncPushItemResult,
  SyncPushResult,
  ScannedEntity,
  SyncScanBeginResult,
  SyncScanFinishResult,
  SyncScanPageResult,
  SyncSnapshotBeginParams,
  SyncSnapshotChunkDescriptor,
  SyncSnapshotChunkGetResult,
  SyncSnapshotDocument,
  SyncSnapshotGetResult,
  SyncSnapshotManifest,
  SyncSnapshotVerifyResult,
  SyncedChange,
} from '../../../cloud/contract/sync.js';
import {
  canonicalSyncSnapshotManifestHashInput,
  canonicalizeJson,
  SYNC_SNAPSHOT_SCHEMA_VERSION,
} from '../../../cloud/contract/sync.js';
import {
  SYNC_ENTITY_SCHEMA_VERSIONS,
  SYNC_ENTITY_WORKSPACE_DEFINITION,
  type PushResult,
  type SyncConflict,
  type SyncConflictKind,
  type SyncConflictResolution,
  type SyncEntityType,
  type SyncOperation,
  type SyncScope,
} from '../../shared/sync-mesh.js';
import {
  applyRemoteEntityPayload,
  deleteLocalEntity,
  entityPayloadIssue,
  isWorkspaceSyncPaused,
  isSupportedEntityType,
  persistConflictCopy,
  readEntityPayloadJson,
} from './sync-entity-domain.js';
import {
  acknowledgeBindingLocalEdits,
  applyPushResults,
  beginScanStaging,
  canonicalJson,
  clearScanStaging,
  deleteBinding,
  deleteMutableOutboxRows,
  deletePendingOutboxRows,
  deletePausedInboundChange,
  getBinding,
  getUnresolvedConflict,
  getSyncState,
  insertUnresolvedConflict,
  listBindings,
  listMutableOutboxRows,
  listPausedInboundChanges,
  listScanStaging,
  listSyncScopesForEntity,
  nextBatch,
  recordLocalChange,
  rejectConflictedOutboxRows,
  rejectDispatchedRows,
  resolveConflict,
  setBindingBase,
  setBindingQuarantine,
  stageScanChange,
  stageScanEntities,
  storePausedInboundChange,
  updateSyncState,
  upsertBinding,
} from './sync-persistence.service.js';
import {
  BackendRpcError,
  rpc as defaultRpc,
  type BackendConnection,
  type RpcResult,
} from './sync-backend-client.service.js';
import {
  isCryptoBoundaryEntityType,
  isSealedEntityPayload,
  CRYPTO_ENTITY_DEVICE_IDENTITY,
} from '../../../cloud/contract/sealed.js';
import {
  AccountKeyUnavailableError,
  UnsealError,
  handleCryptoBoundaryEntity,
  retryQuarantinedEntities,
  sealAccountBytes,
  sealEntityPayload,
  unsealAccountBytes,
  unsealEntityPayload,
} from './sync-keyring.service.js';
import { getDb } from '../db/database.js';

const SCOPE_WHERE = 'backend_id = ? AND account_id = ? AND dataset_epoch = ?';
const DEFAULT_RETRY_MS = 1_000;
const PULL_PAGE_LIMIT = 100;
const SCAN_PAGE_LIMIT = 500;
const CATCHUP_PAGE_LIMIT = 500;
const SYNC_SNAPSHOT_CHUNK_BYTES = 256 * 1024;
const SYNC_SNAPSHOT_MAX_CHUNKS = 1_024;
const SYNC_SNAPSHOT_MAX_STORED_BYTES = SYNC_SNAPSHOT_CHUNK_BYTES * SYNC_SNAPSHOT_MAX_CHUNKS;
/** The plaintext document and encrypted upload each share the backend's 256 MiB size ceiling. */
export const SYNC_SNAPSHOT_MAX_EXPANDED_BYTES = SYNC_SNAPSHOT_MAX_STORED_BYTES;

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
  /**
   * BILL-05 hosted-access write gate. Evaluated before the push and before the
   * rescan; when it reports `allowed: false`, mutating calls (sync.push,
   * sync.scan.begin) are skipped while control/read calls (sync.pull) still
   * run. Outbox rows, cursors, conflicts, and reset_required are untouched, so
   * a restricted account pauses resumably instead of shedding local work.
   * Absent means writes are unrestricted (self-host backends).
   */
  writeGate?: () => { allowed: boolean };
  /**
   * Onboarding-only publication: may push this enrollment's device-identity
   * record, while pulls remain available. It never runs scans or snapshots.
   */
  writeMode?: 'device-identity-only';
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
  /** Backend-supplied error detail (e.g. `reason` on a hosted 403 refusal). */
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      retryAfterMs?: number;
      code?: string;
      details?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = 'SyncEngineError';
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.code = options.code;
    this.details = options.details;
  }
}

interface QueuedCycle {
  input: RunSyncCycleInput;
  settles: Array<(error: unknown) => void>;
}

interface ScopeLoop {
  inFlight: Promise<void> | null;
  queued: QueuedCycle | null;
}

const loops = new Map<string, ScopeLoop>();
const backoffUntil = new Map<string, number>();
const snapshotProbeAt = new Map<string, number>();
const SNAPSHOT_PROBE_INTERVAL_MS = 60 * 60 * 1000;
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SNAPSHOT_MAX_UNCOMPACTED_CHANGES = 10_000;

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
  snapshotProbeAt.clear();
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
    // displaced by a newer request is coalesced INTO the replacement: its
    // settle rides forward so `await requestSync()` only resolves once a
    // cycle covering its intent has actually run.
    return new Promise<void>((resolve, reject) => {
      const carried = loop.queued?.settles ?? [];
      loop.queued = {
        input,
        settles: [...carried, (error) => (error === null ? resolve() : reject(error))],
      };
    });
  }

  const outcome = new Promise<void>((resolve, reject) => {
    const run = (async () => {
      let current: QueuedCycle = {
        input,
        settles: [(error) => (error === null ? resolve() : reject(error))],
      };
      try {
        for (;;) {
          let outcome: unknown = null;
          try {
            await executeOneCycle(current.input);
          } catch (error) {
            outcome = error;
          }
          for (const settle of current.settles) {
            settle(outcome);
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
  const metadataOnly = input.writeMode === 'device-identity-only';
  const writesAllowed = (): boolean =>
    metadataOnly || input.writeGate === undefined || input.writeGate().allowed;
  try {
    // Fence before any durable write: a superseded cycle must not even mark
    // outbox rows dispatched under the dead scope.
    assertCurrent(input);
    if (writesAllowed()) {
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
        } else if (mapped.code === 'forbidden') {
          // BILL-05 hosted-access refusal: writes pause but control/read ops
          // stay available, so the pull still runs before the error
          // propagates. Pending/dispatched outbox rows are never rejected or
          // rewritten — this is a resumable pause, not data loss.
          try {
            await pullCycle(input, rpcFn);
          } catch {
            // The forbidden answer is the meaningful signal for the caller.
          }
          throw mapped;
        } else {
          throw mapped;
        }
      }
    }
    // sync.scan.begin is a mutating op: gated out while restricted so
    // reset_required stays set and the rescan runs once access resumes.
    if (!metadataOnly && getSyncState(input.scope)?.resetRequired === true) {
      const restored = await restorePublishedSnapshot(input, rpcFn);
      if (!restored && writesAllowed()) await scanCycle(input, rpcFn);
    }
    try {
      await pullCycle(input, rpcFn);
    } catch (error) {
      const mapped = toSyncEngineError(error);
      if (mapped.code !== 'reset-required') throw mapped;
      updateSyncState(input.scope, { resetRequired: true });
      if (metadataOnly) throw mapped;
      const restored = await restorePublishedSnapshot(input, rpcFn);
      if (!restored) {
        if (!writesAllowed()) throw mapped;
        await scanCycle(input, rpcFn);
      }
      await pullCycle(input, rpcFn);
    }
    if (!metadataOnly && writesAllowed()) {
      await maybePublishPortableSnapshot(input, rpcFn);
    }
    backoffUntil.delete(key);
  } catch (error) {
    const mapped = toSyncEngineError(error);
    if (mapped.retryable) {
      backoffUntil.set(key, Date.now() + (mapped.retryAfterMs ?? DEFAULT_RETRY_MS));
    }
    throw mapped;
  }
}

/**
 * Keep the portable recovery image fresh without adding a background timer or
 * scanning on every invalidation. A completed account cycle probes at most
 * hourly and publishes after seven days or ten thousand changes beyond the
 * last image; a first full-state image is published as soon as key material is
 * available. The full scan itself pins and catches up to one exact watermark.
 */
async function maybePublishPortableSnapshot(
  input: RunSyncCycleInput,
  rpcFn: SyncEngineRpc,
): Promise<void> {
  const key = scopeKey(input.scope);
  const now = Date.now();
  const lastProbe = snapshotProbeAt.get(key) ?? 0;
  if (now - lastProbe < SNAPSHOT_PROBE_INTERVAL_MS) return;
  snapshotProbeAt.set(key, now);
  try {
    const { result } = await rpcFn<SyncSnapshotGetResult>(
      input.connection,
      'sync.snapshot.get',
      {},
      input.accessToken,
    );
    assertCurrent(input);
    if (
      !isRecord(result) ||
      result.datasetEpoch !== input.scope.datasetEpoch ||
      !Number.isSafeInteger(result.keyVersion) ||
      typeof result.currentCursor !== 'string' ||
      (!isRecord(result.manifest) && result.manifest !== null)
    ) {
      throw new SyncEngineError('sync.snapshot.get returned a malformed publication result', {
        retryable: false,
        code: 'malformed',
      });
    }
    if (result.keyVersion < 1) return;
    const currentCursor = syncCursorNumber(result.currentCursor);
    if (currentCursor === null) {
      throw new SyncEngineError('snapshot publication cursor was malformed', {
        retryable: false,
        code: 'malformed',
      });
    }
    if (result.manifest === null) {
      await scanCycle(input, rpcFn);
      return;
    }
    if (!isSyncSnapshotManifest(result.manifest)) {
      throw new SyncEngineError('snapshot publication manifest was malformed', {
        retryable: false,
        code: 'malformed',
      });
    }
    const manifestCursor = syncCursorNumber(result.manifest.committedCursor);
    const createdAt = Date.parse(result.manifest.createdAt);
    const staleByAge = !Number.isFinite(createdAt) || now - createdAt >= SNAPSHOT_MAX_AGE_MS;
    const staleByChanges =
      manifestCursor === null || currentCursor - manifestCursor >= SNAPSHOT_MAX_UNCOMPACTED_CHANGES;
    if (staleByAge || staleByChanges) await scanCycle(input, rpcFn);
  } catch (error) {
    const mapped = toSyncEngineError(error);
    // Snapshot compaction is opportunistic. Keep the successful push/pull
    // useful when a maintenance probe is unavailable, but do not hide scope
    // supersession or malformed server data.
    if (
      mapped.code === 'superseded' ||
      mapped.code === 'malformed' ||
      mapped.code === 'epoch-mismatch'
    ) {
      throw mapped;
    }
  }
}

/**
 * Wire-form producer for nextBatch: crypto-boundary entities pass through
 * (they carry their own envelopes), domain payloads seal under the current
 * ADK. A missing ADK defers the change — plaintext is never sent.
 */
function sealWirePayload(
  scope: SyncScope,
  input: {
    entityType: string;
    entityId: string;
    operation: SyncOperation;
    schemaVersion: number;
    payload: unknown;
  },
): unknown {
  if (isCryptoBoundaryEntityType(input.entityType)) return input.payload;
  try {
    return sealEntityPayload(scope, input, input.payload);
  } catch (error) {
    if (error instanceof AccountKeyUnavailableError) return undefined;
    throw error;
  }
}

type WireDomainResult =
  | { kind: 'domain'; json: string | null }
  | { kind: 'quarantined'; reason: string; rawJson: string };

/**
 * Converts a domain entity wire payload to local JSON. Sealed envelopes
 * unseal locally; failures and unsealed values quarantine their raw JSON so
 * damaged or unauthenticated records cannot become domain state. Crypto
 * boundary records remain plaintext by protocol and are handled by callers.
 */
function wirePayloadToDomain(
  scope: SyncScope,
  entityType: string,
  entityId: string,
  payload: unknown,
): WireDomainResult {
  if (payload === undefined) return { kind: 'domain', json: null };
  if (isCryptoBoundaryEntityType(entityType)) {
    return { kind: 'domain', json: canonicalJson(payload) };
  }
  if (!isSealedEntityPayload(payload)) {
    return {
      kind: 'quarantined',
      reason: 'unsealed-payload',
      rawJson: canonicalJson(payload),
    };
  }
  try {
    const domain = unsealEntityPayload(scope, { entityType, entityId }, payload);
    return { kind: 'domain', json: canonicalJson(domain) };
  } catch (error) {
    if (error instanceof UnsealError) {
      return {
        kind: 'quarantined',
        reason: `unseal-${error.reason}`,
        rawJson: canonicalJson(payload),
      };
    }
    throw error;
  }
}

async function pushCycle(input: RunSyncCycleInput, rpcFn: SyncEngineRpc): Promise<void> {
  const limits = negotiatedLimits(input);
  const batch = nextBatch(input.scope, input.enrollmentId, {
    entityBytes: limits.entityBytes,
    maxBytes: limits.pageBytes,
    maxChanges: limits.batchChanges,
    seal: (sealInput) => sealWirePayload(input.scope, sealInput),
    shouldDispatch: (entityType, entityId) =>
      (entityType !== SYNC_ENTITY_WORKSPACE_DEFINITION || !isWorkspaceSyncPaused(entityId)) &&
      (input.writeMode !== 'device-identity-only' ||
        (entityType === CRYPTO_ENTITY_DEVICE_IDENTITY && entityId === input.enrollmentId)),
    onlyEntity:
      input.writeMode === 'device-identity-only'
        ? { entityType: CRYPTO_ENTITY_DEVICE_IDENTITY, entityId: input.enrollmentId }
        : undefined,
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
  const entityByChangeId = new Map(
    batch.map((change) => [
      change.changeId,
      { entityType: change.entityType, entityId: change.entityId },
    ]),
  );
  applyPushResults(
    input.scope,
    result.results.map((item) => mapPushItemResult(input.scope, entityByChangeId, item)),
  );
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
    stageScanEntities(input.scope, stagedEntitiesForWire(input, scanned.entities));
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
  const caughtUp = await catchUpStagedState(input, rpcFn, begin.resumeCursor, finish.nextCursor);
  if (!caughtUp) {
    throw new SyncEngineError('scan catch-up did not reach its finish watermark', {
      retryable: true,
      code: 'malformed',
    });
  }

  assertCurrent(input);
  await publishSnapshotFromStaging(
    input,
    rpcFn,
    begin.scanId,
    finish.watermarkEnd,
    finish.nextCursor,
  );
  activateStagedScan(input.scope, finish.nextCursor);
  // A scan may stage a sealed domain envelope before the page containing its
  // pairing/wrap material is consumed. The keyring retry that runs while the
  // crypto row is handled predates activation, so run it once more after the
  // staged bindings become visible. It only reopens sealed envelopes; unknown
  // entity/schema payloads remain quarantined for review.
  retryQuarantinedEntities(input.scope);
}

/** Loads an already-verified portable snapshot into isolated staging before
 * replaying the retained journal tail. Returns false when a full server scan
 * is needed because no retained snapshot reaches the journal floor. */
async function restorePublishedSnapshot(
  input: RunSyncCycleInput,
  rpcFn: SyncEngineRpc,
): Promise<boolean> {
  const { result } = await rpcFn<SyncSnapshotGetResult>(
    input.connection,
    'sync.snapshot.get',
    {},
    input.accessToken,
  );
  assertCurrent(input);
  if (
    !isRecord(result) ||
    result.datasetEpoch !== input.scope.datasetEpoch ||
    typeof result.keyVersion !== 'number' ||
    !Number.isSafeInteger(result.keyVersion) ||
    typeof result.recoveryFloor !== 'number' ||
    !Number.isSafeInteger(result.recoveryFloor) ||
    typeof result.currentCursor !== 'string' ||
    (!isRecord(result.manifest) && result.manifest !== null) ||
    (!isRecord(result.previousManifest) && result.previousManifest !== null)
  ) {
    throw new SyncEngineError('sync.snapshot.get returned a malformed recovery result', {
      retryable: false,
      code: 'malformed',
    });
  }
  const currentCursorNumber = syncCursorNumber(result.currentCursor);
  if (currentCursorNumber === null) {
    throw new SyncEngineError('snapshot recovery cursor was malformed', {
      retryable: false,
      code: 'malformed',
    });
  }
  const candidates = [result.manifest, result.previousManifest]
    .filter(
      (manifest): manifest is SyncSnapshotManifest & Record<string, unknown> =>
        manifest !== null && isSyncSnapshotManifest(manifest),
    )
    .filter((manifest) => manifest.datasetEpoch === input.scope.datasetEpoch)
    .sort((a, b) => syncCursorNumber(b.committedCursor)! - syncCursorNumber(a.committedCursor)!);

  for (const manifest of candidates) {
    const cursorNumber = syncCursorNumber(manifest.committedCursor);
    if (
      manifest.formatVersion !== 2 ||
      !Number.isSafeInteger(manifest.generation) ||
      manifest.generation < 1 ||
      !Number.isSafeInteger(manifest.keyVersion) ||
      manifest.keyVersion < 1 ||
      manifest.schemaVersion !== SYNC_SNAPSHOT_SCHEMA_VERSION ||
      cursorNumber === null ||
      cursorNumber < result.recoveryFloor ||
      cursorNumber > currentCursorNumber ||
      !Array.isArray(manifest.chunks) ||
      manifest.chunks.length === 0 ||
      manifest.chunks.length > SYNC_SNAPSHOT_MAX_CHUNKS
    ) {
      continue;
    }
    try {
      const descriptors = [...manifest.chunks].sort((a, b) => a.index - b.index);
      if (descriptors.some((descriptor, index) => descriptor.index !== index)) continue;
      const downloaded: Buffer[] = [];
      let totalBytes = 0;
      for (const descriptor of descriptors) {
        const { result: chunkResult } = await rpcFn<SyncSnapshotChunkGetResult>(
          input.connection,
          'sync.snapshot.chunk.get',
          { snapshotId: manifest.snapshotId, index: descriptor.index },
          input.accessToken,
        );
        assertCurrent(input);
        const bytes = decodeSnapshotChunk(chunkResult, descriptor);
        totalBytes += bytes.byteLength;
        if (totalBytes > SYNC_SNAPSHOT_MAX_STORED_BYTES) {
          bytes.fill(0);
          throw new Error('snapshot-size-limit');
        }
        downloaded.push(bytes);
      }
      const document = decodeSyncSnapshot(
        input.scope,
        manifest.keyVersion,
        manifest.committedCursor,
        Buffer.concat(downloaded),
        { entityCount: manifest.entityCount, tombstoneCount: manifest.tombstoneCount },
      );
      if (
        document.keyVersion !== manifest.keyVersion ||
        document.schemaVersion !== manifest.schemaVersion ||
        document.committedCursor !== manifest.committedCursor
      ) {
        throw new Error('snapshot-manifest-mismatch');
      }

      const scanId = `snapshot-recovery:${manifest.snapshotId}`;
      beginScanStaging(input.scope, scanId, cursorNumber);
      stageScanEntities(
        input.scope,
        stagedEntitiesForWire(input, document.entities as ScannedEntity[]),
      );
      const recoveredToCurrent = await catchUpStagedState(
        input,
        rpcFn,
        manifest.committedCursor,
        result.currentCursor,
      );
      if (!recoveredToCurrent) {
        clearScanStaging(input.scope);
        continue;
      }
      assertCurrent(input);
      activateStagedScan(input.scope, result.currentCursor);
      retryQuarantinedEntities(input.scope);
      return true;
    } catch {
      clearScanStaging(input.scope);
      // The prior verified generation remains a valid fallback if the current
      // object is damaged or a local key version is temporarily unavailable.
    }
  }
  return false;
}

async function catchUpStagedState(
  input: RunSyncCycleInput,
  rpcFn: SyncEngineRpc,
  startCursor: SyncCursor,
  finishCursor: SyncCursor,
): Promise<boolean> {
  const finishNumber = syncCursorNumber(finishCursor);
  let cursor = startCursor;
  if (finishNumber === null || syncCursorNumber(startCursor) === null) return false;
  const limits = negotiatedLimits(input);
  for (let page = 0; page < CATCHUP_PAGE_LIMIT; page += 1) {
    const { result } = await rpcFn<SyncPullResult>(
      input.connection,
      'sync.pull',
      { cursor, maxBytes: limits.pageBytes },
      input.accessToken,
    );
    assertCurrent(input);
    if (
      !isRecord(result) ||
      !Array.isArray(result.changes) ||
      typeof result.nextCursor !== 'string' ||
      typeof result.hasMore !== 'boolean' ||
      typeof result.recoveryFloor !== 'number'
    ) {
      throw new SyncEngineError('sync.pull (snapshot catch-up) returned a malformed result', {
        retryable: false,
        code: 'malformed',
      });
    }
    let sawPastFinish = false;
    for (const raw of result.changes) {
      const change = toSyncedChange(raw);
      if (change === null) {
        throw new SyncEngineError('sync.pull returned a malformed catch-up change', {
          retryable: false,
          code: 'malformed',
        });
      }
      if (change.sequence > finishNumber) {
        sawPastFinish = true;
        break;
      }
      stagePulledChange(input, change);
    }
    cursor = result.nextCursor;
    const nextNumber = syncCursorNumber(cursor);
    if (sawPastFinish || (nextNumber !== null && nextNumber >= finishNumber)) return true;
    if (!result.hasMore) return false;
    if (page === CATCHUP_PAGE_LIMIT - 1) {
      throw new SyncEngineError('snapshot catch-up exceeded the page safety limit', {
        retryable: true,
        code: 'malformed',
      });
    }
  }
  return false;
}

function stagePulledChange(input: RunSyncCycleInput, change: SyncedChange): void {
  if (isCryptoBoundaryEntityType(change.entityType)) {
    if (change.operation !== 'delete') {
      handleCryptoBoundaryEntity(
        input.scope,
        input.enrollmentId,
        change.entityType,
        change.entityId,
        change.payload,
      );
    }
    stageScanChange(input.scope, {
      entityType: change.entityType,
      entityId: change.entityId,
      operation: change.operation,
      payloadJson: change.operation === 'delete' ? null : canonicalJson(change.payload),
      wirePayloadJson: change.operation === 'delete' ? null : canonicalJson(change.payload),
      revision: change.revision,
      schemaVersion: change.schemaVersion,
    });
    return;
  }
  const wire =
    change.operation === 'delete'
      ? null
      : wirePayloadToDomain(input.scope, change.entityType, change.entityId, change.payload);
  stageScanChange(input.scope, {
    entityType: change.entityType,
    entityId: change.entityId,
    operation: change.operation,
    payloadJson:
      change.operation === 'delete'
        ? null
        : wire?.kind === 'domain'
          ? wire.json
          : canonicalJson({
              envelope: JSON.parse(wire?.rawJson ?? 'null') as unknown,
              revision: change.revision,
              schemaVersion: change.schemaVersion,
            }),
    wirePayloadJson: change.operation === 'delete' ? null : canonicalJson(change.payload),
    revision: change.revision,
    schemaVersion: change.schemaVersion,
  });
}

function syncCursorNumber(cursor: string): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(cursor)) return null;
  const value = Number(cursor);
  return Number.isSafeInteger(value) ? value : null;
}

function isSyncSnapshotManifest(value: unknown): value is SyncSnapshotManifest {
  return (
    isRecord(value) &&
    value['formatVersion'] === 2 &&
    typeof value['snapshotId'] === 'string' &&
    Number.isSafeInteger(value['generation']) &&
    typeof value['datasetEpoch'] === 'string' &&
    Number.isSafeInteger(value['keyVersion']) &&
    value['schemaVersion'] === SYNC_SNAPSHOT_SCHEMA_VERSION &&
    typeof value['committedCursor'] === 'string' &&
    Number.isSafeInteger(value['entityCount']) &&
    Number.isSafeInteger(value['tombstoneCount']) &&
    typeof value['manifestSha256'] === 'string' &&
    Array.isArray(value['chunks']) &&
    value['chunks'].every(
      (chunk) =>
        isRecord(chunk) &&
        Number.isSafeInteger(chunk['index']) &&
        Number.isSafeInteger(chunk['byteLength']) &&
        typeof chunk['sha256'] === 'string',
    ) &&
    typeof value['createdAt'] === 'string'
  );
}

/** Publishes only a just-finished, complete server scan. Staging is the source
 * of truth here, so locally bound/sparse entities and the uncommitted outbox
 * can never be mistaken for the account's full portable state. */
async function publishSnapshotFromStaging(
  input: RunSyncCycleInput,
  rpcFn: SyncEngineRpc,
  scanId: string,
  watermarkEnd: number,
  nextCursor: SyncCursor,
): Promise<void> {
  const allowed = (): boolean =>
    (input.guard === undefined || input.guard()) &&
    (input.writeGate === undefined || input.writeGate().allowed);
  if (!allowed()) return;
  const { result: snapshot } = await rpcFn<SyncSnapshotGetResult>(
    input.connection,
    'sync.snapshot.get',
    {},
    input.accessToken,
  );
  assertCurrent(input);
  if (
    !isRecord(snapshot) ||
    snapshot.datasetEpoch !== input.scope.datasetEpoch ||
    typeof snapshot.keyVersion !== 'number' ||
    !Number.isSafeInteger(snapshot.keyVersion) ||
    typeof snapshot.recoveryFloor !== 'number' ||
    (!isRecord(snapshot.manifest) && snapshot.manifest !== null)
  ) {
    throw new SyncEngineError('sync.snapshot.get returned a malformed result', {
      retryable: false,
      code: 'malformed',
    });
  }
  if (snapshot.keyVersion < 1) return; // No encrypted portable records exist yet.
  if (nextCursor !== String(watermarkEnd)) {
    throw new SyncEngineError('scan cursor did not match its finish watermark', {
      retryable: false,
      code: 'malformed',
    });
  }
  const staged = listScanStaging(input.scope);
  const entities: SyncSnapshotDocument['entities'] = staged.map((entity) => {
    if (
      !Number.isSafeInteger(entity.revision) ||
      !Number.isSafeInteger(entity.schemaVersion) ||
      (entity.operation !== 'create' &&
        entity.operation !== 'update' &&
        entity.operation !== 'delete')
    ) {
      throw new SyncEngineError('Full scan contained a malformed staged entity', {
        retryable: false,
        code: 'malformed',
      });
    }
    if (entity.operation === 'delete') {
      return {
        entityType: entity.entityType,
        entityId: entity.entityId,
        revision: entity.revision,
        operation: entity.operation,
        schemaVersion: entity.schemaVersion,
      };
    }
    if (entity.wirePayloadJson === null) {
      throw new SyncEngineError('Full scan omitted a live entity payload', {
        retryable: false,
        code: 'malformed',
      });
    }
    return {
      entityType: entity.entityType,
      entityId: entity.entityId,
      revision: entity.revision,
      operation: entity.operation,
      schemaVersion: entity.schemaVersion,
      payload: JSON.parse(entity.wirePayloadJson) as unknown,
    };
  });
  const entityCount = entities.filter((entity) => entity.operation !== 'delete').length;
  const tombstoneCount = entities.length - entityCount;
  const existingManifest = snapshot.manifest as SyncSnapshotManifest | null;
  if (
    existingManifest !== null &&
    existingManifest.datasetEpoch === input.scope.datasetEpoch &&
    existingManifest.keyVersion === snapshot.keyVersion &&
    existingManifest.committedCursor === nextCursor
  ) {
    snapshotProbeAt.set(scopeKey(input.scope), Date.now());
    return;
  }

  const document: SyncSnapshotDocument = {
    formatVersion: 2,
    datasetEpoch: input.scope.datasetEpoch,
    keyVersion: snapshot.keyVersion,
    schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
    committedCursor: nextCursor,
    entities,
  };
  const plaintext = encodeSnapshotPlaintext(document);
  if (plaintext === null) {
    snapshotProbeAt.set(scopeKey(input.scope), Date.now());
    console.warn(
      `[Sync] Snapshot exceeds the ${SYNC_SNAPSHOT_MAX_EXPANDED_BYTES}-byte plaintext limit; ` +
        'keeping the journal as the recovery source and retrying after the probe interval.',
    );
    return;
  }
  const compressed = gzipSync(plaintext, { level: 6 });
  plaintext.fill(0);
  const aad = syncSnapshotAssociatedData(input.scope, snapshot.keyVersion, nextCursor);
  const sealed = sealAccountBytes(input.scope, aad, compressed);
  compressed.fill(0);
  if (sealed.keyVersion !== snapshot.keyVersion) {
    sealed.bytes.fill(0);
    throw new SyncEngineError('Local Sync key version changed during snapshot publication', {
      retryable: true,
      code: 'key-epoch-mismatch',
    });
  }
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < sealed.bytes.byteLength; offset += SYNC_SNAPSHOT_CHUNK_BYTES) {
    chunks.push(sealed.bytes.subarray(offset, offset + SYNC_SNAPSHOT_CHUNK_BYTES));
  }
  if (chunks.length === 0 || chunks.length > SYNC_SNAPSHOT_MAX_CHUNKS) {
    sealed.bytes.fill(0);
    snapshotProbeAt.set(scopeKey(input.scope), Date.now());
    console.warn(
      `[Sync] Encrypted snapshot exceeds the ${SYNC_SNAPSHOT_MAX_STORED_BYTES}-byte upload limit; ` +
        'keeping the journal as the recovery source and retrying after the probe interval.',
    );
    return;
  }
  const descriptors: SyncSnapshotChunkDescriptor[] = chunks.map((bytes, index) => ({
    index,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  }));
  const publicationId = randomUUID();
  const beginWithoutHash: Omit<SyncSnapshotBeginParams, 'publicationId' | 'manifestSha256'> = {
    scanId,
    expectedGeneration: existingManifest?.generation ?? 0,
    datasetEpoch: input.scope.datasetEpoch,
    keyVersion: snapshot.keyVersion,
    schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
    committedCursor: nextCursor,
    entityCount,
    tombstoneCount,
    chunks: descriptors,
  };
  const begin: SyncSnapshotBeginParams = {
    publicationId,
    ...beginWithoutHash,
    manifestSha256: sha256(
      Buffer.from(canonicalSyncSnapshotManifestHashInput(beginWithoutHash), 'utf8'),
    ),
  };
  await rpcFn(input.connection, 'sync.snapshot.begin', begin, input.accessToken);
  assertCurrent(input);
  for (const [index, bytes] of chunks.entries()) {
    if (!allowed()) {
      sealed.bytes.fill(0);
      return;
    }
    await rpcFn(
      input.connection,
      'sync.snapshot.chunk.put',
      { publicationId, index, bytesBase64: bytes.toString('base64') },
      input.accessToken,
    );
    assertCurrent(input);
  }

  // Verify through the normal snapshot reader before asking the backend to
  // publish. Upload acknowledgement alone is not evidence of recoverability.
  const downloaded: Buffer[] = [];
  for (const descriptor of descriptors) {
    const { result } = await rpcFn<SyncSnapshotChunkGetResult>(
      input.connection,
      'sync.snapshot.chunk.get',
      { snapshotId: publicationId, index: descriptor.index },
      input.accessToken,
    );
    const bytes = decodeSnapshotChunk(result, descriptor);
    downloaded.push(bytes);
    assertCurrent(input);
  }
  const recovered = decodeSyncSnapshot(
    input.scope,
    snapshot.keyVersion,
    nextCursor,
    Buffer.concat(downloaded),
    { entityCount, tombstoneCount },
  );
  if (canonicalizeJson(recovered) !== canonicalizeJson(document)) {
    sealed.bytes.fill(0);
    throw new SyncEngineError('Downloaded Sync snapshot did not match its staged source', {
      retryable: false,
      code: 'snapshot-verification-failed',
    });
  }
  const verification = await rpcFn<SyncSnapshotVerifyResult>(
    input.connection,
    'sync.snapshot.verify',
    { publicationId, manifestSha256: begin.manifestSha256 },
    input.accessToken,
  );
  assertCurrent(input);
  if (verification.result.verified !== true) {
    throw new SyncEngineError('Backend did not verify all Sync snapshot chunks', {
      retryable: false,
      code: 'snapshot-verification-failed',
    });
  }
  await rpcFn(input.connection, 'sync.snapshot.commit', { publicationId }, input.accessToken);
  sealed.bytes.fill(0);
  snapshotProbeAt.set(scopeKey(input.scope), Date.now());
}

function syncSnapshotAssociatedData(
  scope: SyncScope,
  keyVersion: number,
  cursor: SyncCursor,
): string {
  return `anvil/sync-snapshot/v2:${scope.backendId}:${scope.accountId}:${scope.datasetEpoch}:${keyVersion}:${cursor}`;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeSnapshotChunk(value: unknown, expected: SyncSnapshotChunkDescriptor): Buffer {
  if (
    !isRecord(value) ||
    value.index !== expected.index ||
    value.byteLength !== expected.byteLength ||
    value.sha256 !== expected.sha256 ||
    typeof value.bytesBase64 !== 'string'
  ) {
    throw new SyncEngineError('sync.snapshot.chunk.get returned a malformed chunk', {
      retryable: false,
      code: 'malformed',
    });
  }
  const bytes = Buffer.from(value.bytesBase64, 'base64');
  if (
    bytes.toString('base64') !== value.bytesBase64 ||
    bytes.byteLength !== expected.byteLength ||
    sha256(bytes) !== expected.sha256
  ) {
    bytes.fill(0);
    throw new SyncEngineError('Downloaded Sync snapshot chunk failed its digest check', {
      retryable: false,
      code: 'snapshot-verification-failed',
    });
  }
  return bytes;
}

function decodeSyncSnapshot(
  scope: SyncScope,
  keyVersion: number,
  cursor: SyncCursor,
  sealedBytes: Buffer,
  expectedCoverage?: { entityCount: number; tombstoneCount: number },
): SyncSnapshotDocument {
  let compressed: Buffer | null = null;
  let plaintext: Buffer | null = null;
  try {
    compressed = unsealAccountBytes(
      scope,
      syncSnapshotAssociatedData(scope, keyVersion, cursor),
      keyVersion,
      sealedBytes,
    );
    plaintext = gunzipSync(compressed, { maxOutputLength: SYNC_SNAPSHOT_MAX_EXPANDED_BYTES });
    const parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.formatVersion !== 2 ||
      parsed.datasetEpoch !== scope.datasetEpoch ||
      parsed.keyVersion !== keyVersion ||
      parsed.schemaVersion !== SYNC_SNAPSHOT_SCHEMA_VERSION ||
      parsed.committedCursor !== cursor ||
      !Array.isArray(parsed.entities)
    ) {
      throw new Error('snapshot-document-metadata');
    }
    const entities = parsed.entities as SyncSnapshotDocument['entities'];
    let entityCount = 0;
    for (const entity of entities) {
      if (
        !isRecord(entity) ||
        typeof entity.entityType !== 'string' ||
        typeof entity.entityId !== 'string' ||
        !Number.isSafeInteger(entity.revision) ||
        !Number.isSafeInteger(entity.schemaVersion) ||
        (entity.operation !== 'create' &&
          entity.operation !== 'update' &&
          entity.operation !== 'delete') ||
        (entity.operation === 'delete'
          ? Object.prototype.hasOwnProperty.call(entity, 'payload')
          : !Object.prototype.hasOwnProperty.call(entity, 'payload'))
      ) {
        throw new Error('snapshot-document-entity');
      }
      if (entity.operation !== 'delete') entityCount += 1;
    }
    const tombstoneCount = entities.length - entityCount;
    if (
      expectedCoverage !== undefined &&
      (entityCount !== expectedCoverage.entityCount ||
        tombstoneCount !== expectedCoverage.tombstoneCount)
    ) {
      throw new Error('snapshot-document-coverage');
    }
    return parsed as unknown as SyncSnapshotDocument;
  } catch (error) {
    throw new SyncEngineError(
      error instanceof Error ? error.message : 'Sync snapshot could not be opened',
      { retryable: false, code: 'snapshot-verification-failed' },
    );
  } finally {
    compressed?.fill(0);
    plaintext?.fill(0);
    sealedBytes.fill(0);
  }
}

function encodeSnapshotPlaintext(document: SyncSnapshotDocument): Buffer | null {
  const serialized = canonicalizeJson(document);
  if (Buffer.byteLength(serialized, 'utf8') > SYNC_SNAPSHOT_MAX_EXPANDED_BYTES) return null;
  return Buffer.from(serialized, 'utf8');
}

function mapPushItemResult(
  scope: SyncScope,
  entityByChangeId: Map<string, { entityType: string; entityId: string }>,
  item: SyncPushItemResult,
): PushResult {
  switch (item.status) {
    case 'accepted':
      return { changeId: item.changeId, revision: item.revision, status: 'accepted' };
    case 'conflict': {
      // Conflict content arrives in wire form: unseal it so the conflict
      // record and any merge UI see the domain payload. A missing key version
      // or tampered envelope remains reviewable as a raw envelope; unsealed
      // non-crypto domain content is a malformed sync/2 response.
      const entity = entityByChangeId.get(item.changeId);
      let remotePayload: unknown = item.remoteContent;
      if (entity === undefined) {
        throw new SyncEngineError('sync.push conflict referenced an unknown change', {
          retryable: false,
          code: 'malformed',
        });
      }
      if (
        item.remoteContent !== null &&
        !isCryptoBoundaryEntityType(entity.entityType) &&
        !isSealedEntityPayload(item.remoteContent)
      ) {
        throw new SyncEngineError('sync.push conflict returned an unsealed domain payload', {
          retryable: false,
          code: 'malformed',
        });
      }
      if (
        item.remoteContent !== null &&
        !isCryptoBoundaryEntityType(entity.entityType) &&
        isSealedEntityPayload(item.remoteContent)
      ) {
        try {
          remotePayload = unsealEntityPayload(
            scope,
            { entityType: entity.entityType, entityId: entity.entityId },
            item.remoteContent,
          );
        } catch {
          // Keep the sealed envelope.
        }
      }
      return {
        changeId: item.changeId,
        remotePayload,
        remoteRevision: item.remoteRevision,
        status: 'conflict',
      };
    }
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
      applySyncedChange(input.scope, input.enrollmentId, change);
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

/**
 * Scan-page entities validated and converted for staging. Crypto-boundary
 * entities are consumed by the keyring immediately (never staged); sealed
 * payloads unseal to domain JSON, with failures staged as raw envelopes so
 * activation quarantines them for later key-delivery retry.
 */
function stagedEntitiesForWire(
  input: RunSyncCycleInput,
  value: ScannedEntity[],
): Array<{
  entityType: string;
  entityId: string;
  revision: number;
  schemaVersion: number;
  operation: SyncOperation;
  payloadJson: string | null;
  wirePayloadJson: string | null;
}> {
  const entities: Array<{
    entityType: string;
    entityId: string;
    revision: number;
    schemaVersion: number;
    operation: SyncOperation;
    payloadJson: string | null;
    wirePayloadJson: string | null;
  }> = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.entityType !== 'string' || item.entityType.length === 0) continue;
    if (typeof item.entityId !== 'string' || item.entityId.length === 0) continue;
    if (typeof item.revision !== 'number' || !Number.isInteger(item.revision)) continue;
    if (typeof item.schemaVersion !== 'number' || !Number.isInteger(item.schemaVersion)) continue;
    if (item.operation !== 'create' && item.operation !== 'update' && item.operation !== 'delete') {
      continue;
    }
    if (item.operation !== 'delete' && isCryptoBoundaryEntityType(item.entityType)) {
      handleCryptoBoundaryEntity(
        input.scope,
        input.enrollmentId,
        item.entityType,
        item.entityId,
        item.payload,
      );
      entities.push({
        entityType: item.entityType,
        entityId: item.entityId,
        revision: item.revision,
        schemaVersion: item.schemaVersion,
        operation: item.operation,
        payloadJson: canonicalJson(item.payload),
        wirePayloadJson: canonicalJson(item.payload),
      });
      continue;
    }
    const wire =
      item.operation === 'delete'
        ? null
        : wirePayloadToDomain(input.scope, item.entityType, item.entityId, item.payload);
    entities.push({
      entityType: item.entityType,
      entityId: item.entityId,
      revision: item.revision,
      schemaVersion: item.schemaVersion,
      operation: item.operation,
      payloadJson:
        wire === null
          ? null
          : wire.kind === 'domain'
            ? wire.json
            : canonicalJson({
                envelope: JSON.parse(wire.rawJson) as unknown,
                revision: item.revision,
                schemaVersion: item.schemaVersion,
              }),
      wirePayloadJson: item.operation === 'delete' ? null : canonicalJson(item.payload),
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
  if (!isSupportedEntityType(entityType)) return 'unsupported-entity-type';
  if (schemaVersion !== SYNC_ENTITY_SCHEMA_VERSIONS[entityType]) {
    return 'unsupported-schema-version';
  }
  if (payloadJson === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return 'malformed-payload';
  }
  return entityPayloadIssue(entityType, parsed);
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
    const stagedKeys = new Map(
      staged.map((entity) => [`${entity.entityType}\0${entity.entityId}`, entity]),
    );
    const bindings = new Map(
      listBindings(scope).map((binding) => [`${binding.entityType}\0${binding.entityId}`, binding]),
    );

    for (const entity of staged) {
      const key = `${entity.entityType}\0${entity.entityId}`;
      const binding = bindings.get(key);
      if (
        entity.entityType === SYNC_ENTITY_WORKSPACE_DEFINITION &&
        isWorkspaceSyncPaused(entity.entityId)
      ) {
        let payload: unknown;
        if (entity.payloadJson !== null) {
          payload = JSON.parse(entity.payloadJson) as unknown;
          if (isRecord(payload) && isRecord(payload['envelope'])) {
            payload = payload['envelope'];
          }
        }
        const revision = entity.revision;
        const change: SyncedChange = {
          entityType: entity.entityType,
          entityId: entity.entityId,
          revision,
          operation: entity.operation,
          schemaVersion: entity.schemaVersion,
          ...(entity.payloadJson === null ? {} : { payload }),
          sequence: revision,
        };
        storePausedInboundChange(
          scope,
          {
            entityType: entity.entityType,
            entityId: entity.entityId,
            revision,
            changeJson: canonicalJson(change),
          },
          { replace: true },
        );
        continue;
      }
      const openConflict = getUnresolvedConflict(scope, entity.entityType, entity.entityId);
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
        const foreignBound = listSyncScopesForEntity(entity.entityType, entity.entityId).length > 0;
        if (entity.operation === 'delete') {
          upsertBinding(scope, entity.entityType, entity.entityId, {
            baseRevision: entity.revision,
            basePayloadJson: null,
          });
          if (domainJson !== null && !foreignBound) {
            insertUnresolvedConflict(scope, {
              basePayloadJson: null,
              baseRevision: null,
              entityId: entity.entityId,
              entityType: entity.entityType,
              kind: 'edit-delete',
              localPayloadJson: domainJson,
              remotePayloadJson: null,
              remoteRevision: entity.revision,
              remoteSnapshotIsAuthoritative: true,
            });
          }
          continue;
        }
        if (domainJson === null && !foreignBound) {
          upsertBinding(scope, entity.entityType, entity.entityId, {
            baseRevision: entity.revision,
            basePayloadJson: entity.payloadJson,
          });
          applyDomainProjection({
            entityType: entity.entityType,
            entityId: entity.entityId,
            operation: entity.operation,
            payload: JSON.parse(entity.payloadJson as string),
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
          remoteSnapshotIsAuthoritative: true,
        });
        continue;
      }

      if (quarantineReason !== null) {
        setBindingBase(
          scope,
          entity.entityType,
          entity.entityId,
          entity.revision,
          entity.payloadJson,
        );
        setBindingQuarantine(scope, entity.entityType, entity.entityId, entity.payloadJson);
        continue;
      }

      const domainJson = readLocalPayloadJson(entity.entityType, entity.entityId);
      const dirty =
        openConflict !== null ||
        binding.localEditGeneration > binding.acknowledgedGeneration ||
        listMutableOutboxRows(scope, entity.entityType, entity.entityId).length > 0;
      if (!dirty) {
        setBindingBase(
          scope,
          entity.entityType,
          entity.entityId,
          entity.revision,
          entity.payloadJson,
        );
        setBindingQuarantine(scope, entity.entityType, entity.entityId, null);
        if (domainJson !== entity.payloadJson) {
          applyDomainProjection({
            entityType: entity.entityType,
            entityId: entity.entityId,
            operation:
              entity.operation === 'delete' ? 'delete' : domainJson === null ? 'create' : 'update',
            payload: entity.payloadJson === null ? undefined : JSON.parse(entity.payloadJson),
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
        setBindingBase(
          scope,
          entity.entityType,
          entity.entityId,
          entity.revision,
          entity.payloadJson,
        );
        acknowledgeBindingLocalEdits(scope, entity.entityType, entity.entityId);
        deletePendingOutboxRows(scope, entity.entityType, entity.entityId);
        rejectDispatchedRows(scope, entity.entityType, entity.entityId, 'reset-uncertain');
        rejectConflictedOutboxRows(scope, entity.entityType, entity.entityId, 'reset-converged');
        resolveConvergedConflict(scope, openConflict, entity.payloadJson, entity.revision);
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
        kind:
          entity.operation === 'delete'
            ? 'edit-delete'
            : domainJson === null
              ? 'delete-edit'
              : 'edit-edit',
        localPayloadJson: domainJson,
        remotePayloadJson: entity.payloadJson,
        remoteRevision: entity.revision,
        remoteSnapshotIsAuthoritative: true,
      });
      setBindingBase(
        scope,
        entity.entityType,
        entity.entityId,
        entity.revision,
        entity.payloadJson,
      );
      rejectDispatchedRows(scope, entity.entityType, entity.entityId, 'reset-uncertain');
    }

    // Bound entities absent from the rebuilt remote state.
    for (const binding of bindings.values()) {
      const key = `${binding.entityType}\0${binding.entityId}`;
      if (stagedKeys.has(key)) continue;
      if (
        binding.entityType === SYNC_ENTITY_WORKSPACE_DEFINITION &&
        isWorkspaceSyncPaused(binding.entityId)
      ) {
        const revision = (binding.baseRevision ?? 0) + 1;
        const change: SyncedChange = {
          entityType: binding.entityType,
          entityId: binding.entityId,
          revision,
          operation: 'delete',
          schemaVersion: SYNC_ENTITY_SCHEMA_VERSIONS[SYNC_ENTITY_WORKSPACE_DEFINITION],
          sequence: revision,
        };
        storePausedInboundChange(
          scope,
          {
            entityType: binding.entityType,
            entityId: binding.entityId,
            revision,
            changeJson: canonicalJson(change),
          },
          { replace: true },
        );
        continue;
      }
      const openConflict = getUnresolvedConflict(scope, binding.entityType, binding.entityId);
      const domainJson = readLocalPayloadJson(binding.entityType, binding.entityId);
      const dirty =
        openConflict !== null ||
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
        resolveConvergedConflict(scope, openConflict, null, null);
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

/** Refreshes and resolves a conflict after a reset proves both sides match. */
function resolveConvergedConflict(
  scope: SyncScope,
  conflict: SyncConflict | null,
  remotePayloadJson: string | null,
  remoteRevision: number | null,
): void {
  if (conflict === null) return;
  insertUnresolvedConflict(scope, {
    basePayloadJson: conflict.basePayloadJson,
    baseRevision: conflict.baseRevision,
    entityId: conflict.entityId,
    entityType: conflict.entityType,
    kind: conflict.kind,
    localPayloadJson: conflict.localPayloadJson,
    remotePayloadJson,
    remoteRevision,
    remoteSnapshotIsAuthoritative: true,
  });
  resolveConflict(conflict.id, 'use-remote');
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
        writeBindingBase(
          row.scope,
          row.entityType,
          row.entityId,
          row.remoteRevision ?? 0,
          row.remotePayloadJson,
        );
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
  const copy = persistConflictCopy(conflict.entityType, payload);
  if (copy === null) {
    throw new SyncEngineError(`save-copy is not supported for entity type ${conflict.entityType}`, {
      retryable: false,
    });
  }
  upsertBinding(conflict.scope, conflict.entityType, copy.entityId);
  recordLocalChange(conflict.scope, {
    entityType: conflict.entityType,
    entityId: copy.entityId,
    operation: 'create',
    payload: copy.payload,
    schemaVersion: SYNC_ENTITY_SCHEMA_VERSIONS[conflict.entityType as SyncEntityType] ?? 1,
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

function applySyncedChange(scope: SyncScope, enrollmentId: string, change: SyncedChange): void {
  // Crypto-boundary entities (device identities, key wraps, pairing blobs)
  // are consumed by the keyring, never by domain/binding machinery.
  if (isCryptoBoundaryEntityType(change.entityType)) {
    if (change.operation !== 'delete') {
      handleCryptoBoundaryEntity(
        scope,
        enrollmentId,
        change.entityType,
        change.entityId,
        change.payload,
      );
    }
    return;
  }
  if (
    change.entityType === SYNC_ENTITY_WORKSPACE_DEFINITION &&
    isWorkspaceSyncPaused(change.entityId)
  ) {
    const binding = getBinding(scope, change.entityType, change.entityId);
    if (binding?.baseRevision !== null && binding?.baseRevision !== undefined) {
      if (change.revision <= binding.baseRevision) return;
    }
    // The pull cursor is account-wide, so preserve this sealed change locally
    // and replay it on opt-in. Keeping the old base lets normal conflict logic
    // compare remote edits with workspace changes made while Sync was paused.
    storePausedInboundChange(scope, {
      entityType: change.entityType,
      entityId: change.entityId,
      revision: change.revision,
      changeJson: canonicalJson(change),
    });
    return;
  }
  const binding = getBinding(scope, change.entityType, change.entityId);
  const wire = wirePayloadToDomain(scope, change.entityType, change.entityId, change.payload);
  if (wire.kind === 'quarantined') {
    // A missing ADK is a transient crypto condition, not an application
    // conflict. Preserve the raw authenticated envelope and the remote
    // revision until keyring-pairing/wrap processing installs the key. The
    // keyring retry can then compare the decrypted remote value with any
    // local edit and create a normal, reviewable conflict if they differ.
    const quarantine = canonicalJson({
      envelope: JSON.parse(wire.rawJson) as unknown,
      revision: change.revision,
      schemaVersion: change.schemaVersion,
    });
    if (
      binding !== null &&
      binding.baseRevision !== null &&
      change.revision <= binding.baseRevision
    ) {
      return;
    }
    if (binding === null) {
      upsertBinding(scope, change.entityType, change.entityId, {
        baseRevision: null,
        basePayloadJson: null,
        quarantineJson: quarantine,
      });
    } else {
      setBindingQuarantine(scope, change.entityType, change.entityId, quarantine);
    }
    return;
  }
  const payloadJson = wire.json;
  const quarantineReason =
    change.operation === 'delete'
      ? isSupportedEntityType(change.entityType)
        ? null
        : 'unsupported-entity-type'
      : entityQuarantineReason(change.entityType, change.schemaVersion, payloadJson);
  if (binding) {
    if (binding.baseRevision !== null && change.revision <= binding.baseRevision) {
      return;
    }
    const openConflict = getUnresolvedConflict(scope, change.entityType, change.entityId);
    if (openConflict) {
      const localPayloadJson = readLocalPayloadJson(change.entityType, change.entityId);
      const kind: SyncConflictKind =
        payloadJson === null && localPayloadJson !== null
          ? 'edit-delete'
          : payloadJson !== null && localPayloadJson === null
            ? 'delete-edit'
            : 'edit-edit';
      insertUnresolvedConflict(scope, {
        basePayloadJson: openConflict.basePayloadJson,
        baseRevision: openConflict.baseRevision,
        entityId: change.entityId,
        entityType: change.entityType,
        kind,
        localPayloadJson: openConflict.localPayloadJson,
        remotePayloadJson: payloadJson,
        remoteRevision: change.revision,
      });
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
    applyDomainProjection({
      ...change,
      payload: payloadJson === null ? undefined : JSON.parse(payloadJson),
    });
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
    applyDomainProjection({
      ...change,
      payload: payloadJson === null ? undefined : JSON.parse(payloadJson),
    });
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

/** Reconcile deferred workspace changes after the local Sync choice is enabled. */
export function applyPausedWorkspaceChanges(scope: SyncScope, enrollmentId: string): number {
  const run = getDb().transaction(() => {
    let applied = 0;
    for (const paused of listPausedInboundChanges(scope)) {
      if (paused.entityType !== SYNC_ENTITY_WORKSPACE_DEFINITION) continue;
      if (isWorkspaceSyncPaused(paused.entityId)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(paused.changeJson) as unknown;
      } catch {
        throw new SyncEngineError('stored paused workspace change is malformed', {
          retryable: false,
          code: 'malformed',
        });
      }
      const change = toSyncedChange(parsed);
      if (
        change === null ||
        change.entityType !== paused.entityType ||
        change.entityId !== paused.entityId ||
        change.revision !== paused.revision
      ) {
        throw new SyncEngineError('stored paused workspace change is malformed', {
          retryable: false,
          code: 'malformed',
        });
      }
      applySyncedChange(scope, enrollmentId, change);
      deletePausedInboundChange(scope, paused.entityType, paused.entityId);
      applied += 1;
    }
    return applied;
  });
  return run();
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
  return readEntityPayloadJson(entityType, entityId);
}

function deleteDomainRow(entityType: string, entityId: string): void {
  deleteLocalEntity(entityType, entityId);
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
  switch (change.operation) {
    case 'create':
    case 'update': {
      applyRemoteEntityPayload(change.entityType, change.entityId, change.payload);
      break;
    }
    case 'delete': {
      deleteLocalEntity(change.entityType, change.entityId);
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

function toSyncEngineError(error: unknown): SyncEngineError {
  if (error instanceof SyncEngineError) return error;
  if (error instanceof BackendRpcError) {
    return new SyncEngineError(error.message, {
      code: error.code,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
      details: error.details,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  const httpMatch = /HTTP (\d+)/.exec(message);
  const status = httpMatch ? Number(httpMatch[1]) : undefined;
  const retryable = status === undefined || status >= 500;
  return new SyncEngineError(message, { retryable });
}
