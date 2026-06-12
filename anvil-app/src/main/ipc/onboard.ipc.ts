import { ipcMain, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import type { OnboardDetection, EnvironmentCheck, RepoSummary } from '../../shared/types.js';
import { getDb } from '../db/database.js';
import { detectOnboardState, writeArtifact, readArtifact } from '../services/onboard.service.js';
import { generateAgentsMd, generateDevcontainer } from '../services/foundry.service.js';
import { autoCommit } from '../services/git.service.js';
import { resetInstallCache, ensureRepobaseMcp } from '../services/repobase.service.js';

export function registerOnboardHandlers(): void {
  ipcMain.handle('onboard:detect', async (_event, repoId: string): Promise<OnboardDetection> => {
    const repoPath = getRepoPath(repoId);
    return detectOnboardState(repoPath, repoId);
  });

  ipcMain.handle('onboard:agents-md', async (_event, repoId: string): Promise<string> => {
    const summary = getRepoSummary(repoId);
    const repoName = getRepoName(repoId);
    return generateAgentsMd(repoName, summary);
  });

  ipcMain.handle('onboard:devcontainer', async (_event, repoId: string): Promise<string> => {
    const summary = getRepoSummary(repoId);
    const repoName = getRepoName(repoId);
    return generateDevcontainer(
      repoName,
      summary.frameworks, // languages detected as frameworks in our system
      summary.frameworks,
      summary.configFiles,
    );
  });

  ipcMain.handle(
    'onboard:read-artifact',
    async (_event, repoId: string, artifactType: string): Promise<string | null> => {
      const repoPath = getRepoPath(repoId);
      return readArtifact(repoPath, artifactType);
    },
  );

  ipcMain.handle(
    'onboard:check-env',
    async (_event, repoId: string): Promise<EnvironmentCheck[]> => {
      const repoPath = getRepoPath(repoId);
      const detection = await detectOnboardState(repoPath, repoId);
      return detection.environmentStatus;
    },
  );

  ipcMain.handle(
    'onboard:write',
    async (_event, repoId: string, artifactType: string, content: string): Promise<void> => {
      const repoPath = getRepoPath(repoId);
      writeArtifact(repoPath, artifactType, content);
    },
  );

  ipcMain.handle(
    'onboard:write-and-commit',
    async (
      _event,
      repoId: string,
      artifactType: string,
      content: string,
      commitMessage: string,
    ): Promise<void> => {
      const repoPath = getRepoPath(repoId);
      writeArtifact(repoPath, artifactType, content);
      await autoCommit(repoPath, commitMessage);
    },
  );

  ipcMain.handle(
    'onboard:install-dep',
    async (event, command: string): Promise<{ success: boolean; error?: string }> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const sendLine = (line: string) => {
        win?.webContents.send('onboard:install-output', line);
      };

      return new Promise((resolve) => {
        sendLine(`$ ${command}\n`);
        const child = spawn(command, {
          shell: true,
          env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' },
        });

        child.stdout?.on('data', (data: Buffer) => sendLine(data.toString()));
        child.stderr?.on('data', (data: Buffer) => sendLine(data.toString()));

        child.on('error', (err) => {
          sendLine(`\nError: ${err.message}\n`);
          resolve({ success: false, error: err.message });
        });

        child.on('close', (code) => {
          if (code === 0) {
            sendLine('\nDone.\n');
            // Post-install hooks for tools that need additional setup
            handlePostInstall(command, sendLine);
            resolve({ success: true });
          } else {
            sendLine(`\nExited with code ${code}\n`);
            resolve({ success: false, error: `Process exited with code ${code}` });
          }
        });
      });
    },
  );
}

// --- Post-install hooks ---

function handlePostInstall(command: string, sendLine: (line: string) => void): void {
  if (command.includes('repobase')) {
    resetInstallCache();
    sendLine('Registering Repobase MCP with Codex CLI...\n');
    ensureRepobaseMcp()
      .then((ok) => {
        sendLine(ok ? 'Repobase MCP registered.\n' : 'Repobase MCP registration skipped.\n');
      })
      .catch(() => {});
  }
}

// --- Helpers ---

function getRepoPath(repoId: string): string {
  const db = getDb();
  const row = db.prepare('SELECT path FROM repos WHERE id = ?').get(repoId) as
    | { path: string }
    | undefined;
  if (!row) throw new Error(`Repo not found: ${repoId}`);
  return row.path;
}

function getRepoName(repoId: string): string {
  const db = getDb();
  const row = db.prepare('SELECT name FROM repos WHERE id = ?').get(repoId) as
    | { name: string }
    | undefined;
  if (!row) throw new Error(`Repo not found: ${repoId}`);
  return row.name;
}

function getRepoSummary(repoId: string): RepoSummary {
  const db = getDb();
  const summaryRow = db.prepare('SELECT * FROM repo_summaries WHERE repo_id = ?').get(repoId) as
    | Record<string, string>
    | undefined;
  if (!summaryRow) {
    throw new Error(
      'Repo must be indexed before generating artifacts. Please index the repo first.',
    );
  }

  const modules = db
    .prepare('SELECT * FROM module_summaries WHERE repo_id = ?')
    .all(repoId) as Array<{
    path: string;
    purpose: string;
    file_count: number;
    key_files: string;
    dependencies: string;
  }>;

  return {
    repoId,
    overview: summaryRow.overview ?? '',
    patterns: safeParseJson(summaryRow.patterns, []),
    frameworks: safeParseJson(summaryRow.frameworks, []),
    entryPoints: safeParseJson(summaryRow.entry_points, []),
    configFiles: safeParseJson(summaryRow.config_files, []),
    mermaidDiagram: summaryRow.mermaid_diagram ?? '',
    indexMode: summaryRow.index_mode === 'deep' ? 'deep' : 'light',
    indexProvider: summaryRow.index_provider ?? undefined,
    indexWarnings: safeParseJson(summaryRow.index_warnings, []),
    modules: modules.map((m) => ({
      path: m.path,
      purpose: m.purpose ?? '',
      fileCount: m.file_count ?? 0,
      keyFiles: safeParseJson(m.key_files, []),
      dependencies: safeParseJson(m.dependencies, []),
    })),
  };
}

function safeParseJson<T>(value: string | undefined | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
