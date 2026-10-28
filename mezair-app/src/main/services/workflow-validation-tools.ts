import type { AgentToolSessionContext } from '../agent-tools/dispatch.js';
import { MEZAIR_MCP_TOKEN_ENV, buildCodexMcpArgs } from './agent-mcp/injection.js';
import {
  awaitAgentMcpEndpoint,
  mintAgentMcpToken,
  revokeAgentMcpToken,
} from './agent-mcp/registry.js';

/** Workflow workers can validate their retained checkout without exposing unrelated repo tools. */
export async function openWorkflowValidationTools(
  sessionId: string,
  resolveContext: () => AgentToolSessionContext | undefined,
): Promise<{ args: string[]; env: Record<string, string>; close: () => void }> {
  const endpoint = await awaitAgentMcpEndpoint();
  if (!endpoint) return { args: [], env: {}, close: () => undefined };
  const token = mintAgentMcpToken(sessionId, () => {
    const context = resolveContext();
    return context
      ? {
          ...context,
          allowedToolNames: [
            'validation_context',
            'validation_publish',
            'validation_run',
            'validation_record',
            'surface_read',
            'question_ask',
          ],
        }
      : undefined;
  });
  return {
    args: buildCodexMcpArgs({ url: endpoint.url }),
    env: { [MEZAIR_MCP_TOKEN_ENV]: token },
    close: () => revokeAgentMcpToken(sessionId),
  };
}
