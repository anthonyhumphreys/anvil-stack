import { extractAcceptanceCriteria } from '../../shared/workitem-intent.js';
import type { WorkItem, WorkItemFilters } from '../../shared/types.js';
import type { WorkItemProviderService } from './workitem-provider.js';
import {
  getWorkItemSettings,
  getCachedWorkItems,
  getCachedWorkItem,
  cacheWorkItems,
  cacheSingleWorkItem,
  invalidateWorkItemsCache,
} from './workitem-context.service.js';

interface GitHubIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  pull_request?: unknown;
  assignee?: { login: string } | null;
  assignees?: Array<{ login: string }>;
  labels: Array<string | { name?: string }>;
  milestone?: { number: number; title: string } | null;
}

/** Credentials belong exclusively to the selected Work Item connection. */
export function githubWorkItemTarget() {
  const s = getWorkItemSettings();
  const host = new URL(s.githubHost?.trim() || 'https://github.com');
  if (
    host.protocol !== 'https:' ||
    host.username ||
    host.password ||
    host.pathname !== '/' ||
    host.search ||
    host.hash ||
    (host.hostname === 'github.com' && Boolean(host.port))
  )
    throw new Error('GitHub host must be an HTTPS origin.');
  const owner = s.githubOwner?.trim();
  const repo = s.githubRepo?.trim();
  if (
    !owner ||
    !repo ||
    [owner, repo].some((value) => value === '.' || value === '..') ||
    !/^[\w.-]+$/.test(owner) ||
    !/^[\w.-]+$/.test(repo)
  )
    throw new Error('GitHub owner and repository must be configured.');
  if (!s.githubToken?.trim() || s.githubToken === '••••••••')
    throw new Error('GitHub Work Item token must be configured.');
  return {
    repositoryUrl: `${host.origin}/${owner.toLowerCase()}/${repo.toLowerCase()}`,
    apiUrl: `${host.hostname === 'github.com' ? 'https://api.github.com' : `${host.origin}/api/v3`}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    headers: {
      Authorization: `Bearer ${s.githubToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };
}

export function githubIssueNumber(id: string): number {
  const prefix = `${githubWorkItemTarget().repositoryUrl}/issues/`;
  if (!id.toLowerCase().startsWith(prefix.toLowerCase()))
    throw new Error('GitHub issue must belong to the configured host and repository.');
  const suffix = id.slice(prefix.length);
  if (!/^[1-9]\d*$/.test(suffix) || !Number.isSafeInteger(Number(suffix)))
    throw new Error('Invalid GitHub issue identity.');
  return Number(suffix);
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const target = githubWorkItemTarget();
  const response = await fetch(`${target.apiUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: target.headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`GitHub Work Item request failed: HTTP ${response.status}`);
  return (await response.json()) as T;
}

function toWorkItem(issue: GitHubIssue): WorkItem {
  if (
    !Number.isSafeInteger(issue.number) ||
    issue.number < 1 ||
    typeof issue.title !== 'string' ||
    !Array.isArray(issue.labels)
  )
    throw new Error('GitHub returned an invalid issue.');
  if (issue.pull_request) throw new Error('Pull requests are not GitHub Work Items.');
  const target = githubWorkItemTarget();
  const tags = issue.labels
    .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
    .filter(Boolean);
  const type = tags
    .find((tag) => /^(bug|feature|epic|story|user story)$/i.test(tag))
    ?.toLowerCase();
  return {
    id: `${target.repositoryUrl}/issues/${issue.number}`,
    title: issue.title,
    description: issue.body ?? undefined,
    acceptanceCriteria: extractAcceptanceCriteria({ description: issue.body ?? undefined }),
    state: issue.state,
    type:
      type === 'bug'
        ? 'Bug'
        : type === 'feature'
          ? 'Feature'
          : type === 'epic'
            ? 'Epic'
            : type === 'story' || type === 'user story'
              ? 'User Story'
              : 'Task',
    priority: 4,
    provider: 'github',
    assignee: issue.assignee?.login,
    tags,
    iterationPath: issue.milestone?.title,
    repoUrl: target.repositoryUrl,
    url: `${target.repositoryUrl}/issues/${issue.number}`,
    extras: {
      issueNumber: issue.number,
      milestoneNumber: issue.milestone?.number,
      assignees: issue.assignees?.map((user) => user.login) ?? [],
    },
  };
}

function filterItems(items: WorkItem[], filters?: WorkItemFilters): WorkItem[] {
  return items.filter(
    (item) =>
      (!filters?.state || filters.state === 'all' || item.state === filters.state) &&
      (!filters?.type || item.type === filters.type) &&
      (!filters?.assignee ||
        item.assignee === filters.assignee ||
        (item.extras?.assignees as string[] | undefined)?.includes(filters.assignee)) &&
      (!filters?.tags?.length || filters.tags.every((tag) => item.tags?.includes(tag))) &&
      (!filters?.iterationIds?.length ||
        filters.iterationIds.includes(String(item.extras?.milestoneNumber))),
  );
}

/** Bound pagination and fail rather than caching an incomplete list. */
async function allPages<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await request<T[]>(`${path}&per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error('GitHub results exceed the supported 10,000 item limit.');
}

export const githubWorkItemsProvider: WorkItemProviderService = {
  async listItems(filters) {
    const cached = getCachedWorkItems();
    if (cached) return filterItems(cached, filters);
    const issues = await allPages<GitHubIssue>('/issues?state=all&sort=updated&direction=desc');
    const items = issues.filter((issue) => !issue.pull_request).map(toWorkItem);
    cacheWorkItems(items);
    return filterItems(items, filters);
  },
  async getItem(id) {
    const number = githubIssueNumber(id);
    const cached = getCachedWorkItem(id);
    if (cached) return cached;
    const issue = await request<GitHubIssue>(`/issues/${number}`);
    if (issue.number !== number) throw new Error('GitHub returned a different issue.');
    const item = toWorkItem(issue);
    cacheSingleWorkItem(item);
    return item;
  },
  async createItem(input) {
    if (!input.title.trim()) throw new Error('A work item title is required.');
    if (input.parentId?.trim()) throw new Error('GitHub parent issue creation is not supported.');
    const item = toWorkItem(
      await request<GitHubIssue>('/issues', {
        title: input.title.trim(),
        body: input.description?.trim() || undefined,
      }),
    );
    invalidateWorkItemsCache();
    cacheSingleWorkItem(item);
    return item;
  },
  async listIterations() {
    const milestones = await allPages<{ number: number; title: string; due_on?: string | null }>(
      '/milestones?state=open',
    );
    return milestones.map((m) => ({
      id: String(m.number),
      name: m.title,
      finishDate: m.due_on ?? undefined,
      provider: 'github',
    }));
  },
  async testConnection() {
    try {
      await request<GitHubIssue[]>('/issues?per_page=1');
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'GitHub connection failed.',
      };
    }
  },
};
