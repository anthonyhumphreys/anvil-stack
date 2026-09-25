import type { Feature, UserRole } from '../../shared/types';
import { ROLE_FEATURES } from '../../shared/types';

export interface SidebarNavItemDefinition {
  path: string;
  label: string;
  /** One-line description shown as a secondary line/tooltip (NV2). */
  description?: string;
  feature: Feature;
  requiresRepoFeature?: boolean;
  requiresChat?: boolean;
}

export interface SidebarToolGroupDefinition {
  id: 'delivery' | 'build' | 'knowledge' | 'governance';
  label: string;
  items: SidebarNavItemDefinition[];
}

/** Maximum number of tools a user can pin to the primary nav (NV2). */
export const MAX_PINNED_NAV_TOOLS = 5;

/** localStorage key for the pinned-tool preference (NV2). */
export const PINNED_NAV_TOOLS_STORAGE_KEY = 'layout:pinned-nav-tools:v1';

export const PRIMARY_NAV_ITEMS: SidebarNavItemDefinition[] = [
  {
    path: '/inbox',
    label: 'Activity',
    description: 'Work that needs you and work in progress across workspaces.',
    feature: 'chat',
  },
  {
    path: '/chat',
    label: 'Chat',
    description: 'Agent sessions for the active workspace.',
    feature: 'chat',
    requiresChat: true,
  },
  {
    path: '/workspace',
    label: 'Workspace',
    description: 'Repositories, readiness, and setup for the active workspace.',
    feature: 'repos',
  },
];

export const AUTOMATE_NAV_ITEMS: SidebarNavItemDefinition[] = [
  {
    path: '/automations',
    label: 'Automations',
    description: 'Watchtower — agents that run on events and schedules.',
    feature: 'automations',
  },
  {
    path: '/workflows',
    label: 'Workflows',
    description: 'Reusable multi-step agent pipelines.',
    feature: 'workflows',
    requiresChat: true,
  },
  {
    path: '/dojo',
    label: 'Dojo',
    description: 'Agent practice runs and drills.',
    feature: 'dojo',
    requiresChat: true,
  },
];

