import type { AgentProvider } from './types.js';

export type CloudAgentConnectionProvider = 'cursor' | 'devin';
export type CloudAgentConnectionState =
  | 'connected'
  | 'disconnected'
  | 'locked'
  | 'expired'
  | 'connecting';

export interface CloudAgentProviderStatus {
  provider: AgentProvider;
  enabled: boolean;
  connected: boolean;
  connectionState: CloudAgentConnectionState;
  detail?: string;
}

export interface CloudAgentSettingsSnapshot {
  providers: CloudAgentProviderStatus[];
}

export interface CloudAgentConnectionResult {
  snapshot: CloudAgentSettingsSnapshot;
  error?: string;
}
