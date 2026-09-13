import { ipcMain } from 'electron';
import {
  enableSync,
  getRuntimeStatus,
  listConflictViews,
  previewAdoption,
  resolveRuntimeConflict,
  signOutSync,
  spikeEnroll,
} from '../services/sync-runtime.service.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function registerSyncRuntimeHandlers(): void {
  ipcMain.handle('sync-runtime:status', () => getRuntimeStatus());

  ipcMain.handle('sync-runtime:preview', () => previewAdoption());

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

  ipcMain.handle('sync-runtime:resolve-conflict', (_event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload['conflictId'] !== 'string') {
      throw new Error('resolve-conflict requires a conflictId');
    }
    const resolution = payload['resolution'];
    if (resolution !== 'keep-local' && resolution !== 'use-remote') {
      throw new Error('resolution must be keep-local or use-remote');
    }
    return resolveRuntimeConflict(payload['conflictId'], resolution);
  });
}
