import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  MESH_MACHINE_MAX_FRAME_BYTES,
  MESH_MACHINE_ROUTE_PATHS,
  MESH_MACHINE_SOCKET_SUBPROTOCOL,
  type MeshMachineBootstrapRequest,
  type MeshMachineChallengeRequest,
  type MeshMachineServerPayload,
} from '../../../cloud/contract/machine';
import { MeshHostAdmissionError, MeshHostSessionService } from './mesh-host-session.service.js';

const requireNode = createRequire(import.meta.url);
const MAX_HTTP_BODY_BYTES = 16 * 1024;
const MAX_SOCKET_MESSAGE_BYTES = MESH_MACHINE_MAX_FRAME_BYTES * 2;
const SOCKET_AUTH_TIMEOUT_MS = 5_000;
const MAX_SOCKET_CONNECTIONS = 64;

interface WebSocketPeer {
  readyState: number;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
}

interface WebSocketServerLike {
  clients: Set<WebSocketPeer>;
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (client: WebSocketPeer) => void,
  ): void;
  close(callback?: (error?: Error) => void): void;
}

interface WebSocketModule {
  WebSocketServer: new (options: {
    noServer: true;
    maxPayload: number;
    perMessageDeflate: false;
  }) => WebSocketServerLike;
}

export type MeshHostIngress =
  | { kind: 'private' }
  | { kind: 'managed'; allowedHost: string };

export interface MeshHostSessionServerOptions {
  sessions: MeshHostSessionService;
  enabled: () => boolean;
  ingress: MeshHostIngress;
  /** Exact dashboard website Origin allowlist, checked locally against active grants. */
  isOriginApproved: (origin: string) => boolean;
}

interface AuthenticatedSocket {
  sessionId: string;
  origin: string | undefined;
  authenticated: boolean;
  authTimer: ReturnType<typeof setTimeout>;
}

/** HTTP bootstrap and encrypted WebSocket transport for a single listener authority. */
export class MeshHostSessionServer {
  private readonly options: MeshHostSessionServerOptions;
  private readonly webSockets: WebSocketServerLike;
  private readonly sockets = new Map<WebSocketPeer, AuthenticatedSocket>();
  private readonly socketBySession = new Map<string, WebSocketPeer>();
  private readonly unsubscribeEvents: () => void;
  private disposed = false;

  constructor(options: MeshHostSessionServerOptions) {
    this.options = options;
    const ws = requireNode('ws') as WebSocketModule;
    this.webSockets = new ws.WebSocketServer({
      noServer: true,
      maxPayload: MAX_SOCKET_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    this.unsubscribeEvents = options.sessions.onEvent((event) => {
      const { byteLength, ...payload } = event;
      void byteLength;
      for (const [socket, connection] of this.sockets) {
        if (
          connection.authenticated &&
          options.sessions.isSessionSubscribedToWorkspace(connection.sessionId, event.workspaceId)
        ) {
          this.sendPayload(socket, connection.sessionId, { kind: 'event', ...payload });
        }
      }
    });
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = parseRequestUrl(req);
    if (url === null || !isMachineRoute(url.pathname)) return false;
    if (!this.options.enabled() || this.disposed) {
      sendJson(res, 404, { error: 'Machine endpoint not found.' });
      return true;
    }
    if (!isTrustedIngress(req, this.options.ingress)) {
      sendJson(res, 421, { error: 'Machine endpoint authority is invalid.' });
      return true;
    }

    applySecurityHeaders(res);
    const origin = requestOrigin(req);
    if (origin === INVALID_ORIGIN || (origin !== undefined && !this.options.isOriginApproved(origin))) {
      sendJson(res, 403, { error: 'Machine endpoint Origin is not approved.' });
      return true;
    }
    if (origin !== undefined) applyCorsHeaders(res, origin);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }
    if (url.search !== '') {
      sendJson(res, 400, { error: 'Machine endpoint request is invalid.' });
      return true;
    }

    if (url.pathname === MESH_MACHINE_ROUTE_PATHS.info) {
      if (req.method !== 'GET' || hasBody(req)) {
        sendJson(res, 405, { error: 'Method not allowed.' });
        return true;
      }
      sendJson(res, 200, this.options.sessions.endpointInfo());
      return true;
    }

    if (url.pathname === MESH_MACHINE_ROUTE_PATHS.challenge && req.method === 'POST') {
      const body = await readJsonBody(req, MAX_HTTP_BODY_BYTES).catch(() => null);
      if (!isChallengeRequest(body)) {
        sendJson(res, 400, { error: 'Machine challenge request is invalid.' });
        return true;
      }
      try {
        const result = await this.options.sessions.createChallenge(body, origin);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 403, {
          error: 'Machine challenge was not authorized.',
          ...(error instanceof MeshHostAdmissionError ? { code: error.code } : {}),
        });
      }
      return true;
    }

    if (url.pathname === MESH_MACHINE_ROUTE_PATHS.bootstrap && req.method === 'POST') {
      const body = await readJsonBody(req, MAX_HTTP_BODY_BYTES).catch(() => null);
      if (!isBootstrapRequest(body)) {
        sendJson(res, 400, { error: 'Machine bootstrap request is invalid.' });
        return true;
      }
      try {
        const result = await this.options.sessions.bootstrap(body, origin);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, error instanceof MeshHostAdmissionError ? 403 : 401, {
          error: 'Machine bootstrap was not authorized.',
          ...(error instanceof MeshHostAdmissionError ? { code: error.code } : {}),
        });
      }
      return true;
    }

