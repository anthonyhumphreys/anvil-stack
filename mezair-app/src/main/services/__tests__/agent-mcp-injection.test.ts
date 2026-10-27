import { describe, expect, it } from 'vitest';
import {
  buildAcpMcpServers,
  buildCodexMcpArgs,
  readAcpMcpCapabilities,
} from '../agent-mcp/injection';

const url = 'http://127.0.0.1:43123/mcp';

describe('Codex MCP spawn args', () => {
  it('adds the mezair server by url and bearer env var, never the token', () => {
    const args = buildCodexMcpArgs({ url });
    expect(args).toEqual([
      '-c',
      'mcp_servers.mezair.url="http://127.0.0.1:43123/mcp"',
      '-c',
      'mcp_servers.mezair.bearer_token_env_var="MEZAIR_MCP_TOKEN"',
      '-c',
      'mcp_servers.mezair.tool_timeout_sec=660',
    ]);
  });

  it('keeps temporary chats MCP-free and adds nothing without an endpoint', () => {
    expect(buildCodexMcpArgs({ temporaryChat: true, url })).toEqual(['-c', 'mcp_servers={}']);
    expect(buildCodexMcpArgs({})).toEqual([]);
  });
});

describe('ACP mcpServers', () => {
  it('reads advertised mcpCapabilities defensively', () => {
    expect(readAcpMcpCapabilities({ mcpCapabilities: { http: true, sse: true } })).toEqual({
      http: true,
      sse: true,
    });
    expect(readAcpMcpCapabilities({ loadSession: true })).toEqual({ http: false, sse: false });
    expect(readAcpMcpCapabilities(undefined)).toEqual({ http: false, sse: false });
  });

  it('uses the http transport with an Authorization header when advertised', () => {
    expect(
      buildAcpMcpServers({
        url,
        token: 'tok',
        capabilities: { http: true, sse: false },
        shimPath: '/app/scripts/mezair-mcp-shim.mjs',
        execPath: '/Applications/Mezair.app/Contents/MacOS/Mezair',
      }),
    ).toEqual([
      {
        type: 'http',
        name: 'mezair',
        url,
        headers: [{ name: 'Authorization', value: 'Bearer tok' }],
      },
    ]);
  });

  it('falls back to the stdio shim run as node by the Electron binary', () => {
    expect(
      buildAcpMcpServers({
        url,
        token: 'tok',
        capabilities: { http: false, sse: false },
        shimPath: '/app/scripts/mezair-mcp-shim.mjs',
        execPath: '/electron',
      }),
    ).toEqual([
      {
        name: 'mezair',
        command: '/electron',
        args: ['/app/scripts/mezair-mcp-shim.mjs'],
        env: [
          { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
          { name: 'MEZAIR_MCP_URL', value: url },
          { name: 'MEZAIR_MCP_TOKEN', value: 'tok' },
        ],
      },
    ]);
  });

  it('attaches nothing without an endpoint, a token, or (for stdio) a shim', () => {
    expect(buildAcpMcpServers({ token: 'tok', execPath: '/e' })).toEqual([]);
    expect(
      buildAcpMcpServers({ url, execPath: '/e', capabilities: { http: true, sse: false } }),
    ).toEqual([]);
    expect(buildAcpMcpServers({ url, token: 'tok', execPath: '/e' })).toEqual([]);
  });
});
