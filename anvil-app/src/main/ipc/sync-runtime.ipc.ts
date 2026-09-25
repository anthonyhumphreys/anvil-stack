import { ipcMain } from 'electron';
import {
  approveDashboardGrant,
  addCloudProviderConnection,
  cancelMeshJob,
  commitDataImport,
  decideMeshApproval,
  denyDashboardGrant,
  deviceVerificationCode,
  approveDeviceTrust,
  enableSync,
  enrollWithEnrollmentCode,
  exportAccountDataToFile,
  exportSyncDiagnostics,
  getMeshApprovals,
  getMeshJob,
  getRuntimeStatus,
  getDeviceSecurityStatus,
  getSessionMeshState,
  initiateSessionHandoff,
  issueEnrollmentCode,
  listConflictViews,
  listCloudEnvironments,
  listCloudProviderConnections,
  listLocalCloudEnvironments,
  listDashboardWorkspaces,
  openHostedAccountPage,
  refreshHostedEntitlement,
  reapCloudEnvironment,
  requestCloudEnvironment,
  listDashboardRequests,
  listDevices,
  listMeshHandoffs,
  listMeshJobs,
  observeAttemptActivity,
  previewAdoption,
  previewDataImportFromFile,
  renameDevice,
  resolveRuntimeConflict,
  revokeDashboardAccess,
  revokeDevice,
  removeCloudProviderConnection,
  replaceDeviceRecovery,
  resetEncryptedSyncAccount,
  setNewDeviceTrustPolicy,
  setMeshWorkerOptIn,
  setupDeviceRecovery,
  signInWithOidc,
  signOutSync,
  spikeEnroll,
  unlockDeviceRecovery,
} from '../services/sync-runtime.service.js';
import type {
  SyncDeviceTrustPolicy,
  SyncEncryptedSyncAccountResetConfirmation,
} from '../../shared/sync-device-security.js';
import type { ApprovalDecision } from '../../../cloud/contract/jobs.js';
import {
  isEnvironmentProviderId,
  type EnvironmentProviderId,
} from '../../../cloud/contract/environment.js';
import { DASHBOARD_WORKSPACE_SCOPES } from '../services/dashboard-grant.service.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDeviceTrustPolicy(value: unknown): value is SyncDeviceTrustPolicy {
  return value === 'require-approval' || value === 'auto-trust-authenticated';
}

