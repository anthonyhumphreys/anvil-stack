import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  resolveBackendPaths,
  validateDescriptor,
  type BackendDescriptor,
  type DescriptorLimits,
} from '../../../cloud/contract/discovery.js';
import {
  DEFAULT_LIMITS,
  PROTOCOL,
  SOCKET_SUBPROTOCOL,
  type ContractLimits,
} from '../../../cloud/contract/version.js';
import type { SocketFrame, SocketFrameType } from '../../../cloud/contract/socket.js';

/**
 * Generic v1 backend connection client (BYOB-01).
 *
 * Discovery, RPC envelope transport, and the live socket for any compatible
 * backend described by `cloud/contract`. No Anvil-hosted assumptions: the
 * caller supplies the base URL (or pinned connection) and the device access
 * token. Tokens travel in the Authorization header, never in URLs.
 */

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
export const DEFAULT_DISCOVERY_MAX_BYTES = 64 * 1024;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

const KNOWN_SOCKET_FRAME_TYPES: ReadonlyArray<SocketFrameType> = [
  'hello',
  'subscribe',
  'unsubscribe',
  'sync.invalidate',
  'worker.available',
  'job.available',
  'activity',
  'gap',
  'auth.expiring',
  'error',
];
const KNOWN_SOCKET_FRAME_TYPE_SET: ReadonlySet<string> = new Set(KNOWN_SOCKET_FRAME_TYPES);

export interface DiscoverOptions {
  allowLoopbackHttp?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  /** Injected in tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
}

export interface BackendConnection {
  /** User-entered base normalized to a trailing slash. */
  baseUrl: string;
  apiUrl: string;
  socketUrl: string;
  descriptor: BackendDescriptor;
  /** Negotiated limits: the stricter of local defaults and descriptor limits. */
  limits: ContractLimits;
}

export interface RpcOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface RpcResult<R = unknown> {
  result: R;
  serverTime: string;
}

export class BackendRpcError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  /**
   * Backend-supplied error detail (e.g. `details.reason` on a 403 hosted
   * entitlement refusal). Untrusted input — kept as a plain record, never
   * interpolated into messages or URLs.
   */
  readonly details?: Record<string, unknown>;

  constructor(input: {
    code: string;
    retryable: boolean;
    retryAfterMs?: number;
    requestId?: string;
    message?: string;
    details?: Record<string, unknown>;
  }) {
    super(input.message ?? `backend RPC failed: ${input.code}`);
    this.name = 'BackendRpcError';
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
    this.requestId = input.requestId;
    this.details = input.details;
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower === '[::1]' ||
    /^127\./.test(lower)
  );
}

/** True when the user entered plain HTTP on a loopback host (explicit local-dev opt-in). */
export function shouldAllowLoopbackHttp(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl.trim());
    return url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Known public descriptor fields only. Discovery JSON is untrusted and may
 * include extra keys; those never cross into IPC or pinned storage.
 */
export function toPublicDescriptor(descriptor: BackendDescriptor): BackendDescriptor {
  return {
    descriptorVersion: descriptor.descriptorVersion,
    deploymentId: descriptor.deploymentId,
    displayName: descriptor.displayName,
    protocols: [...descriptor.protocols],
    profiles: [...descriptor.profiles],
    apiPath: descriptor.apiPath,
    socketPath: descriptor.socketPath,
    authModes: [...descriptor.authModes],
    auth: {
      issuer: descriptor.auth.issuer,
      publicClientId: descriptor.auth.publicClientId,
      scopes: [...descriptor.auth.scopes],
    },
    limits: {
      entityBytes: descriptor.limits.entityBytes,
      pageBytes: descriptor.limits.pageBytes,
      batchChanges: descriptor.limits.batchChanges,
      liveFrameBytes: descriptor.limits.liveFrameBytes,
    },
  };
}

/**
 * Trims the user-entered base, requires an absolute URL without embedded
 * credentials, gates plain HTTP to explicit loopback opt-in (mirroring
 * `resolveBackendPaths`), and normalizes to a trailing slash.
 */
