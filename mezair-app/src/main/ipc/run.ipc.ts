import { ipcMain } from 'electron';
import { getDb } from '../db/database.js';
import { detectScripts, detectScriptsAi } from '../services/run-detection.service.js';
import {
  startProcess,
  stopProcess,
  getStatus,
  getOutput,
  cleanupRunProcesses,
} from '../services/run-process.service.js';
import {
  saveCommand,
  listSavedCommands,
  pinCommand,
  unpinCommand,
  deleteCommand,
  touchCommandUsedAt,
} from '../services/run-persistence.service.js';
import type { RunCommand } from '../../shared/run-types.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function getRepoPath(repoId: string): string {
  const db = getDb();
  const repo = db.prepare('SELECT path FROM repos WHERE id = ?').get(repoId) as
    | { path: string }
    | undefined;
  if (!repo) throw new Error(`Repo not found: ${repoId}`);
  return repo.path;
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerRunHandlers(): void {
  // run:detect-scripts
  ipcMain.handle('run:detect-scripts', async (_event, repoId: string) => {
    const repoPath = getRepoPath(repoId);
    return detectScripts(repoId, repoPath);
  });

  // run:detect-all-scripts
  ipcMain.handle('run:detect-all-scripts', async (_event, repoIds: string[]) => {
    const results: Record<string, RunCommand[]> = {};
    await Promise.all(
      repoIds.map(async (repoId) => {
        try {
          const repoPath = getRepoPath(repoId);
          results[repoId] = await detectScripts(repoId, repoPath);
        } catch {
          results[repoId] = [];
        }
      }),
    );
    return results;
  });

  // run:detect-scripts-ai
  ipcMain.handle('run:detect-scripts-ai', async (_event, repoId: string) => {
    const repoPath = getRepoPath(repoId);
    return detectScriptsAi(repoId, repoPath);
  });

  // run:save-custom-command
  ipcMain.handle(
    'run:save-custom-command',
    async (_event, repoId: string, label: string, command: string) => {
      return saveCommand(repoId, label, command, 'custom');
    },
  );

  // run:list-saved-commands
  ipcMain.handle('run:list-saved-commands', async (_event, repoId: string) => {
    return listSavedCommands(repoId);
  });

  // run:pin-command
  ipcMain.handle('run:pin-command', async (_event, commandId: string) => {
    pinCommand(commandId);
  });

  // run:unpin-command
  ipcMain.handle('run:unpin-command', async (_event, commandId: string) => {
    unpinCommand(commandId);
  });

  // run:delete-command
  ipcMain.handle('run:delete-command', async (_event, commandId: string) => {
    deleteCommand(commandId);
  });

  // run:start
  ipcMain.handle('run:start', async (_event, repoId: string, command: string) => {
    const repoPath = getRepoPath(repoId);
    touchCommandUsedAt(repoId, command);
    startProcess(repoId, command, repoPath);
  });

  // run:stop
  ipcMain.handle('run:stop', async (_event, repoId: string) => {
    stopProcess(repoId);
  });

  // run:get-status
  ipcMain.handle('run:get-status', async (_event, repoId: string) => {
    return getStatus(repoId);
  });

  // run:get-output
  ipcMain.handle('run:get-output', async (_event, repoId: string) => {
    return getOutput(repoId);
  });
}

export { cleanupRunProcesses };
