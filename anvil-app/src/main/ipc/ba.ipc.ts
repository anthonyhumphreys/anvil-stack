import { ipcMain, BrowserWindow } from 'electron';
import type {
  BaSession,
  BaFinding,
  BaFindingStatus,
  BaMessage,
  BaRepoLink,
  WorkItemCreateInput,
} from '../../shared/types.js';
import type { CodexSession } from '../../shared/types.js';
import { getDb } from '../db/database.js';
import {
  createBaSession,
  getBaSession,
  endBaSession,
  listBaSessions,
  getOrphanedSessions,
  markSessionOrphaned,
  createBaFinding,
  listBaFindings,
  updateBaFinding,
  deleteBaFinding,
  saveBaMessage,
  loadBaMessages,
  setBaRepoLink,
  getBaRepoLink,
  getBaFinding,
  linkBaFindingToWorkItem,
} from '../services/ba-persistence.service.js';
import {
  setupSpikeBranch,
  teardownSpikeBranch,
  cleanupAllSpikes,
} from '../services/spike-guard.service.js';
import { startSession } from '../services/codex-session.service.js';
import { detectCodexCli, getCodexInstallInstructions } from '../services/codex-bridge.service.js';
import { getActiveProvider } from '../services/workitem-provider.js';

export function registerBaHandlers(): void {
  // ba:sessions:start
  ipcMain.handle(
    'ba:sessions:start',
    async (
      _event,
      workItemId: string,
      repoId: string,
    ): Promise<{ session: BaSession; codexSession: CodexSession }> => {
      // Verify codex is installed
      const status = await detectCodexCli();
      if (!status.installed) {
        throw new Error(`Codex CLI is not installed.\n\n${getCodexInstallInstructions()}`);
      }

      // Get repo path from DB
      const db = getDb();
      const repoRow = db.prepare('SELECT path FROM repos WHERE id = ?').get(repoId) as
        | { path: string }
        | undefined;
      if (!repoRow) throw new Error(`Repo not found: ${repoId}`);
      const repoPath = repoRow.path;

      // Fetch work item via active provider
      const provider = getActiveProvider();
      if (!provider) throw new Error('No active work item provider configured');
      await provider.getItem(workItemId);

      // Setup spike branch with drift detection
      const onDrift = (): void => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('ba:spike-drift', { workItemId, repoId });
        }
      };
      const spikeState = await setupSpikeBranch(repoPath, workItemId, onDrift);

      // Save repo link
      setBaRepoLink(workItemId, repoId);

      // Create BA session
      const sessionId = createBaSession({
        workItemId,
        repoId,
        spikeBranch: spikeState.spikeBranch,
        originBranch: spikeState.originBranch,
        stashRef: spikeState.stashRef ?? undefined,
      });
      const session = getBaSession(sessionId);
      if (!session) throw new Error(`Failed to retrieve created BA session: ${sessionId}`);

      // Start Codex session
      const codexSession = await startSession([repoPath], [repoId], 'ba');

      return { session, codexSession };
    },
  );

  // ba:sessions:end
  ipcMain.handle('ba:sessions:end', async (_event, sessionId: string): Promise<void> => {
    const session = getBaSession(sessionId);
    if (!session) throw new Error(`BA session not found: ${sessionId}`);

    const db = getDb();
    const repoRow = db.prepare('SELECT path FROM repos WHERE id = ?').get(session.repoId) as
      | { path: string }
      | undefined;
    if (!repoRow) throw new Error(`Repo not found: ${session.repoId}`);

    await teardownSpikeBranch(repoRow.path, session.workItemId);
    endBaSession(sessionId);
  });

  // ba:sessions:list
  ipcMain.handle('ba:sessions:list', (_event, workItemId: string): BaSession[] => {
    return listBaSessions(workItemId);
  });

  // ba:findings:list
  ipcMain.handle('ba:findings:list', (_event, workItemId: string): BaFinding[] => {
    return listBaFindings(workItemId);
  });

  // ba:findings:create
  ipcMain.handle(
    'ba:findings:create',
    (_event, finding: Parameters<typeof createBaFinding>[0]): BaFinding => {
      return createBaFinding(finding);
    },
  );

  // ba:findings:update
  ipcMain.handle(
    'ba:findings:update',
    (_event, id: string, updates: { status: BaFindingStatus }): void => {
      updateBaFinding(id, updates);
    },
  );

  // ba:findings:delete
  ipcMain.handle('ba:findings:delete', (_event, id: string): void => {
    deleteBaFinding(id);
  });

  ipcMain.handle(
    'ba:findings:create-work-item',
    async (_event, findingId: string, input: WorkItemCreateInput): Promise<BaFinding> => {
      const finding = getBaFinding(findingId);
      if (!finding) {
        throw new Error(`BA finding not found: ${findingId}`);
      }

      const provider = getActiveProvider();
      if (!provider) {
        throw new Error('No active work item provider configured');
      }

      const created = await provider.createItem(input);
      return linkBaFindingToWorkItem(findingId, created);
    },
  );

  // ba:repo-links:get
  ipcMain.handle('ba:repo-links:get', (_event, workItemId: string): BaRepoLink | null => {
    return getBaRepoLink(workItemId);
  });

  // ba:repo-links:set
  ipcMain.handle('ba:repo-links:set', (_event, workItemId: string, repoId: string): void => {
    setBaRepoLink(workItemId, repoId);
  });

  // ba:messages:save
  ipcMain.handle(
    'ba:messages:save',
    (_event, opts: Parameters<typeof saveBaMessage>[0]): BaMessage => {
      const id = saveBaMessage(opts);
      const messages = loadBaMessages(opts.sessionId);
      const saved = messages.find((m) => m.id === id);
      if (!saved) throw new Error(`Failed to retrieve saved BA message: ${id}`);
      return saved;
    },
  );

  // ba:messages:load
  ipcMain.handle('ba:messages:load', (_event, sessionId: string): BaMessage[] => {
    return loadBaMessages(sessionId);
  });
}

/** Clean up all active spike branch intervals on app quit. */
export function cleanupBaSessions(): void {
  cleanupAllSpikes();
}

/** On startup, detect sessions that were active when the app last crashed and mark them orphaned. */
export function handleOrphanedBaSessions(): void {
  const db = getDb();
  const activeSessions = db.prepare(`SELECT id FROM ba_sessions WHERE status = 'active'`).all() as {
    id: string;
  }[];

  for (const row of activeSessions) {
    markSessionOrphaned(row.id);
  }

  // Log orphaned sessions for diagnostics
  const orphaned = getOrphanedSessions();
  if (orphaned.length > 0) {
    console.log(`[BA] Marked ${orphaned.length} session(s) as orphaned from previous run.`);
  }
}
