// MCP JSON-RPC handling for the local endpoint (spec §6.1). Transport-free:
// the HTTP server authenticates, resolves the session context and hands the
// parsed payload here.

import {
  callAgentTool,
  listAgentTools,
  type AgentToolCallResult,
  type AgentToolDefinition,
  type AgentToolSessionContext,
} from '../../agent-tools/dispatch.js';

export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: AgentToolDefinition['inputSchema'];
  annotations: { title?: string; readOnlyHint: boolean; destructiveHint?: boolean };
}

export interface McpProtocolOptions {
  serverVersion: string;
  instructions?: (ctx: AgentToolSessionContext) => string;
  onToolCall?: (ctx: AgentToolSessionContext, name: string, ok: boolean) => void;
}

export interface McpPayloadOutcome {
  /** Undefined when the payload held only notifications/responses (HTTP 202). */
  body?: JsonRpcResponse | JsonRpcResponse[];
  initialized: boolean;
}

export const JSON_RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' &&
    (SUPPORTED_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : SUPPORTED_MCP_PROTOCOL_VERSIONS[0];
}

export function toMcpTool(tool: AgentToolDefinition): McpTool {
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      ...(tool.title ? { title: tool.title } : {}),
      readOnlyHint: !tool.mutation,
      ...(tool.mutation ? { destructiveHint: true } : {}),
    },
  };
}

export function jsonRpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function callTool(
  ctx: AgentToolSessionContext,
  params: Record<string, unknown>,
  options: McpProtocolOptions,
): Promise<AgentToolCallResult> {
  const name = params.name as string;
  const args = isRecord(params.arguments) ? params.arguments : {};
  try {
    const result = await callAgentTool(ctx, name, args);
    options.onToolCall?.(ctx, name, !result.isError);
    return result;
  } catch (error) {
    options.onToolCall?.(ctx, name, false);
    return { content: [{ type: 'text', text: errorMessage(error) }], isError: true };
  }
}

async function handleRequest(
  ctx: AgentToolSessionContext,
  id: string | number,
  method: string,
  params: Record<string, unknown>,
  options: McpProtocolOptions,
): Promise<JsonRpcResponse> {
  switch (method) {
    case 'initialize': {
      const instructions = options.instructions?.(ctx)?.trim();
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiateProtocolVersion(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'anvil', title: 'Anvil', version: options.serverVersion },
          ...(instructions ? { instructions } : {}),
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: listAgentTools(ctx).map(toMcpTool) } };
    case 'tools/call': {
      if (typeof params.name !== 'string' || !params.name) {
        return jsonRpcError(id, JSON_RPC.invalidParams, 'Tool name is required.');
      }
      if (params.arguments !== undefined && !isRecord(params.arguments)) {
        return jsonRpcError(id, JSON_RPC.invalidParams, 'Tool arguments must be an object.');
      }
      if (!listAgentTools(ctx).some((tool) => tool.name === params.name)) {
        return jsonRpcError(id, JSON_RPC.invalidParams, `Unknown tool: ${params.name}`);
      }
      return { jsonrpc: '2.0', id, result: await callTool(ctx, params, options) };
    }
    default:
      return jsonRpcError(id, JSON_RPC.methodNotFound, `Method not found: ${method}`);
  }
}

async function handleMessage(
  ctx: AgentToolSessionContext,
  message: unknown,
  options: McpProtocolOptions,
): Promise<{ response?: JsonRpcResponse; initialized: boolean }> {
  if (!isRecord(message) || message.jsonrpc !== '2.0') {
    const id = isRecord(message) && isId(message.id) ? message.id : null;
    return {
      response: jsonRpcError(id, JSON_RPC.invalidRequest, 'Invalid request'),
      initialized: false,
    };
  }
  const { id, method } = message;
  // Responses to server requests (we send none) and notifications get no reply.
  if (typeof method !== 'string') return { initialized: false };
  if (id === undefined) return { initialized: false };
  if (!isId(id)) {
    return {
      response: jsonRpcError(null, JSON_RPC.invalidRequest, 'Invalid request id'),
      initialized: false,
    };
  }
  if (message.params !== undefined && !isRecord(message.params)) {
    return {
      response: jsonRpcError(id, JSON_RPC.invalidParams, 'Params must be an object.'),
      initialized: false,
    };
  }
  try {
    const response = await handleRequest(ctx, id, method, message.params ?? {}, options);
    return { response, initialized: method === 'initialize' && !response.error };
  } catch (error) {
    return {
      response: jsonRpcError(id, JSON_RPC.internalError, errorMessage(error)),
      initialized: false,
    };
  }
}

/** Handle a parsed JSON-RPC payload (single message or batch). */
export async function handleMcpPayload(
  ctx: AgentToolSessionContext,
  payload: unknown,
  options: McpProtocolOptions,
): Promise<McpPayloadOutcome> {
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return {
        body: jsonRpcError(null, JSON_RPC.invalidRequest, 'Empty batch'),
        initialized: false,
      };
    }
    const outcomes = await Promise.all(
      payload.map((message) => handleMessage(ctx, message, options)),
    );
    const responses = outcomes.flatMap((outcome) => (outcome.response ? [outcome.response] : []));
    return {
      body: responses.length > 0 ? responses : undefined,
      initialized: outcomes.some((outcome) => outcome.initialized),
    };
  }
  const outcome = await handleMessage(ctx, payload, options);
  return { body: outcome.response, initialized: outcome.initialized };
}
