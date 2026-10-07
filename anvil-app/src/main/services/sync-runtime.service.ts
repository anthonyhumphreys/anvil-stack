import type { RemoteCodexAccountAuthChoice } from '../../shared/remote-chat.js';
import { assertAnvilCloudAgentsEnabled } from './anvil-cloud-agents-availability.service.js';
import {
  configureRemoteChatContext,
  remoteChatOnReady,
  remoteChatOnGone,
  remoteChatOnHostEvent,
  remoteChatOnHostConnectivityChanged,
} from './remote-chat.service.js';
import { createHash, randomUUID } from 'node:crypto';
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
  EventPullParams,
  EventPullResult,
  JobCreateParams,
  JobCreateResult,
  JobCancelResult,
  JobGetResult,
  JobListResult,
  JobSummary,
} from '../../../cloud/contract/jobs.js';
import type { ActivityFrame } from '../../../cloud/contract/socket.js';
import type { HandoffGetResult, HandoffRecord } from '../../../cloud/contract/handoff.js';
import type {
  DashboardRequest,
  DashboardRequestsResult,
  KeyringReportResult,
} from '../../../cloud/contract/dashboard.js';
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandEnvelope,
  BrowserWorkspaceExecutionContext,
  DashboardCommandClaimResult,
  DashboardCommandCompleteResult,
} from '../../../cloud/contract/browser-workspace.js';
import {
  BROWSER_WORKSPACE_OPERATION_SCOPE,
  isBrowserWorkspaceOperation,
} from '../../../cloud/contract/browser-workspace.js';
import type { HostedEntitlement } from '../../../cloud/contract/entitlements.js';
import type {
  CloudEnvironment,
  EnvironmentResumeResult,
  EnvironmentListResult,
  EnvironmentLimitsResult,
  EnvironmentReapResult,
  EnvironmentSuspendResult,
} from '../../../cloud/contract/environment.js';
import type {
  ChatAttachmentInput,
  CarPlayNoteRequest,
  MobileSendChatMessageInput,
  MobileStartChatInput,
} from '../../shared/types.js';
import {
  requestEnvironment,
  addProviderConnection,
  listLocalEnvironments,
  listProviderConnections,
  removeProviderConnection,
  type ProvisionerScope,
  type ProviderConnectionSummary,
  type RequestEnvironmentInput,
  type RequestEnvironmentResult,
} from './cloud-environment.service.js';
import type {
  DeviceAdvertiseParams,
  DeviceAdvertiseResult,
  DevicePresenceResult,
  SessionAttestResult,
} from '../../../cloud/contract/companion.js';
import { PROFILES, PROTOCOL } from '../../../cloud/contract/version.js';
import { executeWithMeshHostCommandReceipt } from './mesh-host-command-receipts.service.js';
import {
  SPIKE_DATASET_EPOCH,
  type SyncAdoptionPreviewItem,
  type SyncAuthPublicSnapshot,
  type SyncConflictResolutionChoice,
  type SyncConflictView,
  type SyncDashboardGrantApproval,
  type SyncDashboardGrantDecisionResult,
  type SyncDashboardGrantWorkspace,
  type SessionMeshState,
  type SyncDashboardRequest,
  type SyncDiagnostics,
  type MeshWorkerStatus,
  type SyncHostedStatus,
  type SyncFairUseStatus,
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
  isWorkspaceSyncPaused,
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
  type WorkOSDeviceChallenge,
  type WorkOSDeviceEnrollParams,
} from './workos-device-auth.service.js';
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
  applyPausedWorkspaceChanges,
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
  notifyMeshWorkerAttemptEvent,
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
import {
  CRYPTO_ENTITY_DEVICE_IDENTITY,
  decodePairingPayload,
  isPairingPayloadString,
} from '../../../cloud/contract/sealed.js';
import { clearCompanionAuthCaches } from './companion-auth-cache.service.js';
import {
  taskKeyFor,
  unsealTaskResult,
  deriveSas,
  createDeviceIdentityBindingProof,
  deviceTrustState,
  ensureDeviceIdentity,
  listDeviceIdentities,
  listDeviceTrust,
  markRotationReported,
  mintPairingPayload,
  pendingRotationReports,
  publishDeviceIdentity,
  revocationsNeedingRotation,
  registerPairingRedemption,
  retryPendingKeyringWraps,
  rotateAccountKey,
  canProvisionAccountKey,
  clearAccountCrypto,
  hasAccountKey,
  invalidateRecoverySecret,
  provisionAccountKey,
  setAccountKeyBootstrapEligibility,
  setDeviceTrust,
  trustAuthenticatedDeviceIdentity,
  wrapAccountKeyFor,
  type DeviceTrustState,
} from './sync-keyring.service.js';
import {
  getDeviceSecurityStatus as orchestrateDeviceSecurityStatus,
  replaceDeviceRecovery as orchestrateReplaceDeviceRecovery,
  refreshDeviceRecovery as orchestrateRefreshDeviceRecovery,
  setNewDeviceTrustPolicy as orchestrateSetNewDeviceTrustPolicy,
  setupDeviceRecovery as orchestrateSetupDeviceRecovery,
  unlockDeviceRecovery as orchestrateUnlockDeviceRecovery,
  type SyncDeviceSecurityContext,
} from './sync-device-security.service.js';
import type {
  SyncDeviceRecoveryResult,
  SyncDeviceSecurityStatus,
  SyncDeviceTrustSource,
  SyncDeviceTrustPolicy,
  SyncEncryptedSyncAccountResetConfirmation,
} from '../../shared/sync-device-security.js';
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
  approveDashboardRequest,
  configureDashboardGrantContext,
  executeDashboardGrantMachineCommand,
  denyDashboardRequest,
  listDashboardGrantWorkspaces,
  listDashboardGrants,
  pumpBrowserWorkspaceCommands,
  dispatchDashboardGrantCommandQueue,
  revokeDashboardGrant,
  serviceDashboardGrants,
  type DashboardGrantRevalidation,
  type DashboardWorkspaceCommand,
} from './dashboard-grant.service.js';
import {
  configureMeshHostSessionBindings,
  publishMeshHostEvent,
  type MeshHostOperationInput,
} from './mesh-host-session.service.js';
import type { MeshHostAdmissionAuthorization } from './mesh-host-session.service.js';
import { fetchMeshMachineBrokerJson } from './mesh-host-client.service.js';
import { MeshHostRuntimePool, type MeshHostRuntimeContext } from './mesh-host-runtime.service.js';
import {
  configureMeshManagedEndpointLifecycle,
  isMeshManagedEndpointEnabled,
} from './mesh-managed-connector.service.js';
import { isMeshMachineEndpointEnabled } from './mesh-machine-endpoint.service.js';
import { getMeshMachineHostStatus } from './mesh-host-status.service.js';
import type { MeshMachineAdmissionConsumeResponse } from '../../../cloud/contract/machine.js';
import { MESH_MACHINE_OPERATIONS } from '../../../cloud/contract/machine.js';
import {
  disposeBrowserWorkspaceExecutor,
  executeBrowserWorkspaceCommand,
} from './browser-workspace-executor.service.js';
import {
  configureMeshIntegrationContext,
  resetMeshIntegrationForTests,
} from './mesh-integration.service.js';
import {
  clearSyncEntitlement,
  canonicalJson,
  getActiveEnrollment,
  getBinding,
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

/** Bounded catch-up when push is unavailable; healthy sockets do not poll. */
const FALLBACK_MIN_MS = 25_000;
const FALLBACK_MAX_MS = 35_000;
const SPIKE_ACCESS_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;
/** Refresh this far before the access token's stated expiry. */
const REFRESH_AHEAD_MS = 60_000;
const REFRESH_MIN_DELAY_MS = 5_000;
/** Slow, bounded retry while an authenticated device is waiting for its ADK. */
const KEYRING_ONBOARDING_MIN_MS = 45_000;
const KEYRING_ONBOARDING_MAX_MS = 5 * 60_000;

/**
 * BILL-05: the hosted account page origin is fixed — never derived from user
 * input, a backend descriptor, or a deep-link parameter. Returning from the
 * browser only re-triggers `session.describe`; no payment state is ever
 * accepted back through a URL.
 */
const HOSTED_SITE_ORIGIN = 'https://anvil.dev';
const HOSTED_ACCOUNT_URL = `${HOSTED_SITE_ORIGIN}/account`;
const HOSTED_ACCOUNT_URL_PROTOCOLS: ReadonlySet<string> = new Set(['https:', 'http:']);

/**
 * Resolves the hosted account destination without allowing an environment
 * variable to turn the system-browser action into an arbitrary URL opener.
 * HTTPS destinations are valid in all builds; plain HTTP is limited to
 * loopback during unpackaged development.
 */
export function resolveHostedAccountUrl(
  configured: string | undefined,
  isPackaged: boolean,
): string {
  const value = configured?.trim();
  if (!value) return HOSTED_ACCOUNT_URL;
  try {
    const url = new URL(value);
    if (!HOSTED_ACCOUNT_URL_PROTOCOLS.has(url.protocol)) return HOSTED_ACCOUNT_URL;
    if (url.username || url.password) return HOSTED_ACCOUNT_URL;
    if (url.protocol === 'https:') return url.href;
    if (
      !isPackaged &&
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    ) {
      return url.href;
    }
  } catch {
    // Fall through to the production default.
  }
  return HOSTED_ACCOUNT_URL;
}
/** Focus/reconnect refreshes are throttled so focus cycling can't spam it. */
const HOSTED_REFRESH_MIN_INTERVAL_MS = 60_000;
function isHostedWritePaused(row: { restricted: boolean; reason: string } | null): boolean {
  return row?.restricted === true;
}
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
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let keyringOnboardingTimer: ReturnType<typeof setTimeout> | null = null;
let keyringOnboardingAttempt = 0;
let keyringOnboardingRunning = false;
let lastKeyringOnboardingAttemptAt = 0;
let dashboardCommandPumpTimer: ReturnType<typeof setTimeout> | null = null;
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
let meshHostPool: MeshHostRuntimePool | null = null;
interface PendingPairingRedemption {
  backendId: string;
  accountId: string;
  pairing: { pairingNonce: string; pairingSecret: string };
}

/**
 * Enrollment can finish while the reviewed backend is still paused. The
 * normal path wraps the one-time pairing secret into sync_pairing immediately;
 * this transient fallback survives only until the next activation retry and
 * is never persisted alongside the session or sent through IPC.
 */
let pendingPairingRedemption: PendingPairingRedemption | null = null;
/**
 * Fences async engine work: bumped on every sign-out, enrollment change, and
 * backend switch. A sync cycle captures the generation (plus its scope and
 * token) and checks both before any durable write that follows an await, so a
 * callback from an old account/backend can never mutate new-scope state.
 */
let runtimeGeneration = 0;
/** Scope stays read-only until its post-revocation key rotation succeeds. */
let keyRotationBlockedScopeKey: string | null = null;
/** Timestamp of the last attempted session.describe entitlement refresh. */
let lastHostedRefreshAt = 0;
const deviceIdentityBindings = new Set<string>();
let lastFairUseStatus: {
  backendId: string;
  accountId: string;
  status: SyncFairUseStatus | null;
} | null = null;

type SyncSessionScopeFields = NonNullable<ReturnType<SyncAuthService['getSessionScopeFields']>>;

/** A saved credential is usable only at the exact backend that issued it. */
function sessionBoundToBackend(
  backend: SyncBackendRecord,
  fields: SyncSessionScopeFields | null = auth?.getSessionScopeFields() ?? null,
): boolean {
  return !backend.identityReviewRequired && fields !== null && fields.backendId === backend.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMeshMachineOperation(
  value: string,
): value is import('../../../cloud/contract/machine.js').MeshMachineOperation {
  return MESH_MACHINE_OPERATIONS.includes(value as (typeof MESH_MACHINE_OPERATIONS)[number]);
}

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

function syncLocalMeshHostListener(): void {
  void import('./mobile-companion.service.js')
    .then(({ syncMobileCompanionServer }) => syncMobileCompanionServer())
    .catch(() => undefined);
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
  meshHostPool?.stop();
  meshHostPool = new MeshHostRuntimePool(getMeshHostRuntimeContext);
  configureMeshHostSessionRuntimeBindings();
  configureMeshManagedEndpointLifecycle({
    context: () => {
      const context = currentHostSessionRpcContext();
      return context === null ? null : { apiUrl: context.apiUrl, accessToken: context.accessToken };
    },
    enabled: () => isMeshMachineEndpointEnabled() && isMeshManagedEndpointEnabled(),
    ...(fetchOverride === undefined ? {} : { fetch: fetchOverride }),
  });
  syncLocalMeshHostListener();
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
    if (
      backend === null ||
      fields === null ||
      token === null ||
      !sessionBoundToBackend(backend, fields)
    )
      return null;
    return {
      apiUrl: apiUrlFor(backend),
      backendUrl: backend.baseUrl,
      accessToken: token,
      enrollmentId: fields.enrollmentId,
      ...(scope === null ? {} : { scope }),
      ...(runtimeUserDataDir === null ? {} : { userDataDir: runtimeUserDataDir }),
      sendFrame: (frame) => {
        if (isMeshActivityFrame(frame)) {
          const deliveredByHost = publishLocalMeshActivity(frame, scope);
          if (!deliveredByHost) liveSocket?.send(JSON.stringify(frame));
          return;
        }
        liveSocket?.send(JSON.stringify(frame));
      },
      publishAttemptLifecycle: (input) => publishLocalMeshAttemptLifecycle(input, scope),
      isLive: () => liveState === 'live' && liveSocket !== null,
      mintEnvironmentCode: async (options) => {
        const issued = await issueEnrollmentCode({
          enrollmentClass: 'ephemeral',
          provider: options.provider,
          sessionTtlSeconds: options.ttlSeconds,
          displayName: options.displayName,
          environmentId: options.environmentId,
        });
        // Authentication-only: the code is the whole bootstrap secret.
        return issued.code;
      },
    };
  });
  // MESH-03: the observer shares the same session context and live socket.
  configureMeshObserverContext(() => {
    const backend = getActiveBackend();
    const fields = auth?.getSessionScopeFields() ?? null;
    const token = auth?.getAccessToken() ?? null;
    if (
      backend === null ||
      fields === null ||
      token === null ||
      !sessionBoundToBackend(backend, fields)
    )
      return null;
    return {
      apiUrl: apiUrlFor(backend),
      backendUrl: backend.baseUrl,
      accessToken: token,
      enrollmentId: fields.enrollmentId,
      sendFrame: (frame) => liveSocket?.send(JSON.stringify(frame)),
      isLive: () => liveState === 'live',
    };
  });
  configureMeshArtifactContext(() => {
    const backend = getActiveBackend();
    const fields = auth?.getSessionScopeFields() ?? null;
    const token = auth?.getAccessToken() ?? null;
    const scope = currentScope();
    if (backend === null || token === null || !sessionBoundToBackend(backend, fields)) return null;
    return {
      apiUrl: apiUrlFor(backend),
      accessToken: token,
      ...(scope === null ? {} : { scope }),
    };
  });
  // Hosted artifact sharing: same session context; user-actor share.* ops.
  configureArtifactShareContext(() => {
    const backend = getActiveBackend();
    const fields = auth?.getSessionScopeFields() ?? null;
    const token = auth?.getAccessToken() ?? null;
    if (backend === null || token === null || !sessionBoundToBackend(backend, fields)) return null;
    return { apiUrl: apiUrlFor(backend), accessToken: token };
  });
  // SESSION-03: handoff orchestration reads the same session context; the
  // local ownership mirror must be reconciled before any session resumes.
  configureMeshHandoffContext(() => {
    const backend = getActiveBackend();
    const fields = auth?.getSessionScopeFields() ?? null;
    const token = auth?.getAccessToken() ?? null;
    const scope = currentScope();
    if (
      backend === null ||
      fields === null ||
      token === null ||
      !sessionBoundToBackend(backend, fields)
    )
      return null;
    return {
      apiUrl: apiUrlFor(backend),
      backendUrl: backend.baseUrl,
      accessToken: token,
      enrollmentId: fields.enrollmentId,
      ...(scope === null ? {} : { scope }),
    };
  });
  configureRemoteChatContext(() => {
    const backend = getActiveBackend();
    const fields = auth?.getSessionScopeFields() ?? null;
    const token = auth?.getAccessToken() ?? null;
    const scope = currentScope();
    if (
      backend === null ||
      fields === null ||
      token === null ||
      scope === null ||
      !sessionBoundToBackend(backend, fields)
    )
      return null;
    return {
      apiUrl: apiUrlFor(backend),
      accessToken: token,
      enrollmentId: fields.enrollmentId,
      scope,
      readHostJob: async (targetEnrollmentId, jobId) => {
        const result = await meshHostPool?.request<JobGetResult>(targetEnrollmentId, 'read.job', {
          jobId,
        });
        return result?.job?.id === jobId ? result : null;
      },
      hasHealthyHostPush: (targetEnrollmentId) =>
        meshHostPool?.hasHealthyPush(targetEnrollmentId) === true,
      retainHost: (targetEnrollmentId) =>
        meshHostPool?.retain(targetEnrollmentId) ?? (() => undefined),
      requestHostedEnvironment: async ({ environmentId, displayName, purpose }) => {
        const limits = await getManagedEnvironmentLimits();
        const result = await requestCloudEnvironment({
          provider: 'anvil-managed',
          ttlSeconds: limits.maxTtlSeconds,
          environmentId,
          displayName,
          ...(purpose === 'remote-chat' ? { hostedRemoteChat: true } : {}),
        });
        return { job: result.job };
      },
      listHostedEnvironments: () => listCloudEnvironments(true),
      reapHostedEnvironment: (environmentId) => reapCloudEnvironment(environmentId),
      suspendHostedEnvironment: (environmentId) => suspendCloudEnvironment(environmentId),
      resumeHostedEnvironment: (environmentId) => resumeCloudEnvironment(environmentId),
    };
  });
  // FLOW-02: node dispatches are source-side; same session context, and
  // boot reconciliation re-adopts persisted jobs (never recreates them).
  configureMeshDispatchContext(() => {
    const backend = getActiveBackend();
    const fields = auth?.getSessionScopeFields() ?? null;
    const token = auth?.getAccessToken() ?? null;
    const scope = currentScope();
    if (
      backend === null ||
      fields === null ||
      token === null ||
      !sessionBoundToBackend(backend, fields)
    )
      return null;
    return {
      apiUrl: apiUrlFor(backend),
      accessToken: token,
      enrollmentId: fields.enrollmentId,
      ...(scope === null ? {} : { scope }),
      mintEnvironmentCode: async (options) => {
        const issued = await issueEnrollmentCode({
          enrollmentClass: 'ephemeral',
          provider: options.provider,
          sessionTtlSeconds: options.ttlSeconds,
          displayName: options.displayName,
          environmentId: options.environmentId,
        });
        return issued.code;
      },
    };
  });
  // DASH-01: the dashboard grant service shares the session context — it
  // is the trusted-device side of browser authorization.
  configureDashboardGrantContext(() => {
    const backend = getActiveBackend();
    const fields = auth?.getSessionScopeFields() ?? null;
    const token = auth?.getAccessToken() ?? null;
    const scope = currentScope();
    if (
      backend === null ||
      fields === null ||
      token === null ||
      scope === null ||
      !sessionBoundToBackend(backend, fields)
    )
      return null;
    const apiUrl = apiUrlFor(backend);
    const rpcOptions = fetchOverride === undefined ? {} : { fetchFn: fetchOverride };
    return {
      apiUrl,
      accessToken: token,
      enrollmentId: fields.enrollmentId,
      pullBrowserWorkspaceCommands: async (
        commandScope,
        enrollmentId,
      ): Promise<DashboardWorkspaceCommand[]> => {
        const grants = listDashboardGrants(commandScope).filter(
          (grant) =>
            grant.state === 'approved' &&
            grant.enrollmentId === enrollmentId &&
            grant.workspace !== null &&
            Date.parse(grant.expiresAt) > Date.now(),
        );
        const claimed: DashboardWorkspaceCommand[] = [];
        let remaining = 8;
        for (const grant of grants) {
          if (remaining <= 0) break;
          try {
            const response = await backendRpc<DashboardCommandClaimResult>(
              { apiUrl },
              'dashboard.command.claim',
              { requestId: grant.requestId, limit: remaining },
              token,
              rpcOptions,
            );
            for (const command of response.result.commands) {
              claimed.push({ ...command.envelope, claimFence: command.claimFence });
            }
            remaining -= response.result.commands.length;
          } catch {
            // The relay is authoritative for revoke/expiry/issuer checks. A
            // stale local mirror must never turn a failed claim into work.
          }
        }
        return claimed;
      },
      revalidateBrowserWorkspaceGrant: async (
        commandScope,
        requestId,
      ): Promise<DashboardGrantRevalidation> => {
        const response = await backendRpc<DashboardRequestsResult & { request?: DashboardRequest }>(
          { apiUrl },
          'dashboard.requests',
          { requestId },
          token,
          rpcOptions,
        );
        // The relay status extension returns `request` for an issuer-bound
        // lookup. Keep the list fallback for deployments that return the
        // matching record in a bounded result instead.
        const request =
          response.result.request ??
          response.result.requests.find((candidate) => candidate.requestId === requestId);
        if (request === undefined) {
          throw new Error('The relay did not return the live dashboard grant state.');
        }
        const binding =
          request.workspaceBindings?.find(
            (candidate) =>
              candidate.workspaceId ===
              listDashboardGrants(commandScope).find((grant) => grant.requestId === requestId)
                ?.workspace?.workspaceId,
          ) ?? request.workspaceBindings?.[0];
        return {
          state: request.state,
          expiresAt: request.expiresAt,
          enrollmentId: request.decidedBy ?? '',
          workspace: {
            workspaceId: binding?.workspaceId ?? '',
            repoIds: binding?.repositoryIds ?? [],
          },
          scopes: request.grantedScopes ?? [],
          ...(request.trustId === undefined ? {} : { trustId: request.trustId }),
        };
      },
      publishBrowserWorkspaceCommandResult: async (
        _commandScope,
        command,
        result,
      ): Promise<void> => {
        if (result.status === 'uncertain' || result.status === 'rejected') return;
        if (command.claimFence === undefined || result.resultEnvelope === undefined) {
          throw new Error('A claimed command result is missing its fence or sealed envelope.');
        }
        await backendRpc<DashboardCommandCompleteResult>(
          { apiUrl },
          'dashboard.command.complete',
          {
            requestId: command.requestId,
            commandId: command.commandId,
            claimFence: command.claimFence,
            outcome: result.status === 'completed' ? 'completed' : 'failed',
            result: result.resultEnvelope,
          },
          token,
          rpcOptions,
        );
      },
      executeBrowserWorkspaceCommand: async (input) => {
        const payload =
          typeof input.payload === 'object' &&
          input.payload !== null &&
          !Array.isArray(input.payload)
            ? (input.payload as Record<string, unknown>)
            : {};
        const command = {
          ...payload,
          operation: input.operation,
          ...(input.repositoryId === null ? {} : { repositoryId: input.repositoryId }),
        } as BrowserWorkspaceCommand;
        const executionContext: BrowserWorkspaceExecutionContext = {
          grantId: input.requestId,
          workspaceId: input.workspaceId,
          repoIds: input.repoIds,
          scopes: input.scopes as BrowserWorkspaceExecutionContext['scopes'],
          ...(input.trustId === undefined ? {} : { trustId: input.trustId }),
          expiresAt: Date.parse(input.expiresAt),
          commandId: input.commandId,
        };
        return executeBrowserWorkspaceCommand(command, executionContext);
      },
    };
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
    ensureCurrentEnrollment();
    meshHostPool.start();
    connectLiveChannel();
    armFallbackPoll();
    armDashboardCommandPump();
    meshWorkerOnSyncReady();
    remoteChatOnReady();
    startHandoffRecovery();
    void reconcileHandoffsWhenReady().catch((error: unknown) => {
      console.warn('[Sync] Handoff recovery will retry on reconnect:', error);
    });
    // BILL-05: pick up any hosted-access change made while the app was off.
    maybeRefreshHostedEntitlement();
    void requestSync().catch(() => {
      // Last error is stored on the runtime snapshot.
    });
  } else if (auth.getPublicSnapshot().state === 'signed-in') {
    ensureCurrentEnrollment();
    startKeyringOnboardingPoll();
  }
}

function getMeshHostRuntimeContext(): MeshHostRuntimeContext | null {
  const backend = getActiveBackend();
  const fields = auth?.getSessionScopeFields() ?? null;
  const token = auth?.getAccessToken() ?? null;
  if (
    !isSyncEnabled() ||
    backend === null ||
    fields === null ||
    token === null ||
    !sessionBoundToBackend(backend, fields)
  ) {
    return null;
  }
  return {
    apiUrl: apiUrlFor(backend),
    accessToken: token,
    accountId: fields.accountId,
    enrollmentId: fields.enrollmentId,
    ...(fetchOverride === undefined ? {} : { fetchFn: fetchOverride }),
    onEvent: (event) => {
      const payload = event.payload;
      if (event.eventKind === 'activity') {
        const frame = meshActivityFrameFromHostEvent(payload);
        if (frame !== null) {
          notifyMeshWorkerAttemptEvent(frame.attemptId);
          handleActivityFrame(frame);
        }
      }
      remoteChatOnHostEvent(event);
    },
    onResnapshotRequired: () => remoteChatOnHostEvent(),
    onConnectivityChanged: () => {
      remoteChatOnHostConnectivityChanged();
      armDashboardCommandPump();
    },
  };
}

function configureMeshHostSessionRuntimeBindings(): void {
  configureMeshHostSessionBindings({
    consumeAdmissionTicket: async (ticket) => {
      const context = currentHostSessionRpcContext();
      if (context === null) throw new Error('Mesh admission is unavailable.');
      const result = await fetchMeshMachineBrokerJson({
        apiUrl: context.apiUrl,
        accessToken: context.accessToken,
        path: 'mesh/admission-tickets/consume',
        method: 'POST',
        body: { ticket },
        ...(fetchOverride === undefined ? {} : { fetchFn: fetchOverride }),
      });
      if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        throw new Error('Mesh admission response is malformed.');
      }
      return result as MeshMachineAdmissionConsumeResponse;
    },
    authorizeAdmission: async (claims): Promise<MeshHostAdmissionAuthorization> => {
      const context = currentHostSessionRpcContext();
      if (
        context === null ||
        claims.accountId !== context.accountId ||
        claims.hostEnrollmentId !== context.enrollmentId ||
        claims.principal.sourceEnrollmentId === context.enrollmentId
      ) {
        return { state: 'unavailable' };
      }
      try {
        const { ensureMeshCompanionEnrollmentPolicy } =
          await import('./mobile-companion.service.js');
        const policy = ensureMeshCompanionEnrollmentPolicy(
          claims.principal.sourceEnrollmentId,
          context.accountId,
        );
        if (policy.state !== 'authorized') return policy;
        return {
          state: 'authorized',
          principal: {
            kind: 'enrollment',
            accountId: context.accountId,
            sourceEnrollmentId: claims.principal.sourceEnrollmentId,
            tier: policy.tier,
          },
        };
      } catch {
        return { state: 'unavailable' };
      }
    },
    revalidateAdmission: async (claims) => {
      const context = currentHostSessionRpcContext();
      if (
        context === null ||
        claims.accountId !== context.accountId ||
        claims.hostEnrollmentId !== context.enrollmentId
      ) {
        return { authorized: false, validUntil: '' };
      }
      try {
        const result = await fetchMeshMachineBrokerJson({
          apiUrl: context.apiUrl,
          accessToken: context.accessToken,
          path: `mesh/hosts/${encodeURIComponent(claims.hostMachineId)}/sessions/revalidate`,
          method: 'POST',
          body: {
            sourceEnrollmentId: claims.principal.sourceEnrollmentId,
            endpointGeneration: claims.endpointGeneration,
          },
          ...(fetchOverride === undefined ? {} : { fetchFn: fetchOverride }),
        });
        if (
          typeof result !== 'object' ||
          result === null ||
          Array.isArray(result) ||
          typeof (result as Record<string, unknown>)['authorized'] !== 'boolean' ||
          typeof (result as Record<string, unknown>)['validUntil'] !== 'string'
        ) {
          return { authorized: false, validUntil: '' };
        }
        return {
          authorized: (result as { authorized: boolean }).authorized,
          validUntil: (result as { validUntil: string }).validUntil,
        };
      } catch {
        return { authorized: false, validUntil: '' };
      }
    },
    dispatchOperation: dispatchMeshHostOperation,
  });
}

