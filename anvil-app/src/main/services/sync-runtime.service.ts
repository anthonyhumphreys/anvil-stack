import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolveBackendPaths } from '../../../cloud/contract/discovery.js';
import type {
  DeviceSession,
  EnrollmentCodeIssueResult,
  EnrollParams,
  EnrollResult,
  SessionRefreshParams,
  SessionRefreshResult,
  SessionRevokeParams,
  SessionRevokeResult,
} from '../../../cloud/contract/auth.js';
import {
  SPIKE_DATASET_EPOCH,
  type SyncAdoptionPreviewItem,
  type SyncAuthPublicSnapshot,
  type SyncConflictResolutionChoice,
  type SyncConflictView,
  type SyncRuntimeStatus,
  type SyncSpikeEnrollInput,
} from '../../shared/sync-runtime.js';
import { SYNC_ENTITY_WORKFLOW_TEMPLATE, type SyncScope } from '../../shared/sync-mesh.js';
import {
  createSyncAuthService,
  type ListenLoopbackFn,
  type OpenExternalFn,
  type SyncAuthService,
} from './sync-auth.service.js';
import {
  activateBackend,
  disconnectBackend,
  getActiveBackend,
  listBackends,
  resolveBackendIdentityReview,
  type SyncBackendRecord,
} from './sync-backend.service.js';
import {
  BackendRpcError,
  computeReconnectDelayMs,
  openSocket,
  postAuthRoute,
  rpc as backendRpc,
  shouldAllowLoopbackHttp,
  type BackendSocket,
  type WebSocketFactory,
} from './sync-backend-client.service.js';
import {
  getSyncEngineSnapshot,
  resolveSyncConflict,
  runSyncCycle,
  SyncEngineError,
  type SyncEngineRpc,
} from './sync-engine.service.js';
import {
  getOrCreateInstallationId,
  listConflicts,
  listSyncScopesForEntity,
  recordLocalChange,
  upsertBinding,
  upsertEnrollment,
} from './sync-persistence.service.js';
import { listWorkflowTemplates } from './workflow.service.js';
import { getDb } from '../db/database.js';

/** Fallback cadence while the live channel is down. */
const POLL_MS = 5_000;
/** Slower safety-net cadence while the live channel is connected. */
const POLL_LIVE_FALLBACK_MS = 60_000;
const SPIKE_ACCESS_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;
/** Refresh this far before the access token's stated expiry. */
const REFRESH_AHEAD_MS = 60_000;
const REFRESH_MIN_DELAY_MS = 5_000;

export type SyncConnectionState = 'offline' | 'connecting' | 'live';

let auth: SyncAuthService | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let lastError: string | null = null;
let sessionExpired = false;
let rpcOverride: SyncEngineRpc | undefined;
/**
 * Live channel state. The socket only accelerates invalidation; the fallback
 * poll and durable cursors recover anything missed, per the socket contract.
 */
let liveSocket: BackendSocket | null = null;
let liveState: SyncConnectionState = 'offline';
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let createSocketOverride: WebSocketFactory | undefined;
/**
 * Development fixture gate. `spikeEnroll` exists only for tests and
 * unpackaged development; index.ts passes `!app.isPackaged`.
 */
let devSpikeEnabled = false;
/** Test hook: routes ALL backend HTTP (enroll/refresh/revoke/issue + engine rpc). */
let fetchOverride: typeof fetch | undefined;
/**
 * Fences async engine work: bumped on every sign-out, enrollment change, and
 * backend switch. A sync cycle captures the generation (plus its scope and
 * token) and checks both before any durable write that follows an await, so a
 * callback from an old account/backend can never mutate new-scope state.
 */
let runtimeGeneration = 0;

