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
