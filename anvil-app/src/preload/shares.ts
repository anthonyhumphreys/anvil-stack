import { ipcRenderer } from 'electron';
import type { SharesApi } from '../shared/shares-ipc.js';

export const sharesBridge: SharesApi = {
  available: () => ipcRenderer.invoke('shares:available'),
  preview: (target, options) => ipcRenderer.invoke('shares:preview', target, options),
  publish: (target, options) => ipcRenderer.invoke('shares:publish', target, options),
  update: (shareRecordId, options) => ipcRenderer.invoke('shares:update', shareRecordId, options),
  revoke: (shareRecordId) => ipcRenderer.invoke('shares:revoke', shareRecordId),
  list: (filter) => ipcRenderer.invoke('shares:list', filter),
  copyLink: (shareRecordId) => ipcRenderer.invoke('shares:copy-link', shareRecordId),
};
