"use client";

import {
  MESH_MACHINE_CAPABILITIES,
  MESH_MACHINE_PROTOCOL_VERSION,
  MESH_MACHINE_ROUTE_PATHS,
  MESH_MACHINE_SESSION_REFRESH_INTERVAL_MS,
  MESH_MACHINE_SOCKET_SUBPROTOCOL,
  MESH_MACHINE_OPERATIONS,
  meshMachineBootstrapProofMessage,
  meshMachineFrameAssociatedData,
  meshMachineSessionTokenAssociatedData,
  meshMachineSocketProofMessage,
  meshMachineTrafficKeyDerivation,
  type MeshMachineBootstrapClaims,
  type MeshMachineBootstrapChallenge,
  type MeshMachineBootstrapResponse,
  type MeshMachineAdmissionIssueResponse,
  type MeshMachineSessionPrincipal,
  type MeshMachineHost,
  type MeshMachineChallengeRequest,
  type MeshMachineEndpointInfo,
  type MeshMachineOperation,
  type MeshMachineRoute,
  type MeshMachineClientPayload,
  type MeshMachineServerFrame,
  type MeshMachineServerPayload,
} from "../../anvil-app/cloud/contract/machine.js";
import {
  BROWSER_WORKSPACE_OPERATION_SCOPE,
  BROWSER_WORKSPACE_OPERATIONS,
} from "../../anvil-app/cloud/contract/browser-workspace.js";
import {
  decodeBase64,
  encodeBase64,
  generateBrowserKeypair,
  hmacSha256,
  randomRequestId,
  x25519,
} from "@/lib/mesh-crypto";

const encoder = new TextEncoder();
const SOCKET_AUTH_TIMEOUT_MS = 5_000;
const MACHINE_HTTP_TIMEOUT_MS = 5_000;
const MAX_FALLBACK_FRAME_BYTES = 1024 * 1024;

export interface BrowserMachineAuthorization {
  route: MeshMachineRoute;
  accountId: string;
  grantId: string;
  targetEnrollmentId: string;
  workspaceId: string;
  repositoryIds: readonly string[];
  scopes: readonly string[];
  trustId?: string;
  dsk: Uint8Array;
  origin: string;
  issueAdmissionTicket(input: {
    clientPublicKey: string;
    bootstrapChallenge: string;
  }): Promise<MeshMachineAdmissionIssueResponse>;
}

export interface BrowserMachineEvent {
  epoch: string;
  sequence: number;
  workspaceId: string;
  jobId?: string;
  kind: string;
  payload: unknown;
}

export type BrowserMachineCursorDecision =
  | { kind: "duplicate" }
  | { kind: "accept"; cursor: { epoch: string; sequence: number } }
  | { kind: "resnapshot"; reason: "epoch-changed" | "sequence-gap" };

/** Shared replay gate: duplicates are harmless, while epoch changes and gaps require a fresh snapshot. */
export function decideBrowserMachineCursor(
  cursor: { epoch: string; sequence: number } | undefined,
  event: Pick<BrowserMachineEvent, "epoch" | "sequence">,
): BrowserMachineCursorDecision {
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    return { kind: "resnapshot", reason: "sequence-gap" };
  }
  if (cursor && event.epoch === cursor.epoch && event.sequence <= cursor.sequence) {
    return { kind: "duplicate" };
  }
  if (cursor && event.epoch !== cursor.epoch) {
    return { kind: "resnapshot", reason: "epoch-changed" };
  }
  if (cursor && event.sequence !== cursor.sequence + 1) {
    return { kind: "resnapshot", reason: "sequence-gap" };
  }
  return { kind: "accept", cursor: { epoch: event.epoch, sequence: event.sequence } };
}

export interface BrowserMachineStreamHandlers {
  onEvent(event: BrowserMachineEvent): void | Promise<void>;
  onResnapshot(reason: "epoch-changed" | "cursor-expired" | "sequence-gap"): void | Promise<void>;
}

export interface BrowserMachineResponse {
  requestId: string;
  sequence: number;
  result: unknown;
}

export interface BrowserMachineSocket {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface BrowserMachineTransportDependencies {
  fetch?: typeof fetch;
  createSocket?: (url: string, protocol: string) => BrowserMachineSocket;
  now?: () => number;
}

export class BrowserMachineTransportError extends Error {
  readonly sent: boolean;
  readonly code: string;

