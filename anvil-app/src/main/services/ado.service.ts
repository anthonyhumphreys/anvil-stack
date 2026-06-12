import type {
  Iteration,
  WorkItem,
  WorkItemCreateInput,
  WorkItemFilters,
} from '../../shared/types.js';
import { getDb } from '../db/database.js';
import { getSettings } from './settings.service.js';
import type { WorkItemProviderService } from './workitem-provider.js';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getAuthHeaders(): Record<string, string> {
  const settings = getSettings();
  if (!settings.adoOrganizationUrl || !settings.adoPat) {
    throw new Error('ADO organisation URL and PAT must be configured in settings');
  }
  return {
    Authorization: `Basic ${Buffer.from(`:${settings.adoPat}`).toString('base64')}`,
    'Content-Type': 'application/json',
  };
}

function getBaseUrl(): string {
  const settings = getSettings();
  return settings.adoOrganizationUrl.replace(/\/$/, '');
}

function getProject(): string {
  return getSettings().adoProject;
}

/**
 * Fetch work items via WIQL query. Uses 5-minute cache.
 */
export async function listWorkItems(filters?: WorkItemFilters): Promise<WorkItem[]> {
  // Check cache first (skip cache when iteration filters are active — cache is unscoped)
  if (!filters?.iterationIds?.length) {
    const cached = getCachedWorkItems();
    if (cached) {
      return applyFilters(cached, filters);
    }
  }

  const project = getProject();
  const headers = getAuthHeaders();
  const baseUrl = getBaseUrl();

  // WIQL query for active work items — optionally scoped to iterations
  let whereClause = `[System.TeamProject] = '${project}' AND [System.State] <> 'Closed' AND [System.State] <> 'Removed'`;

  if (filters?.iterationIds && filters.iterationIds.length > 0) {
    const iterClauses = filters.iterationIds
      .map((p) => `[System.IterationPath] UNDER '${p}'`)
      .join(' OR ');
    whereClause += ` AND (${iterClauses})`;
  }

  const wiql = {
    query: `SELECT [System.Id] FROM WorkItems WHERE ${whereClause} ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC`,
  };

  const wiqlRes = await fetch(`${baseUrl}/${project}/_apis/wit/wiql?api-version=7.1`, {
    method: 'POST',
    headers,
    body: JSON.stringify(wiql),
  });

  if (!wiqlRes.ok) {
    throw new Error(`ADO WIQL query failed: ${wiqlRes.status} ${wiqlRes.statusText}`);
  }

  const wiqlData = (await wiqlRes.json()) as { workItems: Array<{ id: number }> };
  if (!wiqlData.workItems || wiqlData.workItems.length === 0) {
    return [];
  }

  // Fetch details in batches of 200
  const ids = wiqlData.workItems.map((wi) => wi.id).slice(0, 200);
  const fields = [
    'System.Id',
    'System.Title',
    'System.WorkItemType',
    'System.State',
    'Microsoft.VSTS.Common.Priority',
    'System.AssignedTo',
    'System.Description',
    'Microsoft.VSTS.Common.AcceptanceCriteria',
    'System.Tags',
    'System.IterationPath',
  ];

  const detailRes = await fetch(
    `${baseUrl}/${project}/_apis/wit/workitems?ids=${ids.join(',')}&fields=${fields.join(',')}&api-version=7.1`,
    { headers },
  );

  if (!detailRes.ok) {
    throw new Error(`ADO work item fetch failed: ${detailRes.status}`);
  }

  const detailData = (await detailRes.json()) as {
    value: Array<{
      id: number;
      fields: Record<string, unknown>;
    }>;
  };

  let workItems: WorkItem[] = detailData.value.map((wi) => {
    const adoType = wi.fields['System.WorkItemType'] as string;
    return {
      id: String(wi.id),
      title: (wi.fields['System.Title'] as string) ?? '',
      type: mapWorkItemType(adoType),
      state: (wi.fields['System.State'] as string) ?? '',
      priority: (wi.fields['Microsoft.VSTS.Common.Priority'] as number) ?? 4,
      assignee: (wi.fields['System.AssignedTo'] as { displayName?: string })?.displayName,
      description: (wi.fields['System.Description'] as string) ?? '',
      acceptanceCriteria: (wi.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] as string) ?? '',
      tags: ((wi.fields['System.Tags'] as string) ?? '')
        .split(';')
        .map((t) => t.trim())
        .filter(Boolean),
      iterationPath: (wi.fields['System.IterationPath'] as string) ?? undefined,
      provider: 'ado' as const,
      extras: { originalType: adoType },
      url: `${baseUrl}/${project}/_workitems/edit/${wi.id}`,
    };
  });

  // Fetch hierarchy (parent links) via relations expand
  const parentMap = await fetchWorkItemHierarchy(ids, baseUrl, project, headers);
  for (const wi of workItems) {
    const parentId = parentMap.get(Number(wi.id));
    if (parentId) wi.parentId = String(parentId);
  }

  // Cache results
  cacheWorkItems(workItems);

  return applyFilters(workItems, filters);
}

