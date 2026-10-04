/** Host-local Mesh execution and direct-session wire contract. */

import {
  BROWSER_WORKSPACE_OPERATIONS,
  type BrowserWorkspaceOperation,
} from './browser-workspace';

export const MESH_MACHINE_PROTOCOL_VERSION = 1 as const;
export const MESH_MACHINE_ENDPOINT_FLAG = 'ANVIL_MESH_MACHINE_ENDPOINTS';
export const MESH_MACHINE_SOCKET_SUBPROTOCOL = 'anvil.machine.v1' as const;

export const MESH_MACHINE_CAPABILITIES = [
  'machine.session/1',
  'machine.stream/1',
  'dashboard.command.wake/1',
] as const;
export type MeshMachineCapability = (typeof MESH_MACHINE_CAPABILITIES)[number];

export const MESH_MACHINE_OPERATIONS = [
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
  'dashboard.command.wake',
  ...BROWSER_WORKSPACE_OPERATIONS,
] as const;
export type MeshMachineOperation = (typeof MESH_MACHINE_OPERATIONS)[number] | BrowserWorkspaceOperation;

export const MESH_MACHINE_ROUTE_PATHS = {
  info: '/api/machine/v1/info',
  challenge: '/api/machine/v1/sessions/challenge',
  bootstrap: '/api/machine/v1/sessions/bootstrap',
  socket: '/api/machine/v1/sessions/socket',
} as const;

export const MESH_MACHINE_SESSION_REFRESH_INTERVAL_MS = 30_000;
export const MESH_MACHINE_SESSION_AUTHORIZATION_MAX_AGE_MS = 60_000;
export const MESH_MACHINE_SESSION_TTL_MS = 60 * 60 * 1000;
export const MESH_MACHINE_MAX_FRAME_BYTES = 512 * 1024;
export const MESH_MACHINE_REPLAY_MAX_EVENTS = 512;
export const MESH_MACHINE_REPLAY_MAX_BYTES = 2 * 1024 * 1024;

/** Route advertised by the broker. Allocation generation is independent of host identity. */
export interface MeshMachineRoute {
  kind: 'private' | 'https' | 'managed';
  url: string;
  machineId: string;
  endpointGeneration: string;
  reachableUntil: string;
  allocationGeneration?: string;
}

export type MeshMachineAllocationState =
  | 'disabled'
  | 'unallocated'
  | 'allocating'
  | 'ready'
  | 'retiring'
  | 'failed';

/** Account-scoped discovery row. It contains route metadata but never connector credentials. */
export interface MeshMachineHost {
  enrollmentId: string;
  machineId: string;
  endpointGeneration: string;
  protocolVersion: typeof MESH_MACHINE_PROTOCOL_VERSION;
  capabilities: MeshMachineCapability[];
  operations: MeshMachineOperation[];
  online: boolean;
  lastSeenAt: string;
  reachableUntil: string;
  routes: MeshMachineRoute[];
  allocationState: MeshMachineAllocationState;
}

export interface MeshMachineHostsResponse {
  v: typeof MESH_MACHINE_PROTOCOL_VERSION;
  hosts: MeshMachineHost[];
}

export interface MeshMachineTransportLimits {
  socketPath: typeof MESH_MACHINE_ROUTE_PATHS.socket;
  maxFrameBytes: typeof MESH_MACHINE_MAX_FRAME_BYTES;
  replayEvents: typeof MESH_MACHINE_REPLAY_MAX_EVENTS;
  replayBytes: typeof MESH_MACHINE_REPLAY_MAX_BYTES;
  sessionRefreshIntervalMs: typeof MESH_MACHINE_SESSION_REFRESH_INTERVAL_MS;
  sessionAuthorizationMaxAgeMs: typeof MESH_MACHINE_SESSION_AUTHORIZATION_MAX_AGE_MS;
}

export interface MeshMachineEndpointInfo {
  hostEnrollmentId: string;
  machineId: string;
  endpointGeneration: string;
  protocolVersion: typeof MESH_MACHINE_PROTOCOL_VERSION;
  capabilities: MeshMachineCapability[];
  operations: MeshMachineOperation[];
  transport: MeshMachineTransportLimits;
}

/** Renderer-safe local listener state. Secret connector credentials are never represented here. */
export interface MeshMachineHostStatus {
  enabled: boolean;
  running: boolean;
  state: 'disabled' | 'offline' | 'starting' | 'listening' | 'bind-error';
  lastErrorCode?: 'listener-bind-failed';
  machineId: string;
  endpointGeneration: string | null;
  protocolVersion: typeof MESH_MACHINE_PROTOCOL_VERSION;
  capabilities: MeshMachineCapability[];
  activeSessions: number;
  managedOrigin: string | null;
}