  constructor(code: string, message: string, sent = false) {
    super(message);
    this.name = "BrowserMachineTransportError";
    this.sent = sent;
    this.code = code;
  }
}

interface PendingResponse {
  sequence: number;
  sent: boolean;
  resolve(response: BrowserMachineResponse): void;
  reject(error: BrowserMachineTransportError): void;
  timer: ReturnType<typeof setTimeout>;
}

type BrowserMachineHandshakeFrame =
  | { kind: "auth-challenge"; nonce: string; epoch: string }
  | Extract<MeshMachineServerPayload, { kind: "ready" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64Length(value: string): number | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(left.byteLength + right.byteLength);
  bytes.set(left, 0);
  bytes.set(right, left.byteLength);
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sessionAesKey(
  token: Uint8Array,
  usage: KeyUsage,
  input: {
    sessionId: string;
    machineId: string;
    endpointGeneration: string;
    direction: "client-to-host" | "host-to-client";
  },
): Promise<CryptoKey> {
  if (token.byteLength !== 32) throw new Error("Machine session token must be 32 bytes.");
  const rawKey = await crypto.subtle.importKey("raw", token as BufferSource, "HKDF", false, ["deriveKey"]);
  const derivation = meshMachineTrafficKeyDerivation(input);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(derivation.salt) as BufferSource,
      info: encoder.encode(derivation.info) as BufferSource,
    },
    rawKey,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

async function sealSessionPayload(
  token: Uint8Array,
  payload: MeshMachineClientPayload,
  input: {
    sessionId: string;
    machineId: string;
    endpointGeneration: string;
    epoch: string;
    requestId: string;
    sequence: number;
  },
): Promise<{ enc: "aes-256-gcm"; nonce: string; ct: string }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await sessionAesKey(token, "encrypt", { ...input, direction: "client-to-host" });
  const aad = meshMachineFrameAssociatedData({ ...input, direction: "client-to-host" });
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: encoder.encode(aad) as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return { enc: "aes-256-gcm", nonce: encodeBase64(nonce), ct: encodeBase64(new Uint8Array(ciphertext)) };
}

async function openSessionPayload(
  token: Uint8Array,
  envelope: { enc: string; nonce: string; ct: string },
  input: {
    sessionId: string;
    machineId: string;
    endpointGeneration: string;
    epoch: string;
    requestId?: string;
    sequence: number;
  },
): Promise<MeshMachineServerPayload | null> {
  try {
    if (envelope.enc !== "aes-256-gcm") return null;
    const nonce = decodeBase64(envelope.nonce);
    const ciphertext = decodeBase64(envelope.ct);
    if (nonce.byteLength !== 12 || ciphertext.byteLength < 16) return null;
    const key = await sessionAesKey(token, "decrypt", { ...input, direction: "host-to-client" });
    const aad = meshMachineFrameAssociatedData({ ...input, direction: "host-to-client" });
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: encoder.encode(aad) as BufferSource },
      key,
      ciphertext as BufferSource,
    );
    const value: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    return isRecord(value) && typeof value.kind === "string"
      ? value as unknown as MeshMachineServerPayload
      : null;
  } catch {
    return null;
  }
}

function machineInfoPath(route: MeshMachineRoute): string {
  return new URL(MESH_MACHINE_ROUTE_PATHS.info, route.url).toString();
}

function machineChallengePath(route: MeshMachineRoute): string {
  return new URL(MESH_MACHINE_ROUTE_PATHS.challenge, route.url).toString();
}

function machineBootstrapPath(route: MeshMachineRoute): string {
  return new URL(MESH_MACHINE_ROUTE_PATHS.bootstrap, route.url).toString();
}

