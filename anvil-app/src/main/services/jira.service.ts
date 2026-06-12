import type {
  WorkItem,
  WorkItemCreateInput,
  WorkItemFilters,
  Iteration,
} from '../../shared/types.js';
import type { WorkItemProviderService } from './workitem-provider.js';
import { getDb } from '../db/database.js';
import { getSettings } from './settings.service.js';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// In-memory board ID cache
let cachedBoardId: string | null = null;
let boardIdCachedAt = 0;

// --- Auth & URL helpers ---

function getAuthHeaders(): Record<string, string> {
  const settings = getSettings();
  const authMode = settings.jiraAuthMode ?? 'cloud';

  if (authMode === 'server') {
    const pat = settings.jiraApiToken;
    if (!pat) {
      throw new Error('JIRA Server PAT must be configured in settings');
    }
    return {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
    };
  }

  // Cloud: Basic auth with email:token
  const email = settings.jiraEmail;
  const token = settings.jiraApiToken;
  if (!email || !token) {
    throw new Error('JIRA Cloud email and API token must be configured in settings');
  }
  return {
    Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
    'Content-Type': 'application/json',
  };
}

function getBaseUrl(): string {
  const settings = getSettings();
  let host = settings.jiraHost ?? '';
  host = host.replace(/\/$/, '');
  if (host && !host.startsWith('http://') && !host.startsWith('https://')) {
    host = `https://${host}`;
  }
  return host;
}

function getApiVersion(): string {
  const settings = getSettings();
  return settings.jiraAuthMode === 'server' ? '2' : '3';
}

function getProject(): string {
  const settings = getSettings();
  if (!settings.jiraProject) {
    throw new Error('JIRA project must be configured in settings');
  }
  return settings.jiraProject;
}

// --- Type mapping ---

function mapWorkItemType(jiraType: string): WorkItem['type'] {
  const normalized = jiraType?.toLowerCase() ?? '';
  if (normalized.includes('epic')) return 'Epic';
  if (normalized.includes('story')) return 'User Story';
  if (normalized.includes('bug')) return 'Bug';
  return 'Task';
}

// --- Board ID discovery ---

async function getBoardId(): Promise<string> {
  // Use configured board ID if set
  const settings = getSettings();
  if (settings.jiraBoardId) {
    return settings.jiraBoardId;
  }

  // Check in-memory cache
  if (cachedBoardId && Date.now() - boardIdCachedAt < CACHE_TTL_MS) {
    return cachedBoardId;
  }

  // Auto-discover board for project — prefer Scrum boards (they have sprints)
  const baseUrl = getBaseUrl();
  const headers = getAuthHeaders();
  const project = getProject();

  const res = await fetch(
    `${baseUrl}/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(project)}&type=scrum`,
    { headers },
  );

  if (!res.ok) {
    // Fall back to any board type if scrum filter fails
    const fallbackRes = await fetch(
      `${baseUrl}/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(project)}`,
      { headers },
    );
    if (!fallbackRes.ok) {
      throw new Error(
        `Failed to discover JIRA board: ${fallbackRes.status} ${fallbackRes.statusText}`,
      );
    }
    const fallbackData = (await fallbackRes.json()) as {
      values: Array<{ id: number; name: string; type: string }>;
    };
    if (!fallbackData.values || fallbackData.values.length === 0) {
      throw new Error(`No boards found for JIRA project "${project}"`);
    }
    // Prefer scrum boards from the unfiltered list
    const scrumBoard = fallbackData.values.find((b) => b.type === 'scrum');
    cachedBoardId = String((scrumBoard ?? fallbackData.values[0]).id);
    boardIdCachedAt = Date.now();
    return cachedBoardId;
  }

  const data = (await res.json()) as {
    values: Array<{ id: number; name: string; type: string }>;
  };

  if (!data.values || data.values.length === 0) {
    throw new Error(
      `No Scrum boards found for JIRA project "${project}". Sprints require a Scrum board.`,
    );
  }

  cachedBoardId = String(data.values[0].id);
  boardIdCachedAt = Date.now();
  return cachedBoardId;
}

