import type { Feature, UserRole } from '../../shared/types';
import { ROLE_FEATURES } from '../../shared/types';

export interface SidebarNavItemDefinition {
  path: string;
  label: string;
  /** One-line description shown as a secondary line/tooltip (NV2). */
  description?: string;
  /** Search terms shared with the command palette. */
  keywords?: string[];
  feature?: Feature;
  /** Available when the role has ANY of these features (merged destinations such as Notes). */
  anyFeatures?: Feature[];
  requiresRepoFeature?: boolean;
  requiresChat?: boolean;
  /** `global` items sit above the workspace switcher; everything else belongs to the active workspace. */
  scope?: 'global';
}

export interface SidebarToolGroupDefinition {
  id: 'build' | 'delivery' | 'inspect' | 'knowledge' | 'governance';
  label: string;
  items: SidebarNavItemDefinition[];
}

/** Maximum number of tools a user can pin to the primary nav (NV2). */
export const MAX_PINNED_NAV_TOOLS = 5;

/** localStorage key for the pinned-tool preference (NV2). */
export const PINNED_NAV_TOOLS_STORAGE_KEY = 'layout:pinned-nav-tools:v1';

/** Window event fired when pins change outside the sidebar (e.g. from the command palette). */
export const PINNED_NAV_TOOLS_CHANGED_EVENT = 'anvil:pinned-nav-tools-changed';

/** The workspace's repository management tab (WS2; the default tab is Overview). */
export const WORKSPACE_REPOSITORIES_PATH = '/workspace?view=repositories';

/** Merged Notes destination (Workspace notes | Meeting notes). */
export const NOTES_PATH = '/notes';

/** Sidebar alias for the Workspace Library tab; redirects to `/workspace?view=library`. */
export const LIBRARY_PATH = '/library';

export const WORKSPACE_LIBRARY_PATH = '/workspace?view=library';

export const PRIMARY_NAV_ITEMS: SidebarNavItemDefinition[] = [
  {
    path: '/overview',
    label: 'Home',
    description: 'Changes, findings, tickets and ideas across all your workspaces.',
    keywords: ['dashboard', 'overview', 'summary', 'all workspaces'],
    scope: 'global',
  },
  {
    path: '/inbox',
    label: 'Activity',
    description: 'Work that needs you and work in progress across workspaces.',
    keywords: ['inbox', 'attention', 'approval', 'failed', 'completed'],
    feature: 'chat',
    scope: 'global',
  },
  {
    path: '/workspace',
    label: 'Overview',
    description:
      "The active workspace's home: its overview, repositories, health, setup and library.",
    keywords: [
      'workspace',
      'workspace home',
      'dashboard',
      'repositories',
      'repos',
      'health',
      'setup',
      'security',
      'dependencies',
      'ci/cd',
    ],
    feature: 'repos',
  },
  {
    path: '/chat',
    label: 'Chat',
    description: 'Agent sessions for the active workspace.',
    feature: 'chat',
    requiresChat: true,
  },
];

export const AUTOMATE_NAV_ITEMS: SidebarNavItemDefinition[] = [
  {
    path: '/automations',
    label: 'Automations',
    description: 'Watchtower — agents that run on events and schedules.',
    keywords: ['watchtower', 'schedule', 'daemon', 'agents'],
    feature: 'automations',
  },
  {
    path: '/workflows',
    label: 'Workflows',
    description: 'Reusable multi-step agent pipelines.',
    keywords: ['automation', 'agents', 'graph'],
    feature: 'workflows',
    requiresChat: true,
  },
  {
    path: '/dojo',
    label: 'Dojo',
    description: 'Agent practice runs and drills.',
    keywords: ['agent', 'practice', 'drills'],
    feature: 'dojo',
    requiresChat: true,
  },
];

export const SIDEBAR_FOOTER_NAV_ITEMS: SidebarNavItemDefinition[] = [
  {
    path: '/settings',
    label: 'Settings',
    description: 'Configure Anvil and its integrations.',
    keywords: ['preferences', 'configuration'],
  },
  {
    path: '/diagnostics',
    label: 'Diagnostics',
    description: 'Inspect app health, logs, and connected services.',
    keywords: ['health', 'logs', 'troubleshooting'],
  },
];

/**
 * Spec §12: 29 destinations become 18. Results about the current task
 * (reports, findings, documents) moved to repo detail Health/Setup, the
 * Library, or chat surfaces; queues, live tools and editors stay.
 */
