import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  MESH_MACHINE_MAX_FRAME_BYTES,
  MESH_MACHINE_OPERATIONS,
  MESH_MACHINE_SESSION_AUTHORIZATION_MAX_AGE_MS,
  MESH_MACHINE_SESSION_REFRESH_INTERVAL_MS,
  MESH_MACHINE_SESSION_TTL_MS,
  meshMachineAdmissionBootstrapProofMessage,
  meshMachineBootstrapHostProofMessage,
  meshMachineFrameAssociatedData,
  meshMachineSessionTokenAssociatedData,
  meshMachineSocketProofMessage,
  meshMachineTrafficKeyDerivation,
  isMeshMachineEnrollmentAdmissionClaims,
  type MeshMachineAdmissionClaims,
  type MeshMachineAdmissionConsumeResponse,
  type MeshMachineEnrollmentAdmissionClaims,
  type MeshMachineBootstrapChallenge,
  type MeshMachineBootstrapClaims,
  type MeshMachineBootstrapRequest,
  type MeshMachineBootstrapResponse,
  type MeshMachineChallengeRequest,
  type MeshMachineClientFrame,
  type MeshMachineClientPayload,
  type MeshMachineCursor,
  type MeshMachineEndpointInfo,
  type MeshMachineEncryptedEnvelope,
  type MeshMachineOperation,
  type MeshMachineSessionPrincipal,
  type MeshMachineSessionScope,
  type MeshMachineServerFrame,
  type MeshMachineServerPayload,
  type MeshMachineTransportLimits,
} from '../../../cloud/contract/machine';
import type { SyncScope } from '../../shared/sync-mesh.js';
import { sealToRecipientPub } from './sync-keyring.service.js';

const X25519_PUBLIC_BYTES = 32;
const MAX_CHALLENGES = 256;
const MAX_SESSIONS = 64;
const MAX_REQUEST_RECEIPTS = 256;
const MAX_STREAM_EVENTS = 512;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_FRAME_BYTES = MESH_MACHINE_MAX_FRAME_BYTES;
const SESSION_MAX_AGE_MS = MESH_MACHINE_SESSION_TTL_MS;
const AUTHORIZATION_MAX_AGE_MS = MESH_MACHINE_SESSION_AUTHORIZATION_MAX_AGE_MS;
const REFRESH_INTERVAL_MS = MESH_MACHINE_SESSION_REFRESH_INTERVAL_MS;

export interface MeshHostDashboardContext {
  accountId: string;
  sourceBrowserId: string;
  grantId: string;
  trustId?: string;
  origin: string;
  workspaceIds: string[];
  repositoryIds: string[];
  scopes: string[];
  sessionScope: MeshMachineSessionScope;
  expiresAt: string;
};

export interface MeshHostOperationInput {
  sessionId: string;
  principal: MeshMachineSessionPrincipal;
  scope: MeshMachineSessionScope;
  operation: MeshMachineOperation;
  requestId: string;
  payload: unknown;
}

export type MeshHostAdmissionAuthorization =
  | { state: 'authorized'; principal: Extract<MeshMachineSessionPrincipal, { kind: 'enrollment' }> }
  | { state: 'approval-required' }
  | { state: 'denied' }
  | { state: 'unavailable' };

export class MeshHostAdmissionError extends Error {
  constructor(readonly code: 'approval-required' | 'device-denied' | 'authorization-unavailable') {
    super(code);
  }
}

export interface MeshHostSessionBindings {
  identity: () => { hostEnrollmentId: string; machineId: string; endpointGeneration: string };
  activeScope: () => SyncScope | null;
  consumeAdmissionTicket?: (ticket: string) => Promise<MeshMachineAdmissionConsumeResponse>;
  authorizeAdmission?: (
    claims: MeshMachineEnrollmentAdmissionClaims,
  ) => MeshHostAdmissionAuthorization | Promise<MeshHostAdmissionAuthorization>;
  revalidateAdmission?: (
    claims: MeshMachineEnrollmentAdmissionClaims,
  ) => Promise<{ authorized: boolean; validUntil: string }>;
  getDashboardContext?: (scope: SyncScope, grantId: string) => MeshHostDashboardContext | null;
  verifyDashboardProof?: (
    scope: SyncScope,
    claims: MeshMachineBootstrapClaims,
    proof: string,
  ) => boolean;
  createDashboardHostProof?: (
    scope: SyncScope,
    claims: MeshMachineBootstrapClaims,
    challengeId: string,
    nonce: string,
    response: Omit<MeshMachineBootstrapResponse, 'hostProof'>,
  ) => string | null;
  refreshDashboard?: (scope: SyncScope, grantId: string) => Promise<boolean>;
  dispatchOperation?: (input: MeshHostOperationInput) => Promise<unknown>;
}

export type MeshHostSessionRuntimeBindings = Pick<
  MeshHostSessionBindings,
  'consumeAdmissionTicket' | 'authorizeAdmission' | 'revalidateAdmission' | 'dispatchOperation'
>;

let runtimeBindings: Partial<MeshHostSessionRuntimeBindings> = {};

/** Runtime callbacks are configured by sync-runtime when its authenticated RPC context is ready. */
export function configureMeshHostSessionBindings(
  bindings: Partial<MeshHostSessionRuntimeBindings>,
): void {
  runtimeBindings = { ...runtimeBindings, ...bindings };
}

export function resetMeshHostSessionBindingsForTests(): void {
  runtimeBindings = {};
}

let listenerSessionService: MeshHostSessionService | null = null;

export function registerMeshHostSessionService(service: MeshHostSessionService): () => void {
  listenerSessionService?.shutdown();
  listenerSessionService = service;
  return () => {
    if (listenerSessionService !== service) return;
    service.shutdown();
    listenerSessionService = null;
  };
}

/** Publish current-account activity to local session subscribers; stale scope events are dropped. */
export function publishMeshHostEvent(
  input: MeshMachineStreamEventInput,
  sourceScope?: SyncScope,
): StreamEvent | null {
  return listenerSessionService?.publishEvent(input, sourceScope) ?? null;
}

/** Build a listener-owned service while allowing runtime RPC callbacks to change after sign-in. */
export function createMeshHostSessionService(
  bindings: Pick<MeshHostSessionBindings, 'identity' | 'activeScope'> &
    Pick<
      MeshHostSessionBindings,
      'getDashboardContext' | 'verifyDashboardProof' | 'createDashboardHostProof' | 'refreshDashboard'
    >,
): MeshHostSessionService {
  return new MeshHostSessionService({
    ...bindings,
    consumeAdmissionTicket: (ticket) => {
      const callback = runtimeBindings.consumeAdmissionTicket;
      if (callback === undefined) return Promise.reject(new Error('Mesh admission is unavailable.'));
      return callback(ticket);
    },
    authorizeAdmission: async (claims) =>
      (await runtimeBindings.authorizeAdmission?.(claims)) ?? { state: 'unavailable' },
    revalidateAdmission: (claims) => {
      const callback = runtimeBindings.revalidateAdmission;
      if (callback === undefined) return Promise.resolve({ authorized: false, validUntil: '' });
      return callback(claims);
    },
    dispatchOperation: (operation) => {
      const callback = runtimeBindings.dispatchOperation;
      if (callback === undefined) return Promise.reject(new Error('Mesh operation is unavailable.'));
      return callback(operation);
    },
  });
}

