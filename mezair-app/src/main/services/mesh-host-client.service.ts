import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { isIP } from 'node:net';
import { connectMeshRoutes } from '../../../cloud/contract/machine-route-connect.js';
import {
  isMeshLoopbackHost,
  meshMachineRouteRank,
  normalizeMeshNetworkKind,
} from '../../../cloud/contract/machine-route-policy.js';
import {
  MESH_MACHINE_SESSION_REFRESH_INTERVAL_MS,
  MESH_MACHINE_MAX_FRAME_BYTES,
  MESH_MACHINE_ROUTE_PATHS,
  MESH_MACHINE_SOCKET_SUBPROTOCOL,
  MESH_MACHINE_PROTOCOL_VERSION,
  meshMachineAdmissionBootstrapProofMessage,
  meshMachineBootstrapHostProofMessage,
  meshMachineAdmissionProofKeyAssociatedData,
  meshMachineAdmissionClaimsCanonicalJson,
  meshMachineSessionTokenAssociatedData,
  meshMachineSocketProofMessage,
  meshMachineTrafficKeyDerivation,
  meshMachineFrameAssociatedData,
  type MeshMachineAdmissionIssueRequest,
  type MeshMachineAdmissionIssueResponse,
  type MeshMachineBootstrapChallenge,
  type MeshMachineBootstrapResponse,
  type MeshMachineClientPayload,
  type MeshMachineCursor,
  type MeshMachineServerPayload,
  type MeshMachineOperation,
  type MeshMachineEndpointInfo,
  type MeshMachineHost,
  type MeshMachineRoute,
} from '../../../cloud/contract/machine.js';

const X25519_PUBLIC_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const WRAP_INFO = Buffer.from('mezair/keyring-wrap/v1', 'utf8');

export type MeshHostRouteKind = MeshMachineRoute['kind'] | 'account';
export type MeshHostConnectionState = 'offline' | 'connecting' | 'live' | 'degraded';

export interface MeshHostConnectionStatus {
  enrollmentId: string;
  state: MeshHostConnectionState;
  route: MeshHostRouteKind | null;
  capabilities: string[];
  /** Sanitized, renderer-safe code. Never contains server-supplied error text. */
  lastError?:
    | 'route-unavailable'
    | 'protocol-mismatch'
    | 'authorization-unavailable'
    | 'approval-required'
    | 'device-denied';
}

const SAFE_MACHINE_ERROR_CODES = new Set([
  'approval-required',
  'device-denied',
  'authorization-unavailable',
]);

export function safeMachineErrorCode(
  error: unknown,
): MeshHostConnectionStatus['lastError'] | undefined {
  if (!(error instanceof Error)) return undefined;
  if (SAFE_MACHINE_ERROR_CODES.has(error.message)) {
    return error.message as MeshHostConnectionStatus['lastError'];
  }
  return undefined;
}

export interface MeshHostClientContext {
  apiUrl: string;
  accessToken: string;
  accountId: string;
  enrollmentId: string;
  fetchFn?: typeof fetch;
}

interface MeshMachineWebSocketLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type MeshMachineWebSocketFactory = (
  url: string,
  protocols: string[],
) => MeshMachineWebSocketLike;

function createMachineSocket(url: string, protocols: string[]): MeshMachineWebSocketLike {
  const socket = new globalThis.WebSocket(url, protocols);
  return {
    on(event, listener) {
      if (event === 'message') {
        socket.addEventListener('message', (message) => listener(message.data));
      } else if (event === 'error') {
        socket.addEventListener('error', () => listener(new Error('machine-socket-error')));
      } else if (event === 'close') {
        socket.addEventListener('close', () => listener());
      }
    },
    send(data) {
      socket.send(data);
    },
    close(code, reason) {
      socket.close(code, reason);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeBase64(value: string, expectedBytes?: number): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('invalid-base64');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error('invalid-base64');
  if (expectedBytes !== undefined && decoded.byteLength !== expectedBytes) {
    throw new Error('invalid-key-length');
  }
  return decoded;
}

function rawPublicKey(key: KeyObject): Buffer {
  const der = key.export({ format: 'der', type: 'spki' });
  return der.subarray(der.byteLength - 32);
}

function publicKeyFromRaw(value: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_PUBLIC_PREFIX, value]),
    format: 'der',
    type: 'spki',
  });
}

/** Orders authenticated direct routes before the existing account fallback. */
export function meshMachineRouteCandidates(
  host: MeshMachineHost,
  now = Date.now(),
): MeshMachineRoute[] {
  const seen = new Set<string>();
  return host.routes
    .filter((route) => {
      const base = safeMeshRouteBase(route);
      const expiry = Date.parse(route.reachableUntil);
      if (
        base === null ||
        isMeshLoopbackHost(base.hostname) ||
        route.networkKind === 'loopback' ||
        route.machineId !== host.machineId ||
        route.endpointGeneration !== host.endpointGeneration ||
        !Number.isFinite(expiry) ||
        expiry <= now ||
        seen.has(base.origin)
      )
        return false;
      seen.add(base.origin);
      return true;
    })
    .map((route) => ({ ...route, networkKind: normalizeMeshNetworkKind(route.networkKind) }))
    .sort((a, b) => meshMachineRouteRank(a) - meshMachineRouteRank(b));
}