export const TOOL_NAV_GROUPS: SidebarToolGroupDefinition[] = [
  {
    id: 'build',
    label: 'Build',
    items: [
      {
        path: '/editor',
        label: 'Editor',
        description: 'Embedded IDE for workspace files.',
        feature: 'editor',
        requiresRepoFeature: true,
      },
    ],
  },
  {
    id: 'delivery',
    label: 'Delivery',
    items: [
      {
        path: '/workitems',
        label: 'Work Items',
        description: 'Tickets and backlog from your work-item provider.',
        keywords: ['tickets', 'ado', 'backlog'],
        feature: 'workitems',
      },
      {
        path: '/review',
        label: 'Changes',
        description: 'Review uncommitted working-tree changes.',
        keywords: ['diff', 'working tree', 'uncommitted'],
        feature: 'codereview',
      },
      {
        path: '/codereview',
        label: 'PR Review',
        description: 'Review pull requests across workspace repos.',
        keywords: ['code review', 'pr', 'pull request'],
        feature: 'codereview',
        requiresRepoFeature: true,
      },
      {
        path: '/git',
        label: 'Git',
        description: 'Branches, diffs, and repository status.',
        keywords: ['branch', 'commit', 'diff', 'status'],
        feature: 'git',
        requiresRepoFeature: true,
      },
    ],
  },
  {
    id: 'inspect',
    label: 'Inspect',
    items: [
      {
        path: '/cloud',
        label: 'Cloud',
        description: 'Anvil Cloud environments and sandboxes.',
        keywords: ['environment', 'sandbox'],
        feature: 'cloud',
        requiresRepoFeature: true,
      },
    ],
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    items: [
      {
        path: NOTES_PATH,
        label: 'Notes',
        description: 'Workspace notes and meeting notes.',
        keywords: ['meeting notes', 'workspace notes', 'transcript', 'capture'],
        anyFeatures: ['workspace-notes', 'meeting-notes'],
      },
      {
        path: LIBRARY_PATH,
        label: 'Library',
        description: 'Artifacts, reviews, ADRs, diagrams, and compliance docs.',
        keywords: [
          'artifacts',
          'reports',
          'adrs',
          'architecture decisions',
          'diagrams',
          'compliance',
          'documentation',
          'docs',
          'shared links',
        ],
        feature: 'repos',
      },
    ],
  },
  {
    id: 'governance',
    label: 'Governance',
    items: [
      {
        path: '/governance',
        label: 'Lifecycle',
        description: 'Governance gates and lifecycle status.',
        feature: 'governance',
      },
    ],
  },
];

/**
 * Demoted tools (spec §12): not in the sidebar, but reachable from the
 * command palette and pinnable to the primary nav.
 */
export const DEMOTED_NAV_ITEMS: SidebarNavItemDefinition[] = [
  {
    path: '/browser',
    label: 'Browser',
    description: 'Preview running apps and simulators.',
    keywords: ['web', 'localhost', 'dev server', 'preview'],
    feature: 'browser',
    requiresRepoFeature: true,
  },
  {
    path: '/db-insights',
    label: 'DB Insights',
    description: 'Import and analyse database schemas.',
    keywords: ['database', 'db', 'schema', 'sql', 'import', 'ssms'],
    feature: 'dbinsights',
  },
  {
    path: '/argent',
    label: 'Argent',
    description: 'Mobile companion and simulator checks.',
    keywords: ['expo', 'mobile', 'simulator', 'emulator', 'mcp'],
    feature: 'argent',
  },
];

/** Every sidebar destination, primary first and footer last (demoted tools excluded). */
export function allSidebarNavItems(): SidebarNavItemDefinition[] {
  return [
    ...PRIMARY_NAV_ITEMS,
    ...AUTOMATE_NAV_ITEMS,
    ...TOOL_NAV_GROUPS.flatMap((group) => group.items),
    ...SIDEBAR_FOOTER_NAV_ITEMS,
  ];
}

export interface SidebarNavigationEntry {
  item: SidebarNavItemDefinition;
  section: string;
}

/** Section label the command palette uses for demoted tools. */
export const DEMOTED_NAV_SECTION = 'More tools';

