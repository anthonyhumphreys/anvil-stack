// Session handoff state machine and checkpoint shape.
//
// The source must durably reject new messages, quiesce, checkpoint, and
// relinquish its generation before the target activates. Pre-transfer
// cancellation may resume a proven-stopped source under its valid ownership;
// post-transfer cancellation follows target stop/recovery.

export type HandoffState =
  | 'requested'
  | 'target-prepared-without-execution'
  | 'source-quiescing'
  | 'source-relinquished-and-checkpointed'
  | 'ownership-transferred'
  | 'target-activating'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type ProviderContinuationMode =
  | 'native-resume'
  | 'checkpoint-import'
  | 'summary-continuation'
  | 'unsupported';

export interface HandoffRepositoryCommit {
  repositoryId: string;
  commit: string;
}

export interface SessionCheckpoint {
  /** Logical session identity, stable across devices and attempts. */
  sessionId: string;
  schemaVersion: number;
  sourceGeneration: number;
  repositories: HandoffRepositoryCommit[];
  provider: string;
  model: string;
  /** Transferable messages, a summary, or both depending on provider mode. */
  messages?: unknown[];
  summary?: string;
  planGoalState?: string;
  artifactRefs: string[];
  /** Approval authority never transfers; approvals are reissued on target. */
  unresolvedApprovals: string[];
}

/**
 * Allowed handoff advances. `completed` is reachable only from
 * `target-activating`; `cancelled`/`failed` are reachable from every
 * non-terminal state, with pre/post-transfer cancel semantics resolved by
 * the ownership rules above rather than by this table.
 */
export const HANDOFF_TRANSITIONS: Record<HandoffState, readonly HandoffState[]> = {
  requested: ['target-prepared-without-execution', 'cancelled', 'failed'],
  'target-prepared-without-execution': ['source-quiescing', 'cancelled', 'failed'],
  'source-quiescing': ['source-relinquished-and-checkpointed', 'cancelled', 'failed'],
  'source-relinquished-and-checkpointed': ['ownership-transferred', 'cancelled', 'failed'],
  'ownership-transferred': ['target-activating', 'cancelled', 'failed'],
  'target-activating': ['completed', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
};

export function canAdvanceHandoff(from: HandoffState, to: HandoffState): boolean {
  return HANDOFF_TRANSITIONS[from].includes(to);
}

// ---- RPC surface -----------------------------------------------------------

/**
 * `handoff.create` (user): opens the transfer of `sessionId` from source to
 * target. `handoffId` is the idempotency key — a repeated create with the
 * same session/source/target/generation returns the existing row; a reuse
 * with different parameters conflicts. `sourceGeneration` asserts the
 * generation the source currently holds; the first create seen for a
 * session binds that generation to the source enrollment.
 */
export interface HandoffCreateParams {
  handoffId: string;
  sessionId: string;
  sourceEnrollmentId: string;
  targetEnrollmentId: string;
  sourceGeneration: number;
}

export interface HandoffGetParams {
  handoffId: string;
}

/**
 * `handoff.advance` (either, enrollment-checked per transition): CAS on the
 * `from` state honoring HANDOFF_TRANSITIONS. Advancing to
 * `source-relinquished-and-checkpointed` requires `checkpoint`; advancing to
 * `ownership-transferred` performs the session generation CAS that makes the
 * target the sole owner (failure surfaces as `stale-generation`).
 */
export interface HandoffAdvanceParams {
  handoffId: string;
  from: HandoffState;
  to: HandoffState;
  checkpoint?: SessionCheckpoint;
}

export interface HandoffCancelParams {
  handoffId: string;
  reason?: string;
}

/** Durable handoff row as returned by handoff.get/create/advance/cancel. */
export interface HandoffRecord {
  id: string;
  sessionId: string;
  state: HandoffState;
  sourceEnrollmentId: string;
  targetEnrollmentId: string;
  sourceGeneration: number;
  /** Set once ownership-transferred; the generation the target now owns. */
  targetGeneration: number | null;
  checkpoint: SessionCheckpoint | null;
  /**
   * State the handoff was cancelled from (null while uncancelled). Pre-
   * transfer states mean the source may resume under its still-valid
   * ownership; post-transfer states mean the target owns recovery.
   */
  cancelledFrom: HandoffState | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HandoffCreateResult {
  handoff: HandoffRecord;
}

export interface HandoffGetResult {
  handoff: HandoffRecord;
}

export interface HandoffAdvanceResult {
  handoff: HandoffRecord;
}

export interface HandoffCancelResult {
  handoff: HandoffRecord;
}