/** Validates the advertised origin before constructing any host URL. */
export function safeMeshRouteBase(route: Pick<MeshMachineRoute, 'kind' | 'url'>): URL | null {
  try {
    const url = new URL(route.url);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const privateAddress = isPrivateRouteHost(hostname);
    if (
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      (url.pathname !== '/' && url.pathname !== '') ||
      (url.protocol !== 'https:' &&
        !(route.kind === 'private' && url.protocol === 'http:' && privateAddress)) ||
      (route.kind === 'managed' && url.protocol !== 'https:')
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function isPrivateRouteHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    return true;
  }
  const version = isIP(hostname);
  if (version === 4) {
    const octets = hostname.split('.').map(Number);
    return (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127) ||
      (octets[0] === 169 && octets[1] === 254) ||
      octets[0] === 127
    );
  }
  if (version === 6) {
    return hostname === '::1' || /^(?:fc|fd|fe80:)/i.test(hostname);
  }
  return false;
}

export function meshMachineRouteUrl(route: MeshMachineRoute, path: string, socket = false): string {
  const base = safeMeshRouteBase(route);
  if (base === null || !path.startsWith('/')) throw new Error('unsafe-machine-route');
  if (socket) base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = path;
  return base.href;
}

/** Opens one-use X25519-sealed bytes using the repo's shared key-wrap primitive. */
export function openMeshSealedBytes(
  privateKey: KeyObject,
  clientPublicRaw: Buffer,
  envelope: { enc: string; ephPub: string; nonce: string; ct: string },
  aad: string,
): Buffer {
  if (envelope.enc !== 'x25519-aes-256-gcm') throw new Error('unsupported-seal');
  const ephemeralPublicRaw = decodeBase64(envelope.ephPub, 32);
  const nonce = decodeBase64(envelope.nonce, 12);
  const ciphertextAndTag = decodeBase64(envelope.ct);
  if (ciphertextAndTag.byteLength < 16) throw new Error('invalid-seal');
  const shared = diffieHellman({
    privateKey,
    publicKey: publicKeyFromRaw(ephemeralPublicRaw),
  });
  const key = Buffer.from(
    hkdfSync('sha256', shared, Buffer.concat([ephemeralPublicRaw, clientPublicRaw]), WRAP_INFO, 32),
  );
  shared.fill(0);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(ciphertextAndTag.subarray(ciphertextAndTag.byteLength - 16));
  const plaintext = Buffer.concat([
    decipher.update(ciphertextAndTag.subarray(0, ciphertextAndTag.byteLength - 16)),
    decipher.final(),
  ]);
  key.fill(0);
  return plaintext;
}

/** Encrypts a single direct-session frame and binds it to its session cursor. */
export function sealMeshMachineFrame(input: {
  key: Buffer;
  sessionId: string;
  machineId: string;
  endpointGeneration: string;
  epoch: string;
  direction: 'client-to-host' | 'host-to-client';
  requestId?: string;
  sequence: number;
  payload: unknown;
}): { enc: 'aes-256-gcm'; nonce: string; ct: string } {
  if (input.key.byteLength !== 32 || !Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new Error('invalid-machine-frame-key-or-sequence');
  }
  const aad = meshMachineFrameAssociatedData({
    sessionId: input.sessionId,
    machineId: input.machineId,
    endpointGeneration: input.endpointGeneration,
    epoch: input.epoch,
    direction: input.direction,
    requestId: input.requestId,
    sequence: input.sequence,
  });
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', input.key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const serializedPayload = JSON.stringify(input.payload);
  if (Buffer.byteLength(serializedPayload, 'utf8') > MESH_MACHINE_MAX_FRAME_BYTES) {
    throw new Error('machine-frame-too-large');
  }
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(serializedPayload, 'utf8')),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { enc: 'aes-256-gcm', nonce: nonce.toString('base64'), ct: ciphertext.toString('base64') };
}