export interface SyncRuntimeInitOptions {
  /** Enables the spike enrollment fixture. Pass `!app.isPackaged`. */
  devSpikeEnabled?: boolean;
  /** Test seam: replaces global fetch for every backend HTTP call. */
  fetchFn?: typeof fetch;
  /** Test seams for the OIDC browser/loopback boundary. */
  openExternal?: OpenExternalFn;
  listenLoopback?: ListenLoopbackFn;
  /** Test seam: replaces the `ws`-backed socket factory for the live channel. */
  createSocket?: WebSocketFactory;
}

export function initSyncRuntime(userDataDir: string, options: SyncRuntimeInitOptions = {}): void {
  auth = createSyncAuthService({
    userDataDir,
    installationId: getOrCreateInstallationId(),
    ...(options.openExternal === undefined ? {} : { openExternal: options.openExternal }),
    ...(options.listenLoopback === undefined ? {} : { listenLoopback: options.listenLoopback }),
  });
  devSpikeEnabled = options.devSpikeEnabled === true;
  fetchOverride = options.fetchFn;
  createSocketOverride = options.createSocket;
  if (auth.getPublicSnapshot().state === 'signed-in') {
    scheduleSessionRefresh();
  }
  if (isSyncEnabled()) {
    connectLiveChannel();
    armFallbackPoll();
    void requestSync().catch(() => {
      // Last error is stored on the runtime snapshot.
    });
  }
}

export function resetSyncRuntimeForTests(): void {
  runtimeGeneration += 1;
  stopPolling();
  clearSessionRefresh();
  teardownLiveChannel();
  auth = null;
  lastError = null;
  sessionExpired = false;
  rpcOverride = undefined;
  devSpikeEnabled = false;
  fetchOverride = undefined;
  createSocketOverride = undefined;
}

export function setSyncRuntimeRpcForTests(rpc: SyncEngineRpc | undefined): void {
  rpcOverride = rpc;
}

function requireAuth(): SyncAuthService {
  if (!auth) {
    throw new Error('Sync runtime is not initialised.');
  }
  return auth;
}

function pinnedBackend(): SyncBackendRecord | null {
  return getActiveBackend() ?? listBackends()[0] ?? null;
}

/**
 * The current sync scope, or null when the session and active backend do not
 * form a valid pair: session tokens are bound to the backend they were issued
 * against, so a session written under backend A never produces a scope for
 * backend B.
 */
function currentScope(): SyncScope | null {
  const backend = getActiveBackend();
  const fields = auth?.getSessionScopeFields() ?? null;
  if (!backend || !fields) return null;
  if (fields.backendId !== null && fields.backendId !== backend.id) return null;
  return {
    backendId: backend.id,
    accountId: fields.accountId,
    datasetEpoch: fields.datasetEpoch,
  };
}

function isSyncEnabled(): boolean {
  const backend = getActiveBackend();
  return (
    backend?.state === 'active' &&
    !backend.identityReviewRequired &&
    auth?.getPublicSnapshot().state === 'signed-in' &&
    currentScope() !== null
  );
}