interface ChallengeRecord {
  challenge: MeshMachineBootstrapChallenge;
  createdAtMonotonic: number;
  proofKey: Buffer | null;
  ticketClaims: MeshMachineAdmissionClaims | null;
  dashboardGrantId: string | null;
  approvedOrigin: string | null;
  used: boolean;
}

interface RequestReceipt {
  digest: string;
  result?: unknown;
  pending?: Promise<unknown>;
  createdAt: number;
}

interface StreamEvent {
  epoch: string;
  sequence: number;
  workspaceId: string;
  jobId?: string;
  eventKind: string;
  payload: unknown;
  byteLength: number;
}

interface SessionRecord {
  sessionId: string;
  sessionToken: Buffer;
  accountId: string;
  backendId: string;
  datasetEpoch: string;
  machineId: string;
  endpointGeneration: string;
  principal: MeshMachineSessionPrincipal;
  admissionClaims?: MeshMachineEnrollmentAdmissionClaims;
  scope: MeshMachineSessionScope;
  issuedAt: string;
  expiresAt: string;
  expiresAtMonotonic: number;
  authorizationValidUntil: string;
  authorizationDeadlineMonotonic: number;
  lastRefreshAtMonotonic: number;
  nextClientSequence: number;
  nextServerSequence: number;
  lastAcknowledged: MeshMachineCursor | null;
  subscribedWorkspaceIds: Set<string>;
  receipts: Map<string, RequestReceipt>;
  revoked: boolean;
}

export interface MeshMachineStreamEventInput {
  workspaceId: string;
  jobId?: string;
  eventKind: string;
  payload: unknown;
}

/** In-memory host authority. A process restart invalidates its epoch and all sessions. */
export class MeshHostSessionService {
  private readonly bindings: MeshHostSessionBindings;
  private epoch = randomUUID();
  private streamScopeKey: string | undefined;
  private readonly challenges = new Map<string, ChallengeRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly events: StreamEvent[] = [];
  private readonly eventListeners = new Set<(event: StreamEvent) => void>();
  private eventBytes = 0;
  private nextEventSequence = 1;

  constructor(bindings: MeshHostSessionBindings) {
    this.bindings = bindings;
  }

  invalidateAll(): void {
    this.resetSessionState();
    this.streamScopeKey = undefined;
  }

  shutdown(): void {
    this.invalidateAll();
    this.eventListeners.clear();
  }

  endpointInfo(): MeshMachineEndpointInfo {
    const { hostEnrollmentId, machineId, endpointGeneration } = this.bindings.identity();
    return {
      hostEnrollmentId,
      machineId,
      endpointGeneration,
      protocolVersion: 1,
      capabilities: ['machine.session/1', 'machine.stream/1', 'dashboard.command.wake/1'],
      operations: [...MESH_MACHINE_OPERATIONS],
      transport: {
        socketPath: '/api/machine/v1/sessions/socket',
        maxFrameBytes: MESH_MACHINE_MAX_FRAME_BYTES,
        replayEvents: MAX_STREAM_EVENTS,
        replayBytes: MAX_STREAM_BYTES,
        sessionRefreshIntervalMs: REFRESH_INTERVAL_MS,
        sessionAuthorizationMaxAgeMs: AUTHORIZATION_MAX_AGE_MS,
      } satisfies MeshMachineTransportLimits,
    };
  }

