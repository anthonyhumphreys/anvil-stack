// Provider-neutral Anvil Sync & Mesh v1 contract constants.
//
// Frozen v1 values. Changing any of these requires a new wire-major protocol
// version; additive capability growth belongs in new profiles, not edits here.

/** Wire-major protocol identifier sent in every RPC envelope. */
export const PROTOCOL = 'anvil-backend/1' as const;

export type ProtocolName = typeof PROTOCOL;

/** Capability profiles a backend may advertise in discovery. */
export const PROFILES = ['sync/1', 'mesh/1'] as const;

export type ProfileName = (typeof PROFILES)[number];

/** WebSocket subprotocol used for the live channel. */
export const SOCKET_SUBPROTOCOL = 'anvil.mesh.v1' as const;

/** The only accepted connection-descriptor version in v1. */
export const DESCRIPTOR_VERSION = 1 as const;

/** Negotiated byte/count limits (UTF-8 bytes, not characters). */
export interface ContractLimits {
  entityBytes: number;
  pageBytes: number;
  batchChanges: number;
  liveFrameBytes: number;
}

/** Default limits applied when the backend does not negotiate stricter ones. */
export const DEFAULT_LIMITS: ContractLimits = {
  entityBytes: 65536,
  pageBytes: 262144,
  batchChanges: 50,
  liveFrameBytes: 16384,
};

/** Incremental changes, delete tombstones, and push receipts are kept this long. */
export const RETENTION_CHANGES_DAYS = 90;

/** Push receipts are kept this long; older sequences report `receipt-expired`. */
export const RETENTION_RECEIPTS_DAYS = 90;

/** Upper bound on the lifetime of one snapshot-scan reconciliation pass. */
export const SNAPSHOT_LIFETIME_MS = 15 * 60 * 1000;

/** Target readiness probes must answer within this deadline. */
export const READINESS_PROBE_TIMEOUT_MS = 15_000;

/** Default expiry for a user-launched execution request. */
export const USER_JOB_DEADLINE_MS = 10 * 60 * 1000;

/** How long one execution-ownership lease lasts once granted. */
export const LEASE_DURATION_MS = 120_000;

/** How often a running worker renews each active attempt lease. */
export const LEASE_RENEW_INTERVAL_MS = 30_000;

/** Observer interest lapses after this long without renewal. */
export const OBSERVER_INTEREST_MS = 90_000;

/**
 * MESH-01: lifetime of a worker incarnation lease granted by
 * `worker.connect` and refreshed by worker metadata publishes. A worker
 * whose last-seen is older than this bound is treated as unavailable;
 * reconnecting after expiry mints a new incarnation. Sized at three missed
 * renewals of the attempt-lease cadence.
 */
export const WORKER_LEASE_MS = 3 * LEASE_RENEW_INTERVAL_MS;
