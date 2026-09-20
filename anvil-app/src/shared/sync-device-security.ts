/** Renderer-safe device security and recovery contracts. Secrets never appear in a status DTO. */

/** Policy used when a new authenticated enrollment needs the account key. */
export type SyncDeviceTrustPolicy = 'require-approval' | 'auto-trust-authenticated';

/** Trust state for this enrollment. Encryption access is represented separately by hasAccountKey. */
export type SyncDeviceTrustState = 'unknown' | 'pending' | 'trusted' | 'revoked';

/** Non-secret explanation of how this enrollment became trusted. */
export type SyncDeviceTrustSource =
  | 'unknown'
  | 'first-device'
  | 'manual-approval'
  | 'pairing'
  | 'automatic-auth'
  | 'recovery'
  | 'recovery-code'
  | 'local-device';

export type SyncDeviceSecurityEventKind =
  | 'policy-configured'
  | 'policy-changed'
  | 'recovery-configured'
  | 'recovery-unlocked'
  | 'recovery-replaced'
  | 'device-approved'
  | 'device-auto-trusted'
  | 'device-revoked'
  | 'encrypted-data-reset';

/** Metadata only — event rows must never carry keys, recovery codes, or payloads. */
export interface SyncDeviceSecurityEvent {
  kind: SyncDeviceSecurityEventKind;
  occurredAt: string;
  source: SyncDeviceTrustSource;
  enrollmentId: string | null;
}

/** Account-scoped security state for the currently signed-in enrollment. */
export interface SyncDeviceSecurityStatus {
  /** Stable account identifier used for destructive reset confirmation. */
  accountId: string | null;
  configured: boolean;
  policy: SyncDeviceTrustPolicy;
  revision: number;
  trustState: SyncDeviceTrustState;
  trustSource: SyncDeviceTrustSource;
  hasAccountKey: boolean;
  hasRecoverySecret: boolean;
  /** True only while this account is eligible for first-device setup. */
  canConfigure: boolean;
  /** True when the enrollment is authenticated/trusted but still lacks its key. */
  requiresRecovery: boolean;
  recentEvents: SyncDeviceSecurityEvent[];
}

/** Result of a recovery setup or replacement. The code is returned exactly once. */
export interface SyncDeviceRecoveryResult {
  recoveryCode: string;
}

/** Exact acknowledgement required before deleting an account's encrypted data generation. */
export type SyncEncryptedSyncAccountResetConfirmation = 'RESET ENCRYPTED DATA';
