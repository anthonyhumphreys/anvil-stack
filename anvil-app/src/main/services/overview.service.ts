import type {
  AutomationRunStatus,
  ChatThreadAttentionState,
  CodeReviewPullRequest,
  DocPage,
  GitStatusResult,
  WorkItem,
  WorkItemFilters,
  WorkItemProvider,
  AdrEntry,
} from '../../shared/types.js';
import {
  OVERVIEW_MODULES,
  timeRangeStart,
  type OverviewActivityEventType,
  type OverviewActivityRow,
  type OverviewAutomationRunRow,
  type OverviewDocumentRow,
  type OverviewFindingRow,
  type OverviewIdeaRow,
  type OverviewModuleConfig,
  type OverviewModuleInstance,
  type OverviewModuleRequest,
  type OverviewModuleResult,
  type OverviewModuleType,
  type OverviewPullRequestRow,
  type OverviewPullRequestState,
  type OverviewRepositoryRow,
  type OverviewRowsByType,
  type OverviewScope,
  type OverviewSessionRow,
  type OverviewSort,
  type OverviewTicketRow,
  type OverviewTone,
  type OverviewWorkspaceRow,
} from '../../shared/overview.js';
import { getDb } from '../db/database.js';
import { scanRepoForAdrs } from './adr-discovery.service.js';
import {
  listPullRequests,
  parseAdoRemoteUrl,
  parseGitHubRemoteUrl,
} from './code-review-pr.service.js';
import { getActiveDocsProvider } from './docs-provider.js';
import { getFullStatus } from './git.service.js';
import { withLinearDocsApiKey } from './linear-docs.service.js';
import { assertOverviewScope } from './overview-layout.service.js';
import { getSettings } from './settings.service.js';
import { getWorkspaceActivityFeed } from './workspace-activity.service.js';
import { getActiveProvider } from './workitem-provider.js';
import { getWorkspacePreferences, listWorkspaces } from './workspace.service.js';

const NETWORK_TTL_MS = 3 * 60_000;
const LOCAL_TTL_MS = 30_000;
const FAILURE_TTL_MS = 30_000;
const NETWORK_CONCURRENCY = 4;
const STALE_DOC_DAYS = 7;

// Renderer routes (mirrors src/renderer/utils/sidebar-navigation.ts; main can't import it).
const WORKSPACE_REPOSITORIES_ROUTE = '/workspace?view=repositories';
const WORKSPACE_NOTES_ROUTE = '/notes?tab=workspace';
const LIBRARY_DOCS_ROUTE = '/workspace?view=library&kind=doc';

/** Repo Health › Security when the repo is known, else the Repositories tab to pick one. */
function securityRoute(repoId?: string): string {
  return repoId
    ? `/workspace/repos/${encodeURIComponent(repoId)}/health/security`
    : WORKSPACE_REPOSITORIES_ROUTE;
}