function currentHostSessionRpcContext(): {
  apiUrl: string;
  accessToken: string;
  accountId: string;
  enrollmentId: string;
  scope: SyncScope;
} | null {
  const backend = getActiveBackend();
  const fields = auth?.getSessionScopeFields() ?? null;
  const accessToken = auth?.getAccessToken() ?? null;
  const scope = currentScope();
  if (
    backend === null ||
    fields === null ||
    accessToken === null ||
    scope === null ||
    !sessionBoundToBackend(backend, fields) ||
    scope.accountId !== fields.accountId ||
    scope.backendId !== backend.id
  ) {
    return null;
  }
  return {
    apiUrl: apiUrlFor(backend),
    accessToken,
    accountId: fields.accountId,
    enrollmentId: fields.enrollmentId,
    scope,
  };
}

async function dispatchMeshHostOperation(input: MeshHostOperationInput): Promise<unknown> {
  const context = currentHostSessionRpcContext();
  if (context === null || input.principal.accountId !== context.accountId) {
    throw new Error('Mesh host session is no longer authorized.');
  }
  return dispatchMeshHostOperationIdempotently(input, context.scope);
}

function dispatchMeshHostOperationIdempotently(
  input: MeshHostOperationInput,
  scope: SyncScope,
): Promise<unknown> {
  if (!isNativeMeshMutation(input)) {
    return dispatchMeshHostOperationOnce(input, scope);
  }
  const principalId =
    input.principal.kind === 'enrollment'
      ? input.principal.sourceEnrollmentId
      : input.principal.grantId;
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        operation: input.operation,
        payload: input.payload,
      }),
    )
    .digest('hex');
  return executeWithMeshHostCommandReceipt({
    scope,
    principalId,
    requestId: input.requestId,
    operation: input.operation,
    payloadHash: digest,
    execute: () => dispatchMeshHostOperationOnce(input, scope),
  });
}

function isNativeMeshMutation(input: MeshHostOperationInput): boolean {
  const payload = input.payload;
  if (
    isBrowserWorkspaceOperation(input.operation) ||
    input.operation === 'dashboard.command.wake'
  ) {
    return false;
  }
  if (input.operation === 'command.submit') {
    return (
      isRecord(payload) &&
      !('requestedTarget' in payload) &&
      [
        'actionId',
        'message',
        'title',
        'personaId',
        'workspaceId',
        'repoIds',
        'batchId',
        'attachmentIds',
        'attachments',
        'fileMentions',
      ].some((field) => field in payload)
    );
  }
  if (input.operation === 'command.approve') {
    return isRecord(payload) && typeof payload['sessionId'] === 'string';
  }
  if (input.operation === 'command.cancel') {
    return isRecord(payload) && typeof payload['sessionId'] === 'string';
  }
  return (
    input.operation === 'command.steer' ||
    input.operation === 'command.prepare-attachments' ||
    input.operation === 'command.open-desktop' ||
    input.operation === 'command.attachment.begin' ||
    input.operation === 'command.attachment.chunk' ||
    input.operation === 'command.attachment.finish' ||
    input.operation === 'command.carplay-pause' ||
    input.operation === 'command.carplay-pause-all' ||
    input.operation === 'command.carplay-approval' ||
    input.operation === 'command.carplay-note' ||
    input.operation === 'command.carplay-handover'
  );
}