/** Flatten the visible navigation in display order for other navigation surfaces. */
export function getSidebarNavigationEntries(
  userRole: UserRole,
  cloudFeaturesEnabled: boolean,
): SidebarNavigationEntry[] {
  const navigation = getAvailableSidebarNavigation(userRole, cloudFeaturesEnabled);
  return [
    ...navigation.primary.map((item) => ({
      item,
      section: item.scope === 'global' ? 'All workspaces' : 'Workspace',
    })),
    ...navigation.automate.map((item) => ({ item, section: 'Automate' })),
    ...navigation.tools.flatMap((group) =>
      group.items.map((item) => ({ item, section: group.label })),
    ),
    ...navigation.demoted.map((item) => ({ item, section: DEMOTED_NAV_SECTION })),
    ...SIDEBAR_FOOTER_NAV_ITEMS.map((item) => ({ item, section: 'Settings' })),
  ];
}

/** Role/Cloud availability for a single destination. */
export function isNavItemAvailable(
  item: SidebarNavItemDefinition,
  userRole: UserRole,
  cloudFeaturesEnabled: boolean,
): boolean {
  const features = ROLE_FEATURES[userRole];
  if (item.feature && !features.includes(item.feature)) return false;
  if (item.anyFeatures && !item.anyFeatures.some((feature) => features.includes(feature))) {
    return false;
  }
  return item.feature !== 'cloud' || cloudFeaturesEnabled;
}

export function getAvailableSidebarNavigation(
  userRole: UserRole,
  cloudFeaturesEnabled: boolean,
): {
  primary: SidebarNavItemDefinition[];
  automate: SidebarNavItemDefinition[];
  tools: SidebarToolGroupDefinition[];
  demoted: SidebarNavItemDefinition[];
} {
  const isAvailable = (item: SidebarNavItemDefinition) =>
    isNavItemAvailable(item, userRole, cloudFeaturesEnabled);

  return {
    primary: PRIMARY_NAV_ITEMS.filter(isAvailable),
    automate: AUTOMATE_NAV_ITEMS.filter(isAvailable),
    tools: TOOL_NAV_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter(isAvailable),
    })).filter((group) => group.items.length > 0),
    demoted: DEMOTED_NAV_ITEMS.filter(isAvailable),
  };
}

/** Pinnable destinations are tool/automate/demoted items; primary items are always shown. */
export function isPinnableNavItem(item: SidebarNavItemDefinition): boolean {
  return (
    !PRIMARY_NAV_ITEMS.some((primary) => primary.path === item.path) &&
    !SIDEBAR_FOOTER_NAV_ITEMS.some((footer) => footer.path === item.path)
  );
}

/**
 * Toggle a tool's pinned state. Pinned paths keep their existing order and the
 * list is capped at MAX_PINNED_NAV_TOOLS — toggles beyond the cap are ignored.
 */
export function togglePinnedNavTool(pinned: string[], path: string): string[] {
  if (pinned.includes(path)) return pinned.filter((entry) => entry !== path);
  if (pinned.length >= MAX_PINNED_NAV_TOOLS) return pinned;
  return [...pinned, path];
}

/**
 * Pins pointing at destinations removed in the §12 consolidation. A string
 * maps the pin to the tool's new home; `null` drops it (the tool now lives
 * inside repo detail, which has no single destination to pin).
 */
export const LEGACY_PINNED_NAV_REPLACEMENTS: Readonly<Record<string, string | null>> = {
  '/meeting-notes': NOTES_PATH,
  '/workspace-notes': NOTES_PATH,
  '/docs': LIBRARY_PATH,
  '/adrs': LIBRARY_PATH,
  '/diagrams': LIBRARY_PATH,
  '/compliance': LIBRARY_PATH,
  '/security': null,
  '/dependencies': null,
  '/cicd': null,
  '/onboard': null,
};

/** Map legacy pins to their new homes, dropping removed ones and duplicates. */
export function migratePinnedNavTools(pinned: string[]): string[] {
  const next: string[] = [];
  for (const path of pinned) {
    const mapped = Object.prototype.hasOwnProperty.call(LEGACY_PINNED_NAV_REPLACEMENTS, path)
      ? LEGACY_PINNED_NAV_REPLACEMENTS[path]
      : path;
    if (mapped && !next.includes(mapped)) next.push(mapped);
  }
  return next;
}

/**
 * Read pinned tool paths from localStorage; migrates legacy entries (writing
 * the migrated list back when the storage is writable) and drops unknown or
 * unavailable entries from the returned list.
 */
