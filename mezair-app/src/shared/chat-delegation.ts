import type {
  AgentProvider,
  CodexMode,
  ReasoningEffort,
  WorkflowRunStatus,
  WorkflowNodeRunStatus,
  WorkflowTargetPolicy,
} from './types';
import type { RemoteReviewBackendBinding } from './remote-review-candidate';

export interface ChatDelegationOrigin {
  threadId: string;
  requestId: string;
  fingerprint: string;
  reason: string;
  destinations: Record<string, string>;
  source?: 'committed' | 'current-tracked';
  /** Pre-approval source pins for current-tracked reviews, keyed by portable repository ID. */
  sourceBaseCommits?: Record<string, string>;
  /** Backend authority and account approved for a current-tracked review. */
  sourceBackend?: RemoteReviewBackendBinding;
}

export interface ChatDelegationTaskInput {
  id: string;
  name: string;
  instruction: string;
  destinationId: string;
  provider?: AgentProvider;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  access?: 'read-only' | 'inherit';
  dependsOn?: string[];
}

export interface ChatDelegationInput {
  requestId: string;
  title: string;
  reason: string;
  source?: 'committed' | 'current-tracked';
  tasks: ChatDelegationTaskInput[];
}

export interface ChatDelegationDestination {
  id: string;
  label: string;
  target: WorkflowTargetPolicy;
  capabilities: string[];
  providers: AgentProvider[];
  state: string;
}

export type ChatDelegationVerificationState =
  'not-run' | 'running' | 'passed' | 'failed' | 'blocked' | 'stale';

export interface ChatDelegationVerificationCandidate {
  label: string;
  command: string;
  source: 'saved' | 'detected';
}

export interface ChatDelegationIntegrationRepositoryPlan {
  repositoryId: string;
  name: string;
  candidates: ChatDelegationVerificationCandidate[];
  recommendedCommands: string[];
}

export interface ChatDelegationIntegrationPlan {
  repositories: ChatDelegationIntegrationRepositoryPlan[];
  permissionMode: CodexMode;
  permissionExplanation: string;
}

export interface ChatDelegationVerificationSelection {
  repositoryId: string;
  commands: string[];
}

export interface ChatDelegationIntegrationRepository {
  repositoryId: string;
  name: string;
  baseCommit: string;
  integratedCommit: string | null;
  branch: string;
  worktreePath: string;
  appliedAt: string | null;
  destinationBranch: string | null;
  appliedCommit: string | null;
  applyError?: string;
  conflicts: Array<{
    dispatchId: string;
    ref: string;
    conflictedFiles: string[];
  }>;
}

export interface ChatDelegationVerificationResult {
  repositoryId: string;
  command: string;
  approvalGranted: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  logTail: string;
  testedHead: string | null;
  testedTree: string | null;
}

export interface ChatDelegationIntegration {
  integrationId: string;
  mergeState: 'integrating' | 'integrated' | 'conflicted' | 'failed';
  combined: boolean;
  verificationState: ChatDelegationVerificationState;
  verificationAttempt: number;
  verificationSelections: ChatDelegationVerificationSelection[];
  verification: ChatDelegationVerificationResult[];
  appliedAt: string | null;
  applyAllowed: boolean;
  error?: string;
  repositories: ChatDelegationIntegrationRepository[];
}

export interface ChatDelegationRun {
  cancellationPending?: boolean;
  id: string;
  title: string;
  reason: string;
  status: WorkflowRunStatus;
  createdAt: string;
  error?: string;
  tasks: Array<{
    id: string;
    name: string;
    provider: AgentProvider;
    model: string;
    destination: string;
    mode: CodexMode;
    status: WorkflowNodeRunStatus;
    output?: string;
    outputTruncated: boolean;
    error?: string;
    threadId?: string;
    remoteState?: string;
  }>;
  hasRemoteChanges: boolean;
  integrationState?: 'integrated' | 'conflicted' | 'failed';
  integration?: ChatDelegationIntegration;
}

export type ChatDelegationAction = 'resume' | 'retry' | 'integrate';