function machineSocketUrl(route: MeshMachineRoute): string {
  const url = new URL(MESH_MACHINE_ROUTE_PATHS.socket, route.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function isUsableBrowserMachineRoute(
  route: MeshMachineRoute,
  pageProtocol: string,
  now = Date.now(),
): boolean {
  const reachableUntil = Date.parse(route.reachableUntil);
  if (!Number.isFinite(reachableUntil) || reachableUntil <= now) return false;
  try {
    const url = new URL(route.url);
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return false;
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (pageProtocol === "https:" && url.protocol !== "https:") return false;
    if (route.kind === "managed" && url.protocol !== "https:") return false;
    return route.machineId.length > 0 && route.endpointGeneration.length > 0;
  } catch {
    return false;
  }
}

/** Routes are tried in broker preference order; failures remain eligible for hosted fallback. */
export function browserMachineRouteCandidates(host: MeshMachineHost | undefined, now = Date.now()): MeshMachineRoute[] {
  if (!host || !host.online || host.protocolVersion !== MESH_MACHINE_PROTOCOL_VERSION) return [];
  if (Date.parse(host.reachableUntil) <= now) return [];
  if (!host.capabilities.includes("machine.session/1") || !host.capabilities.includes("machine.stream/1")) return [];
  const order: Record<MeshMachineRoute["kind"], number> = { private: 0, https: 1, managed: 2 };
  return host.routes
    .filter((route) =>
      route.machineId === host.machineId &&
      route.endpointGeneration === host.endpointGeneration &&
      isUsableBrowserMachineRoute(route, typeof window === "undefined" ? "https:" : window.location.protocol, now)
    )
    .sort((left, right) => order[left.kind] - order[right.kind]);
}

export function validateBrowserMachineClaims(
  value: unknown,
  authorization: BrowserMachineAuthorization,
  clientPublicKey: string,
  now = Date.now(),
): value is MeshMachineBootstrapClaims {
  if (!isRecord(value) || value.v !== 1) return false;
  const principal = isRecord(value.principal) ? value.principal : null;
  const scope = isRecord(value.scope) ? value.scope : null;
  const expectedRepositories = [...new Set(authorization.repositoryIds)].sort();
  const expectedScopes = [...new Set(authorization.scopes)].sort();
  if (
    value.clientPublicKey !== clientPublicKey ||
    value.machineId !== authorization.route.machineId ||
    value.endpointGeneration !== authorization.route.endpointGeneration ||
    value.accountId !== authorization.accountId ||
    typeof value.bootstrapId !== "string" ||
    value.bootstrapId.length < 8 ||
    typeof value.challenge !== "string" ||
    value.challenge.length < 16 ||
    !principal ||
    principal.kind !== "dashboard" ||
    principal.accountId !== authorization.accountId ||
    principal.sourceBrowserId !== (authorization.trustId ?? authorization.grantId) ||
    principal.grantId !== authorization.grantId ||
    principal.trustId !== authorization.trustId ||
    value.sourceEnrollmentId !== null ||
    !scope ||
    !Array.isArray(scope.workspaceIds) ||
    !scope.workspaceIds.every((id) => typeof id === "string") ||
    JSON.stringify(scope.workspaceIds) !== JSON.stringify([authorization.workspaceId]) ||
    !Array.isArray(scope.repositoryIds) ||
    !scope.repositoryIds.every((id) => typeof id === "string") ||
    JSON.stringify([...scope.repositoryIds].sort()) !== JSON.stringify(expectedRepositories) ||
    !Array.isArray(scope.scopes) ||
    !scope.scopes.every((item) => typeof item === "string") ||
    JSON.stringify([...scope.scopes].sort()) !== JSON.stringify(expectedScopes) ||
    !Array.isArray(scope.operations) ||
    !scope.operations.every((item) => typeof item === "string") ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every((item) => typeof item === "string" && (MESH_MACHINE_CAPABILITIES as readonly string[]).includes(item)) ||
    typeof value.issuedAt !== "string" ||
    typeof value.expiresAt !== "string"
  ) {
    return false;
  }
  const expectedOperations = new Set<string>();
  for (const operation of BROWSER_WORKSPACE_OPERATIONS) {
    const requiredScope = BROWSER_WORKSPACE_OPERATION_SCOPE[operation];
    if (authorization.scopes.includes(requiredScope)) expectedOperations.add(operation);
  }
  if (authorization.scopes.includes("read-dashboard") || authorization.scopes.includes("workspace-read")) {
    expectedOperations.add("read.snapshot");
    expectedOperations.add("read.job");
    expectedOperations.add("read.events");
  }
  if (authorization.scopes.includes("submit-task")) {
    expectedOperations.add("command.submit");
    expectedOperations.add("command.cancel");
  }
  if (authorization.scopes.includes("approve-action")) expectedOperations.add("command.approve");
  if (authorization.scopes.includes("workspace-write") || authorization.scopes.includes("terminal")) {
    expectedOperations.add("command.steer");
  }
  if (expectedOperations.size > 0) expectedOperations.add("dashboard.command.wake");
  if (
    JSON.stringify([...scope.operations].sort()) !== JSON.stringify([...expectedOperations].sort()) ||
    !scope.operations.every((item) => (MESH_MACHINE_OPERATIONS as readonly string[]).includes(item) || (BROWSER_WORKSPACE_OPERATIONS as readonly string[]).includes(item)) ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.includes("machine.session/1") ||
    !value.capabilities.includes("machine.stream/1")
  ) return false;
  const issuedAt = Date.parse(value.issuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  return Number.isFinite(issuedAt) && Number.isFinite(expiresAt) &&
    issuedAt <= now + 60_000 && expiresAt > now && expiresAt > issuedAt &&
    expiresAt - issuedAt <= 10 * 60_000;
}

function validateDashboardAdmissionTicket(
  value: unknown,
  authorization: BrowserMachineAuthorization,
  clientPublicKey: string,
  bootstrapChallenge: string,
  now: number,
): value is MeshMachineAdmissionIssueResponse {
  if (!isRecord(value) || value.v !== 1 || typeof value.ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.ticket)) {
    return false;
  }
  const claims = isRecord(value.claims) ? value.claims : null;
  const principal = claims && isRecord(claims.principal) ? claims.principal : null;
  if (
    !claims || claims.v !== 1 ||
    claims.accountId !== authorization.accountId ||
    claims.hostMachineId !== authorization.route.machineId ||
    claims.endpointGeneration !== authorization.route.endpointGeneration ||
    claims.clientPublicKey !== clientPublicKey ||
    claims.bootstrapChallenge !== bootstrapChallenge ||
    principal?.kind !== "dashboard" || principal.grantId !== authorization.grantId ||
    principal.origin !== authorization.origin ||
    typeof claims.issuedAt !== "string" || typeof claims.expiresAt !== "string"
  ) return false;
  const issuedAt = Date.parse(claims.issuedAt);
  const expiresAt = Date.parse(claims.expiresAt);
  return Number.isFinite(issuedAt) && Number.isFinite(expiresAt) &&
    issuedAt <= now + 5_000 && expiresAt > now && expiresAt > issuedAt && expiresAt - issuedAt <= 60_000;
}

function sameDashboardPrincipal(
  actual: unknown,
  expected: MeshMachineBootstrapClaims["principal"],
): boolean {
  if (!isRecord(actual) || expected.kind !== "dashboard") return false;
  return actual.kind === "dashboard" &&
    actual.accountId === expected.accountId &&
    actual.sourceBrowserId === expected.sourceBrowserId &&
    actual.grantId === expected.grantId &&
    actual.trustId === expected.trustId;
}

export async function openBrowserMachineSessionToken(
  sealed: MeshMachineBootstrapResponse["sessionToken"],
  clientPrivateKey: Uint8Array,
  clientPublicKey: Uint8Array,
  aad: string,
): Promise<{ v: 1; sessionId: string; sessionToken: Uint8Array } | null> {
  try {
    if (sealed.enc !== "x25519-aes-256-gcm") return null;
    const ephPub = decodeBase64(sealed.ephPub);
    const nonce = decodeBase64(sealed.nonce);
    const ciphertext = decodeBase64(sealed.ct);
    if (ephPub.byteLength !== 32 || nonce.byteLength !== 12 || ciphertext.byteLength < 16) return null;
    const sharedSecret = x25519(clientPrivateKey, ephPub);
    const rawKey = await crypto.subtle.importKey("raw", sharedSecret as BufferSource, "HKDF", false, ["deriveKey"]);
    const salt = concatenate(ephPub, clientPublicKey);
    const key = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: salt as BufferSource,
        info: encoder.encode("anvil/keyring-wrap/v1") as BufferSource,
      },
      rawKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: encoder.encode(aad) as BufferSource },
      key,
      ciphertext as BufferSource,
    );
    const inner: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    if (
      !isRecord(inner) || inner.v !== 1 || typeof inner.sessionId !== "string" ||
      typeof inner.sessionToken !== "string" || base64Length(inner.sessionToken) !== 32
    ) return null;
    return { v: 1, sessionId: inner.sessionId, sessionToken: decodeBase64(inner.sessionToken) };
  } catch {
    return null;
  }
}

