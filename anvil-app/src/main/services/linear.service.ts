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

// --- Auth ---

function getHeaders(): Record<string, string> {
  const settings = getSettings();
  const apiKey = settings.linearApiKey;
  if (!apiKey) {
    throw new Error('Linear API key must be configured in settings');
  }
  return {
    Authorization: apiKey,
    'Content-Type': 'application/json',
  };
}

// --- GraphQL helper ---

async function graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const headers = getHeaders();
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[Linear] GraphQL error response:', res.status, body);
    throw new Error(
      `Linear GraphQL request failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`,
    );
  }

  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };

  if (json.errors && json.errors.length > 0) {
    throw new Error(`Linear GraphQL error: ${json.errors.map((e) => e.message).join(', ')}`);
  }

  return json.data as T;
}

// --- Type mapping ---

function mapWorkItemType(label: string): WorkItem['type'] {
  const normalized = label?.toLowerCase() ?? '';
  if (normalized.includes('epic')) return 'Epic';
  if (normalized.includes('feature')) return 'Feature';
  if (normalized.includes('story')) return 'User Story';
  if (normalized.includes('bug')) return 'Bug';
  return 'Task';
}

// --- Linear issue shape ---

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  priority: number;
  url: string;
  state: { name: string };
  assignee?: { name: string };
  labels: { nodes: Array<{ name: string }> };
  estimate?: number;
  cycle?: { id: string; name: string };
  project?: { id: string; name: string };
  team?: { id: string; name: string; key: string };
  parent?: { identifier: string };
}

function issueToWorkItem(issue: LinearIssue): WorkItem {
  const labelNames = issue.labels?.nodes?.map((l) => l.name) ?? [];
  const typeLabel = labelNames.find(
    (l) =>
      l.toLowerCase().includes('bug') ||
      l.toLowerCase().includes('feature') ||
      l.toLowerCase().includes('story') ||
      l.toLowerCase().includes('epic'),
  );
  const originalType = typeLabel ?? 'Task';

  return {
    id: issue.identifier,
    title: issue.title,
    type: mapWorkItemType(originalType),
    state: issue.state?.name ?? '',
    priority: issue.priority ?? 4,
    assignee: issue.assignee?.name,
    description: issue.description ?? undefined,
    tags: labelNames.length > 0 ? labelNames : undefined,
    parentId: issue.parent?.identifier,
    provider: 'linear' as const,
    extras: {
      linearIssueId: issue.id,
      originalType,
      estimate: issue.estimate,
      cycle: issue.cycle ? { id: issue.cycle.id, name: issue.cycle.name } : undefined,
      team: issue.team
        ? { id: issue.team.id, name: issue.team.name, key: issue.team.key }
        : undefined,
      project: issue.project ? { id: issue.project.id, name: issue.project.name } : undefined,
    },
    url: issue.url,
  };
}

// --- Issue fragment ---

const ISSUE_FRAGMENT = `
  id
  identifier
  title
  description
  priority
  url
  state { name }
  assignee { name }
  labels { nodes { name } }
  estimate
  cycle { id name }
  project { id name }
  team { id name key }
  parent { identifier }
`;

// --- List items ---

async function listItems(filters?: WorkItemFilters): Promise<WorkItem[]> {
  // Check cache first (skip cache when iteration/cycle filters are active)
  if (!filters?.iterationIds?.length) {
    const cached = getCachedWorkItems();
    if (cached) {
      return applyFilters(cached, filters);
    }
  }

  const settings = getSettings();
  const teamId = settings.linearTeamId;

  // Build GraphQL filter object
  const issueFilter: Record<string, unknown> = {};

  if (teamId) {
    issueFilter.team = { id: { eq: teamId } };
  }

  if (filters?.iterationIds && filters.iterationIds.length > 0) {
    // Linear cycles: filter by cycle IDs
    issueFilter.cycle = { id: { in: filters.iterationIds } };
  }

  const query = `
    query ListIssues($filter: IssueFilter) {
      issues(filter: $filter, first: 200, orderBy: updatedAt) {
        nodes {
          ${ISSUE_FRAGMENT}
        }
      }
    }
  `;

  interface ListResult {
    issues: { nodes: LinearIssue[] };
  }

  const data = await graphql<ListResult>(query, { filter: issueFilter });
  const workItems = data.issues.nodes.map(issueToWorkItem);

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
    if (age < CACHE_TTL_MS) {
      return rowToWorkItem(cached);
    }
  }

  // Linear's issue() query accepts both UUIDs and human-readable identifiers like "ENG-123"
  const query = `
    query GetIssue($id: String!) {
      issue(id: $id) {
        ${ISSUE_FRAGMENT}
      }
    }
  `;

  interface GetResult {
    issue: LinearIssue;
  }

  const data = await graphql<GetResult>(query, { id });

  if (!data.issue) {
    throw new Error(`Linear issue not found: ${id}`);
  }

  const wi = issueToWorkItem(data.issue);

  // Cache single item
  cacheSingleWorkItem(wi);

  return wi;
}

