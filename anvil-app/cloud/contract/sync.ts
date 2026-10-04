// Sync push/pull/scan types and the canonical change serializer.
//
// `payloadHash` covers the canonical serialization defined here, including
// operation, identity, base revision, and payload. Actor identity is
// authenticated by the device session outside the domain payload.

export type SyncOperation = 'create' | 'update' | 'delete';
export const SYNC_SNAPSHOT_SCHEMA_VERSION = 2 as const;

export interface PendingChange {
  changeId: string;
  enrollmentSequence: number;
  entityType: string;
  entityId: string;
  schemaVersion: number;
  /** Null means create-only; updates and deletes require a base revision. */
  baseRevision: number | null;
  operation: SyncOperation;
  /** Validated by the entity-specific wire schema; absent for deletes. */
  payload?: unknown;
  payloadHash: string;
}

export interface SyncPushParams {
  changes: PendingChange[];
  /** Client's expected dataset epoch; the backend fails the batch on mismatch. */
  epoch?: string;
}

export type PushItemStatus =
  | 'accepted'
  | 'conflict'
  | 'rejected'
  | 'reset-required'
  | 'receipt-expired';

export interface PushItemAccepted {
  status: 'accepted';
  changeId: string;
  revision: number;
  /** Canonical content, or a reference sufficient to retrieve it. */
  content?: unknown;
  contentRef?: string;
}

export interface PushItemConflict {
  status: 'conflict';
  changeId: string;
  remoteRevision: number;
  remoteContent: unknown;
}

export interface PushItemRejected {
  status: 'rejected';
  changeId: string;
  reason: string;
}

export interface PushItemResetRequired {
  status: 'reset-required';
  changeId: string;
  epoch: string;
}

export interface PushItemReceiptExpired {
  status: 'receipt-expired';
  changeId: string;
}

export type SyncPushItemResult =
  | PushItemAccepted
  | PushItemConflict
  | PushItemRejected
  | PushItemResetRequired
  | PushItemReceiptExpired;

export interface SyncPushResult {
  /** Sequential per-item outcomes in batch order. */
  results: SyncPushItemResult[];
}

declare const syncCursorBrand: unique symbol;

/** Opaque, backend/account/epoch-scoped pull position. Never constructed locally. */
export type SyncCursor = string & { readonly [syncCursorBrand]: 'SyncCursor' };

export interface SyncPullParams {
  cursor: SyncCursor | null;
  maxBytes: number;
  maxChanges?: number;
}

export interface SyncedChange {
  entityType: string;
  entityId: string;
  revision: number;
  operation: SyncOperation;
  schemaVersion: number;
  payload?: unknown;
  sequence: number;
}

export interface SyncPullResult {
  changes: SyncedChange[];
  nextCursor: SyncCursor;
  hasMore: boolean;
  /** Oldest pull cursor still backed by a complete retained journal. */
  recoveryFloor: number;
}

/** Immutable, client-encrypted R2 chunk included in a compact snapshot. */
export interface SyncSnapshotChunkDescriptor {
  index: number;
  byteLength: number;
  /** Lowercase SHA-256 hex of the stored encrypted bytes. */
  sha256: string;
}

/** Published, verified recovery image for one account dataset/key epoch. */
export interface SyncSnapshotManifest {
  formatVersion: 2;
  snapshotId: string;
  generation: number;
  datasetEpoch: string;
  keyVersion: number;
  schemaVersion: typeof SYNC_SNAPSHOT_SCHEMA_VERSION;
  /** Every mutation through this sequence is represented by the snapshot. */
  committedCursor: SyncCursor;
  /** Client-verified coverage counts; the server never decrypts the chunks. */
  entityCount: number;
  tombstoneCount: number;
  /** SHA-256 of the canonical begin fields and all chunk descriptors. */
  manifestSha256: string;
  chunks: SyncSnapshotChunkDescriptor[];
  createdAt: string;
}

/** Reserves an immutable upload, fenced to the current manifest generation. */
export interface SyncSnapshotBeginParams {
  /** Client-generated UUID makes begin retries idempotent. */
  publicationId: string;
  /** Completed server scan proving full-state coverage at committedCursor. */
  scanId: string;
  expectedGeneration: number;
  datasetEpoch: string;
  keyVersion: number;
  schemaVersion: typeof SYNC_SNAPSHOT_SCHEMA_VERSION;
  committedCursor: SyncCursor;
  entityCount: number;
  tombstoneCount: number;
  manifestSha256: string;
  chunks: SyncSnapshotChunkDescriptor[];
}

export interface SyncSnapshotBeginResult {
  publicationId: string;
  uploadExpiresAt: string;
}

export interface SyncSnapshotChunkPutParams {
  publicationId: string;
  index: number;
  /** Standard base64 encoded encrypted chunk bytes (at most 256 KiB). */
  bytesBase64: string;
}

export interface SyncSnapshotChunkPutResult {
  publicationId: string;
  index: number;
  sha256: string;
  byteLength: number;
  alreadyUploaded: boolean;
}

/** Attests that the publisher downloaded and staged the complete snapshot. */
export interface SyncSnapshotVerifyParams {
  publicationId: string;
  manifestSha256: string;
}

