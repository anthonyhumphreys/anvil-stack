import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { resolveBackendPaths } from '../../../cloud/contract/discovery.js';
import type { DeviceSession } from '../../../cloud/contract/auth.js';
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
import { createSyncAuthService, type SyncAuthService } from './sync-auth.service.js';
import {
  activateBackend,
  disconnectBackend,
  getActiveBackend,
  listBackends,
  resolveBackendIdentityReview,
  type SyncBackendRecord,
} from './sync-backend.service.js';
import { shouldAllowLoopbackHttp } from './sync-backend-client.service.js';
import {
  getSyncEngineSnapshot,
  resolveSyncConflict,
  runSyncCycle,
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

const POLL_MS = 5_000;
const SPIKE_ACCESS_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

let auth: SyncAuthService | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastError: string | null = null;
let rpcOverride: SyncEngineRpc | undefined;
/**
 * Fences async engine work: bumped on every sign-out, enrollment change, and
 * backend switch. A sync cycle captures the generation (plus its scope and
 * token) and checks both before any durable write that follows an await, so a
 * callback from an old account/backend can never mutate new-scope state.
 */
let runtimeGeneration = 0;

export function initSyncRuntime(userDataDir: string): void {
  auth = createSyncAuthService({
    userDataDir,
    installationId: getOrCreateInstallationId(),
  });
  if (isSyncEnabled()) {
    startPolling();
    void requestSync().catch(() => {
      // Last error is stored on the runtime snapshot.
    });
  }
}

export function resetSyncRuntimeForTests(): void {
  runtimeGeneration += 1;
  stopPolling();
  auth = null;
  lastError = null;
  rpcOverride = undefined;
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

export function spikeEnroll(input: SyncSpikeEnrollInput): SyncAuthPublicSnapshot {
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
  return requireAuth().installDeviceSession(session, backend.id);
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
  startPolling();
  void requestSync();
  return getRuntimeStatus();
}

export function signOutSync(): SyncRuntimeStatus {
  // Fence first: any in-flight engine work from the old session fails its
  // generation check at the next durable write.
  runtimeGeneration += 1;
  stopPolling();
  requireAuth().signOutLocal();
  disconnectBackend();
  lastError = null;
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
  void requestSync();
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
    backendIdentityReviewRequired: backend?.identityReviewRequired ?? false,
    pendingCount: snapshot?.pendingCount ?? 0,
    conflictCount: scope ? listConflicts(scope).length : 0,
    lastError,
    lastPushAt: snapshot?.lastPushAt ?? null,
    lastPullAt: snapshot?.lastPullAt ?? null,
  };
}

export async function requestSync(): Promise<void> {
  if (!isSyncEnabled()) return;
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
      rpc: rpcOverride,
      guard,
    });
    lastError = null;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

export function onBackendDisconnected(): void {
  runtimeGeneration += 1;
  stopPolling();
}

function startPolling(): void {
  if (pollTimer !== null) return;
  pollTimer = setInterval(() => {
    void requestSync().catch(() => {
      // lastError is recorded inside requestSync.
    });
  }, POLL_MS);
}

function stopPolling(): void {
  if (pollTimer === null) return;
  clearInterval(pollTimer);
  pollTimer = null;
}