async function dispatchMeshHostOperationOnce(
  input: MeshHostOperationInput,
  scope: SyncScope,
): Promise<unknown> {
  if (!isMeshMachineOperation(input.operation)) {
    throw new Error('Unsupported Mesh host operation.');
  }
  const payload = input.payload;
  if (input.operation === 'read.snapshot') {
    const workspaceId =
      isRecord(payload) && typeof payload['workspaceId'] === 'string'
        ? payload['workspaceId']
        : undefined;
    if (input.principal.kind === 'dashboard') {
      if (workspaceId === undefined || !input.scope.workspaceIds.includes(workspaceId)) {
        throw new Error('Dashboard snapshots require one explicitly granted workspace.');
      }
    }
    const { getMeshCompanionOverview } = await import('./mobile-companion.service.js');
    const overview = getMeshCompanionOverview(workspaceId);
    if (input.principal.kind !== 'dashboard') return overview;
    const scopedWorkspaceId = workspaceId;
    if (scopedWorkspaceId === undefined) throw new Error('Dashboard workspace is required.');
    if (overview.activeWorkspace?.id !== scopedWorkspaceId) {
      throw new Error('The granted dashboard workspace is no longer available.');
    }
    const allowed = new Set(input.scope.workspaceIds);
    return {
      generatedAt: overview.generatedAt,
      activeWorkspace: overview.activeWorkspace,
      workspaces: overview.workspaces.filter((workspace) => allowed.has(workspace.id)),
      activeSessions: overview.activeSessions.filter(
        (session) => session.workspaceId === scopedWorkspaceId,
      ),
      pendingApprovals: overview.pendingApprovals.filter(
        (approval) => approval.workspaceId !== undefined && allowed.has(approval.workspaceId),
      ),
      threads: overview.threads.filter(
        (thread) => thread.workspaceId !== undefined && allowed.has(thread.workspaceId),
      ),
      recentRuns: overview.recentRuns.filter((run) => run.workspaceId === scopedWorkspaceId),
      workspaceHealth: overview.workspaceHealth,
      workItems: overview.workItems,
      ...(overview.currentIterationPath === undefined
        ? {}
        : { currentIterationPath: overview.currentIterationPath }),
    };
  }
  if (input.operation === 'read.job') {
    if (!isRecord(payload) || typeof payload['jobId'] !== 'string') {
      throw new Error('read.job requires a jobId.');
    }
    const result = await accountRpc<JobGetResult>('job.get', { jobId: payload['jobId'] });
    assertMeshReadWorkspace(input, result.job.inputManifest.inputs['workspaceId']);
    return result;
  }
  if (input.operation === 'read.events') {
    if (!isRecord(payload) || typeof payload['scope'] !== 'string') {
      throw new Error('read.events requires an event scope.');
    }
    const result = await accountRpc<EventPullResult>(
      'event.pull',
      payload as unknown as EventPullParams,
    );
    if (input.principal.kind === 'dashboard') {
      const job = await accountRpc<JobGetResult>('job.get', { jobId: result.jobId });
      assertMeshReadWorkspace(input, job.job.inputManifest.inputs['workspaceId']);
    }
    return result;
  }

  if (input.operation.startsWith('read.')) {
    requireMeshEnrollmentPrincipal(input);
    const companion = await import('./mobile-companion.service.js');
    if (input.operation === 'read.chat-threads') {
      if (
        isRecord(payload) &&
        payload['workspaceId'] !== undefined &&
        typeof payload['workspaceId'] !== 'string'
      ) {
        throw new Error('read.chat-threads workspace id is invalid.');
      }
      const workspaceId =
        isRecord(payload) && typeof payload['workspaceId'] === 'string'
          ? payload['workspaceId']
          : undefined;
      assertMeshWorkspaceAccess(input, workspaceId);
      const threads = companion.listMeshCompanionChatThreads(workspaceId);
      return input.scope.workspaceIds.length === 0 || workspaceId !== undefined
        ? threads
        : threads.filter((thread) => input.scope.workspaceIds.includes(thread.workspaceId ?? ''));
    }
    if (input.operation === 'read.thread-history') {
      if (!isRecord(payload) || typeof payload['threadId'] !== 'string') {
        throw new Error('read.thread-history requires a thread id.');
      }
      const access = companion.getMeshCompanionThreadAccess(payload['threadId']);
      if (access === null) throw new Error('Chat thread is no longer available.');
      assertMeshWorkspaceAccess(input, access.workspaceId);
      if (
        input.scope.repositoryIds.length > 0 &&
        access.repoIds.some((repoId) => !input.scope.repositoryIds.includes(repoId))
      ) {
        throw new Error('Thread history is outside the Mesh repository scope.');
      }
      return companion.readMeshCompanionThreadHistory(payload['threadId']);
    }
    if (input.operation === 'read.workspace-signal-detail') {
      if (!isRecord(payload) || typeof payload['signalId'] !== 'string') {
        throw new Error('read.workspace-signal-detail requires a signal id.');
      }
      const detail = companion.readMeshCompanionWorkspaceSignal(payload['signalId']);
      if (detail === null) return null;
      const allowedWorkspaceIds = input.scope.workspaceIds;
      if (allowedWorkspaceIds.length > 0) {
        const visible = allowedWorkspaceIds.some((workspaceId) =>
          companion
            .getMobileOverview(workspaceId)
            .workspaceHealth.signals.some((signal) => signal.id === payload['signalId']),
        );
        if (!visible) throw new Error('Workspace signal is outside the Mesh workspace scope.');
      }
      return detail;
    }
    if (input.operation === 'read.chat-skills') {
      const query =
        isRecord(payload) && typeof payload['query'] === 'string' ? payload['query'] : '';
      return companion.getMeshCompanionChatSkills(query);
    }
    if (input.operation === 'read.file-mentions') {
      if (
        !isRecord(payload) ||
        !Array.isArray(payload['repoIds']) ||
        payload['repoIds'].some((repoId) => typeof repoId !== 'string')
      ) {
        throw new Error('read.file-mentions requires repository ids.');
      }
      const repoIds = payload['repoIds'] as string[];
      if (
        input.scope.repositoryIds.length > 0 &&
        repoIds.some((repoId) => !input.scope.repositoryIds.includes(repoId))
      ) {
        throw new Error('File mention search is outside the Mesh repository scope.');
      }
      return companion.searchMeshCompanionFileMentions({
        repoIds,
        ...(typeof payload['query'] === 'string' ? { query: payload['query'] } : {}),
        ...(typeof payload['limit'] === 'number' ? { limit: payload['limit'] } : {}),
      });
    }
    if (input.operation === 'read.attachment') {
      if (
        !isRecord(payload) ||
        typeof payload['attachmentId'] !== 'string' ||
        typeof payload['offset'] !== 'number' ||
        typeof payload['byteLength'] !== 'number'
      ) {
        throw new Error('read.attachment requires an attachment id and bounded byte range.');
      }
      if (input.scope.workspaceIds.length > 0) {
        const accesses = companion.getMeshCompanionAttachmentThreadAccess(payload['attachmentId']);
        const visible = accesses.some(
          (access) =>
            access.workspaceId !== undefined &&
            input.scope.workspaceIds.includes(access.workspaceId) &&
            (input.scope.repositoryIds.length === 0 ||
              access.repoIds.every((repoId) => input.scope.repositoryIds.includes(repoId))),
        );
        if (!visible) throw new Error('Attachment is outside the Mesh workspace scope.');
      }
      return companion.readMeshCompanionAttachmentChunk({
        attachmentId: payload['attachmentId'],
        offset: payload['offset'],
        byteLength: payload['byteLength'],
      });
    }
    if (input.operation === 'read.carplay-snapshot') {
      return companion.getMeshCarPlaySnapshot();
    }
    if (input.operation === 'read.carplay-approval') {
      if (!isRecord(payload) || typeof payload['approvalId'] !== 'string') {
        throw new Error('read.carplay-approval requires an approval id.');
      }
      return companion.getMeshCarPlayApproval(payload['approvalId']);
    }
  }

  if (isBrowserWorkspaceOperation(input.operation)) {
    if (input.principal.kind !== 'dashboard' || !isBrowserWorkspaceCommandEnvelope(payload)) {
      throw new Error('Browser workspace commands require a matching dashboard grant envelope.');
    }
    if (payload.operation !== input.operation || payload.requestId !== input.principal.grantId) {
      throw new Error('Browser workspace command does not match the selected operation or grant.');
    }
    return executeDashboardGrantMachineCommand(scope, input.principal.grantId, payload);
  }
  if (input.operation === 'dashboard.command.wake') {
    if (
      input.principal.kind !== 'dashboard' ||
      !isRecord(payload) ||
      payload['requestId'] !== input.principal.grantId
    ) {
      throw new Error('Dashboard command wake requires its exact grant id.');
    }
    return dispatchDashboardGrantCommandQueue(scope, input.principal.grantId);
  }
  if (input.operation === 'command.submit') {
    if (input.principal.kind === 'dashboard' && isBrowserWorkspaceCommandEnvelope(payload)) {
      assertDashboardCommandScope(input.scope, payload, 'submit-task');
      return executeDashboardGrantMachineCommand(scope, input.principal.grantId, payload);
    }
    if (isRecord(payload) && !('requestedTarget' in payload)) {
      requireMeshEnrollmentPrincipal(input, 'steer');
      const mobileInput = omitMeshAttachmentClaim(payload) as MobileStartChatInput;
      assertMobileWorkflowScope(input, mobileInput);
      if (mobileInput.attachments?.some((attachment) => attachment.path !== undefined)) {
        throw new Error('Mesh workflow attachments must use encrypted upload references.');
      }
      const { claimedAttachments, batchId } = await claimMeshCompanionAttachments(input, payload);
      const companion = await import('./mobile-companion.service.js');
      const fileAttachments = await resolveMeshFileMentions(
        input,
        payload,
        mobileInput.workspaceId,
      );
      const result = await companion.startMeshCompanionWorkflow(mobileInput, [
        ...claimedAttachments,
        ...fileAttachments,
      ]);
      return { ...result, ...(batchId === undefined ? {} : { batchId }) };
    }
    if (
      !isRecord(payload) ||
      payload['requestId'] !== input.requestId ||
      typeof payload['payloadHash'] !== 'string' ||
      !isRecord(payload['requestedTarget']) ||
      payload['requestedTarget']['kind'] !== 'device' ||
      payload['requestedTarget']['enrollmentId'] !== currentHostSessionRpcContext()?.enrollmentId
    ) {
      throw new Error('command.submit must target this host with its durable request id.');
    }
    requireMeshEnrollmentPrincipal(input, 'steer');
    payload['workspaceId'] = requireMeshWorkspaceForMutation(
      input,
      typeof payload['workspaceId'] === 'string' ? payload['workspaceId'] : undefined,
    );
    return accountRpc<JobCreateResult>('job.create', payload as unknown as JobCreateParams);
  }
  if (input.operation === 'command.approve') {
    if (input.principal.kind === 'dashboard' && isBrowserWorkspaceCommandEnvelope(payload)) {
      assertDashboardCommandScope(input.scope, payload, 'approve-action');
      return executeDashboardGrantMachineCommand(scope, input.principal.grantId, payload);
    }
    if (
      isRecord(payload) &&
      typeof payload['sessionId'] === 'string' &&
      typeof payload['requestKey'] === 'string' &&
      (payload['decision'] === 'accept' ||
        payload['decision'] === 'acceptForSession' ||
        payload['decision'] === 'decline' ||
        payload['decision'] === 'cancel')
    ) {
      requireMeshEnrollmentPrincipal(input, 'approve');
      const { resolveMeshCompanionApproval } = await import('./mobile-companion.service.js');
      return resolveMeshCompanionApproval(
        payload['sessionId'],
        payload['requestKey'],
        payload['decision'],
        typeof payload['optionId'] === 'string' ? payload['optionId'] : undefined,
      );
    }
    if (
      !isRecord(payload) ||
      typeof payload['approvalId'] !== 'string' ||
      (payload['decision'] !== 'approved' && payload['decision'] !== 'denied')
    ) {
      throw new Error('command.approve requires a decision for one approval.');
    }
    requireMeshEnrollmentPrincipal(input, 'approve');
    const approval = await accountRpc<ApprovalGetResult>('approval.get', {
      approvalId: payload['approvalId'],
    });
    const targetApproval = approval.approvals.find(
      (candidate) => candidate.id === payload['approvalId'],
    );
    if (targetApproval === undefined) throw new Error('Approval is no longer available.');
    await assertMeshJobTargetsThisHost(targetApproval.jobId);
    return accountRpc<ApprovalDecideResult>('approval.decide', {
      approvalId: payload['approvalId'],
      decision: payload['decision'],
      ...(typeof payload['reason'] === 'string' ? { reason: payload['reason'] } : {}),
    });
  }
  if (input.operation === 'command.cancel') {
    if (input.principal.kind === 'dashboard' && isBrowserWorkspaceCommandEnvelope(payload)) {
      assertDashboardCommandScope(input.scope, payload, 'submit-task');
      return executeDashboardGrantMachineCommand(scope, input.principal.grantId, payload);
    }
    if (isRecord(payload) && typeof payload['sessionId'] === 'string') {
      requireMeshEnrollmentPrincipal(input, 'steer');
      const { interruptMeshCompanionSession } = await import('./mobile-companion.service.js');
      return interruptMeshCompanionSession(payload['sessionId']);
    }
    if (!isRecord(payload) || typeof payload['jobId'] !== 'string') {
      throw new Error('command.cancel requires a job id.');
    }
    requireMeshEnrollmentPrincipal(input, 'steer');
    await assertMeshJobTargetsThisHost(payload['jobId']);
    return accountRpc<JobCancelResult>('job.cancel', { jobId: payload['jobId'] });
  }
  if (input.operation === 'command.steer') {
    if (input.principal.kind === 'dashboard' && isBrowserWorkspaceCommandEnvelope(payload)) {
      assertDashboardCommandScope(input.scope, payload, 'workspace-write');
      return executeDashboardGrantMachineCommand(scope, input.principal.grantId, payload);
    }
    if (
      !isRecord(payload) ||
      typeof payload['sessionId'] !== 'string' ||
      typeof payload['message'] !== 'string' ||
      payload['message'].length === 0 ||
      payload['message'].length > 32_000
    ) {
      throw new Error('command.steer requires a bounded message and local session id.');
    }
    requireMeshEnrollmentPrincipal(input, 'steer');
    const mobileInput = omitMeshAttachmentClaim(payload) as MobileSendChatMessageInput;
    if (mobileInput.attachments?.some((attachment) => attachment.path !== undefined)) {
      throw new Error('Mesh message attachments must use encrypted upload references.');
    }
    const companion = await import('./mobile-companion.service.js');
    const thread = companion
      .listMeshCompanionChatThreads()
      .find((candidate) => candidate.activeSessionId === payload['sessionId']);
    if (thread === undefined) throw new Error('This session has no active companion thread.');
    assertMeshWorkspaceAccess(input, thread.workspaceId);
    if (
      input.scope.repositoryIds.length > 0 &&
      thread.repoIds.some((repoId) => !input.scope.repositoryIds.includes(repoId))
    ) {
      throw new Error('This session is outside the Mesh repository scope.');
    }
    const { claimedAttachments, batchId } = await claimMeshCompanionAttachments(input, payload);
    const fileAttachments = await resolveMeshFileMentions(input, payload, thread.workspaceId);
    const result = await companion.sendMeshCompanionMessage(payload['sessionId'], mobileInput, [
      ...claimedAttachments,
      ...fileAttachments,
    ]);
    return { ...result, ...(batchId === undefined ? {} : { batchId }) };
  }
  if (input.operation === 'command.prepare-attachments') {
    requireMeshEnrollmentPrincipal(input, 'steer');
    if (
      !isRecord(payload) ||
      typeof payload['batchId'] !== 'string' ||
      !Array.isArray(payload['attachments'])
    ) {
      throw new Error('command.prepare-attachments requires a batch id and attachments.');
    }
    const companion = await import('./mobile-companion.service.js');
    const attachments = companion.prepareMeshCompanionAttachments(
      payload['attachments'] as ChatAttachmentInput[],
      companion.getMeshCompanionAttachmentContext(input.sessionId, input.principal),
      payload['batchId'],
    );
    return {
      batchId: payload['batchId'],
      attachments,
    };
  }
  if (
    input.operation === 'command.attachment.begin' ||
    input.operation === 'command.attachment.chunk' ||
    input.operation === 'command.attachment.finish'
  ) {
    requireMeshEnrollmentPrincipal(input, 'steer');
    if (!isRecord(payload)) throw new Error(`${input.operation} requires an object payload.`);
    const companion = await import('./mobile-companion.service.js');
    if (input.operation === 'command.attachment.begin') {
      return companion.beginMeshCompanionAttachmentUploadForSession(
        input.sessionId,
        input.principal,
        {
          batchId: requireString(payload, 'batchId'),
          uploadId: requireString(payload, 'uploadId'),
          name: requireString(payload, 'name'),
          mimeType: requireString(payload, 'mimeType'),
          totalBytes: requireNumber(payload, 'totalBytes'),
        },
      );
    }
    if (input.operation === 'command.attachment.chunk') {
      return companion.writeMeshCompanionAttachmentChunkForSession(
        input.sessionId,
        input.principal,
        {
          uploadId: requireString(payload, 'uploadId'),
          offset: requireNumber(payload, 'offset'),
          bytesBase64: requireString(payload, 'bytesBase64'),
        },
      );
    }
    return companion.finishMeshCompanionAttachmentUploadForSession(
      input.sessionId,
      input.principal,
      {
        uploadId: requireString(payload, 'uploadId'),
        sha256: requireString(payload, 'sha256'),
      },
    );
  }
  if (input.operation === 'command.open-desktop') {
    requireMeshEnrollmentPrincipal(input, 'steer');
    const { openMeshCompanionDesktop } = await import('./mobile-companion.service.js');
    return openMeshCompanionDesktop();
  }
  if (input.operation === 'command.carplay-pause') {
    requireMeshEnrollmentPrincipal(input, 'steer');
    if (!isRecord(payload) || typeof payload['sessionId'] !== 'string') {
      throw new Error('command.carplay-pause requires a session id.');
    }
    const { pauseMeshCarPlaySession } = await import('./mobile-companion.service.js');
    return pauseMeshCarPlaySession(payload['sessionId']);
  }
  if (input.operation === 'command.carplay-pause-all') {
    requireMeshEnrollmentPrincipal(input, 'steer');
    const { pauseAllMeshCarPlaySessions } = await import('./mobile-companion.service.js');
    return pauseAllMeshCarPlaySessions();
  }
  if (input.operation === 'command.carplay-approval') {
    requireMeshEnrollmentPrincipal(input, 'approve');
    if (
      !isRecord(payload) ||
      typeof payload['approvalId'] !== 'string' ||
      (payload['decision'] !== 'approve' &&
        payload['decision'] !== 'decline' &&
        payload['decision'] !== 'later')
    ) {
      throw new Error('command.carplay-approval requires a supported decision.');
    }
    const { resolveMeshCarPlayApproval } = await import('./mobile-companion.service.js');
    return resolveMeshCarPlayApproval({
      approvalId: payload['approvalId'],
      decision: payload['decision'],
    });
  }
  if (input.operation === 'command.carplay-note') {
    requireMeshEnrollmentPrincipal(input, 'steer');
    if (
      !isRecord(payload) ||
      typeof payload['body'] !== 'string' ||
      (payload['source'] !== 'carplay' && payload['source'] !== 'siri')
    ) {
      throw new Error('command.carplay-note requires a valid note.');
    }
    payload['workspaceId'] = requireMeshWorkspaceForMutation(
      input,
      typeof payload['workspaceId'] === 'string' ? payload['workspaceId'] : undefined,
    );
    const { createMeshCarPlayNote } = await import('./mobile-companion.service.js');
    return createMeshCarPlayNote(payload as unknown as CarPlayNoteRequest);
  }
  if (input.operation === 'command.carplay-handover') {
    requireMeshEnrollmentPrincipal(input, 'steer');
    if (
      !isRecord(payload) ||
      (payload['workspaceId'] !== undefined && typeof payload['workspaceId'] !== 'string')
    ) {
      throw new Error('command.carplay-handover requires an optional workspace id.');
    }
    const workspaceId = requireMeshWorkspaceForMutation(
      input,
      payload['workspaceId'] as string | undefined,
    );
    const { startMeshCarPlayHandover } = await import('./mobile-companion.service.js');
    return startMeshCarPlayHandover({
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
  }
  throw new Error(`Unsupported Mesh host operation: ${input.operation}`);
}

function requireMeshEnrollmentPrincipal(
  input: MeshHostOperationInput,
  requiredTier: 'observe' | 'approve' | 'steer' = 'observe',
): Extract<MeshHostOperationInput['principal'], { kind: 'enrollment' }> {
  if (input.principal.kind !== 'enrollment') {
    throw new Error('This companion operation requires an enrolled device session.');
  }
  const tierRank = { observe: 0, approve: 1, steer: 2 } as const;
  if (tierRank[input.principal.tier] < tierRank[requiredTier]) {
    throw new Error('This companion operation requires a higher device trust tier.');
  }
  return input.principal;
}

function assertMeshWorkspaceAccess(input: MeshHostOperationInput, workspaceId?: string): void {
  if (
    workspaceId !== undefined &&
    input.scope.workspaceIds.length > 0 &&
    !input.scope.workspaceIds.includes(workspaceId)
  ) {
    throw new Error('Operation is outside the Mesh workspace scope.');
  }
  if (workspaceId === undefined && input.scope.workspaceIds.length === 1) return;
  if (workspaceId === undefined && input.scope.workspaceIds.length > 1) {
    // Read-list operations can filter to the allowed set; mutations must name a workspace.
    return;
  }
}

function requireMeshWorkspaceForMutation(
  input: MeshHostOperationInput,
  workspaceId?: string,
): string | undefined {
  if (input.scope.workspaceIds.length === 0) return workspaceId;
  if (workspaceId !== undefined) {
    assertMeshWorkspaceAccess(input, workspaceId);
    return workspaceId;
  }
  if (input.scope.workspaceIds.length === 1) return input.scope.workspaceIds[0];
  throw new Error('Choose a workspace within the Mesh scope.');
}

function assertMobileWorkflowScope(
  input: MeshHostOperationInput,
  workflow: MobileStartChatInput,
): void {
  if (
    (workflow.workspaceId !== undefined && typeof workflow.workspaceId !== 'string') ||
    (workflow.repoIds !== undefined &&
      (!Array.isArray(workflow.repoIds) ||
        workflow.repoIds.some((repoId) => typeof repoId !== 'string')))
  ) {
    throw new Error('Workflow workspace or repository scope is invalid.');
  }
  assertMeshWorkspaceAccess(input, workflow.workspaceId);
  if (
    input.scope.workspaceIds.length > 0 &&
    workflow.workspaceId === undefined &&
    input.scope.workspaceIds.length === 1
  ) {
    workflow.workspaceId = input.scope.workspaceIds[0];
  } else if (input.scope.workspaceIds.length > 0 && workflow.workspaceId === undefined) {
    throw new Error('Choose a workspace within the Mesh grant before starting a workflow.');
  }
  if (
    input.scope.repositoryIds.length > 0 &&
    workflow.repoIds?.some((repoId) => !input.scope.repositoryIds.includes(repoId))
  ) {
    throw new Error('Workflow repositories are outside the Mesh scope.');
  }
}

function omitMeshAttachmentClaim(payload: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...payload };
  delete rest['batchId'];
  delete rest['attachmentIds'];
  delete rest['fileMentions'];
  return rest;
}

async function resolveMeshFileMentions(
  input: MeshHostOperationInput,
  payload: Record<string, unknown>,
  sessionWorkspaceId?: string,
): Promise<ChatAttachmentInput[]> {
  const fileMentions = payload['fileMentions'];
  if (fileMentions === undefined) return [];
  if (
    !Array.isArray(fileMentions) ||
    fileMentions.length > 10 ||
    fileMentions.some(
      (item) =>
        !isRecord(item) ||
        typeof item['repoId'] !== 'string' ||
        typeof item['relativePath'] !== 'string',
    )
  ) {
    throw new Error('File mention attachment list is invalid.');
  }
  const workspaceId = requireMeshWorkspaceForMutation(input, sessionWorkspaceId);
  if (workspaceId === undefined) {
    throw new Error('File mention attachments require an explicitly selected workspace.');
  }
  const references = fileMentions as Array<{ repoId: string; relativePath: string }>;
  if (
    input.scope.repositoryIds.length > 0 &&
    references.some((reference) => !input.scope.repositoryIds.includes(reference.repoId))
  ) {
    throw new Error('File mention attachments are outside the Mesh repository scope.');
  }
  const companion = await import('./mobile-companion.service.js');
  return companion.resolveMeshCompanionFileMentions(
    workspaceId,
    input.scope.repositoryIds,
    references,
  );
}

async function claimMeshCompanionAttachments(
  input: MeshHostOperationInput,
  payload: Record<string, unknown>,
): Promise<{ claimedAttachments: ChatAttachmentInput[]; batchId?: string }> {
  const hasBatch = typeof payload['batchId'] === 'string';
  const hasAttachments = Array.isArray(payload['attachmentIds']);
  if (!hasBatch && !hasAttachments) return { claimedAttachments: [] };
  if (
    !hasBatch ||
    !hasAttachments ||
    (payload['attachmentIds'] as unknown[]).some((id) => typeof id !== 'string')
  ) {
    throw new Error('Attachment references require a batch id and attachment id list.');
  }
  const attachmentIds = payload['attachmentIds'] as string[];
  if (attachmentIds.length === 0 || attachmentIds.length > 10) {
    throw new Error('Attachment reference list is empty or too large.');
  }
  const principal = requireMeshEnrollmentPrincipal(input, 'steer');
  const { claimMeshCompanionAttachmentsForSession } = await import('./mobile-companion.service.js');
  const claimedAttachments = await claimMeshCompanionAttachmentsForSession(
    input.sessionId,
    principal,
    { batchId: payload['batchId'] as string, attachmentIds },
  );
  return { claimedAttachments, batchId: payload['batchId'] as string };
}

function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} is required.`);
  }
  return value;
}

function requireNumber(payload: Record<string, unknown>, field: string): number {
  const value = payload[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${field} must be a safe integer.`);
  }
  return value;
}