  async createChallenge(
    request: MeshMachineChallengeRequest,
    requestOrigin?: string,
  ): Promise<MeshMachineBootstrapChallenge> {
    this.prune();
    if (this.challenges.size >= MAX_CHALLENGES) throw new Error('challenge-capacity');
    const clientPublicKey = strictBase64(request.clientPublicKey, X25519_PUBLIC_BYTES);
    if (clientPublicKey === null) throw new Error('invalid-client-key');
    const identity = this.bindings.identity();
    const scope = this.bindings.activeScope();
    if (scope === null) throw new Error('host-account-unavailable');
    this.ensureScope(scope);

    if (request.mode === 'admission') {
      if (!request.ticket || request.ticket.length > 4096 || this.bindings.consumeAdmissionTicket === undefined) {
        throw new Error('admission-unavailable');
      }
      const consumed = await this.bindings.consumeAdmissionTicket(request.ticket);
      const claims = consumed.claims;
      const ticketPublicKey = strictBase64(claims.clientPublicKey, X25519_PUBLIC_BYTES);
      const currentScope = this.bindings.activeScope();
      const currentIdentity = this.bindings.identity();
      if (currentScope !== null) this.ensureScope(currentScope);
      if (
        ticketPublicKey === null ||
        ticketPublicKey.toString('base64') !== clientPublicKey.toString('base64') ||
        currentScope === null ||
        currentScope.backendId !== scope.backendId ||
        currentScope.accountId !== scope.accountId ||
        currentScope.datasetEpoch !== scope.datasetEpoch ||
        claims.accountId !== currentScope.accountId ||
        claims.hostEnrollmentId !== currentIdentity.hostEnrollmentId ||
        claims.hostMachineId !== currentIdentity.machineId ||
        claims.endpointGeneration !== currentIdentity.endpointGeneration ||
        claims.v !== 1 ||
        !isCanonicalIsoDate(claims.issuedAt) ||
        !isCanonicalIsoDate(claims.expiresAt) ||
        Date.parse(claims.expiresAt) <= Date.now() ||
        Date.parse(claims.issuedAt) > Date.now() + 5_000 ||
        Date.parse(claims.expiresAt) - Date.parse(claims.issuedAt) > 60_000 ||
        !isCanonicalBase64UrlNonce(claims.bootstrapChallenge) ||
        !isAllowedAdmissionClaims(claims)
      ) {
        throw new Error('admission-invalid');
      }
      let proofKey: Buffer | null = null;
      let dashboardGrantId: string | null = null;
      let responseClaims: MeshMachineBootstrapClaims | MeshMachineAdmissionClaims = claims;
      const challengeId = randomUUID();
      if (isMeshMachineEnrollmentAdmissionClaims(claims)) {
        proofKey = consumed.proofKey === undefined ? null : strictBase64Url(consumed.proofKey, 32);
        if (proofKey === null) throw new Error('admission-invalid');
        let authorization: MeshHostAdmissionAuthorization;
        try {
          authorization = this.bindings.authorizeAdmission === undefined
            ? { state: 'unavailable' }
            : await this.bindings.authorizeAdmission(claims);
        } catch (error) {
          proofKey?.fill(0);
          throw error;
        }
        const latestScope = this.bindings.activeScope();
        if (latestScope !== null) this.ensureScope(latestScope);
        const latestIdentity = this.bindings.identity();
        if (
          proofKey === null ||
          requestOrigin !== undefined ||
          !sameSyncScope(scope, latestScope) ||
          latestIdentity.hostEnrollmentId !== identity.hostEnrollmentId ||
          latestIdentity.machineId !== identity.machineId ||
          latestIdentity.endpointGeneration !== identity.endpointGeneration ||
          authorization.state !== 'authorized' ||
          authorization.principal.accountId !== scope.accountId ||
          authorization.principal.sourceEnrollmentId !== claims.principal.sourceEnrollmentId
        ) {
          proofKey?.fill(0);
          if (authorization.state === 'approval-required') throw new MeshHostAdmissionError('approval-required');
          if (authorization.state === 'denied') throw new MeshHostAdmissionError('device-denied');
          throw new Error('admission-not-authorized');
        }
      } else {
        const dashboard = this.bindings.getDashboardContext?.(scope, claims.principal.grantId) ?? null;
        if (
          dashboard === null ||
          requestOrigin !== claims.principal.origin ||
          dashboard.origin !== claims.principal.origin ||
          dashboard.accountId !== claims.accountId ||
          !isCanonicalOrigin(claims.principal.origin)
        ) {
          throw new Error('dashboard-admission-not-authorized');
        }
        const issuedAt = new Date().toISOString();
        const expiresAt = new Date(
          Math.min(Date.now() + 30_000, Date.parse(dashboard.expiresAt), Date.parse(claims.expiresAt)),
        ).toISOString();
        responseClaims = {
          v: 1,
          bootstrapId: challengeId,
          challenge: claims.bootstrapChallenge,
          accountId: claims.accountId,
          sourceEnrollmentId: null,
          machineId: identity.machineId,
          endpointGeneration: identity.endpointGeneration,
          clientPublicKey: claims.clientPublicKey,
          capabilities: ['machine.session/1', 'machine.stream/1', 'dashboard.command.wake/1'],
          principal: {
            kind: 'dashboard',
            accountId: dashboard.accountId,
            sourceBrowserId: dashboard.sourceBrowserId,
            grantId: dashboard.grantId,
            ...(dashboard.trustId === undefined ? {} : { trustId: dashboard.trustId }),
          },
          scope: dashboard.sessionScope,
          issuedAt,
          expiresAt,
        };
        dashboardGrantId = claims.principal.grantId;
      }
      const challenge: MeshMachineBootstrapChallenge = {
        v: 1,
        mode: 'admission',
        challengeId,
        nonce: claims.bootstrapChallenge,
        epoch: this.epoch,
        machineId: identity.machineId,
        endpointGeneration: identity.endpointGeneration,
        clientPublicKey: claims.clientPublicKey,
        expiresAt: new Date(Math.min(Date.now() + 30_000, Date.parse(claims.expiresAt))).toISOString(),
        claims: responseClaims,
      };
      this.challenges.set(challengeId, {
        challenge,
        createdAtMonotonic: performance.now(),
        proofKey,
        ticketClaims: claims,
        dashboardGrantId,
        approvedOrigin: claims.principal.kind === 'dashboard' ? claims.principal.origin : null,
        used: false,
      });
      return challenge;
    }

    if (request.mode !== 'dashboard' || !request.grantId || request.grantId.length > 128) {
      throw new Error('invalid-challenge-request');
    }
    const dashboard = this.bindings.getDashboardContext?.(scope, request.grantId) ?? null;
    if (
      dashboard === null ||
      dashboard.accountId !== scope.accountId ||
      requestOrigin !== dashboard.origin
    ) {
      throw new Error('dashboard-grant-unavailable');
    }
    const issuedAt = new Date().toISOString();
    const challengeNonce = randomBytes(32).toString('base64url');
    const bootstrapId = randomUUID();
    const expiresAt = new Date(
      Math.min(Date.now() + 30_000, Date.parse(dashboard.expiresAt)),
    ).toISOString();
    const claims: MeshMachineBootstrapClaims = {
      v: 1,
      bootstrapId,
      challenge: challengeNonce,
      accountId: dashboard.accountId,
      sourceEnrollmentId: null,
      machineId: identity.machineId,
      endpointGeneration: identity.endpointGeneration,
      clientPublicKey: request.clientPublicKey,
      capabilities: ['machine.session/1', 'machine.stream/1', 'dashboard.command.wake/1'],
      principal: {
        kind: 'dashboard',
        accountId: dashboard.accountId,
        sourceBrowserId: dashboard.sourceBrowserId,
        grantId: dashboard.grantId,
        ...(dashboard.trustId === undefined ? {} : { trustId: dashboard.trustId }),
      },
      scope: dashboard.sessionScope,
      issuedAt,
      expiresAt,
    };
    const challenge: MeshMachineBootstrapChallenge = {
      v: 1,
      mode: 'dashboard',
      challengeId: bootstrapId,
      nonce: challengeNonce,
      epoch: this.epoch,
      machineId: identity.machineId,
      endpointGeneration: identity.endpointGeneration,
      clientPublicKey: request.clientPublicKey,
      expiresAt,
      claims,
    };
    this.challenges.set(bootstrapId, {
      challenge,
      createdAtMonotonic: performance.now(),
      proofKey: null,
      ticketClaims: null,
      dashboardGrantId: request.grantId,
      approvedOrigin: dashboard.origin,
      used: false,
    });
    return challenge;
  }

