import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolveBackendPaths } from '../../../cloud/contract/discovery.js';
import type {
  DeviceListResult,
  DeviceRenameResult,
  DeviceRevokeResult,
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
import {
  DATA_EXPORT_FORMAT_VERSION,
  type DataExportBeginResult,
  type DataExportPageResult,
  type DataImportCommitResult,
  type DataImportPreviewResult,
  type ExportedEntity,
} from '../../../cloud/contract/data.js';
import type {
  ApprovalDecision,
  ApprovalDecideResult,
  ApprovalGetResult,
  ApprovalRecord,
  JobCancelResult,
  JobGetResult,
  JobListResult,
  JobSummary,
} from '../../../cloud/contract/jobs.js';
import type { HandoffGetResult, HandoffRecord } from '../../../cloud/contract/handoff.js';
import type { HostedEntitlement } from '../../../cloud/contract/entitlements.js';
import type {
  DeviceAdvertiseParams,
  DeviceAdvertiseResult,
  DevicePresenceResult,
  SessionAttestResult,
} from '../../../cloud/contract/companion.js';
import { PROTOCOL } from '../../../cloud/contract/version.js';
import {
  SPIKE_DATASET_EPOCH,
  type SyncAdoptionPreviewItem,
  type SyncAuthPublicSnapshot,
  type SyncConflictResolutionChoice,
  type SyncConflictView,
  type SessionMeshState,
  type SyncDiagnostics,
  type MeshWorkerStatus,
  type SyncHostedStatus,
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
  observeAttempt,
  resetMeshObserverForTests,
  type AttemptObserver,
} from './mesh-observe.service.js';
import {
  configureMeshArtifactContext,
  resetMeshArtifactForTests,
} from './mesh-artifact.service.js';
import { configureArtifactShareContext } from './artifact-share.service.js';
import { decodePairingPayload, isPairingPayloadString } from '../../../cloud/contract/sealed.js';
import {
  deriveSas,
  ensureDeviceIdentity,
  listDeviceIdentities,
  mintPairingPayload,
  publishDeviceIdentity,
  registerPairingRedemption,
  rotateAccountKey,
} from './sync-keyring.service.js';
import {
  configureMeshHandoffContext,
  initiateHandoff,
  reconcileHandoffsOnBoot,
  resetMeshHandoffForTests,
  type InitiateHandoffResult,
} from './mesh-handoff.service.js';
import { readSessionOwnership } from './mesh-ownership.service.js';
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
  clearSyncEntitlement,
  getOrCreateInstallationId,
  getSyncEntitlement,
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
  upsertSyncEntitlement,
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

/**
 * BILL-05: the hosted account page origin is fixed — never derived from user
 * input, a backend descriptor, or a deep-link parameter. Returning from the
 * browser only re-triggers `session.describe`; no payment state is ever
 * accepted back through a URL.
 */
const HOSTED_SITE_ORIGIN = 'https://anvil.dev';
const HOSTED_ACCOUNT_URL = `${HOSTED_SITE_ORIGIN}/account`;
/** Focus/reconnect refreshes are throttled so focus cycling can't spam it. */
const HOSTED_REFRESH_MIN_INTERVAL_MS = 60_000;
/**
 * `error.details.reason` values on a 403 that mean "hosted access paused"
 * (BILL-03 classification). `account-deleted` is deliberately absent — it is
 * a permanent account teardown handled by the deletion path, not a pause.
 */
const HOSTED_DENIAL_REASONS: ReadonlySet<string> = new Set([
  'subscription-required',
  'preview-ended',
  'billing-unavailable',
]);
/** Entitlement states the renderer chip understands; anything else → 'unknown'. */
const HOSTED_STATES: ReadonlySet<string> = new Set([
  'preview',
  'active',
  'grace',
  'restricted',
  'unknown',
]);

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
/** Timestamp of the last attempted session.describe entitlement refresh. */
let lastHostedRefreshAt = 0;

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
    const scope = currentScope();
    if (backend === null || fields === null || token === null) return null;
    return {
      apiUrl: apiUrlFor(backend),
      accessToken: token,
      enrollmentId: fields.enrollmentId,
      ...(scope === null ? {} : { scope }),
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
    const scope = currentScope();
    if (backend === null || token === null) return null;
    return {
      apiUrl: apiUrlFor(backend),
      accessToken: token,
      ...(scope === null ? {} : { scope }),
    };
  });
  // Hosted artifact sharing: same session context; user-actor share.* ops.
  configureArtifactShareContext(() => {
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
    const scope = currentScope();
    if (backend === null || fields === null || token === null) return null;
    return {
      apiUrl: apiUrlFor(backend),
      accessToken: token,
      enrollmentId: fields.enrollmentId,
      ...(scope === null ? {} : { scope }),
    };
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
    // BILL-05: pick up any hosted-access change made while the app was off.
    maybeRefreshHostedEntitlement();
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
  lastHostedRefreshAt = 0;
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
function enrollAgainst(
  backend: SyncBackendRecord,
): (params: EnrollParams) => Promise<EnrollResult> {
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
    // OIDC enrollment has no pairing channel; this device publishes its
    // identity and receives the ADK via a keyring wrap from a device that
    // already holds it (or provisions v1 itself on a fresh account).
    initializeSyncCrypto();
    // BILL-05: pull hosted access now so a restricted account never gets one
    // free mutating cycle before the first describe lands.
    void refreshHostedEntitlement().catch(() => undefined);
    return snapshot;
  } catch (error) {
    service.cancelPendingLogin();
    throw error;
  }
}

/**
 * E2E bootstrap after any successful enrollment: publishes this device's
 * X25519 identity and, when the enrollment carried a pairing payload,
 * registers the pairing secret so the issuer's keyring blob can be
 * unwrapped on the next pull. Best-effort — a failure here defers sealing
 * rather than breaking the session.
 */
function initializeSyncCrypto(pairing?: { pairingNonce: string; pairingSecret: string }): void {
  const scope = currentScope();
  const fields = requireAuth().getSessionScopeFields();
  if (scope === null || fields === null) return;
  try {
    if (pairing !== undefined) {
      registerPairingRedemption(scope, pairing.pairingNonce, pairing.pairingSecret);
    }
    publishDeviceIdentity(scope, fields.enrollmentId);
  } catch (error) {
    console.warn(
      `[sync] E2E crypto bootstrap failed; sealed pushes defer until keys arrive: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Redeems a short-lived single-use enrollment code at the pinned backend. */
export async function enrollWithEnrollmentCode(code: string): Promise<SyncAuthPublicSnapshot> {
  const backend = requireReviewedBackend();
  if (!backend.descriptor.authModes.includes('enrollment-code')) {
    throw new Error('This backend does not advertise enrollment-code sign-in.');
  }
  // A pairing payload carries the enrollment code plus the out-of-band
  // keyring secret; the server only ever sees the code portion.
  const pairing = isPairingPayloadString(code) ? decodePairingPayload(code) : null;
  const redeemCode = pairing === null ? code : pairing.enrollmentCode;
  runtimeGeneration += 1;
  const snapshot = await requireAuth().enrollWithCode(
    redeemCode,
    enrollAgainst(backend),
    backend.id,
  );
  sessionExpired = false;
  scheduleSessionRefresh();
  initializeSyncCrypto(
    pairing === null
      ? undefined
      : { pairingNonce: pairing.pairingNonce, pairingSecret: pairing.pairingSecret },
  );
  void refreshHostedEntitlement().catch(() => undefined);
  return snapshot;
}

/**
 * Mints a pairing payload on the signed-in account for enrolling another
 * device. The returned `pairingPayload` is the `anvil-pair-…` string the
 * new device types or scans: it embeds the enrollment code plus the
 * out-of-band keyring secret and is shown once.
 */
export async function issueEnrollmentCode(): Promise<
  EnrollmentCodeIssueResult & { pairingPayload: string | null }
> {
  const backend = getActiveBackend() ?? pinnedBackend();
  if (!backend) {
    throw new Error('Pin a backend first.');
  }
  const token = requireAuth().getAccessToken();
  if (token === null) {
    throw new Error('Sign in before issuing a pairing code.');
  }
  const result = await postAuthRoute<EnrollmentCodeIssueResult>(
    { apiUrl: apiUrlFor(backend) },
    'enrollment-codes',
    { displayName: hostname() || 'Anvil device' },
    { accessToken: token, fetchFn: fetchOverride },
  );
  // Seal the current ADK under a fresh pairing secret and queue it for the
  // redeeming device. No key yet (fresh account, or this device is itself
  // awaiting a wrap) → the caller still gets a usable enrollment code.
  const scope = currentScope();
  const fields = requireAuth().getSessionScopeFields();
  let pairingPayload: string | null = null;
  if (scope !== null && fields !== null) {
    try {
      pairingPayload = mintPairingPayload(scope, fields.enrollmentId, result.code).pairingPayload;
    } catch {
      pairingPayload = null;
    }
  }
  return { ...result, pairingPayload };
}

/**
 * Envelope-RPC call against the pinned backend under the active device
 * session. Device management and data-portability operations ride this —
 * the launch UX surfaces them in the Sync & Mesh settings.
 */
async function accountRpc<R>(operation: string, params: unknown): Promise<R> {
  const backend = getActiveBackend() ?? pinnedBackend();
  if (!backend) {
    throw new Error('Pin a backend first.');
  }
  const token = requireAuth().getAccessToken();
  if (token === null) {
    throw new Error('Sign in first.');
  }
  const { result } = await backendRpc<R>({ apiUrl: apiUrlFor(backend) }, operation, params, token, {
    fetchFn: fetchOverride,
  });
  return result;
}

/** All device enrollments on the account, including revoked rows and self. */
export async function listDevices(): Promise<DeviceListResult> {
  return accountRpc<DeviceListResult>('device.list', {});
}

/** Rename another enrollment on the same account; empty string clears. */
export async function renameDevice(
  enrollmentId: string,
  displayName: string,
): Promise<DeviceRenameResult> {
  return accountRpc<DeviceRenameResult>('device.rename', { enrollmentId, displayName });
}

/**
 * Revoke a sibling enrollment; idempotent and severs its live sessions.
 * On success the ADK rotates: every surviving known device gets a
 * keyring-wrap of v(N+1) and new writes seal under it, so the revoked
 * device cannot decrypt anything written after this point. It retains
 * what it already decrypted — that bound is inherent.
 */
export async function revokeDevice(enrollmentId: string): Promise<DeviceRevokeResult> {
  const result = await accountRpc<DeviceRevokeResult>('device.revoke', { enrollmentId });
  const scope = currentScope();
  if (scope !== null) {
    try {
      rotateAccountKey(scope, [enrollmentId]);
    } catch (error) {
      console.warn(
        `[sync] ADK rotation after revoke failed; new writes keep the current key: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return result;
}

/**
 * Short authentication string for verifying a sibling device: both
 * devices derive the same 9-digit code from the account id and their
 * X25519 identity public keys, so matching codes on both screens prove
 * neither enrollment's identity was substituted. Throws when the peer's
 * identity has not been seen yet (arrives via sync).
 */
export function deviceVerificationCode(targetEnrollmentId: string): { code: string } {
  const scope = currentScope();
  const fields = requireAuth().getSessionScopeFields();
  if (scope === null || fields === null) {
    throw new Error('Sign in before verifying a device.');
  }
  const peer = listDeviceIdentities(scope).find(
    (device) => device.enrollmentId === targetEnrollmentId,
  );
  if (peer === undefined) {
    throw new Error('Device identity not seen yet — sync, then try again.');
  }
  const own = ensureDeviceIdentity(scope, fields.enrollmentId);
  return { code: deriveSas(scope.accountId, own.pub, peer.pub) };
}

/**
 * MOB-01: verifies a companion's presented device access token through the
 * backend (`session.attest`). Returns the verified identity claims, or null
 * when the token is invalid/expired/revoked — or when this desktop is not
 * signed in and so cannot attest at all.
 */
export async function attestDeviceAccessToken(
  accessToken: string,
): Promise<SessionAttestResult | null> {
  try {
    return await accountRpc<SessionAttestResult>('session.attest', { accessToken });
  } catch {
    return null;
  }
}

/**
 * MOB-01: publishes this host's companion endpoints/capabilities to the
 * account object. Best-effort presence metadata; callers tolerate failure
 * (offline, unsigned) by simply not advertising.
 */
export async function publishCompanionAdvertisement(
  params: DeviceAdvertiseParams,
): Promise<DeviceAdvertiseResult> {
  return accountRpc<DeviceAdvertiseResult>('device.advertise', params);
}

/** MOB-01: the account's companion presence roster. */
export async function getDevicePresence(): Promise<DevicePresenceResult> {
  return accountRpc<DevicePresenceResult>('device.presence', {});
}

/** Begin a durable, resumable export of the account's synced entities. */
export async function beginDataExport(): Promise<DataExportBeginResult> {
  return accountRpc<DataExportBeginResult>('data.export.begin', {});
}

/** One bounded page of an export; the client-held cursor survives restarts. */
export async function pageDataExport(
  operationId: string,
  cursor: string | null,
): Promise<DataExportPageResult> {
  return accountRpc<DataExportPageResult>('data.export.page', { operationId, cursor });
}

/**
 * Gathers every export page and writes a portable document to a
 * user-chosen file. The document is `{ formatVersion, epoch, exportedAt,
 * entities }` — the shape `data.import.preview` accepts.
 */
export async function exportAccountDataToFile(): Promise<{
  saved: boolean;
  filePath: string | null;
  entityCount: number;
}> {
  const begin = await beginDataExport();
  const entities: ExportedEntity[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await pageDataExport(begin.operationId, cursor);
    entities.push(...page.entities);
    if (page.done || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const { BrowserWindow, dialog } = await import('electron');
  const win = BrowserWindow.getAllWindows()[0];
  const { canceled, filePath } = await dialog.showSaveDialog(win!, {
    title: 'Export account data',
    defaultPath: `anvil-export-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'Anvil data export', extensions: ['json'] }],
  });
  if (canceled || !filePath) {
    return { saved: false, filePath: null, entityCount: entities.length };
  }
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        formatVersion: DATA_EXPORT_FORMAT_VERSION,
        epoch: begin.epoch,
        exportedAt: new Date().toISOString(),
        entities,
      },
      null,
      2,
    ),
    'utf-8',
  );
  return { saved: true, filePath, entityCount: entities.length };
}

/**
 * Reads a user-chosen export file and stages an import plan. The returned
 * `operationId` commits via `commitDataImport`; nothing applies at preview.
 */
export async function previewDataImportFromFile(): Promise<
  { canceled: true } | ({ canceled: false; fileName: string } & DataImportPreviewResult)
> {
  const { BrowserWindow, dialog } = await import('electron');
  const win = BrowserWindow.getAllWindows()[0];
  const picked = await dialog.showOpenDialog(win!, {
    title: 'Import account data',
    properties: ['openFile'],
    filters: [{ name: 'Anvil data export', extensions: ['json'] }],
  });
  const filePath = picked.filePaths[0];
  if (picked.canceled || !filePath) {
    return { canceled: true };
  }
  const { readFileSync } = await import('node:fs');
  const { basename } = await import('node:path');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record !== 'object' ||
    record === null ||
    record['formatVersion'] !== DATA_EXPORT_FORMAT_VERSION ||
    !Array.isArray(record['entities'])
  ) {
    throw new Error('That file is not an Anvil data export (unsupported format).');
  }
  const preview = await accountRpc<DataImportPreviewResult>('data.import.preview', {
    formatVersion: DATA_EXPORT_FORMAT_VERSION,
    entities: record['entities'],
  });
  return { canceled: false, fileName: basename(filePath), ...preview };
}

/** Applies a staged import plan from `data.import.preview`. */
export async function commitDataImport(operationId: string): Promise<DataImportCommitResult> {
  return accountRpc<DataImportCommitResult>('data.import.commit', { operationId });
}

// ---- Mesh session view (spec §18) -----------------------------------------
// Read/control surface for remote executions. All ops go through the same
// account-authenticated RPC path as device management; the observe channel
// delegates to mesh-observe's socket + durable-replay machinery.

export async function listMeshJobs(): Promise<JobSummary[]> {
  const result = await accountRpc<JobListResult>('job.list', { limit: 100 });
  return result.jobs;
}

export async function getMeshJob(jobId: string): Promise<JobGetResult> {
  return accountRpc<JobGetResult>('job.get', { jobId });
}

export async function cancelMeshJob(jobId: string): Promise<JobSummary> {
  const result = await accountRpc<JobCancelResult>('job.cancel', { jobId });
  return result.job;
}

export async function getMeshApprovals(jobId: string): Promise<ApprovalRecord[]> {
  const result = await accountRpc<ApprovalGetResult>('approval.get', { jobId });
  return result.approvals;
}

export async function decideMeshApproval(
  approvalId: string,
  decision: ApprovalDecision,
  reason?: string,
): Promise<ApprovalDecideResult> {
  return accountRpc<ApprovalDecideResult>('approval.decide', {
    approvalId,
    decision,
    ...(reason === undefined ? {} : { reason }),
  });
}

/**
 * Subscribes to an attempt's live + journaled activity. Returns the
 * unsubscribe — callers must pair it (the IPC layer scopes it per sender).
 */
export function observeAttemptActivity(attemptId: string, listener: AttemptObserver): () => void {
  return observeAttempt(attemptId, listener);
}

/**
 * Every handoff this device participated in, refreshed against the backend.
 * Journal rows give identity; `handoff.get` is authoritative for state.
 */
export async function listMeshHandoffs(): Promise<HandoffRecord[]> {
  const rows = getDb()
    .prepare('SELECT handoff_id FROM mesh_handoff_journal ORDER BY updated_at DESC')
    .all() as Array<{ handoff_id: string }>;
  const handoffs: HandoffRecord[] = [];
  for (const row of rows) {
    try {
      const result = await accountRpc<HandoffGetResult>('handoff.get', {
        handoffId: row.handoff_id,
      });
      handoffs.push(result.handoff);
    } catch {
      // Row may predate the current backend or be unreachable — skip it.
    }
  }
  return handoffs;
}

/** Ownership mirror + live handoff rows for one chat session. */
export async function getSessionMeshState(sessionId: string): Promise<SessionMeshState> {
  const ownership = readSessionOwnership(sessionId);
  const rows = getDb()
    .prepare(
      'SELECT handoff_id FROM mesh_handoff_journal WHERE session_id = ? ORDER BY updated_at DESC',
    )
    .all(sessionId) as Array<{ handoff_id: string }>;
  const handoffs: HandoffRecord[] = [];
  for (const row of rows) {
    try {
      const result = await accountRpc<HandoffGetResult>('handoff.get', {
        handoffId: row.handoff_id,
      });
      handoffs.push(result.handoff);
    } catch {
      // Skip unreachable rows — the journal remains the local record.
    }
  }
  return {
    ownership:
      ownership === null
        ? null
        : {
            state: ownership.state,
            generation: ownership.generation,
            ownerEnrollmentId: ownership.owner_enrollment_id,
          },
    handoffs,
  };
}

/**
 * Session handoff initiation (SESSION-03): readiness gate → durable reject →
 * quiesce → checkpoint → ownership CAS. Blockers surface for remediation.
 */
export async function initiateSessionHandoff(
  sessionId: string,
  targetEnrollmentId: string,
): Promise<InitiateHandoffResult> {
  return initiateHandoff({ sessionId, targetEnrollmentId });
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
    hosted: scope === null ? null : hostedStatusFor(scope.backendId, scope.accountId),
    lastError,
    lastPushAt: snapshot?.lastPushAt ?? null,
    lastPullAt: snapshot?.lastPullAt ?? null,
  };
}

// ---- BILL-05 hosted entitlement ------------------------------------------
// The hosted backend reports access through `session.describe`; self-host
// backends omit the field entirely. The persisted row gates sync *writes*
// only — pulls, conflicts, cursors, the outbox, and all control ops keep
// working — so a restricted account pauses resumably rather than losing work.

function hostedStatusFor(backendId: string, accountId: string): SyncHostedStatus | null {
  const row = getSyncEntitlement(backendId, accountId);
  if (row === null) return null;
  return {
    state: HOSTED_STATES.has(row.state) ? (row.state as SyncHostedStatus['state']) : 'unknown',
    source: row.source,
    planKey: row.planKey,
    previewEndsAt: row.previewEndsAt,
    accessUntil: row.accessUntil,
    graceUntil: row.graceUntil,
    checkedAt: row.checkedAt,
    reason: row.reason,
    restricted: row.restricted,
  };
}

/** The hosted view for the current scope; null when signed out or self-host. */
function currentHostedStatus(): SyncHostedStatus | null {
  const scope = currentScope();
  return scope === null ? null : hostedStatusFor(scope.backendId, scope.accountId);
}

/**
 * Persists the backend's reported entitlement. `entitlement === null` means
 * `session.describe` omitted the field — a self-host backend — so any stale
 * row is deleted rather than left gating. `restrictedReason` is set only on
 * the mid-flight 403 path, where no entitlement payload exists yet; it writes
 * a minimal restricted row that the immediately-fired describe refresh then
 * replaces with the authoritative record.
 */
function recordEntitlement(
  pair: { backendId: string; accountId: string },
  entitlement: HostedEntitlement | null,
  restrictedReason?: string,
): void {
  if (entitlement === null) {
    if (restrictedReason === undefined) {
      clearSyncEntitlement(pair.backendId, pair.accountId);
      return;
    }
    upsertSyncEntitlement({
      backendId: pair.backendId,
      accountId: pair.accountId,
      state: 'restricted',
      source: 'none',
      planKey: null,
      previewEndsAt: null,
      accessUntil: null,
      graceUntil: null,
      checkedAt: new Date().toISOString(),
      revision: 0,
      reason: restrictedReason,
      restricted: true,
    });
    return;
  }
  upsertSyncEntitlement({
    backendId: pair.backendId,
    accountId: pair.accountId,
    state: entitlement.state,
    source: entitlement.source,
    planKey: entitlement.planKey,
    previewEndsAt: entitlement.previewEndsAt,
    accessUntil: entitlement.accessUntil,
    graceUntil: entitlement.graceUntil,
    checkedAt: entitlement.checkedAt,
    revision: entitlement.revision,
    reason: entitlement.reason,
    // 'unknown' is not free access: while billing is unverifiable the backend
    // refuses mutating ops anyway, so the local write gate mirrors that pause.
    restricted: entitlement.state === 'restricted' || entitlement.state === 'unknown',
  });
}

/**
 * Re-reads hosted access from `session.describe` and persists it. Self-host
 * backends omit the field → the row is cleared. Failures keep the last-known
 * row: a status outage must not look like either paid access or lost access.
 * Returns the current renderer-safe view either way.
 */
export async function refreshHostedEntitlement(): Promise<SyncHostedStatus | null> {
  const backend = getActiveBackend() ?? pinnedBackend();
  const fields = auth?.getSessionScopeFields() ?? null;
  const token = auth?.getAccessToken() ?? null;
  if (
    backend === null ||
    fields === null ||
    token === null ||
    (fields.backendId !== null && fields.backendId !== backend.id)
  ) {
    return currentHostedStatus();
  }
  const generation = runtimeGeneration;
  lastHostedRefreshAt = Date.now();
  try {
    const { result } = await backendRpc<SessionDescribeResult>(
      { apiUrl: apiUrlFor(backend) },
      'session.describe',
      {},
      token,
      { fetchFn: fetchOverride },
    );
    if (generation === runtimeGeneration) {
      recordEntitlement(
        { backendId: backend.id, accountId: fields.accountId },
        result.entitlement ?? null,
      );
    }
  } catch {
    // Keep the last-known row; the next trigger retries.
  }
  return hostedStatusFor(backend.id, fields.accountId);
}

/** Throttled refresh for focus/reconnect triggers; skips when signed out. */
function maybeRefreshHostedEntitlement(): void {
  if (!isSyncEnabled()) return;
  if (Date.now() - lastHostedRefreshAt < HOSTED_REFRESH_MIN_INTERVAL_MS) return;
  void refreshHostedEntitlement().catch(() => undefined);
}

/**
 * Window-focus hook (index.ts wires every BrowserWindow 'focus' here):
 * returning from the hosted account page is how users come back after fixing
 * billing, so re-check `session.describe`. Throttled — and no payment state
 * is ever accepted from a URL; the backend remains the only source of truth.
 */
export function onAppFocus(): void {
  maybeRefreshHostedEntitlement();
}

/** Opens the fixed hosted account page in the system browser. */
export async function openHostedAccountPage(): Promise<void> {
  const { shell } = await import('electron');
  await shell.openExternal(HOSTED_ACCOUNT_URL);
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
      // Same describe payload keeps the hosted row fresh without an extra
      // call; an omitted field (self-host) clears it.
      const fields = auth?.getSessionScopeFields() ?? null;
      if (fields !== null && (fields.backendId === null || fields.backendId === backend.id)) {
        recordEntitlement(
          { backendId: backend.id, accountId: fields.accountId },
          result.result.entitlement ?? null,
        );
      }
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
      // BILL-05 write gate: a restricted hosted row pauses push/scan while
      // pull and control ops keep running. No row (self-host) means writes
      // are unrestricted.
      writeGate: () => ({
        allowed: getSyncEntitlement(scope.backendId, scope.accountId)?.restricted !== true,
      }),
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
    const hostedReason =
      error instanceof SyncEngineError && error.code === 'forbidden'
        ? error.details?.['reason']
        : undefined;
    if (typeof hostedReason === 'string' && HOSTED_DENIAL_REASONS.has(hostedReason)) {
      // Hosted-access refusal on a mutating op: persist the pause and refresh
      // the authoritative record best-effort. The cycle is paused, not failed
      // — the engine already ran the pull and left outbox rows, cursors, and
      // conflicts untouched, so this resolves quietly rather than surfacing
      // as a sync failure.
      recordEntitlement(
        { backendId: scope.backendId, accountId: scope.accountId },
        null,
        hostedReason,
      );
      lastError = null;
      void refreshHostedEntitlement().catch(() => undefined);
      return;
    }
    lastError = error instanceof Error ? error.message : String(error);
    if (error instanceof SyncEngineError && !error.retryable && error.code === 'unauthenticated') {
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
        maybeRefreshHostedEntitlement();
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
