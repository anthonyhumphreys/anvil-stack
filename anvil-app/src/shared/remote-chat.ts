export type RemoteCodexAccountAuthChoice = 'codex-host-auth' | 'codex-account';

import type { PermissionMode } from '../../cloud/contract/permissions.js';
import type { AgentProvider } from './types.js';

export type RemoteCredentialChoice =
  | 'target-local'
  | 'codex-host-auth'
  | 'codex-account'
  | 'openai-api-key'
  | 'cloud-provider';

export type RemoteChatState =
  | 'preparing'
  | 'starting'
  | 'running'
  | 'awaiting-approval'
  | 'cancel-requested'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RemoteChatTurnState =
  | 'queued'
  | 'running'
  | 'awaiting-approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface RemoteChatTurn {
  id: string;
  prompt: string;
  state: RemoteChatTurnState;
  response?: string;
  jobId?: string;
  error?: string;
  createdAt: string;
}

export interface CreateRemoteChatInput {
  workspaceId: string;
  targetEnrollmentId: string;
  provider: AgentProvider;
  model: string;
  permissionMode: PermissionMode;
  credentialChoice?: RemoteCredentialChoice;
  prompt: string;
  requestId?: string;
}

export interface SendRemoteChatInput {
  sessionId: string;
  requestId: string;
  prompt: string;
}

/** Renderer-safe remote chat state. Provider-native resume handles stay in main. */
export interface RemoteChatRecord {
  id: string;
  workspaceId: string;
  targetEnrollmentId: string;
  provider: AgentProvider;
  model: string;
  permissionMode: PermissionMode;
  credentialChoice?: RemoteCredentialChoice;
  sourceSessionId?: string;
  handoffId?: string;
  state: RemoteChatState;
  turns: RemoteChatTurn[];
  prepareJobId?: string;
  jobId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