  async bootstrap(
    request: MeshMachineBootstrapRequest,
    requestOrigin?: string,
  ): Promise<MeshMachineBootstrapResponse> {
    this.prune();
    const record = this.challenges.get(request.challengeId);
    if (
      record === undefined ||
      record.used ||
      request.challengeId !== record.challenge.challengeId ||
      Date.parse(record.challenge.expiresAt) <= Date.now() ||
      performance.now() - record.createdAtMonotonic > 30_000 ||
      this.sessions.size >= MAX_SESSIONS
    ) {
      throw new Error('bootstrap-expired');
    }
    if (record.approvedOrigin !== (requestOrigin ?? null)) throw new Error('bootstrap-origin-invalid');
    record.used = true; // Concurrent and subsequent replays fail closed.
    const scope = this.bindings.activeScope();
    if (scope === null) throw new Error('host-account-unavailable');
    const challenge = record.challenge;
    let principal: MeshMachineSessionPrincipal;
    let sessionScope: MeshMachineSessionScope;
  let accountId: string;
    let admissionHostProofKey: Buffer | null = null;
    let admissionClaims: MeshMachineEnrollmentAdmissionClaims | undefined;
    let sessionExpiry = Date.now() + SESSION_MAX_AGE_MS;

    const ticketClaims = record.ticketClaims;
    if (ticketClaims !== null && !isMeshMachineEnrollmentAdmissionClaims(ticketClaims)) {
      const ticket = ticketClaims;
      const claims = challenge.claims as MeshMachineBootstrapClaims;
      const dashboard = this.bindings.getDashboardContext?.(scope, ticket.principal.grantId) ?? null;
      if (
        dashboard === null ||
        claims.principal.kind !== 'dashboard' ||
        claims.principal.grantId !== ticket.principal.grantId ||
        ticket.accountId !== scope.accountId ||
        ticket.hostEnrollmentId !== this.bindings.identity().hostEnrollmentId ||
        ticket.hostMachineId !== this.bindings.identity().machineId ||
        ticket.endpointGeneration !== this.bindings.identity().endpointGeneration ||
        ticket.clientPublicKey !== challenge.clientPublicKey ||
        dashboard.origin !== ticket.principal.origin ||
        this.bindings.verifyDashboardProof?.(scope, claims, request.proof) !== true
      ) {
        throw new Error('bootstrap-proof-invalid');
      }
      principal = claims.principal;
      sessionScope = claims.scope;
      accountId = claims.accountId;
      sessionExpiry = Math.min(sessionExpiry, Date.parse(dashboard.expiresAt));
    } else if (challenge.mode === 'dashboard') {
      const claims = challenge.claims as MeshMachineBootstrapClaims;
      const dashboard = this.bindings.getDashboardContext?.(
        scope,
        claims.principal.kind === 'dashboard' ? claims.principal.grantId : '',
      ) ?? null;
      if (
        dashboard === null ||
        claims.accountId !== scope.accountId ||
        claims.machineId !== this.bindings.identity().machineId ||
        claims.endpointGeneration !== this.bindings.identity().endpointGeneration ||
        this.bindings.verifyDashboardProof?.(scope, claims, request.proof) !== true
      ) {
        throw new Error('bootstrap-proof-invalid');
      }
      principal = claims.principal;
      sessionScope = claims.scope;
      accountId = claims.accountId;
      sessionExpiry = Math.min(sessionExpiry, Date.parse(dashboard.expiresAt));
    } else {
      const ticket = record.ticketClaims;
      if (ticket === null || !isMeshMachineEnrollmentAdmissionClaims(ticket)) {
        throw new Error('bootstrap-proof-invalid');
      }
      const proofKey = record.proofKey;
      if (proofKey === null) throw new Error('bootstrap-proof-invalid');
      const expected = createHmac('sha256', proofKey)
        .update(meshMachineAdmissionBootstrapProofMessage({
          claims: ticket,
          challengeId: challenge.challengeId,
          nonce: challenge.nonce,
        }), 'utf8')
        .digest();
      const actual = strictBase64Url(request.proof, 32);
      const validProof = actual !== null && timingSafeEqual(expected, actual);
      actual?.fill(0);
      if (
        !validProof ||
        ticket.accountId !== scope.accountId ||
        ticket.hostEnrollmentId !== this.bindings.identity().hostEnrollmentId ||
        ticket.hostMachineId !== this.bindings.identity().machineId ||
        ticket.endpointGeneration !== this.bindings.identity().endpointGeneration
      ) {
        proofKey.fill(0);
        record.proofKey = null;
        throw new Error('bootstrap-proof-invalid');
      }
      record.proofKey = null;
      let authorization: MeshHostAdmissionAuthorization;
      try {
        authorization = this.bindings.authorizeAdmission === undefined
          ? { state: 'unavailable' }
          : await this.bindings.authorizeAdmission(ticket);
      } catch (error) {
        proofKey.fill(0);
        throw error;
      }
      const latestScope = this.bindings.activeScope();
      if (latestScope !== null) this.ensureScope(latestScope);
      const latestIdentity = this.bindings.identity();
      if (authorization.state !== 'authorized') {
        proofKey.fill(0);
        if (authorization.state === 'approval-required') throw new MeshHostAdmissionError('approval-required');
        if (authorization.state === 'denied') throw new MeshHostAdmissionError('device-denied');
        throw new MeshHostAdmissionError('authorization-unavailable');
      }
      if (
        !sameSyncScope(scope, latestScope) ||
        latestIdentity.hostEnrollmentId !== ticket.hostEnrollmentId ||
        latestIdentity.machineId !== ticket.hostMachineId ||
        latestIdentity.endpointGeneration !== ticket.endpointGeneration
      ) {
        proofKey.fill(0);
        throw new MeshHostAdmissionError('authorization-unavailable');
      }
      admissionHostProofKey = Buffer.from(proofKey);
      proofKey.fill(0);
      principal = authorization.principal;
      accountId = ticket.accountId;
      sessionScope = {
        workspaceIds: [],
        repositoryIds: [],
        scopes: [...ticket.principal.scopes],
        operations: ticket.principal.operations.filter((operation) =>
          operationsForTier(principal.kind === 'enrollment' ? principal.tier : 'observe').has(operation),
        ),
      };
      admissionClaims = ticket;
      sessionExpiry = Math.min(sessionExpiry, Date.parse(ticket.expiresAt) + SESSION_MAX_AGE_MS);
    }

    let sessionToken: Buffer | null = null;
    let stored = false;
    try {
      const now = Date.now();
      const nowMonotonic = performance.now();
      const sessionId = randomUUID();
      const token = randomBytes(32);
      sessionToken = token;
      const endpoint = this.bindings.identity();
      const sessionExpiresAt = new Date(Math.min(sessionExpiry, now + SESSION_MAX_AGE_MS)).toISOString();
      const authorizationValidUntil = new Date(
        Math.min(now + AUTHORIZATION_MAX_AGE_MS, Date.parse(sessionExpiresAt)),
      ).toISOString();
      const sessionClaims = {
        accountId,
        principal,
        machineId: endpoint.machineId,
        endpointGeneration: endpoint.endpointGeneration,
        sessionId,
      };
      const latestScope = this.bindings.activeScope();
      if (latestScope !== null) this.ensureScope(latestScope);
      if (
        !sameSyncScope(scope, latestScope) ||
        endpoint.hostEnrollmentId !== this.bindings.identity().hostEnrollmentId ||
        endpoint.machineId !== this.bindings.identity().machineId ||
        endpoint.endpointGeneration !== this.bindings.identity().endpointGeneration
      ) throw new MeshHostAdmissionError('authorization-unavailable');
      const sealed = sealToRecipientPub(
        challenge.clientPublicKey,
        token,
        meshMachineSessionTokenAssociatedData(sessionClaims),
      );
      const responseWithoutHostProof: Omit<MeshMachineBootstrapResponse, 'hostProof'> = {
        v: 1,
        sessionId,
        sessionToken: { enc: 'x25519-aes-256-gcm', ...sealed },
        sessionClaims,
        machineId: endpoint.machineId,
        endpointGeneration: endpoint.endpointGeneration,
        sessionExpiresAt,
        authorizationValidUntil,
        stream: {
          epoch: this.epoch,
          nextSequence: this.nextEventSequence,
          oldestSequence: this.events[0]?.sequence ?? this.nextEventSequence,
        },
      };
      let hostProof: string | null = null;
      if (admissionHostProofKey !== null) {
        hostProof = createHmac('sha256', admissionHostProofKey)
          .update(meshMachineBootstrapHostProofMessage({
            challengeId: challenge.challengeId,
            nonce: challenge.nonce,
            response: responseWithoutHostProof,
          }), 'utf8')
          .digest('base64url');
      } else if (principal.kind === 'dashboard') {
        hostProof = this.bindings.createDashboardHostProof?.(
          scope,
          challenge.claims as MeshMachineBootstrapClaims,
          challenge.challengeId,
          challenge.nonce,
          responseWithoutHostProof,
        ) ?? null;
      }
      if (hostProof === null) throw new MeshHostAdmissionError('authorization-unavailable');

      this.sessions.set(sessionId, {
        sessionId,
        sessionToken: token,
        accountId,
        backendId: scope.backendId,
        datasetEpoch: scope.datasetEpoch,
        machineId: endpoint.machineId,
        endpointGeneration: endpoint.endpointGeneration,
        principal,
        ...(admissionClaims === undefined ? {} : { admissionClaims }),
        scope: cloneScope(sessionScope),
        issuedAt: new Date(now).toISOString(),
        expiresAt: sessionExpiresAt,
        expiresAtMonotonic: nowMonotonic + Date.parse(sessionExpiresAt) - now,
        authorizationValidUntil,
        authorizationDeadlineMonotonic: nowMonotonic + Date.parse(authorizationValidUntil) - now,
        lastRefreshAtMonotonic: nowMonotonic,
        nextClientSequence: 1,
        nextServerSequence: 1,
        lastAcknowledged: null,
        subscribedWorkspaceIds: new Set(),
        receipts: new Map(),
        revoked: false,
      });
      stored = true;
      return { ...responseWithoutHostProof, hostProof };
    } finally {
      admissionHostProofKey?.fill(0);
      if (!stored) sessionToken?.fill(0);
    }
  }