export function browserMachineSessionTokenAssociatedData(input: {
  accountId: string;
  principal: MeshMachineSessionPrincipal;
  machineId: string;
  endpointGeneration: string;
  sessionId: string;
}): string {
  return meshMachineSessionTokenAssociatedData(input);
}

function parseServerFrame(value: unknown): MeshMachineServerFrame | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "auth-challenge") {
    return typeof value.nonce === "string" && typeof value.epoch === "string"
      ? value as unknown as MeshMachineServerFrame
      : null;
  }
  if (
    value.type === "data" && typeof value.sessionId === "string" &&
    typeof value.sequence === "number" && Number.isSafeInteger(value.sequence) &&
    (value.requestId === undefined || typeof value.requestId === "string") && isRecord(value.envelope)
  ) return value as unknown as MeshMachineServerFrame;
  return null;
}

export class BrowserMachineWorkspaceTransport {
  private readonly authorization: BrowserMachineAuthorization;
  private readonly clientPrivateKey: Uint8Array;
  private readonly clientPublicKey: Uint8Array;
  private readonly fetchImpl: typeof fetch;
  private readonly socketFactory: (url: string, protocol: string) => BrowserMachineSocket;
  private readonly now: () => number;
  private socket: BrowserMachineSocket | null = null;
  private sessionId: string | null = null;
  private sessionToken: Uint8Array | null = null;
  private epoch: string | null = null;
  private lastServerSequence: number | null = null;
  private endpointInfo: MeshMachineEndpointInfo | null = null;
  private allowedOperations = new Set<string>();
  private nextSequence = 0;
  private authorizationValidUntil = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly refreshRequests = new Set<string>();
  private readonly pending = new Map<string, PendingResponse>();
  private readonly handshakeFrames: BrowserMachineHandshakeFrame[] = [];
  private handshakeWaiter: ((frame: BrowserMachineHandshakeFrame) => void) | null = null;
  private receiveTail: Promise<void> = Promise.resolve();
  private sendTail: Promise<void> = Promise.resolve();
  private streamHandlers: BrowserMachineStreamHandlers | null = null;
  private subscribedWorkspaceIds: string[] = [];
  private subscriptionRequestId: string | null = null;
  private cursor: { epoch: string; sequence: number } | undefined;
  private closed = false;
  private disconnectedHandler: (() => void) | null = null;

  private constructor(
    authorization: BrowserMachineAuthorization,
    clientPrivateKey: Uint8Array,
    clientPublicKey: Uint8Array,
    dependencies: BrowserMachineTransportDependencies,
  ) {
    this.authorization = authorization;
    this.clientPrivateKey = clientPrivateKey;
    this.clientPublicKey = clientPublicKey;
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.socketFactory = dependencies.createSocket ?? ((url, protocol) => new WebSocket(url, protocol));
    this.now = dependencies.now ?? Date.now;
  }

  static async connect(
    authorization: BrowserMachineAuthorization,
    dependencies: BrowserMachineTransportDependencies = {},
  ): Promise<BrowserMachineWorkspaceTransport> {
    const now = dependencies.now?.() ?? Date.now();
    const protocol = typeof window === "undefined" ? "https:" : window.location.protocol;
    if (!isUsableBrowserMachineRoute(authorization.route, protocol, now)) {
      throw new BrowserMachineTransportError("route-unusable", "No browser-safe direct host route is available.");
    }
    const keypair = generateBrowserKeypair();
    const transport = new BrowserMachineWorkspaceTransport(
      { ...authorization, dsk: new Uint8Array(authorization.dsk) },
      new Uint8Array(keypair.priv),
      new Uint8Array(keypair.pub),
      dependencies,
    );
    keypair.priv.fill(0);
    keypair.pub.fill(0);
    try {
      await transport.bootstrap();
      await transport.openSocket();
      return transport;
    } catch (error) {
      transport.close();
      throw error;
    }
  }

  get operations(): readonly string[] {
    return this.endpointInfo?.operations ?? [];
  }

  get isOpen(): boolean {
    return !this.closed && this.socket?.readyState === 1 && this.sessionToken !== null;
  }

  setDisconnectedHandler(handler: (() => void) | null): void {
    this.disconnectedHandler = handler;
  }