async function assertMeshJobTargetsThisHost(jobId: string): Promise<void> {
  const result = await accountRpc<JobGetResult>('job.get', { jobId });
  const hostEnrollmentId = currentHostSessionRpcContext()?.enrollmentId;
  if (
    hostEnrollmentId === undefined ||
    result.job.requestedTarget.kind !== 'device' ||
    result.job.requestedTarget.enrollmentId !== hostEnrollmentId
  ) {
    throw new Error('Job is not assigned to this host.');
  }
}

function assertMeshReadWorkspace(input: MeshHostOperationInput, workspaceId: unknown): void {
  if (
    input.principal.kind === 'dashboard' &&
    (typeof workspaceId !== 'string' || !input.scope.workspaceIds.includes(workspaceId))
  ) {
    throw new Error('Mesh read is outside the dashboard workspace grant.');
  }
}

function assertDashboardCommandScope(
  scope: MeshHostOperationInput['scope'],
  command: BrowserWorkspaceCommandEnvelope,
  expectedScope: string,
): void {
  const operationScope = BROWSER_WORKSPACE_OPERATION_SCOPE[command.operation];
  if (
    operationScope !== expectedScope ||
    !scope.workspaceIds.includes(command.workspaceId) ||
    (command.repositoryId !== undefined && !scope.repositoryIds.includes(command.repositoryId)) ||
    !scope.scopes.includes(expectedScope)
  ) {
    throw new Error('Browser workspace command is outside the approved scope.');
  }
}

function isBrowserWorkspaceCommandEnvelope(
  value: unknown,
): value is BrowserWorkspaceCommandEnvelope {
  return (
    isRecord(value) &&
    value['v'] === 1 &&
    value['enc'] === 'aes-256-gcm' &&
    typeof value['requestId'] === 'string' &&
    typeof value['commandId'] === 'string' &&
    isBrowserWorkspaceOperation(value['operation']) &&
    typeof value['workspaceId'] === 'string' &&
    typeof value['expiresAt'] === 'string' &&
    typeof value['nonce'] === 'string' &&
    typeof value['ct'] === 'string' &&
    (value['repositoryId'] === undefined || typeof value['repositoryId'] === 'string')
  );
}

function isMeshActivityFrame(
  frame: unknown,
): frame is Record<string, unknown> & { type: 'activity'; streamId: string } {
  return (
    isRecord(frame) &&
    frame['type'] === 'activity' &&
    typeof frame['streamId'] === 'string' &&
    frame['streamId'] !== 'control'
  );
}

function meshActivityFrameFromHostEvent(payload: unknown): ActivityFrame | null {
  if (
    !isRecord(payload) ||
    typeof payload['attemptId'] !== 'string' ||
    payload['attemptId'].length === 0 ||
    typeof payload['generation'] !== 'number' ||
    !Number.isSafeInteger(payload['generation']) ||
    typeof payload['streamId'] !== 'string' ||
    payload['streamId'].length === 0 ||
    payload['streamId'] === 'control' ||
    typeof payload['sequence'] !== 'number' ||
    !Number.isSafeInteger(payload['sequence']) ||
    !isRecord(payload['payload'])
  )
    return null;
  const activity = payload['payload'];
  if (
    (activity['kind'] !== 'stdout' &&
      activity['kind'] !== 'stderr' &&
      activity['kind'] !== 'status') ||
    typeof activity['text'] !== 'string' ||
    Buffer.byteLength(activity['text'], 'utf8') > 256 * 1024 ||
    typeof activity['byteLength'] !== 'number' ||
    !Number.isSafeInteger(activity['byteLength']) ||
    activity['byteLength'] < 0 ||
    typeof activity['truncated'] !== 'boolean'
  )
    return null;
  return {
    type: 'activity',
    version: 1,
    id: `mesh-${payload['attemptId']}-${payload['streamId']}-${payload['sequence']}`,
    attemptId: payload['attemptId'],
    generation: payload['generation'],
    streamId: payload['streamId'],
    sequence: payload['sequence'],
    payload: {
      kind: activity['kind'],
      text: activity['text'],
      byteLength: activity['byteLength'],
      truncated: activity['truncated'],
    },
  };
}

function publishLocalMeshActivity(frame: unknown, scope: SyncScope | null): boolean {
  if (
    scope === null ||
    !isRecord(frame) ||
    !isMeshActivityFrame(frame) ||
    typeof frame['attemptId'] !== 'string' ||
    typeof frame['generation'] !== 'number' ||
    typeof frame['streamId'] !== 'string' ||
    typeof frame['sequence'] !== 'number' ||
    !isRecord(frame['payload'])
  ) {
    return false;
  }
  const host = getMeshMachineHostStatus();
  if (!host.enabled || !host.running) return false;
  try {
    const attempt = getDb()
      .prepare('SELECT job_id, manifest_json FROM mesh_attempts WHERE id = ?')
      .get(frame['attemptId']) as { job_id: string; manifest_json: string } | undefined;
    if (attempt === undefined) return false;
    const manifest = JSON.parse(attempt.manifest_json) as unknown;
    if (!isRecord(manifest) || !isRecord(manifest['inputs'])) return false;
    const workspaceId = manifest['inputs']['workspaceId'];
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) return false;
    publishMeshHostEvent(
      {
        workspaceId,
        jobId: attempt.job_id,
        eventKind: 'activity',
        payload: {
          attemptId: frame['attemptId'],
          generation: frame['generation'],
          streamId: frame['streamId'],
          sequence: frame['sequence'],
          payload: frame['payload'],
        },
      },
      scope,
    );
    return true;
  } catch {
    // Activity is durable through event.append; caller falls back to account push if host publish fails.
    return false;
  }
}

function publishLocalMeshAttemptLifecycle(
  input: { attemptId: string; jobId: string; outcome: 'completed' | 'failed'; status: string },
  scope: SyncScope | null,
): void {
  const host = getMeshMachineHostStatus();
  if (scope === null || !host.enabled || !host.running) return;
  try {
    const attempt = getDb()
      .prepare('SELECT job_id, manifest_json FROM mesh_attempts WHERE id = ?')
      .get(input.attemptId) as { job_id: string; manifest_json: string } | undefined;
    if (attempt === undefined || attempt.job_id !== input.jobId) return;
    const manifest = JSON.parse(attempt.manifest_json) as unknown;
    if (!isRecord(manifest) || !isRecord(manifest['inputs'])) return;
    const workspaceId = manifest['inputs']['workspaceId'];
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) return;
    publishMeshHostEvent(
      {
        workspaceId,
        jobId: input.jobId,
        eventKind: 'attempt.reported',
        payload: input,
      },
      scope,
    );
  } catch {
    // Durable job state is already committed remotely; clients recover from their bounded fallback.
  }
}

export function resetSyncRuntimeForTests(): void {
  runtimeGeneration += 1;
  stopPolling();
  deviceIdentityBindings.clear();
  stopDashboardCommandPump();
  clearSessionRefresh();
  teardownLiveChannel();
  resetMeshObserverForTests();
  resetMeshArtifactForTests();
  resetMeshWorkerForTests();
  stopHandoffRecovery();
  resetMeshHandoffForTests();
  resetMeshDispatchForTests();
  resetMeshIntegrationForTests();
  meshHostPool?.stop();
  meshHostPool = null;
  configureMeshManagedEndpointLifecycle(null);
  auth = null;
  lastError = null;
  sessionExpired = false;
  rpcOverride = undefined;
  devSpikeEnabled = false;
  fetchOverride = undefined;
  createSocketOverride = undefined;
  lastHostedRefreshAt = 0;
  lastFairUseStatus = null;
  keyRotationBlockedScopeKey = null;
  pendingPairingRedemption = null;
  disposeBrowserWorkspaceExecutor();
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
  if (!backend || fields === null || !sessionBoundToBackend(backend, fields)) return null;
  return {
    backendId: backend.id,
    accountId: fields.accountId,
    datasetEpoch: fields.datasetEpoch,
  };
}

/**
 * Returns the authenticated scope for the reviewed backend without activating
 * it. Enrollment may intentionally leave a backend paused until the user
 * opts into Sync, but the pairing secret still needs to be wrapped into the
 * local keyring before a process restart can discard it from memory.
 */
function reviewedSessionScope(): SyncScope | null {
  const backend = pinnedBackend();
  const fields = auth?.getSessionScopeFields() ?? null;
  if (!backend || fields === null || !sessionBoundToBackend(backend, fields)) return null;
  return {
    backendId: backend.id,
    accountId: fields.accountId,
    datasetEpoch: fields.datasetEpoch,
  };
}

function runtimeScopeKey(scope: SyncScope): string {
  return `${scope.backendId}\u0000${scope.accountId}\u0000${scope.datasetEpoch}`;
}

/** A new sign-in may replace the enrollment while keeping the same sync scope. */
function ensureCurrentEnrollment(): void {
  const scope = currentScope() ?? reviewedSessionScope();
  const fields = auth?.getSessionScopeFields() ?? null;
  if (scope === null || fields === null) return;
  upsertEnrollment({
    id: fields.enrollmentId,
    scope,
    installationId: getOrCreateInstallationId(),
    displayName: hostname() || 'Anvil device',
    state: 'active',
  });
}

function resumeSyncAfterEnrollment(): void {
  ensureCurrentEnrollment();
  if (!isSyncEnabled()) {
    startKeyringOnboardingPoll();
    return;
  }
  stopKeyringOnboardingPoll();
  meshHostPool?.start();
  connectLiveChannel();
  armFallbackPoll();
  armDashboardCommandPump();
  meshWorkerOnSyncReady();
  remoteChatOnReady();
  syncLocalMeshHostListener();
  startHandoffRecovery();
  void reconcileHandoffsWhenReady().catch((error: unknown) => {
    console.warn('[Sync] Handoff recovery will retry on reconnect:', error);
  });
  void requestSync().catch(() => undefined);
}