async function createItem(input: WorkItemCreateInput): Promise<WorkItem> {
  const title = input.title.trim();
  if (!title) {
    throw new Error('A work item title is required');
  }

  const settings = getSettings();
  let teamId = settings.linearTeamId;
  let parentLinearId: string | undefined;
  let projectId: string | undefined;

  if (input.parentId?.trim()) {
    interface ParentIssueResult {
      issue: {
        id: string;
        team?: { id: string };
        project?: { id: string };
      } | null;
    }

    const parentData = await graphql<ParentIssueResult>(
      `
        query GetParentIssue($id: String!) {
          issue(id: $id) {
            id
            team { id }
            project { id }
          }
        }
      `,
      { id: input.parentId.trim() },
    );

    if (!parentData.issue) {
      throw new Error(`Linear parent work item not found: ${input.parentId}`);
    }

    parentLinearId = parentData.issue.id;
    teamId = teamId ?? parentData.issue.team?.id;
    projectId = parentData.issue.project?.id;
  }

  if (!teamId) {
    throw new Error('Linear team must be configured in Settings before creating work items');
  }

  interface CreateIssueResult {
    issueCreate: {
      success: boolean;
      issue: LinearIssue | null;
    };
  }

  const createData = await graphql<CreateIssueResult>(
    `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            ${ISSUE_FRAGMENT}
          }
        }
      }
    `,
    {
      input: {
        title,
        description: input.description?.trim() || undefined,
        teamId,
        projectId,
        parentId: parentLinearId,
      },
    },
  );

  if (!createData.issueCreate.success || !createData.issueCreate.issue) {
    throw new Error('Linear did not return the created work item');
  }

  const workItem = issueToWorkItem(createData.issueCreate.issue);
  invalidateWorkItemsCache();
  cacheSingleWorkItem(workItem);
  return workItem;
}

// --- List iterations (cycles) ---

async function listIterations(): Promise<Iteration[]> {
  const settings = getSettings();
  const teamId = settings.linearTeamId;

  if (teamId) {
    // Cycles must be queried through a team
    const query = `
      query TeamCycles($teamId: String!) {
        team(id: $teamId) {
          cycles {
            nodes {
              id
              number
              name
              startsAt
              endsAt
            }
          }
        }
      }
    `;

    interface TeamCyclesResult {
      team: {
        cycles: {
          nodes: Array<{
            id: string;
            number: number;
            name?: string;
            startsAt?: string;
            endsAt?: string;
          }>;
        };
      };
    }

    const data = await graphql<TeamCyclesResult>(query, { teamId });

    // Filter to current/upcoming cycles (started but not ended, or starting soon)
    const now = new Date();
    return data.team.cycles.nodes
      .filter((c) => {
        if (!c.endsAt) return true;
        return new Date(c.endsAt) >= now;
      })
      .map((c) => ({
        id: c.id,
        name: c.name || `Cycle ${c.number}`,
        startDate: c.startsAt,
        finishDate: c.endsAt,
        provider: 'linear' as const,
      }));
  }

  // No team configured — cycles require a team scope, return empty
  return [];
}

// --- Test connection ---

async function testConnection(): Promise<{ ok: boolean; error?: string }> {
  try {
    const settings = getSettings();
    if (!settings.linearApiKey) {
      return { ok: false, error: 'Linear API key is required' };
    }

    interface ViewerResult {
      viewer: { id: string };
    }

    await graphql<ViewerResult>('query { viewer { id } }');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
  if (row.raw_json) {
    return JSON.parse(row.raw_json as string) as WorkItem;
  }
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
    provider: 'linear' as const,
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

// --- Discover teams ---

export async function listLinearTeams(): Promise<Array<{ id: string; name: string; key: string }>> {
  const query = `
    query {
      teams {
        nodes { id name key }
      }
    }
  `;

  interface TeamsResult {
    teams: { nodes: Array<{ id: string; name: string; key: string }> };
  }

  const data = await graphql<TeamsResult>(query);
  return data.teams.nodes;
}

// --- Export provider ---

export const linearProvider: WorkItemProviderService = {
  listItems,
  getItem,
  listIterations,
  createItem,
  testConnection,
};
