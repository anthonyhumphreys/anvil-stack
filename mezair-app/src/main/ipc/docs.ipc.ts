import { ipcMain } from 'electron';
import type {
  DocPage,
  DocsRequestContext,
  LinearDocProject,
} from '../../shared/types.js';
import { getDb } from '../db/database.js';
import { getActiveDocsProvider } from '../services/docs-provider.js';
import { withLinearDocsApiKey } from '../services/linear-docs.service.js';
import { callLlm } from '../services/llm.service.js';
import { getSettings } from '../services/settings.service.js';

function assertCurrentDocsContext(context: DocsRequestContext): void {
  const settings = getSettings();
  if (settings.docsProvider !== context.provider) {
    throw new Error('Documentation provider changed. Reload the page and try again.');
  }
  if (context.workspaceId && settings.activeWorkspaceId !== context.workspaceId) {
    throw new Error('Active workspace changed. Reload the page and try again.');
  }
  if (
    context.provider === 'linear' &&
    settings.activeWorkItemConnectionId !== context.connectionId
  ) {
    throw new Error('Active Linear connection changed. Reload the page and try again.');
  }
}

function captureDocsOperation(context: DocsRequestContext) {
  assertCurrentDocsContext(context);
  const settings = getSettings();
  const provider = getActiveDocsProvider();
  if (!provider) throw new Error('No docs provider configured');
  const apiKey = context.provider === 'linear' ? settings.linearApiKey?.trim() : undefined;
  if (context.provider === 'linear' && !apiKey) {
    throw new Error('Linear API key must be configured in Work Items settings.');
  }
  return {
    provider,
    run: <T>(action: () => Promise<T>) =>
      context.provider === 'linear'
        ? withLinearDocsApiKey(apiKey!, action)
        : action(),
  };
}

export function registerDocsHandlers(): void {
  ipcMain.handle(
    'docs:list-projects',
    async (_event, context: DocsRequestContext): Promise<LinearDocProject[]> => {
      const operation = captureDocsOperation(context);
      const projects = await operation.run(() =>
        operation.provider.listProjects ? operation.provider.listProjects() : Promise.resolve([]),
      );
      assertCurrentDocsContext(context);
      return projects;
    },
  );

  ipcMain.handle(
    'docs:list',
    async (_event, spaceKey: string | undefined, context: DocsRequestContext): Promise<DocPage[]> => {
      const operation = captureDocsOperation(context);
      const pages = await operation.run(() => operation.provider.listPages(spaceKey));
      assertCurrentDocsContext(context);
      return pages;
    },
  );

  ipcMain.handle(
    'docs:list-children',
    async (_event, pageId: string, context: DocsRequestContext): Promise<DocPage[]> => {
      const operation = captureDocsOperation(context);
      const pages = await operation.run(() => operation.provider.listChildren(pageId));
      assertCurrentDocsContext(context);
      return pages;
    },
  );

  ipcMain.handle(
    'docs:check-stale',
    async (
      _event,
      pageId: string,
      repoId: string,
      context: DocsRequestContext,
    ): Promise<DocPage['staleness']> => {
      const operation = captureDocsOperation(context);
      const db = getDb();
      const repo = db.prepare('SELECT last_commit_date FROM repos WHERE id = ?').get(repoId) as
        | { last_commit_date: string }
        | undefined;
      if (!repo?.last_commit_date) return 'unknown';
      const staleness = await operation.run(() =>
        operation.provider.checkStaleness(pageId, repo.last_commit_date),
      );
      assertCurrentDocsContext(context);
      return staleness;
    },
  );

  ipcMain.handle(
    'docs:update',
    async (
      _event,
      pageId: string,
      title: string,
      content: string,
      context: DocsRequestContext,
    ): Promise<void> => {
      const operation = captureDocsOperation(context);
      await operation.run(() => operation.provider.updatePage(pageId, title, content));
      assertCurrentDocsContext(context);
    },
  );

  ipcMain.handle(
    'docs:generate-update',
    async (
      _event,
      pageId: string,
      repoId: string,
      context: DocsRequestContext,
    ): Promise<string> => {
      const operation = captureDocsOperation(context);
      const content = await operation.run(() => operation.provider.getPageContent(pageId));
      assertCurrentDocsContext(context);

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
      const generated = await callLlm(prompt, 4096, 0.3, 3, { taskClass: 'long-context' });
      assertCurrentDocsContext(context);
      return generated;
    },
  );

  ipcMain.handle(
    'docs:create',
    async (
      _event,
      spaceKey: string,
      title: string,
      repoId: string,
      context: DocsRequestContext,
    ): Promise<string> => {
      const operation = captureDocsOperation(context);
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

      // The model call can outlive a workspace/account switch. Never publish its result
      // through a provider or credential that differs from the one the request began with.
      assertCurrentDocsContext(context);
      const pageId = await operation.run(() => operation.provider.createPage(spaceKey, title, content));
      assertCurrentDocsContext(context);
      return pageId;
    },
  );
}