export function registerSyncRuntimeHandlers(): void {
  ipcMain.handle('sync-runtime:status', () => getRuntimeStatus());

  ipcMain.handle('sync-runtime:cloud-provider-connections-list', () =>
    listCloudProviderConnections(),
  );

  ipcMain.handle('sync-runtime:cloud-provider-connection-add', (_event, payload: unknown) => {
    if (!isRecord(payload) || !isEnvironmentProviderId(payload['provider'])) {
      throw new Error('cloud-provider-connection-add requires a known provider');
    }
    const config = payload['config'];
    if (!isRecord(config)) {
      throw new Error('cloud-provider-connection-add requires a config object');
    }
    const displayName = payload['displayName'];
    const secret = payload['secret'];
    if (displayName !== undefined && typeof displayName !== 'string') {
      throw new Error('cloud-provider-connection-add displayName must be a string');
    }
    if (secret !== undefined && typeof secret !== 'string') {
      throw new Error('cloud-provider-connection-add secret must be a string');
    }
    return addCloudProviderConnection({
      provider: payload['provider'] as EnvironmentProviderId,
      config,
      ...(displayName === undefined ? {} : { displayName }),
      ...(secret === undefined ? {} : { secret }),
    });
  });

  ipcMain.handle(
    'sync-runtime:cloud-provider-connection-remove',
    (_event, connectionId: unknown) => {
      if (typeof connectionId !== 'string' || connectionId.trim() === '') {
        throw new Error('cloud-provider-connection-remove requires a connection id');
      }
      return removeCloudProviderConnection(connectionId);
    },
  );

  ipcMain.handle('sync-runtime:cloud-environments-local-list', () => listLocalCloudEnvironments());

  ipcMain.handle('sync-runtime:cloud-environments-list', (_event, includeTerminal: unknown) =>
    listCloudEnvironments(includeTerminal === true),
  );

  ipcMain.handle('sync-runtime:cloud-environment-request', (_event, payload: unknown) => {
    if (!isRecord(payload) || !isEnvironmentProviderId(payload['provider'])) {
      throw new Error('cloud-environment-request requires a known provider');
    }
    const ttlSeconds = payload['ttlSeconds'];
    if (
      typeof ttlSeconds !== 'number' ||
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 60 ||
      ttlSeconds > 7 * 24 * 60 * 60
    ) {
      throw new Error(
        'cloud-environment-request ttlSeconds must be a whole number from 60 seconds to 7 days',
      );
    }
    const optionalStringKeys = [
      'environmentId',
      'imageRef',
      'displayName',
      'connectionId',
    ] as const;
    for (const key of optionalStringKeys) {
      if (payload[key] !== undefined && typeof payload[key] !== 'string') {
        throw new Error(`cloud-environment-request ${key} must be a string`);
      }
    }
    const networkPolicy = payload['networkPolicy'];
    if (
      networkPolicy !== undefined &&
      (!Array.isArray(networkPolicy) || !networkPolicy.every((entry) => typeof entry === 'string'))
    ) {
      throw new Error('cloud-environment-request networkPolicy must be a string array');
    }
    const resources = payload['resources'];
    if (resources !== undefined && !isRecord(resources)) {
      throw new Error('cloud-environment-request resources must be an object');
    }
    if (resources !== undefined) {
      for (const [key, value] of Object.entries(resources)) {
        if (key !== 'vcpus' && key !== 'memoryMb') {
          throw new Error(`cloud-environment-request has unknown resource ${key}`);
        }
        if (
          value !== undefined &&
          (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
        ) {
          throw new Error(`cloud-environment-request ${key} must be a positive whole number`);
        }
      }
    }
    return requestCloudEnvironment({
      provider: payload['provider'] as EnvironmentProviderId,
      ttlSeconds,
      ...(payload['environmentId'] === undefined
        ? {}
        : { environmentId: payload['environmentId'] as string }),
      ...(payload['imageRef'] === undefined ? {} : { imageRef: payload['imageRef'] as string }),
      ...(networkPolicy === undefined ? {} : { networkPolicy: networkPolicy as string[] }),
      ...(resources === undefined
        ? {}
        : { resources: resources as { vcpus?: number; memoryMb?: number } }),
      ...(payload['displayName'] === undefined
        ? {}
        : { displayName: payload['displayName'] as string }),
      ...(payload['connectionId'] === undefined
        ? {}
        : { connectionId: payload['connectionId'] as string }),
    });
  });

  ipcMain.handle('sync-runtime:cloud-environment-reap', (_event, environmentId: unknown) => {
    if (typeof environmentId !== 'string' || environmentId.trim() === '') {
      throw new Error('cloud-environment-reap requires an environment id');
    }
    return reapCloudEnvironment(environmentId);
  });

  ipcMain.handle('sync-runtime:preview', () => previewAdoption());

  ipcMain.handle('sync-runtime:sign-in', () => signInWithOidc());

  ipcMain.handle('sync-runtime:enroll-with-code', (_event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload['code'] !== 'string') {
      throw new Error('enroll-with-code requires a code string');
    }
    return enrollWithEnrollmentCode(payload['code']);
  });

  ipcMain.handle('sync-runtime:issue-enrollment-code', () => issueEnrollmentCode());

  // Dev-fixture enrollment. The service throws when spike is not enabled
  // (production builds never enable it), so this fails closed.
  ipcMain.handle('sync-runtime:spike-enroll', (_event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload['accountId'] !== 'string') {
      throw new Error('spike enroll requires an accountId string');
    }
    const enrollmentId = payload['enrollmentId'];
    return spikeEnroll({
      accountId: payload['accountId'],
      ...(typeof enrollmentId === 'string' ? { enrollmentId } : {}),
    });
  });

  ipcMain.handle('sync-runtime:enable', () => enableSync());

  ipcMain.handle('sync-runtime:sign-out', () => signOutSync());

  ipcMain.handle('sync-runtime:conflicts', () => listConflictViews());

  ipcMain.handle('sync-runtime:diagnostics', () => exportSyncDiagnostics());

  // BILL-05: re-check hosted access via session.describe (self-host backends
  // omit the field → returns null). Explicit user/panel trigger — unthrottled.
  ipcMain.handle('sync-runtime:hosted-refresh', () => refreshHostedEntitlement());

  // Fixed https://anvil.dev/account — never derived from user input or URLs.
  ipcMain.handle('sync-runtime:open-hosted-account', () => openHostedAccountPage());

  ipcMain.handle('sync-runtime:mesh-worker-set', (_event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload['enabled'] !== 'boolean') {
      throw new Error('mesh-worker-set requires an enabled boolean');
    }
    return setMeshWorkerOptIn(payload['enabled']);
  });

  ipcMain.handle('sync-runtime:resolve-conflict', (_event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload['conflictId'] !== 'string') {
      throw new Error('resolve-conflict requires a conflictId');
    }
    const resolution = payload['resolution'];
    if (resolution !== 'keep-local' && resolution !== 'use-remote' && resolution !== 'save-copy') {
      throw new Error('resolution must be keep-local, use-remote, or save-copy');
    }
    return resolveRuntimeConflict(payload['conflictId'], resolution);
  });

  ipcMain.handle('sync-runtime:devices-list', async () => (await listDevices()).devices);

  ipcMain.handle('sync-runtime:device-rename', (_event, payload: unknown) => {
    if (
      !isRecord(payload) ||
      typeof payload['enrollmentId'] !== 'string' ||
      typeof payload['displayName'] !== 'string'
    ) {
      throw new Error('device-rename requires enrollmentId and displayName strings');
    }
    return renameDevice(payload['enrollmentId'], payload['displayName']);
  });

  ipcMain.handle('sync-runtime:device-revoke', (_event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload['enrollmentId'] !== 'string') {
      throw new Error('device-revoke requires an enrollmentId string');
    }
    return revokeDevice(payload['enrollmentId']);
  });

  ipcMain.handle('sync-runtime:device-verify', (_event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload['enrollmentId'] !== 'string') {
      throw new Error('device-verify requires an enrollmentId string');
    }
    return deviceVerificationCode(payload['enrollmentId']);
  });

  ipcMain.handle('sync-runtime:device-security-status', () => getDeviceSecurityStatus());

  ipcMain.handle('sync-runtime:device-recovery-setup', (_event, payload: unknown) => {
    if (!isRecord(payload) || !isDeviceTrustPolicy(payload['policy'])) {
      throw new Error(
        'device-recovery-setup requires a require-approval or auto-trust-authenticated policy',
      );
    }
    return setupDeviceRecovery(payload['policy']);
  });

  ipcMain.handle('sync-runtime:device-recovery-unlock', (_event, payload: unknown) => {
    if (
      !isRecord(payload) ||
      typeof payload['code'] !== 'string' ||
      payload['code'].trim() === ''
    ) {
      throw new Error('device-recovery-unlock requires a recovery code');
    }
    return unlockDeviceRecovery(payload['code'].trim());
  });

  ipcMain.handle('sync-runtime:device-trust-policy-set', (_event, payload: unknown) => {
    if (!isRecord(payload) || !isDeviceTrustPolicy(payload['policy'])) {
      throw new Error(
        'device-trust-policy-set requires a require-approval or auto-trust-authenticated policy',
      );
    }
    return setNewDeviceTrustPolicy(payload['policy']);
  });

  ipcMain.handle('sync-runtime:device-recovery-replace', () => replaceDeviceRecovery());

  ipcMain.handle('sync-runtime:encrypted-account-reset', (_event, payload: unknown) => {
    if (!isRecord(payload) || payload['confirmation'] !== 'RESET ENCRYPTED DATA') {
      throw new Error(
        'encrypted-account-reset requires the exact RESET ENCRYPTED DATA confirmation',
      );
    }
    return resetEncryptedSyncAccount(
      payload['confirmation'] as SyncEncryptedSyncAccountResetConfirmation,
    );
  });

  ipcMain.handle('sync-runtime:device-approve', (_event, payload: unknown) => {
    if (
      !isRecord(payload) ||
      typeof payload['enrollmentId'] !== 'string' ||
      payload['enrollmentId'].trim() === '' ||
      typeof payload['verificationCode'] !== 'string' ||
      payload['verificationCode'].trim() === ''
    ) {
      throw new Error('device-approve requires an enrollmentId and matching verificationCode');
    }
    return approveDeviceTrust(payload['enrollmentId'], payload['verificationCode'].trim());
  });

  // DASH-01: browser dashboard authorization — the trusted-device approval
  // surface. Grants carry scoped, sealed projections; the browser never
  // sees account key material.
  ipcMain.handle('sync-runtime:dashboard-requests', () => listDashboardRequests());
  ipcMain.handle('sync-runtime:dashboard-workspaces', () => listDashboardWorkspaces());

  ipcMain.handle('sync-runtime:dashboard-decide', (_event, payload: unknown) => {
    if (
      !isRecord(payload) ||
      typeof payload['requestId'] !== 'string' ||
      (payload['decision'] !== 'approved' && payload['decision'] !== 'denied')
    ) {
      throw new Error('dashboard-decide requires requestId and an approved|denied decision');
    }
    const approval = payload['approval'];
    if (payload['decision'] === 'approved') {
      if (!isRecord(approval)) {
        throw new Error(
          'dashboard-decide approval requires workspaceId, repoIds, and actionScopes',
        );
      }
      if (typeof approval['workspaceId'] !== 'string' || approval['workspaceId'].trim() === '') {
        throw new Error('dashboard-decide workspaceId must be a non-empty string');
      }
      const repoIds = approval['repoIds'];
      if (
        !Array.isArray(repoIds) ||
        repoIds.length === 0 ||
        !repoIds.every((repoId) => typeof repoId === 'string' && repoId.trim() !== '')
      ) {
        throw new Error('dashboard-decide repoIds must contain at least one repository');
      }
      const actionScopes = approval['actionScopes'];
      if (
        !Array.isArray(actionScopes) ||
        !actionScopes.every(
          (scope) =>
            typeof scope === 'string' &&
            DASHBOARD_WORKSPACE_SCOPES.includes(
              scope as (typeof DASHBOARD_WORKSPACE_SCOPES)[number],
            ),
        )
      ) {
        throw new Error('dashboard-decide actionScopes must be known dashboard scopes');
      }
      return approveDashboardGrant(payload['requestId'], {
        workspaceId: approval['workspaceId'],
        repoIds: repoIds as string[],
        actionScopes: actionScopes as string[],
      });
    }
    return denyDashboardGrant(payload['requestId']);
  });

  ipcMain.handle('sync-runtime:dashboard-revoke', (_event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload['requestId'] !== 'string') {
      throw new Error('dashboard-revoke requires a requestId string');
    }
    return revokeDashboardAccess(payload['requestId']);
  });

  ipcMain.handle('sync-runtime:data-export-file', () => exportAccountDataToFile());

  ipcMain.handle('sync-runtime:data-import-preview-file', () => previewDataImportFromFile());

  ipcMain.handle('sync-runtime:data-import-commit', (_event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload['operationId'] !== 'string') {
      throw new Error('data-import-commit requires an operationId string');
    }
    return commitDataImport(payload['operationId']);
  });

  ipcMain.handle('sync-runtime:mesh-jobs-list', () => listMeshJobs());

  ipcMain.handle('sync-runtime:mesh-job-get', (_event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload['jobId'] !== 'string') {
      throw new Error('mesh-job-get requires a jobId string');
    }
    return getMeshJob(payload['jobId']);
  });

  ipcMain.handle('sync-runtime:mesh-job-cancel', (_event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload['jobId'] !== 'string') {
      throw new Error('mesh-job-cancel requires a jobId string');
    }
    return cancelMeshJob(payload['jobId']);
  });

  ipcMain.handle('sync-runtime:mesh-approvals', (_event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload['jobId'] !== 'string') {
      throw new Error('mesh-approvals requires a jobId string');
    }
    return getMeshApprovals(payload['jobId']);
  });

  ipcMain.handle('sync-runtime:mesh-approval-decide', (_event, payload: unknown) => {
    if (
      !isRecord(payload) ||
      typeof payload['approvalId'] !== 'string' ||
      (payload['decision'] !== 'approved' && payload['decision'] !== 'denied')
    ) {
      throw new Error('mesh-approval-decide requires approvalId and an approved|denied decision');
    }
    const reason = payload['reason'];
    return decideMeshApproval(
      payload['approvalId'],
      payload['decision'] as ApprovalDecision,
      typeof reason === 'string' ? reason : undefined,
    );
  });

  ipcMain.handle('sync-runtime:mesh-handoffs', () => listMeshHandoffs());

  ipcMain.handle('sync-runtime:session-mesh-state', (_event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload['sessionId'] !== 'string') {
      throw new Error('session-mesh-state requires a sessionId string');
    }
    return getSessionMeshState(payload['sessionId']);
  });

  ipcMain.handle('sync-runtime:session-handoff', (_event, payload: unknown) => {
    if (
      !isRecord(payload) ||
      typeof payload['sessionId'] !== 'string' ||
      typeof payload['targetEnrollmentId'] !== 'string'
    ) {
      throw new Error('session-handoff requires sessionId and targetEnrollmentId strings');
    }
    return initiateSessionHandoff(payload['sessionId'], payload['targetEnrollmentId']);
  });

  // Attempt activity push channel: per-sender subscriptions scoped by
  // attemptId; the sender's `destroyed` releases every held subscription.
  const attemptObservers = new Map<number, Map<string, () => void>>();
  ipcMain.handle('sync-runtime:attempt-observe', (event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload['attemptId'] !== 'string') {
      throw new Error('attempt-observe requires an attemptId string');
    }
    const attemptId = payload['attemptId'];
    const sender = event.sender;
    let subs = attemptObservers.get(sender.id);
    if (subs === undefined) {
      subs = new Map();
      attemptObservers.set(sender.id, subs);
      const ownedSubscriptions = subs;
      sender.once('destroyed', () => {
        for (const unsubscribe of ownedSubscriptions.values()) unsubscribe();
        attemptObservers.delete(sender.id);
      });
    }
    // Always resubscribe rather than skip when a key exists: the service
    // drops subscriptions on sign-out/backend disconnect, and a surviving
    // map entry would otherwise swallow re-observe requests silently.
    subs.get(attemptId)?.();
    subs.set(
      attemptId,
      observeAttemptActivity(attemptId, (item) => {
        if (!sender.isDestroyed()) {
          sender.send('sync-runtime:attempt-activity', attemptId, item);
        }
      }),
    );
  });

  ipcMain.handle('sync-runtime:attempt-unobserve', (event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload['attemptId'] !== 'string') {
      throw new Error('attempt-unobserve requires an attemptId string');
    }
    const subs = attemptObservers.get(event.sender.id);
    subs?.get(payload['attemptId'])?.();
    subs?.delete(payload['attemptId']);
  });
}