// --- Issue → WorkItem mapping ---

function mapIssueToWorkItem(issue: JiraIssue): WorkItem {
  const baseUrl = getBaseUrl();
  const fields = issue.fields;
  const originalType = fields.issuetype?.name ?? 'Task';
  const sprint = fields.sprint;
  const storyPoints = fields.customfield_10016;

  return {
    id: issue.key,
    title: fields.summary ?? '',
    type: mapWorkItemType(originalType),
    state: fields.status?.name ?? '',
    priority: fields.priority?.id ? Number(fields.priority.id) : 4,
    assignee: fields.assignee?.displayName ?? undefined,
    description:
      typeof fields.description === 'string'
        ? fields.description
        : fields.description
          ? JSON.stringify(fields.description)
          : undefined,
    tags: fields.labels ?? undefined,
    iterationPath: sprint?.name ?? undefined,
    provider: 'jira' as const,
    extras: {
      originalType,
      storyPoints: storyPoints ?? undefined,
      sprint: sprint ? { id: sprint.id, name: sprint.name, state: sprint.state } : undefined,
      components: fields.components?.map((c) => c.name) ?? undefined,
      fixVersions: fields.fixVersions?.map((v) => v.name) ?? undefined,
    },
    url: `${baseUrl}/browse/${issue.key}`,
  };
}

// --- JIRA API response types ---

interface JiraIssue {
  key: string;
  fields: {
    summary?: string;
    issuetype?: { name: string };
    status?: { name: string };
    priority?: { id: string; name: string };
    assignee?: { displayName: string; emailAddress?: string };
    description?: unknown;
    labels?: string[];
    sprint?: { id: number; name: string; state: string };
    customfield_10016?: number;
    components?: Array<{ name: string }>;
    fixVersions?: Array<{ name: string }>;
  };
}

// --- List work items ---

async function listItems(filters?: WorkItemFilters): Promise<WorkItem[]> {
  // Check cache first (skip cache when iteration filters are active)
  if (!filters?.iterationIds?.length) {
    const cached = getCachedWorkItems();
    if (cached) {
      return applyFilters(cached, filters);
    }
  }

  const baseUrl = getBaseUrl();
  const headers = getAuthHeaders();
  const project = getProject();
  const apiVersion = getApiVersion();

  // Build JQL
  let jql = `project = "${project}" AND status != Done`;

  if (filters?.iterationIds && filters.iterationIds.length > 0) {
    const sprintClauses = filters.iterationIds.map((id) => `sprint = ${id}`).join(' OR ');
    jql += ` AND (${sprintClauses})`;
  }

  const searchUrl = `${baseUrl}/rest/api/${apiVersion}/search`;
  const body = {
    jql,
    maxResults: 200,
    fields: [
      'summary',
      'issuetype',
      'status',
      'priority',
      'assignee',
      'description',
      'labels',
      'sprint',
      'customfield_10016',
      'components',
      'fixVersions',
    ],
  };

  const res = await fetch(searchUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`JIRA search failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { issues: JiraIssue[] };
  const workItems = (data.issues ?? []).map(mapIssueToWorkItem);

  // Cache results
  cacheWorkItems(workItems);

  return applyFilters(workItems, filters);
}

// --- Get single item ---

async function getItem(id: string): Promise<WorkItem> {
  // Check cache first
  const db = getDb();
  const cached = db.prepare('SELECT * FROM work_items_cache WHERE id = ?').get(id) as
    | Record<string, string | number | null>
    | undefined;

  if (cached && cached.fetched_at) {
    const age = Date.now() - new Date(cached.fetched_at as string).getTime();
    if (age < CACHE_TTL_MS && cached.raw_json) {
      return JSON.parse(cached.raw_json as string) as WorkItem;
    }
  }

  const baseUrl = getBaseUrl();
  const headers = getAuthHeaders();
  const apiVersion = getApiVersion();

  const res = await fetch(`${baseUrl}/rest/api/${apiVersion}/issue/${encodeURIComponent(id)}`, {
    headers,
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch JIRA issue ${id}: ${res.status} ${res.statusText}`);
  }

  const issue = (await res.json()) as JiraIssue;
  const wi = mapIssueToWorkItem(issue);

  // Cache single item
  cacheSingleWorkItem(wi);

  return wi;
}

