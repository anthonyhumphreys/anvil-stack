import { ipcMain } from 'electron';
import type { Iteration, WorkItem, WorkItemFilters } from '../../shared/types.js';
import { getDb } from '../db/database.js';
import { getActiveProvider } from '../services/workitem-provider.js';
import { loadPromptTemplate } from '../utils/prompt-templates.js';
import { callLlm } from '../services/llm.service.js';

export function registerWorkItemsHandlers(): void {
  ipcMain.handle(
    'workitems:list',
    async (_event, filters?: WorkItemFilters): Promise<WorkItem[]> => {
      const provider = getActiveProvider();
      if (!provider) return [];
      return provider.listItems(filters);
    },
  );

  ipcMain.handle('workitems:get', async (_event, id: string): Promise<WorkItem> => {
    const provider = getActiveProvider();
    if (!provider) throw new Error('No work item provider configured');
    return provider.getItem(id);
  });

  ipcMain.handle('workitems:plan', async (_event, id: string): Promise<string> => {
    const provider = getActiveProvider();
    if (!provider) throw new Error('No work item provider configured');
    const wi = await provider.getItem(id);
    const repoContext = getActiveRepoContext();

    const prompt = loadPromptTemplate('work-item-plan.md', {
      title: wi.title,
      type: wi.type,
      priority: String(wi.priority),
      description: stripHtml(wi.description ?? ''),
      acceptanceCriteria: stripHtml(wi.acceptanceCriteria ?? 'Not specified'),
      repoName: repoContext.name,
      architectureSummary: repoContext.overview,
      relevantModules: repoContext.modules,
    });

    return callLlm(prompt, 4096, 0.4, 3, { taskClass: 'prompt-draft' });
  });

  ipcMain.handle('workitems:fix-prompt', async (_event, id: string): Promise<string> => {
    const provider = getActiveProvider();
    if (!provider) throw new Error('No work item provider configured');
    const wi = await provider.getItem(id);
    const repoContext = getActiveRepoContext();

    const prompt = loadPromptTemplate('work-item-fix.md', {
      title: wi.title,
      type: wi.type,
      description: stripHtml(wi.description ?? ''),
      acceptanceCriteria: stripHtml(wi.acceptanceCriteria ?? 'Not specified'),
      repoName: repoContext.name,
      architectureSummary: repoContext.overview,
      relevantModules: repoContext.modules,
    });

    return callLlm(prompt, 4096, 0.4, 3, { taskClass: 'prompt-draft' });
  });

  ipcMain.handle('workitems:iterations', async (): Promise<Iteration[]> => {
    const provider = getActiveProvider();
    if (!provider) return [];
    return provider.listIterations();
  });

  ipcMain.handle('workitems:search', async (_event, query: string): Promise<WorkItem[]> => {
    const provider = getActiveProvider();
    if (!provider) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];

    const directMatches: WorkItem[] = [];

    const idCandidate = trimmed.replace(/^#/, '');
    if (/^[A-Za-z0-9-]+$/.test(idCandidate)) {
      try {
        const item = await provider.getItem(idCandidate);
        directMatches.push(item);
      } catch (err) {
        console.warn(`[WorkItems] Direct ID lookup for ${idCandidate} failed:`, err);
      }
    }

    let rankedMatches: WorkItem[] = [];
    try {
      const items = await provider.listItems({});
      rankedMatches = rankWorkItems(items, trimmed);
    } catch (err) {
      console.warn('[WorkItems] List search failed:', err);
    }

    const deduped = new Map<string, WorkItem>();
    for (const item of [...directMatches, ...rankedMatches]) {
      if (!deduped.has(item.id)) {
        deduped.set(item.id, item);
      }
      if (deduped.size >= 20) {
        break;
      }
    }

    return Array.from(deduped.values());
  });
}

// --- Helpers ---

function getActiveRepoContext(): { name: string; overview: string; modules: string } {
  const db = getDb();
  const repo = db
    .prepare(
      "SELECT id, name FROM repos WHERE status = 'indexed' ORDER BY last_indexed DESC LIMIT 1",
    )
    .get() as { id: string; name: string } | undefined;

  if (!repo) {
    return { name: 'Unknown', overview: 'No repo indexed', modules: 'None' };
  }

  const summary = db
    .prepare('SELECT overview FROM repo_summaries WHERE repo_id = ?')
    .get(repo.id) as { overview: string } | undefined;

  const modules = db
    .prepare('SELECT path, purpose FROM module_summaries WHERE repo_id = ?')
    .all(repo.id) as Array<{ path: string; purpose: string }>;

  return {
    name: repo.name,
    overview: summary?.overview ?? 'No summary available',
    modules: modules.map((m) => `${m.path}: ${m.purpose}`).join('\n') || 'None',
  };
}

/** Strip HTML tags from ADO rich text fields */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

function rankWorkItems(items: WorkItem[], query: string): WorkItem[] {
  const scored = items
    .map((item) => ({
      item,
      score: scoreWorkItemMatch(item, query),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  return scored.slice(0, 20).map((entry) => entry.item);
}

function scoreWorkItemMatch(item: WorkItem, query: string): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  const rawQuery = query.trim().toLowerCase();
  const id = item.id.toLowerCase();
  const title = normalizeSearchText(item.title);
  const tags = (item.tags ?? []).map((tag) => normalizeSearchText(tag)).join(' ');
  const searchable = `${id} ${title} ${tags}`.trim();

  let score = 0;
  if (id === rawQuery) score += 400;
  if (id.startsWith(rawQuery)) score += 220;
  if (title.startsWith(normalizedQuery)) score += 160;
  if (title.includes(normalizedQuery)) score += 110;
  if (searchable.includes(normalizedQuery)) score += 60;

  const tokens = normalizedQuery.split(' ').filter(Boolean);
  const allTokensPresent = tokens.every(
    (token) => id.includes(token) || title.includes(token) || tags.includes(token),
  );

  if (allTokensPresent) {
    score += 80;
  }

  for (const token of tokens) {
    if (id.includes(token)) score += 55;
    if (title.includes(token)) score += 35;
    if (tags.includes(token)) score += 15;
  }

  score += fuzzySubsequenceScore(rawQuery, searchable);
  return score;
}

function fuzzySubsequenceScore(query: string, target: string): number {
  let targetIndex = 0;
  let matched = 0;

  for (const char of query) {
    if (char === ' ') continue;
    const foundAt = target.indexOf(char, targetIndex);
    if (foundAt === -1) {
      return matched >= 3 ? matched * 4 : 0;
    }
    matched += 1;
    targetIndex = foundAt + 1;
  }

  return matched * 6;
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
