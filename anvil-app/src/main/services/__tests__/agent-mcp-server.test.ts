import { request } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentToolError,
  registerAgentToolProvider,
  resetAgentToolProvidersForTests,
  textResult,
  type AgentToolDefinition,
  type AgentToolSessionContext,
} from '../../agent-tools/dispatch';
import {
  getAgentMcpTokenForSession,
  listAgentMcpSessions,
  mintAgentMcpToken,
  recordAgentMcpToolCall,
  resetAgentMcpRegistryForTests,
  resolveAgentMcpToken,
  revokeAgentMcpToken,
} from '../agent-mcp/registry';
import { negotiateProtocolVersion, toMcpTool } from '../agent-mcp/protocol';
import {
  isAllowedLoopbackRequest,
  startAgentMcpServer,
  type AgentMcpServer,
} from '../agent-mcp/server';

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  text: string;
}

function http(
  server: AgentMcpServer,
  options: {
    method?: string;
    token?: string | null;
    body?: unknown;
    raw?: string;
    headers?: Record<string, string>;
    path?: string;
  } = {},
): Promise<HttpResult> {
  const payload = options.raw ?? (options.body === undefined ? '' : JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: options.path ?? '/mcp',
        method: options.method ?? 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown;
          try {
            body = text ? JSON.parse(text) : undefined;
          } catch {
            body = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const rpc = (id: number | string, method: string, params?: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params ? { params } : {}),
});

const live: { ctx: AgentToolSessionContext } = {
  ctx: {
    sessionId: 'session-1',
    appThreadId: 'thread-1',
    workspaceId: 'ws-1',
    repoIds: ['repo-1'],
    provider: 'codex',
    mode: 'on-request',
    features: ['chat', 'codereview'],
  },
};

let server: AgentMcpServer;
let token: string;
const toolCalls: Array<{ name: string; ok: boolean }> = [];

beforeAll(async () => {
  server = await startAgentMcpServer({
    serverVersion: '9.9.9',
    instructions: (ctx) => `guide for ${ctx.provider}`,
    resolveToken: resolveAgentMcpToken,
    onToolCall: (ctx, name, ok) => {
      toolCalls.push({ name, ok });
      recordAgentMcpToolCall(ctx.sessionId, ok);
    },
    maxBodyBytes: 64 * 1024,
  });
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  resetAgentToolProvidersForTests();
  resetAgentMcpRegistryForTests();
  toolCalls.length = 0;
  live.ctx = { ...live.ctx, mode: 'on-request', features: ['chat', 'codereview'] };
  token = mintAgentMcpToken('session-1', () => live.ctx);
  registerAgentToolProvider({
    id: 'test',
    tools: (): AgentToolDefinition[] => [
      {
        name: 'review_read',
        title: 'Read review',
        description: 'Read a review',
        inputSchema: { type: 'object', properties: { repoId: { type: 'string' } } },
      },
      {
        name: 'review_publish',
        description: 'Publish a review',
        inputSchema: { type: 'object', properties: {} },
        mutation: true,
      },
      {
        name: 'browser_only',
        description: 'Needs the browser feature',
        inputSchema: { type: 'object', properties: {} },
        feature: 'browser',
      },
      {
        name: 'explodes',
        description: 'Throws',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'forbidden_repo',
        description: 'Rejects repo',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    async call(ctx, name, args) {
      if (name === 'review_read')
        return textResult(`read ${String(args.repoId)} in ${ctx.workspaceId}`);
      if (name === 'review_publish') return textResult('published', { surfaceId: 's-1' });
      if (name === 'explodes') throw new Error('kaboom');
      if (name === 'forbidden_repo') {
        throw new AgentToolError(
          'Repository is outside this session’s workspace scope.',
          'forbidden',
        );
      }
      return undefined;
    },
  });
});

describe('agent MCP endpoint: auth and transport guards', () => {
  it('binds to loopback and exposes the /mcp URL', () => {
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/mcp`);
  });

  it('rejects requests without a token, with an unknown token, or after revocation', async () => {
    expect((await http(server, { body: rpc(1, 'ping') })).status).toBe(401);
    const unknown = await http(server, { token: 'not-a-token', body: rpc(1, 'ping') });
    expect(unknown.status).toBe(401);
    expect(unknown.headers['www-authenticate']).toContain('Bearer');
    expect((await http(server, { token, body: rpc(1, 'ping') })).status).toBe(200);
    revokeAgentMcpToken('session-1');
    expect((await http(server, { token, body: rpc(1, 'ping') })).status).toBe(401);
  });

  it('rejects a token whose session context no longer resolves', async () => {
    const ended = mintAgentMcpToken('ended', () => undefined);
    expect((await http(server, { token: ended, body: rpc(1, 'ping') })).status).toBe(401);
  });

  it('rejects non-loopback Host and Origin headers (DNS rebinding)', async () => {
    const badHost = await http(server, {
      token,
      body: rpc(1, 'ping'),
      headers: { Host: `evil.example:${server.port}` },
    });
    expect(badHost.status).toBe(403);
    const badOrigin = await http(server, {
      token,
      body: rpc(1, 'ping'),
      headers: { Origin: 'https://evil.example' },
    });
    expect(badOrigin.status).toBe(403);
    const localhost = await http(server, {
      token,
      body: rpc(1, 'ping'),
      headers: { Host: `localhost:${server.port}`, Origin: `http://localhost:${server.port}` },
    });
    expect(localhost.status).toBe(200);
  });

  it('validates loopback headers as a pure function', () => {
    expect(isAllowedLoopbackRequest({ host: '127.0.0.1:5' }, 5)).toBe(true);
    expect(isAllowedLoopbackRequest({ host: '127.0.0.1:6' }, 5)).toBe(false);
    expect(isAllowedLoopbackRequest({ host: '127.0.0.1:5', origin: 'null' }, 5)).toBe(false);
    expect(isAllowedLoopbackRequest({ host: 'localhost:5', origin: 'http://[::1]:9' }, 5)).toBe(
      true,
    );
  });

  it('answers GET with 405, unknown paths with 404, and caps the body size', async () => {
    expect((await http(server, { token, method: 'GET' })).status).toBe(405);
    expect((await http(server, { token, path: '/other', body: rpc(1, 'ping') })).status).toBe(404);
    const huge = await http(server, { token, raw: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }) });
    expect(huge.status).toBe(413);
  });

  it('returns a JSON-RPC parse error for malformed JSON', async () => {
    const result = await http(server, { token, raw: '{not json' });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: -32700 } });
  });
});

