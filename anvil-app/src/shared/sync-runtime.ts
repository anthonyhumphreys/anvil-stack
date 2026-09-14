/**
 * Renderer-safe Sync runtime contracts. Tokens never appear here.
 */

import type { HandoffRecord } from '../../cloud/contract/handoff.js';

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

/**
 * Account-scoped device row (`device.list`). `self` marks the caller's own
 * enrollment; revoked rows stay listed for audit until the server sweep
 * ages them out. Never carries token material.
 */
export interface SyncDevice {
  enrollmentId: string;
  displayName?: string;
  installationId: string;
  revoked: boolean;
  createdAt: string;
  self: boolean;
}

export interface SyncDeviceRenameResult {
  renamed: boolean;
  enrollmentId: string;
}

export interface SyncDeviceRevokeResult {
  revoked: boolean;
  enrollmentId: string;
}

/** Result of exporting the account's synced entities to a chosen file. */
export interface SyncDataExportFileResult {
  saved: boolean;
  filePath: string | null;
  entityCount: number;
}

export interface SyncDataImportSummary {
  creates: number;
  identical: number;
  conflicts: number;
  invalid: number;
}

export interface SyncImportPreviewEntry {
  entityType: string;
  entityId: string;
  outcome: 'create' | 'identical' | 'conflict' | 'invalid';
  reason?: string;
}

/** Staged import plan — nothing applies until `commitDataImport` runs. */
export type SyncDataImportFilePreview =
  | { canceled: true }
  | {
      canceled: false;
      fileName: string;
      operationId: string;
      summary: SyncDataImportSummary;
      entries: SyncImportPreviewEntry[];
      truncated: boolean;
    };

export interface SyncDataImportCommitResult {
  applied: number;
  conflicts: number;
  skipped: number;
}

// ---- Mesh session view (spec §18) ----------------------------------------
// Wire types are re-exported from the provider-neutral contract (the
// `sync-mesh.ts` precedent) so desktop and backend share one schema.

export type { HandoffRecord, HandoffState } from '../../cloud/contract/handoff.js';
export type {
  ApprovalDecision,
  ApprovalRecord,
  ExecutionAttempt,
  JobState,
  JobSummary,
} from '../../cloud/contract/jobs.js';

/** Live attempt activity item pushed to observers (mesh-observe mirror). */
export interface SyncAttemptActivity {
  at: string;
  kind: 'stdout' | 'stderr' | 'status';
  text: string;
  sequence: number;
  /** True when a gap frame/replay marks skipped sequence numbers. */
  gapBefore: boolean;
}

/**
 * Readiness blocker returned when a session can't hand off yet — each
 * carries a concrete remediation (dirty tree, unpushed commits, …).
 */
export interface SyncHandoffBlocker {
  repositoryId?: string;
  code: string;
  remediation: string;
}

export type SyncInitiateHandoffResult =
  | { ok: true; handoff: HandoffRecord }
  | { ok: false; blockers: SyncHandoffBlocker[] };

/** Local ownership mirror + live handoff rows for one chat session. */
export interface SessionMeshState {
  ownership: {
    state: 'owned' | 'relinquished';
    generation: number;
    ownerEnrollmentId: string;
  } | null;
  handoffs: HandoffRecord[];
}

/** MESH-02 device-local worker state — consent + incarnation, never synced. */
export interface MeshWorkerStatus {
  /** Local opt-in flag: this device consents to run account jobs. */
  enabled: boolean;
  /** The worker incarnation lease is live (fresh `worker.connect`). */
  connected: boolean;
  workerIncarnation: string | null;
  leaseExpiresAt: string | null;
  activeAttempts: number;
  lastError: string | null;
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
  /** A rejection was the account history quota — local edits stay local until space frees. */
  quotaExceeded: boolean;
  /** Dataset was reset server-side; the next cycle re-scans and rebuilds. */
  recovering: boolean;
  /** The stored session was revoked or rejected; sign in again to resume. */
  sessionExpired: boolean;
  /** Device-local mesh worker state (opt-in is never synced). */
  meshWorker: MeshWorkerStatus;
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