function libraryAdrRoute(repoId?: string): string {
  return `/workspace?view=library&kind=adr${repoId ? `&repo=${encodeURIComponent(repoId)}` : ''}`;
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

interface ScopedWorkspace {
  id: string;
  name: string;
}

interface ScopedRepo {
  id: string;
  name: string;
  path: string;
  remoteUrl: string | null;
  status: OverviewRepositoryRow['indexStatus'];
  lastIndexed: string | null;
  lastCommitDate: string | null;
  workspaceIds: string[];
}

interface ScopeContext {
  scope: OverviewScope;
  workspaces: ScopedWorkspace[];
  workspaceNames: Map<string, string>;
  repos: ScopedRepo[];
}

interface RepoRow {
  id: string;
  name: string;
  path: string;
  remote_url: string | null;
  status: string | null;
  last_indexed: string | null;
  last_commit_date: string | null;
  workspace_id: string;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

/**
 * Workspace boundaries are a trust boundary: a workspace overview only ever
 * sees its own repositories; the global overview sees the selected workspaces.
 */
export function resolveOverviewScope(
  scope: OverviewScope,
  config: OverviewModuleConfig,
): ScopeContext {
  const all = listWorkspaces();
  const selected =
    scope.kind === 'workspace'
      ? all.filter((workspace) => workspace.id === scope.workspaceId)
      : config.workspaceIds?.length
        ? all.filter((workspace) => config.workspaceIds!.includes(workspace.id))
        : all;
  const workspaces = selected.map((workspace) => ({ id: workspace.id, name: workspace.name }));
  const workspaceIds = workspaces.map((workspace) => workspace.id);
  const rows = workspaceIds.length
    ? (getDb()
        .prepare(
          `SELECT r.id, r.name, r.path, r.remote_url, r.status, r.last_indexed, r.last_commit_date,
                  wr.workspace_id
           FROM repos r JOIN workspace_repos wr ON wr.repo_id = r.id
           WHERE wr.workspace_id IN (${placeholders(workspaceIds.length)})
           ORDER BY r.name COLLATE NOCASE`,
        )
        .all(...workspaceIds) as RepoRow[])
    : [];

  const repos = new Map<string, ScopedRepo>();
  for (const row of rows) {
    const existing = repos.get(row.id);
    if (existing) {
      existing.workspaceIds.push(row.workspace_id);
      continue;
    }
    repos.set(row.id, {
      id: row.id,
      name: row.name,
      path: row.path,
      remoteUrl: row.remote_url,
      status: (['connected', 'indexing', 'indexed', 'error'].includes(row.status ?? '')
        ? row.status
        : 'connected') as ScopedRepo['status'],
      lastIndexed: row.last_indexed,
      lastCommitDate: row.last_commit_date,
      workspaceIds: [row.workspace_id],
    });
  }
  let scopedRepos = [...repos.values()];
  if (scope.kind === 'workspace' && config.repoIds?.length) {
    scopedRepos = scopedRepos.filter((repo) => config.repoIds!.includes(repo.id));
  }
  return {
    scope,
    workspaces,
    workspaceNames: new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
    repos: scopedRepos,
  };
}

function primaryWorkspace(ctx: ScopeContext, workspaceIds: string[]) {
  const workspaceId = workspaceIds.find((id) => ctx.workspaceNames.has(id)) ?? workspaceIds[0];
  return {
    workspaceId,
    workspaceName: ctx.workspaceNames.get(workspaceId) ?? 'Workspace',
    alsoIn: workspaceIds
      .filter((id) => id !== workspaceId && ctx.workspaceNames.has(id))
      .map((id) => ctx.workspaceNames.get(id)!),
  };
}

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value?: T;
  observedAt?: string;
  lastSuccessAt?: string;
  error?: string;
  fetchedAt: number;
  inflight?: Promise<void>;
}

const pullRequestCache = new Map<string, CacheEntry<CodeReviewPullRequest[]>>();
const ticketCache = new Map<string, CacheEntry<WorkItem[]>>();
const docsCache = new Map<string, CacheEntry<DocPage[]>>();
const gitCache = new Map<string, CacheEntry<GitStatusResult>>();
const adrCache = new Map<string, CacheEntry<AdrEntry[]>>();

/** Test hook: forget cached network results. */
export function clearOverviewCaches(): void {
  for (const cache of [pullRequestCache, ticketCache, docsCache, gitCache, adrCache]) cache.clear();
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw
    .replace(/^(Error:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!message) return 'Unknown error.';
  const clipped = message.length > 240 ? `${message.slice(0, 237).trimEnd()}...` : message;
  return /[.!?…]$/.test(clipped) ? clipped : `${clipped}.`;
}

async function cachedFetch<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  ttlMs: number,
  refresh: boolean,
  fetcher: () => Promise<T>,
): Promise<CacheEntry<T>> {
  const entry = cache.get(key);
  if (entry?.inflight) {
    await entry.inflight;
    return cache.get(key)!;
  }
  const age = entry ? Date.now() - entry.fetchedAt : Infinity;
  if (entry && !refresh && age < (entry.error ? FAILURE_TTL_MS : ttlMs)) return entry;

  const inflight = (async () => {
    try {
      const value = await fetcher();
      const now = new Date().toISOString();
      cache.set(key, { value, observedAt: now, lastSuccessAt: now, fetchedAt: Date.now() });
    } catch (error) {
      cache.set(key, {
        value: entry?.value,
        observedAt: entry?.observedAt,
        lastSuccessAt: entry?.lastSuccessAt,
        error: errorMessage(error),
        fetchedAt: Date.now(),
      });
    }
  })();
  cache.set(key, { ...(entry ?? { fetchedAt: 0 }), inflight });
  await inflight;
  return cache.get(key)!;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function oldest(values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => dateValue(a) - dateValue(b))[0];
}

function dateValue(value?: string | null): number {
  if (!value) return 0;
  const parsed = new Date(
    value.includes('T') || value.includes('Z') ? value : `${value}Z`,
  ).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function iso(value?: string | null): string | undefined {
  const time = dateValue(value);
  return time ? new Date(time).toISOString() : undefined;
}

function sortRows<T>(
  rows: T[],
  sort: OverviewSort | undefined,
  time: (row: T) => string | undefined,
  name: (row: T) => string,
): T[] {
  return [...rows].sort((a, b) => {
    if (sort === 'name') return name(a).localeCompare(name(b), undefined, { sensitivity: 'base' });
    const delta = dateValue(time(b)) - dateValue(time(a));
    return sort === 'oldest' ? -delta : delta;
  });
}

function result<T extends OverviewModuleType>(
  type: T,
  rows: OverviewRowsByType[T][],
  limit: number,
  extra: Partial<OverviewModuleResult<T>> & { source: string },
): OverviewModuleResult<T> {
  return {
    type,
    state: 'ready',
    rows: rows.slice(0, limit),
    total: rows.length,
    observedAt: new Date().toISOString(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

function remoteProvider(remoteUrl: string | null): 'github' | 'ado' | null {
  if (!remoteUrl) return null;
  if (parseGitHubRemoteUrl(remoteUrl)) return 'github';
  if (parseAdoRemoteUrl(remoteUrl)) return 'ado';
  return null;
}

interface PullRequestFetch {
  rows: OverviewPullRequestRow[];
  applicable: number;
  failures: Array<{ repo: string; error: string }>;
  observedAt?: string;
  lastSuccessAt?: string;
  providers: Set<'github' | 'ado'>;
}

async function fetchPullRequests(ctx: ScopeContext, refresh: boolean): Promise<PullRequestFetch> {
  const applicable = ctx.repos.filter((repo) => remoteProvider(repo.remoteUrl));
  const providers = new Set(applicable.map((repo) => remoteProvider(repo.remoteUrl)!));
  const entries = await mapLimit(applicable, NETWORK_CONCURRENCY, async (repo) => ({
    repo,
    entry: await cachedFetch(pullRequestCache, repo.id, NETWORK_TTL_MS, refresh, () =>
      listPullRequests(repo.remoteUrl),
    ),
  }));

  const rows: OverviewPullRequestRow[] = [];
  const failures: PullRequestFetch['failures'] = [];
  for (const { repo, entry } of entries) {
    if (entry.error) failures.push({ repo: repo.name, error: entry.error });
    const ref = primaryWorkspace(ctx, repo.workspaceIds);
    for (const pullRequest of entry.value ?? []) {
      rows.push({
        id: `${repo.id}:${pullRequest.provider}:${pullRequest.id}`,
        number: pullRequest.id,
        title: pullRequest.title,
        repoId: repo.id,
        repoName: repo.name,
        provider: pullRequest.provider,
        state: pullRequest.state,
        isDraft: pullRequest.isDraft,
        author: pullRequest.author,
        updatedAt: pullRequest.updatedAt,
        workspaceId: ref.workspaceId,
        workspaceName: ref.workspaceName,
        target: { url: pullRequest.url, workspaceId: ref.workspaceId },
      });
    }
  }
  return {
    rows,
    applicable: applicable.length,
    failures,
    providers,
    observedAt: oldest(entries.map(({ entry }) => entry.observedAt)),
    lastSuccessAt: oldest(entries.map(({ entry }) => entry.lastSuccessAt)),
  };
}

function providerLabel(providers: Set<'github' | 'ado'>): string {
  if (providers.size === 0) return 'Git hosting';
  return [...providers]
    .map((provider) => (provider === 'github' ? 'GitHub' : 'Azure DevOps'))
    .join(' · ');
}

function pullRequestFailureState(fetch: PullRequestFetch) {
  if (fetch.failures.length === 0) return {};
  const allFailed = fetch.failures.length === fetch.applicable;
  const first = fetch.failures[0];
  return {
    state: allFailed ? ('disconnected' as const) : ('ready' as const),
    message: allFailed
      ? first.error
      : `${fetch.failures.length} of ${fetch.applicable} repositories could not be refreshed. ${first.repo}: ${first.error}`,
    setupTarget: 'delivery#git',
  };
}

async function loadPullRequests(
  ctx: ScopeContext,
  module: OverviewModuleInstance,
  since: number,
  refresh: boolean,
): Promise<OverviewModuleResult<'pull-requests'>> {
  const fetch = await fetchPullRequests(ctx, refresh);
  const states = new Set<OverviewPullRequestState>(
    module.config.prStates?.length ? module.config.prStates : ['open', 'merged', 'closed'],
  );
  // Open pull requests are current state; merged/closed ones are history.
  const rows = fetch.rows.filter(
    (row) => states.has(row.state) && (row.state === 'open' || dateValue(row.updatedAt) >= since),
  );
  const sorted = sortRows(
    rows,
    module.config.sort,
    (row) => row.updatedAt,
    (row) => row.title,
  );
  return result('pull-requests', sorted, module.rows, {
    source: providerLabel(fetch.providers),
    observedAt: fetch.observedAt,
    lastSuccessAt: fetch.lastSuccessAt,
    emptyReason: fetch.applicable === 0 ? 'no-sources' : 'no-matches',
    message:
      fetch.applicable === 0
        ? 'No repository here has a GitHub or Azure DevOps remote.'
        : undefined,
    viewAllRoute: ctx.scope.kind === 'workspace' ? '/codereview' : undefined,
    ...pullRequestFailureState(fetch),
  });
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

interface SecurityFindingRow {
  id: string;
  severity: string;
  category: string;
  description: string;
  remediation: string | null;
  affected_files: string | null;
  work_item_id: string | null;
  repo_id: string;
  completed_at: string | null;
}

interface CodeReviewFindingRow {
  id: string;
  severity: string;
  category: string;
  description: string;
  suggestion: string | null;
  file_path: string | null;
  line_start: number | null;
  work_item_id: string | null;
  repo_id: string;
  completed_at: string | null;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  major: 3,
  medium: 2,
  minor: 2,
  low: 1,
  suggestion: 1,
  info: 0,
  nitpick: 0,
};

function severityTone(severity: string): OverviewTone {
  const rank = SEVERITY_RANK[severity] ?? 0;
  return rank >= 3 ? 'error' : rank === 2 ? 'warning' : 'info';
}

function parseFiles(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((file): file is string => typeof file === 'string')
      : [];
  } catch {
    return value
      .split(',')
      .map((file) => file.trim())
      .filter(Boolean);
  }
}

/** Latest completed audit per repo and latest completed review per scope; dismissed hidden. */
export function collectFindings(
  ctx: ScopeContext,
  config: OverviewModuleConfig,
): OverviewFindingRow[] {
  const repoIds = ctx.repos.map((repo) => repo.id);
  if (repoIds.length === 0) return [];
  const repos = new Map(ctx.repos.map((repo) => [repo.id, repo]));
  const sources = new Set(
    config.findingSources?.length ? config.findingSources : ['security', 'code-review'],
  );
  const floor = config.severity === 'high' ? 3 : config.severity === 'all' ? -1 : 2;
  const db = getDb();
  const rows: OverviewFindingRow[] = [];

  const push = (
    source: OverviewFindingRow['source'],
    row: {
      id: string;
      severity: string;
      category: string;
      description: string;
      work_item_id: string | null;
      repo_id: string;
      completed_at: string | null;
    },
    remediation: string | undefined,
    files: string[],
  ) => {
    if ((SEVERITY_RANK[row.severity] ?? 0) < floor) return;
    if (config.findingStatus !== 'all' && row.work_item_id) return;
    const repo = repos.get(row.repo_id);
    if (!repo) return;
    const ref = primaryWorkspace(ctx, repo.workspaceIds);
    rows.push({
      id: `${source}:${row.id}`,
      source,
      severity: row.severity,
      tone: severityTone(row.severity),
      title: row.category,
      description: row.description,
      remediation,
      files,
      repoId: repo.id,
      repoName: repo.name,
      workspaceId: ref.workspaceId,
      workspaceName: ref.workspaceName,
      alsoIn: ref.alsoIn,
      workItemId: row.work_item_id ?? undefined,
      detectedAt: iso(row.completed_at),
      target: {
        workspaceId: ref.workspaceId,
        route:
          source === 'security'
            ? securityRoute(repo.id)
            : `/codereview/${encodeURIComponent(repo.id)}`,
      },
    });
  };

  if (sources.has('security')) {
    const security = db
      .prepare(
        `WITH latest AS (
           SELECT id, repo_id, completed_at FROM (
             SELECT a.id, a.repo_id, a.completed_at,
                    ROW_NUMBER() OVER (PARTITION BY a.repo_id ORDER BY a.started_at DESC) AS rn
             FROM security_audits a
             WHERE a.status = 'completed' AND a.repo_id IN (${placeholders(repoIds.length)})
           ) WHERE rn = 1
         )
         SELECT f.id, f.severity, f.category, f.description, f.remediation, f.affected_files,
                f.work_item_id, latest.repo_id, latest.completed_at
         FROM security_findings f JOIN latest ON latest.id = f.audit_id
         WHERE f.dismissed = 0`,
      )
      .all(...repoIds) as SecurityFindingRow[];
    for (const row of security) {
      push('security', row, row.remediation ?? undefined, parseFiles(row.affected_files));
    }
  }

  if (sources.has('code-review')) {
    const reviews = db
      .prepare(
        `WITH latest AS (
           SELECT id, repo_id, completed_at FROM (
             SELECT r.id, r.repo_id, r.completed_at,
                    ROW_NUMBER() OVER (
                      PARTITION BY r.repo_id, r.scope_type, COALESCE(r.scope_ref, '')
                      ORDER BY r.started_at DESC
                    ) AS rn
             FROM code_reviews r
             WHERE r.status = 'completed' AND r.repo_id IN (${placeholders(repoIds.length)})
           ) WHERE rn = 1
         )
         SELECT f.id, f.severity, f.category, f.description, f.suggestion, f.file_path,
                f.line_start, f.work_item_id, latest.repo_id, latest.completed_at
         FROM code_review_findings f JOIN latest ON latest.id = f.review_id
         WHERE f.dismissed = 0`,
      )
      .all(...repoIds) as CodeReviewFindingRow[];
    for (const row of reviews) {
      const file = row.file_path
        ? `${row.file_path}${row.line_start ? `:${row.line_start}` : ''}`
        : null;
      push('code-review', row, row.suggestion ?? undefined, file ? [file] : []);
    }
  }

  return rows.sort(
    (a, b) =>
      (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
      dateValue(b.detectedAt) - dateValue(a.detectedAt),
  );
}

function loadFindings(
  ctx: ScopeContext,
  module: OverviewModuleInstance,
): OverviewModuleResult<'findings'> {
  const sources = module.config.findingSources?.length
    ? module.config.findingSources
    : ['security', 'code-review'];
  return result('findings', collectFindings(ctx, module.config), module.rows, {
    source:
      sources.length === 2 ? 'Checks' : sources[0] === 'security' ? 'Security' : 'Code review',
    emptyReason: 'no-matches',
    viewAllRoute:
      ctx.scope.kind === 'workspace'
        ? securityRoute(ctx.repos.length === 1 ? ctx.repos[0].id : undefined)
        : undefined,
  });
}

// ---------------------------------------------------------------------------
// Workspaces & repositories
// ---------------------------------------------------------------------------

function loadWorkspaces(
  ctx: ScopeContext,
  module: OverviewModuleInstance,
): OverviewModuleResult<'workspaces'> {
  const db = getDb();
  const ids = ctx.workspaces.map((workspace) => workspace.id);
  const latest = new Map<string, string>();
  const bump = (workspaceId: string, value: string | null) => {
    if (!value) return;
    const current = latest.get(workspaceId);
    if (!current || dateValue(value) > dateValue(current)) latest.set(workspaceId, value);
  };
  if (ids.length) {
    const marks = placeholders(ids.length);
    const queries = [
      `SELECT workspace_id, MAX(COALESCE(last_message_at, updated_at)) AS at FROM chat_threads
       WHERE workspace_id IN (${marks}) GROUP BY workspace_id`,
      `SELECT workspace_id, MAX(COALESCE(completed_at, started_at)) AS at FROM automation_runs
       WHERE workspace_id IN (${marks}) GROUP BY workspace_id`,
      `SELECT workspace_id, MAX(created_at) AS at FROM workspace_notes
       WHERE workspace_id IN (${marks}) GROUP BY workspace_id`,
    ];
    for (const sql of queries) {
      for (const row of db.prepare(sql).all(...ids) as Array<{
        workspace_id: string;
        at: string | null;
      }>) {
        bump(row.workspace_id, row.at);
      }
    }
  }
  for (const repo of ctx.repos) {
    for (const workspaceId of repo.workspaceIds) bump(workspaceId, repo.lastCommitDate);
  }

  const findings = collectFindings(ctx, { findingStatus: 'unlogged', severity: 'medium' });
  const findingCounts = new Map<string, number>();
  for (const finding of findings) {
    const repo = ctx.repos.find((entry) => entry.id === finding.repoId);
    for (const workspaceId of repo?.workspaceIds ?? []) {
      findingCounts.set(workspaceId, (findingCounts.get(workspaceId) ?? 0) + 1);
    }
  }
  const attention = new Map(
    getWorkspaceActivityFeed().map((summary) => [
      summary.workspaceId,
      summary.items.filter((item) => item.status === 'warning' || item.status === 'error').length,
    ]),
  );
  const repoCounts = new Map<string, number>();
  for (const repo of ctx.repos) {
    for (const workspaceId of repo.workspaceIds) {
      repoCounts.set(workspaceId, (repoCounts.get(workspaceId) ?? 0) + 1);
    }
  }

  const rows: OverviewWorkspaceRow[] = ctx.workspaces.map((workspace) => ({
    workspaceId: workspace.id,
    name: workspace.name,
    repoCount: repoCounts.get(workspace.id) ?? 0,
    latestActivityAt: iso(latest.get(workspace.id)),
    findingsToReview: findingCounts.get(workspace.id) ?? 0,
    needsAttention: attention.get(workspace.id) ?? 0,
    target: { workspaceId: workspace.id, route: '/workspace' },
  }));
  return result(
    'workspaces',
    sortRows(
      rows,
      module.config.sort,
      (row) => row.latestActivityAt,
      (row) => row.name,
    ),
    module.rows,
    { source: 'Local', emptyReason: 'no-matches' },
  );
}

async function loadRepositories(
  ctx: ScopeContext,
  module: OverviewModuleInstance,
  refresh: boolean,
): Promise<OverviewModuleResult<'repositories'>> {
  const statuses = await mapLimit(ctx.repos, NETWORK_CONCURRENCY, (repo) =>
    cachedFetch(gitCache, repo.id, LOCAL_TTL_MS, refresh, () => getFullStatus(repo.path)),
  );
  const rows: OverviewRepositoryRow[] = ctx.repos.map((repo, index) => {
    const status = statuses[index];
    return {
      repoId: repo.id,
      name: repo.name,
      branch: status.value?.branch,
      changedFiles: status.value?.files.length,
      gitError: status.error,
      indexStatus: repo.status,
      lastIndexed: iso(repo.lastIndexed),
      target: {
        workspaceId: repo.workspaceIds[0],
        route: `/workspace?view=repositories&repo=${encodeURIComponent(repo.id)}`,
      },
    };
  });
  return result(
    'repositories',
    sortRows(
      rows,
      module.config.sort ?? 'name',
      (row) => row.lastIndexed,
      (row) => row.name,
    ),
    module.rows,
    {
      source: 'Local',
      emptyReason: 'no-matches',
      observedAt: oldest(statuses.map((status) => status.observedAt)) ?? new Date().toISOString(),
      viewAllRoute: WORKSPACE_REPOSITORIES_ROUTE,
    },
  );
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

const WORK_ITEM_PROVIDER_LABEL: Record<WorkItemProvider, string> = {
  ado: 'Azure DevOps',
  linear: 'Linear',
  jira: 'Jira',
};

async function loadTickets(
  ctx: ScopeContext,
  module: OverviewModuleInstance,
  refresh: boolean,
): Promise<OverviewModuleResult<'tickets'>> {
  const settings = getSettings();
  const workspacePrefs =
    ctx.scope.kind === 'workspace' ? getWorkspacePreferences(ctx.scope.workspaceId) : null;
  const connectionId = module.config.connectionId ?? workspacePrefs?.workitems.workItemConnectionId;
  const connection = settings.workItemConnections?.find((entry) => entry.id === connectionId);
  if (!connection) {
    return {
      type: 'tickets',
      state: 'needs-setup',
      rows: [],
      total: 0,
      source: 'Tickets',
      message: connectionId
        ? 'The ticketing connection for this module is no longer configured.'
        : ctx.scope.kind === 'workspace'
          ? 'Choose a ticketing connection in this workspace’s setup.'
          : 'Choose a ticketing connection for this module.',
      setupTarget: ctx.scope.kind === 'workspace' ? 'workspace#connections' : 'delivery#work-items',
    };
  }

  // Keep the workspace's own iteration scope when this is its connection.
  const filters: WorkItemFilters = {
    state: module.config.ticketState,
    assignee: module.config.ticketAssignee,
    iterationIds:
      workspacePrefs?.workitems.workItemConnectionId === connection.id
        ? workspacePrefs.workitems.iterationIds
        : undefined,
  };
  const providerName = WORK_ITEM_PROVIDER_LABEL[connection.provider];
  const source =
    connection.name.trim().toLowerCase() === providerName.toLowerCase()
      ? providerName
      : `${providerName} · ${connection.name}`;
  const entry = await cachedFetch(
    ticketCache,
    JSON.stringify({ id: connection.id, filters }),
    NETWORK_TTL_MS,
    refresh,
    async () => {
      const provider = getActiveProvider(connection.id, refresh);
      if (!provider) throw new Error('This ticketing connection has no provider configured.');
      return provider.listItems(filters);
    },
  );

  const rows: OverviewTicketRow[] = (entry.value ?? []).map((item) => ({
    id: item.id,
    title: item.title,
    state: item.state,
    type: item.type,
    assignee: item.assignee,
    priority: item.priority,
    target: item.url
      ? { url: item.url }
      : { route: '/workitems', workspaceId: ctx.workspaces[0]?.id },
  }));
  return result('tickets', rows, module.rows, {
    source,
    observedAt: entry.observedAt,
    lastSuccessAt: entry.lastSuccessAt,
    emptyReason: 'no-matches',
    viewAllRoute: ctx.scope.kind === 'workspace' ? '/workitems' : undefined,
    ...(entry.error
      ? { state: 'disconnected', message: entry.error, setupTarget: 'delivery#work-items' }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Ideas & decisions
// ---------------------------------------------------------------------------

interface NoteRow {
  id: string;
  workspace_id: string;
  repo: string | null;
  body: string;
  created_at: string;
}

function noteTitle(body: string): string {
  const line = body.split(/\r?\n/).find((entry) => entry.trim()) ?? body;
  const text = line.replace(/^#+\s*/, '').trim();
  return text.length > 120 ? `${text.slice(0, 117).trimEnd()}...` : text;
}

async function loadIdeas(
  ctx: ScopeContext,
  module: OverviewModuleInstance,
  refresh: boolean,
): Promise<OverviewModuleResult<'ideas'>> {
  const types = new Set(
    module.config.contentTypes?.length ? module.config.contentTypes : ['notes', 'decisions'],
  );
  const rows: OverviewIdeaRow[] = [];
  const ids = ctx.workspaces.map((workspace) => workspace.id);

  if (types.has('notes') && ids.length) {
    const notes = getDb()
      .prepare(
        `SELECT id, workspace_id, repo, body, created_at FROM workspace_notes
         WHERE status = 'open' AND workspace_id IN (${placeholders(ids.length)})
         ORDER BY created_at DESC LIMIT 200`,
      )
      .all(...ids) as NoteRow[];
    for (const note of notes) {
      rows.push({
        id: `note:${note.id}`,
        kind: 'note',
        title: noteTitle(note.body),
        status: 'Open',
        workspaceId: note.workspace_id,
        workspaceName: ctx.workspaceNames.get(note.workspace_id),
        repoName: note.repo ?? undefined,
        createdAt: iso(note.created_at),
        target: { workspaceId: note.workspace_id, route: WORKSPACE_NOTES_ROUTE },
      });
    }
  }

  if (types.has('decisions')) {
    const scans = await mapLimit(ctx.repos, NETWORK_CONCURRENCY, (repo) =>
      cachedFetch(adrCache, repo.id, 5 * 60_000, refresh, async () => scanRepoForAdrs(repo.path)),
    );
    ctx.repos.forEach((repo, index) => {
      const ref = primaryWorkspace(ctx, repo.workspaceIds);
      for (const adr of scans[index].value ?? []) {
        rows.push({
          id: `adr:${repo.id}:${adr.relativePath}`,
          kind: 'decision',
          title: adr.title,
          status: adr.status,
          workspaceId: ref.workspaceId,
          workspaceName: ref.workspaceName,
          repoName: repo.name,
          target: { workspaceId: ref.workspaceId, route: libraryAdrRoute(repo.id) },
        });
      }
    });
  }

  return result('ideas', rows, module.rows, {
    source: 'Local',
    emptyReason: 'no-matches',
    viewAllRoute: ctx.scope.kind === 'workspace' ? WORKSPACE_NOTES_ROUTE : undefined,
  });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

interface ThreadRow {
  id: string;
  workspace_id: string;
  persona_id: string;
  title: string;
  repo_ids_json: string;
  attention_state: string;
  at: string;
}

function listThreadRows(ctx: ScopeContext, since: number): ThreadRow[] {
  const ids = ctx.workspaces.map((workspace) => workspace.id);
  if (!ids.length) return [];
  return (
    getDb()
      .prepare(
        `SELECT id, workspace_id, persona_id, title, repo_ids_json, attention_state,
                COALESCE(attention_updated_at, last_message_at, updated_at) AS at
         FROM chat_threads
         WHERE workspace_id IN (${placeholders(ids.length)})
           AND purpose = 'normal'
           AND settled_at IS NULL
         ORDER BY at DESC
         LIMIT 400`,
      )
      .all(...ids) as ThreadRow[]
  ).filter((row) => dateValue(row.at) >= since);
}

function parseRepoIds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function attentionState(value: string): ChatThreadAttentionState {
  return ['working', 'approval', 'input', 'failed', 'complete'].includes(value)
    ? (value as ChatThreadAttentionState)
    : 'idle';
}

function threadRoute(row: ThreadRow): string {
  return `/chat?thread=${encodeURIComponent(row.id)}&persona=${encodeURIComponent(row.persona_id)}`;
}

function loadSessions(
  ctx: ScopeContext,
  module: OverviewModuleInstance,
  since: number,
): OverviewModuleResult<'sessions'> {
  const states = module.config.sessionStates?.length ? new Set(module.config.sessionStates) : null;
  const repoFilter =
    ctx.scope.kind === 'workspace' && module.config.repoIds?.length
      ? new Set(module.config.repoIds)
      : null;
  const rows: OverviewSessionRow[] = listThreadRows(ctx, since)
    .map((row) => ({
      row,
      repoIds: parseRepoIds(row.repo_ids_json),
      state: attentionState(row.attention_state),
    }))
    .filter(({ state }) => !states || states.has(state))
    .filter(({ repoIds }) => !repoFilter || repoIds.some((id) => repoFilter.has(id)))
    .map(({ row, repoIds, state }) => ({
      threadId: row.id,
      title: row.title,
      state,
      repoCount: repoIds.length,
      lastActivityAt: iso(row.at) ?? row.at,
      workspaceId: row.workspace_id,
      workspaceName: ctx.workspaceNames.get(row.workspace_id) ?? 'Workspace',
      target: { workspaceId: row.workspace_id, route: threadRoute(row) },
    }));
  return result(
    'sessions',
    sortRows(
      rows,
      module.config.sort,
      (row) => row.lastActivityAt,
      (row) => row.title,
    ),
    module.rows,
    {
      source: 'Local',
      emptyReason: 'no-recent-activity',
      viewAllRoute: ctx.scope.kind === 'workspace' ? '/chat' : undefined,
    },
  );
}

// ---------------------------------------------------------------------------
// Automation runs
// ---------------------------------------------------------------------------

interface RunRow {
  id: string;
  automation_id: string;
  automation_name: string;
  workspace_id: string;
  trigger: string;
  status: string;
  assistant_message: string | null;
  error_message: string | null;
  changed_file_count: number;
  started_at: string;
  completed_at: string | null;
}

function listRunRows(ctx: ScopeContext, since: number): RunRow[] {
  const ids = ctx.workspaces.map((workspace) => workspace.id);
  if (!ids.length) return [];
  return (
    getDb()
      .prepare(
        `SELECT r.id, r.automation_id, d.name AS automation_name, r.workspace_id, r.trigger, r.status,
                r.assistant_message, r.error_message, r.changed_file_count, r.started_at, r.completed_at
         FROM automation_runs r JOIN automation_definitions d ON d.id = r.automation_id
         WHERE r.workspace_id IN (${placeholders(ids.length)})
         ORDER BY r.started_at DESC
         LIMIT 400`,
      )
      .all(...ids) as RunRow[]
  ).filter((row) => dateValue(row.completed_at ?? row.started_at) >= since);
}

function firstLine(value: string | null | undefined, max = 140): string | undefined {
  const line = value
    ?.split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 3).trimEnd()}...` : line;
}

function runStatus(value: string): AutomationRunStatus {
  return ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(value)
    ? (value as AutomationRunStatus)
    : 'queued';
}

function runRoute(row: RunRow): string {
  return `/automations?automation=${encodeURIComponent(row.automation_id)}&run=${encodeURIComponent(row.id)}`;
}

function loadAutomationRuns(
  ctx: ScopeContext,
  module: OverviewModuleInstance,
  since: number,
): OverviewModuleResult<'automation-runs'> {
  const outcomes = module.config.runOutcomes?.length ? new Set(module.config.runOutcomes) : null;
  const automations = module.config.automationIds?.length
    ? new Set(module.config.automationIds)
    : null;
  const rows: OverviewAutomationRunRow[] = listRunRows(ctx, since)
    .filter((row) => !automations || automations.has(row.automation_id))
    .map((row) => ({ row, status: runStatus(row.status) }))
    .filter(({ status }) => !outcomes || outcomes.has(status))
    .map(({ row, status }) => ({
      runId: row.id,
      automationId: row.automation_id,
      automationName: row.automation_name,
      status,
      trigger: row.trigger,
      startedAt: iso(row.started_at) ?? row.started_at,
      completedAt: iso(row.completed_at),
      changedFileCount: row.changed_file_count,
      summary: firstLine(row.error_message) ?? firstLine(row.assistant_message),
      workspaceId: row.workspace_id,
      workspaceName: ctx.workspaceNames.get(row.workspace_id) ?? 'Workspace',
      target: { workspaceId: row.workspace_id, route: runRoute(row) },
    }));
  return result(
    'automation-runs',
    sortRows(
      rows,
      module.config.sort,
      (row) => row.completedAt ?? row.startedAt,
      (row) => row.automationName,
    ),
    module.rows,
    {
      source: 'Watchtower',
      emptyReason: 'no-recent-activity',
      viewAllRoute: ctx.scope.kind === 'workspace' ? '/automations' : undefined,
    },
  );
}

// ---------------------------------------------------------------------------
// Documentation
// ---------------------------------------------------------------------------

const DOCS_PROVIDER_LABEL = {
  confluence: 'Confluence',
  notion: 'Notion',
  linear: 'Linear',
} as const;

function formatDay(value: string): string {
  return new Date(dateValue(value)).toISOString().slice(0, 10);
}

/** A page is worth reviewing once the code it covers has moved on by more than a week. */
export function documentReview(
  page: Pick<DocPage, 'lastUpdated'>,
  latestCommit: { repoName: string; date: string } | null,
): Pick<OverviewDocumentRow, 'review' | 'evidence'> {
  if (!latestCommit || !page.lastUpdated) return { review: 'unknown' };
  const gapDays = (dateValue(latestCommit.date) - dateValue(page.lastUpdated)) / 86_400_000;
  if (gapDays > STALE_DOC_DAYS) {
    return {
      review: 'needs-review',
      evidence: `${latestCommit.repoName} changed on ${formatDay(latestCommit.date)}; this page was last updated on ${formatDay(page.lastUpdated)}.`,
    };
  }
  return { review: 'current' };
}

async function loadDocumentation(
  ctx: ScopeContext,
  module: OverviewModuleInstance,
  since: number,
  refresh: boolean,
): Promise<OverviewModuleResult<'documentation'>> {
  const settings = getSettings();
  const provider = getActiveDocsProvider();
  const providerId = settings.docsProvider;
  if (!provider || providerId === 'none' || !provider.isConfigured()) {
    return {
      type: 'documentation',
      state: 'needs-setup',
      rows: [],
      total: 0,
      source: 'Documentation',
      message: 'Connect Confluence, Notion or Linear documents in Settings.',
      setupTarget: 'delivery#docs',
    };
  }
  const parentPageId =
    ctx.scope.kind === 'workspace'
      ? getWorkspacePreferences(ctx.scope.workspaceId)?.docs.parentPageId
      : undefined;
  const location = parentPageId ?? provider.getSpaceKeyOrParent();
  const run = <T>(action: () => Promise<T>) => {
    if (providerId !== 'linear') return action();
    const apiKey = settings.linearApiKey?.trim();
    if (!apiKey) throw new Error('Linear API key must be configured in Work Items settings.');
    return withLinearDocsApiKey(apiKey, action);
  };
  const entry = await cachedFetch(
    docsCache,
    JSON.stringify({ providerId, parentPageId, location }),
    NETWORK_TTL_MS,
    refresh,
    () =>
      run(() =>
        parentPageId ? provider.listChildren(parentPageId) : provider.listPages(location),
      ),
  );

  const latestRepo = [...ctx.repos]
    .filter((repo) => repo.lastCommitDate)
    .sort((a, b) => dateValue(b.lastCommitDate) - dateValue(a.lastCommitDate))[0];
  const latestCommit = latestRepo
    ? { repoName: latestRepo.name, date: latestRepo.lastCommitDate! }
    : null;
  const mode = module.config.docsChange ?? 'all';
  const rows: OverviewDocumentRow[] = (entry.value ?? [])
    .map((page) => ({
      id: page.id,
      title: page.title,
      lastUpdated: iso(page.lastUpdated) ?? page.lastUpdated,
      lastUpdatedBy: page.lastUpdatedBy || undefined,
      ...documentReview(page, latestCommit),
      target: { url: page.url },
    }))
    .filter((row) => {
      const changed = dateValue(row.lastUpdated) >= since;
      if (mode === 'changed') return changed;
      if (mode === 'needs-review') return row.review === 'needs-review';
      return changed || row.review === 'needs-review';
    })
    .sort((a, b) => dateValue(b.lastUpdated) - dateValue(a.lastUpdated));

  return result('documentation', rows, module.rows, {
    source: DOCS_PROVIDER_LABEL[providerId],
    observedAt: entry.observedAt,
    lastSuccessAt: entry.lastSuccessAt,
    emptyReason: mode === 'needs-review' ? 'no-matches' : 'no-recent-activity',
    viewAllRoute: ctx.scope.kind === 'workspace' ? LIBRARY_DOCS_ROUTE : undefined,
    ...(entry.error
      ? { state: 'disconnected', message: entry.error, setupTarget: 'delivery#docs' }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Recent activity
// ---------------------------------------------------------------------------

interface CheckRunRow {
  id: string;
  repo_id: string;
  completed_at: string;
  finding_count: number;
}

const PULL_REQUEST_OUTCOME: Record<
  OverviewPullRequestState,
  { label: string; tone: OverviewTone }
> = {
  merged: { label: 'Merged', tone: 'success' },
  closed: { label: 'Closed, unmerged', tone: 'neutral' },
  open: { label: 'Open', tone: 'info' },
};

const SESSION_OUTCOME: Partial<
  Record<ChatThreadAttentionState, { label: string; tone: OverviewTone }>
> = {
  complete: { label: 'Finished', tone: 'success' },
  failed: { label: 'Failed', tone: 'error' },
  approval: { label: 'Needs approval', tone: 'warning' },
  input: { label: 'Needs input', tone: 'warning' },
  working: { label: 'Running', tone: 'info' },
};

const RUN_OUTCOME: Record<AutomationRunStatus, { label: string; tone: OverviewTone }> = {
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'error' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  queued: { label: 'Queued', tone: 'neutral' },
};

async function loadActivity(
  ctx: ScopeContext,
  module: OverviewModuleInstance,
  since: number,
  refresh: boolean,
): Promise<OverviewModuleResult<'activity'>> {
  const events = new Set<OverviewActivityEventType>(
    module.config.eventTypes?.length
      ? module.config.eventTypes
      : (OVERVIEW_MODULES.activity.defaultConfig.eventTypes ?? []),
  );
  const rows: OverviewActivityRow[] = [];
  let pullRequestState: Partial<OverviewModuleResult<'activity'>> = {};
  const repoById = new Map(ctx.repos.map((repo) => [repo.id, repo]));

  if (events.has('pull-request')) {
    const fetch = await fetchPullRequests(ctx, refresh);
    for (const pullRequest of fetch.rows) {
      if (dateValue(pullRequest.updatedAt) < since) continue;
      const outcome = PULL_REQUEST_OUTCOME[pullRequest.state];
      rows.push({
        id: `pr:${pullRequest.id}`,
        kind: 'pull-request',
        title: pullRequest.title,
        detail: `${pullRequest.repoName} #${pullRequest.number}`,
        repoName: pullRequest.repoName,
        outcome: pullRequest.isDraft && pullRequest.state === 'open' ? 'Draft' : outcome.label,
        tone: outcome.tone,
        occurredAt: pullRequest.updatedAt,
        workspaceId: pullRequest.workspaceId,
        workspaceName: pullRequest.workspaceName,
        target: pullRequest.target,
      });
    }
    const failure = pullRequestFailureState(fetch);
    if (failure.message) {
      // Other local sources stay current; surface the partial refresh only.
      pullRequestState = {
        message: `Pull requests: ${failure.message}`,
        setupTarget: failure.setupTarget,
      };
    }
  }

  if (events.has('session')) {
    for (const row of listThreadRows(ctx, since)) {
      const outcome = SESSION_OUTCOME[attentionState(row.attention_state)];
      if (!outcome) continue;
      rows.push({
        id: `session:${row.id}`,
        kind: 'session',
        title: row.title,
        outcome: outcome.label,
        tone: outcome.tone,
        occurredAt: iso(row.at) ?? row.at,
        workspaceId: row.workspace_id,
        workspaceName: ctx.workspaceNames.get(row.workspace_id) ?? 'Workspace',
        target: { workspaceId: row.workspace_id, route: threadRoute(row) },
      });
    }
  }

  if (events.has('automation')) {
    for (const row of listRunRows(ctx, since)) {
      const outcome = RUN_OUTCOME[runStatus(row.status)];
      rows.push({
        id: `run:${row.id}`,
        kind: 'automation',
        title: row.automation_name,
        detail: firstLine(row.error_message) ?? firstLine(row.assistant_message),
        outcome: outcome.label,
        tone: outcome.tone,
        occurredAt: iso(row.completed_at ?? row.started_at) ?? row.started_at,
        workspaceId: row.workspace_id,
        workspaceName: ctx.workspaceNames.get(row.workspace_id) ?? 'Workspace',
        target: { workspaceId: row.workspace_id, route: runRoute(row) },
      });
    }
  }

  if (events.has('finding') && ctx.repos.length) {
    const marks = placeholders(ctx.repos.length);
    const repoIds = ctx.repos.map((repo) => repo.id);
    const sources: Array<{ kind: 'security' | 'codereview'; label: string; sql: string }> = [
      {
        kind: 'security',
        label: 'Security audit',
        sql: `SELECT a.id, a.repo_id, a.completed_at,
                     (SELECT COUNT(*) FROM security_findings f WHERE f.audit_id = a.id AND f.dismissed = 0) AS finding_count
              FROM security_audits a
              WHERE a.status = 'completed' AND a.completed_at IS NOT NULL AND a.repo_id IN (${marks})`,
      },
      {
        kind: 'codereview',
        label: 'Code review',
        sql: `SELECT r.id, r.repo_id, r.completed_at,
                     (SELECT COUNT(*) FROM code_review_findings f WHERE f.review_id = r.id AND f.dismissed = 0) AS finding_count
              FROM code_reviews r
              WHERE r.status = 'completed' AND r.completed_at IS NOT NULL AND r.repo_id IN (${marks})`,
      },
    ];
    for (const source of sources) {
      for (const row of getDb()
        .prepare(source.sql)
        .all(...repoIds) as CheckRunRow[]) {
        if (dateValue(row.completed_at) < since) continue;
        const repo = repoById.get(row.repo_id);
        if (!repo) continue;
        const ref = primaryWorkspace(ctx, repo.workspaceIds);
        rows.push({
          id: `check:${source.kind}:${row.id}`,
          kind: 'finding',
          title: `${source.label} · ${repo.name}`,
          repoName: repo.name,
          outcome:
            row.finding_count === 0
              ? 'No findings'
              : `${row.finding_count} finding${row.finding_count === 1 ? '' : 's'}`,
          tone: row.finding_count === 0 ? 'success' : 'warning',
          occurredAt: iso(row.completed_at) ?? row.completed_at,
          workspaceId: ref.workspaceId,
          workspaceName: ref.workspaceName,
          target: {
            workspaceId: ref.workspaceId,
            route:
              source.kind === 'security'
                ? securityRoute(repo.id)
                : `/codereview/${encodeURIComponent(repo.id)}`,
          },
        });
      }
    }
  }

  if (events.has('note') && ctx.workspaces.length) {
    const ids = ctx.workspaces.map((workspace) => workspace.id);
    const notes = getDb()
      .prepare(
        `SELECT id, workspace_id, repo, body, created_at FROM workspace_notes
         WHERE workspace_id IN (${placeholders(ids.length)}) AND status != 'dismissed'
         ORDER BY created_at DESC LIMIT 200`,
      )
      .all(...ids) as NoteRow[];
    for (const note of notes) {
      if (dateValue(note.created_at) < since) continue;
      rows.push({
        id: `note:${note.id}`,
        kind: 'note',
        title: noteTitle(note.body),
        repoName: note.repo ?? undefined,
        outcome: 'Note added',
        tone: 'neutral',
        occurredAt: iso(note.created_at) ?? note.created_at,
        workspaceId: note.workspace_id,
        workspaceName: ctx.workspaceNames.get(note.workspace_id) ?? 'Workspace',
        target: { workspaceId: note.workspace_id, route: WORKSPACE_NOTES_ROUTE },
      });
    }
  }

  const sorted = sortRows(
    rows,
    module.config.sort,
    (row) => row.occurredAt,
    (row) => row.title,
  );
  return result('activity', sorted, module.rows, {
    source:
      events.has('pull-request') && ctx.repos.some((repo) => remoteProvider(repo.remoteUrl))
        ? 'Local · Git hosting'
        : 'Local',
    emptyReason: 'no-recent-activity',
    ...pullRequestState,
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function loadOverviewModule(
  request: OverviewModuleRequest,
): Promise<OverviewModuleResult> {
  const scope = assertOverviewScope(request.scope);
  const module = request.module;
  if (!OVERVIEW_MODULES[module?.type]) throw new Error('Unknown overview module.');
  const ctx = resolveOverviewScope(scope, module.config ?? {});
  const since = timeRangeStart(request.timeRange ?? '7d');
  const refresh = request.refresh === true;

  switch (module.type) {
    case 'activity':
      return loadActivity(ctx, module, since, refresh);
    case 'pull-requests':
      return loadPullRequests(ctx, module, since, refresh);
    case 'findings':
      return loadFindings(ctx, module);
    case 'workspaces':
      return loadWorkspaces(ctx, module);
    case 'repositories':
      return loadRepositories(ctx, module, refresh);
    case 'tickets':
      return loadTickets(ctx, module, refresh);
    case 'ideas':
      return loadIdeas(ctx, module, refresh);
    case 'sessions':
      return loadSessions(ctx, module, since);
    case 'automation-runs':
      return loadAutomationRuns(ctx, module, since);
    case 'documentation':
      return loadDocumentation(ctx, module, since, refresh);
    case 'pinned-links': {
      const links = module.config.links ?? [];
      return result('pinned-links', links, module.rows, {
        source: 'Pinned',
        emptyReason: 'no-matches',
      });
    }
  }
}
