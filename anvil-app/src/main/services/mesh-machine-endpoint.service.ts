import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BrowserWorkspaceResultEnvelope } from '../../../cloud/contract/browser-workspace.js';

export const MESH_MACHINE_ENDPOINT_PROTOCOL_VERSION = 1 as const;
export const MESH_MACHINE_ENDPOINT_FLAG = 'ANVIL_MESH_MACHINE_ENDPOINTS';
export const MESH_MACHINE_ENDPOINT_CAPABILITIES = ['dashboard.command.wake/1'] as const;

export type MachineCommandDispatchState = 'completed' | 'failed' | 'uncertain' | 'processing';

export interface MachineCommandDispatchEntry {
  commandId: string;
  state: MachineCommandDispatchState;
  result?: BrowserWorkspaceResultEnvelope;
}

export interface MachineCommandDispatchResult {
  state: 'dispatched' | 'processing' | 'not-ready';
  commands: MachineCommandDispatchEntry[];
}

export interface MeshMachineEndpointOptions {
  enabled: boolean;
  machineId: string;
  originForGrant: (requestId: string) => string | null | Promise<string | null>;
  /** The companion caller must already have passed bearer and tier authorization. */
  dispatchGrantCommands: (requestId: string) => Promise<MachineCommandDispatchResult>;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const INFO_ROUTE = /^\/api\/machine\/v1\/grants\/([A-Za-z0-9_-]{1,128})\/info$/;
const DISPATCH_ROUTE =
  /^\/api\/machine\/v1\/machines\/([A-Za-z0-9_-]{1,128})\/grants\/([A-Za-z0-9_-]{1,128})\/commands\/dispatch$/;

export function isMeshMachineEndpointEnabled(
  value: string | undefined = process.env[MESH_MACHINE_ENDPOINT_FLAG],
): boolean {
  return value === 'true';
}

/**
 * Handles the narrow browser-workspace machine routes. The caller remains
 * responsible for registering these routes on the existing companion server.
 */
export async function handleMeshMachineEndpointRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: MeshMachineEndpointOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const info = INFO_ROUTE.exec(url.pathname);
  const dispatch = DISPATCH_ROUTE.exec(url.pathname);
  if (!info && !dispatch) return false;

  if (!options.enabled) {
    sendJson(res, 404, { error: 'Machine endpoint not found.' });
    return true;
  }

  if (url.search || !SAFE_ID.test(options.machineId)) {
    sendJson(res, 400, { error: 'Machine endpoint request is invalid.' });
    return true;
  }

  const machineId = dispatch?.[1] ?? options.machineId;
  const requestId = info?.[1] ?? dispatch?.[2];
  if (machineId !== options.machineId || !requestId) {
    sendJson(res, 404, { error: 'Machine endpoint not found.' });
    return true;
  }

  if (!isLocalAuthority(req)) {
    sendJson(res, 421, { error: 'Machine endpoint authority is invalid.' });
    return true;
  }

  const approvedOrigin = await options.originForGrant(requestId);
  const origin = req.headers.origin;
  if (approvedOrigin === null || (origin !== undefined && origin !== approvedOrigin)) {
    sendJson(res, 403, { error: 'Machine endpoint grant is not available to this caller.' });
    return true;
  }

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (info) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed.' });
      return true;
    }
    sendJson(res, 200, {
      machineId: options.machineId,
      protocolVersion: MESH_MACHINE_ENDPOINT_PROTOCOL_VERSION,
      capabilities: MESH_MACHINE_ENDPOINT_CAPABILITIES,
    });
    return true;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return true;
  }
  if (hasRequestBody(req)) {
    sendJson(res, 400, { error: 'Machine dispatch accepts no request body.' });
    return true;
  }

  const outcome = await options.dispatchGrantCommands(requestId);
  const statusCode = outcome.state === 'dispatched' ? 200 : 202;
  sendJson(res, statusCode, {
    machineId: options.machineId,
    protocolVersion: MESH_MACHINE_ENDPOINT_PROTOCOL_VERSION,
    state: outcome.state,
    commands: outcome.commands,
  });
  return true;
}

function isLocalAuthority(req: IncomingMessage): boolean {
  if (
    req.headers.forwarded !== undefined ||
    req.headers['x-forwarded-host'] !== undefined ||
    req.headers['x-forwarded-proto'] !== undefined ||
    req.headers['x-real-ip'] !== undefined
  ) {
    return false;
  }

  const authority = req.headers.host;
  if (!authority || req.socket.localPort === undefined) return false;
  try {
    const parsed = new URL(`http://${authority}`);
    if (
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      Number(parsed.port) !== req.socket.localPort
    ) {
      return false;
    }
    const host = normalizeAddress(parsed.hostname);
    const local = normalizeAddress(req.socket.localAddress ?? '');
    return (
      host === local ||
      (host === 'localhost' && isLoopback(local) && isLoopback(req.socket.remoteAddress))
    );
  } catch {
    return false;
  }
}

function normalizeAddress(address: string): string {
  return address
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/^::ffff:/, '');
}

function isLoopback(address: string | undefined): boolean {
  const normalized = normalizeAddress(address ?? '');
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
}

function hasRequestBody(req: IncomingMessage): boolean {
  const contentLength = req.headers['content-length'];
  return (
    req.headers['transfer-encoding'] !== undefined ||
    (typeof contentLength === 'string' && contentLength !== '0')
  );
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
