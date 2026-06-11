import { BrowserWindow, ipcMain } from 'electron';
import type { WorkspaceCreateOptions } from '../../shared/types.js';
import {
  listWorkspaces,
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  addReposToWorkspace,
  removeReposFromWorkspace,
  getWorkspacePreferences,
  updateWorkspacePreferences,
  clearWorkspacePreferences,
  exportVSCodeWorkspace,
} from '../services/workspace.service.js';
import { scanForReposAsync, cancelScan } from '../services/repo-scan.service.js';
import { ensureGateTemplates } from '../services/lifecycle.service.js';

interface WorkspaceHandlersOptions {
  openWorkspaceWindow?: (workspaceId: string) => void;
}

export function registerWorkspaceHandlers(options: WorkspaceHandlersOptions = {}): void {
  ipcMain.handle('workspace:list', () => {
    try {
      return listWorkspaces();
    } catch (err) {
      console.error('[Workspace IPC] Error listing workspaces:', err);
      throw err;
    }
  });

  ipcMain.handle('workspace:get', (_event, id: string) => {
    try {
      return getWorkspace(id);
    } catch (err) {
      console.error('[Workspace IPC] Error getting workspace:', err);
      throw err;
    }
  });

  ipcMain.handle('workspace:create', (_event, opts: WorkspaceCreateOptions) => {
    try {
      const workspace = createWorkspace(opts);
      ensureGateTemplates(workspace.id);
      return workspace;
    } catch (err) {
      console.error('[Workspace IPC] Error creating workspace:', err);
      throw err;
    }
  });

  ipcMain.handle('workspace:get-preferences', (_event, workspaceId: string) => {
    try {
      return getWorkspacePreferences(workspaceId);
    } catch (err) {
      console.error('[Workspace IPC] Error getting workspace preferences:', err);
      throw err;
    }
  });

  ipcMain.handle(
    'workspace:update-preferences',
    (
      _event,
      workspaceId: string,
      updates: {
        workitems?: Record<string, unknown>;
        docs?: Record<string, unknown>;
        launch?: Record<string, unknown>;
      },
    ) => {
      try {
        return updateWorkspacePreferences(workspaceId, updates);
      } catch (err) {
        console.error('[Workspace IPC] Error updating workspace preferences:', err);
        throw err;
      }
    },
  );

  ipcMain.handle(
    'workspace:clear-preferences',
    (_event, workspaceId: string, sections?: Array<'workitems' | 'docs' | 'launch'>) => {
      try {
        return clearWorkspacePreferences(workspaceId, sections);
      } catch (err) {
        console.error('[Workspace IPC] Error clearing workspace preferences:', err);
        throw err;
      }
    },
  );

  ipcMain.handle('workspace:update', (_event, id: string, opts: { name: string }) => {
    try {
      return updateWorkspace(id, opts);
    } catch (err) {
      console.error('[Workspace IPC] Error updating workspace:', err);
      throw err;
    }
  });

  ipcMain.handle('workspace:delete', (_event, id: string) => {
    try {
      return deleteWorkspace(id);
    } catch (err) {
      console.error('[Workspace IPC] Error deleting workspace:', err);
      throw err;
    }
  });

  ipcMain.handle('workspace:add-repos', (_event, workspaceId: string, repoIds: string[]) => {
    try {
      return addReposToWorkspace(workspaceId, repoIds);
    } catch (err) {
      console.error('[Workspace IPC] Error adding repos to workspace:', err);
      throw err;
    }
  });

  ipcMain.handle('workspace:remove-repos', (_event, workspaceId: string, repoIds: string[]) => {
    try {
      return removeReposFromWorkspace(workspaceId, repoIds);
    } catch (err) {
      console.error('[Workspace IPC] Error removing repos from workspace:', err);
      throw err;
    }
  });

  ipcMain.handle('workspace:export-vscode', async (_event, workspaceId: string) => {
    try {
      return await exportVSCodeWorkspace(workspaceId);
    } catch (err) {
      console.error('[Workspace IPC] Error exporting VS Code workspace:', err);
      throw err;
    }
  });

  ipcMain.handle('workspace:open-in-new-window', (_event, workspaceId: string) => {
    try {
      getWorkspace(workspaceId);
      if (!options.openWorkspaceWindow) {
        throw new Error('Workspace window opener is not registered');
      }
      options.openWorkspaceWindow(workspaceId);
    } catch (err) {
      console.error('[Workspace IPC] Error opening workspace in new window:', err);
      throw err;
    }
  });

  ipcMain.handle('repo:scan', async (_event, folderPath: string, maxDepth?: number) => {
    try {
      const win = BrowserWindow.getFocusedWindow();
      const repos = await scanForReposAsync(folderPath, maxDepth, (repo) => {
        win?.webContents.send('repo:scan-progress', repo);
      });
      return repos;
    } catch (err) {
      console.error('[Workspace IPC] Error scanning for repos:', err);
      throw err;
    }
  });

  ipcMain.handle('repo:cancel-scan', () => {
    try {
      cancelScan();
    } catch (err) {
      console.error('[Workspace IPC] Error cancelling scan:', err);
      throw err;
    }
  });
}
