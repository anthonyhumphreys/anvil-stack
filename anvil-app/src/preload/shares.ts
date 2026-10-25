import { ipcRenderer } from 'electron';
import type { SharesApi } from '../shared/shares-ipc.js';

export const sharesBridge: SharesApi = {
  pickupPending: () => ipcRenderer.invoke('shares:pickup-pending'),
  onPickupRequested: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('shares:pickup-requested', handler);
    return () => ipcRenderer.removeListener('shares:pickup-requested', handler);
  },
  preparePickup: () => ipcRenderer.invoke('shares:prepare-pickup'),
  confirmPickup: (input) => ipcRenderer.invoke('shares:confirm-pickup', input),
  cancelPickup: (id) => ipcRenderer.invoke('shares:cancel-pickup', id),
  available: () => ipcRenderer.invoke('shares:available'),
  accessOptions: () => ipcRenderer.invoke('shares:access-options'),
  previewTicket: (id, ticket) => ipcRenderer.invoke('shares:preview-ticket', id, ticket),
  attachTicket: (id, ticket) => ipcRenderer.invoke('shares:attach-ticket', id, ticket),
  preview: (target, options) => ipcRenderer.invoke('shares:preview', target, options),
  publish: (target, options) => ipcRenderer.invoke('shares:publish', target, options),
  update: (shareRecordId, options) => ipcRenderer.invoke('shares:update', shareRecordId, options),
  revoke: (shareRecordId) => ipcRenderer.invoke('shares:revoke', shareRecordId),
  list: (filter) => ipcRenderer.invoke('shares:list', filter),
  copyLink: (shareRecordId) => ipcRenderer.invoke('shares:copy-link', shareRecordId),
};
