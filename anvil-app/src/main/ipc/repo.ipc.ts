import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { RepoIndexProgress, RepoInfo, RepoSummary } from '../../shared/types.js';
import { getDb } from '../db/database.js';
import {
  listGithubRepos,
  listAdoRepos,
  cloneRepo,
  checkGhAuthStatus,
} from '../services/remote-repo.service.js';
import { connectRepoPath } from '../services/repo-connect.service.js';
import { indexRepo } from '../services/repo-index.service.js';

/** On startup, reset repos stuck in 'indexing' from a previous crash back to 'connected'. */
export function handleStaleIndexingRepos(): void {
  const db = getDb();
  const stale = db.prepare(`SELECT id FROM repos WHERE status = 'indexing'`).all() as {
    id: string;
  }[];

  if (stale.length === 0) return;

  db.prepare(
    `UPDATE repos SET status = 'connected', updated_at = datetime('now') WHERE status = 'indexing'`,
  ).run();

  console.log(`[Repo] Reset ${stale.length} repo(s) stuck in 'indexing' from previous run.`);
}

export function registerRepoHandlers(): void {
  ipcMain.handle('dialog:selectDirectory', async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select Repository Directory',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('repo:list', (): RepoInfo[] => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM repos ORDER BY updated_at DESC').all() as DbRepoRow[];
    return rows.map(rowToRepoInfo);
  });

  ipcMain.handle('repo:connect', async (_event, repoPath: string): Promise<RepoInfo> => {
    return connectRepoPath(repoPath);
  });

  ipcMain.handle('repo:index', async (event, repoId: string): Promise<void> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    await indexRepo(
      repoId,
      (message: string, percent: number, stage: RepoIndexProgress['stage'], detail?: string) => {
        win?.webContents.send('repo:index-progress', { repoId, message, percent, stage, detail });
      },
    );
  });

  ipcMain.handle('repo:status', (_event, repoId: string): RepoInfo['status'] => {
    const db = getDb();

    // Clean up repos stuck in 'indexing' for over 30 minutes
    const staleThreshold = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    db.prepare(
      `UPDATE repos SET status = 'error', updated_at = datetime('now')
       WHERE id = ? AND status = 'indexing' AND updated_at < ?`,
    ).run(repoId, staleThreshold);

    const row = db.prepare('SELECT status FROM repos WHERE id = ?').get(repoId) as
      | { status: string }
      | undefined;
    return (row?.status as RepoInfo['status']) ?? 'connected';
  });

  ipcMain.handle('repo:reset-status', (_event, repoId: string): void => {
    const db = getDb();
    db.prepare(
      `UPDATE repos SET status = 'connected', updated_at = datetime('now') WHERE id = ? AND status = 'indexing'`,
    ).run(repoId);
  });

  ipcMain.handle('repo:summary', (_event, repoId: string): RepoSummary | null => {
    const db = getDb();
    const summaryRow = db.prepare('SELECT * FROM repo_summaries WHERE repo_id = ?').get(repoId) as
      | DbSummaryRow
      | undefined;
    if (!summaryRow) return null;

    const modules = db
      .prepare('SELECT * FROM module_summaries WHERE repo_id = ?')
      .all(repoId) as DbModuleRow[];

    return {
      repoId,
      overview: summaryRow.overview ?? '',
      modules: modules.map((m) => ({
        path: m.path,
        purpose: m.purpose ?? '',
        fileCount: m.file_count ?? 0,
        keyFiles: safeParseJson(m.key_files, []),
        dependencies: safeParseJson(m.dependencies, []),
      })),
      patterns: safeParseJson(summaryRow.patterns, []),
      frameworks: safeParseJson(summaryRow.frameworks, []),
      entryPoints: safeParseJson(summaryRow.entry_points, []),
      configFiles: safeParseJson(summaryRow.config_files, []),
      mermaidDiagram: summaryRow.mermaid_diagram ?? '',
      indexMode: summaryRow.index_mode === 'deep' ? 'deep' : 'light',
      indexProvider: summaryRow.index_provider ?? undefined,
      indexWarnings: safeParseJson(summaryRow.index_warnings, []),
    };
  });

  ipcMain.handle('repo:architecture', (_event, repoId: string): string | null => {
    const db = getDb();
    const row = db
      .prepare('SELECT mermaid_diagram FROM repo_summaries WHERE repo_id = ?')
      .get(repoId) as { mermaid_diagram: string } | undefined;
    return row?.mermaid_diagram ?? null;
  });

  ipcMain.handle('repo:open-vscode', async (_event, repoPath: string): Promise<void> => {
    await shell.openExternal(`vscode://file/${encodeURI(repoPath)}`);
  });

  // Progress event listener registration for renderer
  ipcMain.handle('repo:onProgress', () => {
    // This is handled via webContents.send, registered by the renderer via ipcRenderer.on
  });

  ipcMain.handle('repo:gh-auth-status', async () => {
    try {
      return await checkGhAuthStatus();
    } catch (err) {
      return { authenticated: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('repo:list-github', async () => {
    try {
      return await listGithubRepos();
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  });

  ipcMain.handle('repo:list-ado', async () => {
    try {
      return await listAdoRepos();
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  });

  ipcMain.handle(
    'repo:clone',
    async (event, cloneUrl: string, targetDir: string, provider: 'github' | 'ado') => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        const repoName = cloneUrl.split('/').pop()?.replace('.git', '') ?? 'repo';

        const onProgress = (message: string) => {
          win?.webContents.send('repo:clone-progress', { repoName, cloneUrl, message });
        };

        return await cloneRepo(cloneUrl, targetDir, provider, onProgress);
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  );
}

// --- DB row types ---

interface DbRepoRow {
  id: string;
  name: string;
  path: string;
  remote_url: string | null;
  default_branch: string;
  status: string;
  last_indexed: string | null;
  file_count: number;
  branch_count: number;
  last_commit_message: string | null;
  last_commit_date: string | null;
}

interface DbSummaryRow {
  overview: string | null;
  architecture_description: string | null;
  mermaid_diagram: string | null;
  patterns: string | null;
  frameworks: string | null;
  entry_points: string | null;
  config_files: string | null;
  language_breakdown: string | null;
  index_mode: string | null;
  index_provider: string | null;
  index_warnings: string | null;
}

interface DbModuleRow {
  path: string;
  purpose: string | null;
  file_count: number | null;
  key_files: string | null;
  dependencies: string | null;
}

function rowToRepoInfo(row: DbRepoRow): RepoInfo {
  const db = getDb();
  const summaryRow = db
    .prepare(
      'SELECT language_breakdown, index_mode, index_provider, index_warnings FROM repo_summaries WHERE repo_id = ?',
    )
    .get(row.id) as
    | {
        language_breakdown: string | null;
        index_mode: string | null;
        index_provider: string | null;
        index_warnings: string | null;
      }
    | undefined;

  return {
    id: row.id,
    name: row.name,
    path: row.path,
    remoteUrl: row.remote_url ?? undefined,
    defaultBranch: row.default_branch,
    languages: safeParseJson(summaryRow?.language_breakdown ?? null, []),
    status: row.status as RepoInfo['status'],
    lastIndexed: row.last_indexed ?? undefined,
    fileCount: row.file_count,
    branchCount: row.branch_count,
    lastCommitMessage: row.last_commit_message ?? undefined,
    lastCommitDate: row.last_commit_date ?? undefined,
    indexMode:
      summaryRow?.index_mode === 'deep'
        ? 'deep'
        : summaryRow?.index_mode === 'light'
          ? 'light'
          : undefined,
    indexProvider: summaryRow?.index_provider ?? undefined,
    indexWarnings: safeParseJson(summaryRow?.index_warnings ?? null, []),
  };
}

function safeParseJson<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}