export interface SyncSnapshotVerifyResult {
  publicationId: string;
  verified: true;
}

export interface SyncSnapshotCommitParams {
  publicationId: string;
}

export interface SyncSnapshotCommitResult {
  manifest: SyncSnapshotManifest;
  previousGeneration: number | null;
}

export interface SyncSnapshotGetResult {
  manifest: SyncSnapshotManifest | null;
  /** Prior verified generation kept for rollback during the retention window. */
  previousManifest: SyncSnapshotManifest | null;
  datasetEpoch: string;
  keyVersion: number;
  currentCursor: SyncCursor;
  /** A cursor below this floor requires snapshot recovery before replay. */
  recoveryFloor: number;
}

/** Logical snapshot plaintext, sealed as one account-key blob before chunking. */
export interface SyncSnapshotDocument {
  formatVersion: 2;
  datasetEpoch: string;
  keyVersion: number;
  schemaVersion: typeof SYNC_SNAPSHOT_SCHEMA_VERSION;
  committedCursor: SyncCursor;
  /** Complete remote entity state at committedCursor, including tombstones. */
  entities: Array<{
    entityType: string;
    entityId: string;
    revision: number;
    operation: SyncOperation;
    schemaVersion: number;
    payload?: unknown;
  }>;
}

export interface SyncSnapshotChunkGetParams {
  snapshotId: string;
  index: number;
}

export interface SyncSnapshotChunkGetResult {
  index: number;
  sha256: string;
  byteLength: number;
  bytesBase64: string;
}

/**
 * Canonical content hashed by SyncSnapshotBeginParams.manifestSha256.
 * Publication IDs are retry identities and are intentionally not part of
 * the immutable snapshot content digest.
 */
export function canonicalSyncSnapshotManifestHashInput(
  params: Omit<SyncSnapshotBeginParams, 'publicationId' | 'manifestSha256'>,
): string {
  return canonicalizeJson({
    chunks: params.chunks,
    committedCursor: params.committedCursor,
    datasetEpoch: params.datasetEpoch,
    entityCount: params.entityCount,
    expectedGeneration: params.expectedGeneration,
    keyVersion: params.keyVersion,
    scanId: params.scanId,
    schemaVersion: params.schemaVersion,
    tombstoneCount: params.tombstoneCount,
  });
}

export interface SyncScanBeginParams {
  epoch?: string | null;
}

export interface SyncScanBeginResult {
  scanId: string;
  watermarkStart: number;
  /**
   * Pull cursor positioned at `watermarkStart`. The client stages the scan,
   * then applies every change in (watermarkStart, watermarkEnd] starting from
   * this cursor before activating the staged snapshot.
   */
  resumeCursor: SyncCursor;
  epoch: string;
}

export interface ScannedEntity {
  entityType: string;
  entityId: string;
  revision: number;
  operation: SyncOperation;
  schemaVersion: number;
  /** Omitted for tombstones. */
  payload?: unknown;
}

export interface SyncScanPageParams {
  scanId: string;
  cursor: string | null;
  maxBytes: number;
}

export interface SyncScanPageResult {
  entities: ScannedEntity[];
  nextCursor: string | null;
  done: boolean;
}

export interface SyncScanFinishParams {
  scanId: string;
}

export interface SyncScanFinishResult {
  scanId: string;
  complete: boolean;
  /**
   * Server-assigned end watermark. The activated snapshot equals the scanned
   * entities plus the pull range (watermarkStart, watermarkEnd]; clients resume
   * normal pulls at `nextCursor`.
   */
  watermarkEnd: number;
  /** Dataset epoch proof re-checked when the scan finished. */
  epoch: string;
  nextCursor: SyncCursor;
}

type HashInputChange = Pick<
  PendingChange,
  'entityType' | 'entityId' | 'schemaVersion' | 'baseRevision' | 'operation' | 'payload'
>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'string') {
    const encoded: string = JSON.stringify(value);
    return encoded;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    const entries = keys.map((key) => {
      const encodedKey: string = JSON.stringify(key);
      return `${encodedKey}:${canonicalize(value[key])}`;
    });
    return `{${entries.join(',')}}`;
  }
  return 'null';
}

/**
 * Deterministic canonical JSON (sorted keys, no whitespace) for any value.
 * Used to build hash inputs and test vectors; not a hash itself.
 */
export function canonicalizeJson(value: unknown): string {
  return canonicalize(value);
}

/**
 * Canonical serialization of the immutable mutation content covered by
 * `PendingChange.payloadHash`: operation, identity, base revision, and
 * payload. Key order of the caller's object does not affect the output.
 */
export function canonicalChangeHashInput(change: HashInputChange): string {
  return canonicalize({
    baseRevision: change.baseRevision,
    entityId: change.entityId,
    entityType: change.entityType,
    operation: change.operation,
    payload: change.payload ?? null,
    schemaVersion: change.schemaVersion,
  });
}

/**
 * Hashes a change with an injected SHA-256 implementation so this contract
 * stays free of Node-only crypto. The hasher must accept the canonical
 * UTF-8 string and return lowercase hex.
 */
export function hashChange(change: HashInputChange, sha256Hex: (input: string) => string): string {
  return sha256Hex(canonicalChangeHashInput(change));
}
