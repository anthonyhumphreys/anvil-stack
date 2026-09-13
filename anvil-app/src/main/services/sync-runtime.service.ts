import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolveBackendPaths } from '../../../cloud/contract/discovery.js';
import type {
  DeviceSession,
  EnrollmentCodeIssueResult,
  EnrollParams,
  EnrollResult,
  SessionDescribeResult,
  SessionRefreshParams,
  SessionRefreshResult,
  SessionRevokeParams,
  SessionRevokeResult,
} from '../../../cloud/contract/auth.js';
import { PROTOCOL } from '../../../cloud/contract/version.js';
import {
  SPIKE_DATASET_EPOCH,
  type SyncAdoptionPreviewItem,
  type SyncAuthPublicSnapshot,
  type SyncConflictResolutionChoice,
  type SyncConflictView,
  type SyncDiagnostics,
  type MeshWorkerStatus,
  type SyncRemoteAccountStats,
  type SyncRuntimeStatus,
  type SyncScopeDiagnostics,
  type SyncSpikeEnrollInput,
} from '../../shared/sync-runtime.js';
import {
  SYNC_ENTITY_SCHEMA_VERSIONS,
  SYNC_ENTITY_SETTINGS,
  SYNC_ENTITY_TYPES,
  SYNC_ENTITY_WORKSPACE_DEFINITION,
  SYNC_SETTINGS_ENTITY_ID,
  type SyncScope,
} from '../../shared/sync-mesh.js';
import {
  buildEntityPayload,
  listLocalEntityIds,
  materializeRepoDefinitions,
} from './sync-entity-domain.js';
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
  configureMeshWorkerContext,
  getMeshWorkerStatus,
  handleJobAvailable,
  meshWorkerOnSyncGone,
  meshWorkerOnSyncReady,
  reconcileMeshAttemptsOnBoot,
  resetMeshWorkerForTests,
  setMeshWorkerEnabled,
} from './mesh-worker.service.js';
import {
  configureMeshObserverContext,
  handleActivityFrame,
  handleGapFrame,
  meshObserverOnGone,
  meshObserverOnLive,
  resetMeshObserverForTests,
} from './mesh-observe.service.js';
import {
  configureMeshArtifactContext,
  resetMeshArtifactForTests,
} from './mesh-artifact.service.js';
import {
  configureMeshHandoffContext,
  reconcileHandoffsOnBoot,
  resetMeshHandoffForTests,
} from './mesh-handoff.service.js';
import {
  configureMeshDispatchContext,
  reconcileDispatchesOnBoot,
  resetMeshDispatchForTests,
} from './mesh-dispatch.service.js';
import {
  configureMeshIntegrationContext,
  resetMeshIntegrationForTests,
} from './mesh-integration.service.js';
import {
  getOrCreateInstallationId,
  getSyncState,
  listBindings,
  listConflicts,
  listOutboxRows,
  listScanStaging,
  listSyncScopes,
  listSyncScopesForEntity,
  recordLocalChange,
  sweepLocalSyncRetention,
  upsertBinding,
  upsertEnrollment,
} from './sync-persistence.service.js';
import { getDb } from '../db/database.js';
import { SCHEMA_VERSION } from '../db/schema.js';

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
/** The `runtimeGeneration` that dialed `liveSocket`; -1 when none. */
let liveSocketGeneration = -1;
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
let runtimeUserDataDir: string | null = null;
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
  runtimeUserDataDir = userDataDir;
  auth = createSyncAuthService({
    userDataDir,
    installationId: getOrCreateInstallationId(),
    ...(options.openExternal === undefined ? {} : { openExternal: options.openExternal }),
    ...(options.listenLoopback === undefined ? {} : { listenLoopback: options.listenLoopback }),
  });
  devSpikeEnabled = options.devSpikeEnabled === true;
  fetchOverride = options.fetchFn;
  createSocketOverride = options.createSocket;
  // Compact terminal sync metadata (acknowledged/rejected outbox rows,
  // resolved conflicts) past the local retention window.
  sweepLocalSyncRetention();
  // MESH-02: the worker reads its session/backend context through an
  // injected getter so it never imports this module.
  configureMeshWorkerContext(() => {
    const backend = getActiveBackend();
    const fields = auth?.getSessionScopeFields() ?? null;
    const token = auth?.getAccessToken() ?? null;
    if (backend === null || fields === null || token === null) return null;
    return {
      apiUrl: apiUrlFor(backend),
      accessToken: token,
      enrollmentId: fields.enrollmentId,
      ...(runtimeUserDataDir === null ? {} : { userDataDir: runtimeUserDataDir }),
      sendFrame: (frame) => liveSocket?.send(JSON.stringify(frame)),
      isLive: () => liveState === 'live' && liveSocket !== null,
    };
  });
  // MESH-03: the observer shares the same session context and live socket.
  configureMeshObserverContext(() => {
    const backend = getActiveBackend();
    const fields = auth?.getSessionScopeFields() ?? null;
    const token = auth?.getAccessToken() ?? null;
    if (backend === null || fields === null || token === null) return null;
    return {
      apiUrl: apiUrlFor(backend),
      accessToken: token,
      enrollmentId: fields.enrollmentId,
      sendFrame: (frame) => liveSocket?.send(JSON.stringify(frame)),
      isLive: () => liveState === 'live',
    };
  });
  configureMeshArtifactContext(() => {
    const backend = getActiveBackend();
    const token = auth?.getAccessToken() ?? null;
    if (backend === null || token === null) return null;
    return { apiUrl: apiUrlFor(backend), accessToken: token };
  });
  // SESSION-03: handoff orchestration reads the same session context; the
  // local ownership mirror must be reconciled before any session resumes.
  configureMeshHandoffContext(() => {
    const backend = getActiveBackend();
    const fields = auth?.getSessionScopeFields() ?? null;
    const token = auth?.getAccessToken() ?? null;
    if (backend === null || fields === null || token === null) return null;
    return { apiUrl: apiUrlFor(backend), accessToken: token, enrollmentId: fields.enrollmentId };
  });
  // FLOW-02: node dispatches are source-side; same session context, and
  // boot reconciliation re-adopts persisted jobs (never recreates them).
  configureMeshDispatchContext(() => {
    const backend = getActiveBackend();
    const fields = auth?.getSessionScopeFields() ?? null;
    const token = auth?.getAccessToken() ?? null;
    if (backend === null || fields === null || token === null) return null;
    return { apiUrl: apiUrlFor(backend), accessToken: token, enrollmentId: fields.enrollmentId };
  });
  // FLOW-03: integration runs are local-only (merge adopted refs, verify)
  // — they need just the userData dir for worktree roots.
  configureMeshIntegrationContext(() =>
    runtimeUserDataDir === null ? null : { userDataDir: runtimeUserDataDir },
  );
  void reconcileMeshAttemptsOnBoot().catch(() => undefined);
  void reconcileHandoffsOnBoot().catch(() => undefined);
  void reconcileDispatchesOnBoot().catch(() => undefined);
  if (auth.getPublicSnapshot().state === 'signed-in') {
    scheduleSessionRefresh();
  }
  if (isSyncEnabled()) {
    connectLiveChannel();
    armFallbackPoll();
    meshWorkerOnSyncReady();
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
  resetMeshObserverForTests();
  resetMeshArtifactForTests();
  resetMeshWorkerForTests();
  resetMeshHandoffForTests();
  resetMeshDispatchForTests();
  resetMeshIntegrationForTests();
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
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.name === 'string') return record.name;
    // The settings singleton carries { id, fields } rather than a name.
    if (record.id === SYNC_SETTINGS_ENTITY_ID) return 'App settings';
  } catch {
    return null;
  }
  return null;
}

