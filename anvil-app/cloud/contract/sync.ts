// Sync push/pull/scan types and the canonical change serializer.
//
// `payloadHash` covers the canonical serialization defined here, including
// operation, identity, base revision, and payload. Actor identity is
// authenticated by the device session outside the domain payload.

export type SyncOperation = 'create' | 'update' | 'delete';

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
}

export interface SyncScanBeginParams {
  epoch?: string | null;
}

export interface SyncScanBeginResult {
  scanId: string;
  watermarkStart: number;
  epoch: string;
}

export interface ScannedEntity {
  entityType: string;
  entityId: string;
  revision: number;
  schemaVersion: number;
  payload: unknown;
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
  watermarkEnd: number;
}

export interface SyncScanFinishResult {
  scanId: string;
  complete: boolean;
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
export function hashChange(
  change: HashInputChange,
  sha256Hex: (input: string) => string,
): string {
  return sha256Hex(canonicalChangeHashInput(change));
}
