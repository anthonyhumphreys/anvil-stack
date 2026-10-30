import { ipcMain } from 'electron';
import {
  cancelWorkspaceScaffoldSession,
  getWorkspaceScaffoldSession,
  maybeCompleteWorkspaceScaffold,
  startWorkspaceScaffoldSession,
} from '../services/workspace-scaffold.service.js';

export function registerWorkspaceScaffoldHandlers(): void {
  ipcMain.handle('workspace-scaffold:start', (_event, workspaceId: string, rootPath: string) => {
    try {
      const scaffoldSession = startWorkspaceScaffoldSession(workspaceId, rootPath);
      return { workspaceId, scaffoldSession };
    } catch (err) {
      console.error('[Workspace Scaffold IPC] Error starting scaffold session:', err);
      throw err;
    }
  });

  ipcMain.handle('workspace-scaffold:get-by-workspace', (_event, workspaceId: string) => {
    try {
      return getWorkspaceScaffoldSession(workspaceId);
    } catch (err) {
      console.error('[Workspace Scaffold IPC] Error getting scaffold session:', err);
      throw err;
    }
  });

  ipcMain.handle(
    'workspace-scaffold:maybe-complete',
    (_event, workspaceId: string, assistantMessage: string) => {
      try {
        return maybeCompleteWorkspaceScaffold(workspaceId, assistantMessage);
      } catch (err) {
        console.error('[Workspace Scaffold IPC] Error completing scaffold session:', err);
        throw err;
      }
    },
  );

  ipcMain.handle('workspace-scaffold:cancel', (_event, workspaceId: string) => {
    try {
      cancelWorkspaceScaffoldSession(workspaceId);
    } catch (err) {
      console.error('[Workspace Scaffold IPC] Error cancelling scaffold session:', err);
      throw err;
    }
  });
}
