import type {
  AutomationRunStatus,
  ChatThreadAttentionState,
  DocsProvider,
  Feature,
  WorkItemProvider,
} from './types.js';

// ---------------------------------------------------------------------------
// Overview (ANV-51): configurable all-workspaces and single-workspace overviews.
// ---------------------------------------------------------------------------

export type OverviewModuleType =
  | 'activity'
  | 'pull-requests'
  | 'findings'
  | 'workspaces'
  | 'repositories'
  | 'tickets'
  | 'ideas'
  | 'sessions'
  | 'automation-runs'
  | 'documentation'
  | 'pinned-links';

export type OverviewModuleWidth = 'third' | 'half' | 'two-thirds' | 'full';
export type OverviewTimeRange = '24h' | '7d' | '30d' | '90d';

export type OverviewScope = { kind: 'global' } | { kind: 'workspace'; workspaceId: string };

/** Where a layout is stored: personal global, default for every workspace, or one workspace. */
export type OverviewLayoutTarget = 'global' | 'workspace-default' | `workspace:${string}`;

export type OverviewActivityEventType =
  | 'pull-request'
  | 'session'
  | 'automation'
  | 'finding'
  | 'note';
export type OverviewPullRequestState = 'open' | 'merged' | 'closed';
export type OverviewFindingSource = 'security' | 'code-review';
export type OverviewSeverityFloor = 'high' | 'medium' | 'all';
export type OverviewIdeaContentType = 'notes' | 'decisions';
export type OverviewDocsChange = 'all' | 'changed' | 'needs-review';
export type OverviewSort = 'newest' | 'oldest' | 'name';

export interface OverviewPinnedLink {
  id: string;
  label: string;
  /** An in-app route (`/chat`) or an http(s) URL. */
  target: string;
}

/**
 * One flat, optional bag of settings. Each module type reads the subset its
 * catalogue entry declares; unknown keys are dropped on save.
 */
export interface OverviewModuleConfig {
  workspaceIds?: string[];
  repoIds?: string[];
  eventTypes?: OverviewActivityEventType[];
  prStates?: OverviewPullRequestState[];
  findingSources?: OverviewFindingSource[];
  findingStatus?: 'unlogged' | 'all';
  severity?: OverviewSeverityFloor;
  connectionId?: string;
  ticketState?: string;
  ticketAssignee?: string;
  contentTypes?: OverviewIdeaContentType[];
  sessionStates?: ChatThreadAttentionState[];
  automationIds?: string[];
  runOutcomes?: AutomationRunStatus[];
  docsChange?: OverviewDocsChange;
  links?: OverviewPinnedLink[];
  sort?: OverviewSort;
  /** Optional columns that are visible; required columns always render. */
  columns?: string[];
}

export interface OverviewModuleInstance {
  id: string;
  type: OverviewModuleType;
  /** Display name override; falls back to the catalogue label. */
  title?: string;
  width: OverviewModuleWidth;
  rows: number;
  config: OverviewModuleConfig;
}

export interface OverviewLayout {
  version: 1;
  modules: OverviewModuleInstance[];
}

export type OverviewLayoutSource =
  | 'personal'
  | 'workspace-override'
  | 'workspace-default'
  | 'built-in';