/** Host identity metadata included in the host's own `device.advertise` call. */
export interface MeshMachineAdvertisedEndpoint {
  hostEnrollmentId: string;
  machineId: string;
  endpointGeneration: string;
  protocolVersion: typeof MESH_MACHINE_PROTOCOL_VERSION;
  capabilities: MeshMachineCapability[];
  operations: MeshMachineOperation[];
}

export type MeshMachineSessionPrincipal =
  | {
      kind: 'enrollment';
      accountId: string;
      sourceEnrollmentId: string;
      tier: 'observe' | 'approve' | 'steer';
    }
  | {
      kind: 'dashboard';
      accountId: string;
      sourceBrowserId: string;
      grantId: string;
      trustId?: string;
    };

export interface MeshMachineSessionScope {
  workspaceIds: string[];
  repositoryIds: string[];
  scopes: string[];
  operations: MeshMachineOperation[];
}

export interface MeshMachineChallengeRequest {
  v: 1;
  mode: 'dashboard' | 'admission';
  clientPublicKey: string;
  /** Dashboard DSK grant. Required only when mode is dashboard. */
  grantId?: string;
  /** One-time broker-issued admission ticket. Required only when mode is admission. */
  ticket?: string;
}

export interface MeshMachineBootstrapClaims {
  v: 1;
  bootstrapId: string;
  challenge: string;
  accountId: string;
  sourceEnrollmentId: string | null;
  machineId: string;
  endpointGeneration: string;
  clientPublicKey: string;
  capabilities: MeshMachineCapability[];
  principal: MeshMachineSessionPrincipal;
  scope: MeshMachineSessionScope;
  issuedAt: string;
  expiresAt: string;
}

export type MeshMachineChallengeResponse = MeshMachineBootstrapChallenge;

export interface MeshMachineBootstrapRequest {
  v: 1;
  challengeId: string;
  proof: string;
}

/** Broker ticket claims: the source account bearer never reaches the host. */
interface MeshMachineAdmissionClaimsBase {
  v: 1;
  accountId: string;
  hostEnrollmentId: string;
  hostMachineId: string;
  endpointGeneration: string;
  clientPublicKey: string;
  bootstrapChallenge: string;
  issuedAt: string;
  expiresAt: string;
}

/** A ticket's trust principal is explicit; dashboard tickets grant no operations. */
export type MeshMachineAdmissionClaims =
  | MeshMachineEnrollmentAdmissionClaims
  | MeshMachineDashboardAdmissionClaims;

export type MeshMachineEnrollmentAdmissionClaims = MeshMachineAdmissionClaimsBase & {
  principal: {
    kind: 'enrollment';
    sourceEnrollmentId: string;
    requestedCapabilities: MeshMachineCapability[];
    operations: MeshMachineOperation[];
    scopes: string[];
  };
};

export type MeshMachineDashboardAdmissionClaims = MeshMachineAdmissionClaimsBase & {
  principal: { kind: 'dashboard'; grantId: string; origin: string };
};

export function isMeshMachineEnrollmentAdmissionClaims(
  claims: MeshMachineAdmissionClaims,
): claims is MeshMachineEnrollmentAdmissionClaims {
  return claims.principal.kind === 'enrollment';
}

export type MeshMachineAdmissionIssueRequest =
  | {
      kind: 'enrollment';
      endpointGeneration: string;
      clientPublicKey: string;
      requestedCapabilities: MeshMachineCapability[];
      operations: MeshMachineOperation[];
      scopes: string[];
      bootstrapChallenge: string;
      requestId: string;
    }
  | {
      kind: 'dashboard';
      endpointGeneration: string;
      clientPublicKey: string;
      grantId: string;
      origin: string;
      bootstrapChallenge: string;
      requestId: string;
    };

export interface MeshMachineAdmissionIssueResponse {
  v: 1;
  ticket: string;
  claims: MeshMachineAdmissionClaims;
  /** Enrollment proof key; dashboard tickets rely on the locally held DSK instead. */
  sealedProofKey?: MeshMachineSealedValue;
}

export interface MeshMachineAdmissionConsumeResponse {
  v: 1;
  claims: MeshMachineAdmissionClaims;
  proofKey?: string;
}

export interface MeshMachineBootstrapChallenge {
  v: 1;
  mode: 'dashboard' | 'admission';
  challengeId: string;
  nonce: string;
  epoch: string;
  machineId: string;
  endpointGeneration: string;
  clientPublicKey: string;
  expiresAt: string;
  /** Dashboard claims contain locally checked grant scope; admission claims are broker-issued. */
  claims: MeshMachineBootstrapClaims | MeshMachineAdmissionClaims;
}