    if (url.pathname === MESH_MACHINE_ROUTE_PATHS.challenge || url.pathname === MESH_MACHINE_ROUTE_PATHS.bootstrap) {
      sendJson(res, 405, { error: 'Method not allowed.' });
      return true;
    }
    sendJson(res, 404, { error: 'Machine endpoint not found.' });
    return true;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = parseRequestUrl(req);
    if (url === null || url.pathname !== MESH_MACHINE_ROUTE_PATHS.socket) return false;
    if (!this.options.enabled() || this.disposed || url.search !== '') {
      rejectUpgrade(socket, 404, 'Not Found');
      return true;
    }
    if (
      !isTrustedIngress(req, this.options.ingress) ||
      !hasSocketSubprotocol(req) ||
      this.webSockets.clients.size >= MAX_SOCKET_CONNECTIONS
    ) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return true;
    }
    const origin = requestOrigin(req);
    if (
      origin === INVALID_ORIGIN ||
      (origin !== undefined && !this.options.isOriginApproved(origin))
    ) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return true;
    }

    this.webSockets.handleUpgrade(req, socket, head, (client) => {
      this.acceptSocket(client, origin);
    });
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeEvents();
    for (const [client, socket] of this.sockets) {
      clearTimeout(socket.authTimer);
      client.close(1001, 'listener-stopped');
      client.terminate();
    }
    this.sockets.clear();
    this.socketBySession.clear();
    this.webSockets.close();
  }

  private acceptSocket(client: WebSocketPeer, origin: string | undefined): void {
    const challenge = this.options.sessions.createSocketChallenge();
    const state: AuthenticatedSocket = {
      sessionId: '',
      origin,
      authenticated: false,
      authTimer: setTimeout(() => client.close(1008, 'auth-timeout'), SOCKET_AUTH_TIMEOUT_MS),
    };
    state.authTimer.unref?.();
    this.sockets.set(client, state);
    client.send(JSON.stringify({ type: 'auth-challenge', ...challenge }));
    client.on('message', (raw) => {
      void this.handleSocketMessage(client, raw, challenge.nonce).catch(() => {
        client.close(1008, 'invalid-session-frame');
      });
    });
    client.once('close', () => this.forgetSocket(client));
    client.once('error', () => this.forgetSocket(client));
  }

  private async handleSocketMessage(
    client: WebSocketPeer,
    raw: unknown,
    nonce: string,
  ): Promise<void> {
    const state = this.sockets.get(client);
    if (state === undefined) return;
    const text = socketMessageText(raw);
    if (text === null || Buffer.byteLength(text, 'utf8') > MAX_SOCKET_MESSAGE_BYTES) {
      client.close(1009, 'message-too-large');
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(text) as unknown;
    } catch {
      client.close(1007, 'malformed-frame');
      return;
    }
    if (!state.authenticated) {
      if (!isAuthFrame(frame)) {
        client.close(1008, 'auth-required');
        return;
      }
      const expectedOrigin = this.options.sessions.getSessionOrigin(frame.sessionId);
      if (
        !this.options.sessions.authenticateSocket(frame.sessionId, nonce, frame.proof) ||
        (expectedOrigin === null ? state.origin !== undefined : expectedOrigin !== state.origin)
      ) {
        client.close(1008, 'session-not-authorized');
        return;
      }
      clearTimeout(state.authTimer);
      const previous = this.socketBySession.get(frame.sessionId);
      if (previous !== undefined && previous !== client) previous.close(4001, 'session-reconnected');
      state.sessionId = frame.sessionId;
      state.authenticated = true;
      this.socketBySession.set(frame.sessionId, client);
      this.sendPayload(client, frame.sessionId, this.options.sessions.readyPayload(frame.sessionId));
      return;
    }

    if (!isEncryptedClientFrame(frame) || frame.sessionId !== state.sessionId) {
      client.close(1008, 'encrypted-frame-required');
      return;
    }
    try {
      const decoded = this.options.sessions.decryptClientFrame(frame);
      const payloads = await this.options.sessions.processClientPayload(decoded.sessionId, decoded.payload);
      for (const payload of payloads) this.sendPayload(client, decoded.sessionId, payload);
    } catch {
      client.close(1008, 'encrypted-frame-invalid');
    }
  }

  private sendPayload(client: WebSocketPeer, sessionId: string, payload: MeshMachineServerPayload): void {
    if (client.readyState !== 1 || !this.options.sessions.isSessionActive(sessionId)) return;
    try {
      const frame = this.options.sessions.encryptServerPayload(sessionId, payload);
      const text = JSON.stringify(frame);
      if (Buffer.byteLength(text, 'utf8') > MAX_SOCKET_MESSAGE_BYTES) {
        client.close(1009, 'response-too-large');
        return;
      }
      client.send(text, (error) => {
        if (error) client.close(1011, 'send-failed');
      });
    } catch {
      client.close(1008, 'session-expired');
    }
  }

  private forgetSocket(client: WebSocketPeer): void {
    const state = this.sockets.get(client);
    if (state === undefined) return;
    clearTimeout(state.authTimer);
    this.sockets.delete(client);
    if (state.sessionId !== '' && this.socketBySession.get(state.sessionId) === client) {
      this.socketBySession.delete(state.sessionId);
    }
  }
}

function parseRequestUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', 'http://mesh.local');
  } catch {
    return null;
  }
}

function isMachineRoute(path: string): boolean {
  return (
    path === MESH_MACHINE_ROUTE_PATHS.info ||
    path === MESH_MACHINE_ROUTE_PATHS.challenge ||
    path === MESH_MACHINE_ROUTE_PATHS.bootstrap
  );
}

function requestOrigin(req: IncomingMessage): string | undefined | typeof INVALID_ORIGIN {
  const origin = req.headers.origin;
  if (origin === undefined) return undefined;
  if (typeof origin !== 'string' || !isCanonicalOrigin(origin)) return INVALID_ORIGIN;
  return origin;
}

const INVALID_ORIGIN = Symbol('invalid-origin');

function isCanonicalOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.origin === value &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

function isTrustedIngress(req: IncomingMessage, ingress: MeshHostIngress): boolean {
  if (hasForwardedAuthority(req, ingress)) return false;
  const hostHeader = req.headers.host;
  if (typeof hostHeader !== 'string' || req.socket.localPort === undefined) return false;
  try {
    const host = new URL(`http://${hostHeader}`);
    if (host.username !== '' || host.password !== '' || host.pathname !== '/' || host.search || host.hash) {
      return false;
    }
    if (ingress.kind === 'managed') {
      return (
        host.hostname.toLowerCase() === ingress.allowedHost.toLowerCase() &&
        host.port === '' &&
        isLoopback(req.socket.localAddress) &&
        isLoopback(req.socket.remoteAddress)
      );
    }
    if (Number(host.port || 80) !== req.socket.localPort) return false;
    const authorityHost = normalizeAddress(host.hostname);
    const localAddress = normalizeAddress(req.socket.localAddress ?? '');
    return (
      authorityHost === localAddress ||
      (authorityHost === 'localhost' && isLoopback(req.socket.remoteAddress) && isLoopback(req.socket.localAddress))
    );
  } catch {
    return false;
  }
}

