// Anvil as a local MCP server (spec §6). Started at app launch; every
// non-temporary local agent session connects with its own bearer token.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { app } from 'electron';
import { registerAgentToolProvider } from '../../agent-tools/dispatch.js';
import { questionToolProvider } from '../../agent-tools/question-tools.js';
import { browserToolProvider } from '../../agent-tools/browser-tools.js';
import { buildSurfaceGuide } from '../../surfaces/guide.js';
import {
  getAgentMcpEndpoint,
  listAgentMcpSessions,
  recordAgentMcpToolCall,
  resolveAgentMcpToken,
  setAgentMcpEndpoint,
  setAgentMcpEndpointStartup,
  type AgentMcpEndpointState,
  type AgentMcpSessionStats,
} from './registry.js';
import { startAgentMcpServer, type AgentMcpServer } from './server.js';

let server: AgentMcpServer | undefined;
let startup: Promise<AgentMcpEndpointState | undefined> | undefined;
let unregisterQuestionTools: (() => void) | undefined;
let unregisterBrowserTools: (() => void) | undefined;
let lastError: string | undefined;

/** Mirrors browser.ipc.ts's chrome-mcp-server.mjs resolution (dev root or packaged app). */
export function resolveAnvilMcpShimPath(): string | undefined {
  const appPath = app.getAppPath();
  const candidates = [
    resolve(appPath, 'scripts/anvil-mcp-shim.mjs'),
    resolve(appPath, '..', 'scripts/anvil-mcp-shim.mjs'),
    resolve(__dirname, '../../scripts/anvil-mcp-shim.mjs'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export function startAgentMcpEndpoint(): Promise<AgentMcpEndpointState | undefined> {
  if (startup) return startup;
  unregisterQuestionTools ??= registerAgentToolProvider(questionToolProvider);
  unregisterBrowserTools ??= registerAgentToolProvider(browserToolProvider);
  startup = startAgentMcpServer({
    serverVersion: app.getVersion(),
    instructions: (ctx) => buildSurfaceGuide(ctx),
    resolveToken: resolveAgentMcpToken,
    onToolCall: (ctx, _name, ok) => recordAgentMcpToolCall(ctx.sessionId, ok),
  }).then(
    (started) => {
      server = started;
      lastError = undefined;
      let shimPath: string | undefined;
      try {
        shimPath = resolveAnvilMcpShimPath();
      } catch {
        shimPath = undefined;
      }
      const state: AgentMcpEndpointState = { url: started.url, port: started.port, shimPath };
      setAgentMcpEndpoint(state);
      console.log(`[AgentMcp] endpoint listening on 127.0.0.1:${started.port}`);
      return state;
    },
    (error: unknown) => {
      lastError = error instanceof Error ? error.message : String(error);
      console.warn(`[AgentMcp] endpoint failed to start: ${lastError}`);
      startup = undefined;
      setAgentMcpEndpointStartup(undefined);
      return undefined;
    },
  );
  setAgentMcpEndpointStartup(startup);
  return startup;
}

export async function stopAgentMcpEndpoint(): Promise<void> {
  const current = server;
  server = undefined;
  startup = undefined;
  setAgentMcpEndpoint(undefined);
  setAgentMcpEndpointStartup(undefined);
  unregisterQuestionTools?.();
  unregisterQuestionTools = undefined;
  unregisterBrowserTools?.();
  unregisterBrowserTools = undefined;
  await current?.close();
}

export interface AgentMcpStatus {
  running: boolean;
  port?: number;
  error?: string;
  sessions: AgentMcpSessionStats[];
}

/** Diagnostics view: never includes token values. */
export function getAgentMcpStatus(): AgentMcpStatus {
  const endpoint = getAgentMcpEndpoint();
  return {
    running: Boolean(endpoint),
    ...(endpoint ? { port: endpoint.port } : {}),
    ...(lastError ? { error: lastError } : {}),
    sessions: listAgentMcpSessions(),
  };
}
