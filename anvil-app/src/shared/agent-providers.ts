import type { AgentProvider } from './types.js';

export const AGENT_PROVIDERS = [
  'codex',
  'openai',
  'azure',
  'cursor',
  'devin',
  'llmgateway',
] as const satisfies readonly AgentProvider[];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === 'string' && AGENT_PROVIDERS.some((provider) => provider === value);
}

/** Providers driven through an Agent Client Protocol (ACP) subprocess. */
export const ACP_AGENT_PROVIDERS = ['cursor', 'devin'] as const;
export type AcpAgentProvider = (typeof ACP_AGENT_PROVIDERS)[number];

export function isAcpAgentProvider(
  provider: AgentProvider | undefined,
): provider is AcpAgentProvider {
  return ACP_AGENT_PROVIDERS.includes(provider as AcpAgentProvider);
}
