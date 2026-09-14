import { ipcMain } from 'electron';
import {
  cancelMeshJob,
  commitDataImport,
  decideMeshApproval,
  enableSync,
  enrollWithEnrollmentCode,
  exportAccountDataToFile,
  exportSyncDiagnostics,
  getMeshApprovals,
  getMeshJob,
  getRuntimeStatus,
  getSessionMeshState,
  initiateSessionHandoff,
  issueEnrollmentCode,
  listConflictViews,
  listDevices,
  listMeshHandoffs,
  listMeshJobs,
  observeAttemptActivity,
  previewAdoption,
  previewDataImportFromFile,
  renameDevice,
  resolveRuntimeConflict,
  revokeDevice,
  setMeshWorkerOptIn,
  signInWithOidc,
  signOutSync,
  spikeEnroll,
} from '../services/sync-runtime.service.js';
import type { ApprovalDecision } from '../../../cloud/contract/jobs.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function registerSyncRuntimeHandlers(): void {
  ipcMain.handle('sync-runtime:status', () => getRuntimeStatus());

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
    if (
      resolution !== 'keep-local' &&
      resolution !== 'use-remote' &&
      resolution !== 'save-copy'
    ) {
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
      sender.once('destroyed', () => {
        for (const unsubscribe of subs.values()) unsubscribe();
        attemptObservers.delete(sender.id);
      });
    }
    if (!subs.has(attemptId)) {
      subs.set(
        attemptId,
        observeAttemptActivity(attemptId, (item) => {
          if (!sender.isDestroyed()) {
            sender.send('sync-runtime:attempt-activity', attemptId, item);
          }
        }),
      );
    }
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
