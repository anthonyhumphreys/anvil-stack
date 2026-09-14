import type { AgentProvider } from './types.js';

/** Providers driven through an Agent Client Protocol (ACP) subprocess. */
export const ACP_AGENT_PROVIDERS = ['cursor', 'devin'] as const;
export type AcpAgentProvider = (typeof ACP_AGENT_PROVIDERS)[number];

export function isAcpAgentProvider(
  provider: AgentProvider | undefined,
): provider is AcpAgentProvider {
  return ACP_AGENT_PROVIDERS.includes(provider as AcpAgentProvider);
}
