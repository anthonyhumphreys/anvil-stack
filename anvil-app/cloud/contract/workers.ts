// Worker lifecycle (MESH-01): local opt-in policy, worker incarnation
// registry, capability/replica metadata, and availability reporting.
//
// Sync enrollment does not authorize Mesh. A device opts in locally by
// publishing a device policy whose worker section allows jobs; every
// `worker.*` operation fails closed unless that policy is present and
// allowing. `allowedSources` is stored by the backend now and enforced at
// `job.claim` (MESH-02); it never substitutes for target-local validation.
// Replica summaries are metadata only — paths and local configuration never
// leave the device.

/**
 * `allowedSources` entry matching every enrollment on the same account.
 * Any other entry is an explicit source enrollment id.
 */
export const SAME_ACCOUNT_SOURCE = 'same-account' as const;

/** The worker facet of a device policy: this enrollment's consent to run jobs. */
export interface WorkerPolicy {
  /** Master switch: `worker.*` operations reject unless this is true. */
  allowJobs: boolean;
  /**
   * Source enrollments permitted to request execution on this device:
   * explicit enrollment ids or the literal `same-account`. Absent means no
   * remote source is authorized (enforced at `job.claim`, MESH-02).
   */
  allowedSources?: string[];
  /** Upper bound on concurrent attempts this device accepts. */
  maxConcurrentJobs?: number;
}

/**
 * Device policy document published by `device.policy.publish`. New facets
 * are added alongside `worker`; the backend stores the document verbatim
 * and the device may only publish for its own enrollment.
 */
export interface DevicePolicy {
  worker: WorkerPolicy;
}

export type DevicePolicyPublishParams = DevicePolicy;

export interface DevicePolicyPublishResult {
  published: true;
  /** Server wall-clock time (ISO-8601) the policy was stored. */
  publishedAt: string;
}

/** `worker.connect` takes no parameters: identity comes from the session. */
export type WorkerConnectParams = Record<string, never>;

export interface WorkerConnectResult {
  /**
   * The enrollment's active incarnation: a fresh UUID on first connect or
   * after lease expiry/revocation, reused on heartbeat reconnects that land
   * inside the active lease.
   */
  workerIncarnation: string;
  /** ISO-8601 instant the incarnation lease lapses (WORKER_LEASE_MS out). */
  leaseExpiresAt: string;
}

/** Published capability set; replaces the incarnation's prior set verbatim. */
export interface WorkerCapabilities {
  os: string;
  arch: string;
  memoryMb?: number;
  capabilities: string[];
  maxConcurrentJobs?: number;
}

export type WorkerCapabilitiesPublishParams = WorkerCapabilities;

export interface WorkerCapabilitiesPublishResult {
  published: true;
}

export type WorkerReplicaReadiness = 'ready' | 'cloning' | 'error' | 'not-ready';

/** Coarse replica state for placement; metadata only, never local paths. */
export interface WorkerReplicaSummary {
  workspaceId: string;
  definitionRevision: string;
  readiness: WorkerReplicaReadiness;
  /** ISO-8601 time the worker last verified this state. */
  observedAt: string;
}

/** Upserts replica summaries keyed by `workspaceId`; unlisted replicas persist. */
export interface WorkerReplicaPublishParams {
  replicas: WorkerReplicaSummary[];
}

export interface WorkerReplicaPublishResult {
  published: true;
}

/**
 * The caller's worker record. `workerIncarnation`/`lastSeenAt`/`leaseExpiresAt`
 * are null while the enrollment has an allowing policy but no live
 * incarnation. `available` is derived from lease freshness at read time —
 * never a stored flag — so expiry holds without relying on sweep timers.
 */
export interface WorkerDescribeResult {
  enrollmentId: string;
  workerIncarnation: string | null;
  available: boolean;
  policy: DevicePolicy;
  capabilities: WorkerCapabilities | null;
  replicas: WorkerReplicaSummary[];
  /** ISO-8601 time the current incarnation was established. */
  connectedAt: string | null;
  lastSeenAt: string | null;
  leaseExpiresAt: string | null;
}