export interface MeshMachineSealedValue {
  enc: 'x25519-aes-256-gcm';
  ephPub: string;
  nonce: string;
  ct: string;
}

export interface MeshMachineEncryptedEnvelope {
  enc: 'aes-256-gcm';
  nonce: string;
  ct: string;
}

export interface MeshMachineBootstrapResponse {
  v: 1;
  sessionId: string;
  /** Session token is sealed to the one-use client X25519 key and held in client memory. */
  sessionToken: MeshMachineSealedValue;
  /** Exact fields used to construct session-token AAD. */
  sessionClaims: {
    accountId: string;
    principal: MeshMachineSessionPrincipal;
    machineId: string;
    endpointGeneration: string;
    sessionId: string;
  };
  machineId: string;
  endpointGeneration: string;
  sessionExpiresAt: string;
  authorizationValidUntil: string;
  /** Host possession proof under the admitted proof key or approved dashboard DSK. */
  hostProof: string;
  stream: { epoch: string; nextSequence: number; oldestSequence: number };
}

/** Canonical host HMAC transcript. `response` is the complete bootstrap response except hostProof. */
export function meshMachineBootstrapHostProofMessage(input: {
  challengeId: string;
  nonce: string;
  response: Omit<MeshMachineBootstrapResponse, 'hostProof'>;
}): string {
  return canonicalJson({
    v: 1,
    purpose: 'anvil/mesh-machine-bootstrap-host-proof/1',
    challengeId: input.challengeId,
    nonce: input.nonce,
    response: input.response,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function meshMachineSessionTokenAssociatedData(input: {
  accountId: string;
  principal: MeshMachineSessionPrincipal;
  machineId: string;
  endpointGeneration: string;
  sessionId: string;
}): string {
  return JSON.stringify({
    v: 1,
    purpose: 'anvil/mesh-machine-session-token/1',
    accountId: input.accountId,
    principal: input.principal,
    machineId: input.machineId,
    endpointGeneration: input.endpointGeneration,
    sessionId: input.sessionId,
  });
}

/** Canonical ticket claims JSON shared by broker, host and client proof code. */
export function meshMachineAdmissionClaimsCanonicalJson(
  claims: MeshMachineAdmissionClaims,
): string {
  const common = {
    v: claims.v,
    accountId: claims.accountId,
    hostEnrollmentId: claims.hostEnrollmentId,
    hostMachineId: claims.hostMachineId,
    endpointGeneration: claims.endpointGeneration,
    clientPublicKey: claims.clientPublicKey,
    bootstrapChallenge: claims.bootstrapChallenge,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  };
  return claims.principal.kind === 'enrollment'
    ? JSON.stringify({
        ...common,
        principal: {
          kind: 'enrollment',
          sourceEnrollmentId: claims.principal.sourceEnrollmentId,
          requestedCapabilities: [...claims.principal.requestedCapabilities].sort(),
          operations: [...claims.principal.operations].sort(),
          scopes: [...claims.principal.scopes].sort(),
        },
      })
    : JSON.stringify({
        ...common,
        principal: {
          kind: 'dashboard',
          grantId: claims.principal.grantId,
          origin: claims.principal.origin,
        },
      });
}

/** AAD for the broker's proof key sealed to the requesting client's X25519 key. */
export function meshMachineAdmissionProofKeyAssociatedData(
  claims: MeshMachineAdmissionClaims,
): string {
  return JSON.stringify({
    v: 1,
    purpose: 'anvil/mesh-machine-admission-proof-key/1',
    claims: JSON.parse(meshMachineAdmissionClaimsCanonicalJson(claims)) as object,
  });
}

/** HMAC transcript for a one-use broker ticket after the host adds its challenge id. */
export function meshMachineAdmissionBootstrapProofMessage(input: {
  claims: MeshMachineAdmissionClaims;
  challengeId: string;
  nonce: string;
}): string {
  return JSON.stringify({
    v: 1,
    purpose: 'anvil/mesh-machine-admission-bootstrap/1',
    claims: JSON.parse(meshMachineAdmissionClaimsCanonicalJson(input.claims)) as object,
    challengeId: input.challengeId,
    nonce: input.nonce,
  });
}

/** Exact HKDF salt/info bytes for the two directional socket traffic keys. */
export function meshMachineTrafficKeyDerivation(input: {
  sessionId: string;
  machineId: string;
  endpointGeneration: string;
  direction: 'client-to-host' | 'host-to-client';
}): { salt: string; info: string } {
  return {
    salt: `${input.sessionId}\0${input.machineId}\0${input.endpointGeneration}`,
    info: `anvil/mesh-machine-traffic/1/${input.direction}`,
  };
}

/** HMAC input is stable JSON with keys in this order; callers must not sign only a subset. */
export function meshMachineBootstrapProofMessage(claims: MeshMachineBootstrapClaims): string {
  return JSON.stringify({
    v: claims.v,
    purpose: 'anvil/mesh-machine-bootstrap/1',
    bootstrapId: claims.bootstrapId,
    challenge: claims.challenge,
    accountId: claims.accountId,
    sourceEnrollmentId: claims.sourceEnrollmentId,
    machineId: claims.machineId,
    endpointGeneration: claims.endpointGeneration,
    clientPublicKey: claims.clientPublicKey,
    capabilities: [...claims.capabilities].sort(),
    principal:
      claims.principal.kind === 'enrollment'
        ? {
            kind: 'enrollment',
            accountId: claims.principal.accountId,
            sourceEnrollmentId: claims.principal.sourceEnrollmentId,
            tier: claims.principal.tier,
          }
        : {
            kind: 'dashboard',
            accountId: claims.principal.accountId,
            sourceBrowserId: claims.principal.sourceBrowserId,
            grantId: claims.principal.grantId,
            trustId: claims.principal.trustId ?? null,
          },
    scope: {
      workspaceIds: [...claims.scope.workspaceIds].sort(),
      repositoryIds: [...claims.scope.repositoryIds].sort(),
      scopes: [...claims.scope.scopes].sort(),
      operations: [...claims.scope.operations].sort(),
    },
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  });
}

export interface MeshMachineCursor {
  epoch: string;
  sequence: number;
}

export type MeshMachineClientPayload =
  | {
      kind: 'request';
      requestId: string;
      operation: MeshMachineOperation;
      payload: unknown;
    }
  | {
      kind: 'subscribe';
      requestId: string;
      cursor?: MeshMachineCursor;
      workspaceIds?: string[];
    }
  | { kind: 'ack'; requestId: string; cursor: MeshMachineCursor }
  | { kind: 'refresh'; requestId: string }
  | { kind: 'ping'; requestId: string };

export type MeshMachineClientFrame =
  | { type: 'auth'; sessionId: string; proof: string }
  | {
      type: 'data';
      sessionId: string;
      requestId: string;
      sequence: number;
      envelope: MeshMachineEncryptedEnvelope;
    };

export type MeshMachineServerPayload =
  | {
      kind: 'ready';
      sessionId: string;
      epoch: string;
      nextClientSequence: number;
      nextSequence: number;
      oldestSequence: number;
      authorizationValidUntil: string;
    }
  | { kind: 'response'; requestId: string; result: unknown }
  | { kind: 'refreshed'; requestId: string; authorizationValidUntil: string }
  | {
      kind: 'event';
      epoch: string;
      sequence: number;
      workspaceId: string;
      jobId?: string;
      eventKind: string;
      payload: unknown;
    }
  | {
      kind: 'resnapshot-required';
      requestId: string;
      epoch: string;
      nextSequence: number;
      reason: 'epoch-changed' | 'cursor-expired';
    }
  | { kind: 'session.revoked'; reason: 'grant-revoked' | 'device-revoked' | 'expired' }
  | { kind: 'error'; requestId?: string; code: string; message: string };

export type MeshMachineServerFrame =
  | { type: 'auth-challenge'; nonce: string; epoch: string }
  | {
      type: 'data';
      sessionId: string;
      requestId?: string;
      sequence: number;
      envelope: MeshMachineEncryptedEnvelope;
    };

export function meshMachineSocketProofMessage(input: {
  sessionId: string;
  nonce: string;
  machineId: string;
  endpointGeneration: string;
}): string {
  return JSON.stringify({
    v: 1,
    purpose: 'anvil/mesh-machine-socket/1',
    sessionId: input.sessionId,
    nonce: input.nonce,
    machineId: input.machineId,
    endpointGeneration: input.endpointGeneration,
  });
}

export function meshMachineFrameAssociatedData(input: {
  sessionId: string;
  machineId: string;
  endpointGeneration: string;
  epoch: string;
  direction: 'client-to-host' | 'host-to-client';
  requestId?: string;
  sequence: number;
}): string {
  return JSON.stringify({
    v: 1,
    purpose: 'anvil/mesh-machine-frame/1',
    sessionId: input.sessionId,
    machineId: input.machineId,
    endpointGeneration: input.endpointGeneration,
    epoch: input.epoch,
    direction: input.direction,
    requestId: input.requestId ?? null,
    sequence: input.sequence,
  });
}
