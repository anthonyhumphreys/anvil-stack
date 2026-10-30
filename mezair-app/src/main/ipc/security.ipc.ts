import { ipcMain, BrowserWindow, dialog } from 'electron';
import fs from 'node:fs';
import {
  getAudit,
  getRunningAudit,
  listAudits,
  getFindings,
  getFinding,
  dismissFinding,
  linkFindingToWorkItem,
} from '../services/security-persistence.service.js';
import {
  createPendingSecurityAudit,
  runSecurityAudit,
  generateMarkdownReport,
} from '../services/security-audit.service.js';
import { getDb } from '../db/database.js';
import { notifyIfUnfocused } from '../services/notification.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseJson<T>(json: string | undefined | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerSecurityHandlers(): void {
  // security:run-audit
  ipcMain.handle('security:run-audit', async (_event, repoId: string) => {
    const win = BrowserWindow.getAllWindows()[0];
    const sendProgress = (message: string, percent: number): void => {
      win?.webContents.send('security:audit-progress', { repoId, message, percent });
    };

    const existingAudit = getRunningAudit(repoId);
    if (existingAudit) {
      return existingAudit;
    }

    const db = getDb();

    // Get repo info
    const repo = db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId) as
      | { name: string; path: string }
      | undefined;
    if (!repo) throw new Error(`Repo not found: ${repoId}`);

    // Get summary
    const summaryRow = db.prepare('SELECT * FROM repo_summaries WHERE repo_id = ?').get(repoId) as
      | Record<string, string>
      | undefined;
    if (!summaryRow) throw new Error('Repo must be indexed before running a security audit');

    // Get modules
    const moduleRows = db
      .prepare('SELECT * FROM module_summaries WHERE repo_id = ?')
      .all(repoId) as Array<Record<string, unknown>>;

    const repoSummary = {
      repoId,
      overview: summaryRow.overview || '',
      modules: moduleRows.map((m) => ({
        path: String(m.path),
        purpose: String(m.purpose || ''),
        fileCount: Number(m.file_count || 0),
        keyFiles: safeParseJson(m.key_files as string, []),
        dependencies: safeParseJson(m.dependencies as string, []),
      })),
      patterns: safeParseJson(summaryRow.patterns, []),
      frameworks: safeParseJson(summaryRow.frameworks, []),
      entryPoints: safeParseJson(summaryRow.entry_points, []),
      configFiles: safeParseJson(summaryRow.config_files, []),
      mermaidDiagram: summaryRow.mermaid_diagram || '',
    };

    const languages = safeParseJson(summaryRow.language_breakdown, []);

    const auditId = createPendingSecurityAudit(repoId, repoSummary, languages);
    void runSecurityAudit(auditId, repoId, repoSummary, languages, sendProgress)
      .then(() => {
        notifyIfUnfocused('Security Audit Complete', `Audit finished for ${repo.name}.`);
      })
      .catch((err) => {
        console.error(`[Security IPC] Audit failed for repo ${repoId}:`, err);
      });

    return getAudit(auditId);
  });

  // security:get-audit
  ipcMain.handle('security:get-audit', async (_event, auditId: string) => {
    return getAudit(auditId);
  });

  // security:get-running-audit — check if there's an in-progress audit for a repo
  ipcMain.handle('security:get-running-audit', async (_event, repoId: string) => {
    return getRunningAudit(repoId);
  });

  // security:list-audits
  ipcMain.handle('security:list-audits', async (_event, repoId: string) => {
    return listAudits(repoId);
  });

  // security:get-findings
  ipcMain.handle('security:get-findings', async (_event, auditId: string) => {
    return getFindings(auditId);
  });

  // security:dismiss-finding
  ipcMain.handle('security:dismiss-finding', async (_event, findingId: string) => {
    dismissFinding(findingId);
  });

  // security:create-work-item
  ipcMain.handle('security:create-work-item', async (_event, findingId: string) => {
    const finding = getFinding(findingId);
    if (!finding) throw new Error(`Finding not found: ${findingId}`);

    // TODO: Integrate with work item providers (ADO, Linear, Jira)
    const wiId = `WI-${Date.now()}`;
    linkFindingToWorkItem(findingId, wiId);
    return wiId;
  });

  // security:create-work-items-bulk
  ipcMain.handle('security:create-work-items-bulk', async (_event, findingIds: string[]) => {
    const results: string[] = [];
    for (const fid of findingIds) {
      const finding = getFinding(fid);
      if (!finding) continue;
      const wiId = `WI-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      linkFindingToWorkItem(fid, wiId);
      results.push(wiId);
    }
    return results;
  });

  // security:export-report
  ipcMain.handle('security:export-report', async (_event, auditId: string) => {
    const audit = getAudit(auditId);
    if (!audit) throw new Error(`Audit not found: ${auditId}`);

    const findings = getFindings(auditId);

    const db = getDb();
    const repo = db.prepare('SELECT name FROM repos WHERE id = ?').get(audit.repoId) as
      | { name: string }
      | undefined;

    const markdown = generateMarkdownReport(audit, findings, repo?.name || 'Unknown');

    // Show save dialog
    const win = BrowserWindow.getAllWindows()[0];
    const result = await dialog.showSaveDialog(win!, {
      defaultPath: `security-audit-${audit.repoId.substring(0, 8)}-${new Date().toISOString().split('T')[0]}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });

    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, markdown, 'utf-8');
      return result.filePath;
    }

    return '';
  });
}
