import { scanRepoForAdrs } from '../services/adr-discovery.service.js';
import { ipcMain } from 'electron';
import { getDb } from '../db/database.js';
import type { RepoAdrs } from '../../shared/types.js';

export function registerAdrHandlers(): void {
  ipcMain.handle(
    'adr:list-by-workspace',
    async (_event, workspaceId: string): Promise<RepoAdrs[]> => {
      const db = getDb();

      const repos = db
        .prepare(
          `SELECT r.id, r.name, r.path
           FROM repos r
           JOIN workspace_repos wr ON wr.repo_id = r.id
           WHERE wr.workspace_id = ?`,
        )
        .all(workspaceId) as Array<{ id: string; name: string; path: string }>;

      const results: RepoAdrs[] = [];

      for (const repo of repos) {
        const adrs = scanRepoForAdrs(repo.path);
        if (adrs.length > 0) {
          results.push({ repoId: repo.id, repoName: repo.name, adrs });
        }
      }

      return results;
    },
  );
}
