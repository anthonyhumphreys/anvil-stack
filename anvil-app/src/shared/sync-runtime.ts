/**
 * Renderer-safe Sync runtime contracts. Tokens never appear here.
 */

export const SPIKE_DATASET_EPOCH = 'spike-epoch-1';

export type SyncAuthPublicState = 'signed-out' | 'enrolling' | 'signed-in';

export interface SyncAuthPublicSnapshot {
  state: SyncAuthPublicState;
  accountId: string | null;
  enrollmentId: string | null;
  expiresAt: string | null;
}

export interface SyncSpikeEnrollInput {
  accountId: string;
  enrollmentId?: string;
}

/** A single-use pairing code minted for enrolling another device. */
export interface SyncIssuedEnrollmentCode {
  code: string;
  expiresAt: string;
  accountId: string;
}

export interface SyncAdoptionPreviewItem {
  entityType: string;
  entityId: string;
  name: string;
}

export type SyncConflictResolutionChoice = 'keep-local' | 'use-remote' | 'save-copy';

export interface SyncConflictView {
  id: string;
  entityType: string;
  entityId: string;
  kind: string;
  localLabel: string | null;
  remoteLabel: string | null;
  /** Raw entity payloads for the compare affordance; null when that side deleted the entity. */
  localPayloadJson: string | null;
  remotePayloadJson: string | null;
}

export interface SyncRuntimeStatus {
  auth: SyncAuthPublicSnapshot;
  syncEnabled: boolean;
  /** Spike enrollment is a dev fixture; true only in unpackaged builds. */
  devSpikeAvailable: boolean;
  /** Live-channel state: the socket accelerates sync; fallback polling always runs. */
  connectionState: 'offline' | 'connecting' | 'live';
  /** The pinned backend's endpoint or issuer changed; re-review is required. */
  backendIdentityReviewRequired: boolean;
  pendingCount: number;
  conflictCount: number;
  /** Terminal-rejected changes that need user attention. */
  rejectedCount: number;
  /** Dataset was reset server-side; the next cycle re-scans and rebuilds. */
  recovering: boolean;
  /** The stored session was revoked or rejected; sign in again to resume. */
  sessionExpired: boolean;
  lastError: string | null;
  lastPushAt: string | null;
  lastPullAt: string | null;
}

/**
 * Per-scope metadata rollup for diagnostics. Counts and sequences only —
 * never payloads, paths, tokens, or enrollment codes.
 */
export interface SyncScopeDiagnostics {
  backendId: string;
  accountId: string;
  datasetEpoch: string;
  /** entityType -> bound entity count. */
  bindingsByEntityType: Record<string, number>;
  /** outbox state -> row count (pending, dispatched, acknowledged, rejected). */
  outboxByState: Record<string, number>;
  openConflicts: number;
  resolvedConflicts: number;
  /** Pull cursor and server-provided sequences for cursor/retention debugging. */
  pullCursor: string | null;
  consumedSequenceHighWater: number;
  retentionFloorSequence: number | null;
  resetRequired: boolean;
  /** Staged scan rows not yet activated. */
  stagedScanRows: number;
  lastPushAt: string | null;
  lastPullAt: string | null;
}

/** Aggregate operational counters returned by the backend, when reachable. */
export interface SyncRemoteAccountStats {
  historyBytes: number;
  historyQuotaBytes: number;
  retentionFloor: number;
  counters: Record<string, number>;
}

/**
 * Redacted diagnostics bundle. Safe to share with an operator: contains
 * identifiers, counts, cursors, and error strings — never payloads, file
 * paths, tokens, enrollment codes, or entity content.
 */
export interface SyncDiagnostics {
  generatedAt: string;
  protocol: string;
  profile: string;
  schemaVersion: number;
  /** Opaque device identifier used to correlate reports with installations. */
  installationId: string;
  status: SyncRuntimeStatus;
  scopes: SyncScopeDiagnostics[];
  /** Remote account stats from session.describe; null when unreachable. */
  remote: SyncRemoteAccountStats | null;
}
