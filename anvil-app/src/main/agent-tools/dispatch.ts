// Agent tool dispatch: the single entry point the local MCP endpoint calls.
// Tool groups (surface kinds, artifacts, sketches, domain tools) register a
// provider; the endpoint never imports them directly.
// Spec: docs/plans/inline-artifacts-and-canvas-tools.md §5–§6.

import type { AgentProvider, CodexMode, Feature } from '../../shared/types.js';
import type { JsonSchema } from '../../shared/surfaces/types.js';

/** Resolved from the per-session bearer token; never supplied by the agent. */
export interface AgentToolSessionContext {
  sessionId: string;
  appThreadId?: string;
  workspaceId?: string;
  repoIds: readonly string[];
  provider: AgentProvider;
  mode: CodexMode;
  features: readonly Feature[];
  /** Main-owned allowlist for narrowly scoped workers. Omitted for interactive chats. */
  allowedToolNames?: readonly string[];
}

export interface AgentToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  /** Mutating tools are hidden in read-only sessions and must route through approvals. */
  mutation?: boolean;
  /** Role gate via ROLE_FEATURES. */
  feature?: Feature;
  /** Needs a persisted (non-temporary) thread. Defaults to true. */
  requiresThread?: boolean;
}

export type AgentToolContent =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface AgentToolCallResult {
  content: AgentToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface AgentToolProvider {
  id: string;
  tools(ctx: AgentToolSessionContext): AgentToolDefinition[];
  /** Return undefined when the tool name is not owned by this provider. */
  call(
    ctx: AgentToolSessionContext,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AgentToolCallResult | undefined>;
}

export class AgentToolError extends Error {
  constructor(
    message: string,
    readonly code: 'not-found' | 'forbidden' | 'invalid-params' | 'conflict' | 'unavailable',
  ) {
    super(message);
    this.name = 'AgentToolError';
  }
}

const providers = new Map<string, AgentToolProvider>();

export function registerAgentToolProvider(provider: AgentToolProvider): () => void {
  providers.set(provider.id, provider);
  return () => {
    if (providers.get(provider.id) === provider) providers.delete(provider.id);
  };
}

function isAllowed(ctx: AgentToolSessionContext, tool: AgentToolDefinition): boolean {
  if (ctx.allowedToolNames && !ctx.allowedToolNames.includes(tool.name)) return false;
  if (tool.feature && !ctx.features.includes(tool.feature)) return false;
  if (tool.mutation && ctx.mode === 'read-only') return false;
  if ((tool.requiresThread ?? true) && !ctx.appThreadId) return false;
  return true;
}

export function listAgentTools(ctx: AgentToolSessionContext): AgentToolDefinition[] {
  const seen = new Set<string>();
  const tools: AgentToolDefinition[] = [];
  for (const provider of providers.values()) {
    for (const tool of provider.tools(ctx)) {
      if (seen.has(tool.name) || !isAllowed(ctx, tool)) continue;
      seen.add(tool.name);
      tools.push(tool);
    }
  }
  return tools;
}

export async function callAgentTool(
  ctx: AgentToolSessionContext,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AgentToolCallResult> {
  const tool = listAgentTools(ctx).find((candidate) => candidate.name === name);
  if (!tool) throw new AgentToolError(`Unknown or unavailable tool: ${name}`, 'not-found');
  for (const provider of providers.values()) {
    const result = await provider.call(ctx, name, args, signal);
    if (result) return result;
  }
  throw new AgentToolError(`No handler for tool: ${name}`, 'not-found');
}

/** Repo arguments must belong to the session; call this from every repo-scoped tool. */
export function assertRepoInScope(ctx: AgentToolSessionContext, repoId: unknown): string {
  if (typeof repoId !== 'string' || !ctx.repoIds.includes(repoId)) {
    throw new AgentToolError('Repository is outside this session’s workspace scope.', 'forbidden');
  }
  return repoId;
}

export function textResult(
  text: string,
  structuredContent?: Record<string, unknown>,
): AgentToolCallResult {
  return { content: [{ type: 'text', text }], ...(structuredContent ? { structuredContent } : {}) };
}

export function resetAgentToolProvidersForTests(): void {
  providers.clear();
}