export function previewAdoption(): SyncAdoptionPreviewItem[] {
  const items: SyncAdoptionPreviewItem[] = [];
  for (const entityType of SYNC_ENTITY_TYPES) {
    for (const entityId of listLocalEntityIds(entityType)) {
      const payload = buildEntityPayload(entityType, entityId);
      const name =
        payload !== null && typeof payload === 'object' && 'name' in payload
          ? ((payload as { name: unknown }).name as string | undefined)
          : undefined;
      items.push({
        entityType,
        entityId,
        name: name ?? (entityType === SYNC_ENTITY_SETTINGS ? 'App settings' : entityId),
      });
    }
  }
  return items;
}

/**
 * Adopts local-only entities into the scope. An entity already bound in ANY
 * scope is skipped: at most one hosted association exists per entity in v1,
 * so data owned by another account/backend is never silently re-homed.
 * Cross-account copies need explicit export/adoption (a separate UX flow).
 */
export function bindLocalEntities(scope: SyncScope): number {
  const run = getDb().transaction(() => {
    let bound = 0;
    for (const entityType of SYNC_ENTITY_TYPES) {
      const entityIds = listLocalEntityIds(entityType);
      for (const entityId of entityIds) {
        if (entityType === SYNC_ENTITY_WORKSPACE_DEFINITION) {
          materializeRepoDefinitions(entityId);
        }
        if (listSyncScopesForEntity(entityType, entityId).length > 0) {
          continue;
        }
        const payload = buildEntityPayload(entityType, entityId);
        if (payload === null) continue;
        upsertBinding(scope, entityType, entityId);
        recordLocalChange(scope, {
          entityType,
          entityId,
          schemaVersion: SYNC_ENTITY_SCHEMA_VERSIONS[entityType],
          operation: 'create',
          payload,
        });
        bound += 1;
      }
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
  bindLocalEntities(scope);
  connectLiveChannel();
  armFallbackPoll();
  meshWorkerOnSyncReady();
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
  meshWorkerOnSyncGone();
  meshObserverOnGone();
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
    quotaExceeded: snapshot?.quotaExceeded ?? false,
    recovering: snapshot?.recovering ?? false,
    sessionExpired,
    meshWorker: getMeshWorkerStatus(),
    lastError,
    lastPushAt: snapshot?.lastPushAt ?? null,
    lastPullAt: snapshot?.lastPullAt ?? null,
  };
}

/**
 * MESH-02: local worker opt-in. Requires an enabled sync scope — the policy
 * publish and worker incarnation are account-scoped operations. The toggle
 * itself is device-local and never syncs.
 */
export async function setMeshWorkerOptIn(enabled: boolean): Promise<MeshWorkerStatus> {
  if (enabled && !isSyncEnabled()) {
    throw new Error('Enable sync before opting this device in as a worker.');
  }
  return setMeshWorkerEnabled(enabled);
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

/**
 * Redacted diagnostics bundle for operator inspection (OPS-01). Only
 * identifiers, counts, cursors, and error strings — never payloads, file
 * paths, tokens, or enrollment codes. Remote account stats are merged
 * best-effort; the bundle stays complete when the backend is unreachable.
 */
export async function exportSyncDiagnostics(): Promise<SyncDiagnostics> {
  const scopes: SyncScopeDiagnostics[] = listSyncScopes().map((scope) => {
    const state = getSyncState(scope);
    const conflicts = listConflicts(scope);
    return {
      backendId: scope.backendId,
      accountId: scope.accountId,
      datasetEpoch: scope.datasetEpoch,
      bindingsByEntityType: countBy(listBindings(scope), (b) => b.entityType),
      outboxByState: countBy(listOutboxRows(scope), (r) => r.state),
      openConflicts: conflicts.filter((c) => c.resolvedAt === null).length,
      resolvedConflicts: conflicts.filter((c) => c.resolvedAt !== null).length,
      pullCursor: state?.cursor ?? null,
      consumedSequenceHighWater: state?.consumedSequenceHighWater ?? 0,
      retentionFloorSequence: state?.retentionFloorSequence ?? null,
      resetRequired: state?.resetRequired ?? false,
      stagedScanRows: listScanStaging(scope).length,
      lastPushAt: state?.lastPushAt ?? null,
      lastPullAt: state?.lastPullAt ?? null,
    };
  });
  let remote: SyncRemoteAccountStats | null = null;
  const backend = getActiveBackend() ?? pinnedBackend();
  const token = auth?.getAccessToken() ?? null;
  if (backend !== null && token !== null) {
    try {
      const allowLoopbackHttp = shouldAllowLoopbackHttp(backend.baseUrl);
      const paths = resolveBackendPaths(backend.baseUrl, backend.descriptor, {
        allowLoopbackHttp,
      });
      const result = await backendRpc<SessionDescribeResult>(
        { apiUrl: paths.apiUrl },
        'session.describe',
        {},
        token,
        fetchOverride === undefined ? {} : { fetchFn: fetchOverride },
      );
      remote = result.result.accountStats ?? null;
    } catch {
      remote = null;
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    protocol: PROTOCOL,
    profile: 'sync/1',
    schemaVersion: SCHEMA_VERSION,
    installationId: getOrCreateInstallationId(),
    status: getRuntimeStatus(),
    scopes,
    remote,
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
  meshWorkerOnSyncGone();
  meshObserverOnGone();
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
  if (!isSyncEnabled()) {
    return;
  }
  if (liveSocket !== null) {
    if (liveSocketGeneration === runtimeGeneration) {
      return;
    }
    // A generation bump (re-enable, sign-out race) superseded this socket
    // mid-handshake — its hello would be fenced out at the frame handler,
    // stranding the channel in 'connecting' forever. Retire and redial.
    const stale = liveSocket;
    liveSocket = null;
    liveSocketGeneration = -1;
    stale.close(1000, 'superseded generation');
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
  liveSocketGeneration = generation;
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
        meshWorkerOnSyncReady();
        meshObserverOnLive();
        void requestSync().catch(() => undefined);
        break;
      case 'sync.invalidate':
        void requestSync().catch(() => undefined);
        break;
      case 'job.available':
        void handleJobAvailable(frame.jobId).catch(() => undefined);
        break;
      case 'activity':
        handleActivityFrame(frame);
        break;
      case 'gap':
        // Attempt-stream gap — the observer replays the durable journal.
        handleGapFrame(frame);
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
  liveSocketGeneration = -1;
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
  liveSocketGeneration = -1;
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
  liveSocketGeneration = -1;
  liveState = 'offline';
  // onLiveClosed ignores this close: liveSocket is already null.
  socket?.close(1000, 'sync disabled');
}
