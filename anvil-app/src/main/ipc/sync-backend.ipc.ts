import { ipcMain } from 'electron';
import { discover, shouldAllowLoopbackHttp } from '../services/sync-backend-client.service.js';
import {
  disconnectBackend,
  getBackendStatus,
  getIntegrationPrompt,
  pinBackend,
  resolveBackendIdentityReview,
} from '../services/sync-backend.service.js';
import { onBackendDisconnected } from '../services/sync-runtime.service.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Thin IPC: validate inputs, delegate to services, return secret-free results. */
export function registerSyncBackendHandlers(): void {
  ipcMain.handle('sync-backend:discover', (_event, url: unknown) => {
    if (typeof url !== 'string' || url.trim().length === 0) {
      throw new Error('backend URL must be a non-empty string');
    }
    return discover(url, { allowLoopbackHttp: shouldAllowLoopbackHttp(url) });
  });

  ipcMain.handle('sync-backend:pin', (_event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload['baseUrl'] !== 'string') {
      throw new Error('pin payload must include a baseUrl string and a descriptor');
    }
    pinBackend({ baseUrl: payload['baseUrl'], descriptor: payload['descriptor'] });
    return getBackendStatus();
  });

  ipcMain.handle('sync-backend:status', () => getBackendStatus());

  ipcMain.handle('sync-backend:disconnect', () => {
    disconnectBackend();
    onBackendDisconnected();
    return getBackendStatus();
  });

  ipcMain.handle('sync-backend:resolve-review', (_event, payload: unknown) => {
    if (!isRecord(payload) || typeof payload['backendId'] !== 'string') {
      throw new Error('resolve-review requires a backendId');
    }
    resolveBackendIdentityReview(payload['backendId']);
    return getBackendStatus();
  });

  ipcMain.handle('sync-backend:integration-prompt', () => getIntegrationPrompt());
}
