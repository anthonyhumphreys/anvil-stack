import type { AgentProvider, CodexEvent } from '../../shared/types';
import { isAcpAgentProvider } from '../../shared/agent-providers';

/**
 * H13 — provider display labels for user-facing strings.
 *
 * ACP events carry `agentLabel` stamped by the protocol layer ('Cursor',
 * 'Devin'). Codex-family events leave it undefined; callers that only have an
 * event should use `agentEventLabel`, and callers that also know the session
 * provider can use `agentProviderLabel` for a stronger fallback.
 */
export function agentProviderLabel(provider: AgentProvider | undefined): string | null {
  if (!provider) return null;
  if (isAcpAgentProvider(provider)) return provider === 'cursor' ? 'Cursor' : 'Devin';
  return 'Codex';
}

/**
 * Display label for the agent that produced an event — prefers the stamped
 * `agentLabel`, then the session provider, then a generic 'Agent'.
 */
export function agentEventLabel(
  event: Pick<CodexEvent, 'agentLabel'>,
  provider?: AgentProvider,
): string {
  return event.agentLabel ?? agentProviderLabel(provider) ?? 'Agent';
}
