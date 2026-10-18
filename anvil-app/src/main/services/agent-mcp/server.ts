// Streamable HTTP MCP endpoint on loopback (spec §6.1). JSON responses only;
// no SSE stream (GET is 405), which the transport spec permits.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { callAgentTool, type AgentToolSessionContext } from '../../agent-tools/dispatch.js';
import { handleMcpPayload, jsonRpcError, JSON_RPC, type McpProtocolOptions } from './protocol.js';

export const AGENT_MCP_PATH = '/mcp';
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_MCP_SESSIONS = 1024;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface AgentMcpServerOptions extends McpProtocolOptions {
  resolveToken(token: string): { sessionId: string; context: AgentToolSessionContext } | undefined;
  maxBodyBytes?: number;
}

export interface AgentMcpServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): void {
  if (body === undefined) {
    res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(payload)),
    ...headers,
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  send(
    res,
    status,
    jsonRpcError(null, status === 413 ? JSON_RPC.invalidRequest : -32000, message),
    status === 413 ? { Connection: 'close' } : {},
  );
}

/** DNS-rebinding defence: Host must be the loopback port; Origin, when present, loopback too. */
export function isAllowedLoopbackRequest(
  headers: IncomingMessage['headers'],
  port: number,
): boolean {
  const host = headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      LOOPBACK_HOSTNAMES.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function readBearerToken(headers: IncomingMessage['headers']): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(headers.authorization ?? '');
  return match?.[1];
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return Promise.reject(new HttpError(413, 'Request body too large'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'Request body too large'));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
    req.on('aborted', () => reject(new HttpError(400, 'Request aborted')));
  });
}

export function startAgentMcpServer(options: AgentMcpServerOptions): Promise<AgentMcpServer> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  /** Mcp-Session-Id → owning agent session. */
  const mcpSessions = new Map<string, string>();
  const activeCalls = new Map<
    string,
    { sessionId: string; mcpSessionId?: string; abort: AbortController }
  >();
  let port = 0;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAllowedLoopbackRequest(req.headers, port)) {
      sendError(res, 403, 'Forbidden');
      return;
    }
    const token = readBearerToken(req.headers);
    const auth = token ? options.resolveToken(token) : undefined;
    if (!auth) {
      send(res, 401, jsonRpcError(null, -32001, 'Unauthorized'), {
        'WWW-Authenticate': 'Bearer realm="anvil"',
      });
      return;
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== AGENT_MCP_PATH) {
      sendError(res, 404, 'Not found');
      return;
    }
    const headerSessionId = req.headers['mcp-session-id'];
    const mcpSessionId = typeof headerSessionId === 'string' ? headerSessionId : undefined;
    if (mcpSessionId !== undefined && mcpSessions.get(mcpSessionId) !== auth.sessionId) {
      sendError(res, 404, 'Unknown MCP session');
      return;
    }

    if (req.method === 'DELETE') {
      if (!mcpSessionId) {
        send(res, 405, undefined, { Allow: 'POST, DELETE' });
        return;
      }
      mcpSessions.delete(mcpSessionId);
      for (const call of activeCalls.values()) {
        if (call.sessionId === auth.sessionId && call.mcpSessionId === mcpSessionId)
          call.abort.abort();
      }
      send(res, 200);
      return;
    }
    if (req.method !== 'POST') {
      send(res, 405, undefined, { Allow: 'POST, DELETE' });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(req, maxBodyBytes));
    } catch (error) {
      if (error instanceof HttpError) {
        sendError(res, error.status, error.message);
        return;
      }
      send(res, 400, jsonRpcError(null, JSON_RPC.parseError, 'Parse error'));
      return;
    }

    const keyFor = (id: string | number) =>
      JSON.stringify([auth.sessionId, mcpSessionId ?? '', id]);
    const outcome = await handleMcpPayload(auth.context, payload, {
      ...options,
      onCancelRequest: (id) => activeCalls.get(keyFor(id))?.abort.abort(),
      runTool: async (ctx, id, name, args) => {
        const key = keyFor(id);
        if (activeCalls.has(key))
          throw new Error('A tool call with this request ID is already active.');
        const abort = new AbortController();
        const onClose = () => {
          if (!res.writableEnded) abort.abort();
        };
        activeCalls.set(key, { sessionId: auth.sessionId, mcpSessionId, abort });
        res.once('close', onClose);
        if (res.destroyed) abort.abort();
        try {
          return await callAgentTool(ctx, name, args, abort.signal);
        } finally {
          res.off('close', onClose);
          activeCalls.delete(key);
        }
      },
    });
    if (res.destroyed) return;
    const headers: Record<string, string> = {};
    if (outcome.initialized) {
      const id = randomUUID();
      if (mcpSessions.size >= MAX_MCP_SESSIONS) {
        const oldest = mcpSessions.keys().next().value;
        if (oldest !== undefined) mcpSessions.delete(oldest);
      }
      mcpSessions.set(id, auth.sessionId);
      headers['Mcp-Session-Id'] = id;
    }
    if (outcome.body === undefined) send(res, 202, undefined, headers);
    else send(res, 200, outcome.body, headers);
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) sendError(res, 500, 'Internal error');
        else res.end();
      });
    });
    server.requestTimeout = 120_000;
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to bind the Anvil MCP endpoint'));
        return;
      }
      port = address.port;
      server.off('error', reject);
      server.on('error', (error) => console.warn('[AgentMcp] server error:', error.message));
      server.unref();
      resolve({
        port,
        url: `http://127.0.0.1:${port}${AGENT_MCP_PATH}`,
        close: () =>
          new Promise<void>((done) => {
            for (const call of activeCalls.values()) call.abort.abort();
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
