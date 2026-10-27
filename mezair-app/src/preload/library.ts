import { ipcRenderer } from 'electron';
import type { LibraryApi } from '../shared/library-ipc.js';

export const libraryBridge: LibraryApi = {
  list: (workspaceId, filter) => ipcRenderer.invoke('library:list', workspaceId, filter),
};