export interface OverviewLayoutState {
  layout: OverviewLayout;
  source: OverviewLayoutSource;
  /** Layout the "Reset layout" action falls back to for the current target. */
  fallback: OverviewLayout;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface OverviewWorkItemConnectionSummary {
  id: string;
  name: string;
  provider: WorkItemProvider;
}

export interface OverviewSources {
  workItemConnections: OverviewWorkItemConnectionSummary[];
  /** Ticketing connection chosen in each workspace's setup. */
  workspaceConnectionIds: Record<string, string | undefined>;
  docs: { provider: DocsProvider | 'none'; configured: boolean };
}

export type OverviewSourceRequirement = 'tickets' | 'docs';

// ---------------------------------------------------------------------------
// Module data
// ---------------------------------------------------------------------------

export type OverviewTone = 'success' | 'warning' | 'error' | 'info' | 'neutral' | 'accent';

/** Where a row leads. Routes are workspace-relative and switch workspace first. */
export interface OverviewTarget {
  workspaceId?: string;
  route?: string;
  url?: string;
}

export interface OverviewWorkspaceRef {
  workspaceId: string;
  workspaceName: string;
}

export interface OverviewActivityRow extends OverviewWorkspaceRef {
  id: string;
  kind: OverviewActivityEventType;
  title: string;
  detail?: string;
  repoName?: string;
  outcome: string;
  tone: OverviewTone;
  occurredAt: string;
  target: OverviewTarget;
}

export interface OverviewPullRequestRow extends OverviewWorkspaceRef {
  id: string;
  number: string;
  title: string;
  repoId: string;
  repoName: string;
  provider: 'github' | 'ado';
  state: OverviewPullRequestState;
  isDraft: boolean;
  author?: string;
  updatedAt: string;
  target: OverviewTarget;
}

export interface OverviewFindingRow extends OverviewWorkspaceRef {
  id: string;
  source: OverviewFindingSource;
  severity: string;
  tone: OverviewTone;
  title: string;
  description: string;
  remediation?: string;
  files: string[];
  repoId: string;
  repoName: string;
  /** Other workspaces that include the same repository. */
  alsoIn: string[];
  workItemId?: string;
  detectedAt?: string;
  target: OverviewTarget;
}

export interface OverviewWorkspaceRow {
  workspaceId: string;
  name: string;
  repoCount: number;
  latestActivityAt?: string;
  findingsToReview: number;
  needsAttention: number;
  target: OverviewTarget;
}

export interface OverviewRepositoryRow {
  repoId: string;
  name: string;
  branch?: string;
  changedFiles?: number;
  gitError?: string;
  indexStatus: 'connected' | 'indexing' | 'indexed' | 'error';
  lastIndexed?: string;
  target: OverviewTarget;
}

export interface OverviewTicketRow {
  id: string;
  title: string;
  state: string;
  type: string;
  assignee?: string;
  priority: number;
  target: OverviewTarget;
}

export interface OverviewIdeaRow {
  id: string;
  kind: 'note' | 'decision';
  title: string;
  status?: string;
  workspaceId?: string;
  workspaceName?: string;
  repoName?: string;
  createdAt?: string;
  target: OverviewTarget;
}

export interface OverviewSessionRow extends OverviewWorkspaceRef {
  threadId: string;
  title: string;
  state: ChatThreadAttentionState;
  repoCount: number;
  lastActivityAt: string;
  target: OverviewTarget;
}

export interface OverviewAutomationRunRow extends OverviewWorkspaceRef {
  runId: string;
  automationId: string;
  automationName: string;
  status: AutomationRunStatus;
  trigger: string;
  startedAt: string;
  completedAt?: string;
  changedFileCount: number;
  summary?: string;
  target: OverviewTarget;
}

export interface OverviewDocumentRow {
  id: string;
  title: string;
  lastUpdated: string;
  lastUpdatedBy?: string;
  review: 'needs-review' | 'current' | 'unknown';
  /** Plain-language reason a review is suggested. */
  evidence?: string;
  target: OverviewTarget;
}

export interface OverviewRowsByType {
  activity: OverviewActivityRow;
  'pull-requests': OverviewPullRequestRow;
  findings: OverviewFindingRow;
  workspaces: OverviewWorkspaceRow;
  repositories: OverviewRepositoryRow;
  tickets: OverviewTicketRow;
  ideas: OverviewIdeaRow;
  sessions: OverviewSessionRow;
  'automation-runs': OverviewAutomationRunRow;
  documentation: OverviewDocumentRow;
  'pinned-links': OverviewPinnedLink;
}

/**
 * - `ready`: rows reflect the source (possibly empty).
 * - `needs-setup`: the source is not configured; `setupTarget` points at Settings.
 * - `disconnected`: the last refresh failed; rows are the last successful result.
 */
export type OverviewModuleState = 'ready' | 'needs-setup' | 'disconnected';

export interface OverviewModuleResult<T extends OverviewModuleType = OverviewModuleType> {
  type: T;
  state: OverviewModuleState;
  rows: OverviewRowsByType[T][];
  /** Matching rows before the row limit. */
  total: number;
  /** Human source label, e.g. "GitHub", "Linear · Platform", "Local". */
  source: string;
  observedAt?: string;
  lastSuccessAt?: string;
  /** Plain-language detail for setup, disconnection, or partial refreshes. */
  message?: string;
  /** Settings deep link (`category#panel`) for setup or reconnect. */
  setupTarget?: string;
  /** Why an empty result is empty: nothing matches vs. nothing happened in range. */
  emptyReason?: 'no-matches' | 'no-recent-activity' | 'no-sources';
  /** In-app route to the full view for this module, when one exists. */
  viewAllRoute?: string;
}

export interface OverviewModuleRequest {
  scope: OverviewScope;
  module: OverviewModuleInstance;
  timeRange: OverviewTimeRange;
  /** Bypass cached network results. */
  refresh?: boolean;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface OverviewColumnDefinition {
  id: string;
  label: string;
  required?: boolean;
}

export interface OverviewModuleDefinition {
  type: OverviewModuleType;
  label: string;
  description: string;
  scopes: ReadonlyArray<OverviewScope['kind']>;
  defaultWidth: OverviewModuleWidth;
  defaultRows: number;
  /** True when the global time filter applies (event history, not current state). */
  timeScoped: boolean;
  requires?: OverviewSourceRequirement;
  /** Role features that make the module relevant; any one is enough. */
  features?: Feature[];
  columns: OverviewColumnDefinition[];
  defaultConfig: OverviewModuleConfig;
  /** Config keys the module reads; everything else is stripped on save. */
  configKeys: ReadonlyArray<keyof OverviewModuleConfig>;
  /** First-scope modules ship in the default layouts. */
  wave: 1 | 2;
}

export const OVERVIEW_WIDTHS: ReadonlyArray<{ value: OverviewModuleWidth; label: string }> = [
  { value: 'third', label: 'One third' },
  { value: 'half', label: 'Half' },
  { value: 'two-thirds', label: 'Two thirds' },
  { value: 'full', label: 'Full width' },
];

export const OVERVIEW_TIME_RANGES: ReadonlyArray<{ value: OverviewTimeRange; label: string }> = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
];

export const OVERVIEW_MIN_ROWS = 3;
export const OVERVIEW_MAX_ROWS = 25;
export const OVERVIEW_MAX_MODULES = 24;
export const OVERVIEW_MAX_LINKS = 12;

const BOTH_SCOPES = ['global', 'workspace'] as const;

export const OVERVIEW_MODULES: Record<OverviewModuleType, OverviewModuleDefinition> = {
  activity: {
    type: 'activity',
    label: 'Recent activity',
    description: 'Merged and closed changes, finished sessions, runs, findings and notes.',
    scopes: BOTH_SCOPES,
    defaultWidth: 'two-thirds',
    defaultRows: 6,
    timeScoped: true,
    columns: [
      { id: 'event', label: 'Change', required: true },
      { id: 'workspace', label: 'Workspace' },
      { id: 'outcome', label: 'Outcome' },
      { id: 'when', label: 'When' },
    ],
    defaultConfig: {
      eventTypes: ['pull-request', 'session', 'automation', 'finding', 'note'],
      sort: 'newest',
    },
    configKeys: ['workspaceIds', 'repoIds', 'eventTypes', 'sort', 'columns'],
    wave: 1,
  },
  'pull-requests': {
    type: 'pull-requests',
    label: 'Pull requests',
    description: 'Open, merged and closed pull requests from GitHub or Azure DevOps.',
    scopes: BOTH_SCOPES,
    defaultWidth: 'two-thirds',
    defaultRows: 6,
    timeScoped: true,
    features: ['codereview', 'git'],
    columns: [
      { id: 'number', label: '#' },
      { id: 'title', label: 'Title', required: true },
      { id: 'repository', label: 'Repository' },
      { id: 'author', label: 'Author' },
      { id: 'status', label: 'Status' },
      { id: 'updated', label: 'Updated' },
    ],
    defaultConfig: { prStates: ['open', 'merged', 'closed'], sort: 'newest' },
    configKeys: ['workspaceIds', 'repoIds', 'prStates', 'sort', 'columns'],
    wave: 1,
  },
  findings: {
    type: 'findings',
    label: 'Findings to review',
    description: 'Unconfirmed results from security audits and code reviews, with evidence.',
    scopes: BOTH_SCOPES,
    defaultWidth: 'third',
    defaultRows: 4,
    timeScoped: false,
    features: ['security', 'codereview'],
    columns: [{ id: 'finding', label: 'Finding', required: true }],
    defaultConfig: {
      findingSources: ['security', 'code-review'],
      findingStatus: 'unlogged',
      severity: 'medium',
    },
    configKeys: ['workspaceIds', 'repoIds', 'findingSources', 'findingStatus', 'severity'],
    wave: 1,
  },
  workspaces: {
    type: 'workspaces',
    label: 'Workspaces',
    description: 'Each workspace with its repositories, latest activity and findings.',
    scopes: ['global'],
    defaultWidth: 'two-thirds',
    defaultRows: 6,
    timeScoped: false,
    columns: [
      { id: 'workspace', label: 'Workspace', required: true },
      { id: 'repositories', label: 'Repositories' },
      { id: 'activity', label: 'Latest activity' },
      { id: 'findings', label: 'Findings' },
    ],
    defaultConfig: { sort: 'newest' },
    configKeys: ['workspaceIds', 'sort', 'columns'],
    wave: 1,
  },
  repositories: {
    type: 'repositories',
    label: 'Repositories',
    description: 'Branch, working tree and index state for each repository.',
    scopes: ['workspace'],
    defaultWidth: 'two-thirds',
    defaultRows: 6,
    timeScoped: false,
    features: ['repos'],
    columns: [
      { id: 'repository', label: 'Repository', required: true },
      { id: 'branch', label: 'Branch' },
      { id: 'tree', label: 'Working tree' },
      { id: 'indexed', label: 'Indexed' },
    ],
    defaultConfig: { sort: 'name' },
    configKeys: ['repoIds', 'sort', 'columns'],
    wave: 1,
  },
  tickets: {
    type: 'tickets',
    label: 'Tickets',
    description: 'Records from a connected ticketing system, in its own states.',
    scopes: BOTH_SCOPES,
    defaultWidth: 'third',
    defaultRows: 5,
    timeScoped: false,
    requires: 'tickets',
    features: ['workitems'],
    columns: [
      { id: 'id', label: 'ID' },
      { id: 'title', label: 'Title', required: true },
      { id: 'type', label: 'Type' },
      { id: 'assignee', label: 'Assignee' },
      { id: 'status', label: 'Status' },
    ],
    defaultConfig: { columns: ['id', 'status'] },
    configKeys: ['connectionId', 'ticketState', 'ticketAssignee', 'columns'],
    wave: 1,
  },
  ideas: {
    type: 'ideas',
    label: 'Ideas & decisions',
    description: 'Open workspace notes and architecture decision records.',
    scopes: BOTH_SCOPES,
    defaultWidth: 'third',
    defaultRows: 5,
    timeScoped: false,
    features: ['workspace-notes', 'adrs'],
    columns: [
      { id: 'idea', label: 'Idea', required: true },
      { id: 'workspace', label: 'Workspace' },
      { id: 'type', label: 'Type' },
      { id: 'added', label: 'Added' },
    ],
    defaultConfig: { contentTypes: ['notes', 'decisions'], columns: ['type'] },
    configKeys: ['workspaceIds', 'contentTypes', 'columns'],
    wave: 1,
  },
  sessions: {
    type: 'sessions',
    label: 'Recent sessions',
    description: 'Conversations to reopen or resume.',
    scopes: BOTH_SCOPES,
    defaultWidth: 'two-thirds',
    defaultRows: 4,
    timeScoped: true,
    features: ['chat'],
    columns: [
      { id: 'session', label: 'Session', required: true },
      { id: 'workspace', label: 'Workspace' },
      { id: 'status', label: 'Status' },
      { id: 'when', label: 'When' },
    ],
    defaultConfig: { sort: 'newest' },
    configKeys: ['workspaceIds', 'repoIds', 'sessionStates', 'sort', 'columns'],
    wave: 2,
  },
  'automation-runs': {
    type: 'automation-runs',
    label: 'Automation runs',
    description: 'Latest runs, their outcomes and links to logs.',
    scopes: BOTH_SCOPES,
    defaultWidth: 'half',
    defaultRows: 5,
    timeScoped: true,
    features: ['automations'],
    columns: [
      { id: 'automation', label: 'Automation', required: true },
      { id: 'workspace', label: 'Workspace' },
      { id: 'outcome', label: 'Outcome' },
      { id: 'when', label: 'When' },
    ],
    defaultConfig: { sort: 'newest' },
    configKeys: ['workspaceIds', 'automationIds', 'runOutcomes', 'sort', 'columns'],
    wave: 2,
  },
  documentation: {
    type: 'documentation',
    label: 'Documentation',
    description: 'Changed pages, and pages older than the code they describe.',
    scopes: BOTH_SCOPES,
    defaultWidth: 'half',
    defaultRows: 5,
    timeScoped: true,
    requires: 'docs',
    features: ['docs'],
    columns: [
      { id: 'page', label: 'Page', required: true },
      { id: 'review', label: 'Review' },
      { id: 'updated', label: 'Updated' },
    ],
    defaultConfig: { docsChange: 'all' },
    configKeys: ['docsChange', 'columns'],
    wave: 2,
  },
  'pinned-links': {
    type: 'pinned-links',
    label: 'Pinned links',
    description: 'Useful destinations, in your order.',
    scopes: BOTH_SCOPES,
    defaultWidth: 'third',
    defaultRows: 6,
    timeScoped: false,
    columns: [{ id: 'link', label: 'Link', required: true }],
    defaultConfig: { links: [] },
    configKeys: ['links'],
    wave: 2,
  },
};

export const OVERVIEW_MODULE_ORDER: OverviewModuleType[] = [
  'activity',
  'pull-requests',
  'findings',
  'workspaces',
  'repositories',
  'tickets',
  'ideas',
  'sessions',
  'automation-runs',
  'documentation',
  'pinned-links',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function overviewLayoutTarget(scope: OverviewScope): OverviewLayoutTarget {
  return scope.kind === 'global' ? 'global' : `workspace:${scope.workspaceId}`;
}

export function moduleAllowedInScope(type: OverviewModuleType, scope: OverviewScope): boolean {
  return OVERVIEW_MODULES[type].scopes.includes(scope.kind);
}

export function moduleTitle(module: Pick<OverviewModuleInstance, 'type' | 'title'>): string {
  return module.title?.trim() || OVERVIEW_MODULES[module.type].label;
}

export function timeRangeStart(range: OverviewTimeRange, now = Date.now()): number {
  const hours =
    range === '24h' ? 24 : range === '7d' ? 24 * 7 : range === '30d' ? 24 * 30 : 24 * 90;
  return now - hours * 60 * 60 * 1000;
}

export function timeRangeLabel(range: OverviewTimeRange): string {
  return OVERVIEW_TIME_RANGES.find((entry) => entry.value === range)?.label ?? 'Last 7 days';
}

/** Tickets are offered once a connection exists (and, per workspace, was chosen in setup). */
export function sourceAvailable(
  requirement: OverviewSourceRequirement | undefined,
  scope: OverviewScope,
  sources: OverviewSources,
): boolean {
  if (!requirement) return true;
  if (requirement === 'docs') return sources.docs.configured;
  if (sources.workItemConnections.length === 0) return false;
  if (scope.kind === 'global') return true;
  return Boolean(sources.workspaceConnectionIds[scope.workspaceId]);
}

export function visibleColumns(module: OverviewModuleInstance): Set<string> {
  const definition = OVERVIEW_MODULES[module.type];
  const chosen = module.config.columns;
  return new Set(
    definition.columns
      .filter((column) => column.required || !chosen || chosen.includes(column.id))
      .map((column) => column.id),
  );
}

let fallbackCounter = 0;
export function createOverviewModuleId(type: OverviewModuleType): string {
  const random =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : `${Date.now().toString(36)}${(fallbackCounter += 1)}`;
  return `${type}-${random}`;
}

export function createOverviewModule(
  type: OverviewModuleType,
  overrides: Partial<Omit<OverviewModuleInstance, 'type'>> = {},
): OverviewModuleInstance {
  const definition = OVERVIEW_MODULES[type];
  return {
    id: overrides.id ?? createOverviewModuleId(type),
    type,
    title: overrides.title,
    width: overrides.width ?? definition.defaultWidth,
    rows: overrides.rows ?? definition.defaultRows,
    config: { ...structuredCloneConfig(definition.defaultConfig), ...(overrides.config ?? {}) },
  };
}

function structuredCloneConfig(config: OverviewModuleConfig): OverviewModuleConfig {
  return JSON.parse(JSON.stringify(config)) as OverviewModuleConfig;
}

/** Built-in layouts: the first-scope modules, Tickets only when a connection is set up. */
export function buildDefaultOverviewLayout(
  scope: OverviewScope,
  sources: OverviewSources,
): OverviewLayout {
  const tickets = sourceAvailable('tickets', scope, sources);
  const defaultConnectionId =
    scope.kind === 'workspace'
      ? sources.workspaceConnectionIds[scope.workspaceId]
      : (Object.values(sources.workspaceConnectionIds).find(Boolean) ??
        sources.workItemConnections[0]?.id);
  const ticketModule = tickets
    ? [
        createOverviewModule('tickets', {
          id: 'tickets-default',
          config: scope.kind === 'global' ? { connectionId: defaultConnectionId } : {},
        }),
      ]
    : [];

  const modules =
    scope.kind === 'global'
      ? [
          createOverviewModule('activity', { id: 'activity-default' }),
          createOverviewModule('findings', { id: 'findings-default' }),
          createOverviewModule('workspaces', { id: 'workspaces-default', rows: 5 }),
          ...ticketModule,
          createOverviewModule('sessions', { id: 'sessions-default' }),
          createOverviewModule('ideas', {
            id: 'ideas-default',
            config: { columns: ['workspace'] },
          }),
        ]
      : [
          createOverviewModule('repositories', { id: 'repositories-default', rows: 5 }),
          createOverviewModule('findings', { id: 'findings-default' }),
          createOverviewModule('pull-requests', {
            id: 'pull-requests-default',
            rows: 5,
            config: { columns: ['number', 'repository', 'status', 'updated'] },
          }),
          ...ticketModule,
          createOverviewModule('sessions', {
            id: 'sessions-default',
            config: { columns: ['status', 'when'] },
          }),
          createOverviewModule('ideas', { id: 'ideas-default' }),
        ];

  return {
    version: 1,
    modules: modules.filter((module) => moduleAllowedInScope(module.type, scope)),
  };
}

// ---------------------------------------------------------------------------
// Layout operations (pure)
// ---------------------------------------------------------------------------

export function addOverviewModule(
  layout: OverviewLayout,
  module: OverviewModuleInstance,
  index = layout.modules.length,
): OverviewLayout {
  if (layout.modules.length >= OVERVIEW_MAX_MODULES) return layout;
  const modules = [...layout.modules];
  modules.splice(clamp(index, 0, modules.length), 0, module);
  return { ...layout, modules };
}

export function removeOverviewModule(layout: OverviewLayout, moduleId: string): OverviewLayout {
  return { ...layout, modules: layout.modules.filter((module) => module.id !== moduleId) };
}

/** Move a module to `toIndex` (position in the resulting list). */
export function moveOverviewModule(
  layout: OverviewLayout,
  moduleId: string,
  toIndex: number,
): OverviewLayout {
  const from = layout.modules.findIndex((module) => module.id === moduleId);
  if (from < 0) return layout;
  const modules = [...layout.modules];
  const [module] = modules.splice(from, 1);
  const target = clamp(toIndex, 0, modules.length);
  if (target === from) return layout;
  modules.splice(target, 0, module);
  return { ...layout, modules };
}

export function updateOverviewModule(
  layout: OverviewLayout,
  moduleId: string,
  patch: Partial<Omit<OverviewModuleInstance, 'id' | 'type'>>,
): OverviewLayout {
  return {
    ...layout,
    modules: layout.modules.map((module) =>
      module.id === moduleId
        ? {
            ...module,
            ...patch,
            rows: clampRows(patch.rows ?? module.rows),
            config: patch.config ? { ...patch.config } : module.config,
          }
        : module,
    ),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampRows(value: number): number {
  return clamp(
    Number.isFinite(value) ? value : OVERVIEW_MIN_ROWS,
    OVERVIEW_MIN_ROWS,
    OVERVIEW_MAX_ROWS,
  );
}

const WIDTHS = new Set<OverviewModuleWidth>(OVERVIEW_WIDTHS.map((entry) => entry.value));
const ACTIVITY_EVENTS = new Set<OverviewActivityEventType>([
  'pull-request',
  'session',
  'automation',
  'finding',
  'note',
]);
const PR_STATES = new Set<OverviewPullRequestState>(['open', 'merged', 'closed']);
const FINDING_SOURCES = new Set<OverviewFindingSource>(['security', 'code-review']);
const IDEA_TYPES = new Set<OverviewIdeaContentType>(['notes', 'decisions']);
const SESSION_STATES = new Set<ChatThreadAttentionState>([
  'idle',
  'working',
  'approval',
  'input',
  'failed',
  'complete',
]);
const RUN_OUTCOMES = new Set<AutomationRunStatus>([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

function stringList(value: unknown, max = 100): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .slice(0, max);
}

function enumList<T extends string>(value: unknown, allowed: Set<T>): T[] | undefined {
  const list = stringList(value);
  return list
    ? [...new Set(list.filter((entry): entry is T => allowed.has(entry as T)))]
    : undefined;
}

function shortText(value: unknown, max = 120): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, max);
  return trimmed || undefined;
}

export function isSafeOverviewLinkTarget(target: string): boolean {
  if (target.startsWith('/') && !target.startsWith('//')) return true;
  try {
    const url = new URL(target);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function sanitizeConfig(type: OverviewModuleType, raw: unknown): OverviewModuleConfig {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const allowed = new Set<string>(OVERVIEW_MODULES[type].configKeys);
  const columnIds = new Set(OVERVIEW_MODULES[type].columns.map((column) => column.id));
  const config: OverviewModuleConfig = {};
  const set = <K extends keyof OverviewModuleConfig>(key: K, value: OverviewModuleConfig[K]) => {
    if (allowed.has(key) && value !== undefined) config[key] = value;
  };

  set('workspaceIds', stringList(input.workspaceIds));
  set('repoIds', stringList(input.repoIds));
  set('automationIds', stringList(input.automationIds));
  set('eventTypes', enumList(input.eventTypes, ACTIVITY_EVENTS));
  set('prStates', enumList(input.prStates, PR_STATES));
  set('findingSources', enumList(input.findingSources, FINDING_SOURCES));
  set('contentTypes', enumList(input.contentTypes, IDEA_TYPES));
  set('sessionStates', enumList(input.sessionStates, SESSION_STATES));
  set('runOutcomes', enumList(input.runOutcomes, RUN_OUTCOMES));
  set(
    'columns',
    stringList(input.columns)?.filter((column) => columnIds.has(column)),
  );
  set(
    'findingStatus',
    input.findingStatus === 'all' || input.findingStatus === 'unlogged'
      ? input.findingStatus
      : undefined,
  );
  set(
    'severity',
    input.severity === 'high' || input.severity === 'medium' || input.severity === 'all'
      ? input.severity
      : undefined,
  );
  set(
    'docsChange',
    input.docsChange === 'all' ||
      input.docsChange === 'changed' ||
      input.docsChange === 'needs-review'
      ? input.docsChange
      : undefined,
  );
  set(
    'sort',
    input.sort === 'newest' || input.sort === 'oldest' || input.sort === 'name'
      ? input.sort
      : undefined,
  );
  set('connectionId', shortText(input.connectionId, 200));
  set('ticketState', shortText(input.ticketState, 80));
  set('ticketAssignee', shortText(input.ticketAssignee, 120));

  if (allowed.has('links') && Array.isArray(input.links)) {
    config.links = input.links
      .map((entry, index) => {
        const link = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
        const label = shortText(link.label, 80);
        const target = shortText(link.target, 2000);
        if (!label || !target || !isSafeOverviewLinkTarget(target)) return null;
        return { id: shortText(link.id, 80) ?? `link-${index}`, label, target };
      })
      .filter((link): link is OverviewPinnedLink => link !== null)
      .slice(0, OVERVIEW_MAX_LINKS);
  }

  return config;
}

/**
 * Validate a layout crossing the IPC/storage boundary: drops unknown module
 * types, modules not allowed in the scope, duplicate ids, and unknown config.
 */
export function normalizeOverviewLayout(raw: unknown, scope: OverviewScope): OverviewLayout {
  const input = (raw && typeof raw === 'object' ? raw : {}) as { modules?: unknown };
  const seen = new Set<string>();
  const modules: OverviewModuleInstance[] = [];
  for (const entry of Array.isArray(input.modules) ? input.modules : []) {
    if (modules.length >= OVERVIEW_MAX_MODULES) break;
    const candidate = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const type = candidate.type as OverviewModuleType;
    if (!OVERVIEW_MODULES[type] || !moduleAllowedInScope(type, scope)) continue;
    const id = shortText(candidate.id, 80) ?? createOverviewModuleId(type);
    if (seen.has(id)) continue;
    seen.add(id);
    const definition = OVERVIEW_MODULES[type];
    modules.push({
      id,
      type,
      title: shortText(candidate.title, 60),
      width: WIDTHS.has(candidate.width as OverviewModuleWidth)
        ? (candidate.width as OverviewModuleWidth)
        : definition.defaultWidth,
      rows: clampRows(typeof candidate.rows === 'number' ? candidate.rows : definition.defaultRows),
      config: sanitizeConfig(type, candidate.config),
    });
  }
  return { version: 1, modules };
}

export function overviewLayoutsEqual(a: OverviewLayout, b: OverviewLayout): boolean {
  return JSON.stringify(a.modules) === JSON.stringify(b.modules);
}