function payloadLabel(json: string | null): string | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null && 'name' in parsed) {
      const name = (parsed as { name: unknown }).name;
      return typeof name === 'string' ? name : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function previewAdoption(): SyncAdoptionPreviewItem[] {
  return listWorkflowTemplates().map((template) => ({
    entityType: SYNC_ENTITY_WORKFLOW_TEMPLATE,
    entityId: template.id,
    name: template.name,
  }));
}

/**
 * Adopts local-only workflow templates into the scope. An entity already bound
 * in ANY scope is skipped: at most one hosted association exists per entity in
 * v1, so data owned by another account/backend is never silently re-homed.
 * Cross-account copies need explicit export/adoption (a separate UX flow).
 */
export function bindLocalWorkflowTemplates(scope: SyncScope): number {
  const templates = listWorkflowTemplates();
  const run = getDb().transaction(() => {
    let bound = 0;
    for (const template of templates) {
      if (listSyncScopesForEntity(SYNC_ENTITY_WORKFLOW_TEMPLATE, template.id).length > 0) {
        continue;
      }
      upsertBinding(scope, SYNC_ENTITY_WORKFLOW_TEMPLATE, template.id);
      recordLocalChange(scope, {
        entityType: SYNC_ENTITY_WORKFLOW_TEMPLATE,
        entityId: template.id,
        schemaVersion: 1,
        operation: 'create',
        payload: {
          id: template.id,
          name: template.name,
          description: template.description,
          nodes: template.nodes,
          edges: template.edges,
          orchestration: template.orchestration,
        },
      });
      bound += 1;
    }
    return bound;
  });
  return run();
}

/** Dev/test fixture only — never reachable when `devSpikeEnabled` is false. */
export function spikeEnroll(input: SyncSpikeEnrollInput): SyncAuthPublicSnapshot {
  if (!devSpikeEnabled) {
    throw new Error('Spike enrollment is only available in development builds.');
  }
  const accountId = input.accountId.trim();
  if (accountId.length === 0 || accountId.includes(':')) {
    throw new Error('Account id must be a non-empty string without colons.');
  }
  const enrollmentId = (input.enrollmentId?.trim() || randomUUID()).replace(/:/g, '');
  if (enrollmentId.length === 0) {
    throw new Error('Enrollment id must be a non-empty string without colons.');
  }
  const backend = pinnedBackend();
  if (!backend) {
    throw new Error('Pin a backend before enrolling this device.');
  }
  if (backend.identityReviewRequired) {
    throw new Error('The pinned backend changed identity and must be re-reviewed first.');
  }
  runtimeGeneration += 1;
  const session: DeviceSession = {
    accessToken: `spike:${accountId}:${enrollmentId}`,
    accessExpiresAt: new Date(Date.now() + SPIKE_ACCESS_TTL_MS).toISOString(),
    refreshToken: `spike-refresh:${enrollmentId}`,
    credentialGeneration: 1,
    enrollmentId,
    accountId,
    datasetEpoch: SPIKE_DATASET_EPOCH,
    displayName: hostname() || 'Anvil device',
  };
  const snapshot = requireAuth().installDeviceSession(session, backend.id);
  sessionExpired = false;
  return snapshot;
}

function requireReviewedBackend(): SyncBackendRecord {
  const backend = pinnedBackend();
  if (!backend) {
    throw new Error('Pin a backend before signing in.');
  }
  if (backend.identityReviewRequired) {
    throw new Error('The pinned backend changed identity and must be re-reviewed first.');
  }
  return backend;
}

function apiUrlFor(backend: SyncBackendRecord): string {
  const allowLoopbackHttp = shouldAllowLoopbackHttp(backend.baseUrl);
  return resolveBackendPaths(backend.baseUrl, backend.descriptor, { allowLoopbackHttp }).apiUrl;
}

/** Real enroll RPC against the pinned backend's contract auth route. */
function enrollAgainst(backend: SyncBackendRecord): (params: EnrollParams) => Promise<EnrollResult> {
  return (params) =>
    postAuthRoute<EnrollResult>(
      { apiUrl: apiUrlFor(backend) },
      'enroll',
      params as unknown as Record<string, unknown>,
      { fetchFn: fetchOverride },
    );
}

function refreshAgainst(
  backend: SyncBackendRecord,
): (params: SessionRefreshParams) => Promise<SessionRefreshResult> {
  return (params) =>
    postAuthRoute<SessionRefreshResult>(
      { apiUrl: apiUrlFor(backend) },
      'session/refresh',
      params as unknown as Record<string, unknown>,
      { fetchFn: fetchOverride },
    );
}

function revokeAgainst(
  backend: SyncBackendRecord,
): (params: SessionRevokeParams) => Promise<SessionRevokeResult> {
  return (params) =>
    postAuthRoute<SessionRevokeResult>(
      { apiUrl: apiUrlFor(backend) },
      'session/revoke',
      params as unknown as Record<string, unknown>,
      { accessToken: requireAuth().getAccessToken() ?? undefined, fetchFn: fetchOverride },
    );
}

/**
 * Production sign-in: system-browser OIDC + PKCE against the issuer the
 * reviewed backend advertises, then proof exchange at `<api>/enroll`. Blocks
 * until the loopback callback arrives, the user cancels, or the wait times
 * out. Secrets stay in the main process; only the public snapshot returns.
 */
export async function signInWithOidc(): Promise<SyncAuthPublicSnapshot> {
  const backend = requireReviewedBackend();
  if (!backend.descriptor.authModes.includes('oidc-pkce')) {
    throw new Error('This backend does not advertise oidc-pkce sign-in.');
  }
  const service = requireAuth();
  await service.createPkceLogin({
    issuer: backend.descriptor.auth.issuer,
    clientId: backend.descriptor.auth.publicClientId,
    scopes: backend.descriptor.auth.scopes,
    launchBrowser: true,
  });
  try {
    const callback = await service.waitForPkceCallback();
    runtimeGeneration += 1;
    const snapshot = await service.completePkceLogin(
      { state: callback.state, authorizationCode: callback.authorizationCode },
      enrollAgainst(backend),
      backend.id,
    );
    sessionExpired = false;
    scheduleSessionRefresh();
    return snapshot;
  } catch (error) {
    service.cancelPendingLogin();
    throw error;
  }
}

/** Redeems a short-lived single-use enrollment code at the pinned backend. */
export async function enrollWithEnrollmentCode(code: string): Promise<SyncAuthPublicSnapshot> {
  const backend = requireReviewedBackend();
  if (!backend.descriptor.authModes.includes('enrollment-code')) {
    throw new Error('This backend does not advertise enrollment-code sign-in.');
  }
  runtimeGeneration += 1;
  const snapshot = await requireAuth().enrollWithCode(code, enrollAgainst(backend), backend.id);
  sessionExpired = false;
  scheduleSessionRefresh();
  return snapshot;
}

/**
 * Mints a pairing code on the signed-in account for enrolling another
 * device. Requires an active session; the returned code is shown once.
 */
export async function issueEnrollmentCode(): Promise<EnrollmentCodeIssueResult> {
  const backend = getActiveBackend() ?? pinnedBackend();
  if (!backend) {
    throw new Error('Pin a backend first.');
  }
  const token = requireAuth().getAccessToken();
  if (token === null) {
    throw new Error('Sign in before issuing a pairing code.');
  }
  return postAuthRoute<EnrollmentCodeIssueResult>(
    { apiUrl: apiUrlFor(backend) },
    'enrollment-codes',
    { displayName: hostname() || 'Anvil device' },
    { accessToken: token, fetchFn: fetchOverride },
  );
}

/**
 * Schedules the next credential rotation shortly before the stored access
 * expiry. The refresh itself is serialized inside the auth service, and a
 * stale response is fenced by the session epoch there.
 */
function scheduleSessionRefresh(): void {
  clearSessionRefresh();
  const snapshot = auth?.getPublicSnapshot() ?? null;
  if (snapshot?.state !== 'signed-in' || snapshot.expiresAt === null) {
    return;
  }
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return;
  }
  const delay = Math.max(expiresAt - Date.now() - REFRESH_AHEAD_MS, REFRESH_MIN_DELAY_MS);
  refreshTimer = setTimeout(() => {
    void runSessionRefresh();
  }, delay);
}

