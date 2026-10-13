// Pure builders that connect each provider family to the local MCP endpoint
// (spec §6.2). The token never appears in process args.

export const ANVIL_MCP_SERVER_NAME = 'anvil';
export const ANVIL_MCP_TOKEN_ENV = 'ANVIL_MCP_TOKEN';
export const ANVIL_MCP_URL_ENV = 'ANVIL_MCP_URL';

/**
 * Codex app-server `-c` overrides. Temporary chats disable every MCP server;
 * otherwise the anvil server is added per spawn without touching config.toml.
 */
export function buildCodexMcpArgs(input: { temporaryChat?: boolean; url?: string }): string[] {
  if (input.temporaryChat) return ['-c', 'mcp_servers={}'];
  if (!input.url) return [];
  return [
    '-c',
    `mcp_servers.${ANVIL_MCP_SERVER_NAME}.url=${JSON.stringify(input.url)}`,
    '-c',
    `mcp_servers.${ANVIL_MCP_SERVER_NAME}.bearer_token_env_var="${ANVIL_MCP_TOKEN_ENV}"`,
  ];
}

export interface AcpMcpCapabilities {
  http: boolean;
  sse: boolean;
}

export function readAcpMcpCapabilities(agentCapabilities: unknown): AcpMcpCapabilities {
  const mcp =
    agentCapabilities && typeof agentCapabilities === 'object'
      ? (agentCapabilities as { mcpCapabilities?: unknown }).mcpCapabilities
      : undefined;
  const record = mcp && typeof mcp === 'object' ? (mcp as Record<string, unknown>) : {};
  return { http: record.http === true, sse: record.sse === true };
}

interface AcpNameValue {
  name: string;
  value: string;
}

export type AcpMcpServer =
  | { type: 'http'; name: string; url: string; headers: AcpNameValue[] }
  | { name: string; command: string; args: string[]; env: AcpNameValue[] };

/**
 * ACP `mcpServers` for session/new and session/load. HTTP when the agent
 * advertises it; otherwise the bundled stdio shim (stdio is mandatory in ACP v1).
 */
export function buildAcpMcpServers(input: {
  url?: string;
  token?: string;
  capabilities?: AcpMcpCapabilities;
  shimPath?: string;
  execPath: string;
}): AcpMcpServer[] {
  const { url, token } = input;
  if (!url || !token) return [];
  if (input.capabilities?.http) {
    return [
      {
        type: 'http',
        name: ANVIL_MCP_SERVER_NAME,
        url,
        headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
      },
    ];
  }
  if (!input.shimPath) return [];
  return [
    {
      name: ANVIL_MCP_SERVER_NAME,
      command: input.execPath,
      args: [input.shimPath],
      env: [
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
        { name: ANVIL_MCP_URL_ENV, value: url },
        { name: ANVIL_MCP_TOKEN_ENV, value: token },
      ],
    },
  ];
}
