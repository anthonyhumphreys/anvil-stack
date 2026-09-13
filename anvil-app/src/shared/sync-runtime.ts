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

export type SyncConflictResolutionChoice = 'keep-local' | 'use-remote';

export interface SyncConflictView {
  id: string;
  entityType: string;
  entityId: string;
  kind: string;
  localLabel: string | null;
  remoteLabel: string | null;
}

export interface SyncRuntimeStatus {
  auth: SyncAuthPublicSnapshot;
  syncEnabled: boolean;
  /** Spike enrollment is a dev fixture; true only in unpackaged builds. */
  devSpikeAvailable: boolean;
  /** The pinned backend's endpoint or issuer changed; re-review is required. */
  backendIdentityReviewRequired: boolean;
  pendingCount: number;
  conflictCount: number;
  lastError: string | null;
  lastPushAt: string | null;
  lastPullAt: string | null;
}