async function createItem(input: WorkItemCreateInput): Promise<WorkItem> {
  const title = input.title.trim();
  if (!title) {
    throw new Error('A work item title is required');
  }

  const baseUrl = getBaseUrl();
  const headers = getAuthHeaders();
  const apiVersion = getApiVersion();
  const project = getProject();

  const baseFields: Record<string, unknown> = {
    project: { key: project },
    summary: title,
  };

  if (input.description?.trim()) {
    baseFields.description = buildJiraDescription(input.description, apiVersion);
  }

  const fieldVariants: Array<Record<string, unknown>> = [];
  if (input.parentId?.trim()) {
    fieldVariants.push({
      ...baseFields,
      issuetype: { name: 'Sub-task' },
      parent: { key: input.parentId.trim() },
    });
    fieldVariants.push({
      ...baseFields,
      issuetype: { name: 'Subtask' },
      parent: { key: input.parentId.trim() },
    });
    fieldVariants.push({
      ...baseFields,
      issuetype: { name: 'Task' },
      parent: { key: input.parentId.trim() },
    });
  } else {
    fieldVariants.push({
      ...baseFields,
      issuetype: { name: 'Task' },
    });
  }

  let lastError = 'Unknown JIRA error';
  for (const fields of fieldVariants) {
    const res = await fetch(`${baseUrl}/rest/api/${apiVersion}/issue`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ fields }),
    });

    if (res.ok) {
      const created = (await res.json()) as { key: string };
      invalidateWorkItemsCache();
      return getItem(created.key);
    }

    const body = await res.text().catch(() => '');
    lastError = `JIRA work item creation failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`;
  }

  throw new Error(lastError);
}

// --- List iterations (sprints) ---

async function listIterations(): Promise<Iteration[]> {
  let boardId: string;
  try {
    boardId = await getBoardId();
  } catch {
    // No board found — project may not use boards/sprints
    return [];
  }

  const baseUrl = getBaseUrl();
  const headers = getAuthHeaders();

  const res = await fetch(`${baseUrl}/rest/agile/1.0/board/${boardId}/sprint?state=active,future`, {
    headers,
  });

  if (!res.ok) {
    // 400 typically means the board doesn't support sprints (e.g. Kanban board)
    if (res.status === 400) {
      console.warn(
        `[JIRA] Board ${boardId} does not support sprints (likely a Kanban board). Returning empty iterations.`,
      );
      return [];
    }
    const body = await res.text().catch(() => '');
    throw new Error(
      `Failed to fetch JIRA sprints: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`,
    );
  }

  const data = (await res.json()) as {
    values: Array<{
      id: number;
      name: string;
      state: string;
      startDate?: string;
      endDate?: string;
    }>;
  };

  return (data.values ?? []).map((sprint) => ({
    id: String(sprint.id),
    name: sprint.name,
    path: sprint.state,
    startDate: sprint.startDate,
    finishDate: sprint.endDate,
    provider: 'jira' as const,
  }));
}

// --- Test connection ---

