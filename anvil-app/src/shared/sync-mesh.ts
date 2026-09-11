/**
 * Shared TypeScript contracts for the local sync persistence layer (SYNC-01).
 *
 * Wire types (`PendingChange`, `SyncOperation`) are re-exported from the
 * provider-neutral contract so local hashing and the backend share one schema.
 * Every sync row is scoped to `{ backendId, accountId, datasetEpoch }` per the
 * spec's ownership invariants. `datasetEpoch` is an opaque identifier (rotated
 * on server restore), so it is modelled as a string even though it is often numeric.
 */

export type { PendingChange, SyncOperation } from '../../cloud/contract/sync.js';
export {
  canonicalChangeHashInput,
  canonicalizeJson,
  hashChange,
} from '../../cloud/contract/sync.js';

export interface SyncScope {
  backendId: string;
  accountId: string;
  datasetEpoch: string;
}

export type SyncEntityType = string;

export type SyncOutboxState = 'pending' | 'dispatched' | 'acknowledged' | 'conflict' | 'rejected';

export type SyncEnrollmentState = 'active' | 'revoked' | 'pending';

export type SyncConflictKind = 'edit-edit' | 'edit-delete' | 'delete-edit';

export type SyncConflictResolution = 'keep-local' | 'use-remote' | 'save-copy';

export type PushResultStatus =
  | 'accepted'
  | 'conflict'
  | 'rejected'
  | 'reset-required'
  | 'receipt-expired';

export interface DeviceEnrollment {
  id: string;
  scope: SyncScope;
  installationId: string;
  enrollmentGeneration: number;
  displayName: string;
  state: SyncEnrollmentState;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface SyncBinding {
  id: string;
  scope: SyncScope;
  entityType: string;
  entityId: string;
  /** Last acknowledged revision, stored separately from the live domain row. */
  baseRevision: number | null;
  /** Last acknowledged payload, stored separately from the live domain row. */
  basePayloadJson: string | null;
  localEditGeneration: number;
  acknowledgedGeneration: number;
  /** Raw payload for unknown-schema entities held in quarantine. */
  quarantineJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncOutboxRow {
  changeId: string;
  scope: SyncScope;
  enrollmentId: string;
  /** Assigned at dispatch; null while the row is still coalescible. */
  enrollmentSequence: number | null;
  entityType: string;
  entityId: string;
  schemaVersion: number;
  baseRevision: number | null;
  operation: SyncOperation;
  payloadJson: string | null;
  payloadHash: string;
  localEditGeneration: number;
  state: SyncOutboxState;
  createdAt: string;
  dispatchedAt: string | null;
  resultJson: string | null;
}

export interface SyncStateRow {
  scope: SyncScope;
  cursor: string | null;
  lastPullAt: string | null;
  lastPushAt: string | null;
  consumedSequenceHighWater: number;
  retentionFloorSequence: number | null;
  protocolVersion: string | null;
  serverLimitsJson: string | null;
  /** Set when the backend answers `reset-required` or `receipt-expired`. */
  resetRequired: boolean;
  updatedAt: string;
}

export interface SyncConflict {
  id: string;
  scope: SyncScope;
  entityType: string;
  entityId: string;
  basePayloadJson: string | null;
  localPayloadJson: string | null;
  remotePayloadJson: string | null;
  baseRevision: number | null;
  remoteRevision: number | null;
  kind: SyncConflictKind;
  createdAt: string;
  resolvedAt: string | null;
  resolution: SyncConflictResolution | null;
}

export interface PushResult {
  changeId: string;
  status: PushResultStatus;
  revision?: number;
  remotePayload?: unknown;
  remoteRevision?: number;
}

export interface NextBatchOptions {
  maxChanges?: number;
  maxBytes?: number;
}

export interface RecordLocalChangeInput {
  entityType: string;
  entityId: string;
  schemaVersion: number;
  operation: SyncOperation;
  /** Absent for deletes. */
  payload?: unknown;
}

export const SYNC_PUSH_DEFAULTS = {
  maxChanges: 50,
  maxBytes: 262144,
} as const;

/** Portable entity types synced in this packet. */
export const SYNC_ENTITY_WORKFLOW_TEMPLATE = 'workflow-template';