  createSocketChallenge(): { nonce: string; epoch: string } {
    return { nonce: randomBytes(32).toString('base64url'), epoch: this.epoch };
  }

  authenticateSocket(sessionId: string, nonce: string, proof: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session === undefined || !this.isSessionUnexpired(session)) return false;
    const expected = createHmac('sha256', session.sessionToken)
      .update(
        meshMachineSocketProofMessage({
          sessionId,
          nonce,
          machineId: this.bindings.identity().machineId,
          endpointGeneration: this.bindings.identity().endpointGeneration,
        }),
        'utf8',
      )
      .digest();
    const actual = strictBase64Url(proof, 32);
    const valid = actual !== null && timingSafeEqual(expected, actual);
    actual?.fill(0);
    return valid;
  }

  decryptClientFrame(frame: MeshMachineClientFrame): {
    sessionId: string;
    requestId: string;
    sequence: number;
    payload: MeshMachineClientPayload;
  } {
    if (frame.type !== 'data') throw new Error('invalid-client-frame');
    const session = this.sessions.get(frame.sessionId);
    if (!session || !this.isSessionUnexpired(session)) throw new Error('session-expired');
    if (
      !isSafeRequestId(frame.requestId) ||
      !Number.isSafeInteger(frame.sequence) ||
      frame.sequence !== session.nextClientSequence
    ) {
      throw new Error('sequence-invalid');
    }
    const plaintext = openFrame({
      key: trafficKey(session.sessionToken, session, 'client-to-host'),
      machineId: this.bindings.identity().machineId,
      endpointGeneration: this.bindings.identity().endpointGeneration,
      epoch: this.epoch,
      frame,
    });
    if (Buffer.byteLength(JSON.stringify(plaintext), 'utf8') > MAX_FRAME_BYTES) {
      throw new Error('frame-too-large');
    }
    if (!isClientPayload(plaintext) || plaintext.requestId !== frame.requestId) {
      throw new Error('frame-invalid');
    }
    session.nextClientSequence += 1;
    return {
      sessionId: session.sessionId,
      requestId: frame.requestId,
      sequence: frame.sequence,
      payload: plaintext,
    };
  }

  async processClientPayload(
    sessionId: string,
    payload: MeshMachineClientPayload,
  ): Promise<MeshMachineServerPayload[]> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.isSessionUnexpired(session)) {
      return [{ kind: 'session.revoked', reason: 'expired' }];
    }
    if (payload.kind === 'ping') return [{ kind: 'response', requestId: payload.requestId, result: { ok: true } }];
    if (payload.kind === 'refresh') {
      if (performance.now() - session.lastRefreshAtMonotonic < REFRESH_INTERVAL_MS - 5_000) {
        return [{ kind: 'error', requestId: payload.requestId, code: 'refresh-too-soon', message: 'Refresh interval has not elapsed.' }];
      }
      const validUntil = await this.refreshSession(session);
      if (validUntil === null) {
        return [{ kind: 'session.revoked', reason: 'device-revoked' }];
      }
      return [{ kind: 'refreshed', requestId: payload.requestId, authorizationValidUntil: validUntil }];
    }
    if (!this.isSessionFresh(session)) {
      return [{ kind: 'session.revoked', reason: 'expired' }];
    }
    if (payload.kind === 'ack') {
      if (
        payload.cursor.epoch !== this.epoch ||
        !Number.isSafeInteger(payload.cursor.sequence) ||
        payload.cursor.sequence >= this.nextEventSequence ||
        (session.lastAcknowledged !== null &&
          payload.cursor.sequence < session.lastAcknowledged.sequence)
      ) {
        return [{ kind: 'error', requestId: payload.requestId, code: 'cursor-invalid', message: 'Acknowledgement cursor is invalid.' }];
      }
      session.lastAcknowledged = { ...payload.cursor };
      return [{ kind: 'response', requestId: payload.requestId, result: { acknowledged: payload.cursor } }];
    }
    if (payload.kind === 'subscribe') return this.subscribe(session, payload);
    if (!this.isAuthorizedForOperation(session, payload.operation)) {
      return [{ kind: 'error', requestId: payload.requestId, code: 'operation-forbidden', message: 'Operation is outside this session scope.' }];
    }

    const digest = createHmac('sha256', session.sessionToken)
      .update(JSON.stringify({ operation: payload.operation, payload: payload.payload }), 'utf8')
      .digest('hex');
    const prior = session.receipts.get(payload.requestId);
    if (prior !== undefined) {
      if (prior.digest !== digest) {
        return [{ kind: 'error', requestId: payload.requestId, code: 'request-id-conflict', message: 'Request id was already used with a different operation.' }];
      }
      const result = prior.pending === undefined ? prior.result : await prior.pending;
      return [{ kind: 'response', requestId: payload.requestId, result }];
    }
    if (session.receipts.size >= MAX_REQUEST_RECEIPTS) {
      return [{ kind: 'error', requestId: payload.requestId, code: 'receipt-capacity', message: 'Session request receipt capacity is full.' }];
    }
    if (this.bindings.dispatchOperation === undefined) {
      return [{ kind: 'error', requestId: payload.requestId, code: 'operation-unavailable', message: 'Operation is unavailable on this host.' }];
    }
    const pending = this.bindings.dispatchOperation({
        sessionId: session.sessionId,
        principal: session.principal,
        scope: cloneScope(session.scope),
        operation: payload.operation,
        requestId: payload.requestId,
        payload: payload.payload,
      }).catch(() => ({ state: 'failed', error: 'Operation failed on the host.' }));
    const receipt: RequestReceipt = { digest, pending, createdAt: Date.now() };
    session.receipts.set(payload.requestId, receipt);
    const result = await pending;
    if (!this.isSessionFresh(session)) {
      return [{ kind: 'session.revoked', reason: 'expired' }];
    }
    receipt.result = result;
    delete receipt.pending;
    return [{ kind: 'response', requestId: payload.requestId, result }];
  }

  encryptServerPayload(sessionId: string, payload: MeshMachineServerPayload): MeshMachineServerFrame {
    const session = this.sessions.get(sessionId);
    if (!session || !this.isSessionUnexpired(session)) throw new Error('session-expired');
    const sequence = session.nextServerSequence++;
    const requestId = 'requestId' in payload ? payload.requestId : undefined;
    const envelope = sealFrame({
      key: trafficKey(session.sessionToken, session, 'host-to-client'),
      machineId: this.bindings.identity().machineId,
      endpointGeneration: this.bindings.identity().endpointGeneration,
      epoch: this.epoch,
      sessionId,
      requestId,
      sequence,
      payload,
    });
    return {
      type: 'data',
      sessionId,
      ...(requestId === undefined ? {} : { requestId }),
      sequence,
      envelope,
    };
  }

  readyPayload(sessionId: string): MeshMachineServerPayload {
    const session = this.sessions.get(sessionId);
    if (!session || !this.isSessionUnexpired(session)) throw new Error('session-expired');
    return {
      kind: 'ready',
      sessionId,
      epoch: this.epoch,
      nextClientSequence: session.nextClientSequence,
      nextSequence: this.nextEventSequence,
      oldestSequence: this.events[0]?.sequence ?? this.nextEventSequence,
      authorizationValidUntil: session.authorizationValidUntil,
    };
  }

  publishEvent(input: MeshMachineStreamEventInput, sourceScope?: SyncScope): StreamEvent | null {
    const activeScope = this.bindings.activeScope();
    if (
      activeScope === null ||
      (sourceScope !== undefined &&
        (activeScope.backendId !== sourceScope.backendId ||
          activeScope.accountId !== sourceScope.accountId ||
          activeScope.datasetEpoch !== sourceScope.datasetEpoch))
    ) return null;
    this.ensureScope(activeScope);
    const json = JSON.stringify(input);
    const byteLength = Buffer.byteLength(json, 'utf8');
    if (byteLength > MAX_FRAME_BYTES) throw new Error('mesh event exceeds the frame limit');
    const event: StreamEvent = {
      ...input,
      epoch: this.epoch,
      sequence: this.nextEventSequence++,
      byteLength,
    };
    this.events.push(event);
    this.eventBytes += byteLength;
    while (this.events.length > MAX_STREAM_EVENTS || this.eventBytes > MAX_STREAM_BYTES) {
      const removed = this.events.shift();
      if (removed !== undefined) this.eventBytes -= removed.byteLength;
    }
    for (const listener of this.eventListeners) listener(event);
    return event;
  }

  onEvent(listener: (event: StreamEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  isSessionActive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session !== undefined && this.isSessionUnexpired(session);
  }

  challengeOrigin(challengeId: string): string | null {
    return this.challenges.get(challengeId)?.approvedOrigin ?? null;
  }

  isSessionSubscribedToWorkspace(sessionId: string, workspaceId: string): boolean {
    const session = this.sessions.get(sessionId);
    return (
      session !== undefined &&
      this.isSessionFresh(session) &&
      (session.subscribedWorkspaceIds.has(workspaceId) ||
        (session.principal.kind === 'enrollment' &&
          session.scope.workspaceIds.length === 0 &&
          session.subscribedWorkspaceIds.size === 0))
    );
  }

  eventsAfter(cursor: MeshMachineCursor | undefined, workspaceIds: readonly string[]): {
    payloads: MeshMachineServerPayload[];
    cursor: MeshMachineCursor;
  } {
    const oldest = this.events[0]?.sequence ?? this.nextEventSequence;
    if (cursor !== undefined && (cursor.epoch !== this.epoch || cursor.sequence < oldest - 1)) {
      return {
        payloads: [
          {
            kind: 'resnapshot-required',
            requestId: randomUUID(),
            epoch: this.epoch,
            nextSequence: this.nextEventSequence,
            reason: cursor.epoch !== this.epoch ? 'epoch-changed' : 'cursor-expired',
          },
        ],
        cursor: { epoch: this.epoch, sequence: this.nextEventSequence - 1 },
      };
    }
    const after = cursor?.sequence ?? this.nextEventSequence - 1;
    const selected = this.events.filter(
      (event) => event.sequence > after && (workspaceIds.length === 0 || workspaceIds.includes(event.workspaceId)),
    );
    return {
      payloads: selected.map(({ byteLength: _byteLength, ...event }) => ({ kind: 'event', ...event })),
      cursor: { epoch: this.epoch, sequence: this.nextEventSequence - 1 },
    };
  }

  activeSessionCount(): number {
    this.prune();
    return this.sessions.size;
  }

  revoke(predicate: (principal: MeshMachineSessionPrincipal) => boolean): string[] {
    const revoked: string[] = [];
    for (const session of this.sessions.values()) {
      if (predicate(session.principal)) {
        session.revoked = true;
        session.sessionToken.fill(0);
        this.sessions.delete(session.sessionId);
        revoked.push(session.sessionId);
      }
    }
    return revoked;
  }

  getSessionOrigin(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    const scope = this.bindings.activeScope();
    return (
      session?.principal.kind === 'dashboard' &&
      scope !== null &&
      scope.backendId === session.backendId &&
      scope.accountId === session.accountId &&
      scope.datasetEpoch === session.datasetEpoch
    )
      ? this.bindings.getDashboardContext?.(scope, session.principal.grantId)?.origin ?? null
      : null;
  }

  private async subscribe(
    session: SessionRecord,
    payload: Extract<MeshMachineClientPayload, { kind: 'subscribe' }>,
  ): Promise<MeshMachineServerPayload[]> {
    const requestedWorkspaces = payload.workspaceIds ?? session.scope.workspaceIds;
    const unrestrictedEnrollment =
      session.principal.kind === 'enrollment' && session.scope.workspaceIds.length === 0;
    if (
      !Array.isArray(requestedWorkspaces) ||
      (!unrestrictedEnrollment && requestedWorkspaces.some((id) => !session.scope.workspaceIds.includes(id)))
    ) {
      return [{ kind: 'error', requestId: payload.requestId, code: 'scope-forbidden', message: 'Subscription is outside the session scope.' }];
    }
    session.subscribedWorkspaceIds = new Set(requestedWorkspaces);
    const replay = this.eventsAfter(payload.cursor, requestedWorkspaces);
    return [
      { kind: 'response', requestId: payload.requestId, result: { cursor: replay.cursor } },
      ...replay.payloads,
    ];
  }

  private isAuthorizedForOperation(session: SessionRecord, operation: MeshMachineOperation): boolean {
    return (
      this.isSessionFresh(session) &&
      Date.now() < Date.parse(session.authorizationValidUntil) &&
      performance.now() < session.authorizationDeadlineMonotonic &&
      session.scope.operations.includes(operation) &&
      (session.principal.kind !== 'enrollment' || operationsForTier(session.principal.tier).has(operation))
    );
  }

  private async refreshSession(session: SessionRecord): Promise<string | null> {
    if (session.principal.kind === 'dashboard') {
      const scope = this.bindings.activeScope();
      if (scope === null || scope.backendId !== session.backendId || scope.accountId !== session.accountId) {
        return null;
      }
      if (await this.bindings.refreshDashboard?.(scope, session.principal.grantId).catch(() => false) !== true) return null;
      const currentScope = this.bindings.activeScope();
      if (
        currentScope === null ||
        currentScope.backendId !== session.backendId ||
        currentScope.accountId !== session.accountId ||
        currentScope.datasetEpoch !== session.datasetEpoch
      ) return null;
      const dashboard = this.bindings.getDashboardContext?.(scope, session.principal.grantId);
      if (dashboard === null || dashboard === undefined || dashboard.expiresAt <= new Date().toISOString()) {
        return null;
      }
      session.scope = cloneScope(dashboard.sessionScope);
      session.authorizationValidUntil = new Date(
        Math.min(Date.now() + AUTHORIZATION_MAX_AGE_MS, Date.parse(dashboard.expiresAt)),
      ).toISOString();
    } else {
      const scope = this.bindings.activeScope();
      if (
        scope === null ||
        scope.backendId !== session.backendId ||
        scope.accountId !== session.accountId ||
        this.bindings.revalidateAdmission === undefined
      ) {
        return null;
      }
      const admissionClaims = session.admissionClaims;
      if (admissionClaims === undefined) return null;
      const refreshed = await this.bindings.revalidateAdmission(admissionClaims).catch(() => null);
      let authorization: MeshHostAdmissionAuthorization;
      try {
        authorization = this.bindings.authorizeAdmission === undefined
          ? { state: 'unavailable' }
          : await this.bindings.authorizeAdmission(admissionClaims);
      } catch {
        return null;
      }
      const currentScope = this.bindings.activeScope();
      if (currentScope !== null) this.ensureScope(currentScope);
      if (
        currentScope === null ||
        currentScope.backendId !== session.backendId ||
        currentScope.accountId !== session.accountId ||
        currentScope.datasetEpoch !== session.datasetEpoch ||
        refreshed === null ||
        !refreshed.authorized ||
        authorization.state !== 'authorized' ||
        authorization.principal.accountId !== session.accountId ||
        authorization.principal.sourceEnrollmentId !== session.principal.sourceEnrollmentId
      ) return null;
      session.principal = authorization.principal;
      const allowedForTier = operationsForTier(authorization.principal.tier);
      session.scope.operations = session.scope.operations.filter((operation) => allowedForTier.has(operation));
      const validUntil = Date.parse(refreshed.validUntil);
      if (!Number.isFinite(validUntil) || validUntil <= Date.now()) return null;
      session.authorizationValidUntil = new Date(
        Math.min(Date.now() + AUTHORIZATION_MAX_AGE_MS, validUntil, Date.parse(session.expiresAt)),
      ).toISOString();
    }
    session.authorizationDeadlineMonotonic =
      performance.now() + Math.min(AUTHORIZATION_MAX_AGE_MS, Date.parse(session.authorizationValidUntil) - Date.now());
    session.lastRefreshAtMonotonic = performance.now();
    return session.authorizationValidUntil;
  }

  private isSessionUnexpired(session: SessionRecord): boolean {
    const scope = this.bindings.activeScope();
    const identity = this.bindings.identity();
    this.ensureScope(scope);
    if (
      session.revoked ||
      scope === null ||
      scope.backendId !== session.backendId ||
      scope.accountId !== session.accountId ||
      scope.datasetEpoch !== session.datasetEpoch ||
      identity.machineId !== session.machineId ||
      identity.endpointGeneration !== session.endpointGeneration ||
      Date.parse(session.expiresAt) <= Date.now() ||
      performance.now() >= session.expiresAtMonotonic
    ) {
      session.revoked = true;
      session.sessionToken.fill(0);
      this.sessions.delete(session.sessionId);
      return false;
    }
    return true;
  }

  private isSessionFresh(session: SessionRecord): boolean {
    return (
      this.isSessionUnexpired(session) &&
      Date.parse(session.authorizationValidUntil) > Date.now() &&
      performance.now() < session.authorizationDeadlineMonotonic
    );
  }

  private prune(): void {
    for (const [id, challenge] of this.challenges) {
      if (challenge.used || Date.parse(challenge.challenge.expiresAt) <= Date.now()) {
        challenge.proofKey?.fill(0);
        this.challenges.delete(id);
      }
    }
    for (const session of this.sessions.values()) this.isSessionUnexpired(session);
  }

  private ensureScope(scope: SyncScope | null): void {
    const identity = this.bindings.identity();
    const key = scope === null
      ? 'inactive'
      : JSON.stringify({
          backendId: scope.backendId,
          accountId: scope.accountId,
          datasetEpoch: scope.datasetEpoch,
          machineId: identity.machineId,
          hostEnrollmentId: identity.hostEnrollmentId,
          endpointGeneration: identity.endpointGeneration,
        });
    if (this.streamScopeKey === key) return;
    this.resetSessionState();
    this.streamScopeKey = key;
  }

  private resetSessionState(): void {
    for (const challenge of this.challenges.values()) challenge.proofKey?.fill(0);
    for (const session of this.sessions.values()) {
      session.revoked = true;
      session.sessionToken.fill(0);
    }
    this.challenges.clear();
    this.sessions.clear();
    this.events.length = 0;
    this.eventBytes = 0;
    this.nextEventSequence = 1;
    this.epoch = randomUUID();
  }
}

