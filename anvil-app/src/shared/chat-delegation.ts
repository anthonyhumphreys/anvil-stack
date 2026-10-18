import type {
  AgentProvider,
  CodexMode,
  ReasoningEffort,
  WorkflowRunStatus,
  WorkflowNodeRunStatus,
  WorkflowTargetPolicy,
} from './types';

export interface ChatDelegationOrigin {
  threadId: string;
  requestId: string;
  fingerprint: string;
  reason: string;
  destinations: Record<string, string>;
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
}

export type ChatDelegationAction = 'resume' | 'retry' | 'integrate';
