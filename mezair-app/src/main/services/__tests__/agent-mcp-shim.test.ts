import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  registerAgentToolProvider,
  resetAgentToolProvidersForTests,
  textResult,
} from '../../agent-tools/dispatch';
import {
  mintAgentMcpToken,
  resetAgentMcpRegistryForTests,
  resolveAgentMcpToken,
} from '../agent-mcp/registry';
import { startAgentMcpServer, type AgentMcpServer } from '../agent-mcp/server';

const SHIM = path.resolve(__dirname, '../../../../scripts/mezair-mcp-shim.mjs');

let server: AgentMcpServer;
let token: string;

beforeAll(async () => {
  resetAgentToolProvidersForTests();
  resetAgentMcpRegistryForTests();
  registerAgentToolProvider({
    id: 'shim-test',
    tools: () => [
      { name: 'echo', description: 'Echo', inputSchema: { type: 'object' }, requiresThread: false },
    ],
    async call(_ctx, name, args) {
      return name === 'echo' ? textResult(`echo:${String(args.text)}`) : undefined;
    },
  });
  token = mintAgentMcpToken('shim-session', () => ({
    sessionId: 'shim-session',
    repoIds: [],
    provider: 'cursor',
    mode: 'on-request',
    features: [],
  }));
  server = await startAgentMcpServer({
    serverVersion: '1.0.0',
    resolveToken: (candidate) => resolveAgentMcpToken(candidate),
    onToolCall: () => undefined,
  });
});

afterAll(async () => {
  await server.close();
});

function runShim(
  lines: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SHIM], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(lines.map((line) => `${line}\n`).join(''));
  });
}

const parseLines = (stdout: string) =>
  stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('mezair-mcp-shim.mjs', () => {
  it('forwards stdio JSON-RPC to the endpoint and exits cleanly when stdin ends', async () => {
    const result = await runShim(
      [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'echo', arguments: { text: 'hi' } },
        }),
        'not json',
      ],
      { MEZAIR_MCP_URL: server.url, MEZAIR_MCP_TOKEN: token },
    );
    expect(result.code).toBe(0);
    const messages = parseLines(result.stdout);
    const byId = new Map(messages.map((message) => [message.id, message]));
    expect(byId.get(1)).toMatchObject({ result: { serverInfo: { name: 'mezair' } } });
    expect(byId.get(2)).toMatchObject({ result: { tools: [{ name: 'echo' }] } });
    expect(byId.get(3)).toMatchObject({ result: { content: [{ type: 'text', text: 'echo:hi' }] } });
    expect(byId.get(null)).toMatchObject({ error: { code: -32700 } });
    // The notification produced no output line.
    expect(messages).toHaveLength(4);
  });

  it('reports auth failures as JSON-RPC errors for pending requests', async () => {
    const result = await runShim([JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })], {
      MEZAIR_MCP_URL: server.url,
      MEZAIR_MCP_TOKEN: 'wrong',
    });
    expect(result.code).toBe(0);
    expect(parseLines(result.stdout)).toEqual([
      { jsonrpc: '2.0', id: 7, error: { code: -32000, message: 'Unauthorized' } },
    ]);
  });

  it('refuses to start without configuration or with a non-loopback URL', async () => {
    expect((await runShim([], {})).code).toBe(1);
    const remote = await runShim([], {
      MEZAIR_MCP_URL: 'http://example.com/mcp',
      MEZAIR_MCP_TOKEN: 't',
    });
    expect(remote.code).toBe(1);
  });
});