/** Decrypts a post-auth direct-session frame after checking the same bound fields. */
export function openMeshMachineFrame(input: {
  key: Buffer;
  sessionId: string;
  machineId: string;
  endpointGeneration: string;
  epoch: string;
  direction: 'client-to-host' | 'host-to-client';
  requestId?: string;
  sequence: number;
  envelope: { enc: string; nonce: string; ct: string };
}): unknown {
  if (input.key.byteLength !== 32 || input.envelope.enc !== 'aes-256-gcm') {
    throw new Error('invalid-machine-frame');
  }
  const nonce = decodeBase64(input.envelope.nonce, 12);
  const ciphertextAndTag = decodeBase64(input.envelope.ct);
  if (ciphertextAndTag.byteLength < 16) throw new Error('invalid-machine-frame');
  const aad = meshMachineFrameAssociatedData({
    sessionId: input.sessionId,
    machineId: input.machineId,
    endpointGeneration: input.endpointGeneration,
    epoch: input.epoch,
    direction: input.direction,
    requestId: input.requestId,
    sequence: input.sequence,
  });
  const decipher = createDecipheriv('aes-256-gcm', input.key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(ciphertextAndTag.subarray(ciphertextAndTag.byteLength - 16));
  const plaintext = Buffer.concat([
    decipher.update(ciphertextAndTag.subarray(0, ciphertextAndTag.byteLength - 16)),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext) as unknown;
}

export function createMeshMachineMac(key: string | Buffer, message: string): string {
  return createHmac('sha256', key).update(message, 'utf8').digest('base64url');
}

function verifyMeshMachineMac(key: Buffer, message: string, signature: unknown): boolean {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  const actual = Buffer.from(signature, 'base64url');
  if (actual.byteLength !== 32 || actual.toString('base64url') !== signature) {
    actual.fill(0);
    return false;
  }
  const expected = Buffer.from(createMeshMachineMac(key, message), 'base64url');
  const matches = timingSafeEqual(expected, actual);
  actual.fill(0);
  expected.fill(0);
  return matches;
}

export function newMeshMachineEphemeralIdentity(): {
  privateKey: KeyObject;
  clientPublicRaw: Buffer;
  clientPublicKey: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const clientPublicRaw = rawPublicKey(publicKey);
  return {
    privateKey,
    clientPublicRaw,
    clientPublicKey: clientPublicRaw.toString('base64'),
  };
}

export function parseMeshMachineHostList(value: unknown): MeshMachineHost[] {
  if (
    !isRecord(value) ||
    value.v !== MESH_MACHINE_PROTOCOL_VERSION ||
    !Array.isArray(value.hosts)
  ) {
    throw new Error('malformed-host-list');
  }
  const hosts: MeshMachineHost[] = [];
  for (const item of value.hosts) {
    if (
      !isRecord(item) ||
      typeof item['enrollmentId'] !== 'string' ||
      typeof item['machineId'] !== 'string' ||
      typeof item['endpointGeneration'] !== 'string' ||
      item['protocolVersion'] !== MESH_MACHINE_PROTOCOL_VERSION ||
      typeof item['online'] !== 'boolean' ||
      !Array.isArray(item['capabilities']) ||
      !item['capabilities'].every((capability) => typeof capability === 'string') ||
      !Array.isArray(item['operations']) ||
      !item['operations'].every((operation) => typeof operation === 'string') ||
      !Array.isArray(item['routes'])
    ) {
      continue;
    }
    const routes = item['routes'].filter(
      (route): route is MeshMachineRoute =>
        isRecord(route) &&
        (route['kind'] === 'private' || route['kind'] === 'https' || route['kind'] === 'managed') &&
        typeof route['url'] === 'string' &&
        typeof route['machineId'] === 'string' &&
        typeof route['endpointGeneration'] === 'string' &&
        typeof route['reachableUntil'] === 'string',
    );
    hosts.push({
      enrollmentId: item['enrollmentId'],
      machineId: item['machineId'],
      endpointGeneration: item['endpointGeneration'],
      protocolVersion: MESH_MACHINE_PROTOCOL_VERSION,
      capabilities: item['capabilities'] as MeshMachineHost['capabilities'],
      operations: item['operations'] as MeshMachineHost['operations'],
      online: item['online'],
      lastSeenAt: typeof item['lastSeenAt'] === 'string' ? item['lastSeenAt'] : '',
      reachableUntil: typeof item['reachableUntil'] === 'string' ? item['reachableUntil'] : '',
      routes,
      allocationState:
        item['allocationState'] === 'ready' ||
        item['allocationState'] === 'allocating' ||
        item['allocationState'] === 'retiring' ||
        item['allocationState'] === 'failed' ||
        item['allocationState'] === 'disabled'
          ? item['allocationState']
          : 'unallocated',
    });
  }
  return hosts;
}

/** Reads account-scoped host route metadata; the bearer is sent only to the backend API. */
export async function fetchMeshMachineHosts(input: {
  apiUrl: string;
  accessToken: string;
  fetchFn?: typeof fetch;
}): Promise<MeshMachineHost[]> {
  const apiUrl = safeAdmissionApiUrl(input.apiUrl);
  const response = await fetchMachineJson(
    input.fetchFn ?? fetch,
    new URL('mesh/hosts', apiUrl).href,
    { method: 'GET', headers: { authorization: `Bearer ${input.accessToken}` } },
  );
  return parseMeshMachineHostList(response);
}

/** Performs one backend Mesh REST call without ever sending credentials to a host route. */
export async function fetchMeshMachineBrokerJson(input: {
  apiUrl: string;
  accessToken: string;
  path: string;
  method: 'POST';
  body: unknown;
  fetchFn?: typeof fetch;
}): Promise<unknown> {
  if (
    input.path.startsWith('/') ||
    input.path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('unsafe-mesh-broker-path');
  }
  const apiUrl = safeAdmissionApiUrl(input.apiUrl);
  return fetchMachineJson(input.fetchFn ?? fetch, new URL(input.path, apiUrl).href, {
    method: input.method,
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input.body),
  });
}

export function parseMeshMachineEndpointInfo(value: unknown): MeshMachineEndpointInfo | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.hostEnrollmentId !== 'string' ||
    typeof value.machineId !== 'string' ||
    typeof value.endpointGeneration !== 'string' ||
    value.protocolVersion !== MESH_MACHINE_PROTOCOL_VERSION ||
    !Array.isArray(value.capabilities) ||
    !Array.isArray(value.operations) ||
    !isRecord(value.transport) ||
    value.transport['socketPath'] !== MESH_MACHINE_ROUTE_PATHS.socket ||
    value.transport['maxFrameBytes'] !== MESH_MACHINE_MAX_FRAME_BYTES
  ) {
    return null;
  }
  return value as unknown as MeshMachineEndpointInfo;
}

export function machineSocketProtocol(): string[] {
  return [MESH_MACHINE_SOCKET_SUBPROTOCOL];
}

/** Used by the managed-session client once its one-use ticket exchange completes. */
export interface MeshMachineSocketCredential {
  sessionId: string;
  sessionToken: Buffer;
  authorizationValidUntil: string;
  stream: { epoch: string; nextSequence: number; oldestSequence: number };
}

export function createMeshMachineSocketProof(input: {
  sessionToken: Buffer;
  sessionId: string;
  nonce: string;
  machineId: string;
  endpointGeneration: string;
}): string {
  return createMeshMachineMac(
    input.sessionToken,
    meshMachineSocketProofMessage({
      sessionId: input.sessionId,
      nonce: input.nonce,
      machineId: input.machineId,
      endpointGeneration: input.endpointGeneration,
    }),
  );
}

export function nextMeshMachineRequestId(): string {
  return randomUUID();
}

