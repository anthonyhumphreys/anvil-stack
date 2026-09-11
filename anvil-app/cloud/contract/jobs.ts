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
 * - Terminal states have no outgoing edges.
 */
export const JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ['running', 'awaiting-approval', 'failed', 'cancel-requested', 'cancelled'],
  running: ['awaiting-approval', 'completed', 'failed', 'cancel-requested', 'unknown-outcome'],
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