/** Give a newly enrolled device one read-only key delivery/bootstrap pass. */
async function prepareDeviceKeyBeforeConnect(): Promise<void> {
  if (isSyncEnabled() || reviewedSessionScope() === null) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 12_000);
    timer.unref?.();
  });
  try {
    await Promise.race([runKeyringOnboardingCycle(), deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
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

/**
 * The active sync scope for callers outside the runtime (daemon provider
 * commands, IPC). Null when no valid session/backend pair exists.
 */
export function activeSyncScope(): SyncScope | null {
  return currentScope();
}

/**
 * Complete the first one-shot sync cycle within a bounded headless budget.
 * The regular runtime has its own transport timeout, while this extra bound
 * also covers injected RPC seams used by daemon integrations and tests.
 */
async function requestSyncWithin(timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Initial sync timed out.')), timeoutMs);
  });
  try {
    await Promise.race([requestSync(), timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
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
  const scope = currentScope() ?? reviewedSessionScope();
  const items: SyncAdoptionPreviewItem[] = [];
  for (const entityType of SYNC_ENTITY_TYPES) {
    for (const entityId of listLocalEntityIds(entityType)) {
      if (!adoptionScopeAllowsEntity(scope, entityType, entityId)) continue;
      const payload = buildEntityPayload(entityType, entityId);
      if (payload === null) continue;
      if (
        entityType === SYNC_ENTITY_WORKSPACE_DEFINITION &&
        scope !== null &&
        getBinding(scope, entityType, entityId)?.basePayloadJson === canonicalJson(payload)
      ) {
        continue;
      }
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

/** Mirrors the account-ownership and workspace-opt-in checks used by binding. */
function adoptionScopeAllowsEntity(
  scope: SyncScope | null,
  entityType: string,
  entityId: string,
): boolean {
  const boundScopes = listSyncScopesForEntity(entityType, entityId);
  if (entityType === SYNC_ENTITY_WORKSPACE_DEFINITION) {
    return (
      !isWorkspaceSyncPaused(entityId) &&
      (scope === null
        ? boundScopes.length === 0
        : boundScopes.every((boundScope) => sameSyncScope(boundScope, scope)))
    );
  }
  return boundScopes.length === 0;
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
          if (!adoptionScopeAllowsEntity(scope, entityType, entityId)) continue;
          if (bindWorkspaceDefinitionInScope(scope, entityId)) bound += 1;
          continue;
        }
        if (!adoptionScopeAllowsEntity(scope, entityType, entityId)) continue;
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
  const bound = run();
  const enrollment = getActiveEnrollment(scope);
  if (enrollment !== null) applyPausedWorkspaceChanges(scope, enrollment.id);
  return bound;
}

function sameSyncScope(left: SyncScope, right: SyncScope): boolean {
  return (
    left.backendId === right.backendId &&
    left.accountId === right.accountId &&
    left.datasetEpoch === right.datasetEpoch
  );
}

function bindWorkspaceDefinitionInScope(scope: SyncScope, workspaceId: string): boolean {
  if (isWorkspaceSyncPaused(workspaceId)) return false;
  const otherScopes = listSyncScopesForEntity(SYNC_ENTITY_WORKSPACE_DEFINITION, workspaceId).filter(
    (boundScope) => !sameSyncScope(boundScope, scope),
  );
  if (otherScopes.length > 0) return false;
  materializeRepoDefinitions(workspaceId);

  const wasBound = getBinding(scope, SYNC_ENTITY_WORKSPACE_DEFINITION, workspaceId) !== null;
  if (!wasBound) upsertBinding(scope, SYNC_ENTITY_WORKSPACE_DEFINITION, workspaceId);
  const payload = buildEntityPayload(SYNC_ENTITY_WORKSPACE_DEFINITION, workspaceId);
  if (payload === null) return false;
  const binding = getBinding(scope, SYNC_ENTITY_WORKSPACE_DEFINITION, workspaceId);
  if (binding === null) return false;
  if (canonicalJson(payload) !== (binding.basePayloadJson ?? null)) {
    recordLocalChange(scope, {
      entityType: SYNC_ENTITY_WORKSPACE_DEFINITION,
      entityId: workspaceId,
      schemaVersion: SYNC_ENTITY_SCHEMA_VERSIONS[SYNC_ENTITY_WORKSPACE_DEFINITION],
      operation: 'update',
      payload,
    });
  }
  return !wasBound;
}

/** Apply an explicit Local → Sync choice immediately when account Sync is active. */
export function onWorkspaceSyncSelectionChanged(workspaceId: string, selected: boolean): void {
  if (!selected || !isSyncEnabled()) return;
  const scope = currentScope();
  if (scope === null) return;
  const enrollment = getActiveEnrollment(scope);
  if (enrollment === null) return;
  getDb().transaction(() => bindWorkspaceDefinitionInScope(scope, workspaceId))();
  applyPausedWorkspaceChanges(scope, enrollment.id);
  void requestSync().catch(() => undefined);
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
  fetchFn: typeof fetch | undefined = fetchOverride,
): (params: SessionRefreshParams) => Promise<SessionRefreshResult> {
  return (params) =>
    postAuthRoute<SessionRefreshResult>(
      { apiUrl: apiUrlFor(backend) },
      'session/refresh',
      params as unknown as Record<string, unknown>,
      { fetchFn },
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
    ensureCurrentEnrollment();
    pendingPairingRedemption = null;
    // OIDC enrollment has no pairing channel; this device publishes its
    // identity and receives the ADK via a keyring wrap from a device that
    // already holds it (or provisions v1 itself on a fresh account).
    initializeSyncCrypto();
    await prepareDeviceKeyBeforeConnect();
    // BILL-05: pull hosted access now so a restricted account never gets one
    // free mutating cycle before the first describe lands.
    void refreshHostedEntitlement().catch(() => undefined);
    resumeSyncAfterEnrollment();
    return snapshot;
  } catch (error) {
    service.cancelPendingLogin();
    throw error;
  }
}

export interface SignInWithWorkOSDeviceOptions {
  /** Receives only the public code and safe verification URI. */
  onChallenge?: (challenge: WorkOSDeviceChallenge) => void | Promise<void>;
  /** Cancels the flow without ever writing a local session. */
  signal?: AbortSignal;
  /** Optional bounded override used by headless callers and tests. */
  timeoutMs?: number;
  /**
   * Daemon sign-in is a one-shot authentication command. When false, persist
   * the session but leave sync timers, sockets, and worker activity to `run`.
   */
  startRuntime?: boolean;
}

/**
 * Headless production sign-in. WorkOS is contacted directly for its public
 * device authorization response; each poll submits the private code through
 * the reviewed backend's `/enroll` route, which returns only an Anvil session.
 */
export async function signInWithWorkOSDevice(
  options: SignInWithWorkOSDeviceOptions = {},
): Promise<SyncAuthPublicSnapshot> {
  const backend = requireReviewedBackend();
  if (!backend.descriptor.authModes.includes('workos-device')) {
    throw new Error('This backend does not advertise workos-device sign-in.');
  }
  const service = requireAuth();
  const generation = runtimeGeneration;
  runtimeGeneration += 1;
  const snapshot = await service.enrollWithWorkOSDevice(
    {
      clientId: backend.descriptor.auth.publicClientId,
      ...(options.onChallenge === undefined ? {} : { onChallenge: options.onChallenge }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(fetchOverride === undefined ? {} : { fetchFn: fetchOverride }),
    },
    async (params: WorkOSDeviceEnrollParams, signal: AbortSignal) => {
      return postAuthRoute<EnrollResult>({ apiUrl: apiUrlFor(backend) }, 'enroll', params, {
        fetchFn: fetchOverride,
        signal,
      });
    },
    backend.id,
    () => {
      const current = pinnedBackend();
      return (
        runtimeGeneration === generation + 1 &&
        current?.id === backend.id &&
        current.identityReviewRequired === false
      );
    },
  );
  if (
    runtimeGeneration !== generation + 1 ||
    snapshot.state !== 'signed-in' ||
    pinnedBackend()?.id !== backend.id
  ) {
    return snapshot;
  }
  sessionExpired = false;
  pendingPairingRedemption = null;
  if (options.startRuntime !== false) {
    scheduleSessionRefresh();
    ensureCurrentEnrollment();
    initializeSyncCrypto();
    await prepareDeviceKeyBeforeConnect();
    void refreshHostedEntitlement().catch(() => undefined);
    resumeSyncAfterEnrollment();
  } else {
    // The daemon's one-shot sign-in binds and publishes this device identity,
    // then performs a read-only key-delivery pass. `run` owns Sync opt-in,
    // recurring timers, sockets, and worker leases.
    stopSyncRuntimeForOneShot();
    ensureCurrentEnrollment();
    initializeSyncCrypto();
    try {
      await runKeyringOnboardingCycle({ scheduleRetry: false });
    } catch (error) {
      // Enrollment is already committed at this point. Keep sign-in success
      // truthful and leave the retryable failure for the next `run`.
      lastError = error instanceof Error ? error.message : 'Initial sync failed.';
    }
  }
  return snapshot;
}

export interface DeviceAuthorizationSignInFlow {
  verificationUri: string;
  userCode: string;
  expiresIn: number;
  waitForCompletion: (signal: AbortSignal) => Promise<void>;
  cancel: () => void;
  dispose: () => void;
  /** Exposes commit state without exposing the session or provider tokens. */
  isSessionPersisted: () => boolean;
}

/**
 * Starts the headless flow and resolves as soon as the public challenge is
 * ready to display. The returned handle lets the daemon own SIGINT without
 * exposing the private device code or a WorkOS token.
 */
export async function beginDeviceAuthorizationSignIn(
  signal?: AbortSignal,
  options: { startRuntime?: boolean } = {},
): Promise<DeviceAuthorizationSignInFlow> {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener('abort', onCallerAbort, { once: true });
  if (signal?.aborted) controller.abort();

  let challenge: WorkOSDeviceChallenge | null = null;
  let resolveChallenge: ((value: WorkOSDeviceChallenge) => void) | null = null;
  let rejectChallenge: ((error: unknown) => void) | null = null;
  const challengeReady = new Promise<WorkOSDeviceChallenge>((resolve, reject) => {
    resolveChallenge = resolve;
    rejectChallenge = reject;
  });
  const completion = signInWithWorkOSDevice({
    signal: controller.signal,
    ...(options.startRuntime === undefined ? {} : { startRuntime: options.startRuntime }),
    onChallenge: (next) => {
      challenge = next;
      resolveChallenge?.(next);
    },
  });
  // If the provider/backend rejects before emitting a challenge, wake the
  // start caller and keep the completion promise available to waiters.
  void completion.catch((error: unknown) => {
    rejectChallenge?.(error);
  });
  try {
    await Promise.race([
      challengeReady,
      completion.then(() => {
        if (challenge === null) throw new Error('WorkOS did not return a device challenge.');
        return challenge;
      }),
    ]);
  } catch (error) {
    controller.abort();
    signal?.removeEventListener('abort', onCallerAbort);
    throw error;
  }
  if (challenge === null) {
    controller.abort();
    signal?.removeEventListener('abort', onCallerAbort);
    throw new Error('WorkOS did not return a device challenge.');
  }
  const publicChallenge: WorkOSDeviceChallenge = challenge;
  let disposed = false;
  const cancel = () => {
    controller.abort();
    auth?.cancelPendingLogin();
  };
  return {
    verificationUri: publicChallenge.verificationUri,
    userCode: publicChallenge.userCode,
    expiresIn: Math.max(0, (Date.parse(publicChallenge.expiresAt) - Date.now()) / 1000),
    waitForCompletion: async (waitSignal: AbortSignal): Promise<void> => {
      if (waitSignal.aborted) {
        cancel();
      } else {
        waitSignal.addEventListener('abort', cancel, { once: true });
      }
      try {
        await completion;
      } finally {
        waitSignal.removeEventListener('abort', cancel);
      }
    },
    cancel,
    isSessionPersisted: () => getRuntimeStatus().auth.state === 'signed-in',
    dispose: () => {
      if (disposed) return;
      disposed = true;
      signal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/**
 * E2E bootstrap after any successful enrollment: publishes this device's
 * X25519 identity and, when the enrollment carried a pairing payload,
 * registers the pairing secret so the issuer's keyring blob can be
 * unwrapped on the next pull. Best-effort — a failure here defers sealing
 * rather than breaking the session.
 */
function initializeSyncCrypto(pairing?: { pairingNonce: string; pairingSecret: string }): boolean {
  // Use the active scope during normal runtime. During enrollment the
  // reviewed backend is still paused, so derive the same authenticated scope
  // without changing backend state or enabling sync.
  const activeScope = currentScope();
  const scope = activeScope ?? reviewedSessionScope();
  const fields = requireAuth().getSessionScopeFields();
  if (scope === null || fields === null) return false;
  const pending = pendingPairingRedemption;
  const deferredPairing =
    pairing === undefined &&
    pending !== null &&
    pending.backendId === scope.backendId &&
    pending.accountId === scope.accountId
      ? pending.pairing
      : undefined;
  const pairingToRegister = pairing ?? deferredPairing;
  try {
    if (pairingToRegister !== undefined) {
      registerPairingRedemption(
        scope,
        pairingToRegister.pairingNonce,
        pairingToRegister.pairingSecret,
      );
    }
    ensureDeviceIdentity(scope, fields.enrollmentId);
    // Identity publication is a sync mutation and therefore waits for the
    // explicit Sync opt-in. Pairing redemption itself is safe to persist while
    // the reviewed backend remains paused because it never leaves this device.
    if (activeScope !== null) {
      publishDeviceIdentity(activeScope, fields.enrollmentId);
    }
    if (pairingToRegister !== undefined && pending !== null) {
      pendingPairingRedemption = null;
    }
    return true;
  } catch (error) {
    console.warn(
      `[sync] E2E crypto bootstrap failed; sealed pushes defer until keys arrive: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
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
  pendingPairingRedemption = null;
  runtimeGeneration += 1;
  const snapshot = await requireAuth().enrollWithCode(
    redeemCode,
    enrollAgainst(backend),
    backend.id,
  );
  sessionExpired = false;
  scheduleSessionRefresh();
  ensureCurrentEnrollment();
  if (pairing !== null) {
    if (snapshot.accountId === null) {
      throw new Error('Enrollment succeeded without an account scope.');
    }
    pendingPairingRedemption = {
      backendId: backend.id,
      accountId: snapshot.accountId,
      pairing: { pairingNonce: pairing.pairingNonce, pairingSecret: pairing.pairingSecret },
    };
  }
  initializeSyncCrypto(
    pairing === null
      ? undefined
      : { pairingNonce: pairing.pairingNonce, pairingSecret: pairing.pairingSecret },
  );
  await prepareDeviceKeyBeforeConnect();
  void refreshHostedEntitlement().catch(() => undefined);
  resumeSyncAfterEnrollment();
  return snapshot;
}

/**
 * Mints a pairing payload on the signed-in account for enrolling another
 * device. The returned `pairingPayload` is the `anvil-pair-…` string the
 * new device types or scans: it embeds the enrollment code plus the
 * out-of-band keyring secret and is shown once.
 */
export async function issueEnrollmentCode(options?: {
  /** ENV-01: 'ephemeral' mints a class-bound code for a cloud environment. */
  enrollmentClass?: 'device' | 'ephemeral';
  /** Provider id recorded on the enrollment (e.g. 'aws-lambda-microvm'). */
  provider?: string;
  /** Ephemeral session lifetime; the backend clamps to its bounds. */
  sessionTtlSeconds?: number;
  displayName?: string;
  /** ENV-01: environment record the redeemed enrollment is bound to. */
  environmentId?: string;
}): Promise<EnrollmentCodeIssueResult & { pairingPayload: string | null }> {
  const backend = getActiveBackend() ?? pinnedBackend();
  if (!backend) {
    throw new Error('Pin a backend first.');
  }
  const fields = requireAuth().getSessionScopeFields();
  if (!sessionBoundToBackend(backend, fields)) {
    if (fields === null) throw new Error('Sign in before issuing a pairing code.');
    if (fields.backendId === null) {
      throw new Error('This saved device session is not bound to this backend. Sign in again.');
    }
    throw new Error('This device session belongs to a different backend. Sign out first.');
  }
  const token = requireAuth().getAccessToken();
  if (token === null) throw new Error('Sign in before issuing a pairing code.');
  const result = await postAuthRoute<EnrollmentCodeIssueResult>(
    { apiUrl: apiUrlFor(backend) },
    'enrollment-codes',
    {
      displayName: (options?.displayName ?? hostname()) || 'Anvil device',
      ...(options?.enrollmentClass === undefined
        ? {}
        : { enrollmentClass: options.enrollmentClass }),
      ...(options?.provider === undefined ? {} : { provider: options.provider }),
      ...(options?.sessionTtlSeconds === undefined
        ? {}
        : { sessionTtlSeconds: options.sessionTtlSeconds }),
      ...(options?.environmentId === undefined ? {} : { environmentId: options.environmentId }),
    },
    { accessToken: token, fetchFn: fetchOverride },
  );
  // Seal the current ADK bundle under a fresh pairing secret and queue it
  // for the redeeming device. No key yet (fresh account, or this device is
  // itself awaiting a wrap) → the caller still gets a usable enrollment
  // code. Ephemeral-class codes never mint a pairing: environments get
  // task-scoped keys via wraps, never account key material.
  const scope = currentScope();
  let pairingPayload: string | null = null;
  if (scope !== null && fields !== null && options?.enrollmentClass !== 'ephemeral') {
    try {
      pairingPayload = mintPairingPayload(scope, fields.enrollmentId, result.code).pairingPayload;
    } catch {
      pairingPayload = null;
    }
  }
  return { ...result, pairingPayload };
}

/**
 * ENV-01/ENV-09: request a cloud environment on the signed-in account —
 * `provision-environment` job with `kind:'auto'` placement. For
 * `anvil-managed` the ephemeral pairing is minted here and staged via
 * `environment.bootstrap` so the backend's internal claimer can boot the
 * environment; BYO jobs wait for a provisioner-capable device to claim
 * them. Daemon `env` and future UI callers share this path.
 */
export async function requestCloudEnvironment(
  input: RequestEnvironmentInput,
): Promise<RequestEnvironmentResult> {
  const backend = getActiveBackend() ?? pinnedBackend();
  const token = requireAuth().getAccessToken();
  const scope = currentScope();
  const fields = requireAuth().getSessionScopeFields();
  if (
    backend === null ||
    token === null ||
    scope === null ||
    fields === null ||
    !sessionBoundToBackend(backend, fields)
  ) {
    throw new Error('Sign in before requesting an environment.');
  }
  const provisionerScope: ProvisionerScope = {
    backendId: scope.backendId,
    accountId: scope.accountId,
    enrollmentId: fields.enrollmentId,
    apiUrl: apiUrlFor(backend),
    backendUrl: backend.baseUrl,
    accessToken: token,
  };
  return requestEnvironment(provisionerScope, input, {
    mintEnvironmentCode: async (options) => {
      const issued = await issueEnrollmentCode({
        enrollmentClass: 'ephemeral',
        provider: options.provider,
        sessionTtlSeconds: options.ttlSeconds,
        displayName: options.displayName,
        environmentId: options.environmentId,
      });
      // Ephemeral codes carry authentication only — never a pairing
      // payload: the coordinator must not hold equivalent account keying
      // material for a worker it merely coordinates.
      return issued.code;
    },
  });
}

function currentProvisionerScope(): ProvisionerScope {
  const backend = getActiveBackend() ?? pinnedBackend();
  const token = requireAuth().getAccessToken();
  const scope = currentScope();
  const fields = requireAuth().getSessionScopeFields();
  if (
    backend === null ||
    token === null ||
    scope === null ||
    fields === null ||
    !sessionBoundToBackend(backend, fields)
  ) {
    throw new Error('Sign in before managing cloud environment connections.');
  }
  return {
    backendId: scope.backendId,
    accountId: scope.accountId,
    enrollmentId: fields.enrollmentId,
    apiUrl: apiUrlFor(backend),
    backendUrl: backend.baseUrl,
    accessToken: token,
  };
}

/** Secret-free provider connections stored on this provisioner device. */
export function listCloudProviderConnections(): ProviderConnectionSummary[] {
  return listProviderConnections(currentProvisionerScope());
}

/** Add a provider connection. Secrets are encrypted by the main process and never synced. */
export function addCloudProviderConnection(input: {
  provider: RequestEnvironmentInput['provider'];
  displayName?: string;
  config: Record<string, unknown>;
  secret?: string;
}): ProviderConnectionSummary {
  return addProviderConnection(currentProvisionerScope(), input);
}

export function removeCloudProviderConnection(connectionId: string): boolean {
  return removeProviderConnection(currentProvisionerScope(), connectionId);
}

export function listLocalCloudEnvironments() {
  return listLocalEnvironments(currentProvisionerScope());
}

/** Account-wide environment records (terminal rows only with includeTerminal). */
export async function listCloudEnvironments(
  includeTerminal = false,
): Promise<EnvironmentListResult> {
  return accountRpc<EnvironmentListResult>('environment.list', { includeTerminal });
}

/** Current server-authoritative hosted environment limits for this account. */
export async function getManagedEnvironmentLimits(): Promise<EnvironmentLimitsResult> {
  return accountRpc<EnvironmentLimitsResult>('environment.limits', {});
}

/**
 * Durable teardown intent for any environment on the account — managed
 * envs are deleted by the backend's provisioner, BYO envs by the claiming
 * device's reap sweep. Provider-neutral by design.
 */
export async function reapCloudEnvironment(environmentId: string): Promise<EnvironmentReapResult> {
  return accountRpc<EnvironmentReapResult>('environment.reap', { environmentId });
}

export async function suspendCloudEnvironment(environmentId: string): Promise<CloudEnvironment> {
  const result = await accountRpc<EnvironmentSuspendResult>('environment.suspend', {
    environmentId,
  });
  return result.environment;
}

/** Restart the same hosted environment from its private filesystem snapshot. */
export async function resumeCloudEnvironment(environmentId: string): Promise<CloudEnvironment> {
  assertAnvilCloudAgentsEnabled();
  const { maxTtlSeconds: ttlSeconds } = await getManagedEnvironmentLimits();
  const issued = await issueEnrollmentCode({
    enrollmentClass: 'ephemeral',
    provider: 'anvil-managed',
    sessionTtlSeconds: ttlSeconds,
    displayName: 'Anvil hosted chat',
    environmentId,
  });
  await accountRpc<{ ok: true }>('environment.bootstrap', {
    environmentId,
    payload: issued.code,
  });
  const result = await accountRpc<EnvironmentResumeResult>('environment.resume', {
    environmentId,
    ttlSeconds,
  });
  return result.environment;
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
  const service = requireAuth();
  const fields = service.getSessionScopeFields();
  if (!sessionBoundToBackend(backend, fields)) {
    if (fields === null) throw new Error('Sign in first.');
    if (fields.backendId === null) {
      throw new Error('This saved device session is not bound to this backend. Sign in again.');
    }
    throw new Error('This device session belongs to a different backend. Sign out first.');
  }
  const token = service.getAccessToken();
  if (token === null) {
    throw new Error('Sign in first.');
  }
  const { result } = await backendRpc<R>({ apiUrl: apiUrlFor(backend) }, operation, params, token, {
    fetchFn: fetchOverride,
  });
  return result;
}

interface SecurityView {
  accountId?: unknown;
  policy?: unknown;
  newDeviceTrustPolicy?: unknown;
  canConfigure?: unknown;
  bootstrapEnrollmentId?: unknown;
  enrollments?: unknown;
}

interface SecurityEnrollmentView {
  enrollmentId?: unknown;
  trustState?: unknown;
  trustSource?: unknown;
  trustedAt?: unknown;
  identityPub?: unknown;
  identityBoundAt?: unknown;
  proofMethod?: unknown;
  enrollmentClass?: unknown;
  provider?: unknown;
  expiresAt?: unknown;
  sessionExpiresAt?: unknown;
  enrollmentExpiresAt?: unknown;
}

function securityEnrollment(
  view: SecurityView,
  enrollmentId: string,
): SecurityEnrollmentView | null {
  if (!Array.isArray(view.enrollments)) return null;
  const entry = view.enrollments.find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as SecurityEnrollmentView).enrollmentId === enrollmentId,
  );
  return entry === undefined ? null : (entry as SecurityEnrollmentView);
}

function securityContext(fence: {
  scope: SyncScope;
  enrollmentId: string;
  generation: number;
}): SyncDeviceSecurityContext {
  return {
    scope: fence.scope,
    enrollmentId: fence.enrollmentId,
    rpc: (operation, params) => accountRpc(operation, params),
    assertCurrent: () => assertSecurityScope(fence),
  };
}

async function recordBootstrapEligibility(fence: {
  scope: SyncScope;
  enrollmentId: string;
  generation: number;
}): Promise<SecurityView> {
  assertSecurityScope(fence);
  const view = await accountRpc<SecurityView>('security.get', {});
  assertSecurityScope(fence);
  // `canConfigure` is intentionally broader than first-key minting: an
  // already keyed trusted device may configure/replace recovery. Only the
  // server-selected bootstrap enrollment may create the account's first ADK.
  const eligible = view.canConfigure === true && view.bootstrapEnrollmentId === fence.enrollmentId;
  setAccountKeyBootstrapEligibility(fence.scope, fence.enrollmentId, eligible);
  return view;
}

function emptyDeviceSecurityStatus(): SyncDeviceSecurityStatus {
  return {
    accountId: null,
    configured: false,
    policy: 'require-approval',
    revision: 1,
    trustState: 'unknown',
    trustSource: 'unknown',
    hasAccountKey: false,
    hasRecoverySecret: false,
    canConfigure: false,
    requiresRecovery: false,
    recentEvents: [],
  };
}

/**
 * Pull account state while keeping all writes (including scan and push)
 * disabled. This is used before first-device key provisioning so an OIDC
 * enrolment cannot mint a divergent key for an already populated account.
 */
async function readOnlySyncPull(fence: {
  scope: SyncScope;
  enrollmentId: string;
  generation: number;
}, options: { identityOnlyWrite?: boolean } = {}): Promise<void> {
  const backend = getActiveBackend() ?? pinnedBackend();
  const service = requireAuth();
  const fields = service.getSessionScopeFields();
  const token = service.getAccessToken();
  if (
    backend === null ||
    token === null ||
    fields === null ||
    !sessionBoundToBackend(backend, fields)
  ) {
    throw new Error('Sign in before reading account state on this backend.');
  }
  const paths = resolveBackendPaths(backend.baseUrl, backend.descriptor, {
    allowLoopbackHttp: shouldAllowLoopbackHttp(backend.baseUrl),
  });
  const fetchFn = fetchOverride;
  const cycleRpc: SyncEngineRpc | undefined =
    rpcOverride ??
    (fetchFn === undefined
      ? undefined
      : (connection, operation, params, accessToken) =>
          backendRpc(connection, operation, params, accessToken, { fetchFn }));
  await runSyncCycle({
    scope: fence.scope,
    enrollmentId: fence.enrollmentId,
    connection: { apiUrl: paths.apiUrl, limits: backend.descriptor.limits },
    accessToken: token,
    writeGate: () => ({ allowed: false }),
    ...(options.identityOnlyWrite === true ? { writeMode: 'device-identity-only' as const } : {}),
    rpc: cycleRpc,
    guard: () => {
      return sessionFenceIsCurrent(fence);
    },
  });
  assertSessionFence(fence);
}

/** Queue only this enrollment's public identity before a paused-account pull. */
function queueOwnDeviceIdentityForOnboarding(fence: {
  scope: SyncScope;
  enrollmentId: string;
  generation: number;
}): void {
  assertSessionFence(fence);
  ensureDeviceIdentity(fence.scope, fence.enrollmentId);
  const binding = getBinding(fence.scope, CRYPTO_ENTITY_DEVICE_IDENTITY, fence.enrollmentId);
  const hasOutstandingIdentity = listOutboxRows(fence.scope).some(
    (row) =>
      row.entityType === CRYPTO_ENTITY_DEVICE_IDENTITY &&
      row.entityId === fence.enrollmentId &&
      (row.state === 'pending' || row.state === 'dispatched'),
  );
  if (binding !== null && binding.baseRevision !== null) return;
  if (!hasOutstandingIdentity) publishDeviceIdentity(fence.scope, fence.enrollmentId);
}

/** Returns security metadata only; recovery envelopes remain in the main process. */
export async function getDeviceSecurityStatus(): Promise<SyncDeviceSecurityStatus> {
  const scope = reviewedSessionScope();
  const fields = auth?.getSessionScopeFields() ?? null;
  if (scope === null || fields === null) return emptyDeviceSecurityStatus();
  const fence = {
    scope,
    enrollmentId: fields.enrollmentId,
    generation: runtimeGeneration,
  };
  if (!hasAccountKey(scope)) await recordBootstrapEligibility(fence);
  return orchestrateDeviceSecurityStatus(securityContext(fence));
}

/**
 * First-device setup. The server authorizes the bootstrap enrollment and the
 * pull-only pass establishes enough local state to safely mint the first ADK.
 */
export async function setupDeviceRecovery(
  policy: SyncDeviceTrustPolicy,
): Promise<SyncDeviceRecoveryResult> {
  const fence = securityScope();
  const view = await recordBootstrapEligibility(fence);
  if (view.canConfigure !== true) {
    throw new Error('This account is not eligible for initial recovery setup.');
  }
  if (!hasAccountKey(fence.scope)) {
    await readOnlySyncPull(fence);
    if (!canProvisionAccountKey(fence.scope, fence.enrollmentId)) {
      throw new Error('This enrollment is not authorized to create the first account key.');
    }
    provisionAccountKey(fence.scope);
  }
  return orchestrateSetupDeviceRecovery(securityContext(fence), policy);
}

function securityScope(): {
  scope: SyncScope;
  enrollmentId: string;
  generation: number;
} {
  const scope = reviewedSessionScope();
  const fields = requireAuth().getSessionScopeFields();
  if (scope === null || fields === null) {
    throw new Error('Sign in before changing device security.');
  }
  return { scope, enrollmentId: fields.enrollmentId, generation: runtimeGeneration };
}

function assertSecurityScope(fence: {
  scope: SyncScope;
  enrollmentId: string;
  generation: number;
}): void {
  if (!sessionFenceIsCurrent(fence)) {
    throw new Error('The sign-in session changed while device security was updating.');
  }
}

function sessionFenceIsCurrent(fence: {
  scope: SyncScope;
  enrollmentId: string;
  generation: number;
}): boolean {
  if (fence.generation !== runtimeGeneration) return false;
  const backend = getActiveBackend() ?? pinnedBackend();
  const fields = auth?.getSessionScopeFields() ?? null;
  return (
    backend !== null &&
    !backend.identityReviewRequired &&
    fields !== null &&
    sessionBoundToBackend(backend, fields) &&
    backend.id === fence.scope.backendId &&
    fields.accountId === fence.scope.accountId &&
    fields.datasetEpoch === fence.scope.datasetEpoch &&
    fields.enrollmentId === fence.enrollmentId
  );
}

function assertSessionFence(fence: {
  scope: SyncScope;
  enrollmentId: string;
  generation: number;
}): void {
  if (!sessionFenceIsCurrent(fence)) {
    throw new Error('The sign-in session changed while device key delivery was updating.');
  }
}

function deviceIdentityBindingCacheKey(
  scope: SyncScope,
  enrollmentId: string,
  identityPub: string,
): string {
  return `${runtimeScopeKey(scope)}\u0000${enrollmentId}\u0000${identityPub}`;
}

/** Binds the current session to its own stored X25519 key, never caller data. */
async function bindCurrentDeviceIdentity(fence: {
  scope: SyncScope;
  enrollmentId: string;
  generation: number;
}): Promise<void> {
  const identityPub = ensureDeviceIdentity(fence.scope, fence.enrollmentId).pub;
  const cacheKey = deviceIdentityBindingCacheKey(fence.scope, fence.enrollmentId, identityPub);
  if (deviceIdentityBindings.has(cacheKey)) return;

  assertSessionFence(fence);
  const existingRoster = await accountRpc<DeviceListResult>('device.list', {});
  assertSessionFence(fence);
  const existingOwn = existingRoster.devices.find(
    (device) => device.enrollmentId === fence.enrollmentId,
  );
  if (existingOwn === undefined || existingOwn.revoked) {
    throw new Error('The authenticated enrollment is missing or revoked in the device roster.');
  }
  if (existingOwn.identityPub !== undefined && existingOwn.identityPub !== null) {
    if (existingOwn.identityPub !== identityPub) {
      throw new Error('The backend identity binding does not match this local device key.');
    }
    if (
      existingOwn.identityBoundAt === undefined ||
      existingOwn.identityBoundAt === null ||
      !Number.isFinite(Date.parse(existingOwn.identityBoundAt))
    ) {
      throw new Error('The backend returned an incomplete device identity binding.');
    }
    deviceIdentityBindings.add(cacheKey);
    return;
  }

  const challenge = await accountRpc<unknown>('security.identityChallenge', { identityPub });
  assertSessionFence(fence);
  if (
    !isRecord(challenge) ||
    typeof challenge['challengeId'] !== 'string' ||
    typeof challenge['challenge'] !== 'string' ||
    challenge['accountId'] !== fence.scope.accountId ||
    challenge['enrollmentId'] !== fence.enrollmentId ||
    challenge['identityPub'] !== identityPub ||
    typeof challenge['serverPublicKey'] !== 'string' ||
    typeof challenge['expiresAt'] !== 'string' ||
    !Number.isFinite(Date.parse(challenge['expiresAt'])) ||
    Date.parse(challenge['expiresAt']) <= Date.now()
  ) {
    throw new Error('Backend returned an invalid device identity challenge.');
  }
  const proof = createDeviceIdentityBindingProof(fence.scope, fence.enrollmentId, {
    challengeId: challenge['challengeId'],
    challenge: challenge['challenge'],
    accountId: challenge['accountId'],
    enrollmentId: challenge['enrollmentId'],
    identityPub: challenge['identityPub'],
    serverPublicKey: challenge['serverPublicKey'],
  });
  assertSessionFence(fence);
  const bound = await accountRpc<unknown>('security.bindIdentity', {
    challengeId: challenge['challengeId'],
    identityPub,
    proof,
  });
  assertSessionFence(fence);
  if (
    !isRecord(bound) ||
    bound['accountId'] !== fence.scope.accountId ||
    bound['enrollmentId'] !== fence.enrollmentId ||
    bound['identityPub'] !== identityPub ||
    typeof bound['identityBoundAt'] !== 'string' ||
    !Number.isFinite(Date.parse(bound['identityBoundAt']))
  ) {
    throw new Error('Backend did not confirm this device identity binding.');
  }
  deviceIdentityBindings.add(cacheKey);
}

export async function unlockDeviceRecovery(code: string): Promise<SyncDeviceSecurityStatus> {
  const fence = securityScope();
  return orchestrateUnlockDeviceRecovery(securityContext(fence), code);
}

export async function setNewDeviceTrustPolicy(
  policy: SyncDeviceTrustPolicy,
): Promise<SyncDeviceSecurityStatus> {
  const fence = securityScope();
  return orchestrateSetNewDeviceTrustPolicy(securityContext(fence), policy);
}

export async function replaceDeviceRecovery(): Promise<SyncDeviceRecoveryResult> {
  const fence = securityScope();
  return orchestrateReplaceDeviceRecovery(securityContext(fence));
}

export async function refreshDeviceRecovery(): Promise<SyncDeviceSecurityStatus> {
  const fence = securityScope();
  return orchestrateRefreshDeviceRecovery(securityContext(fence));
}

export async function resetEncryptedSyncAccount(
  confirmation: SyncEncryptedSyncAccountResetConfirmation,
): Promise<void> {
  if (confirmation !== 'RESET ENCRYPTED DATA') {
    throw new Error('Explicit reset confirmation required.');
  }
  const fence = securityScope();
  const resumeSyncAfterRejectedReset = isSyncEnabled();
  runtimeGeneration += 1;
  stopPolling();
  clearSessionRefresh();
  teardownLiveChannel();
  meshWorkerOnSyncGone();
  remoteChatOnGone();
  stopHandoffRecovery();
  meshObserverOnGone();
  try {
    await accountRpc('security.reset', { confirmation });
  } catch (error) {
    // A non-retryable RPC response is a definitive rejection. Restore the
    // prior runtime only while the captured sign-in is still current. Network
    // and retryable failures remain fenced because the server may have
    // accepted the reset before the response was lost.
    const active = currentScope();
    const fields = requireAuth().getSessionScopeFields();
    const sameSession =
      active !== null &&
      fields !== null &&
      active.backendId === fence.scope.backendId &&
      active.accountId === fence.scope.accountId &&
      active.datasetEpoch === fence.scope.datasetEpoch &&
      fields.enrollmentId === fence.enrollmentId;
    if (
      sameSession &&
      resumeSyncAfterRejectedReset &&
      error instanceof BackendRpcError &&
      !error.retryable &&
      error.code !== 'unauthenticated'
    ) {
      resumeSyncAfterEnrollment();
    }
    if (error instanceof BackendRpcError && !error.retryable && error.code === 'unauthenticated') {
      sessionExpired = true;
    }
    scheduleSessionRefresh();
    throw error;
  }
  const active = currentScope();
  const fields = requireAuth().getSessionScopeFields();
  if (
    active === null ||
    fields === null ||
    active.backendId !== fence.scope.backendId ||
    active.accountId !== fence.scope.accountId ||
    active.datasetEpoch !== fence.scope.datasetEpoch ||
    fields.enrollmentId !== fence.enrollmentId
  ) {
    scheduleSessionRefresh();
    throw new Error('The sign-in session changed before encrypted data reset completed.');
  }
  clearAccountCrypto(fence.scope);
  keyRotationBlockedScopeKey = null;
  clearCompanionAuthCaches();
  requireAuth().signOutLocal();
  disconnectBackend();
  syncLocalMeshHostListener();
  sessionExpired = false;
  lastError = null;
}

/** All device enrollments on the account, including revoked rows and self. */
export async function listDevices(): Promise<DeviceListResult> {
  const result = await accountRpc<DeviceListResult>('device.list', {});
  const scope = currentScope();
  if (scope === null) return result;

  // `device.list` is an enrollment roster, while `security.get` carries the
  // server's audit metadata. Join that metadata with the local keyring trust
  // state before exposing it to the renderer. A server-side trusted row alone
  // never grants local E2EE access: a device remains pending here until its
  // local identity has been verified and the keyring has accepted a wrap.
  const security = await accountRpc<SecurityView>('security.get', {});
  const remote = new Map<string, SecurityEnrollmentView>();
  if (Array.isArray(security.enrollments)) {
    for (const entry of security.enrollments) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as SecurityEnrollmentView).enrollmentId === 'string'
      ) {
        const enrollment = entry as SecurityEnrollmentView;
        remote.set(enrollment.enrollmentId as string, enrollment);
      }
    }
  }
  const local = new Map(listDeviceTrust(scope).map((entry) => [entry.enrollmentId, entry]));
  const trustSources = new Set<SyncDeviceTrustSource>([
    'first-device',
    'manual-approval',
    'pairing',
    'recovery',
    'automatic-auth',
    'recovery-code',
    'local-device',
  ]);
  const asSource = (value: unknown): SyncDeviceTrustSource | undefined =>
    typeof value === 'string' && trustSources.has(value as SyncDeviceTrustSource)
      ? (value as SyncDeviceTrustSource)
      : undefined;
  return {
    ...result,
    devices: result.devices.map((device) => {
      const localTrust = local.get(device.enrollmentId);
      const remoteTrust = remote.get(device.enrollmentId);
      // Remote revocation is authoritative for the display, even before the
      // next sync reconciliation writes the sticky local state.
      const trustState = device.revoked ? ('revoked' as const) : localTrust?.state;
      if (trustState === undefined) return device;
      const source =
        trustState === 'pending'
          ? undefined
          : (asSource(remoteTrust?.trustSource) ??
            (device.self ? ('local-device' as const) : ('manual-approval' as const)));
      return {
        ...device,
        trustState,
        ...(source === undefined ? {} : { trustSource: source }),
        trustedAt:
          (typeof remoteTrust?.trustedAt === 'string' ? remoteTrust.trustedAt : null) ??
          localTrust?.decidedAt ??
          null,
      };
    }),
  };
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
  const scope = currentScope();
  const generation = runtimeGeneration;
  const result = await accountRpc<DeviceRevokeResult>('device.revoke', { enrollmentId });
  clearCompanionAuthCaches();
  if (
    scope !== null &&
    generation === runtimeGeneration &&
    currentScope()?.accountId === scope.accountId
  ) {
    try {
      rotateAccountKey(scope, [enrollmentId]);
    } catch (error) {
      // A revoked device must not remain able to decrypt new writes. Pause
      // this runtime until key rotation succeeds on the next explicit cycle.
      keyRotationBlockedScopeKey = runtimeScopeKey(scope);
      stopPolling();
      teardownLiveChannel();
      throw new Error(
        `Device revoked, but account-key rotation failed; Sync is paused: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    keyRotationBlockedScopeKey = null;
    // The previous recovery root is deliberately invalidated by revocation;
    // require an explicit replacement before refreshing future key versions.
    invalidateRecoverySecret(scope);
  }
  return result;
}

/**
 * Trust states for every enrollment known to this device — joined with
 * the account roster by the caller when it wants display names.
 */
export function deviceTrustStates(): Array<{
  enrollmentId: string;
  state: DeviceTrustState;
  decidedAt: string | null;
}> {
  const scope = currentScope();
  if (scope === null) return [];
  return listDeviceTrust(scope);
}

/**
 * Promotes a pending enrollment after the user has compared the SAS. This is
 * intentionally local: the server's authenticated roster is not a crypto
 * approval. A revoked enrollment can never be reopened by this path.
 */
export async function approveDeviceTrust(
  enrollmentId: string,
  verificationCode: string,
): Promise<void> {
  const fence = securityScope();
  const localTrust = deviceTrustState(fence.scope, enrollmentId);
  if (localTrust === 'revoked') {
    throw new Error('A revoked device requires a fresh enrollment before it can be trusted.');
  }
  const holdsAccountKey = hasAccountKey(fence.scope);
  if (localTrust !== 'pending' && (holdsAccountKey || localTrust !== 'trusted')) {
    throw new Error('Only a device waiting for approval can be approved.');
  }
  const ownPub = ensureDeviceIdentity(fence.scope, fence.enrollmentId).pub;
  const peer = listDeviceIdentities(fence.scope).find(
    (device) => device.enrollmentId === enrollmentId,
  );
  if (peer === undefined) throw new Error('Device identity not seen yet — sync, then try again.');
  const peerPub = peer.pub;
  const expected = deriveSas(fence.scope.accountId, ownPub, peerPub);
  if (verificationCode !== expected)
    throw new Error('The device verification code does not match.');
  const roster = await accountRpc<DeviceListResult>('device.list', {});
  assertSecurityScope(fence);
  if (
    ensureDeviceIdentity(fence.scope, fence.enrollmentId).pub !== ownPub ||
    listDeviceIdentities(fence.scope).find((device) => device.enrollmentId === enrollmentId)
      ?.pub !== peerPub
  ) {
    throw new Error('The device identity changed while approval was in progress.');
  }
  const remote = roster.devices.find((device) => device.enrollmentId === enrollmentId);
  if (remote === undefined || remote.revoked)
    throw new Error('That device is revoked or no longer enrolled.');

  if (!holdsAccountKey) {
    // A newly enrolled/keyless device can verify the identity of an already
    // trusted source. This changes only the local membership used to accept
    // that source's authenticated wrap; it never creates or grants an ADK.
    const security = await accountRpc<SecurityView>('security.get', {});
    assertSecurityScope(fence);
    const source = securityEnrollment(security, enrollmentId);
    if (source?.trustState !== 'trusted') {
      throw new Error('That device is not trusted by the account yet.');
    }
    setDeviceTrust(fence.scope, enrollmentId, 'trusted');
    retryPendingKeyringWraps(fence.scope);
    await requestSync();
    return;
  }

  // This is an audit/roster acknowledgement only. The server response never
  // authorizes key delivery; local SAS verification above remains the crypto
  // gate. Read the authoritative security row after the fresh roster check:
  // another already-trusted device may have completed approval concurrently,
  // in which case repeating security.approve is a conflict. A server roster
  // row alone is deliberately insufficient for this decision.
  const security = await accountRpc<SecurityView>('security.get', {});
  assertSecurityScope(fence);
  if (securityEnrollment(security, enrollmentId)?.trustState !== 'trusted') {
    await accountRpc('security.approve', {
      enrollmentId,
      source: 'manual-approval',
    });
    assertSecurityScope(fence);
  }
  setDeviceTrust(fence.scope, enrollmentId, 'trusted');
  wrapAccountKeyFor(fence.scope, enrollmentId, peer.pub);
  await requestSync();
}

/**
 * Reconciles local trust with the authoritative roster after
 * `device.list`: remote revocations become sticky local 'revoked' rows,
 * unseen enrollments arrive 'pending', and a newly-revoked set triggers
 * exactly one rotation. Called from the sync loop — a device that was
 * offline when the web revoked a sibling learns it here and rotates so
 * post-revocation writes are unreadable to the revoked device.
 */
interface DeviceTrustReconciliationSnapshot {
  roster: DeviceListResult;
  security: SecurityView | null;
}

async function reconcileDeviceTrust(
  scope: SyncScope,
  guard: () => boolean = () => true,
): Promise<DeviceTrustReconciliationSnapshot | null> {
  const [roster, security] = await Promise.all([
    accountRpc<DeviceListResult>('device.list', {}),
    accountRpc<SecurityView>('security.get', {}).catch(() => null),
  ]);
  if (!guard()) return null;
  const remoteRevoked = new Set(
    roster.devices.filter((device) => device.revoked).map((device) => device.enrollmentId),
  );
  const remoteKnown = new Set(roster.devices.map((device) => device.enrollmentId));
  const newlyRevoked: string[] = [];
  for (const enrollmentId of remoteRevoked) {
    const state = deviceTrustState(scope, enrollmentId);
    if (state !== 'revoked') {
      setDeviceTrust(scope, enrollmentId, 'revoked');
      newlyRevoked.push(enrollmentId);
    }
  }
  // Enrollments known to the account but never seen via identity entities
  // arrive pending — metadata only, no deliveries.
  for (const enrollmentId of remoteKnown) {
    if (deviceTrustState(scope, enrollmentId) === null) {
      setDeviceTrust(scope, enrollmentId, 'pending');
    }
  }
  // Only the local completion fence written atomically by rotateAccountKey is
  // evidence this device handled a revoke. Pulled rotation metadata is
  // backend-controlled and may arrive without a usable key wrap.
  const rotationTargets = revocationsNeedingRotation(scope, [...remoteRevoked]);
  const rotationNeeded =
    rotationTargets.length > 0 || keyRotationBlockedScopeKey === runtimeScopeKey(scope);
  if (rotationNeeded && remoteRevoked.size > 0) {
    if (hasAccountKey(scope)) {
      try {
        rotateAccountKey(scope, rotationTargets.length > 0 ? rotationTargets : [...remoteRevoked]);
        keyRotationBlockedScopeKey = null;
      } catch (error) {
        keyRotationBlockedScopeKey = runtimeScopeKey(scope);
        throw error;
      }
    }
    invalidateRecoverySecret(scope);
  }
  return { roster, security };
}

const TRUSTED_DEVICE_SOURCES = new Set([
  'first-device',
  'manual-approval',
  'pairing',
  'recovery',
  'automatic-auth',
  'recovery-code',
]);

function isProviderAuthenticatedDurableDevice(
  enrollment: SecurityEnrollmentView | null,
  rosterDevice: unknown,
): enrollment is SecurityEnrollmentView & { identityPub: string } {
  if (enrollment === null || !isRecord(rosterDevice)) return false;
  const rosterPub = rosterDevice['identityPub'];
  const rosterTrustSource = rosterDevice['trustSource'];
  const expiry =
    enrollment.enrollmentExpiresAt ?? enrollment.expiresAt ?? enrollment.sessionExpiresAt;
  const rosterExpiry =
    rosterDevice['enrollmentExpiresAt'] ??
    rosterDevice['expiresAt'] ??
    rosterDevice['sessionExpiresAt'];
  const boundAt = enrollment.identityBoundAt;
  const rosterBoundAt = rosterDevice['identityBoundAt'];
  const proofMethod = enrollment.proofMethod;
  const provider = enrollment.provider;
  return (
    enrollment.trustState === 'trusted' &&
    typeof enrollment.trustSource === 'string' &&
    TRUSTED_DEVICE_SOURCES.has(enrollment.trustSource) &&
    rosterDevice['trustState'] === 'trusted' &&
    rosterTrustSource === enrollment.trustSource &&
    typeof rosterTrustSource === 'string' &&
    TRUSTED_DEVICE_SOURCES.has(rosterTrustSource) &&
    rosterDevice['revoked'] === false &&
    (proofMethod === 'oidc-pkce' || proofMethod === 'workos-device') &&
    rosterDevice['proofMethod'] === proofMethod &&
    enrollment.enrollmentClass === 'device' &&
    (rosterDevice['enrollmentClass'] === undefined ||
      rosterDevice['enrollmentClass'] === 'device') &&
    typeof boundAt === 'string' &&
    Number.isFinite(Date.parse(boundAt)) &&
    rosterBoundAt === boundAt &&
    typeof enrollment.identityPub === 'string' &&
    typeof rosterPub === 'string' &&
    rosterPub === enrollment.identityPub &&
    (expiry === undefined || expiry === null) &&
    (rosterExpiry === undefined || rosterExpiry === null) &&
    (provider === undefined ||
      provider === null ||
      (typeof provider === 'string' && provider.length > 0)) &&
    (rosterDevice['provider'] === undefined ||
      rosterDevice['provider'] === null ||
      rosterDevice['provider'] === provider)
  );
}

/**
 * Applies the explicit account opt-in only after a provider-authenticated,
 * durable enrollment's backend-bound identity matches the independently
 * synced X25519 identity. This grants local keyring membership, not backend
 * access to the ADK.
 */
function applyAutomaticAuthenticatedTrust(
  scope: SyncScope,
  ownEnrollmentId: string,
  snapshot: DeviceTrustReconciliationSnapshot | null,
  guard: () => boolean,
): boolean {
  const security = snapshot?.security;
  if (
    snapshot === null ||
    security == null ||
    !guard() ||
    security.accountId !== scope.accountId ||
    (security.newDeviceTrustPolicy ?? security.policy) !== 'auto-trust-authenticated'
  ) {
    return false;
  }
  let changed = false;
  for (const remoteDevice of snapshot.roster.devices) {
    if (!guard()) return changed;
    if (remoteDevice.enrollmentId === ownEnrollmentId || remoteDevice.revoked) continue;
    const enrollment = securityEnrollment(security, remoteDevice.enrollmentId);
    if (!isProviderAuthenticatedDurableDevice(enrollment, remoteDevice)) continue;
    const localTrustBefore = deviceTrustState(scope, remoteDevice.enrollmentId);
    const keyBeforeDevice = hasAccountKey(scope);
    const matched = trustAuthenticatedDeviceIdentity(
      scope,
      remoteDevice.enrollmentId,
      enrollment.identityPub,
    );
    if (!matched) continue;

    if (!keyBeforeDevice) retryPendingKeyringWraps(scope);
    let wrapped = false;
    if (hasAccountKey(scope)) {
      wrapped = wrapAccountKeyFor(scope, remoteDevice.enrollmentId, enrollment.identityPub);
    }
    changed =
      changed ||
      localTrustBefore !== 'trusted' ||
      (!keyBeforeDevice && hasAccountKey(scope)) ||
      wrapped;
  }
  return changed;
}

function keyringOnboardingPolicyEnabled(security: SecurityView | null | undefined): boolean | null {
  if (security === null || security === undefined) return null;
  const policy = security.newDeviceTrustPolicy ?? security.policy;
  if (policy === 'auto-trust-authenticated') return true;
  if (policy === 'require-approval' || policy === 'require-code') return false;
  return null;
}

async function runKeyringOnboardingCycle(options: { scheduleRetry?: boolean } = {}): Promise<void> {
  if (keyringOnboardingRunning) return;
  keyringOnboardingRunning = true;
  const attemptAt = Date.now();
  let shouldRetry = false;
  let fence: { scope: SyncScope; enrollmentId: string; generation: number } | null = null;
  try {
    if (isSyncEnabled()) return;
    const backend = pinnedBackend();
    const fields = auth?.getSessionScopeFields() ?? null;
    const scope = reviewedSessionScope();
    if (
      backend === null ||
      backend.identityReviewRequired ||
      fields === null ||
      scope === null ||
      auth?.getPublicSnapshot().state !== 'signed-in'
    ) {
      shouldRetry = false;
      return;
    }
    const onboardingFence = {
      scope,
      enrollmentId: fields.enrollmentId,
      generation: runtimeGeneration,
    };
    fence = onboardingFence;
    shouldRetry = true;
    ensureCurrentEnrollment();
    ensureDeviceIdentity(scope, fields.enrollmentId);

    let ownIdentityBound = false;
    try {
      await bindCurrentDeviceIdentity(onboardingFence);
      ownIdentityBound = sessionFenceIsCurrent(onboardingFence);
    } catch {
      // Automatic delivery stays closed until the server confirms this exact
      // local key. First-device bootstrap uses its separate authority gate.
    }

    const current = (): boolean => sessionFenceIsCurrent(onboardingFence);
    const initial = await reconcileDeviceTrust(scope, current);
    if (!current()) return;
    const initialSecurity = initial?.security ?? null;
    setAccountKeyBootstrapEligibility(
      scope,
      fields.enrollmentId,
      initialSecurity?.canConfigure === true &&
        initialSecurity.bootstrapEnrollmentId === fields.enrollmentId,
    );

    // This pull is read-only at the wire boundary. It can receive an ADK
    // wrap while Sync is paused, but cannot upload application changes.
    queueOwnDeviceIdentityForOnboarding(onboardingFence);
    await readOnlySyncPull(onboardingFence, { identityOnlyWrite: true });
    assertSessionFence(onboardingFence);

    const refreshed = await reconcileDeviceTrust(scope, current);
    if (!current()) return;
    const security = refreshed?.security ?? initialSecurity;
    const policyEnabled = keyringOnboardingPolicyEnabled(security);
    if (ownIdentityBound) {
      applyAutomaticAuthenticatedTrust(scope, fields.enrollmentId, refreshed, current);
    }

    if (!hasAccountKey(scope) && security?.canConfigure === true) {
      const bootstrapAuthorized = security.bootstrapEnrollmentId === fields.enrollmentId;
      setAccountKeyBootstrapEligibility(scope, fields.enrollmentId, bootstrapAuthorized);
      if (bootstrapAuthorized && canProvisionAccountKey(scope, fields.enrollmentId)) {
        // Only the server-selected first enrollment may mint, and the keyring
        // repeats its pull/peer/quarantine gates before creating ADK v1.
        provisionAccountKey(scope);
      }
    }
    shouldRetry = !hasAccountKey(scope) && (policyEnabled === true || policyEnabled === null);
  } catch {
    shouldRetry =
      fence !== null && !isSyncEnabled() && !hasAccountKey(fence.scope);
  } finally {
    keyringOnboardingRunning = false;
    lastKeyringOnboardingAttemptAt = attemptAt;
    if (
      options.scheduleRetry !== false &&
      shouldRetry &&
      fence !== null &&
      !isSyncEnabled() &&
      sessionFenceIsCurrent(fence)
    ) {
      scheduleKeyringOnboardingPoll();
    } else if (!shouldRetry || (fence !== null && hasAccountKey(fence.scope))) {
      stopKeyringOnboardingPoll();
    }
  }
}

/** Reports this device's completed rotations to the account object. */
async function flushRotationReports(scope: SyncScope): Promise<void> {
  for (const rotation of pendingRotationReports(scope)) {
    try {
      await accountRpc<KeyringReportResult>('keyring.report', {
        rotationId: rotation.rotationId,
        revokedEnrollmentIds: rotation.revokedEnrollmentIds,
        toVersion: rotation.toVersion,
      });
      markRotationReported(scope, rotation.rotationId);
    } catch {
      // A transient backend failure is retried on the next sync cycle.
    }
  }
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
  const scope = currentScope();
  if (scope === null || result.approvals.every((approval) => approval.sealedDetails === undefined))
    return result.approvals;
  const { job } = await accountRpc<JobGetResult>('job.get', { jobId });
  const key = taskKeyFor(scope, job.id) ?? taskKeyFor(scope, `req:${job.requestId}`);
  return result.approvals.map((approval) => {
    if (approval.sealedDetails === undefined || key === null) return approval;
    try {
      const value = unsealTaskResult(
        scope,
        job.id,
        approval.attemptId,
        key,
        approval.sealedDetails,
      ) as { actionDigest?: unknown; details?: unknown };
      return value.actionDigest === approval.actionDigest && typeof value.details === 'string'
        ? { ...approval, details: value.details }
        : approval;
    } catch {
      return approval;
    }
  });
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

// ---- Browser dashboard grants (DASH-01) ------------------------------------
// Approval surface for browser authorization requests. The local mirror in
// mesh_dashboard_grants is refreshed by the sync loop; decisions go through
// dashboard-grant.service which seals the DSK grant + snapshot.

function requireDashboardScope(): SyncScope {
  const scope = currentScope();
  if (scope === null) {
    throw new Error('Sign in before managing dashboard access.');
  }
  return scope;
}

export function listDashboardRequests(): SyncDashboardRequest[] {
  return listDashboardGrants(requireDashboardScope()).map((row) => ({
    requestId: row.requestId,
    ...(row.request?.targetEnrollmentId === undefined
      ? {}
      : { targetEnrollmentId: row.request.targetEnrollmentId }),
    ...(row.request === null
      ? {}
      : {
          firstMachinePairing:
            row.request.targetEnrollmentId !== undefined &&
            row.request.scopes.length === 0 &&
            (row.request.workspaceBindings?.length ?? 0) === 0,
        }),
    browserPub: row.browserPub,
    ...(row.request?.challenge === undefined
      ? {}
      : {
          verificationCode: createHash('sha256')
            .update(`${row.browserPub}|${row.request.challenge}`)
            .digest('hex')
            .slice(0, 12)
            .toUpperCase()
            .match(/.{1,4}/g)
            ?.join('-'),
        }),
    scopes: row.scopes,
    expiresAt: row.expiresAt,
    seq: row.seq,
    state: row.state,
    ...(row.request?.origin === undefined ? {} : { origin: row.request.origin }),
    ...(row.request?.userAgent === undefined ? {} : { userAgent: row.request.userAgent }),
    ...(row.workspace === null ? {} : { workspace: row.workspace }),
    ...(row.enrollmentId === null ? {} : { enrollmentId: row.enrollmentId }),
  }));
}

export function listDashboardWorkspaces(): SyncDashboardGrantWorkspace[] {
  requireDashboardScope();
  return listDashboardGrantWorkspaces();
}

export async function approveDashboardGrant(
  requestId: string,
  approval?: SyncDashboardGrantApproval,
): Promise<SyncDashboardGrantDecisionResult> {
  if (approval === undefined) {
    throw new Error('Choose a workspace, repository, and action permissions before approving.');
  }
  return approveDashboardRequest(requireDashboardScope(), requestId, {
    workspace: {
      workspaceId: approval.workspaceId,
      repoIds: approval.repoIds,
    },
    scopes: approval.actionScopes,
    rememberBrowser: approval.rememberBrowser,
  });
}

export async function denyDashboardGrant(
  requestId: string,
): Promise<SyncDashboardGrantDecisionResult> {
  await denyDashboardRequest(requireDashboardScope(), requestId);
  return { decision: 'denied', rememberedBrowser: false, sessionOnly: false };
}

export async function revokeDashboardAccess(requestId: string): Promise<void> {
  await revokeDashboardGrant(requireDashboardScope(), requestId);
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
  cloudAuthChoice?: RemoteCodexAccountAuthChoice,
): Promise<InitiateHandoffResult> {
  return initiateHandoff({ sessionId, targetEnrollmentId, cloudAuthChoice });
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
  if (!sessionBoundToBackend(backend, fields)) {
    return;
  }
  try {
    const snapshot = await service.refreshSession(refreshAgainst(backend, fetchOverride));
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
    if (generation !== runtimeGeneration) {
      return;
    }
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
  if (fields.backendId !== backend.id) {
    if (fields.backendId === null) {
      throw new Error('This saved device session is not bound to this backend. Sign in again.');
    }
    throw new Error('This device session belongs to a different backend. Sign out first.');
  }
  runtimeGeneration += 1;
  stopKeyringOnboardingPoll();
  activateBackend(backend.id);
  const scope: SyncScope = {
    backendId: backend.id,
    accountId: fields.accountId,
    datasetEpoch: fields.datasetEpoch,
  };
  ensureCurrentEnrollment();
  bindLocalEntities(scope);
  // Enrollment can complete while the backend is still paused. In that case
  // the post-enrollment bootstrap ran before `currentScope()` existed, so
  // publish the device identity again when Sync is actually enabled. This
  // also marks the first device trusted locally before key provisioning.
  initializeSyncCrypto();
  meshHostPool?.start();
  syncLocalMeshHostListener();
  connectLiveChannel();
  armFallbackPoll();
  armDashboardCommandPump();
  meshWorkerOnSyncReady();
  remoteChatOnReady();
  startHandoffRecovery();
  void reconcileHandoffsWhenReady().catch((error: unknown) => {
    console.warn('[Sync] Handoff recovery will retry on reconnect:', error);
  });
  // Fire-and-forget kick: a superseded/backoff rejection must not surface as
  // an unhandled rejection; the error is already recorded in `lastError`.
  void requestSync().catch(() => undefined);
  return getRuntimeStatus();
}

export async function signOutSync(): Promise<SyncRuntimeStatus> {
  // Fence first: any in-flight engine work from the old session fails its
  // generation check at the next durable write.
  runtimeGeneration += 1;
  deviceIdentityBindings.clear();
  clearCompanionAuthCaches();
  stopPolling();
  clearSessionRefresh();
  teardownLiveChannel();
  const backend = pinnedBackend();
  const service = requireAuth();
  const fields = service.getSessionScopeFields();
  if (backend !== null && sessionBoundToBackend(backend, fields)) {
    try {
      await service.revokeSession(revokeAgainst(backend));
    } catch {
      // Best effort: the local session is wiped regardless.
    }
  }
  service.signOutLocal();
  disconnectBackend();
  meshHostPool?.stop();
  syncLocalMeshHostListener();
  configureMeshManagedEndpointLifecycle(null);
  keyRotationBlockedScopeKey = null;
  meshWorkerOnSyncGone();
  remoteChatOnGone();
  stopHandoffRecovery();
  meshObserverOnGone();
  lastError = null;
  sessionExpired = false;
  pendingPairingRedemption = null;
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
    datasetEpoch: scope?.datasetEpoch ?? null,
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
    meshHost: getMeshMachineHostStatus(),
    meshHosts: meshHostPool?.statuses() ?? [],
    hosted: scope === null ? null : hostedStatusFor(scope.backendId, scope.accountId),
    lastError,
    lastPushAt: snapshot?.lastPushAt ?? null,
    lastPullAt: snapshot?.lastPullAt ?? null,
  };
}

/**
 * Stop long-lived runtime activity for a one-shot daemon command while
 * keeping the reviewed backend and signed-in session available for the
 * command's final RPC. This is deliberately different from sign-out: the
 * persisted session and account binding remain intact for the next `run`.
 */
export function stopSyncRuntimeForOneShot(): void {
  runtimeGeneration += 1;
  stopPolling();
  clearSessionRefresh();
  teardownLiveChannel();
  meshHostPool?.stop();
  configureMeshManagedEndpointLifecycle(null);
  meshWorkerOnSyncGone();
  remoteChatOnGone();
  stopHandoffRecovery();
  meshObserverOnGone();
}

/**
 * Refresh the authoritative device roster before a one-shot security
 * command. Device verification and approval must use the current published
 * identities, rather than whatever roster a previous sync happened to cache.
 * The sync cycle is bounded and all timers/sockets are stopped before and
 * after it so the daemon process can return to its shell prompt.
 */
export async function refreshDeviceIdentitiesForOneShot(): Promise<void> {
  if (!isSyncEnabled()) {
    const backend = requireReviewedBackend();
    const fields = requireAuth().getSessionScopeFields();
    if (fields === null) throw new Error('Enroll this device before refreshing identities.');
    if (fields.backendId !== backend.id) {
      if (fields.backendId === null) {
        throw new Error('This saved device session is not bound to this backend. Sign in again.');
      }
      throw new Error('This device session belongs to a different backend. Sign out first.');
    }
    // `enableSync()` starts the socket, fallback poll, worker lease, and a
    // fire-and-forget cycle. Security commands need the same local bootstrap
    // without any of those long-lived activities.
    runtimeGeneration += 1;
    activateBackend(backend.id);
    ensureCurrentEnrollment();
    initializeSyncCrypto();
  }
  stopSyncRuntimeForOneShot();
  await requestSyncWithin(15_000);
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
    fundedBy: row.fundedBy,
    organizationId: row.organizationId,
    deviceLimit: row.deviceLimit,
    previewEndsAt: row.previewEndsAt,
    accessUntil: row.accessUntil,
    graceUntil: row.graceUntil,
    checkedAt: row.checkedAt,
    reason: row.reason,
    restricted: isHostedWritePaused(row),
    fairUse: fairUseStatusFor(backendId, accountId),
  };
}

function fairUseStatusFor(backendId: string, accountId: string): SyncFairUseStatus | null {
  return lastFairUseStatus?.backendId === backendId && lastFairUseStatus.accountId === accountId
    ? lastFairUseStatus.status
    : null;
}

function normalizeFairUseStatus(value: unknown): SyncFairUseStatus | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const status = record['status'];
  const usage = record['usage'];
  if (
    (status !== 'clear' && status !== 'notice' && status !== 'restricted') ||
    typeof usage !== 'object' ||
    usage === null ||
    Array.isArray(usage)
  ) {
    return null;
  }
  const usageRecord = usage as Record<string, unknown>;
  if (
    !Number.isSafeInteger(usageRecord['historyBytes']) ||
    (usageRecord['historyBytes'] as number) < 0 ||
    !Number.isSafeInteger(usageRecord['artifactBytes']) ||
    (usageRecord['artifactBytes'] as number) < 0
  ) {
    return null;
  }
  const rawNotice = record['notice'];
  if (rawNotice === undefined) {
    return {
      status,
      usage: {
        historyBytes: usageRecord['historyBytes'] as number,
        artifactBytes: usageRecord['artifactBytes'] as number,
      },
    };
  }
  if (typeof rawNotice !== 'object' || rawNotice === null || Array.isArray(rawNotice)) return null;
  const notice = rawNotice as Record<string, unknown>;
  const code = notice['code'];
  const message = notice['message'];
  const noticeAt = notice['noticeAt'];
  const restrictAt = notice['restrictAt'];
  const emergency = notice['emergency'];
  if (
    (code !== 'storage-usage' &&
      code !== 'sustained-excessive-usage' &&
      code !== 'service-protection') ||
    typeof message !== 'string' ||
    message.trim().length === 0 ||
    message.length > 500 ||
    typeof noticeAt !== 'string' ||
    !Number.isFinite(Date.parse(noticeAt)) ||
    typeof restrictAt !== 'string' ||
    !Number.isFinite(Date.parse(restrictAt)) ||
    typeof emergency !== 'boolean'
  ) {
    return null;
  }
  return {
    status,
    usage: {
      historyBytes: usageRecord['historyBytes'] as number,
      artifactBytes: usageRecord['artifactBytes'] as number,
    },
    notice: { code, message, noticeAt, restrictAt, emergency },
  };
}

function recordFairUseStatus(pair: { backendId: string; accountId: string }, value: unknown): void {
  lastFairUseStatus = {
    ...pair,
    status: value === undefined || value === null ? null : normalizeFairUseStatus(value),
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
 * row is deleted rather than left gating.
 */
function recordEntitlement(
  pair: { backendId: string; accountId: string },
  entitlement: HostedEntitlement | null,
): void {
  if (entitlement === null) {
    clearSyncEntitlement(pair.backendId, pair.accountId);
    return;
  }
  upsertSyncEntitlement({
    backendId: pair.backendId,
    accountId: pair.accountId,
    state: entitlement.state,
    source: entitlement.source,
    planKey: entitlement.planKey,
    fundedBy: entitlement.fundedBy,
    organizationId: entitlement.organizationId,
    deviceLimit: entitlement.limits.devices,
    previewEndsAt: entitlement.previewEndsAt,
    accessUntil: entitlement.accessUntil,
    graceUntil: entitlement.graceUntil,
    checkedAt: entitlement.checkedAt,
    revision: entitlement.revision,
    reason: entitlement.reason,
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
    !sessionBoundToBackend(backend, fields)
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
      recordFairUseStatus(
        { backendId: backend.id, accountId: fields.accountId },
        result.accountStats?.fairUse,
      );
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
 * returning from account settings re-checks `session.describe`. No access
 * state is accepted from a URL; the backend remains the source of truth.
 */
export function onAppFocus(): void {
  maybeRefreshHostedEntitlement();
  kickKeyringOnboardingPoll();
}

/** Opens the fixed hosted account page in the system browser. */
export async function openHostedAccountPage(): Promise<void> {
  const { app, shell } = await import('electron');
  await shell.openExternal(
    resolveHostedAccountUrl(process.env.ANVIL_HOSTED_ACCOUNT_URL, app.isPackaged),
  );
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
  const fields = auth?.getSessionScopeFields() ?? null;
  if (
    backend !== null &&
    token !== null &&
    fields !== null &&
    sessionBoundToBackend(backend, fields)
  ) {
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
      recordFairUseStatus({ backendId: backend.id, accountId: fields.accountId }, remote?.fairUse);
      // Same describe payload keeps the hosted row fresh without an extra
      // call; an omitted field (self-host) clears it.
      recordEntitlement(
        { backendId: backend.id, accountId: fields.accountId },
        result.result.entitlement ?? null,
      );
    } catch {
      remote = null;
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    protocol: PROTOCOL,
    profile: PROFILES[0],
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
      if (sessionExpired) {
        throw new Error('Sync session expired; sign in again.');
      }
      if (!isSyncEnabled()) return;
    }
  }
  const backend = getActiveBackend();
  const fields = auth?.getSessionScopeFields() ?? null;
  const token = auth?.getAccessToken() ?? null;
  if (!backend || !fields || token === null || !sessionBoundToBackend(backend, fields)) return;
  const allowLoopbackHttp = shouldAllowLoopbackHttp(backend.baseUrl);
  const paths = resolveBackendPaths(backend.baseUrl, backend.descriptor, { allowLoopbackHttp });
  const scope: SyncScope = {
    backendId: backend.id,
    accountId: fields.accountId,
    datasetEpoch: fields.datasetEpoch,
  };
  const generation = runtimeGeneration;
  const fetchFn = fetchOverride;
  const cycleRpc: SyncEngineRpc | undefined =
    rpcOverride ??
    (fetchFn === undefined
      ? undefined
      : (connection, operation, params, accessToken) =>
          backendRpc(connection, operation, params, accessToken, { fetchFn }));
  const guard = (): boolean => {
    if (generation !== runtimeGeneration) return false;
    const active = getActiveBackend();
    const sessionFields = auth?.getSessionScopeFields() ?? null;
    const activeToken = auth?.getAccessToken() ?? null;
    return (
      active !== null &&
      !active.identityReviewRequired &&
      sessionFields !== null &&
      sessionFields.backendId === scope.backendId &&
      activeToken === token &&
      active.id === scope.backendId &&
      sessionFields.accountId === scope.accountId &&
      sessionFields.datasetEpoch === scope.datasetEpoch
    );
  };
  try {
    const fence = { scope, enrollmentId: fields.enrollmentId, generation };
    let ownIdentityBound = false;
    try {
      await bindCurrentDeviceIdentity(fence);
      ownIdentityBound = guard();
    } catch {
      // Manual verification remains available if automatic identity binding
      // cannot complete, including during a transient connection failure.
    }
    // Reconcile the authoritative device roster before pushing anything. A
    // remote revoke must rotate the local account key first; a roster failure
    // therefore fails closed instead of allowing another encrypted write.
    const trustSnapshot = await reconcileDeviceTrust(scope, guard);
    if (!guard()) return;
    // A first device may choose to continue without setting up recovery yet.
    // Refresh the server-authorized bootstrap decision before the engine can
    // mint its first local account key; local absence of peers is insufficient.
    if (!hasAccountKey(scope)) {
      const security = await accountRpc<SecurityView>('security.get', {});
      if (!guard()) return;
      setAccountKeyBootstrapEligibility(
        scope,
        fields.enrollmentId,
        security.canConfigure === true && security.bootstrapEnrollmentId === fields.enrollmentId,
      );
    }
    await runSyncCycle({
      scope,
      enrollmentId: fields.enrollmentId,
      connection: { apiUrl: paths.apiUrl, limits: backend.descriptor.limits },
      accessToken: token,
      // Pause account/security restrictions while reads and control stay
      // available.
      writeGate: () => ({
        allowed:
          !isHostedWritePaused(getSyncEntitlement(scope.backendId, scope.accountId)) &&
          keyRotationBlockedScopeKey !== runtimeScopeKey(scope),
      }),
      rpc: cycleRpc,
      guard,
    });
    if (!guard()) return;
    const automaticTrustChanged = ownIdentityBound
      ? applyAutomaticAuthenticatedTrust(scope, fields.enrollmentId, trustSnapshot, guard)
      : false;
    lastError = null;
    if (guard()) {
      // Rotation reports ride the same cadence — a finished rotation is
      // never left to a manual refresh.
      await flushRotationReports(scope).catch(() => undefined);
      // Pairing/recovery may have delivered a newer key version. Refreshing
      // the opaque bundle is harmless when unchanged and remains blocked by
      // the local invalidation fence after a revocation.
      await refreshDeviceRecovery().catch(() => undefined);
      await serviceDashboardGrants(scope, guard).catch(() => undefined);
    }
    if (automaticTrustChanged && guard()) {
      // Trust was recorded after this cycle's push phase. Kick one bounded
      // follow-up so a newly-created recipient wrap reaches the backend now.
      const followupGeneration = generation;
      setTimeout(() => {
        if (followupGeneration === runtimeGeneration && isSyncEnabled()) {
          void requestSync().catch(() => undefined);
        }
      }, 0).unref?.();
    }
  } catch (error) {
    if (!guard()) return;
    lastError = error instanceof Error ? error.message : String(error);
    if (error instanceof SyncEngineError && !error.retryable && error.code === 'unauthenticated') {
      sessionExpired = true;
    }
    if (error instanceof BackendRpcError && !error.retryable && error.code === 'unauthenticated') {
      sessionExpired = true;
    }
    throw error;
  }
}

export function onBackendDisconnected(): void {
  runtimeGeneration += 1;
  stopPolling();
  teardownLiveChannel();
  meshHostPool?.stop();
  configureMeshManagedEndpointLifecycle(null);
  meshWorkerOnSyncGone();
  remoteChatOnGone();
  stopHandoffRecovery();
  meshObserverOnGone();
  syncLocalMeshHostListener();
}

/**
 * OS sleep/wake hook (index.ts wires `powerMonitor.on('resume')` here): the
 * socket may have died silently while suspended, so reconnect and kick a
 * catch-up cycle. Generation-fenced inside like any other trigger.
 */
export function onSystemResume(): void {
  if (isSyncEnabled()) {
    connectLiveChannel();
    void requestSync().catch(() => undefined);
  } else {
    kickKeyringOnboardingPoll();
  }
}

function startKeyringOnboardingPoll(): void {
  if (isSyncEnabled()) {
    stopKeyringOnboardingPoll();
    return;
  }
  if (keyringOnboardingTimer !== null || keyringOnboardingRunning) return;
  keyringOnboardingAttempt = 0;
  void runKeyringOnboardingCycle();
}

function kickKeyringOnboardingPoll(): void {
  if (isSyncEnabled() || keyringOnboardingRunning) return;
  if (Date.now() - lastKeyringOnboardingAttemptAt < 30_000) return;
  if (keyringOnboardingTimer !== null) {
    clearTimeout(keyringOnboardingTimer);
    keyringOnboardingTimer = null;
  }
  void runKeyringOnboardingCycle();
}

function scheduleKeyringOnboardingPoll(): void {
  if (
    isSyncEnabled() ||
    keyringOnboardingTimer !== null ||
    auth?.getPublicSnapshot().state !== 'signed-in'
  ) {
    return;
  }
  const delay = Math.min(
    KEYRING_ONBOARDING_MAX_MS,
    KEYRING_ONBOARDING_MIN_MS * 2 ** Math.min(keyringOnboardingAttempt, 4),
  );
  keyringOnboardingAttempt += 1;
  keyringOnboardingTimer = setTimeout(() => {
    keyringOnboardingTimer = null;
    void runKeyringOnboardingCycle();
  }, delay);
  keyringOnboardingTimer.unref?.();
}

function stopKeyringOnboardingPoll(): void {
  if (keyringOnboardingTimer !== null) {
    clearTimeout(keyringOnboardingTimer);
    keyringOnboardingTimer = null;
  }
  keyringOnboardingAttempt = 0;
}

/**
 * Bounded fallback: the live channel drives prompt sync; this timer only
 * guarantees eventual progress (and reconnect attempts) when the socket is
 * down, dropping to a slow safety-net cadence while it is live.
 */
function armFallbackPoll(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (liveState === 'live' || !isSyncEnabled()) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    if (!isSyncEnabled()) return;
    connectLiveChannel();
    void requestSync()
      .catch(() => {
        // lastError is recorded inside requestSync.
      })
      .finally(armFallbackPoll);
  }, boundedFallbackDelay());
  pollTimer.unref?.();
}

function armDashboardCommandPump(): void {
  stopDashboardCommandPump();
  if (!isSyncEnabled() || meshHostPool?.statuses().some((host) => host.state === 'live')) return;
  dashboardCommandPumpTimer = setTimeout(() => {
    dashboardCommandPumpTimer = null;
    if (!isSyncEnabled() || meshHostPool?.statuses().some((host) => host.state === 'live')) return;
    const scope = currentScope();
    if (scope === null) {
      armDashboardCommandPump();
      return;
    }
    const generation = runtimeGeneration;
    void pumpBrowserWorkspaceCommands(
      scope,
      () => generation === runtimeGeneration && isSyncEnabled(),
    )
      .catch(() => undefined)
      .finally(armDashboardCommandPump);
  }, boundedFallbackDelay());
  dashboardCommandPumpTimer.unref?.();
}

function boundedFallbackDelay(): number {
  return FALLBACK_MIN_MS + Math.floor(Math.random() * (FALLBACK_MAX_MS - FALLBACK_MIN_MS + 1));
}

function stopDashboardCommandPump(): void {
  if (dashboardCommandPumpTimer === null) return;
  clearTimeout(dashboardCommandPumpTimer);
  dashboardCommandPumpTimer = null;
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  stopDashboardCommandPump();
  stopKeyringOnboardingPoll();
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
  const fields = auth?.getSessionScopeFields() ?? null;
  const token = auth?.getAccessToken() ?? null;
  if (!backend || token === null || !sessionBoundToBackend(backend, fields)) {
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
        meshHostPool?.start();
        syncLocalMeshHostListener();
        // Catch up anything missed while the channel was down.
        meshWorkerOnSyncReady();
        remoteChatOnReady();
        startHandoffRecovery();
        void reconcileHandoffsWhenReady().catch((error: unknown) => {
          console.warn('[Sync] Handoff recovery will retry on reconnect:', error);
        });
        meshObserverOnLive();
        maybeRefreshHostedEntitlement();
        void requestSync().catch(() => undefined);
        break;
      case 'sync.invalidate':
        void meshHostPool?.refresh().catch(() => undefined);
        void requestSync().catch(() => undefined);
        break;
      case 'job.available':
        void meshHostPool?.refresh().catch(() => undefined);
        void handleJobAvailable(frame.jobId).catch(() => undefined);
        break;
      case 'worker.available':
        void meshHostPool?.refresh().catch(() => undefined);
        break;
      case 'activity':
        notifyMeshWorkerAttemptEvent(frame.attemptId);
        handleActivityFrame(frame);
        break;
      case 'gap':
        // Attempt-stream gap — the observer replays the durable journal.
        notifyMeshWorkerAttemptEvent(frame.attemptId);
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

let handoffReconciliationInFlight: Promise<void> | null = null;
function reconcileHandoffsWhenReady(): Promise<void> {
  if (handoffReconciliationInFlight !== null) return handoffReconciliationInFlight;
  handoffReconciliationInFlight = reconcileHandoffsOnBoot().finally(() => {
    handoffReconciliationInFlight = null;
  });
  return handoffReconciliationInFlight;
}

let handoffRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
function startHandoffRecovery(): void {
  if (handoffRecoveryTimer !== null || !hasPendingHandoffRecovery()) return;
  handoffRecoveryTimer = setTimeout(() => {
    handoffRecoveryTimer = null;
    void reconcileHandoffsWhenReady()
      .catch((error: unknown) => {
        console.warn('[Sync] Handoff recovery will retry:', error);
      })
      .finally(startHandoffRecovery);
  }, boundedFallbackDelay());
  handoffRecoveryTimer.unref?.();
}

function hasPendingHandoffRecovery(): boolean {
  const scope = currentScope();
  if (scope === null) return false;
  const row = getDb()
    .prepare(
      `SELECT 1 FROM mesh_handoff_journal
       WHERE backend_id = ? AND account_id = ? AND scope_epoch = ?
         AND state NOT IN ('completed', 'cancelled', 'failed')
       LIMIT 1`,
    )
    .get(scope.backendId, scope.accountId, scope.datasetEpoch);
  return row !== undefined;
}

function stopHandoffRecovery(): void {
  if (handoffRecoveryTimer === null) return;
  clearTimeout(handoffRecoveryTimer);
  handoffRecoveryTimer = null;
}