export interface MeshMachineAdmissionContext {
  /** Backend API base ending in the descriptor API path, e.g. `/v1/`. */
  apiUrl: string;
  accessToken: string;
  accountId: string;
  enrollmentId: string;
  fetchFn?: typeof fetch;
  socketFactory?: MeshMachineWebSocketFactory;
  signal?: AbortSignal;
  resumeCursor?: MeshMachineCursor;
  workspaceIds?: readonly string[];
  requireReplayComplete?: boolean;
  onEvent?: (event: {
    enrollmentId: string;
    epoch: string;
    sequence: number;
    workspaceId: string;
    jobId?: string;
    eventKind: string;
    payload: unknown;
  }) => void;
  onResnapshotRequired?: (input: {
    enrollmentId: string;
    reason: 'epoch-changed' | 'cursor-expired';
  }) => void;
  onClosed?: (enrollmentId: string, reason?: string) => void;
}

interface PendingMachineRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One authenticated direct session to a single advertised execution host. */
export class MeshMachineSessionConnection {
  readonly enrollmentId: string;
  readonly machineId: string;
  readonly endpointGeneration: string;
  readonly routeKind: MeshMachineRoute['kind'];
  readonly route: MeshMachineRoute;
  readonly supportsHandoff: boolean;
  private readonly socket: MeshMachineWebSocketLike;
  private readonly context: MeshMachineAdmissionContext;
  private readonly sessionId: string;
  private readonly epoch: string;
  private readonly clientToHostKey: Buffer;
  private readonly hostToClientKey: Buffer;
  private clientSequence: number;
  private serverSequence = 1;
  private authorizationValidUntil: string;
  private readyState = false;
  private terminated = false;
  private subscriptionRevision = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private cursor: MeshMachineCursor | null = null;
  private readonly pending = new Map<string, PendingMachineRequest>();
  private readonly workspaces = new Set<string>();
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readyPromise: Promise<void>;