export function readPinnedNavTools(
  availablePaths: ReadonlySet<string>,
  storage:
    (Pick<Storage, 'getItem'> & Partial<Pick<Storage, 'setItem'>>) | undefined = safeLocalStorage(),
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PINNED_NAV_TOOLS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const stored = parsed.filter((entry): entry is string => typeof entry === 'string');
    const migrated = migratePinnedNavTools(stored);
    if (storage.setItem && migrated.join('\n') !== stored.join('\n')) {
      // Role-hidden pins stay in storage; only the legacy migration is persisted.
      storage.setItem(PINNED_NAV_TOOLS_STORAGE_KEY, JSON.stringify(migrated));
    }
    return migrated.filter((entry) => availablePaths.has(entry)).slice(0, MAX_PINNED_NAV_TOOLS);
  } catch {
    return [];
  }
}

export function writePinnedNavTools(
  pinned: string[],
  storage: Pick<Storage, 'setItem'> | undefined = safeLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PINNED_NAV_TOOLS_STORAGE_KEY, JSON.stringify(pinned));
  } catch {
    // Storage can be unavailable (e.g. tool windows); pinning is best-effort.
  }
}

function safeLocalStorage(): Storage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage;
}

/**
 * Why a nav item is gated, for tooltips/aria (NV3). Chat-gated and repo-gated
 * items get distinct reasons instead of one shared repo message.
 */
export function navItemGateReason(
  item: SidebarNavItemDefinition,
  availability: {
    chatEnabled: boolean;
    repoFeaturesEnabled: boolean;
    repoFeatureReason?: string;
  },
): string | undefined {
  if (item.requiresChat && !availability.chatEnabled) {
    return (
      availability.repoFeatureReason ??
      'Chat unlocks once a repository has been indexed in this workspace.'
    );
  }
  if (item.requiresRepoFeature && !availability.repoFeaturesEnabled) {
    return (
      availability.repoFeatureReason ??
      'This tool needs an indexed repository in the active workspace.'
    );
  }
  return undefined;
}

/**
 * Whether a destination is the current route. The Library lives on the
 * Workspace route (`?view=library`), so both need the query string.
 */
export function isSidebarNavItemActive(
  pathname: string,
  item: SidebarNavItemDefinition,
  search = '',
): boolean {
  const inLibrary =
    pathname === '/workspace' && new URLSearchParams(search).get('view') === 'library';
  if (item.path === LIBRARY_PATH) return inLibrary || pathname.startsWith(LIBRARY_PATH);
  if (item.path === '/workspace') return pathname.startsWith('/workspace') && !inLibrary;
  return pathname === item.path || pathname.startsWith(`${item.path}/`);
}

// ---------------------------------------------------------------------------
// Destinations for consolidated tools (spec §12)
// ---------------------------------------------------------------------------

export type RepoDetailSection = 'overview' | 'health' | 'setup';
export type RepoHealthTab = 'security' | 'dependencies' | 'cicd';
export type NotesTab = 'workspace' | 'meeting';
/** Library filter keys, as used in `/workspace?view=library&kind=…`. */
export type LibraryFilterKey =
  'all' | 'artifact' | 'surface' | 'adr' | 'diagram' | 'compliance' | 'doc' | 'shared';

export const REPO_HEALTH_TABS: readonly RepoHealthTab[] = ['security', 'dependencies', 'cicd'];
export const LIBRARY_FILTER_KEYS: readonly LibraryFilterKey[] = [
  'all',
  'artifact',
  'surface',
  'adr',
  'diagram',
  'compliance',
  'doc',
  'shared',
];

export function isRepoHealthTab(value: string | null | undefined): value is RepoHealthTab {
  return !!value && (REPO_HEALTH_TABS as readonly string[]).includes(value);
}

export function isLibraryFilterKey(value: string | null | undefined): value is LibraryFilterKey {
  return !!value && (LIBRARY_FILTER_KEYS as readonly string[]).includes(value);
}

/**
 * Repo detail URL. Overview keeps the established `?repo=` form; Health and
 * Setup use path params so embedded tools that read `:repoId` work as-is.
 */