describe('agent MCP endpoint: protocol', () => {
  it('initializes with negotiated version, server info, instructions and a session id', async () => {
    const result = await http(server, {
      token,
      body: rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {} }),
    });
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toContain('application/json');
    expect(result.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'anvil', title: 'Anvil', version: '9.9.9' },
        instructions: 'guide for codex',
      },
    });
    const sessionId = result.headers['mcp-session-id'];
    expect(typeof sessionId).toBe('string');

    // The issued session id is accepted, unknown ids are 404, DELETE ends it.
    const headers = { 'Mcp-Session-Id': sessionId as string };
    expect((await http(server, { token, body: rpc(2, 'ping'), headers })).status).toBe(200);
    const unknown = { 'Mcp-Session-Id': 'nope' };
    expect((await http(server, { token, body: rpc(3, 'ping'), headers: unknown })).status).toBe(
      404,
    );
    expect((await http(server, { token, method: 'DELETE', headers })).status).toBe(200);
    expect((await http(server, { token, body: rpc(4, 'ping'), headers })).status).toBe(404);
    expect((await http(server, { token, method: 'DELETE' })).status).toBe(405);
  });

  it('does not let another session reuse an MCP session id', async () => {
    const init = await http(server, { token, body: rpc(1, 'initialize', {}) });
    const other = mintAgentMcpToken('session-2', () => ({ ...live.ctx, sessionId: 'session-2' }));
    const result = await http(server, {
      token: other,
      body: rpc(2, 'ping'),
      headers: { 'Mcp-Session-Id': init.headers['mcp-session-id'] as string },
    });
    expect(result.status).toBe(404);
  });

  it('negotiates unknown protocol versions to the latest supported', () => {
    expect(negotiateProtocolVersion('1999-01-01')).toBe('2025-06-18');
    expect(negotiateProtocolVersion('2024-11-05')).toBe('2024-11-05');
    expect(negotiateProtocolVersion(undefined)).toBe('2025-06-18');
  });

  it('accepts notifications and client responses with 202 and no body', async () => {
    const notification = await http(server, {
      token,
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(notification.status).toBe(202);
    expect(notification.text).toBe('');
    const response = await http(server, { token, body: { jsonrpc: '2.0', id: 9, result: {} } });
    expect(response.status).toBe(202);
  });

  it('handles batches, omitting notifications from the response array', async () => {
    const result = await http(server, {
      token,
      body: [
        rpc(1, 'ping'),
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        rpc(2, 'nope'),
      ],
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Method not found: nope' } },
    ]);
    const empty = await http(server, { token, body: [] });
    expect(empty.body).toMatchObject({ error: { code: -32600 } });
  });

  it('lists tools with MCP annotations, filtered by role features', async () => {
    const result = await http(server, { token, body: rpc(1, 'tools/list') });
    const tools = (result.body as { result: { tools: Array<Record<string, unknown>> } }).result
      .tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      'review_read',
      'review_publish',
      'explodes',
      'forbidden_repo',
    ]);
    expect(tools[0]).toEqual({
      name: 'review_read',
      title: 'Read review',
      description: 'Read a review',
      inputSchema: { type: 'object', properties: { repoId: { type: 'string' } } },
      annotations: { title: 'Read review', readOnlyHint: true },
    });
    expect(tools[1].annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
  });

  it('resolves context live: a read-only switch hides mutation tools on the next request', async () => {
    live.ctx = { ...live.ctx, mode: 'read-only', features: [...live.ctx.features, 'browser'] };
    const result = await http(server, { token, body: rpc(1, 'tools/list') });
    const names = (result.body as { result: { tools: Array<{ name: string }> } }).result.tools.map(
      (tool) => tool.name,
    );
    expect(names).toContain('browser_only');
    expect(names).not.toContain('review_publish');
    const call = await http(server, {
      token,
      body: rpc(2, 'tools/call', { name: 'review_publish', arguments: {} }),
    });
    expect(call.body).toMatchObject({ error: { code: -32602 } });
  });

  it('calls tools with the session context and returns structured content', async () => {
    const read = await http(server, {
      token,
      body: rpc(1, 'tools/call', { name: 'review_read', arguments: { repoId: 'repo-1' } }),
    });
    expect(read.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'read repo-1 in ws-1' }] },
    });
    const publish = await http(server, {
      token,
      body: rpc(2, 'tools/call', { name: 'review_publish' }),
    });
    expect(publish.body).toMatchObject({ result: { structuredContent: { surfaceId: 's-1' } } });
  });

  it('turns tool errors into isError results and unknown tools into -32602', async () => {
    const thrown = await http(server, {
      token,
      body: rpc(1, 'tools/call', { name: 'explodes', arguments: {} }),
    });
    expect(thrown.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'kaboom' }], isError: true },
    });
    const forbidden = await http(server, {
      token,
      body: rpc(2, 'tools/call', { name: 'forbidden_repo', arguments: {} }),
    });
    expect(forbidden.body).toMatchObject({ result: { isError: true } });
    const unknown = await http(server, {
      token,
      body: rpc(3, 'tools/call', { name: 'does_not_exist', arguments: {} }),
    });
    expect(unknown.body).toMatchObject({
      error: { code: -32602, message: 'Unknown tool: does_not_exist' },
    });
    const badArgs = await http(server, {
      token,
      body: rpc(4, 'tools/call', { name: 'review_read', arguments: [] }),
    });
    expect(badArgs.body).toMatchObject({ error: { code: -32602 } });
    expect(toolCalls).toEqual([
      { name: 'explodes', ok: false },
      { name: 'forbidden_repo', ok: false },
    ]);
    expect(listAgentMcpSessions()).toEqual([
      expect.objectContaining({ sessionId: 'session-1', toolCalls: 2, toolErrors: 2 }),
    ]);
  });

  it('rejects invalid JSON-RPC envelopes', async () => {
    const result = await http(server, { token, body: { id: 1, method: 'ping' } });
    expect(result.body).toMatchObject({ id: 1, error: { code: -32600 } });
    const badParams = await http(server, {
      token,
      body: { jsonrpc: '2.0', id: 2, method: 'ping', params: [1] },
    });
    expect(badParams.body).toMatchObject({ id: 2, error: { code: -32602 } });
  });
});

describe('agent MCP token registry', () => {
  it('mints distinct 32-byte tokens and replaces a session token on re-mint', () => {
    const first = getAgentMcpTokenForSession('session-1');
    const second = mintAgentMcpToken('session-1', () => live.ctx);
    expect(second).not.toBe(first);
    expect(Buffer.from(second, 'base64url')).toHaveLength(32);
    expect(resolveAgentMcpToken(first!)).toBeUndefined();
    expect(resolveAgentMcpToken(second)?.sessionId).toBe('session-1');
    expect(resolveAgentMcpToken('')).toBeUndefined();
  });

  it('maps tool definitions without leaking internal fields', () => {
    expect(
      toMcpTool({
        name: 'x',
        description: 'd',
        inputSchema: { type: 'object' },
        feature: 'chat',
        requiresThread: false,
      }),
    ).toEqual({
      name: 'x',
      description: 'd',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
    });
  });
});