  private constructor(input: {
    host: MeshMachineHost;
    route: MeshMachineRoute;
    context: MeshMachineAdmissionContext;
    socket: MeshMachineWebSocketLike;
    sessionId: string;
    sessionToken: Buffer;
    epoch: string;
    clientSequence: number;
    authorizationValidUntil: string;
  }) {
    this.enrollmentId = input.host.enrollmentId;
    this.machineId = input.host.machineId;
    this.endpointGeneration = input.host.endpointGeneration;
    this.routeKind = input.route.kind;
    this.route = { ...input.route };
    this.supportsHandoff = input.host.capabilities.includes('machine.stream-handoff/1');
    for (const workspaceId of input.context.workspaceIds ?? []) this.workspaces.add(workspaceId);
    this.context = input.context;
    this.socket = input.socket;
    this.sessionId = input.sessionId;
    this.epoch = input.epoch;
    this.clientSequence = input.clientSequence;
    this.authorizationValidUntil = input.authorizationValidUntil;
    this.clientToHostKey = deriveMachineTrafficKey(input.sessionToken, {
      sessionId: input.sessionId,
      machineId: input.host.machineId,
      endpointGeneration: input.host.endpointGeneration,
      direction: 'client-to-host',
    });
    this.hostToClientKey = deriveMachineTrafficKey(input.sessionToken, {
      sessionId: input.sessionId,
      machineId: input.host.machineId,
      endpointGeneration: input.host.endpointGeneration,
      direction: 'host-to-client',
    });
    this.retainedToken = Buffer.from(input.sessionToken);
    input.sessionToken.fill(0);
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  static async open(input: {
    host: MeshMachineHost;
    route: MeshMachineRoute;
    context: MeshMachineAdmissionContext;
    socket: MeshMachineWebSocketLike;
    sessionId: string;
    sessionToken: Buffer;
    epoch: string;
    clientSequence: number;
    authorizationValidUntil: string;
  }): Promise<MeshMachineSessionConnection> {
    const connection = new MeshMachineSessionConnection(input);
    const abort = (): void => connection.finish(new Error('machine-session-cancelled'), true);
    input.context.signal?.addEventListener('abort', abort, { once: true });
    connection.attach();
    try {
      if (input.context.signal?.aborted) abort();
      await connection.readyPromise;
      if (input.context.signal?.aborted) throw new Error('machine-session-cancelled');
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    } finally {
      input.context.signal?.removeEventListener('abort', abort);
    }
  }

  private authChallengeSeen = false;

  private attach(): void {
    this.socket.on('message', (...args) => {
      if (this.terminated) return;
      // Decryption and sequence validation are synchronous before this async handler yields.
      void this.handleSocketMessage(args[0]).catch((error: unknown) => {
        this.finish(error instanceof Error ? error : new Error('machine-session-protocol'));
      });
    });
    this.socket.on('error', (...args) => {
      this.finish(args[0] instanceof Error ? args[0] : new Error('machine-socket-error'));
    });
    this.socket.on('close', () => this.finish(new Error('machine-session-closed')));
    const timer = setTimeout(() => this.finish(new Error('machine-session-timeout')), 15_000);
    timer.unref?.();
    this.readyPromise.finally(() => clearTimeout(timer)).catch(() => undefined);
  }

  private async handleSocketMessage(data: unknown): Promise<void> {
    const raw = socketMessageText(data);
    if (raw === null || Buffer.byteLength(raw, 'utf8') > MESH_MACHINE_MAX_FRAME_BYTES) {
      throw new Error('machine-frame-too-large');
    }
    let frame: unknown;
    try {
      frame = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('machine-frame-malformed');
    }
    if (!isRecord(frame)) throw new Error('machine-frame-malformed');
    if (frame['type'] === 'auth-challenge') {
      if (
        this.readyState ||
        this.authChallengeSeen ||
        typeof frame['nonce'] !== 'string' ||
        typeof frame['epoch'] !== 'string' ||
        frame['epoch'] !== this.epoch
      ) {
        throw new Error('machine-auth-challenge-mismatch');
      }
      const sessionToken = this.consumePendingSessionToken();
      const proof = createMeshMachineMac(
        sessionToken,
        meshMachineSocketProofMessage({
          sessionId: this.sessionId,
          nonce: frame['nonce'],
          machineId: this.machineId,
          endpointGeneration: this.endpointGeneration,
        }),
      );
      sessionToken.fill(0);
      this.socket.send(JSON.stringify({ type: 'auth', sessionId: this.sessionId, proof }));
      this.authChallengeSeen = true;
      return;
    }
    if (
      !this.authChallengeSeen ||
      frame['type'] !== 'data' ||
      frame['sessionId'] !== this.sessionId ||
      !Number.isSafeInteger(frame['sequence']) ||
      frame['sequence'] !== this.serverSequence ||
      !isRecord(frame['envelope']) ||
      typeof frame['envelope']['enc'] !== 'string' ||
      typeof frame['envelope']['nonce'] !== 'string' ||
      typeof frame['envelope']['ct'] !== 'string'
    ) {
      throw new Error('machine-frame-malformed');
    }
    const requestId = typeof frame['requestId'] === 'string' ? frame['requestId'] : undefined;
    const payload = openMeshMachineFrame({
      key: this.hostToClientKey,
      sessionId: this.sessionId,
      machineId: this.machineId,
      endpointGeneration: this.endpointGeneration,
      epoch: this.epoch,
      direction: 'host-to-client',
      requestId,
      sequence: frame['sequence'] as number,
      envelope: frame['envelope'] as { enc: string; nonce: string; ct: string },
    });
    this.serverSequence += 1;
    if (!isRecord(payload) || typeof payload['kind'] !== 'string') {
      throw new Error('machine-payload-malformed');
    }
    this.handleServerPayload(payload as unknown as MeshMachineServerPayload, requestId);
  }

  private retainedToken: Buffer | null = null;

  private consumePendingSessionToken(): Buffer {
    const token = this.retainedToken;
    if (token === null) throw new Error('machine-session-token-missing');
    this.retainedToken = null;
    return token;
  }

  private handleServerPayload(payload: MeshMachineServerPayload, outerRequestId?: string): void {
    switch (payload.kind) {
      case 'ready': {
        if (
          this.readyState ||
          payload.sessionId !== this.sessionId ||
          payload.epoch !== this.epoch ||
          !Number.isSafeInteger(payload.nextClientSequence) ||
          payload.nextClientSequence < 1 ||
          !Number.isSafeInteger(payload.nextSequence) ||
          !Number.isSafeInteger(payload.oldestSequence)
        ) {
          throw new Error('machine-ready-malformed');
        }
        this.clientSequence = payload.nextClientSequence;
        this.authorizationValidUntil = payload.authorizationValidUntil;
        const saved = this.context.resumeCursor;
        if (saved !== undefined && saved.epoch === payload.epoch) {
          this.cursor = saved;
        } else {
          this.cursor = { epoch: payload.epoch, sequence: Math.max(0, payload.nextSequence - 1) };
          if (saved !== undefined) {
            this.context.onResnapshotRequired?.({
              enrollmentId: this.enrollmentId,
              reason: 'epoch-changed',
            });
          }
        }
        this.readyState = true;
        this.refreshTimer = setInterval(() => {
          void this.sendRequest({ kind: 'refresh', requestId: nextMeshMachineRequestId() }).catch(
            () => this.finish(new Error('authorization-unavailable')),
          );
        }, MESH_MACHINE_SESSION_REFRESH_INTERVAL_MS);
        this.refreshTimer.unref?.();
        if (this.context.requireReplayComplete && !this.supportsHandoff) {
          this.finish(new Error('machine-handoff-unsupported'));
          return;
        }
        if (!this.supportsHandoff) this.resolveReady();
        void this.subscribe().catch((error: unknown) => {
          this.finish(error instanceof Error ? error : new Error('machine-subscribe-failed'));
        });
        return;
      }
      case 'response':
      case 'refreshed': {
        const id = payload.requestId || outerRequestId;
        const pending = id === undefined ? undefined : this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id as string);
        clearTimeout(pending.timer);
        if (payload.kind === 'response') pending.resolve(payload.result);
        else {
          this.authorizationValidUntil = payload.authorizationValidUntil;
          pending.resolve({ authorizationValidUntil: payload.authorizationValidUntil });
        }
        return;
      }
      case 'event':
        if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 1)
          throw new Error('machine-event-sequence-invalid');
        if (payload.epoch !== this.epoch || this.cursor?.epoch !== payload.epoch) {
          this.cursor = { epoch: payload.epoch, sequence: Math.max(0, payload.sequence - 1) };
          this.context.onResnapshotRequired?.({
            enrollmentId: this.enrollmentId,
            reason: 'epoch-changed',
          });
          return;
        }
        if (payload.sequence <= (this.cursor?.sequence ?? 0)) return;
        this.cursor = { epoch: payload.epoch, sequence: payload.sequence };
        this.context.onEvent?.({
          enrollmentId: this.enrollmentId,
          epoch: payload.epoch,
          sequence: payload.sequence,
          workspaceId: payload.workspaceId,
          ...(payload.jobId === undefined ? {} : { jobId: payload.jobId }),
          eventKind: payload.eventKind,
          payload: payload.payload,
        });
        void this.sendControl({
          kind: 'ack',
          requestId: nextMeshMachineRequestId(),
          cursor: this.cursor,
        }).catch(() => this.finish(new Error('machine-ack-failed')));
        return;
      case 'resnapshot-required':
        this.cursor = { epoch: payload.epoch, sequence: Math.max(0, payload.nextSequence - 1) };
        this.context.onResnapshotRequired?.({
          enrollmentId: this.enrollmentId,
          reason: payload.reason,
        });
        this.finish(new Error('machine-resnapshot-required'));
        return;
      case 'session.revoked':
        this.finish(
          new Error(payload.reason === 'expired' ? 'machine-session-expired' : 'device-denied'),
        );
        return;
      case 'error': {
        const id = payload.requestId ?? outerRequestId;
        const pending = id === undefined ? undefined : this.pending.get(id);
        if (pending !== undefined) {
          this.pending.delete(id as string);
          clearTimeout(pending.timer);
          pending.reject(new Error(`machine-${payload.code}`));
        }
        return;
      }
      default: {
        const unhandled: never = payload;
        throw new Error(`unknown-machine-payload:${String(unhandled)}`);
      }
    }
  }

  addWorkspace(workspaceId: string): void {
    if (workspaceId.trim() === '') return;
    this.workspaces.add(workspaceId);
    if (this.readyState)
      void this.subscribe().catch(() => this.finish(new Error('machine-subscribe-failed')));
  }

  async request<T = unknown>(
    operation: MeshMachineOperation,
    payload: unknown,
    requestId = nextMeshMachineRequestId(),
  ): Promise<T> {
    await this.readyPromise;
    if (this.terminated) throw new Error('machine-session-closed');
    return this.sendRequest<T>({ kind: 'request', requestId, operation, payload });
  }

  private async sendRequest<T>(
    payload: Extract<
      MeshMachineClientPayload,
      { kind: 'request' | 'subscribe' | 'refresh' | 'ping' }
    >,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(payload.requestId);
        reject(new Error('machine-request-timeout'));
      }, 15_000);
      this.pending.set(payload.requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      void this.sendControl(payload).catch((error: unknown) => {
        const pending = this.pending.get(payload.requestId);
        if (pending === undefined) return;
        this.pending.delete(payload.requestId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('machine-send-failed'));
      });
    });
  }

  get isOpen(): boolean {
    return this.readyState && !this.terminated;
  }

  get streamCursor(): MeshMachineCursor | null {
    return this.cursor === null ? null : { ...this.cursor };
  }

  private async subscribe(): Promise<void> {
    const revision = ++this.subscriptionRevision;
    const payload: Extract<MeshMachineClientPayload, { kind: 'subscribe' }> = {
      kind: 'subscribe',
      requestId: nextMeshMachineRequestId(),
      ...(this.cursor === null ? {} : { cursor: this.cursor }),
      ...(this.workspaces.size === 0 ? {} : { workspaceIds: [...this.workspaces].sort() }),
    };
    if (!this.supportsHandoff) {
      await this.sendControl(payload);
      return;
    }
    const result = await this.sendRequest<unknown>(payload);
    if (revision !== this.subscriptionRevision || this.terminated) return;
    if (
      !isRecord(result) ||
      result.replayComplete !== true ||
      !isRecord(result.cursor) ||
      result.cursor.epoch !== this.epoch ||
      !Number.isSafeInteger(result.cursor.sequence) ||
      (result.cursor.sequence as number) < 0
    )
      throw new Error('machine-subscribe-incomplete');
    this.cursor = {
      epoch: this.epoch,
      sequence: Math.max(this.cursor?.sequence ?? 0, result.cursor.sequence as number),
    };
    this.resolveReady();
  }

  private async sendControl(payload: MeshMachineClientPayload): Promise<void> {
    if (!this.readyState || this.terminated) throw new Error('machine-session-closed');
    const sequence = this.clientSequence;
    try {
      const envelope = sealMeshMachineFrame({
        key: this.clientToHostKey,
        sessionId: this.sessionId,
        machineId: this.machineId,
        endpointGeneration: this.endpointGeneration,
        epoch: this.epoch,
        direction: 'client-to-host',
        requestId: payload.requestId,
        sequence,
        payload,
      });
      const frame = JSON.stringify({
        type: 'data',
        sessionId: this.sessionId,
        requestId: payload.requestId,
        sequence,
        envelope,
      });
      this.clientSequence = sequence + 1;
      this.socket.send(frame);
    } catch {
      // A failed send has an unknown wire outcome. Never reuse a possibly skipped sequence.
      const error = new Error('machine-send-failed');
      this.finish(error);
      throw error;
    }
  }

  close(code = 1000, reason = 'client-close'): void {
    this.finish(new Error('machine-session-closed'), true, code, reason);
  }

  private finish(error: Error, intentional = false, code = 1000, reason = 'session-ended'): void {
    if (this.terminated) return;
    this.terminated = true;
    this.rejectReady(error);
    this.failPending(error);
    this.cleanup();
    try {
      this.socket.close(code, reason);
    } catch {
      /* Already closed. */
    }
    if (!intentional) {
      try {
        this.context.onClosed?.(this.enrollmentId, error.message);
      } catch {
        // The terminal state and pending request failures do not depend on observer behavior.
      }
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private cleanup(): void {
    this.readyState = false;
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.clientToHostKey.fill(0);
    this.hostToClientKey.fill(0);
    this.retainedToken?.fill(0);
    this.retainedToken = null;
  }
}

function socketMessageText(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data))
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return null;
}

