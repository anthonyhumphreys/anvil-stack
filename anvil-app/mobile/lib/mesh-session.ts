import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fetch as expoFetch } from 'expo/fetch';
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
  type MeshMachineClientPayload,
} from '../../cloud/contract/machine';
import { getAccountConnection, listMeshMachineHosts } from './anvil-account';
import { readBoundedResponseText } from './bounded-response';
import { OrderedMeshQueue } from './mesh-ordered-queue';
import { connectMeshRoutes } from '../../cloud/contract/machine-route-connect';
import {
  isMeshLoopbackHost,
  meshMachineRouteRank,
  meshMachineRoutePath,
} from '../../cloud/contract/machine-route-policy';
import {
  MobileMeshSessionManager,
  type MobileMeshCursor,
  type MobileMeshHandlers,
} from './mesh-session-manager';
import { mobileMeshAccountScope, onMobileMeshAccountInvalidated } from './mesh-account-lifecycle';

const encoder = new TextEncoder();
const WRAP_INFO = encoder.encode('anvil/keyring-wrap/v1');
const ACCOUNT_REQUEST_TIMEOUT_MS = 10_000;

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
  onClosed(cause?: string): void;
}

export class MeshMachineRequestError extends Error {
  readonly code: string;
  readonly definitive: boolean;