function clearSessionRefresh(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

async function runSessionRefresh(): Promise<void> {
  const backend = pinnedBackend();
  const service = auth;
  if (!backend || !service || backend.identityReviewRequired) {
    return;
  }
  const generation = runtimeGeneration;
  const fields = service.getSessionScopeFields();
  if (fields === null || (fields.backendId !== null && fields.backendId !== backend.id)) {
    return;
  }
  try {
    const snapshot = await service.refreshSession(refreshAgainst(backend));
    if (generation !== runtimeGeneration) {
      return;
    }
    if (snapshot.state === 'signed-in') {
      sessionExpired = false;
      scheduleSessionRefresh();
      // The socket authenticates at connect time; rotate it onto the new token.
      reconnectLiveChannel();
    } else if (snapshot.state === 'signed-out') {
      // The service wiped the session (e.g. refresh-reuse detection).
      sessionExpired = true;
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    if (error instanceof BackendRpcError && !error.retryable) {
      // The refresh credential itself was rejected or revoked; polling cannot
      // recover it — the user must sign in again.
      sessionExpired = true;
    }
    // Transient refresh failures retry at the next poll tick's expiry check.
  }
}

export function enableSync(): SyncRuntimeStatus {
  const backend = pinnedBackend();
  if (!backend) {
    throw new Error('Pin a backend before enabling Sync.');
  }
  if (backend.identityReviewRequired) {
    throw new Error('The pinned backend changed identity and must be re-reviewed first.');
  }
  const fields = requireAuth().getSessionScopeFields();
  if (!fields) {
    throw new Error('Enroll this device before enabling Sync.');
  }
  if (fields.backendId !== null && fields.backendId !== backend.id) {
    throw new Error('This device session belongs to a different backend. Sign out first.');
  }
  runtimeGeneration += 1;
  activateBackend(backend.id);
  const scope: SyncScope = {
    backendId: backend.id,
    accountId: fields.accountId,
    datasetEpoch: fields.datasetEpoch,
  };
  upsertEnrollment({
    id: fields.enrollmentId,
    scope,
    installationId: getOrCreateInstallationId(),
    displayName: hostname() || 'Anvil device',
    state: 'active',
  });
  bindLocalWorkflowTemplates(scope);
  connectLiveChannel();
  armFallbackPoll();
  // Fire-and-forget kick: a superseded/backoff rejection must not surface as
  // an unhandled rejection; the error is already recorded in `lastError`.
  void requestSync().catch(() => undefined);
  return getRuntimeStatus();
}

export async function signOutSync(): Promise<SyncRuntimeStatus> {
  // Fence first: any in-flight engine work from the old session fails its
  // generation check at the next durable write.
  runtimeGeneration += 1;
  stopPolling();
  clearSessionRefresh();
  teardownLiveChannel();
  const backend = pinnedBackend();
  const service = requireAuth();
  if (backend !== null) {
    try {
      await service.revokeSession(revokeAgainst(backend));
    } catch {
      // Best effort: the local session is wiped regardless.
    }
  }
  service.signOutLocal();
  disconnectBackend();
  lastError = null;
  sessionExpired = false;
  return getRuntimeStatus();
}

export function listConflictViews(): SyncConflictView[] {
  const scope = currentScope();
  if (!scope) return [];
  return listConflicts(scope).map((conflict) => ({
    id: conflict.id,
    entityType: conflict.entityType,
    entityId: conflict.entityId,
    kind: conflict.kind,
    localLabel: payloadLabel(conflict.localPayloadJson),
    remoteLabel: payloadLabel(conflict.remotePayloadJson),
    localPayloadJson: conflict.localPayloadJson,
    remotePayloadJson: conflict.remotePayloadJson,
  }));
}

export function resolveRuntimeConflict(
  conflictId: string,
  resolution: SyncConflictResolutionChoice,
): SyncRuntimeStatus {
  const scope = currentScope();
  if (!scope) {
    throw new Error('No active sync scope; conflicts resolve only inside their account.');
  }
  resolveSyncConflict({ conflictId, resolution, scope });
  void requestSync().catch(() => undefined);
  return getRuntimeStatus();
}

export function reviewBackendIdentity(): SyncRuntimeStatus {
  const backend = pinnedBackend();
  if (!backend) {
    throw new Error('No backend is pinned.');
  }
  resolveBackendIdentityReview(backend.id);
  return getRuntimeStatus();
}

export function getRuntimeStatus(): SyncRuntimeStatus {
  const scope = currentScope();
  const snapshot = scope ? getSyncEngineSnapshot(scope) : null;
  const backend = getActiveBackend() ?? pinnedBackend();
  return {
    auth: auth?.getPublicSnapshot() ?? {
      state: 'signed-out',
      accountId: null,
      enrollmentId: null,
      expiresAt: null,
    },
    syncEnabled: isSyncEnabled(),
    devSpikeAvailable: devSpikeEnabled,
    connectionState: liveState,
    backendIdentityReviewRequired: backend?.identityReviewRequired ?? false,
    pendingCount: snapshot?.pendingCount ?? 0,
    conflictCount: scope ? listConflicts(scope).length : 0,
    rejectedCount: snapshot?.rejectedCount ?? 0,
    recovering: snapshot?.recovering ?? false,
    sessionExpired,
    lastError,
    lastPushAt: snapshot?.lastPushAt ?? null,
    lastPullAt: snapshot?.lastPullAt ?? null,
  };
}

export async function requestSync(): Promise<void> {
  if (!isSyncEnabled()) return;
  // Refresh near-expiry credentials before they mid-flight a sync cycle.
  const snapshot = auth?.getPublicSnapshot() ?? null;
  if (snapshot?.state === 'signed-in' && snapshot.expiresAt !== null) {
    const expiresAt = Date.parse(snapshot.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() <= REFRESH_AHEAD_MS) {
      await runSessionRefresh();
      if (!isSyncEnabled()) return;
    }
  }
  const backend = getActiveBackend();
  const fields = auth?.getSessionScopeFields() ?? null;
  const token = auth?.getAccessToken() ?? null;
  if (!backend || !fields || token === null) return;
  const allowLoopbackHttp = shouldAllowLoopbackHttp(backend.baseUrl);
  const paths = resolveBackendPaths(backend.baseUrl, backend.descriptor, { allowLoopbackHttp });
  const scope: SyncScope = {
    backendId: backend.id,
    accountId: fields.accountId,
    datasetEpoch: fields.datasetEpoch,
  };
  const generation = runtimeGeneration;
  const guard = (): boolean => {
    if (generation !== runtimeGeneration) return false;
    const active = getActiveBackend();
    const sessionFields = auth?.getSessionScopeFields() ?? null;
    const activeToken = auth?.getAccessToken() ?? null;
    return (
      active !== null &&
      !active.identityReviewRequired &&
      sessionFields !== null &&
      activeToken === token &&
      active.id === scope.backendId &&
      sessionFields.accountId === scope.accountId &&
      sessionFields.datasetEpoch === scope.datasetEpoch
    );
  };
  try {
    await runSyncCycle({
      scope,
      enrollmentId: fields.enrollmentId,
      connection: { apiUrl: paths.apiUrl, limits: backend.descriptor.limits },
      accessToken: token,
      rpc:
        rpcOverride ??
        (fetchOverride === undefined
          ? undefined
          : (connection, operation, params, accessToken) =>
              backendRpc(connection, operation, params, accessToken, {
                fetchFn: fetchOverride,
              })),
      guard,
    });
    lastError = null;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    if (
      error instanceof SyncEngineError &&
      !error.retryable &&
      error.code === 'unauthenticated'
    ) {
      sessionExpired = true;
    }
    throw error;
  }
}

export function onBackendDisconnected(): void {
  runtimeGeneration += 1;
  stopPolling();
  teardownLiveChannel();
}

/**
 * OS sleep/wake hook (index.ts wires `powerMonitor.on('resume')` here): the
 * socket may have died silently while suspended, so reconnect and kick a
 * catch-up cycle. Generation-fenced inside like any other trigger.
 */
export function onSystemResume(): void {
  if (!isSyncEnabled()) return;
  connectLiveChannel();
  void requestSync().catch(() => undefined);
}

/**
 * Bounded fallback: the live channel drives prompt sync; this timer only
 * guarantees eventual progress (and reconnect attempts) when the socket is
 * down, dropping to a slow safety-net cadence while it is live.
 */
function armFallbackPoll(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollTimer = setInterval(
    () => {
      if (liveState !== 'live') {
        connectLiveChannel();
      }
      void requestSync().catch(() => {
        // lastError is recorded inside requestSync.
      });
    },
    liveState === 'live' ? POLL_LIVE_FALLBACK_MS : POLL_MS,
  );
}

function stopPolling(): void {
  if (pollTimer === null) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

/**
 * Opens the live socket for the current backend+session. The socket carries
 * only acceleration hints (`sync.invalidate`, `auth.expiring`, `gap`); any
 * frame triggers a generation-fenced `requestSync`, and loss of the channel
 * schedules a full-jitter reconnect while the fallback poll keeps progress.
 */
function connectLiveChannel(): void {
  if (!isSyncEnabled() || liveSocket !== null) {
    return;
  }
  const backend = getActiveBackend();
  const token = auth?.getAccessToken() ?? null;
  if (!backend || backend.identityReviewRequired || token === null) {
    liveState = 'offline';
    return;
  }
  const paths = resolveBackendPaths(backend.baseUrl, backend.descriptor, {
    allowLoopbackHttp: shouldAllowLoopbackHttp(backend.baseUrl),
  });
  const generation = runtimeGeneration;
  liveState = 'connecting';
  let socket: BackendSocket;
  try {
    socket = openSocket({ socketUrl: paths.socketUrl }, token, {
      liveFrameBytes: backend.descriptor.limits?.liveFrameBytes,
      ...(createSocketOverride === undefined ? {} : { createSocket: createSocketOverride }),
    });
  } catch {
    liveState = 'offline';
    scheduleLiveReconnect(generation);
    return;
  }
  liveSocket = socket;
  socket.onFrame((frame) => {
    if (generation !== runtimeGeneration) {
      return;
    }
    switch (frame.type) {
      case 'hello':
        liveState = 'live';
        reconnectAttempt = 0;
        armFallbackPoll();
        // Catch up anything missed while the channel was down.
        void requestSync().catch(() => undefined);
        break;
      case 'sync.invalidate':
      case 'gap':
        void requestSync().catch(() => undefined);
        break;
      case 'auth.expiring':
        void runSessionRefresh();
        break;
      case 'error':
        lastError = frame.message;
        if (frame.retryable) {
          socket.close();
        } else {
          socket.close(1008, 'backend error frame');
        }
        break;
      default:
        break;
    }
  });
  socket.onClose(() => {
    onLiveClosed(generation, socket);
  });
  socket.onError(() => {
    // The close event that follows drives the reconnect path.
  });
  socket.onProtocolError(() => {
    // openSocket already closed the transport; the close event drives it.
  });
}

function onLiveClosed(generation: number, socket: BackendSocket): void {
  if (liveSocket !== socket) {
    return; // stale close event from a replaced socket
  }
  liveSocket = null;
  liveState = 'offline';
  if (generation !== runtimeGeneration) {
    return;
  }
  armFallbackPoll();
  scheduleLiveReconnect(generation);
}

function scheduleLiveReconnect(generation: number): void {
  if (reconnectTimer !== null || !isSyncEnabled()) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (generation !== runtimeGeneration) {
      return;
    }
    connectLiveChannel();
  }, computeReconnectDelayMs(reconnectAttempt));
  reconnectAttempt += 1;
}

/** Re-auth the socket after a credential rotation. */
function reconnectLiveChannel(): void {
  const socket = liveSocket;
  liveSocket = null;
  liveState = 'offline';
  socket?.close(1000, 'credential rotation');
  connectLiveChannel();
}

function teardownLiveChannel(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
  const socket = liveSocket;
  liveSocket = null;
  liveState = 'offline';
  // onLiveClosed ignores this close: liveSocket is already null.
  socket?.close(1000, 'sync disabled');
}
