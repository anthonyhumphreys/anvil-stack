import { ipcMain } from 'electron';
import { getDb } from '../db/database.js';
import type { CicdCreatePipelineInput } from '../../shared/types.js';
import { analyzeCicdPipelines, createCicdPipeline } from '../services/cicd.service.js';

function repoDetails(repoId: string): { name: string; path: string } {
  const row = getDb().prepare('SELECT name, path FROM repos WHERE id = ?').get(repoId) as
    | { name: string; path: string }
    | undefined;
  if (!row) throw new Error(`Repo not found: ${repoId}`);
  return row;
}

export function registerCicdHandlers(): void {
  ipcMain.handle('cicd:analyze', async (_event, repoId: string) => {
    const repo = repoDetails(repoId);
    return analyzeCicdPipelines(repoId, repo.name, repo.path);
  });

  ipcMain.handle('cicd:create-pipeline', (_event, repoId: string, input: CicdCreatePipelineInput) => {
    const repo = repoDetails(repoId);
    return createCicdPipeline(repo.path, input);
  });
}