export const TOOL_NAV_GROUPS: SidebarToolGroupDefinition[] = [
  {
    id: 'delivery',
    label: 'Delivery',
    items: [
      {
        path: '/review',
        label: 'Changes',
        description: 'Review uncommitted working-tree changes.',
        feature: 'codereview',
      },
      {
        path: '/workitems',
        label: 'Work Items',
        description: 'Tickets and backlog from your work-item provider.',
        feature: 'workitems',
      },
      {
        path: '/codereview',
        label: 'PR Review',
        description: 'Review pull requests across workspace repos.',
        feature: 'codereview',
        requiresRepoFeature: true,
      },
      {
        path: '/cicd',
        label: 'CI/CD',
        description: 'Pipeline status for workspace repos.',
        feature: 'cicd',
        requiresRepoFeature: true,
      },
      {
        path: '/git',
        label: 'Git',
        description: 'Branches, diffs, and repository status.',
        feature: 'git',
        requiresRepoFeature: true,
      },
    ],
  },
  {
    id: 'build',
    label: 'Build & inspect',
    items: [
      {
        path: '/editor',
        label: 'Editor',
        description: 'Embedded IDE for workspace files.',
        feature: 'editor',
        requiresRepoFeature: true,
      },
      {
        path: '/browser',
        label: 'Browser',
        description: 'Preview running apps and simulators.',
        feature: 'browser',
        requiresRepoFeature: true,
      },
      {
        path: '/cloud',
        label: 'Cloud',
        description: 'Anvil Cloud environments and sandboxes.',
        feature: 'cloud',
        requiresRepoFeature: true,
      },
      {
        path: '/db-insights',
        label: 'DB Insights',
        description: 'Import and analyse database schemas.',
        feature: 'dbinsights',
      },
      {
        path: '/dependencies',
        label: 'Dependencies',
        description: 'Package and dependency overview per repo.',
        feature: 'dependencies',
        requiresRepoFeature: true,
      },
      {
        path: '/security',
        label: 'Security',
        description: 'Security audits and findings per repo.',
        feature: 'security',
        requiresRepoFeature: true,
      },
      {
        path: '/onboard',
        label: 'Repo setup',
        description: 'AGENTS.md, devcontainer, and environment readiness checks.',
        feature: 'onboard',
        requiresRepoFeature: true,
      },
      {
        path: '/argent',
        label: 'Argent',
        description: 'Mobile companion and simulator checks.',
        feature: 'argent',
      },
    ],
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    items: [
      {
        path: '/meeting-notes',
        label: 'Meeting Notes',
        description: 'Notes captured from meetings.',
        feature: 'meeting-notes',
      },
      {
        path: '/workspace-notes',
        label: 'Workspace Notes',
        description: 'Shared notes for this workspace.',
        feature: 'workspace-notes',
      },
      {
        path: '/docs',
        label: 'Documentation',
        description: 'Docs from your documentation provider.',
        feature: 'docs',
      },
      {
        path: '/adrs',
        label: 'ADRs',
        description: 'Architecture decision records.',
        feature: 'adrs',
        requiresRepoFeature: true,
      },
      {
        path: '/diagrams',
        label: 'Diagrams',
        description: 'Architecture diagrams for workspace repos.',
        feature: 'diagrams',
        requiresRepoFeature: true,
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
      {
        path: '/compliance',
        label: 'Data & Compliance',
        description: 'Privacy and compliance checks.',
        feature: 'compliance',
        requiresRepoFeature: true,
      },
    ],
  },
];

/** Every navigable item, primary first — used by pinning and the palette. */
export function allSidebarNavItems(): SidebarNavItemDefinition[] {
  return [
    ...PRIMARY_NAV_ITEMS,
    ...AUTOMATE_NAV_ITEMS,
    ...TOOL_NAV_GROUPS.flatMap((group) => group.items),
  ];
}

export function getAvailableSidebarNavigation(
  userRole: UserRole,
  cloudFeaturesEnabled: boolean,
): {
  primary: SidebarNavItemDefinition[];
  automate: SidebarNavItemDefinition[];
  tools: SidebarToolGroupDefinition[];
} {
  const isAvailable = (item: SidebarNavItemDefinition) =>
    ROLE_FEATURES[userRole].includes(item.feature) &&
    (item.feature !== 'cloud' || cloudFeaturesEnabled);

  return {
    primary: PRIMARY_NAV_ITEMS.filter(isAvailable),
    automate: AUTOMATE_NAV_ITEMS.filter(isAvailable),
    tools: TOOL_NAV_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter(isAvailable),
    })).filter((group) => group.items.length > 0),
  };
}

/** Pinnable destinations are tool/automate items; primary items are always shown. */
export function isPinnableNavItem(item: SidebarNavItemDefinition): boolean {
  return !PRIMARY_NAV_ITEMS.some((primary) => primary.path === item.path);
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

/** Read pinned tool paths from localStorage; drops unknown/stale entries. */
export function readPinnedNavTools(
  availablePaths: ReadonlySet<string>,
  storage: Pick<Storage, 'getItem'> | undefined = safeLocalStorage(),
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PINNED_NAV_TOOLS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .filter((entry) => availablePaths.has(entry))
      .slice(0, MAX_PINNED_NAV_TOOLS);
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

export function isSidebarNavItemActive(pathname: string, item: SidebarNavItemDefinition): boolean {
  if (item.path === '/dependencies') {
    return pathname.startsWith('/dependencies') || /\/security\/[^/]+\/dependencies/.test(pathname);
  }
  if (item.path === '/security') {
    return pathname.startsWith('/security') && !pathname.endsWith('/dependencies');
  }
  return pathname.startsWith(item.path);
}