function deriveMachineTrafficKey(
  sessionToken: Buffer,
  input: {
    sessionId: string;
    machineId: string;
    endpointGeneration: string;
    direction: 'client-to-host' | 'host-to-client';
  },
): Buffer {
  const derivation = meshMachineTrafficKeyDerivation(input);
  return Buffer.from(
    hkdfSync(
      'sha256',
      sessionToken,
      Buffer.from(derivation.salt, 'utf8'),
      Buffer.from(derivation.info, 'utf8'),
      32,
    ),
  );
}

const CLIENT_MACHINE_OPERATIONS: readonly MeshMachineOperation[] = [
  'read.snapshot',
  'read.job',
  'read.events',
  'read.chat-threads',
  'read.thread-history',
  'read.workspace-signal-detail',
  'read.chat-skills',
  'read.file-mentions',
  'read.attachment',
  'read.carplay-snapshot',
  'read.carplay-approval',
  'command.submit',
  'command.approve',
  'command.cancel',
  'command.steer',
  'command.prepare-attachments',
  'command.open-desktop',
  'command.attachment.begin',
  'command.attachment.chunk',
  'command.attachment.finish',
  'command.carplay-pause',
  'command.carplay-pause-all',
  'command.carplay-approval',
  'command.carplay-note',
  'command.carplay-handover',
];