/**
 * Get a single work item by ID.
 */
export async function getWorkItem(id: string): Promise<WorkItem> {
  // Check cache first
  const db = getDb();
  const cached = db.prepare('SELECT * FROM work_items_cache WHERE id = ?').get(id) as
    | Record<string, string | number | null>
    | undefined;

  if (cached && cached.fetched_at) {
    const age = Date.now() - new Date(cached.fetched_at as string).getTime();
    if (age < CACHE_TTL_MS) {
      return rowToWorkItem(cached);
    }
  }

  // Fetch from ADO
  const headers = getAuthHeaders();
  const baseUrl = getBaseUrl();
  const project = getProject();

  const res = await fetch(
    `${baseUrl}/${project}/_apis/wit/workitems/${id}?$expand=all&api-version=7.1`,
    { headers },
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch work item ${id}: ${res.status}`);
  }

  const data = (await res.json()) as { id: number; fields: Record<string, unknown> };
  const adoType = data.fields['System.WorkItemType'] as string;
  const wi: WorkItem = {
    id: String(data.id),
    title: (data.fields['System.Title'] as string) ?? '',
    type: mapWorkItemType(adoType),
    state: (data.fields['System.State'] as string) ?? '',
    priority: (data.fields['Microsoft.VSTS.Common.Priority'] as number) ?? 4,
    assignee: (data.fields['System.AssignedTo'] as { displayName?: string })?.displayName,
    description: (data.fields['System.Description'] as string) ?? '',
    acceptanceCriteria: (data.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] as string) ?? '',
    tags: ((data.fields['System.Tags'] as string) ?? '')
      .split(';')
      .map((t) => t.trim())
      .filter(Boolean),
    provider: 'ado' as const,
    extras: { originalType: adoType },
    url: `${baseUrl}/${project}/_workitems/edit/${data.id}`,
  };

  // Cache single item
  cacheSingleWorkItem(wi);

  return wi;
}

export async function createWorkItem(input: WorkItemCreateInput): Promise<WorkItem> {
  const title = input.title.trim();
  if (!title) {
    throw new Error('A work item title is required');
  }

  const baseUrl = getBaseUrl();
  const project = getProject();
  const headers = {
    ...getAuthHeaders(),
    'Content-Type': 'application/json-patch+json',
  };

  const operations: Array<Record<string, unknown>> = [
    { op: 'add', path: '/fields/System.Title', value: title },
  ];

  if (input.description?.trim()) {
    operations.push({
      op: 'add',
      path: '/fields/System.Description',
      value: textToAdoHtml(input.description),
    });
  }

  if (input.parentId?.trim()) {
    operations.push({
      op: 'add',
      path: '/relations/-',
      value: {
        rel: 'System.LinkTypes.Hierarchy-Reverse',
        url: `${baseUrl}/_apis/wit/workItems/${input.parentId.trim()}`,
      },
    });
  }

  const res = await fetch(`${baseUrl}/${project}/_apis/wit/workitems/$Task?api-version=7.1`, {
    method: 'POST',
    headers,
    body: JSON.stringify(operations),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `ADO work item creation failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`,
    );
  }

  const created = (await res.json()) as { id: number };
  invalidateWorkItemsCache();
  return getWorkItem(String(created.id));
}

/**
 * Fetch current and future iterations for the configured team.
 */
export async function listCurrentIterations(): Promise<Iteration[]> {
  const headers = getAuthHeaders();
  const baseUrl = getBaseUrl();
  const project = getProject();
  const settings = getSettings();
  const team = settings.adoTeam || `${project} Team`;

  const res = await fetch(
    `${baseUrl}/${project}/${encodeURIComponent(team)}/_apis/work/teamsettings/iterations?api-version=7.1`,
    { headers },
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch iterations: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    value: Array<{
      id: string;
      name: string;
      path: string;
      attributes?: { startDate?: string; finishDate?: string; timeFrame?: string };
    }>;
  };

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  return data.value
    .filter((iter) => {
      // Include if no finish date (undated iterations)
      if (!iter.attributes?.finishDate) return true;
      // Include if finish date is today or in the future
      const finish = new Date(iter.attributes.finishDate);
      finish.setHours(0, 0, 0, 0);
      return finish >= now;
    })
    .map((iter) => ({
      id: iter.path,
      name: iter.name,
      path: iter.path,
      startDate: iter.attributes?.startDate,
      finishDate: iter.attributes?.finishDate,
      provider: 'ado' as const,
    }));
}

/**
 * Fetch parent-child hierarchy via $expand=relations batch fetch.
 * Returns Map<childId, parentId>.
 */
async function fetchWorkItemHierarchy(
  ids: number[],
  baseUrl: string,
  project: string,
  headers: Record<string, string>,
): Promise<Map<number, number>> {
  const parentMap = new Map<number, number>();
  if (ids.length === 0) return parentMap;

  // Batch in groups of 200
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const res = await fetch(
      `${baseUrl}/${project}/_apis/wit/workitems?ids=${batch.join(',')}&$expand=relations&api-version=7.1`,
      { headers },
    );

    if (!res.ok) continue; // non-fatal — items just won't have hierarchy

    const data = (await res.json()) as {
      value: Array<{
        id: number;
        relations?: Array<{
          rel: string;
          url: string;
        }>;
      }>;
    };

    for (const wi of data.value) {
      if (!wi.relations) continue;
      for (const rel of wi.relations) {
        // Parent link: System.LinkTypes.Hierarchy-Reverse
        if (rel.rel === 'System.LinkTypes.Hierarchy-Reverse') {
          const match = rel.url.match(/\/workItems\/(\d+)$/i);
          if (match) {
            parentMap.set(wi.id, Number(match[1]));
          }
        }
      }
    }
  }

  return parentMap;
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

  return rows.map(rowToWorkItem);
}

function invalidateWorkItemsCache(): void {
  getDb().prepare('DELETE FROM work_items_cache').run();
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

function rowToWorkItem(row: Record<string, string | number | null>): WorkItem {
  return {
    id: String(row.id),
    title: (row.title as string) ?? '',
    type: (row.type as WorkItem['type']) ?? 'Task',
    state: (row.state as string) ?? '',
    priority: (row.priority as number) ?? 4,
    assignee: row.assignee as string | undefined,
    description: row.description as string | undefined,
    acceptanceCriteria: row.acceptance_criteria as string | undefined,
    tags: row.tags ? (row.tags as string).split(';').filter(Boolean) : undefined,
    iterationPath: row.iteration_path as string | undefined,
    parentId: row.parent_id as string | undefined,
    provider: 'ado' as const,
    extras: row.raw_json ? JSON.parse(row.raw_json as string).extras : undefined,
    url: row.raw_json ? JSON.parse(row.raw_json as string).url : undefined,
  };
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

function mapWorkItemType(adoType: string): WorkItem['type'] {
  const normalized = adoType?.toLowerCase() ?? '';
  if (normalized.includes('epic')) return 'Epic';
  if (normalized.includes('feature')) return 'Feature';
  if (normalized.includes('product backlog item') || normalized.includes('user story'))
    return 'User Story';
  if (normalized.includes('bug')) return 'Bug';
  return 'Task';
}

function textToAdoHtml(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function testConnection(): Promise<{ ok: boolean; error?: string }> {
  try {
    const settings = getSettings();
    if (!settings.adoOrganizationUrl || !settings.adoPat) {
      return { ok: false, error: 'ADO organisation URL and PAT are required' };
    }
    const url = `${settings.adoOrganizationUrl}/_apis/projects/${settings.adoProject}?api-version=7.1`;
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${Buffer.from(`:${settings.adoPat}`).toString('base64')}` },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${res.statusText}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const adoProvider: WorkItemProviderService = {
  listItems: listWorkItems,
  getItem: getWorkItem,
  listIterations: listCurrentIterations,
  createItem: createWorkItem,
  testConnection,
};
