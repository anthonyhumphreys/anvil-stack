// In-memory session token registry and endpoint state for the local MCP
// endpoint (spec §6.1). Electron-free so the session layer can import it.
// Tokens are never persisted or logged; lookups go through a SHA-256 digest.

import { createHash, randomBytes } from 'node:crypto';
import type { AgentToolSessionContext } from '../../agent-tools/dispatch.js';

export type AgentMcpContextResolver = () => AgentToolSessionContext | undefined;

interface TokenEntry {
  sessionId: string;
  token: string;
  resolveContext: AgentMcpContextResolver;
  createdAt: string;
  toolCalls: number;
  toolErrors: number;
}

export interface AgentMcpSessionStats {
  sessionId: string;
  createdAt: string;
  toolCalls: number;
  toolErrors: number;
}

export interface AgentMcpEndpointState {
  url: string;
  port: number;
  /** Absolute path to scripts/anvil-mcp-shim.mjs, when bundled. */
  shimPath?: string;
}

const byDigest = new Map<string, TokenEntry>();
const bySession = new Map<string, TokenEntry>();
let endpoint: AgentMcpEndpointState | undefined;
let endpointStartup: Promise<AgentMcpEndpointState | undefined> | undefined;

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Mint (or replace) the bearer token for one agent session. */
export function mintAgentMcpToken(
  sessionId: string,
  resolveContext: AgentMcpContextResolver,
): string {
  revokeAgentMcpToken(sessionId);
  const token = randomBytes(32).toString('base64url');
  const entry: TokenEntry = {
    sessionId,
    token,
    resolveContext,
    createdAt: new Date().toISOString(),
    toolCalls: 0,
    toolErrors: 0,
  };
  byDigest.set(digest(token), entry);
  bySession.set(sessionId, entry);
  return token;
}

export function revokeAgentMcpToken(sessionId: string): void {
  const entry = bySession.get(sessionId);
  if (!entry) return;
  bySession.delete(sessionId);
  byDigest.delete(digest(entry.token));
}

export function getAgentMcpTokenForSession(sessionId: string): string | undefined {
  return bySession.get(sessionId)?.token;
}

/** Resolve a bearer token to the live session context, or undefined when unknown/ended. */
export function resolveAgentMcpToken(
  token: string,
): { sessionId: string; context: AgentToolSessionContext } | undefined {
  const entry = token ? byDigest.get(digest(token)) : undefined;
  if (!entry) return undefined;
  const context = entry.resolveContext();
  return context ? { sessionId: entry.sessionId, context } : undefined;
}

export function recordAgentMcpToolCall(sessionId: string, ok: boolean): void {
  const entry = bySession.get(sessionId);
  if (!entry) return;
  entry.toolCalls += 1;
  if (!ok) entry.toolErrors += 1;
}

export function listAgentMcpSessions(): AgentMcpSessionStats[] {
  return [...bySession.values()].map(({ sessionId, createdAt, toolCalls, toolErrors }) => ({
    sessionId,
    createdAt,
    toolCalls,
    toolErrors,
  }));
}

export function setAgentMcpEndpoint(state: AgentMcpEndpointState | undefined): void {
  endpoint = state;
}

export function setAgentMcpEndpointStartup(
  startup: Promise<AgentMcpEndpointState | undefined> | undefined,
): void {
  endpointStartup = startup;
}

export function getAgentMcpEndpoint(): AgentMcpEndpointState | undefined {
  return endpoint;
}

/** Waits for an in-flight startup; never starts the endpoint itself. */
export async function awaitAgentMcpEndpoint(): Promise<AgentMcpEndpointState | undefined> {
  if (endpoint || !endpointStartup) return endpoint;
  try {
    return await endpointStartup;
  } catch {
    return undefined;
  }
}

export function resetAgentMcpRegistryForTests(): void {
  byDigest.clear();
  bySession.clear();
  endpoint = undefined;
  endpointStartup = undefined;
}