/** Opens a one-use, proof-bound session to an advertised host over safe routes. */
export async function connectMeshMachineHost(
  host: MeshMachineHost,
  context: MeshMachineAdmissionContext,
  now = Date.now(),
): Promise<MeshMachineSessionConnection> {
  const fetchImpl = context.fetchFn ?? fetch;
  try {
    return await connectMeshRoutes({
      routes: meshMachineRouteCandidates(host, now),
      signal: context.signal,
      probe: async (route, signal) => {
        const value = await fetchMachineJson(
          fetchImpl,
          meshMachineRouteUrl(route, MESH_MACHINE_ROUTE_PATHS.info),
          { method: 'GET', signal },
        );
        const info = parseMeshMachineEndpointInfo(value);
        if (
          info === null ||
          info.hostEnrollmentId !== host.enrollmentId ||
          info.machineId !== host.machineId ||
          info.endpointGeneration !== host.endpointGeneration ||
          !info.capabilities.includes('machine.session/1') ||
          !info.capabilities.includes('machine.stream/1')
        ) {
          throw new Error('protocol-mismatch');
        }
        return info;
      },
      connect: (route, info, signal) => {
        if (Date.parse(route.reachableUntil) <= Date.now()) throw new Error('route-unavailable');
        return bootstrapMachineRoute(host, route, info, { ...context, signal }, fetchImpl);
      },
      dispose: (connection) => connection.close(),
    });
  } catch (error) {
    if (context.signal?.aborted) throw new Error('machine-session-cancelled');
    if (
      error instanceof Error &&
      (error.message === 'protocol-mismatch' || safeMachineErrorCode(error) !== undefined)
    )
      throw error;
    throw new Error('route-unavailable');
  }
}

