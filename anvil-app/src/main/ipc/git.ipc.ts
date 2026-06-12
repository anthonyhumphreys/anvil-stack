import { ipcMain } from 'electron';
import { getDb } from '../db/database.js';
import {
  getFullStatus,
  generateConventionalCommitMessage,
  stageFiles,
  unstageFiles,
  discardFiles,
  commitChanges,
  pushBranch,
  pullBranch,
  fetchRemote,
  getLog,
  listBranches,
  createBranch,
  switchBranch,
  deleteBranch,
  getFileDiff,
  mergeBranch,
  createPullRequestFromChanges,
} from '../services/git.service.js';

/** Resolve a repoId to its disk path from the database. */
function repoPath(repoId: string): string {
  const db = getDb();
  const row = db.prepare('SELECT path FROM repos WHERE id = ?').get(repoId) as
    | { path: string }
    | undefined;
  if (!row) throw new Error(`Repo not found: ${repoId}`);
  return row.path;
}

export function registerGitHandlers(): void {
  ipcMain.handle('git:status', (_e, repoId: string) => {
    return getFullStatus(repoPath(repoId));
  });

  ipcMain.handle('git:workspace-status', async (_e, repoIds: string[]) => {
    if (repoIds.length === 0) {
      return { repos: [], totalFiles: 0 };
    }

    const db = getDb();
    const rows = db
      .prepare(`SELECT id, name, path FROM repos WHERE id IN (${repoIds.map(() => '?').join(',')})`)
      .all(...repoIds) as Array<{ id: string; name: string; path: string }>;

    const repos = (
      await Promise.all(
        rows.map(async (repo) => {
          const status = await getFullStatus(repo.path);
          if (status.files.length === 0) return null;
          return {
            repoId: repo.id,
            repoName: repo.name,
            branch: status.branch,
            fileCount: status.files.length,
            stagedCount: status.files.filter((file) => file.staged).length,
            unstagedCount: status.files.filter((file) => !file.staged).length,
          };
        }),
      )
    ).filter((repo): repo is NonNullable<typeof repo> => repo !== null);

    return {
      repos,
      totalFiles: repos.reduce((total, repo) => total + repo.fileCount, 0),
    };
  });

  ipcMain.handle('git:stage', (_e, repoId: string, paths: string[]) => {
    return stageFiles(repoPath(repoId), paths);
  });

  ipcMain.handle('git:unstage', (_e, repoId: string, paths: string[]) => {
    return unstageFiles(repoPath(repoId), paths);
  });

  ipcMain.handle('git:discard', (_e, repoId: string, paths: string[]) => {
    return discardFiles(repoPath(repoId), paths);
  });

  ipcMain.handle('git:commit', (_e, repoId: string, message: string) => {
    return commitChanges(repoPath(repoId), message);
  });

  ipcMain.handle('git:generate-commit-message', (_e, repoId: string) => {
    return generateConventionalCommitMessage(repoPath(repoId));
  });

  ipcMain.handle('git:create-pull-request', (_e, repoId: string) => {
    const db = getDb();
    const repo = db.prepare('SELECT name, path FROM repos WHERE id = ?').get(repoId) as
      | { name: string; path: string }
      | undefined;
    if (!repo) throw new Error(`Repo not found: ${repoId}`);
    return createPullRequestFromChanges(repoId, repo.name, repo.path);
  });

  ipcMain.handle(
    'git:push',
    (_e, repoId: string, remote?: string, branch?: string, setUpstream?: boolean) => {
      return pushBranch(repoPath(repoId), remote, branch, setUpstream);
    },
  );

  ipcMain.handle('git:pull', (_e, repoId: string, remote?: string, branch?: string) => {
    return pullBranch(repoPath(repoId), remote, branch);
  });

  ipcMain.handle('git:fetch', (_e, repoId: string, remote?: string) => {
    return fetchRemote(repoPath(repoId), remote);
  });

  ipcMain.handle('git:log', (_e, repoId: string, count?: number) => {
    return getLog(repoPath(repoId), count);
  });

  ipcMain.handle('git:branches', (_e, repoId: string) => {
    return listBranches(repoPath(repoId));
  });

  ipcMain.handle('git:create-branch', (_e, repoId: string, name: string, startPoint?: string) => {
    return createBranch(repoPath(repoId), name, startPoint);
  });

  ipcMain.handle('git:switch-branch', (_e, repoId: string, name: string) => {
    return switchBranch(repoPath(repoId), name);
  });

  ipcMain.handle('git:delete-branch', (_e, repoId: string, name: string, force?: boolean) => {
    return deleteBranch(repoPath(repoId), name, force);
  });

  ipcMain.handle('git:diff', (_e, repoId: string, filePath: string, staged: boolean) => {
    return getFileDiff(repoPath(repoId), filePath, staged);
  });

  ipcMain.handle('git:merge', (_e, repoId: string, branch: string) => {
    return mergeBranch(repoPath(repoId), branch);
  });
}
