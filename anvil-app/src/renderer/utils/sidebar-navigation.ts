import type { Feature, UserRole } from '../../shared/types';
import { ROLE_FEATURES } from '../../shared/types';

export interface SidebarNavItemDefinition {
  path: string;
  label: string;
  feature: Feature;
  requiresRepoFeature?: boolean;
  requiresChat?: boolean;
}

export interface SidebarToolGroupDefinition {
  id: 'delivery' | 'build' | 'knowledge' | 'governance';
  label: string;
  items: SidebarNavItemDefinition[];
}

export const PRIMARY_NAV_ITEMS: SidebarNavItemDefinition[] = [
  { path: '/inbox', label: 'Inbox', feature: 'chat' },
  { path: '/chat', label: 'Chat', feature: 'chat', requiresChat: true },
  { path: '/repos', label: 'Workspace', feature: 'repos' },
];

export const AUTOMATE_NAV_ITEMS: SidebarNavItemDefinition[] = [
  { path: '/automations', label: 'Watchtower & schedules', feature: 'automations' },
  { path: '/workflows', label: 'Workflows', feature: 'workflows', requiresChat: true },
  { path: '/dojo', label: 'Dojo', feature: 'dojo', requiresChat: true },
];

export const TOOL_NAV_GROUPS: SidebarToolGroupDefinition[] = [
  {
    id: 'delivery',
    label: 'Delivery',
    items: [
      { path: '/workitems', label: 'Work Items', feature: 'workitems' },
      {
        path: '/codereview',
        label: 'Code Review',
        feature: 'codereview',
        requiresRepoFeature: true,
      },
      { path: '/cicd', label: 'CI/CD', feature: 'cicd', requiresRepoFeature: true },
      { path: '/git', label: 'Git', feature: 'git', requiresRepoFeature: true },
    ],
  },
  {
    id: 'build',
    label: 'Build & inspect',
    items: [
      { path: '/editor', label: 'Editor', feature: 'editor', requiresRepoFeature: true },
      { path: '/browser', label: 'Browser', feature: 'browser', requiresRepoFeature: true },
      { path: '/cloud', label: 'Cloud', feature: 'cloud', requiresRepoFeature: true },
      { path: '/db-insights', label: 'DB Insights', feature: 'dbinsights' },
      {
        path: '/dependencies',
        label: 'Dependencies',
        feature: 'dependencies',
        requiresRepoFeature: true,
      },
      { path: '/security', label: 'Security', feature: 'security', requiresRepoFeature: true },
      { path: '/onboard', label: 'Onboarding', feature: 'onboard', requiresRepoFeature: true },
      { path: '/argent', label: 'Argent', feature: 'argent' },
    ],
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    items: [
      { path: '/meeting-notes', label: 'Meeting Notes', feature: 'meeting-notes' },
      { path: '/workspace-notes', label: 'Workspace Notes', feature: 'workspace-notes' },
      { path: '/docs', label: 'Documentation', feature: 'docs' },
      { path: '/adrs', label: 'ADRs', feature: 'adrs', requiresRepoFeature: true },
      { path: '/diagrams', label: 'Diagrams', feature: 'diagrams', requiresRepoFeature: true },
    ],
  },
  {
    id: 'governance',
    label: 'Governance',
    items: [
      { path: '/governance', label: 'Lifecycle', feature: 'governance' },
      {
        path: '/compliance',
        label: 'Data & Compliance',
        feature: 'compliance',
        requiresRepoFeature: true,
      },
    ],
  },
];

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

export function isSidebarNavItemActive(pathname: string, item: SidebarNavItemDefinition): boolean {
  if (item.path === '/dependencies') {
    return pathname.startsWith('/dependencies') || /\/security\/[^/]+\/dependencies/.test(pathname);
  }
  if (item.path === '/security') {
    return pathname.startsWith('/security') && !pathname.endsWith('/dependencies');
  }
  return pathname.startsWith(item.path);
}