async function bootstrapMachineRoute(
  host: MeshMachineHost,
  route: MeshMachineRoute,
  info: MeshMachineEndpointInfo,
  context: MeshMachineAdmissionContext,
  fetchImpl: typeof fetch,
): Promise<MeshMachineSessionConnection> {
  const identity = newMeshMachineEphemeralIdentity();
  const bootstrapChallenge = randomBytes(32).toString('base64url');
  const capabilities = (
    ['machine.session/1', 'machine.stream/1', 'machine.stream-handoff/1'] as const
  ).filter((capability) => host.capabilities.includes(capability));
  const operations = CLIENT_MACHINE_OPERATIONS.filter((operation) =>
    host.operations.includes(operation),
  );
  if (
    !capabilities.includes('machine.session/1') ||
    !capabilities.includes('machine.stream/1') ||
    operations.length === 0
  ) {
    throw new Error('protocol-mismatch');
  }
  const issueRequest: MeshMachineAdmissionIssueRequest = {
    kind: 'enrollment',
    endpointGeneration: host.endpointGeneration,
    clientPublicKey: identity.clientPublicKey,
    requestedCapabilities: capabilities,
    operations,
    scopes: [],
    bootstrapChallenge,
    requestId: nextMeshMachineRequestId(),
  };
  const apiUrl = safeAdmissionApiUrl(context.apiUrl);
  const ticketResponse = (await fetchMachineJson(
    fetchImpl,
    new URL(`mesh/hosts/${encodeURIComponent(host.machineId)}/admission-tickets`, apiUrl).href,
    {
      method: 'POST',
      signal: context.signal,
      headers: {
        authorization: `Bearer ${context.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(issueRequest),
    },
  )) as MeshMachineAdmissionIssueResponse;
  if (
    !isRecord(ticketResponse) ||
    ticketResponse.v !== 1 ||
    typeof ticketResponse.ticket !== 'string' ||
    ticketResponse.ticket.length < 32 ||
    !isRecord(ticketResponse.claims) ||
    !isRecord(ticketResponse.claims.principal) ||
    ticketResponse.claims.principal.kind !== 'enrollment' ||
    ticketResponse.claims.accountId !== context.accountId ||
    ticketResponse.claims.hostEnrollmentId !== host.enrollmentId ||
    ticketResponse.claims.principal.sourceEnrollmentId !== context.enrollmentId ||
    ticketResponse.claims.hostMachineId !== host.machineId ||
    ticketResponse.claims.endpointGeneration !== host.endpointGeneration ||
    ticketResponse.claims.clientPublicKey !== identity.clientPublicKey ||
    ticketResponse.claims.bootstrapChallenge !== bootstrapChallenge ||
    Date.parse(String(ticketResponse.claims.expiresAt)) <= Date.now() ||
    !isRecord(ticketResponse.sealedProofKey)
  ) {
    throw new Error('authorization-unavailable');
  }
  const claims = ticketResponse.claims as unknown as Extract<
    MeshMachineAdmissionIssueResponse['claims'],
    { principal: { kind: 'enrollment' } }
  >;
  const proofKey = openMeshSealedBytes(
    identity.privateKey,
    identity.clientPublicRaw,
    ticketResponse.sealedProofKey as { enc: string; ephPub: string; nonce: string; ct: string },
    meshMachineAdmissionProofKeyAssociatedData(claims),
  );
  if (proofKey.byteLength !== 32) {
    proofKey.fill(0);
    throw new Error('authorization-unavailable');
  }

  let challenge: MeshMachineBootstrapChallenge;
  try {
    challenge = (await fetchMachineJson(
      fetchImpl,
      meshMachineRouteUrl(route, MESH_MACHINE_ROUTE_PATHS.challenge),
      {
        method: 'POST',
        signal: context.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          v: 1,
          mode: 'admission',
          ticket: ticketResponse.ticket,
          clientPublicKey: identity.clientPublicKey,
        }),
      },
    )) as MeshMachineBootstrapChallenge;
    if (
      !isRecord(challenge) ||
      challenge.v !== 1 ||
      challenge.mode !== 'admission' ||
      typeof challenge.challengeId !== 'string' ||
      challenge.nonce !== bootstrapChallenge ||
      challenge.machineId !== host.machineId ||
      challenge.endpointGeneration !== host.endpointGeneration ||
      challenge.clientPublicKey !== identity.clientPublicKey ||
      !isRecord(challenge.claims) ||
      meshMachineAdmissionClaimsCanonicalJson(challenge.claims as typeof claims) !==
        meshMachineAdmissionClaimsCanonicalJson(claims)
    ) {
      throw new Error('protocol-mismatch');
    }
    const proof = createMeshMachineMac(
      proofKey,
      meshMachineAdmissionBootstrapProofMessage({
        claims,
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
      }),
    );
    const bootstrap = (await fetchMachineJson(
      fetchImpl,
      meshMachineRouteUrl(route, MESH_MACHINE_ROUTE_PATHS.bootstrap),
      {
        method: 'POST',
        signal: context.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, challengeId: challenge.challengeId, proof }),
      },
    )) as MeshMachineBootstrapResponse;
    if (
      !isRecord(bootstrap) ||
      bootstrap.v !== 1 ||
      typeof bootstrap.sessionId !== 'string' ||
      typeof bootstrap.hostProof !== 'string' ||
      !isRecord(bootstrap.sessionClaims) ||
      bootstrap.sessionClaims.accountId !== context.accountId ||
      bootstrap.sessionClaims.machineId !== host.machineId ||
      bootstrap.sessionClaims.endpointGeneration !== host.endpointGeneration ||
      bootstrap.sessionClaims.sessionId !== bootstrap.sessionId ||
      !isRecord(bootstrap.sessionClaims.principal) ||
      bootstrap.sessionClaims.principal.kind !== 'enrollment' ||
      bootstrap.sessionClaims.principal.sourceEnrollmentId !== context.enrollmentId ||
      !isRecord(bootstrap.sessionToken) ||
      !isRecord(bootstrap.stream) ||
      typeof bootstrap.stream.epoch !== 'string' ||
      !Number.isSafeInteger(bootstrap.stream.nextSequence)
    ) {
      throw new Error('protocol-mismatch');
    }
    const { hostProof, ...responseWithoutHostProof } = bootstrap;
    const hostProofMessage = meshMachineBootstrapHostProofMessage({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      response: responseWithoutHostProof,
    });
    if (!verifyMeshMachineMac(proofKey, hostProofMessage, hostProof)) {
      throw new Error('authorization-unavailable');
    }
    proofKey.fill(0);
    const sessionToken = openMeshSealedBytes(
      identity.privateKey,
      identity.clientPublicRaw,
      bootstrap.sessionToken,
      meshMachineSessionTokenAssociatedData(bootstrap.sessionClaims),
    );
    let socket: MeshMachineWebSocketLike | undefined;
    try {
      if (sessionToken.byteLength !== 32) throw new Error('authorization-unavailable');
      if (context.signal?.aborted) throw new Error('machine-session-cancelled');
      socket = (context.socketFactory ?? createMachineSocket)(
        meshMachineRouteUrl(route, info.transport.socketPath, true),
        machineSocketProtocol(),
      );
      return await MeshMachineSessionConnection.open({
        host,
        route,
        context,
        socket,
        sessionId: bootstrap.sessionId,
        sessionToken,
        epoch: bootstrap.stream.epoch,
        clientSequence: 1,
        authorizationValidUntil: bootstrap.authorizationValidUntil,
      });
    } catch (error) {
      try {
        socket?.close();
      } catch {
        /* Already closed. */
      }
      throw error;
    } finally {
      sessionToken.fill(0);
    }
  } catch (error) {
    proofKey.fill(0);
    throw error;
  }
}

function safeAdmissionApiUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !url.pathname.endsWith('/')
  ) {
    throw new Error('authorization-unavailable');
  }
  return url;
}

async function fetchMachineJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  if (init.signal?.aborted) throw new Error('machine-session-cancelled');
  const controller = new AbortController();
  const response = await fetchImpl(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(10_000),
      ...(init.signal ? [init.signal] : []),
    ]),
    headers: { accept: 'application/json', ...init.headers },
  });
  if (init.signal?.aborted) {
    controller.abort();
    void response.body?.cancel().catch(() => undefined);
    throw new Error('machine-session-cancelled');
  }
  const bodyBytes = await readBoundedResponseBody(
    response,
    MESH_MACHINE_MAX_FRAME_BYTES,
    controller,
  );
  const body = bodyBytes.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new Error(response.ok ? 'machine-response-malformed' : 'route-unavailable');
  }
  if (!response.ok) {
    if (
      response.status === 403 &&
      isRecord(parsed) &&
      typeof parsed['code'] === 'string' &&
      SAFE_MACHINE_ERROR_CODES.has(parsed['code'])
    ) {
      throw new Error(parsed['code']);
    }
    throw new Error('route-unavailable');
  }
  return parsed;
}

async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
  controller: AbortController,
): Promise<Buffer> {
  const body = response.body;
  if (body === null) {
    throw new Error(response.ok ? 'machine-response-malformed' : 'route-unavailable');
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        const error = new Error('machine-response-too-large');
        controller.abort(error);
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}
