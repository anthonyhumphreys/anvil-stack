// Durable jobs, execution attempts, and their cancellation-safe transitions.
//
// Terminal completion and cancellation race through conditional transitions:
// an already accepted completion stays completed, while a prior
// cancel-requested state prevents an ordinary completion from masking the
// cancellation outcome. `cancelled` is confirmed only after stopping is
// verified, so `running` never jumps directly to `cancelled`.

export type JobKind =
  | 'diagnostic'
  | 'prepare-workspace'
  | 'start-session'
  | 'code-task'
  | 'workflow-node';

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

// ---- FLOW-01 attempt result manifest -------------------------------------
// The durable proof of what a write-capable attempt produced: exact base →
// result commits per repository, declared verification outcomes, published
// artifacts, and provenance. Code moves through Git refs — a textual
// "done" is context, not evidence (spec §455).

export interface ResultManifestRepository {
  /** Manifest-pinned repository identity (workspace portable id). */
  repositoryId: string;
  baseCommit: string;
  /** Branch tip at finalize time — equals baseCommit when nothing changed. */
  resultCommit: string;
  /** The attempt's unique branch in the source checkout's ref namespace. */
  branch: string;
  /** resultCommit !== baseCommit, or residue was committed by the executor. */
  changed: boolean;
}

export interface ResultManifestVerification {
  repositoryId: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export interface AttemptResultManifest {
  schemaVersion: 1;
  jobId: string;
  attemptId: string;
  repositories: ResultManifestRepository[];
  verification: ResultManifestVerification[];
  /** R2 artifact ids this attempt published (evidence bundle etc.). */
  artifacts: Array<{ artifactId: string; label: string }>;
  provenance: {
    workerEnrollmentId: string;
    workerIncarnation: string;
    cliVersion: string | null;
    startedAt: string;
    completedAt: string;
  };
}

// ---- MESH-03 durable event journal + approvals ---------------------------
// Wire shapes for `event.pull`, `approval.get`, and `approval.decide`
// (spec §10: live and durable channels; durable expiring approvals).

/**
 * Journal row kinds. `activity` rows are intermediate metadata: journaled
 * only up to the per-job budget, then represented by `gap` rows. Every
 * other kind is durable — always journaled, never coalesced or dropped.
 */
export type DurableEventKind =
  | 'job.created'
  | 'job.state'
  | 'attempt.created'
  | 'attempt.state'
  | 'approval.requested'
  | 'approval.decided'
  | 'artifact.reserved'
  | 'artifact.published'
  | 'artifact.deleted'
  | 'artifact.expired'
  | 'activity'
  | 'gap';

/**
 * One journaled event. Two sequence spaces are deliberate: `cursor` is the
 * per-job monotonic durable cursor used by `event.pull`/`subscribe`
 * `afterSequence`, while `sequence` is the per-(attempt, stream) sequence
 * carried live by `ActivityFrame`/`GapFrame`.
 */
export interface DurableEvent {
  /** Monotonic per-job durable cursor; feed back as `afterSequence`. */
  cursor: number;
  jobId: string;
  /** Present on attempt-scoped rows; absent on job-scope lifecycle rows. */
  attemptId?: string;
  streamId: string;
  /** Per-(attempt, stream) sequence — the socket `ActivityFrame.sequence` space. */
  sequence: number;
  kind: DurableEventKind;
  /** Owning attempt's fence for attempt-scoped rows; 0 on job-scope rows. */
  generation: number;
  /**
   * Kind-specific bounded JSON. `gap` rows carry
   * `{attemptId, streamId, fromSequence, toSequence, droppedEvents}` —
   * stream-space bounds of the dropped range.
   */
  payload: unknown;
  createdAt: string;
}

export interface EventPullParams {
  /** A job id or attempt id within the authenticated account. */
  scope: string;
  /** Durable cursor (`DurableEvent.cursor` / `EventPullResult.nextCursor`). */
  afterSequence?: number | null;
  /** Page size, bounded by the backend. */
  limit?: number;
}

export interface EventPullResult {
  scopeKind: 'job' | 'attempt';
  scopeId: string;
  /** Owning job — the cursor domain for `nextCursor`/`hasGap`. */
  jobId: string;
  events: DurableEvent[];
  /** Resume point: feed back as `afterSequence`. */
  nextCursor: number;
  hasMore: boolean;
  /**
   * True when the returned window spans dropped intermediate events —
   * either `gap` rows inside it or a gap range covering part of it.
   */
  hasGap: boolean;
}

/** Durable approval lifecycle (spec §10). */
export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export type ApprovalDecision = 'approved' | 'denied';

/**
 * An expiring durable approval request bound to an attempt, an action
 * digest, the attempt fence (generation), and a permitted approver.
 * Approval never loosens the target's local execution policy; a decision
 * only resolves the pending request.
 */
export interface ApprovalRecord {
  id: string;
  jobId: string;
  attemptId: string;
  /** Digest of the action being approved (e.g. a bootstrap recipe hash). */
  actionDigest: string;
  /** The attempt fence the request was issued against; stale fences reject. */
  generation: number;
  /** The single enrollment permitted to decide; absent defers to `approverRole`. */
  approverEnrollmentId?: string;
  /** Approver class when no enrollment is pinned (`user`: any account device except the executing worker). */
  approverRole: 'user';
  state: ApprovalState;
  decidedBy?: string;
  decidedAt?: string;
  expiresAt: string;
  createdAt: string;
}

/** `approval.get`: exactly one selector is required. */
export interface ApprovalGetParams {
  approvalId?: string;
  jobId?: string;
  attemptId?: string;
}

export interface ApprovalGetResult {
  approvals: ApprovalRecord[];
}

export interface ApprovalDecideParams {
  approvalId: string;
  decision: ApprovalDecision;
  /** Optional human-readable note recorded on the decision. */
  reason?: string;
}

export interface ApprovalDecideResult {
  approval: ApprovalRecord;
  job: JobSummary;
  /**
   * True when an identical decision was already stored — the replay is
   * idempotent and changes nothing.
   */
  duplicate: boolean;
}