export function repoDetailPath(
  repoId: string,
  section: RepoDetailSection = 'overview',
  tab: RepoHealthTab = 'security',
): string {
  const id = encodeURIComponent(repoId);
  if (section === 'health') return `/workspace/repos/${id}/health/${tab}`;
  if (section === 'setup') return `/workspace/repos/${id}/setup`;
  return `${WORKSPACE_REPOSITORIES_PATH}&repo=${id}`;
}

/** Repositories tab with a hint: picking a repo opens this section. */
export function repositoriesSectionHintPath(
  section: Exclude<RepoDetailSection, 'overview'>,
  tab?: RepoHealthTab,
): string {
  const params = new URLSearchParams({ view: 'repositories', section });
  if (section === 'health' && tab) params.set('tab', tab);
  return `/workspace?${params.toString()}`;
}

/**
 * Library tab URL. `tool` opens the kind's full management tool (ADR browser,
 * diagram editor, compliance generator, provider docs) instead of the list.
 */
export function libraryPath(
  options: { kind?: LibraryFilterKey; repoId?: string; tool?: boolean } = {},
): string {
  const params = new URLSearchParams({ view: 'library' });
  if (options.kind && options.kind !== 'all') params.set('kind', options.kind);
  if (options.repoId) params.set('repo', options.repoId);
  if (options.tool) params.set('tool', '1');
  return `/workspace?${params.toString()}`;
}

export function notesPath(tab: NotesTab = 'workspace'): string {
  return `${NOTES_PATH}?tab=${tab}`;
}

/** Deep link into a chat thread, optionally opening a surface or artifact on the stage. */
export function chatItemPath(
  threadId: string,
  target?: { surfaceId?: string; artifactId?: string },
): string {
  const params = new URLSearchParams({ thread: threadId });
  if (target?.surfaceId) params.set('surface', target.surfaceId);
  if (target?.artifactId) params.set('artifact', target.artifactId);
  return `/chat?${params.toString()}`;
}

/** Start a chat with a prefilled (not sent) prompt via the `?prompt=` route intent. */
export function chatPromptPath(prompt: string): string {
  return `/chat?prompt=${encodeURIComponent(prompt)}`;
}

/** Carry legacy query params (auditId, workspaceId, toolWindow…) onto the new target. */
function withLegacySearch(target: string, search: string): string {
  const legacy = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if ([...legacy.keys()].length === 0) return target;
  const [path, query = ''] = target.split('?');
  const params = new URLSearchParams(query);
  legacy.forEach((value, key) => {
    if (!params.has(key)) params.set(key, value);
  });
  const merged = params.toString();
  return merged ? `${path}?${merged}` : path;
}

/**
 * Map a route removed in the §12 consolidation to its new home. Returns
 * `null` for routes that are still destinations. `onboardRepoId` lets the
 * caller send `/onboard` straight to a known repo's Setup section.
 */
export function resolveLegacyRoute(
  pathname: string,
  search = '',
  options: { onboardRepoId?: string | null } = {},
): string | null {
  const segments = pathname.split('/').filter(Boolean).map(safeDecode);
  const [root, second, third] = segments;
  let target: string;

  switch (root) {
    case 'security':
      if (!second) target = repositoriesSectionHintPath('health', 'security');
      else
        target = repoDetailPath(
          second,
          'health',
          third === 'dependencies' ? 'dependencies' : 'security',
        );
      break;
    case 'dependencies':
      target = second
        ? repoDetailPath(second, 'health', 'dependencies')
        : repositoriesSectionHintPath('health', 'dependencies');
      break;
    case 'cicd':
      target = second
        ? repoDetailPath(second, 'health', 'cicd')
        : repositoriesSectionHintPath('health', 'cicd');
      break;
    case 'onboard':
      target = options.onboardRepoId
        ? repoDetailPath(options.onboardRepoId, 'setup')
        : repositoriesSectionHintPath('setup');
      break;
    case 'adrs':
      target = libraryPath({ kind: 'adr' });
      break;
    case 'diagrams':
      target = libraryPath({ kind: 'diagram', repoId: second });
      break;
    case 'docs':
      target = libraryPath({ kind: 'doc' });
      break;
    case 'compliance':
      target = libraryPath({ kind: 'compliance' });
      break;
    case 'library':
      target = libraryPath();
      break;
    case 'meeting-notes':
      target = notesPath('meeting');
      break;
    case 'workspace-notes':
      target = notesPath('workspace');
      break;
    default:
      return null;
  }

  return withLegacySearch(target, search);
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