  private async postJson<T>(url: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MACHINE_HTTP_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const code = isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === "string"
          ? payload.error.code
          : `http-${response.status}`;
        throw new BrowserMachineTransportError(code, `The direct host returned ${response.status}.`);
      }
      return payload as T;
    } catch (error) {
      if (error instanceof BrowserMachineTransportError) throw error;
      throw new BrowserMachineTransportError("route-unreachable", "The browser could not reach the direct host.");
    } finally {
      clearTimeout(timeout);
    }
  }

  private async bootstrap(): Promise<void> {
    const infoResponse = await this.fetchImpl(machineInfoPath(this.authorization.route), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
      signal: AbortSignal.timeout(MACHINE_HTTP_TIMEOUT_MS),
    }).catch(() => null);
    if (!infoResponse?.ok) {
      throw new BrowserMachineTransportError("route-unreachable", "The direct host identity could not be verified.");
    }
    const info: unknown = await infoResponse.json().catch(() => null);
    if (
      !isRecord(info) || info.protocolVersion !== MESH_MACHINE_PROTOCOL_VERSION ||
      info.machineId !== this.authorization.route.machineId ||
      info.endpointGeneration !== this.authorization.route.endpointGeneration ||
      !Array.isArray(info.capabilities) || !Array.isArray(info.operations) ||
      !isRecord(info.transport) || typeof info.transport.maxFrameBytes !== "number" ||
      info.transport.maxFrameBytes < 1024
    ) {
      throw new BrowserMachineTransportError("route-generation-mismatch", "The direct host route has changed.");
    }
    this.endpointInfo = info as unknown as MeshMachineEndpointInfo;
    for (const capability of MESH_MACHINE_CAPABILITIES.slice(0, 2)) {
      if (!this.endpointInfo.capabilities.includes(capability)) {
        throw new BrowserMachineTransportError("unsupported-route", "The direct host does not support browser sessions.");
      }
    }

    const clientPublicKey = encodeBase64(this.clientPublicKey);
    const bootstrapChallenge = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const ticket = await this.authorization.issueAdmissionTicket({ clientPublicKey, bootstrapChallenge });
    if (!validateDashboardAdmissionTicket(ticket, this.authorization, clientPublicKey, bootstrapChallenge, this.now())) {
      throw new BrowserMachineTransportError("invalid-admission-ticket", "The workspace service returned an invalid host ticket.");
    }
    const challengeRequest: MeshMachineChallengeRequest = {
      v: 1,
      mode: "admission",
      ticket: ticket.ticket,
      clientPublicKey,
    };
    const challenge = await this.postJson<MeshMachineBootstrapChallenge>(
      machineChallengePath(this.authorization.route),
      challengeRequest,
    );
    if (
      !isRecord(challenge) || challenge.v !== 1 || challenge.mode !== "admission" ||
      typeof challenge.challengeId !== "string" || typeof challenge.nonce !== "string" ||
      typeof challenge.epoch !== "string" || challenge.machineId !== this.authorization.route.machineId ||
      challenge.endpointGeneration !== this.authorization.route.endpointGeneration ||
      challenge.clientPublicKey !== clientPublicKey || typeof challenge.expiresAt !== "string" ||
      Date.parse(challenge.expiresAt) <= this.now() ||
      !validateBrowserMachineClaims(challenge.claims, this.authorization, clientPublicKey, this.now()) ||
      challenge.challengeId !== challenge.claims.bootstrapId ||
      challenge.nonce !== challenge.claims.challenge ||
      challenge.claims.challenge !== ticket.claims.bootstrapChallenge
    ) {
      throw new BrowserMachineTransportError("invalid-challenge", "The direct host returned an out-of-scope session challenge.");
    }
    const claims = challenge.claims;
    this.allowedOperations = new Set(
      claims.scope.operations.filter((operation) =>
        (BROWSER_WORKSPACE_OPERATIONS as readonly string[]).includes(operation),
      ),
    );
    const proof = encodeBase64(await hmacSha256(
      this.authorization.dsk,
      meshMachineBootstrapProofMessage(claims as MeshMachineBootstrapClaims),
    ));
    const bootstrap = await this.postJson<MeshMachineBootstrapResponse>(machineBootstrapPath(this.authorization.route), {
      v: 1,
      challengeId: challenge.challengeId,
      proof,
    });
    if (
      !isRecord(bootstrap) || bootstrap.v !== 1 || typeof bootstrap.sessionId !== "string" ||
      bootstrap.machineId !== this.authorization.route.machineId ||
      bootstrap.endpointGeneration !== this.authorization.route.endpointGeneration ||
      !isRecord(bootstrap.sessionClaims) ||
      bootstrap.sessionClaims.accountId !== claims.accountId ||
      bootstrap.sessionClaims.machineId !== claims.machineId ||
      bootstrap.sessionClaims.endpointGeneration !== claims.endpointGeneration ||
      bootstrap.sessionClaims.sessionId !== bootstrap.sessionId ||
      !sameDashboardPrincipal(bootstrap.sessionClaims.principal, claims.principal) ||
      !isRecord(bootstrap.stream) || typeof bootstrap.stream.epoch !== "string" ||
      typeof bootstrap.stream.nextSequence !== "number" || !Number.isSafeInteger(bootstrap.stream.nextSequence)
    ) {
      throw new BrowserMachineTransportError("invalid-session", "The direct host returned an invalid session.");
    }
    const tokenInner = await openBrowserMachineSessionToken(
      bootstrap.sessionToken,
      this.clientPrivateKey,
      this.clientPublicKey,
      browserMachineSessionTokenAssociatedData(bootstrap.sessionClaims),
    );
    if (tokenInner === null || tokenInner.sessionId !== bootstrap.sessionId) {
      throw new BrowserMachineTransportError("invalid-session-token", "The direct host session token could not be authenticated.");
    }
    this.sessionId = tokenInner.sessionId;
    this.sessionToken = tokenInner.sessionToken;
    this.authorization.dsk.fill(0);
    this.epoch = bootstrap.stream.epoch;
    this.cursor = { epoch: bootstrap.stream.epoch, sequence: bootstrap.stream.nextSequence - 1 };
  }

  private async waitForHandshakeFrame(timeoutMs: number): Promise<BrowserMachineHandshakeFrame> {
    const queued = this.handshakeFrames.shift();
    if (queued) return queued;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.handshakeWaiter === receive) this.handshakeWaiter = null;
        reject(new BrowserMachineTransportError("socket-auth-timeout", "The direct host did not finish session authentication."));
      }, timeoutMs);
      const receive = (frame: BrowserMachineHandshakeFrame) => {
        clearTimeout(timeout);
        if (this.handshakeWaiter === receive) this.handshakeWaiter = null;
        resolve(frame);
      };
      this.handshakeWaiter = receive;
    });
  }

  private async openSocket(): Promise<void> {
    const socket = this.socketFactory(machineSocketUrl(this.authorization.route), MESH_MACHINE_SOCKET_SUBPROTOCOL);
    this.socket = socket;
    socket.onmessage = (event) => {
      this.receiveTail = this.receiveTail.then(() => this.receiveRawFrame(event.data)).catch(() => undefined);
    };
    socket.onerror = () => this.failPending("socket-error", "The direct host connection failed.");
    socket.onclose = () => {
      this.failPending("socket-closed", "The direct host connection closed.");
      this.sessionToken?.fill(0);
      this.sessionToken = null;
      this.closed = true;
      if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      this.disconnectedHandler?.();
    };
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new BrowserMachineTransportError("socket-open-timeout", "The direct host did not accept a WebSocket connection.")), SOCKET_AUTH_TIMEOUT_MS);
      socket.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new BrowserMachineTransportError("socket-unavailable", "The browser could not open a direct WebSocket connection."));
      };
    });
    const challenge = await this.waitForHandshakeFrame(SOCKET_AUTH_TIMEOUT_MS);
    const bootstrapEpoch = this.cursor?.epoch;
    if (
      challenge.kind !== "auth-challenge" || this.sessionId === null || this.sessionToken === null ||
      challenge.epoch !== bootstrapEpoch
    ) {
      throw new BrowserMachineTransportError("invalid-socket-challenge", "The direct host sent an invalid WebSocket challenge.");
    }
    const proof = encodeBase64(await hmacSha256(
      this.sessionToken,
      meshMachineSocketProofMessage({
        sessionId: this.sessionId,
        nonce: challenge.nonce,
        machineId: this.authorization.route.machineId,
        endpointGeneration: this.authorization.route.endpointGeneration,
      }),
    ));
    socket.send(JSON.stringify({ type: "auth", sessionId: this.sessionId, proof }));
    const ready = await this.waitForHandshakeFrame(SOCKET_AUTH_TIMEOUT_MS);
    if (
      ready.kind !== "ready" || ready.sessionId !== this.sessionId ||
      ready.epoch !== challenge.epoch ||
      typeof ready.nextClientSequence !== "number" || !Number.isSafeInteger(ready.nextClientSequence) ||
      typeof ready.nextSequence !== "number" || !Number.isSafeInteger(ready.nextSequence) ||
      typeof ready.oldestSequence !== "number" || !Number.isSafeInteger(ready.oldestSequence) ||
      !Number.isFinite(Date.parse(ready.authorizationValidUntil)) ||
      Date.parse(ready.authorizationValidUntil) <= this.now()
    ) {
      throw new BrowserMachineTransportError("socket-auth-rejected", "The direct host refused this browser session.");
    }
    this.nextSequence = ready.nextClientSequence;
    this.epoch = ready.epoch;
    if (this.cursor?.epoch !== ready.epoch) this.cursor = undefined;
    if (this.cursor && this.cursor.sequence < ready.oldestSequence - 1) this.cursor = undefined;
    this.authorizationValidUntil = Date.parse(ready.authorizationValidUntil);
    this.refreshTimer = setInterval(() => this.refreshAuthorization(), MESH_MACHINE_SESSION_REFRESH_INTERVAL_MS);
  }

  private async receiveRawFrame(data: unknown): Promise<void> {
    let text: string;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else if (typeof Blob !== "undefined" && data instanceof Blob) text = await data.text();
    else return;
    if (encoder.encode(text).byteLength > (this.endpointInfo?.transport.maxFrameBytes ?? MAX_FALLBACK_FRAME_BYTES)) {
      this.failPending("oversized-frame", "The direct host sent an oversized frame.");
      this.socket?.close(1009, "frame too large");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.failPending("invalid-frame", "The direct host sent an invalid frame.");
      return;
    }
    const frame = parseServerFrame(parsed);
    if (frame === null) return;
    if (frame.type === "auth-challenge") {
      this.epoch = frame.epoch;
      this.deliverHandshakePayload({ kind: "auth-challenge", nonce: frame.nonce, epoch: frame.epoch });
      return;
    }
    if (frame.sessionId !== this.sessionId || this.sessionToken === null || this.epoch === null) {
      this.failPending("session-mismatch", "The direct host frame belongs to a different session.");
      this.socket?.close(1008, "session mismatch");
      return;
    }
    if (this.lastServerSequence !== null && frame.sequence <= this.lastServerSequence) return;
    const requestId = frame.requestId;
    const payload = await openSessionPayload(this.sessionToken, frame.envelope, {
      sessionId: frame.sessionId,
      machineId: this.authorization.route.machineId,
      endpointGeneration: this.authorization.route.endpointGeneration,
      epoch: this.epoch,
      ...(requestId === undefined ? {} : { requestId }),
      sequence: frame.sequence,
    });
    if (payload === null) {
      this.failPending("frame-authentication-failed", "The direct host frame could not be authenticated.");
      this.socket?.close(1008, "invalid encrypted frame");
      return;
    }
    if (this.lastServerSequence !== null && frame.sequence > this.lastServerSequence + 1 && payload.kind !== "ready") {
      this.failPending("socket-sequence-gap", "The direct host stream skipped encrypted frames.");
      this.cursor = undefined;
      void this.requestResnapshot("sequence-gap");
    }
    this.lastServerSequence = frame.sequence;
    await this.receiveServerPayload(payload, requestId ?? "", frame.sequence);
  }

  private deliverHandshakePayload(frame: BrowserMachineHandshakeFrame): void {
    if (this.handshakeWaiter) this.handshakeWaiter(frame);
    else if (this.handshakeFrames.length < 4) this.handshakeFrames.push(frame);
  }

  private async receiveServerPayload(
    frame: MeshMachineServerPayload,
    outerRequestId: string,
    outerSequence: number,
  ): Promise<void> {
    if (frame.kind === "ready") {
      this.deliverHandshakePayload(frame);
      return;
    }
    if (frame.kind === "response") {
      if (frame.requestId !== outerRequestId) return;
      const pending = this.pending.get(frame.requestId);
      if (pending === undefined) return;
      this.pending.delete(frame.requestId);
      clearTimeout(pending.timer);
      pending.resolve({ requestId: frame.requestId, sequence: pending.sequence, result: frame.result });
      return;
    }
    if (frame.kind === "refreshed") {
      if (
        frame.requestId !== outerRequestId ||
        !this.refreshRequests.delete(frame.requestId) ||
        !Number.isFinite(Date.parse(frame.authorizationValidUntil)) ||
        Date.parse(frame.authorizationValidUntil) <= this.now()
      ) {
        this.failPending("refresh-rejected", "The direct host did not refresh browser authorization.");
        this.socket?.close(1008, "authorization refresh rejected");
        return;
      }
      this.authorizationValidUntil = Date.parse(frame.authorizationValidUntil);
      return;
    }
    if (frame.kind === "event") {
      await this.receiveEvent({
        epoch: frame.epoch,
        sequence: frame.sequence,
        workspaceId: frame.workspaceId,
        ...(frame.jobId === undefined ? {} : { jobId: frame.jobId }),
        kind: frame.eventKind,
        payload: frame.payload,
      });
      return;
    }
    if (frame.kind === "resnapshot-required") {
      this.epoch = frame.epoch;
      this.cursor = undefined;
      void this.requestResnapshot(frame.reason);
      return;
    }
    if (frame.kind === "session.revoked") {
      this.failPending("session-revoked", "The browser workspace grant was revoked.");
      this.sessionToken?.fill(0);
      this.sessionToken = null;
      this.socket?.close(1000, "session revoked");
      return;
    }
    if (frame.kind === "error" && frame.requestId) {
      if (this.refreshRequests.delete(frame.requestId)) {
        this.failPending("refresh-rejected", "The direct host could not refresh browser authorization.");
        this.socket?.close(1008, "authorization refresh failed");
        return;
      }
      const pending = this.pending.get(frame.requestId);
      if (pending) {
        this.pending.delete(frame.requestId);
        clearTimeout(pending.timer);
        pending.reject(new BrowserMachineTransportError(frame.code, frame.message, pending.sent));
      }
    }
    void outerSequence;
  }

  private async receiveEvent(frame: BrowserMachineEvent): Promise<void> {
    if (!this.streamHandlers || !this.subscribedWorkspaceIds.includes(frame.workspaceId)) return;
    const decision = decideBrowserMachineCursor(this.cursor, frame);
    if (decision.kind === "duplicate") {
      this.sendAck(frame);
      return;
    }
    if (decision.kind === "resnapshot") {
      this.cursor = undefined;
      await this.requestResnapshot(decision.reason);
      return;
    }
    try {
      await this.streamHandlers.onEvent(frame);
      this.cursor = decision.cursor;
      this.sendAck(frame);
    } catch {
      this.cursor = undefined;
      await this.requestResnapshot("sequence-gap");
    }
  }

  private sendAck(frame: BrowserMachineEvent): void {
    if (!this.isOpen || !this.cursor) return;
    const requestId = this.subscriptionRequestId ?? randomRequestId();
    void this.sendFrame(
      { kind: "ack", requestId, cursor: { epoch: frame.epoch, sequence: frame.sequence } },
      requestId,
      this.takeSequence(),
    ).catch(() => undefined);
  }

  private async requestResnapshot(reason: "epoch-changed" | "cursor-expired" | "sequence-gap"): Promise<void> {
    if (!this.streamHandlers || this.closed) return;
    try {
      await this.streamHandlers.onResnapshot(reason);
      if (this.isOpen) this.subscribe(this.subscribedWorkspaceIds, undefined);
    } catch {
      // Keep the cursor empty. A later resubscribe will request another snapshot.
    }
  }

  private takeSequence(): number {
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    return sequence;
  }

  private refreshAuthorization(): void {
    if (!this.isOpen || this.refreshRequests.size > 0) return;
    if (this.authorizationValidUntil <= this.now()) {
      this.failPending("authorization-expired", "The direct host authorization expired.");
      this.socket?.close(1008, "authorization expired");
      return;
    }
    const requestId = randomRequestId();
    this.refreshRequests.add(requestId);
    try {
      void this.sendFrame({ kind: "refresh", requestId }, requestId, this.takeSequence()).catch(() => {
        this.refreshRequests.delete(requestId);
      });
    } catch {
      this.refreshRequests.delete(requestId);
      if (this.authorizationValidUntil <= this.now() + 5_000) {
        this.failPending("authorization-expired", "The direct host authorization could not be refreshed.");
        this.socket?.close(1008, "authorization refresh unavailable");
      }
    }
  }

  private sendFrame(payload: MeshMachineClientPayload, requestId: string, sequence: number): Promise<void> {
    const send = this.sendTail.then(async () => {
      if (!this.isOpen || this.socket === null || this.sessionId === null || this.sessionToken === null || this.epoch === null) {
        throw new BrowserMachineTransportError("socket-closed", "The direct host connection is not open.");
      }
      const envelope = await sealSessionPayload(this.sessionToken, payload, {
        sessionId: this.sessionId,
        machineId: this.authorization.route.machineId,
        endpointGeneration: this.authorization.route.endpointGeneration,
        epoch: this.epoch,
        requestId,
        sequence,
      });
      const serialized = JSON.stringify({ type: "data", sessionId: this.sessionId, requestId, sequence, envelope });
      const bytes = encoder.encode(serialized).byteLength;
      const max = this.endpointInfo?.transport.maxFrameBytes ?? MAX_FALLBACK_FRAME_BYTES;
      if (bytes > max) throw new BrowserMachineTransportError("frame-too-large", "The direct host request is too large.");
      this.socket.send(serialized);
    });
    this.sendTail = send.catch(() => undefined);
    return send;
  }

  request(operation: MeshMachineOperation, payload: unknown, timeoutMs: number): Promise<BrowserMachineResponse> {
    if (!this.endpointInfo?.operations.includes(operation) || !this.allowedOperations.has(operation)) {
      return Promise.reject(new BrowserMachineTransportError("unsupported-operation", "The direct host does not support this operation."));
    }
    if (!this.isOpen) return Promise.reject(new BrowserMachineTransportError("socket-closed", "The direct host connection is not open."));
    if (this.authorizationValidUntil <= this.now()) {
      return Promise.reject(new BrowserMachineTransportError("authorization-expired", "The direct host authorization expired."));
    }
    const requestId = randomRequestId();
    const sequence = this.takeSequence();
    return new Promise((resolve, reject) => {
      const pending: PendingResponse = {
        sequence,
        sent: false,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(requestId);
          reject(new BrowserMachineTransportError("request-timeout", "The direct host command did not finish in time.", pending.sent));
        }, timeoutMs),
      };
      this.pending.set(requestId, pending);
      try {
        void this.sendFrame({ kind: "request", requestId, operation, payload }, requestId, sequence)
          .then(() => { pending.sent = true; })
          .catch((error) => {
            this.pending.delete(requestId);
            clearTimeout(pending.timer);
            reject(error instanceof BrowserMachineTransportError ? error : new BrowserMachineTransportError("send-failed", "The direct host request could not be sent."));
          });
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        reject(error instanceof BrowserMachineTransportError ? error : new BrowserMachineTransportError("send-failed", "The direct host request could not be sent."));
      }
    });
  }

  subscribe(workspaceIds: string[], handlers?: BrowserMachineStreamHandlers, cursor = this.cursor): void {
    if (handlers) this.streamHandlers = handlers;
    this.subscribedWorkspaceIds = [...new Set(workspaceIds)];
    if (!this.isOpen || this.subscribedWorkspaceIds.length === 0) return;
    const requestId = randomRequestId();
    this.subscriptionRequestId = requestId;
    void this.sendFrame({
      kind: "subscribe",
      requestId,
      ...(cursor ? { cursor } : {}),
      workspaceIds: this.subscribedWorkspaceIds,
    }, requestId, this.takeSequence()).catch(() => undefined);
  }

  unsubscribe(): void {
    this.streamHandlers = null;
    this.subscribedWorkspaceIds = [];
    this.subscriptionRequestId = null;
  }

  private failPending(code: string, message: string): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(new BrowserMachineTransportError(code, message, pending.sent));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failPending("session-closed", "The browser workspace direct session closed.");
    this.sessionToken?.fill(0);
    this.sessionToken = null;
    this.authorization.dsk.fill(0);
    this.clientPrivateKey.fill(0);
    this.clientPublicKey.fill(0);
    this.socket?.close(1000, "client closed");
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.socket = null;
    this.streamHandlers = null;
  }
}