function cloneScope(scope: MeshMachineSessionScope): MeshMachineSessionScope {
  return {
    workspaceIds: [...scope.workspaceIds],
    repositoryIds: [...scope.repositoryIds],
    scopes: [...scope.scopes],
    operations: [...scope.operations],
  };
}

function sameSyncScope(left: SyncScope | null, right: SyncScope | null): boolean {
  return left !== null && right !== null &&
    left.backendId === right.backendId &&
    left.accountId === right.accountId &&
    left.datasetEpoch === right.datasetEpoch;
}

function strictBase64(value: string, expectedLength: number): Buffer | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return (expectedLength < 0 || decoded.byteLength === expectedLength) && decoded.toString('base64') === value
    ? decoded
    : null;
}

function strictBase64Url(value: string, expectedLength: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === expectedLength && decoded.toString('base64url') === value
    ? decoded
    : null;
}

function isCanonicalBase64UrlNonce(value: string): boolean {
  const decoded = strictBase64Url(value, 32);
  decoded?.fill(0);
  return decoded !== null;
}

function isCanonicalIsoDate(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isAllowedAdmissionClaims(claims: MeshMachineAdmissionClaims): boolean {
  const allowedCapabilities = new Set(['machine.session/1', 'machine.stream/1', 'dashboard.command.wake/1']);
  const allowedOperations = new Set<string>(MESH_MACHINE_OPERATIONS);
  if (claims.principal.kind === 'dashboard') {
    return (
      claims.principal.grantId.length > 0 &&
      claims.principal.grantId.length <= 128 &&
      isCanonicalOrigin(claims.principal.origin)
    );
  }
  return (
    claims.principal.sourceEnrollmentId.length > 0 &&
    claims.principal.sourceEnrollmentId.length <= 128 &&
    Array.isArray(claims.principal.requestedCapabilities) &&
    claims.principal.requestedCapabilities.length > 0 &&
    claims.principal.requestedCapabilities.every((capability) => allowedCapabilities.has(capability)) &&
    Array.isArray(claims.principal.operations) &&
    claims.principal.operations.length <= 64 &&
    claims.principal.operations.every((operation) => allowedOperations.has(operation)) &&
    Array.isArray(claims.principal.scopes) &&
    claims.principal.scopes.length <= 64 &&
    claims.principal.scopes.every((scope) => typeof scope === 'string' && scope.length > 0 && scope.length <= 128)
  );
}

function isCanonicalOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.origin === value &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

function operationsForTier(tier: 'observe' | 'approve' | 'steer'): Set<MeshMachineOperation> {
  const operations = new Set<MeshMachineOperation>([
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
  ]);
  if (tier === 'approve' || tier === 'steer') {
    operations.add('command.approve');
    operations.add('command.carplay-approval');
  }
  if (tier === 'steer') {
    operations.add('command.submit');
    operations.add('command.cancel');
    operations.add('command.steer');
    operations.add('command.prepare-attachments');
    operations.add('command.open-desktop');
    operations.add('command.attachment.begin');
    operations.add('command.attachment.chunk');
    operations.add('command.attachment.finish');
    operations.add('command.carplay-pause');
    operations.add('command.carplay-pause-all');
    operations.add('command.carplay-note');
    operations.add('command.carplay-handover');
    operations.add('dashboard.command.wake');
  }
  return operations;
}

function isSafeRequestId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function isClientPayload(value: unknown): value is MeshMachineClientPayload {
  if (!isRecord(value) || typeof value['kind'] !== 'string' || !isSafeRequestId(String(value['requestId'] ?? ''))) {
    return false;
  }
  if (value['kind'] === 'request') {
    return typeof value['operation'] === 'string' && Object.hasOwn(value, 'payload');
  }
  if (value['kind'] === 'subscribe') {
    return value['cursor'] === undefined || isCursor(value['cursor']);
  }
  if (value['kind'] === 'ack') return isCursor(value['cursor']);
  return ['refresh', 'ping'].includes(value['kind']);
}

function isCursor(value: unknown): value is MeshMachineCursor {
  return (
    isRecord(value) &&
    typeof value['epoch'] === 'string' &&
    Number.isSafeInteger(value['sequence']) &&
    (value['sequence'] as number) >= 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trafficKey(
  sessionToken: Buffer,
  session: SessionRecord,
  direction: 'client-to-host' | 'host-to-client',
): Buffer {
  const derivation = meshMachineTrafficKeyDerivation({
    sessionId: session.sessionId,
    machineId: session.machineId,
    endpointGeneration: session.endpointGeneration,
    direction,
  });
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

function openFrame(input: {
  key: Buffer;
  machineId: string;
  endpointGeneration: string;
  epoch: string;
  frame: Extract<MeshMachineClientFrame, { type: 'data' }>;
}): unknown {
  const { frame } = input;
  if (frame.envelope.enc !== 'aes-256-gcm') throw new Error('frame-encryption-invalid');
  const nonce = strictBase64(frame.envelope.nonce, 12);
  const ciphertextAndTag = strictBase64(frame.envelope.ct, -1);
  if (nonce === null || ciphertextAndTag === null || ciphertextAndTag.byteLength < 16) {
    input.key.fill(0);
    throw new Error('frame-encoding-invalid');
  }
  const decipher = createDecipheriv('aes-256-gcm', input.key, nonce);
  try {
    decipher.setAAD(Buffer.from(meshMachineFrameAssociatedData({
      sessionId: frame.sessionId,
      machineId: input.machineId,
      endpointGeneration: input.endpointGeneration,
      epoch: input.epoch,
      direction: 'client-to-host',
      requestId: frame.requestId,
      sequence: frame.sequence,
    }), 'utf8'));
    decipher.setAuthTag(ciphertextAndTag.subarray(ciphertextAndTag.byteLength - 16));
    const plaintext = Buffer.concat([
      decipher.update(ciphertextAndTag.subarray(0, ciphertextAndTag.byteLength - 16)),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext) as unknown;
  } finally {
    input.key.fill(0);
    nonce.fill(0);
    ciphertextAndTag.fill(0);
  }
}

function sealFrame(input: {
  key: Buffer;
  machineId: string;
  endpointGeneration: string;
  epoch: string;
  sessionId: string;
  requestId?: string;
  sequence: number;
  payload: unknown;
}): MeshMachineEncryptedEnvelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', input.key, nonce);
  cipher.setAAD(Buffer.from(meshMachineFrameAssociatedData({
    sessionId: input.sessionId,
    machineId: input.machineId,
    endpointGeneration: input.endpointGeneration,
    epoch: input.epoch,
    direction: 'host-to-client',
    requestId: input.requestId,
    sequence: input.sequence,
  }), 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(input.payload), 'utf8')),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const encodedNonce = nonce.toString('base64');
  input.key.fill(0);
  nonce.fill(0);
  return { enc: 'aes-256-gcm', nonce: encodedNonce, ct: ciphertext.toString('base64') };
}