export function normalizeBaseUrl(
  baseUrl: string,
  options: { allowLoopbackHttp?: boolean } = {},
): string {
  const trimmed = baseUrl.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('backend URL must be an absolute URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('backend URL must not embed credentials');
  }
  const secure = url.protocol === 'https:';
  const loopbackHttp =
    url.protocol === 'http:' &&
    options.allowLoopbackHttp === true &&
    isLoopbackHostname(url.hostname);
  if (!secure && !loopbackHttp) {
    throw new Error(
      'backend URL must use https (http is allowed only for loopback with explicit opt-in)',
    );
  }
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/';
  }
  return url.href;
}

/** Stricter of the local defaults and the descriptor limits, per key. */
export function negotiateLimits(descriptorLimits: DescriptorLimits): ContractLimits {
  return {
    entityBytes: Math.min(DEFAULT_LIMITS.entityBytes, descriptorLimits.entityBytes),
    pageBytes: Math.min(DEFAULT_LIMITS.pageBytes, descriptorLimits.pageBytes),
    batchChanges: Math.min(DEFAULT_LIMITS.batchChanges, descriptorLimits.batchChanges),
    liveFrameBytes: Math.min(DEFAULT_LIMITS.liveFrameBytes, descriptorLimits.liveFrameBytes),
  };
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`backend discovery response exceeds ${maxBytes} bytes`);
    }
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`backend discovery response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fetches `<base>/.well-known/anvil-backend` with a bounded timeout/size
 * budget, never following redirects, then validates the descriptor and
 * resolves the API/socket URLs inside the selected origin and base path.
 */
export async function discover(
  baseUrl: string,
  options: DiscoverOptions = {},
): Promise<BackendConnection> {
  const {
    allowLoopbackHttp = false,
    timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
    maxBytes = DEFAULT_DISCOVERY_MAX_BYTES,
    fetchFn = fetch,
  } = options;
  const normalized = normalizeBaseUrl(baseUrl, { allowLoopbackHttp });
  const discoveryUrl = new URL('.well-known/anvil-backend', normalized).href;
  let response: Response;
  try {
    response = await fetchFn(discoveryUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`backend discovery failed for ${normalized}: ${toMessage(error)}`);
  }
  if (!response.ok) {
    throw new Error(`backend discovery failed with HTTP ${response.status} for ${normalized}`);
  }
  const text = await readBoundedText(response, maxBytes);
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error('backend discovery response is not valid JSON');
  }
  const validated = validateDescriptor(payload);
  if (!validated.ok) {
    throw new Error(`invalid backend descriptor: ${validated.errors.join('; ')}`);
  }
  const resolved = resolveBackendPaths(normalized, validated.descriptor, { allowLoopbackHttp });
  const descriptor = toPublicDescriptor(validated.descriptor);
  return {
    baseUrl: normalized,
    apiUrl: resolved.apiUrl,
    socketUrl: resolved.socketUrl,
    descriptor,
    limits: negotiateLimits(descriptor.limits),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcUrl(apiUrl: string): string {
  const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
  return new URL('rpc', base).href;
}

/**
 * POSTs one versioned RPC envelope to `<api>/rpc` with bearer authorization
 * and parses the success/error envelope. The requestId is correlated where
 * the backend provides one.
 */
export async function rpc<R = unknown>(
  connection: Pick<BackendConnection, 'apiUrl'>,
  operation: string,
  params: unknown,
  accessToken: string,
  options: RpcOptions = {},
): Promise<RpcResult<R>> {
  const { fetchFn = fetch, timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS } = options;
  const requestId = randomUUID();
  let response: Response;
  try {
    response = await fetchFn(rpcUrl(connection.apiUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ protocol: PROTOCOL, requestId, operation, params }),
    });
  } catch (error) {
    throw new Error(`backend RPC ${operation} failed: ${toMessage(error)}`);
  }
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    throw new Error(`backend RPC ${operation} returned an unreadable response`);
  }
  if (!isRecord(payload)) {
    throw new Error(`backend RPC ${operation} returned a malformed envelope`);
  }
  if (isRecord(payload['error'])) {
    const errorBody = payload['error'];
    const responseId = typeof payload['requestId'] === 'string' ? payload['requestId'] : undefined;
    if (responseId !== undefined && responseId !== requestId) {
      throw new Error(`backend RPC ${operation} returned a mismatched requestId`);
    }
    throw new BackendRpcError({
      code: typeof errorBody['code'] === 'string' ? errorBody['code'] : 'unavailable',
      retryable: errorBody['retryable'] === true,
      retryAfterMs:
        typeof errorBody['retryAfterMs'] === 'number' ? errorBody['retryAfterMs'] : undefined,
      requestId: responseId,
      details: isRecord(errorBody['details']) ? errorBody['details'] : undefined,
    });
  }
  if (!response.ok) {
    throw new Error(`backend RPC ${operation} failed with HTTP ${response.status}`);
  }
  if (!('result' in payload)) {
    throw new Error(`backend RPC ${operation} returned a malformed envelope`);
  }
  if (typeof payload['requestId'] === 'string' && payload['requestId'] !== requestId) {
    throw new Error(`backend RPC ${operation} returned a mismatched requestId`);
  }
  return {
    result: payload['result'] as R,
    serverTime: typeof payload['serverTime'] === 'string' ? payload['serverTime'] : '',
  };
}

/** Minimal structural surface of the `ws` WebSocket used by this client. */
export interface BackendWebSocketLike {
  on(event: string, listener: (...args: Array<unknown>) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (
  url: string,
  protocols: string[],
  options: { headers: Record<string, string> },
) => BackendWebSocketLike;

interface WsModuleShape {
  WebSocket: new (
    url: string,
    protocols?: string | string[],
    options?: { headers?: Record<string, string> },
  ) => BackendWebSocketLike;
}

const requireNode = createRequire(import.meta.url);

function defaultCreateSocket(
  url: string,
  protocols: string[],
  options: { headers: Record<string, string> },
): BackendWebSocketLike {
  const wsModule = requireNode('ws') as unknown as WsModuleShape;
  return new wsModule.WebSocket(url, protocols, { headers: options.headers });
}

export interface OpenSocketOptions {
  createSocket?: WebSocketFactory;
  /** Rejects larger frames; defaults to the negotiated contract limit. */
  liveFrameBytes?: number;
  protocols?: string[];
}

export interface BackendSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
  onFrame(listener: (frame: SocketFrame) => void): () => void;
  onProtocolError(listener: (error: Error) => void): () => void;
  /** Fires when the underlying transport closes (any code). */
  onClose(listener: (code: number, reason: string) => void): () => void;
  /** Fires on transport-level errors; a close event usually follows. */
  onError(listener: (error: Error) => void): () => void;
}

/**
 * Opens the live channel with the fixed `anvil.mesh.v1` subprotocol and the
 * device bearer in the Authorization header (never in the URL). Incoming
 * frames are JSON-validated and size-bounded: oversized or unknown frames
 * raise a protocol error and close the socket. Reconnection is the caller's
 * job using `computeReconnectDelayMs`.
 */
export function openSocket(
  connection: Pick<BackendConnection, 'socketUrl'>,
  accessToken: string,
  options: OpenSocketOptions = {},
): BackendSocket {
  const {
    createSocket = defaultCreateSocket,
    liveFrameBytes = DEFAULT_LIMITS.liveFrameBytes,
    protocols = [SOCKET_SUBPROTOCOL],
  } = options;
  if (/[?&](token|access_token)=/i.test(connection.socketUrl)) {
    throw new Error('socket URL must not carry credentials');
  }
  const socket = createSocket(connection.socketUrl, protocols, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const frameListeners = new Set<(frame: SocketFrame) => void>();
  const protocolErrorListeners = new Set<(error: Error) => void>();
  const closeListeners = new Set<(code: number, reason: string) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  socket.on('close', (...args: Array<unknown>) => {
    const code = typeof args[0] === 'number' ? args[0] : 1006;
    const reason = Buffer.isBuffer(args[1]) ? args[1].toString('utf8') : String(args[1] ?? '');
    for (const listener of closeListeners) {
      listener(code, reason);
    }
  });
  socket.on('error', (...args: Array<unknown>) => {
    const error = args[0] instanceof Error ? args[0] : new Error(String(args[0] ?? 'socket error'));
    for (const listener of errorListeners) {
      listener(error);
    }
  });
  const failProtocol = (message: string): void => {
    const error = new Error(message);
    for (const listener of protocolErrorListeners) {
      listener(error);
    }
    socket.close(1008, message);
  };
  socket.on('message', (...args: Array<unknown>) => {
    const data = args[0];
    const text =
      typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : String(data ?? '');
    if (Buffer.byteLength(text, 'utf8') > liveFrameBytes) {
      failProtocol(`socket frame exceeds ${liveFrameBytes} bytes`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      failProtocol('socket frame is not valid JSON');
      return;
    }
    if (!isRecord(parsed) || typeof parsed['type'] !== 'string') {
      failProtocol('socket frame is missing a frame type');
      return;
    }
    if (!KNOWN_SOCKET_FRAME_TYPE_SET.has(parsed['type'])) {
      failProtocol(`unknown socket frame type: ${parsed['type']}`);
      return;
    }
    for (const listener of frameListeners) {
      listener(parsed as unknown as SocketFrame);
    }
  });
  return {
    close: (code?: number, reason?: string) => socket.close(code, reason),
    send: (data: string) => socket.send(data),
    onFrame: (listener: (frame: SocketFrame) => void) => {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
    onProtocolError: (listener: (error: Error) => void) => {
      protocolErrorListeners.add(listener);
      return () => {
        protocolErrorListeners.delete(listener);
      };
    },
    onClose: (listener: (code: number, reason: string) => void) => {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
    onError: (listener: (error: Error) => void) => {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    },
  };
}

/**
 * POSTs a contract auth route (enroll/session refresh/revoke/enrollment-code
 * issue). These are plain JSON bodies, not the RPC envelope. Error envelopes
 * still surface as BackendRpcError so `code` reaches the auth service's
 * AuthErrorCode mapping.
 */
export async function postAuthRoute<R = unknown>(
  connection: Pick<BackendConnection, 'apiUrl'>,
  route: 'enroll' | 'session/refresh' | 'session/revoke' | 'enrollment-codes',
  params: unknown,
  options: RpcOptions & { accessToken?: string } = {},
): Promise<R> {
  const { fetchFn = fetch, timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS, accessToken } = options;
  const base = connection.apiUrl.endsWith('/') ? connection.apiUrl : `${connection.apiUrl}/`;
  let response: Response;
  try {
    response = await fetchFn(new URL(route, base).href, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` }),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(params),
    });
  } catch (error) {
    throw new Error(`backend auth route ${route} failed: ${toMessage(error)}`);
  }
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    throw new Error(`backend auth route ${route} returned an unreadable response`);
  }
  if (isRecord(payload) && isRecord(payload['error'])) {
    const errorBody = payload['error'];
    throw new BackendRpcError({
      code: typeof errorBody['code'] === 'string' ? errorBody['code'] : 'unauthenticated',
      retryable: errorBody['retryable'] === true,
      message: `backend auth route ${route} rejected`,
      details: isRecord(errorBody['details']) ? errorBody['details'] : undefined,
    });
  }
  if (!response.ok) {
    throw new Error(`backend auth route ${route} failed with HTTP ${response.status}`);
  }
  return payload as R;
}

export interface ReconnectDelayOptions {
  baseMs?: number;
  maxMs?: number;
  random?: () => number;
}

/**
 * Full-jitter exponential backoff for socket reconnects: a random delay in
 * `[0, min(maxMs, baseMs * 2^attempt)]`. Pure and exported for tests; the
 * client itself never loops.
 */
export function computeReconnectDelayMs(
  attempt: number,
  options: ReconnectDelayOptions = {},
): number {
  const { baseMs = RECONNECT_BASE_MS, maxMs = RECONNECT_MAX_MS, random = Math.random } = options;
  const clamped = Math.max(0, Math.floor(attempt));
  const cap = Math.min(maxMs, baseMs * 2 ** Math.min(clamped, 10));
  return Math.floor(random() * cap);
}