  constructor(code: string, definitive = false) {
    super(code);
    this.name = 'MeshMachineRequestError';
    this.code = code;
    this.definitive = definitive;
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
  if (host.includes(':'))
    return host === '::1' || /^(?:(?:fc|fd)[0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(host);
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
      !isMeshLoopbackHost(url.hostname) &&
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
  const seen = new Set<string>();
  return host.routes
    .filter((route) => isUsableMeshMachineRoute(host, route, now))
    .sort((left, right) => meshMachineRouteRank(left) - meshMachineRouteRank(right))
    .filter((route) => {
      const key = new URL(route.url).origin;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
  const abort = () => controller.abort();
  if (init.signal?.aborted) controller.abort();
  else init.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), ACCOUNT_REQUEST_TIMEOUT_MS);
  try {
    const response = await expoFetch(url, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
    });
    const contentLength = response.headers.get('content-length');
    if (
      contentLength !== null &&
      /^\d+$/.test(contentLength) &&
      Number(contentLength) > MESH_MACHINE_MAX_FRAME_BYTES
    ) {
      controller.abort();
      throw new MeshMachineRequestError('machine-response-too-large');
    }
    let raw: string;
    try {
      raw = await readBoundedResponseText(response.body, MESH_MACHINE_MAX_FRAME_BYTES);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('machine-response-')) {
        controller.abort();
        throw new MeshMachineRequestError(error.message);
      }
      throw error;
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
    init.signal?.removeEventListener('abort', abort);
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
  options: MobileMeshConnectOptions,
): Promise<MeshMachineSessionConnection> {
  await assertMobileMeshAccount(account, options.signal);
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
  const capabilities = (
    ['machine.session/1', 'machine.stream/1', 'machine.stream-handoff/1'] as const
  ).filter((capability) => host.capabilities.includes(capability));
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
    await assertMobileMeshAccount(account, options.signal);
    const ticketValue = await fetchJson(issueUrl.href, {
      signal: options.signal,
      method: 'POST',
      headers: {
        authorization: `Bearer ${account.session.accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(ticketRequest),
    });
    await assertMobileMeshAccount(account, options.signal);
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

    await assertMobileMeshAccount(account, options.signal);
    const challengeValue = await fetchJson(
      new URL(MESH_MACHINE_ROUTE_PATHS.challenge, route.url).href,
      {
        signal: options.signal,
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
    await assertMobileMeshAccount(account, options.signal);
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
    await assertMobileMeshAccount(account, options.signal);
    const bootstrapValue = await fetchJson(
      new URL(MESH_MACHINE_ROUTE_PATHS.bootstrap, route.url).href,
      {
        signal: options.signal,
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ v: 1, challengeId: challenge.challengeId, proof }),
      },
    );
    await assertMobileMeshAccount(account, options.signal);
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
    await assertMobileMeshAccount(account, options.signal);
    const socket = new WebSocket(socketUrl.href, MESH_MACHINE_SOCKET_SUBPROTOCOL);
    const connection = await MeshMachineSessionConnection.open({
      host,
      route,
      socket,
      sessionId: bootstrap.sessionId,
      sessionToken,
      epoch: bootstrap.stream.epoch,
      authorizationValidUntil: bootstrap.authorizationValidUntil,
      cursor: options.cursor,
      handlers: options.handlers,
      signal: options.signal,
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
  mutating: boolean;
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
  private cursor: MobileMeshCursor | null = null;
  private ready = false;
  private closed = false;
  private streamComplete = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventHandlers = new Set<MeshMachineEventHandlers>();
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly readyPromise: Promise<void>;
  private authorizationValidUntil: string;
  private readonly inbound = new OrderedMeshQueue();
  private readonly outbound = new OrderedMeshQueue();

  private constructor(input: {
    host: MeshMachineHost;
    route: MeshMachineRoute;
    socket: WebSocket;
    sessionId: string;
    sessionToken: Uint8Array;
    epoch: string;
    authorizationValidUntil: string;
    cursor?: MobileMeshCursor;
    handlers?: MobileMeshHandlers;
  }) {
    this.host = input.host;
    this.route = input.route;
    this.socket = input.socket;
    this.sessionId = input.sessionId;
    this.sessionToken = input.sessionToken;
    this.epoch = input.epoch;
    this.authorizationValidUntil = input.authorizationValidUntil;
    this.cursor = input.cursor ?? null;
    if (input.handlers !== undefined) this.eventHandlers.add(input.handlers);
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
    cursor?: MobileMeshCursor;
    handlers?: MobileMeshHandlers;
    signal?: AbortSignal;
  }): Promise<MeshMachineSessionConnection> {
    const connection = new MeshMachineSessionConnection(input);
    const abort = () => connection.terminate('machine-route-cancelled');
    const timeout = setTimeout(() => connection.terminate('machine-session-timeout'), 15_000);
    connection.attach();
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    try {
      await connection.readyPromise;
      const result = await connection.control({
        kind: 'subscribe',
        requestId: randomId(),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      if (
        !isRecord(result) ||
        !isRecord(result.cursor) ||
        typeof result.cursor.epoch !== 'string' ||
        !Number.isSafeInteger(result.cursor.sequence) ||
        Number(result.cursor.sequence) < 0
      ) {
        throw new MeshMachineRequestError('machine-subscribe-malformed');
      }
      const cursor = result.cursor as unknown as MobileMeshCursor;
      if (cursor.epoch !== connection.epoch)
        throw new MeshMachineRequestError('machine-stream-epoch-changed');
      if (connection.cursor === null || cursor.sequence > connection.cursor.sequence)
        connection.cursor = cursor;
      connection.streamComplete =
        result.replayComplete === true &&
        input.host.capabilities.includes('machine.stream-handoff/1');
      if (
        input.host.capabilities.includes('machine.stream-handoff/1') &&
        !connection.streamComplete
      ) {
        throw new MeshMachineRequestError('machine-stream-readiness-unavailable');
      }
      if (!connection.isOpen) throw new MeshMachineRequestError('machine-session-closed');
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', abort);
    }
  }

  private attach(): void {
    this.socket.addEventListener('message', (event) => {
      const data: unknown = event.data;
      const bytes =
        typeof data === 'string'
          ? encoder.encode(data).byteLength
          : data instanceof ArrayBuffer
            ? data.byteLength
            : MESH_MACHINE_MAX_FRAME_BYTES + 1;
      if (bytes > MESH_MACHINE_MAX_FRAME_BYTES) {
        this.terminate('machine-frame-too-large');
        return;
      }
      void this.inbound
        .run(() => this.handleMessage(data), bytes)
        .catch((error: unknown) => {
          this.terminate(error instanceof Error ? error.message : 'machine-protocol');
        });
    });
    this.socket.addEventListener('error', () => this.terminate('machine-socket-error'));
    this.socket.addEventListener('close', () => this.terminate('machine-session-closed'));
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (this.closed) return;
    const raw =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(data)
          : null;
    if (raw === null) throw new MeshMachineRequestError('machine-frame-malformed');
    let frame: unknown;
    try {
      frame = JSON.parse(raw) as unknown;
    } catch {
      throw new MeshMachineRequestError('machine-frame-malformed');
    }
    if (!isRecord(frame)) throw new MeshMachineRequestError('machine-frame-malformed');
    if (frame.type === 'auth-challenge') {
      if (this.ready || typeof frame.nonce !== 'string' || frame.epoch !== this.epoch) {
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
      if (!this.closed)
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
    if (this.closed) return;
    this.serverSequence += 1;
    if (!isRecord(plaintext) || typeof plaintext.kind !== 'string')
      throw new MeshMachineRequestError('machine-payload-malformed');
    this.handleServerPayload(plaintext as unknown as MeshMachineServerPayload, requestId);
  }

  private handleServerPayload(payload: MeshMachineServerPayload, outerRequestId?: string): void {
    switch (payload.kind) {
      case 'ready': {
        if (
          this.ready ||
          payload.sessionId !== this.sessionId ||
          payload.epoch !== this.epoch ||
          !Number.isSafeInteger(payload.nextClientSequence) ||
          payload.nextClientSequence < 1 ||
          !Number.isSafeInteger(payload.nextSequence) ||
          payload.nextSequence < 1 ||
          !Number.isSafeInteger(payload.oldestSequence)
        )
          throw new MeshMachineRequestError('machine-ready-malformed');
        this.clientSequence = payload.nextClientSequence;
        this.authorizationValidUntil = payload.authorizationValidUntil;
        // nextSequence is an EVENT cursor; encrypted frame sequence is session-local.
        this.cursor ??= { epoch: payload.epoch, sequence: Math.max(0, payload.nextSequence - 1) };
        this.ready = true;
        this.refreshTimer = setInterval(() => {
          void this.control({ kind: 'refresh', requestId: randomId() }).catch(() =>
            this.terminate('authorization-unavailable'),
          );
        }, MESH_MACHINE_SESSION_REFRESH_INTERVAL_MS);
        this.resolveReady();
        return;
      }
      case 'response':
      case 'refreshed': {
        const id = payload.requestId || outerRequestId;
        const pending = id === undefined ? undefined : this.pending.get(id);
        if (pending === undefined || id === undefined) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (payload.kind === 'refreshed') {
          this.authorizationValidUntil = payload.authorizationValidUntil;
          pending.resolve({ authorizationValidUntil: payload.authorizationValidUntil });
        } else pending.resolve(payload.result);
        return;
      }
      case 'event': {
        if (payload.epoch !== this.epoch) {
          for (const handler of this.eventHandlers) handler.onResnapshot('epoch-changed');
          this.terminate('machine-stream-epoch-changed');
          return;
        }
        if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 1)
          throw new MeshMachineRequestError('machine-event-malformed');
        if (this.cursor?.epoch === payload.epoch && payload.sequence <= this.cursor.sequence)
          return;
        // Global event numbers legitimately skip workspaces outside this subscription.
        this.cursor = { epoch: payload.epoch, sequence: payload.sequence };
        for (const handler of this.eventHandlers)
          handler.onEvent({
            epoch: payload.epoch,
            sequence: payload.sequence,
            workspaceId: payload.workspaceId,
            ...(payload.jobId === undefined ? {} : { jobId: payload.jobId }),
            eventKind: payload.eventKind,
            payload: payload.payload,
          });
        void this.control({ kind: 'ack', requestId: randomId(), cursor: this.cursor }).catch(() =>
          this.terminate('machine-ack-failed'),
        );
        return;
      }
      case 'resnapshot-required':
        for (const handler of this.eventHandlers) handler.onResnapshot(payload.reason);
        this.terminate('machine-stream-resnapshot-required');
        return;
      case 'session.revoked':
        this.terminate(
          payload.reason === 'expired' ? 'machine-session-expired' : 'session.revoked',
        );
        return;
      case 'error': {
        const id = payload.requestId ?? outerRequestId;
        const pending = id === undefined ? undefined : this.pending.get(id);
        if (pending !== undefined && id !== undefined) {
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(new MeshMachineRequestError(`machine-${payload.code}`, true));
        }
        return;
      }
      default:
        throw new MeshMachineRequestError('machine-payload-unsupported');
    }
  }

  async request(operation: string, payload: unknown, requestId = randomId()): Promise<unknown> {
    await this.readyPromise;
    if (!this.host.operations.includes(operation as MeshMachineOperation))
      throw new MeshMachineRequestError('machine-operation-unavailable', true);
    return this.control(
      { kind: 'request', requestId, operation: operation as MeshMachineOperation, payload },
      !operation.startsWith('read.'),
    );
  }
  subscribe(handlers: MeshMachineEventHandlers): () => void {
    this.eventHandlers.add(handlers);
    return () => this.eventHandlers.delete(handlers);
  }
  get isOpen(): boolean {
    return this.ready && !this.closed && Date.parse(this.authorizationValidUntil) > Date.now();
  }
  get streamCursor(): MobileMeshCursor | null {
    return this.cursor === null ? null : { ...this.cursor };
  }
  get replayComplete(): boolean {
    return this.streamComplete;
  }
  close(): void {
    this.terminate('retired');
  }

  private control(payload: MeshMachineClientPayload, mutating = false): Promise<unknown> {
    if (!this.isOpen)
      return Promise.reject(new MeshMachineRequestError('machine-session-closed', true));
    const id = payload.requestId;
    return new Promise((resolve, reject) => {
      if (this.pending.has(id)) {
        reject(new MeshMachineRequestError('machine-request-id-in-use', true));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new MeshMachineRequestError(
            mutating ? 'machine-request-uncertain' : 'machine-request-timeout',
          ),
        );
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer, mutating });
      void this.outbound
        .run(
          async () => {
            if (!this.isOpen || !this.pending.has(id))
              throw new MeshMachineRequestError('machine-session-closed');
            const sequence = this.clientSequence;
            const envelope = await encryptFrame(this.clientToHostKey, payload, {
              sessionId: this.sessionId,
              machineId: this.host.machineId,
              endpointGeneration: this.host.endpointGeneration,
              epoch: this.epoch,
              direction: 'client-to-host',
              requestId: id,
              sequence,
            });
            if (!this.isOpen || !this.pending.has(id))
              throw new MeshMachineRequestError('machine-session-closed');
            // A timed-out queued encryption must not consume a sequence that was never sent.
            this.clientSequence += 1;
            this.socket.send(
              JSON.stringify({
                type: 'data',
                sessionId: this.sessionId,
                requestId: id,
                sequence,
                envelope,
              }),
            );
          },
          encoder.encode(JSON.stringify(payload)).byteLength,
        )
        .catch((error: unknown) => {
          const pending = this.pending.get(id);
          if (pending === undefined) return;
          this.pending.delete(id);
          clearTimeout(timer);
          pending.reject(
            new MeshMachineRequestError(
              mutating
                ? 'machine-request-uncertain'
                : error instanceof Error
                  ? error.message
                  : 'machine-send-failed',
            ),
          );
          this.terminate('machine-send-failed');
        });
    });
  }
  private terminate(cause: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    const error = new MeshMachineRequestError(cause);
    this.rejectReady(error);
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.inbound.close();
    this.outbound.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new MeshMachineRequestError(pending.mutating ? 'machine-request-uncertain' : cause),
      );
    }
    this.pending.clear();
    try {
      this.socket.close(1000, 'client-close');
    } catch {
      /* The native socket may already be closed. */
    }
    this.clientToHostKey.fill(0);
    this.hostToClientKey.fill(0);
    this.sessionToken.fill(0);
    for (const handler of [...this.eventHandlers]) {
      try {
        handler.onClosed(cause);
      } catch {
        // Socket cleanup and other owners must not depend on a consumer callback.
      }
    }
    this.eventHandlers.clear();
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

interface MobileMeshConnectOptions {
  signal?: AbortSignal;
  cursor?: MobileMeshCursor;
  handlers?: MobileMeshHandlers;
}

async function assertMobileMeshAccount(
  account: NonNullable<Awaited<ReturnType<typeof getAccountConnection>>>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new MeshMachineRequestError('machine-route-cancelled');
  const current = await getAccountConnection();
  if (current === null || mobileMeshAccountScope(current) !== mobileMeshAccountScope(account)) {
    throw new MeshMachineRequestError('authorization-unavailable');
  }
  if (signal?.aborted) throw new MeshMachineRequestError('machine-route-cancelled');
}

export async function connectMeshMachineHost(
  host: MeshMachineHost,
  account: NonNullable<Awaited<ReturnType<typeof getAccountConnection>>>,
  options: MobileMeshConnectOptions = {},
): Promise<MeshMachineSessionConnection> {
  if (!host.online || !host.operations.includes('read.snapshot')) {
    throw new MeshMachineRequestError('machine-protocol-upgrade-required');
  }
  safeAccountApiUrl(account.apiUrl);
  try {
    return await connectMeshRoutes({
      routes: meshMachineRouteCandidates(host),
      signal: options.signal,
      probe: async (route, signal) => {
        const info = await fetchJson(new URL(MESH_MACHINE_ROUTE_PATHS.info, route.url).href, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal,
        });
        if (
          !isRecord(info) ||
          info.protocolVersion !== MESH_MACHINE_PROTOCOL_VERSION ||
          info.machineId !== host.machineId ||
          info.endpointGeneration !== host.endpointGeneration ||
          info.hostEnrollmentId !== host.enrollmentId
        )
          throw new MeshMachineRequestError('machine-protocol-mismatch');
        return info;
      },
      connect: async (route, info, signal) => {
        if (!isUsableMeshMachineRoute(host, route))
          throw new MeshMachineRequestError('machine-route-unavailable');
        return bootstrapRoute(host, route, account, info, { ...options, signal });
      },
      dispose: (connection) => connection.close(),
    });
  } catch (error) {
    throw error instanceof MeshMachineRequestError
      ? error
      : new MeshMachineRequestError(
          error instanceof Error ? error.message : 'machine-route-unavailable',
        );
  }
}

export const mobileMeshSessions = new MobileMeshSessionManager({
  scope: async () => {
    const account = await getAccountConnection();
    if (account === null) return null;
    safeAccountApiUrl(account.apiUrl);
    return mobileMeshAccountScope(account);
  },
  discover: (signal) => listMeshMachineHosts(signal),
  connect: async (host, options) => {
    const account = await getAccountConnection();
    if (account === null) throw new MeshMachineRequestError('account-sign-in-required');
    return connectMeshMachineHost(host, account, options);
  },
  rank: meshMachineRouteRank,
  path: meshMachineRoutePath,
});

mobileMeshSessions.setUpgradesEnabled(
  process.env.EXPO_PUBLIC_ANVIL_MESH_ROUTE_UPGRADES !== 'false',
);

onMobileMeshAccountInvalidated(() => mobileMeshSessions.reset());

/** A stable facade keeps callers and subscribers independent of route replacements. */
export async function getMeshMachineSession(targetEnrollmentId: string) {
  try {
    return await mobileMeshSessions.get(targetEnrollmentId);
  } catch (error) {
    throw error instanceof MeshMachineRequestError
      ? error
      : new MeshMachineRequestError(
          error instanceof Error ? error.message : 'machine-route-unavailable',
        );
  }
}
