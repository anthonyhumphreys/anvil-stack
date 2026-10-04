import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as Crypto from 'expo-crypto';
import {
  MESH_MACHINE_MAX_FRAME_BYTES,
  MESH_MACHINE_PROTOCOL_VERSION,
  MESH_MACHINE_ROUTE_PATHS,
  MESH_MACHINE_SESSION_REFRESH_INTERVAL_MS,
  MESH_MACHINE_SOCKET_SUBPROTOCOL,
  meshMachineAdmissionBootstrapProofMessage,
  meshMachineAdmissionProofKeyAssociatedData,
  meshMachineAdmissionClaimsCanonicalJson,
  meshMachineBootstrapHostProofMessage,
  meshMachineFrameAssociatedData,
  meshMachineSessionTokenAssociatedData,
  meshMachineSocketProofMessage,
  meshMachineTrafficKeyDerivation,
  type MeshMachineAdmissionIssueRequest,
  type MeshMachineAdmissionIssueResponse,
  type MeshMachineBootstrapChallenge,
  type MeshMachineBootstrapResponse,
  type MeshMachineHost,
  type MeshMachineOperation,
  type MeshMachineRoute,
  type MeshMachineServerPayload,
} from '../../cloud/contract/machine';
import { getAccountConnection, listMeshMachineHosts } from './anvil-account';

const encoder = new TextEncoder();
const WRAP_INFO = encoder.encode('anvil/keyring-wrap/v1');
const ACCOUNT_REQUEST_TIMEOUT_MS = 10_000;
const pendingConnections = new Map<string, Promise<MeshMachineSessionConnection>>();
const activeConnections = new Map<string, MeshMachineSessionConnection>();

export interface MeshMachineEvent {
  epoch: string;
  sequence: number;
  workspaceId: string;
  jobId?: string;
  eventKind: string;
  payload: unknown;
}

export interface MeshMachineEventHandlers {
  onEvent(event: MeshMachineEvent): void;
  onResnapshot(reason: 'epoch-changed' | 'cursor-expired' | 'sequence-gap'): void;
  onClosed(): void;
}

export class MeshMachineRequestError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'MeshMachineRequestError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function randomId(): string {
  return Crypto.randomUUID();
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string, expectedBytes?: number): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new MeshMachineRequestError('malformed-base64');
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (
    encodeBase64(bytes) !== value ||
    (expectedBytes !== undefined && bytes.length !== expectedBytes)
  ) {
    throw new MeshMachineRequestError('malformed-base64');
  }
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function constantTimeTextEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function privateRouteHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || /^(?:fc|fd|fe[89ab])/i.test(host)) return true;
  const octets = host.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return (
    octets[0] === 10 ||
    (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127) ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 169 && octets[1] === 254) ||
    octets[0] === 127
  );
}

/** A route is usable only while its broker advertisement is fresh and target-bound. */
export function isUsableMeshMachineRoute(
  host: MeshMachineHost,
  route: MeshMachineRoute,
  now = Date.now(),
): boolean {
  if (
    route.machineId !== host.machineId ||
    route.endpointGeneration !== host.endpointGeneration ||
    !Number.isFinite(Date.parse(route.reachableUntil)) ||
    Date.parse(route.reachableUntil) <= now
  ) {
    return false;
  }
  try {
    const url = new URL(route.url);
    const isPrivate = privateRouteHost(url.hostname);
    return (
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      (url.pathname === '/' || url.pathname === '') &&
      (url.protocol === 'https:' ||
        (route.kind === 'private' && url.protocol === 'http:' && isPrivate)) &&
      (route.kind !== 'managed' || url.protocol === 'https:')
    );
  } catch {
    return false;
  }
}

export function meshMachineRouteCandidates(
  host: MeshMachineHost,
  now = Date.now(),
): MeshMachineRoute[] {
  const order: Record<MeshMachineRoute['kind'], number> = { private: 0, https: 1, managed: 2 };
  return host.routes
    .filter((route) => isUsableMeshMachineRoute(host, route, now))
    .sort((left, right) => order[left.kind] - order[right.kind]);
}

function safeAccountApiUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !url.pathname.endsWith('/')
  ) {
    throw new MeshMachineRequestError('account-api-requires-https');
  }
  return url;
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ACCOUNT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MESH_MACHINE_MAX_FRAME_BYTES) {
      throw new MeshMachineRequestError('machine-response-too-large');
    }
    let payload: unknown;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      throw new MeshMachineRequestError('machine-response-malformed');
    }
    if (!response.ok) {
      const errorCode =
        isRecord(payload) && typeof payload.code === 'string'
          ? payload.code
          : isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === 'string'
            ? payload.error.code
            : null;
      if (errorCode === 'approval-required' || errorCode === 'device-denied') {
        throw new MeshMachineRequestError(errorCode);
      }
      throw new MeshMachineRequestError(`machine-http-${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function hmacSha256(key: Uint8Array, message: string): Promise<Uint8Array> {
  return hmac(sha256, key, encoder.encode(message));
}

async function openSealedValue(
  privateKey: Uint8Array,
  clientPublicKey: Uint8Array,
  envelope: { enc: string; ephPub: string; nonce: string; ct: string },
  associatedData: string,
): Promise<Uint8Array> {
  if (envelope.enc !== 'x25519-aes-256-gcm') {
    throw new MeshMachineRequestError('unsupported-mesh-seal');
  }
  const ephemeralPublicKey = decodeBase64(envelope.ephPub, 32);
  const nonce = decodeBase64(envelope.nonce, 12);
  const ciphertextWithTag = decodeBase64(envelope.ct);
  if (ciphertextWithTag.length < 16) throw new MeshMachineRequestError('invalid-mesh-seal');
  const shared = x25519.getSharedSecret(privateKey, ephemeralPublicKey);
  const wrappingKey = hkdf(
    sha256,
    shared,
    concatBytes(ephemeralPublicKey, clientPublicKey),
    WRAP_INFO,
    32,
  );
  shared.fill(0);
  try {
    const key = await Crypto.AESEncryptionKey.import(wrappingKey);
    const sealed = Crypto.AESSealedData.fromParts(nonce, ciphertextWithTag, 16);
    const plaintext = await Crypto.aesDecryptAsync(sealed, key, {
      additionalData: encoder.encode(associatedData),
      output: 'bytes',
    });
    if (typeof plaintext === 'string') throw new MeshMachineRequestError('invalid-mesh-seal');
    return plaintext;
  } catch {
    throw new MeshMachineRequestError('invalid-mesh-seal');
  } finally {
    wrappingKey.fill(0);
  }
}

function validateAdmissionResponse(
  value: unknown,
  expected: {
    host: MeshMachineHost;
    accountId: string;
    sourceEnrollmentId: string;
    clientPublicKey: string;
    bootstrapChallenge: string;
  },
): MeshMachineAdmissionIssueResponse {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    typeof value.ticket !== 'string' ||
    value.ticket.length < 32 ||
    !isRecord(value.claims) ||
    !isRecord(value.claims.principal) ||
    value.claims.principal.kind !== 'enrollment' ||
    typeof value.claims.accountId !== 'string' ||
    value.claims.accountId !== expected.accountId ||
    value.claims.hostEnrollmentId !== expected.host.enrollmentId ||
    value.claims.hostMachineId !== expected.host.machineId ||
    value.claims.endpointGeneration !== expected.host.endpointGeneration ||
    value.claims.clientPublicKey !== expected.clientPublicKey ||
    value.claims.bootstrapChallenge !== expected.bootstrapChallenge ||
    value.claims.principal.sourceEnrollmentId !== expected.sourceEnrollmentId ||
    Date.parse(String(value.claims.expiresAt)) <= Date.now() ||
    !isRecord(value.sealedProofKey) ||
    typeof value.sealedProofKey.enc !== 'string' ||
    typeof value.sealedProofKey.ephPub !== 'string' ||
    typeof value.sealedProofKey.nonce !== 'string' ||
    typeof value.sealedProofKey.ct !== 'string'
  ) {
    throw new MeshMachineRequestError('authorization-unavailable');
  }
  if (!isRecord(value.claims) || !isRecord(value.claims.principal)) {
    throw new MeshMachineRequestError('authorization-unavailable');
  }
  const claims = value.claims;
  const principal = claims.principal as Record<string, unknown>;
  if (
    claims.v !== 1 ||
    typeof claims.issuedAt !== 'string' ||
    !Number.isFinite(Date.parse(claims.issuedAt)) ||
    !Array.isArray(principal['requestedCapabilities']) ||
    !principal['requestedCapabilities'].every((item: unknown) => typeof item === 'string') ||
    !Array.isArray(principal['operations']) ||
    !principal['operations'].every((item: unknown) => typeof item === 'string') ||
    !Array.isArray(principal['scopes']) ||
    !principal['scopes'].every((item: unknown) => typeof item === 'string')
  ) {
    throw new MeshMachineRequestError('authorization-unavailable');
  }
  return value as unknown as MeshMachineAdmissionIssueResponse;
}

function validateBootstrapChallenge(
  value: unknown,
  host: MeshMachineHost,
  ticketClaims: MeshMachineAdmissionIssueResponse['claims'],
  clientPublicKey: string,
  bootstrapChallenge: string,
): MeshMachineBootstrapChallenge {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    value.mode !== 'admission' ||
    typeof value.challengeId !== 'string' ||
    typeof value.nonce !== 'string' ||
    value.nonce !== bootstrapChallenge ||
    typeof value.epoch !== 'string' ||
    value.machineId !== host.machineId ||
    value.endpointGeneration !== host.endpointGeneration ||
    value.clientPublicKey !== clientPublicKey ||
    !isRecord(value.claims)
  ) {
    throw new MeshMachineRequestError('machine-protocol-mismatch');
  }
  try {
    if (
      meshMachineAdmissionClaimsCanonicalJson(
        value.claims as unknown as MeshMachineAdmissionIssueResponse['claims'],
      ) !== meshMachineAdmissionClaimsCanonicalJson(ticketClaims)
    ) {
      throw new Error('claims mismatch');
    }
  } catch {
    throw new MeshMachineRequestError('machine-protocol-mismatch');
  }
  return value as unknown as MeshMachineBootstrapChallenge;
}

function validateBootstrapResponse(
  value: unknown,
  host: MeshMachineHost,
  accountId: string,
  sourceEnrollmentId: string,
): MeshMachineBootstrapResponse {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    typeof value.sessionId !== 'string' ||
    value.machineId !== host.machineId ||
    value.endpointGeneration !== host.endpointGeneration ||
    !isRecord(value.sessionToken) ||
    value.sessionToken.enc !== 'x25519-aes-256-gcm' ||
    !isRecord(value.sessionClaims) ||
    value.sessionClaims.accountId !== accountId ||
    value.sessionClaims.machineId !== host.machineId ||
    value.sessionClaims.endpointGeneration !== host.endpointGeneration ||
    value.sessionClaims.sessionId !== value.sessionId ||
    !isRecord(value.sessionClaims.principal) ||
    value.sessionClaims.principal.kind !== 'enrollment' ||
    value.sessionClaims.principal.accountId !== accountId ||
    value.sessionClaims.principal.sourceEnrollmentId !== sourceEnrollmentId ||
    !['observe', 'approve', 'steer'].includes(String(value.sessionClaims.principal.tier)) ||
    typeof value.authorizationValidUntil !== 'string' ||
    !Number.isFinite(Date.parse(value.authorizationValidUntil)) ||
    Date.parse(value.authorizationValidUntil) <= Date.now() ||
    !isRecord(value.stream) ||
    typeof value.stream.epoch !== 'string' ||
    !Number.isSafeInteger(value.stream.nextSequence) ||
    !Number.isSafeInteger(value.stream.oldestSequence) ||
    (value.stream.nextSequence as number) < 1 ||
    (value.stream.oldestSequence as number) < 1 ||
    (value.stream.oldestSequence as number) > (value.stream.nextSequence as number) ||
    typeof value.sessionExpiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.sessionExpiresAt)) ||
    Date.parse(value.sessionExpiresAt) <= Date.now() ||
    typeof value.hostProof !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.hostProof) ||
    typeof value.sessionToken.ephPub !== 'string' ||
    typeof value.sessionToken.nonce !== 'string' ||
    typeof value.sessionToken.ct !== 'string'
  ) {
    throw new MeshMachineRequestError('machine-protocol-mismatch');
  }
  return value as unknown as MeshMachineBootstrapResponse;
}

async function bootstrapRoute(
  host: MeshMachineHost,
  route: MeshMachineRoute,
  account: NonNullable<Awaited<ReturnType<typeof getAccountConnection>>>,
  info: unknown,
): Promise<MeshMachineSessionConnection> {
  if (
    !isRecord(info) ||
    info.protocolVersion !== MESH_MACHINE_PROTOCOL_VERSION ||
    info.machineId !== host.machineId ||
    info.endpointGeneration !== host.endpointGeneration ||
    info.hostEnrollmentId !== host.enrollmentId ||
    !Array.isArray(info.capabilities) ||
    !info.capabilities.includes('machine.session/1') ||
    !info.capabilities.includes('machine.stream/1') ||
    !isRecord(info.transport) ||
    info.transport.socketPath !== MESH_MACHINE_ROUTE_PATHS.socket
  ) {
    throw new MeshMachineRequestError('machine-protocol-mismatch');
  }
  const clientSecretKey = await Crypto.getRandomBytesAsync(32);
  const clientPublicKeyBytes = x25519.getPublicKey(clientSecretKey);
  const clientPublicKey = encodeBase64(clientPublicKeyBytes);
  const bootstrapChallenge = encodeBase64Url(await Crypto.getRandomBytesAsync(32));
  const operations: MeshMachineOperation[] = (
    [
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
    ] as MeshMachineOperation[]
  ).filter((operation) => host.operations.includes(operation));
  const capabilities = (['machine.session/1', 'machine.stream/1'] as const).filter((capability) =>
    host.capabilities.includes(capability),
  );
  if (
    operations.length === 0 ||
    !capabilities.includes('machine.session/1') ||
    !capabilities.includes('machine.stream/1')
  ) {
    clientSecretKey.fill(0);
    throw new MeshMachineRequestError('machine-protocol-mismatch');
  }
  const ticketRequest: MeshMachineAdmissionIssueRequest = {
    kind: 'enrollment',
    endpointGeneration: host.endpointGeneration,
    clientPublicKey,
    requestedCapabilities: capabilities,
    operations,
    scopes: [],
    bootstrapChallenge,
    requestId: randomId(),
  };
  let proofKey: Uint8Array | null = null;
  let sessionToken: Uint8Array | null = null;
  try {
    const apiBase = safeAccountApiUrl(account.apiUrl);
    const issueUrl = new URL(
      `mesh/hosts/${encodeURIComponent(host.machineId)}/admission-tickets`,
      apiBase,
    );
    const ticketValue = await fetchJson(issueUrl.href, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${account.session.accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(ticketRequest),
    });
    const ticket = validateAdmissionResponse(ticketValue, {
      host,
      accountId: account.session.accountId,
      sourceEnrollmentId: account.session.enrollmentId,
      clientPublicKey,
      bootstrapChallenge,
    });
    proofKey = await openSealedValue(
      clientSecretKey,
      clientPublicKeyBytes,
      ticket.sealedProofKey!,
      meshMachineAdmissionProofKeyAssociatedData(ticket.claims),
    );
    if (proofKey.length !== 32) throw new MeshMachineRequestError('authorization-unavailable');

    const challengeValue = await fetchJson(
      new URL(MESH_MACHINE_ROUTE_PATHS.challenge, route.url).href,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          v: 1,
          mode: 'admission',
          ticket: ticket.ticket,
          clientPublicKey,
        }),
      },
    );
    const challenge = validateBootstrapChallenge(
      challengeValue,
      host,
      ticket.claims,
      clientPublicKey,
      bootstrapChallenge,
    );
    const proof = encodeBase64Url(
      await hmacSha256(
        proofKey,
        meshMachineAdmissionBootstrapProofMessage({
          claims: ticket.claims,
          challengeId: challenge.challengeId,
          nonce: challenge.nonce,
        }),
      ),
    );
    const bootstrapValue = await fetchJson(
      new URL(MESH_MACHINE_ROUTE_PATHS.bootstrap, route.url).href,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ v: 1, challengeId: challenge.challengeId, proof }),
      },
    );
    const bootstrap = validateBootstrapResponse(
      bootstrapValue,
      host,
      account.session.accountId,
      account.session.enrollmentId,
    );
    const responseWithoutHostProof = {
      v: bootstrap.v,
      sessionId: bootstrap.sessionId,
      sessionToken: {
        enc: bootstrap.sessionToken.enc,
        ephPub: bootstrap.sessionToken.ephPub,
        nonce: bootstrap.sessionToken.nonce,
        ct: bootstrap.sessionToken.ct,
      },
      sessionClaims: {
        accountId: bootstrap.sessionClaims.accountId,
        principal: bootstrap.sessionClaims.principal,
        machineId: bootstrap.sessionClaims.machineId,
        endpointGeneration: bootstrap.sessionClaims.endpointGeneration,
        sessionId: bootstrap.sessionClaims.sessionId,
      },
      machineId: bootstrap.machineId,
      endpointGeneration: bootstrap.endpointGeneration,
      sessionExpiresAt: bootstrap.sessionExpiresAt,
      authorizationValidUntil: bootstrap.authorizationValidUntil,
      stream: {
        epoch: bootstrap.stream.epoch,
        nextSequence: bootstrap.stream.nextSequence,
        oldestSequence: bootstrap.stream.oldestSequence,
      },
    };
    const hostProofKey = proofKey;
    if (hostProofKey === null) throw new MeshMachineRequestError('authorization-unavailable');
    const expectedHostProof = encodeBase64Url(
      await hmacSha256(
        hostProofKey,
        meshMachineBootstrapHostProofMessage({
          challengeId: challenge.challengeId,
          nonce: challenge.nonce,
          response: responseWithoutHostProof,
        }),
      ),
    );
    if (!constantTimeTextEqual(expectedHostProof, bootstrap.hostProof)) {
      throw new MeshMachineRequestError('authorization-unavailable');
    }
    hostProofKey.fill(0);
    proofKey = null;
    sessionToken = await openSealedValue(
      clientSecretKey,
      clientPublicKeyBytes,
      bootstrap.sessionToken,
      meshMachineSessionTokenAssociatedData(bootstrap.sessionClaims),
    );
    if (sessionToken.length !== 32) throw new MeshMachineRequestError('authorization-unavailable');
    const socketUrl = new URL(info.transport.socketPath, route.url);
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(socketUrl.href, MESH_MACHINE_SOCKET_SUBPROTOCOL);
    const connection = await MeshMachineSessionConnection.open({
      host,
      route,
      socket,
      sessionId: bootstrap.sessionId,
      sessionToken,
      epoch: bootstrap.stream.epoch,
      authorizationValidUntil: bootstrap.authorizationValidUntil,
      onUnauthorizedClose: () => {},
    });
    sessionToken = null;
    return connection;
  } finally {
    clientSecretKey.fill(0);
    proofKey?.fill(0);
    sessionToken?.fill(0);
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class MeshMachineSessionConnection {
  readonly host: MeshMachineHost;
  readonly route: MeshMachineRoute;
  private readonly socket: WebSocket;
  private readonly sessionId: string;
  private readonly sessionToken: Uint8Array;
  private readonly clientToHostKey: Uint8Array;
  private readonly hostToClientKey: Uint8Array;
  private readonly epoch: string;
  private clientSequence = 1;
  private serverSequence = 1;
  private cursor: { epoch: string; sequence: number } | null = null;
  private ready = false;
  private closed = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private eventHandlers = new Set<MeshMachineEventHandlers>();
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly readyPromise: Promise<void>;
  private authorizationValidUntil: string;
  private readonly onUnauthorizedClose: () => void;

  private constructor(input: {
    host: MeshMachineHost;
    route: MeshMachineRoute;
    socket: WebSocket;
    sessionId: string;
    sessionToken: Uint8Array;
    epoch: string;
    authorizationValidUntil: string;
    onUnauthorizedClose: () => void;
  }) {
    this.host = input.host;
    this.route = input.route;
    this.socket = input.socket;
    this.sessionId = input.sessionId;
    this.sessionToken = input.sessionToken;
    this.epoch = input.epoch;
    this.authorizationValidUntil = input.authorizationValidUntil;
    this.onUnauthorizedClose = input.onUnauthorizedClose;
    const derivation = (direction: 'client-to-host' | 'host-to-client') =>
      meshMachineTrafficKeyDerivation({
        sessionId: this.sessionId,
        machineId: this.host.machineId,
        endpointGeneration: this.host.endpointGeneration,
        direction,
      });
    const clientInfo = derivation('client-to-host');
    const hostInfo = derivation('host-to-client');
    this.clientToHostKey = hkdf(
      sha256,
      this.sessionToken,
      encoder.encode(clientInfo.salt),
      encoder.encode(clientInfo.info),
      32,
    );
    this.hostToClientKey = hkdf(
      sha256,
      this.sessionToken,
      encoder.encode(hostInfo.salt),
      encoder.encode(hostInfo.info),
      32,
    );
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  static async open(input: {
    host: MeshMachineHost;
    route: MeshMachineRoute;
    socket: WebSocket;
    sessionId: string;
    sessionToken: Uint8Array;
    epoch: string;
    authorizationValidUntil: string;
    onUnauthorizedClose: () => void;
  }): Promise<MeshMachineSessionConnection> {
    const connection = new MeshMachineSessionConnection(input);
    connection.attach();
    try {
      await connection.readyPromise;
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  private attach(): void {
    this.socket.addEventListener('message', (event) => {
      void this.handleMessage(event.data).catch((error: unknown) => {
        const failure =
          error instanceof Error ? error : new MeshMachineRequestError('machine-protocol');
        this.rejectReady(failure);
        this.failPending(failure);
        this.close();
      });
    });
    this.socket.addEventListener('error', () => {
      const error = new MeshMachineRequestError('machine-socket-error');
      this.rejectReady(error);
      this.failPending(error);
      this.close();
    });
    this.socket.addEventListener('close', () => {
      if (!this.closed) this.failPending(new MeshMachineRequestError('machine-session-closed'));
      this.closed = true;
      this.cleanup();
      for (const handler of this.eventHandlers) handler.onClosed();
      this.eventHandlers.clear();
    });
    const timeout = setTimeout(() => {
      this.rejectReady(new MeshMachineRequestError('machine-session-timeout'));
      this.close();
    }, 15_000);
    void this.readyPromise.finally(() => clearTimeout(timeout)).catch(() => undefined);
  }

  private async handleMessage(data: unknown): Promise<void> {
    const raw =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(data)
          : null;
    if (raw === null || encoder.encode(raw).byteLength > MESH_MACHINE_MAX_FRAME_BYTES) {
      throw new MeshMachineRequestError('machine-frame-too-large');
    }
    let frame: unknown;
    try {
      frame = JSON.parse(raw) as unknown;
    } catch {
      throw new MeshMachineRequestError('machine-frame-malformed');
    }
    if (!isRecord(frame)) throw new MeshMachineRequestError('machine-frame-malformed');
    if (frame.type === 'auth-challenge') {
      if (
        this.ready ||
        typeof frame.nonce !== 'string' ||
        typeof frame.epoch !== 'string' ||
        frame.epoch !== this.epoch
      ) {
        throw new MeshMachineRequestError('machine-auth-challenge-mismatch');
      }
      const proof = encodeBase64Url(
        await hmacSha256(
          this.sessionToken,
          meshMachineSocketProofMessage({
            sessionId: this.sessionId,
            nonce: frame.nonce,
            machineId: this.host.machineId,
            endpointGeneration: this.host.endpointGeneration,
          }),
        ),
      );
      this.socket.send(JSON.stringify({ type: 'auth', sessionId: this.sessionId, proof }));
      return;
    }
    if (
      frame.type !== 'data' ||
      frame.sessionId !== this.sessionId ||
      !Number.isSafeInteger(frame.sequence) ||
      frame.sequence !== this.serverSequence ||
      !isRecord(frame.envelope) ||
      typeof frame.envelope.enc !== 'string' ||
      typeof frame.envelope.nonce !== 'string' ||
      typeof frame.envelope.ct !== 'string'
    ) {
      throw new MeshMachineRequestError('machine-frame-malformed');
    }
    const requestId = typeof frame.requestId === 'string' ? frame.requestId : undefined;
    const plaintext = await decryptFrame(
      this.hostToClientKey,
      {
        enc: frame.envelope.enc,
        nonce: frame.envelope.nonce,
        ct: frame.envelope.ct,
      },
      {
        sessionId: this.sessionId,
        machineId: this.host.machineId,
        endpointGeneration: this.host.endpointGeneration,
        epoch: this.epoch,
        direction: 'host-to-client',
        requestId,
        sequence: frame.sequence,
      },
    );
    this.serverSequence += 1;
    if (!isRecord(plaintext) || typeof plaintext.kind !== 'string') {
      throw new MeshMachineRequestError('machine-payload-malformed');
    }
    this.handleServerPayload(plaintext as unknown as MeshMachineServerPayload, requestId);
  }

  private handleServerPayload(payload: MeshMachineServerPayload, outerRequestId?: string): void {
    switch (payload.kind) {
      case 'ready': {
        if (
          payload.sessionId !== this.sessionId ||
          payload.epoch !== this.epoch ||
          !Number.isSafeInteger(payload.nextClientSequence) ||
          payload.nextClientSequence < 1 ||
          !Number.isSafeInteger(payload.nextSequence) ||
          payload.nextSequence < 2 ||
          !Number.isSafeInteger(payload.oldestSequence)
        ) {
          throw new MeshMachineRequestError('machine-ready-malformed');
        }
        this.clientSequence = payload.nextClientSequence;
        this.serverSequence = payload.nextSequence;
        this.authorizationValidUntil = payload.authorizationValidUntil;
        this.cursor = { epoch: payload.epoch, sequence: Math.max(0, payload.nextSequence - 1) };
        this.ready = true;
        this.refreshTimer = setInterval(() => {
          void this.sendPayload({ kind: 'refresh', requestId: randomId() }).catch(() =>
            this.close(),
          );
        }, MESH_MACHINE_SESSION_REFRESH_INTERVAL_MS);
        this.resolveReady();
        void this.sendPayload({ kind: 'subscribe', requestId: randomId() }).catch(() =>
          this.close(),
        );
        return;
      }
      case 'response': {
        const requestId = payload.requestId || outerRequestId;
        const pending = requestId === undefined ? undefined : this.pending.get(requestId);
        if (!pending || requestId === undefined) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve(payload.result);
        return;
      }
      case 'refreshed': {
        this.authorizationValidUntil = payload.authorizationValidUntil;
        return;
      }
      case 'event': {
        if (payload.epoch !== this.cursor?.epoch) {
          for (const handler of this.eventHandlers) handler.onResnapshot('epoch-changed');
          void this.sendPayload({
            kind: 'subscribe',
            requestId: randomId(),
            cursor: this.cursor ?? undefined,
          });
          return;
        }
        if (payload.sequence <= (this.cursor?.sequence ?? 0)) return;
        if (payload.sequence !== (this.cursor?.sequence ?? 0) + 1) {
          for (const handler of this.eventHandlers) handler.onResnapshot('sequence-gap');
          void this.sendPayload({
            kind: 'subscribe',
            requestId: randomId(),
            cursor: this.cursor ?? undefined,
          });
          return;
        }
        this.cursor = { epoch: payload.epoch, sequence: payload.sequence };
        for (const handler of this.eventHandlers) {
          handler.onEvent({
            epoch: payload.epoch,
            sequence: payload.sequence,
            workspaceId: payload.workspaceId,
            ...(payload.jobId === undefined ? {} : { jobId: payload.jobId }),
            eventKind: payload.eventKind,
            payload: payload.payload,
          });
        }
        void this.sendPayload({ kind: 'ack', requestId: randomId(), cursor: this.cursor }).catch(
          () => this.close(),
        );
        return;
      }
      case 'resnapshot-required':
        this.cursor = { epoch: payload.epoch, sequence: Math.max(0, payload.nextSequence - 1) };
        for (const handler of this.eventHandlers) handler.onResnapshot(payload.reason);
        void this.sendPayload({
          kind: 'subscribe',
          requestId: randomId(),
          cursor: this.cursor,
        }).catch(() => this.close());
        return;
      case 'session.revoked':
        this.onUnauthorizedClose();
        this.close();
        return;
      case 'error': {
        const requestId = payload.requestId ?? outerRequestId;
        const pending = requestId === undefined ? undefined : this.pending.get(requestId);
        if (pending) {
          this.pending.delete(requestId!);
          clearTimeout(pending.timer);
          pending.reject(new MeshMachineRequestError(`machine-${payload.code}`));
        }
        return;
      }
      default: {
        const exhaustive: never = payload;
        throw new MeshMachineRequestError(`machine-payload-unsupported-${String(exhaustive)}`);
      }
    }
  }

  async request(
    operation: MeshMachineOperation,
    payload: unknown,
    requestId = randomId(),
  ): Promise<unknown> {
    await this.readyPromise;
    if (!this.ready || this.closed) throw new MeshMachineRequestError('machine-session-closed');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new MeshMachineRequestError('machine-request-uncertain'));
      }, 15_000);
      this.pending.set(requestId, { resolve, reject, timer });
      void this.sendPayload({ kind: 'request', requestId, operation, payload }).catch(
        (error: unknown) => {
          const pending = this.pending.get(requestId);
          if (!pending) return;
          this.pending.delete(requestId);
          clearTimeout(timer);
          reject(
            error instanceof Error ? error : new MeshMachineRequestError('machine-send-failed'),
          );
        },
      );
    });
  }

  subscribe(handlers: MeshMachineEventHandlers): () => void {
    this.eventHandlers.add(handlers);
    return () => this.eventHandlers.delete(handlers);
  }

  get isOpen(): boolean {
    return this.ready && !this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close(1000, 'client-close');
    this.cleanup();
    this.failPending(new MeshMachineRequestError('machine-session-closed'));
  }

  private async sendPayload(payload: {
    kind: 'request' | 'subscribe' | 'ack' | 'refresh' | 'ping';
    requestId: string;
    operation?: MeshMachineOperation;
    payload?: unknown;
    cursor?: { epoch: string; sequence: number };
  }): Promise<void> {
    if (!this.ready || this.closed) return;
    const sequence = this.clientSequence++;
    const envelope = await encryptFrame(this.clientToHostKey, payload, {
      sessionId: this.sessionId,
      machineId: this.host.machineId,
      endpointGeneration: this.host.endpointGeneration,
      epoch: this.epoch,
      direction: 'client-to-host',
      requestId: payload.requestId,
      sequence,
    });
    this.socket.send(
      JSON.stringify({
        type: 'data',
        sessionId: this.sessionId,
        requestId: payload.requestId,
        sequence,
        envelope,
      }),
    );
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private cleanup(): void {
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.clientToHostKey.fill(0);
    this.hostToClientKey.fill(0);
    this.sessionToken.fill(0);
  }
}

async function encryptFrame(
  keyBytes: Uint8Array,
  payload: unknown,
  input: {
    sessionId: string;
    machineId: string;
    endpointGeneration: string;
    epoch: string;
    direction: 'client-to-host' | 'host-to-client';
    requestId: string;
    sequence: number;
  },
): Promise<{ enc: 'aes-256-gcm'; nonce: string; ct: string }> {
  const nonce = await Crypto.getRandomBytesAsync(12);
  const key = await Crypto.AESEncryptionKey.import(keyBytes);
  const sealed = await Crypto.aesEncryptAsync(encoder.encode(JSON.stringify(payload)), key, {
    nonce: { bytes: nonce },
    additionalData: encoder.encode(
      meshMachineFrameAssociatedData({ ...input, direction: input.direction }),
    ),
  });
  const iv = await sealed.iv('bytes');
  const ciphertext = await sealed.ciphertext({ encoding: 'bytes', includeTag: true });
  return { enc: 'aes-256-gcm', nonce: encodeBase64(iv), ct: encodeBase64(ciphertext) };
}

async function decryptFrame(
  keyBytes: Uint8Array,
  envelope: { enc: string; nonce: string; ct: string },
  input: {
    sessionId: string;
    machineId: string;
    endpointGeneration: string;
    epoch: string;
    direction: 'client-to-host' | 'host-to-client';
    requestId?: string;
    sequence: number;
  },
): Promise<unknown> {
  if (envelope.enc !== 'aes-256-gcm')
    throw new MeshMachineRequestError('machine-frame-unencrypted');
  const nonce = decodeBase64(envelope.nonce, 12);
  const ciphertext = decodeBase64(envelope.ct);
  if (ciphertext.length < 16) throw new MeshMachineRequestError('machine-frame-malformed');
  const key = await Crypto.AESEncryptionKey.import(keyBytes);
  const sealed = Crypto.AESSealedData.fromParts(nonce, ciphertext, 16);
  const plaintext = await Crypto.aesDecryptAsync(sealed, key, {
    additionalData: encoder.encode(meshMachineFrameAssociatedData(input)),
    output: 'bytes',
  });
  if (typeof plaintext === 'string') throw new MeshMachineRequestError('machine-frame-malformed');
  return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
}

async function connectOnRoute(
  host: MeshMachineHost,
  route: MeshMachineRoute,
  account: NonNullable<Awaited<ReturnType<typeof getAccountConnection>>>,
): Promise<MeshMachineSessionConnection> {
  const info = await fetchJson(new URL(MESH_MACHINE_ROUTE_PATHS.info, route.url).href, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  return bootstrapRoute(host, route, account, info);
}

export async function connectMeshMachineHost(
  host: MeshMachineHost,
  account: NonNullable<Awaited<ReturnType<typeof getAccountConnection>>>,
): Promise<MeshMachineSessionConnection> {
  if (!host.online || !host.operations.includes('read.snapshot')) {
    throw new MeshMachineRequestError('machine-protocol-upgrade-required');
  }
  if (safeAccountApiUrl(account.apiUrl).protocol !== 'https:') {
    throw new MeshMachineRequestError('account-api-requires-https');
  }
  let lastError: unknown;
  for (const route of meshMachineRouteCandidates(host)) {
    try {
      return await connectOnRoute(host, route, account);
    } catch (error) {
      lastError = error;
      if (error instanceof MeshMachineRequestError && error.code === 'machine-protocol-mismatch') {
        throw error;
      }
    }
  }
  if (lastError instanceof MeshMachineRequestError) throw lastError;
  throw new MeshMachineRequestError('machine-route-unavailable');
}

/** Finds a fresh broker-advertised host and reuses its in-memory session when possible. */
export async function getMeshMachineSession(
  targetEnrollmentId: string,
): Promise<MeshMachineSessionConnection> {
  const account = await getAccountConnection();
  if (!account) throw new MeshMachineRequestError('account-sign-in-required');
  safeAccountApiUrl(account.apiUrl);
  const host = (await listMeshMachineHosts()).find(
    (candidate) => candidate.enrollmentId === targetEnrollmentId,
  );
  if (!host) throw new MeshMachineRequestError('machine-protocol-upgrade-required');
  const existing = activeConnections.get(targetEnrollmentId);
  if (existing?.isOpen && existing.host.endpointGeneration === host.endpointGeneration)
    return existing;
  existing?.close();
  activeConnections.delete(targetEnrollmentId);
  const existingPromise = pendingConnections.get(targetEnrollmentId);
  if (existingPromise) return existingPromise;
  const currentAccount = await getAccountConnection();
  if (!currentAccount) throw new MeshMachineRequestError('account-sign-in-required');
  const connectionPromise = connectMeshMachineHost(host, currentAccount)
    .then((connection) => {
      activeConnections.set(targetEnrollmentId, connection);
      return connection;
    })
    .finally(() => {
      if (pendingConnections.get(targetEnrollmentId) === connectionPromise) {
        pendingConnections.delete(targetEnrollmentId);
      }
    });
  pendingConnections.set(targetEnrollmentId, connectionPromise);
  return connectionPromise;
}