function hasForwardedAuthority(req: IncomingMessage, ingress: MeshHostIngress): boolean {
  return Object.entries(req.headers).some(([name, value]) =>
    (name === 'forwarded' ||
      name === 'x-forwarded-host' ||
      name === 'x-forwarded-proto' ||
      name === 'x-real-ip' ||
      (ingress.kind === 'private' && name.startsWith('x-forwarded-'))) &&
    value !== undefined,
  );
}

function normalizeAddress(address: string): string {
  return address.toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
}

function isLoopback(address: string | undefined): boolean {
  const value = normalizeAddress(address ?? '');
  return value === 'localhost' || value === '::1' || value.startsWith('127.');
}

function hasSocketSubprotocol(req: IncomingMessage): boolean {
  const header = req.headers['sec-websocket-protocol'];
  return typeof header === 'string' && header.split(',').some((item) => item.trim() === MESH_MACHINE_SOCKET_SUBPROTOCOL);
}

function isChallengeRequest(value: unknown): value is MeshMachineChallengeRequest {
  if (!isRecord(value) || value['v'] !== 1 || typeof value['clientPublicKey'] !== 'string') return false;
  if (value['mode'] === 'admission') {
    return typeof value['ticket'] === 'string' && value['ticket'].length > 0 && value['ticket'].length <= 4096;
  }
  return value['mode'] === 'dashboard' && typeof value['grantId'] === 'string' && value['grantId'].length <= 128;
}

function isBootstrapRequest(value: unknown): value is MeshMachineBootstrapRequest {
  return (
    isRecord(value) &&
    value['v'] === 1 &&
    typeof value['challengeId'] === 'string' &&
    value['challengeId'].length <= 128 &&
    typeof value['proof'] === 'string' &&
    value['proof'].length <= 256
  );
}

function isAuthFrame(value: unknown): value is { type: 'auth'; sessionId: string; proof: string } {
  return (
    isRecord(value) &&
    value['type'] === 'auth' &&
    typeof value['sessionId'] === 'string' &&
    value['sessionId'].length <= 128 &&
    typeof value['proof'] === 'string' &&
    value['proof'].length <= 256
  );
}

function isEncryptedClientFrame(value: unknown): value is {
  type: 'data';
  sessionId: string;
  requestId: string;
  sequence: number;
  envelope: { enc: 'aes-256-gcm'; nonce: string; ct: string };
} {
  if (!isRecord(value) || value['type'] !== 'data' || !isRecord(value['envelope'])) return false;
  const envelope = value['envelope'];
  return (
    typeof value['sessionId'] === 'string' &&
    typeof value['requestId'] === 'string' &&
    Number.isSafeInteger(value['sequence']) &&
    envelope['enc'] === 'aes-256-gcm' &&
    typeof envelope['nonce'] === 'string' &&
    typeof envelope['ct'] === 'string'
  );
}

function socketMessageText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
  if (Array.isArray(value) && value.every((chunk) => Buffer.isBuffer(chunk))) {
    return Buffer.concat(value).toString('utf8');
  }
  return null;
}

function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return Promise.reject(new Error('content-type-invalid'));
  }
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    return Promise.reject(new Error('body-too-large'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let oversized = false;
    req.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > limit) {
        oversized = true;
        return;
      }
      chunks.push(buffer);
    });
    req.once('error', reject);
    req.once('end', () => {
      if (oversized) {
        reject(new Error('body-too-large'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        reject(new Error('body-malformed'));
      }
    });
  });
}

function hasBody(req: IncomingMessage): boolean {
  return (
    req.headers['transfer-encoding'] !== undefined ||
    (typeof req.headers['content-length'] === 'string' && req.headers['content-length'] !== '0')
  );
}

function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function applyCorsHeaders(res: ServerResponse, origin: string): void {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Max-Age', '300');
  res.setHeader('Vary', 'Origin');
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  applySecurityHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
