import { ipcMain } from 'electron';
import { getDb } from '../db/database.js';
import {
  auditLicenses,
  exportSbom,
  isPackageManager,
  isSbomFormat,
  listDependencies,
  runDependencyAudit,
} from '../services/dependencies.service.js';

function getRepoPath(repoId: string): string {
  const db = getDb();
  const repo = db.prepare('SELECT path FROM repos WHERE id = ?').get(repoId) as
    | { path: string }
    | undefined;
  if (!repo) throw new Error(`Repo not found: ${repoId}`);
  return repo.path;
}

export function registerDependencyHandlers(): void {
  ipcMain.handle('dependencies:list', async (_event, repoId: string) => {
    return listDependencies(getRepoPath(repoId));
  });

  ipcMain.handle('dependencies:audit', async (_event, repoId: string, manager: unknown) => {
    if (!isPackageManager(manager)) {
      throw new Error(`Unsupported dependency manager: ${String(manager)}`);
    }
    return runDependencyAudit(getRepoPath(repoId), manager);
  });

  ipcMain.handle('dependencies:audit-licenses', async (_event, repoId: string) => {
    return auditLicenses(getRepoPath(repoId));
  });

  ipcMain.handle('dependencies:export-sbom', async (_event, repoId: string, format: unknown) => {
    if (!isSbomFormat(format)) {
      throw new Error(`Unsupported SBOM format: ${String(format)}`);
    }
    return exportSbom(getRepoPath(repoId), format);
  });
}
