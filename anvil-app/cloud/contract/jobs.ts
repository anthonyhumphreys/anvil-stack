// Durable jobs, execution attempts, and their cancellation-safe transitions.
//
// Terminal completion and cancellation race through conditional transitions:
// an already accepted completion stays completed, while a prior
// cancel-requested state prevents an ordinary completion from masking the
// cancellation outcome. `cancelled` is confirmed only after stopping is
// verified, so `running` never jumps directly to `cancelled`.

export type JobKind = 'diagnostic' | 'prepare-workspace' | 'start-session' | 'workflow-node';

export type JobState =
  | 'queued'
  | 'running'
  | 'awaiting-approval'
  | 'completed'
  | 'failed'
  | 'cancel-requested'
  | 'cancelled'
  | 'unknown-outcome';

export type AttemptState =
  | 'claimed'
  | 'preparing'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown-outcome';

export type RetryPolicy = 'safe' | 'inspect-before-retry' | 'never';

export interface CapabilityRequirements {
  capabilities: string[];
  os?: string;
  cpu?: string;
  memoryMb?: number;
}

export interface RequestedTarget {
  kind: 'device' | 'auto';
  enrollmentId?: string;
  requirements?: CapabilityRequirements;
}

/** Immutable input manifest pinned at job creation. */
export interface ExecutionManifest {
  workspaceDefinitionRevision: string;
  repositories: Array<{ repositoryId: string; commit: string }>;
  bootstrapDigest: string;
  provider: string;
  model: string;
  configVersions: Record<string, string>;
  inputs: Record<string, unknown>;
}

export interface MeshJob {
  id: string;
  /** Unique within account and source enrollment; creation is idempotent on it. */
  requestId: string;
  payloadHash: string;
  kind: JobKind;
  sourceEnrollmentId: string;
  requestedTarget: RequestedTarget;
  /** Resolved before claim; the source's choice is preserved. */
  targetEnrollmentId?: string;
  inputManifest: ExecutionManifest;
  state: JobState;
  queueDeadline: string;
  retryPolicy: RetryPolicy;
}

export interface ExecutionAttempt {
  id: string;
  jobId: string;
  workerIncarnation: string;
  fence: number;
  leaseExpiresAt: string;
  state: AttemptState;
}

/**
 * Allowed job transitions. Notes:
 * - `queued`/`awaiting-approval` may cancel directly: nothing is running yet.
 * - `running` must pass through `cancel-requested`: stopping needs verifying.
 * - `cancel-requested` never reaches `completed`: cancellation wins once asked.
 * - `cancel-requested` loops to itself so cancel stays idempotent.
 * - `running` may return to `queued` exactly once under a `safe` retry
 *   policy: the failed attempt is terminal and the re-queue carries a fresh
 *   queue deadline. It is never a reassignment of a live attempt.
 * - Terminal states have no outgoing edges.
 */
export const JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ['running', 'awaiting-approval', 'failed', 'cancel-requested', 'cancelled'],
  running: [
    'awaiting-approval',
    'completed',
    'failed',
    'cancel-requested',
    'unknown-outcome',
    'queued',
  ],
  'awaiting-approval': ['running', 'failed', 'cancel-requested', 'cancelled', 'unknown-outcome'],
  completed: [],
  failed: [],
  'cancel-requested': ['cancel-requested', 'cancelled', 'failed', 'unknown-outcome'],
  cancelled: [],
  'unknown-outcome': [],
};

/**
 * Allowed attempt transitions. Notes:
 * - `running` never jumps to `cancelled`: only verified stops cancel.
 * - `stopping` never reaches `completed`: a prior cancel request masks
 *   ordinary completion; partial effects are reported with the cancel.
 * - `unknown-outcome` is reachable only from active states
 *   (`claimed`, `preparing`, `running`, `stopping`).
 */
export const ATTEMPT_TRANSITIONS: Record<AttemptState, readonly AttemptState[]> = {
  claimed: ['preparing', 'stopping', 'cancelled', 'failed', 'unknown-outcome'],
  preparing: ['running', 'stopping', 'cancelled', 'failed', 'unknown-outcome'],
  running: ['stopping', 'completed', 'failed', 'unknown-outcome'],
  stopping: ['cancelled', 'failed', 'unknown-outcome'],
  completed: [],
  failed: [],
  cancelled: [],
  'unknown-outcome': [],
};

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export function canTransitionAttempt(from: AttemptState, to: AttemptState): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

// ---- MESH-02 RPC params/results -------------------------------------------
// Wire shapes for the `job.*`/`attempt.*` operations. Account and enrollment
// identity always come from the authenticated session, never from params.

/**
 * `job.create` parameters. Creation is idempotent on `requestId` +
 * `payloadHash` within the (account, source enrollment) pair; a replay with
 * a different hash is a `conflict`.
 */
export interface JobCreateParams {
  requestId: string;
  /** SHA-256 hex over the client-canonical job payload. */
  payloadHash: string;
  kind: JobKind;
  requestedTarget: RequestedTarget;
  inputManifest: ExecutionManifest;
  /** ISO-8601; defaults to USER_JOB_DEADLINE_MS from creation. */
  queueDeadline?: string;
  retryPolicy?: RetryPolicy;
}

/**
 * A MeshJob plus the backend's persisted placement record. `stateReason` is
 * the machine-readable cause of the current state (e.g. `queue-deadline`,
 * `cancel-requested`) when the backend recorded one.
 */
export interface JobSummary extends MeshJob {
  placementExplanation: string | null;
  stateReason?: string;
}

export interface JobCreateResult {
  job: JobSummary;
}

export interface JobGetParams {
  jobId: string;
}

export interface JobGetResult {
  job: JobSummary;
  attempts: ExecutionAttempt[];
}

export interface JobListParams {
  state?: JobState;
  /** Page size, bounded by the backend (max 100). */
  limit?: number;
}

export interface JobListResult {
  jobs: JobSummary[];
}

export interface JobClaimParams {
  jobId: string;
}

export interface JobClaimResult {
  job: JobSummary;
  attempt: ExecutionAttempt;
  /** Ownership fence the worker echoes back on renew/report. */
  fence: number;
  manifest: ExecutionManifest;
}

/** One attempt-lease renewal inside an `attempt.renew` batch. */
export interface AttemptRenewalRequest {
  attemptId: string;
  incarnation: string;
  fence: number;
}

export interface AttemptRenewParams {
  renewals: AttemptRenewalRequest[];
}

export interface AttemptRenewalResult {
  attemptId: string;
  status: 'renewed' | 'rejected';
  /** New ISO-8601 attempt-lease expiry when renewed. */
  leaseExpiresAt?: string;
  /** Machine-readable rejection reason (e.g. `stale-fence`). */
  reason?: string;
}

export interface AttemptRenewResult {
  results: AttemptRenewalResult[];
}

export interface AttemptReportParams {
  attemptId: string;
  incarnation: string;
  fence: number;
  outcome: 'completed' | 'failed';
  /** Provider-neutral final outcome record; bounded metadata. */
  result?: unknown;
  error?: string;
}

export type AttemptReportStatus =
  /** Fence/incarnation matched: the transition was applied. */
  | 'applied'
  /**
   * Stale fence/incarnation or terminal attempt: the transition was rejected
   * but the reported result was retained on the attempt row for forensics.
   */
  | 'late-result-retained';

export interface AttemptReportResult {
  status: AttemptReportStatus;
  job: JobSummary;
  attempt: ExecutionAttempt;
}

export interface JobCancelParams {
  jobId: string;
}

export interface JobCancelResult {
  job: JobSummary;
}