async function testConnection(): Promise<{ ok: boolean; error?: string }> {
  try {
    const settings = getSettings();

    if (!settings.jiraHost) {
      return { ok: false, error: 'JIRA host is required' };
    }
    if (!settings.jiraProject) {
      return { ok: false, error: 'JIRA project is required' };
    }

    const authMode = settings.jiraAuthMode ?? 'cloud';
    if (authMode === 'server') {
      if (!settings.jiraApiToken) {
        return { ok: false, error: 'JIRA Server PAT is required' };
      }
    } else {
      if (!settings.jiraEmail || !settings.jiraApiToken) {
        return { ok: false, error: 'JIRA Cloud email and API token are required' };
      }
    }

    const baseUrl = getBaseUrl();
    const headers = getAuthHeaders();
    const apiVersion = getApiVersion();

    const res = await fetch(`${baseUrl}/rest/api/${apiVersion}/myself`, { headers });

    if (!res.ok) {
      if (res.status === 401) return { ok: false, error: 'Invalid credentials' };
      return { ok: false, error: `HTTP ${res.status}: ${res.statusText}` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) {
      return { ok: false, error: 'Connection failed — check your JIRA host URL' };
    }
    return { ok: false, error: msg };
  }
}

// --- Caching ---

function getCachedWorkItems(): WorkItem[] | null {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM work_items_cache ORDER BY priority ASC').all() as Array<
    Record<string, string | number | null>
  >;

  if (rows.length === 0) return null;

  // Check age of first item
  const firstAge = rows[0].fetched_at
    ? Date.now() - new Date(rows[0].fetched_at as string).getTime()
    : Infinity;
  if (firstAge > CACHE_TTL_MS) return null;

  return rows
    .filter((row) => row.raw_json)
    .map((row) => JSON.parse(row.raw_json as string) as WorkItem);
}

function invalidateWorkItemsCache(): void {
  getDb().prepare('DELETE FROM work_items_cache').run();
}

function buildJiraDescription(description: string, apiVersion: string): unknown {
  if (apiVersion === '2') {
    return description;
  }

  const paragraphs = description
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => ({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: block,
        },
      ],
    }));

  return {
    type: 'doc',
    version: 1,
    content: paragraphs.length > 0 ? paragraphs : [{ type: 'paragraph', content: [] }],
  };
}

function cacheWorkItems(items: WorkItem[]): void {
  const db = getDb();
  const now = new Date().toISOString();

  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO work_items_cache
     (id, title, type, state, priority, assignee, description, acceptance_criteria, tags, iteration_path, parent_id, raw_json, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM work_items_cache').run();
    for (const wi of items) {
      insertStmt.run(
        wi.id,
        wi.title,
        wi.type,
        wi.state,
        wi.priority,
        wi.assignee ?? null,
        wi.description ?? null,
        wi.acceptanceCriteria ?? null,
        wi.tags?.join(';') ?? null,
        wi.iterationPath ?? null,
        wi.parentId ?? null,
        JSON.stringify(wi),
        now,
      );
    }
  });
  tx();
}

function cacheSingleWorkItem(wi: WorkItem): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO work_items_cache
     (id, title, type, state, priority, assignee, description, acceptance_criteria, tags, iteration_path, parent_id, raw_json, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    wi.id,
    wi.title,
    wi.type,
    wi.state,
    wi.priority,
    wi.assignee ?? null,
    wi.description ?? null,
    wi.acceptanceCriteria ?? null,
    wi.tags?.join(';') ?? null,
    wi.iterationPath ?? null,
    wi.parentId ?? null,
    JSON.stringify(wi),
  );
}

// --- Filtering ---

function applyFilters(items: WorkItem[], filters?: WorkItemFilters): WorkItem[] {
  if (!filters) return items;

  return items.filter((wi) => {
    if (filters.state && wi.state !== filters.state) return false;
    if (filters.type && wi.type !== filters.type) return false;
    if (filters.assignee && wi.assignee !== filters.assignee) return false;
    return true;
  });
}

// --- Exported provider ---

export const jiraProvider: WorkItemProviderService = {
  listItems,
  getItem,
  listIterations,
  createItem,
  testConnection,
};
