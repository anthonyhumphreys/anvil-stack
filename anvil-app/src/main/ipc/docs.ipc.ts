import { ipcMain } from 'electron';
import type { DocPage } from '../../shared/types.js';
import { getDb } from '../db/database.js';
import { getActiveDocsProvider } from '../services/docs-provider.js';
import { callLlm } from '../services/llm.service.js';

export function registerDocsHandlers(): void {
  ipcMain.handle('docs:list', async (_event, spaceKey?: string): Promise<DocPage[]> => {
    const provider = getActiveDocsProvider();
    if (!provider) throw new Error('No docs provider configured');
    return provider.listPages(spaceKey);
  });

  ipcMain.handle('docs:list-children', async (_event, pageId: string): Promise<DocPage[]> => {
    const provider = getActiveDocsProvider();
    if (!provider) throw new Error('No docs provider configured');
    return provider.listChildren(pageId);
  });

  ipcMain.handle(
    'docs:check-stale',
    async (_event, pageId: string, repoId: string): Promise<DocPage['staleness']> => {
      const provider = getActiveDocsProvider();
      if (!provider) return 'unknown';

      const db = getDb();
      const repo = db.prepare('SELECT last_commit_date FROM repos WHERE id = ?').get(repoId) as
        | { last_commit_date: string }
        | undefined;

      if (!repo?.last_commit_date) return 'unknown';

      return provider.checkStaleness(pageId, repo.last_commit_date);
    },
  );

  ipcMain.handle(
    'docs:generate-update',
    async (_event, pageId: string, repoId: string): Promise<string> => {
      const provider = getActiveDocsProvider();
      if (!provider) throw new Error('No docs provider configured');

      const content = await provider.getPageContent(pageId);

      const db = getDb();
      const summary = db
        .prepare('SELECT overview FROM repo_summaries WHERE repo_id = ?')
        .get(repoId) as { overview: string } | undefined;

      const modules = db
        .prepare('SELECT path, purpose FROM module_summaries WHERE repo_id = ?')
        .all(repoId) as Array<{ path: string; purpose: string }>;

      const moduleSummaryText = modules.map((m) => `- ${m.path}: ${m.purpose}`).join('\n');

      const prompt = `Compare this documentation page against the current state of the codebase.
Identify what is outdated and generate an updated version.

Current page content:
${content}

Current module summaries:
${moduleSummaryText || 'No modules indexed'}

Repository overview:
${summary?.overview ?? 'Not available'}

Output the updated page content. Highlight what changed and why in comments.`;

      return callLlm(prompt, 4096, 0.3, 3, { taskClass: 'long-context' });
    },
  );

  ipcMain.handle(
    'docs:create',
    async (_event, spaceKey: string, title: string, repoId: string): Promise<string> => {
      const provider = getActiveDocsProvider();
      if (!provider) throw new Error('No docs provider configured');

      const db = getDb();
      const repo = db.prepare('SELECT name FROM repos WHERE id = ?').get(repoId) as
        | { name: string }
        | undefined;

      const summary = db
        .prepare('SELECT overview, mermaid_diagram FROM repo_summaries WHERE repo_id = ?')
        .get(repoId) as { overview: string; mermaid_diagram: string } | undefined;

      const modules = db
        .prepare('SELECT path, purpose, key_files FROM module_summaries WHERE repo_id = ?')
        .all(repoId) as Array<{ path: string; purpose: string; key_files: string }>;

      const prompt = `Generate a documentation page for this software project.

Project: ${repo?.name ?? 'Unknown'}
Title: ${title}

Overview: ${summary?.overview ?? 'Not available'}

Modules:
${modules.map((m) => `- ${m.path}: ${m.purpose}`).join('\n') || 'None'}

Output the page content with clear headings, description paragraphs, and code blocks where appropriate.`;

      const content = await callLlm(prompt, 4096, 0.3, 3, { taskClass: 'long-context' });

      return provider.createPage(spaceKey, title, content);
    },
  );
}
