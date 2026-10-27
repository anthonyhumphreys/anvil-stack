export interface CodexRuntimeStatus {
  installed: boolean;
  ready: boolean;
  version?: string;
  path?: string;
  source?: 'managed' | 'system';
  error?: string;
}
