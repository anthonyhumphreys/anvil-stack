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
