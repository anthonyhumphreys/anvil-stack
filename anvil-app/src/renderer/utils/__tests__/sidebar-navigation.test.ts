import { describe, expect, it } from 'vitest';
import {
  AUTOMATE_NAV_ITEMS,
  DEMOTED_NAV_ITEMS,
  DEMOTED_NAV_SECTION,
  getAvailableSidebarNavigation,
  getSidebarNavigationEntries,
  isPinnableNavItem,
  isSidebarNavItemActive,
  libraryPath,
  MAX_PINNED_NAV_TOOLS,
  migratePinnedNavTools,
  navItemGateReason,
  notesPath,
  PINNED_NAV_TOOLS_STORAGE_KEY,
  PRIMARY_NAV_ITEMS,
  readPinnedNavTools,
  repoDetailPath,
  repositoriesSectionHintPath,
  resolveLegacyRoute,
  chatItemPath,
  chatPromptPath,
  SIDEBAR_FOOTER_NAV_ITEMS,
  TOOL_NAV_GROUPS,
  togglePinnedNavTool,
  type SidebarNavItemDefinition,
} from '../sidebar-navigation';

const toolItems = () => TOOL_NAV_GROUPS.flatMap((group) => group.items);
const findTool = (path: string) => toolItems().find((item) => item.path === path)!;

describe('sidebar navigation (spec §12)', () => {
  it('separates the all-workspaces Home from the active workspace', () => {
    expect(PRIMARY_NAV_ITEMS.map((item) => item.label)).toEqual([
      'Home',
      'Activity',
      'Overview',
      'Chat',
    ]);
    expect(
      PRIMARY_NAV_ITEMS.filter((item) => item.scope === 'global').map((item) => item.path),
    ).toEqual(['/overview', '/inbox']);
  });

  it('lists exactly the 18 consolidated destinations, each once', () => {
    const sidebar = [
      ...PRIMARY_NAV_ITEMS,
      ...AUTOMATE_NAV_ITEMS,
      ...toolItems(),
      ...SIDEBAR_FOOTER_NAV_ITEMS,
    ].map((item) => item.label);

    expect(new Set(sidebar).size).toBe(sidebar.length);
    expect(sidebar).toEqual([
      'Home',
      'Activity',
      'Overview',
      'Chat',
      'Automations',
      'Workflows',
      'Dojo',
      'Editor',
      'Work Items',
      'Changes',
      'PR Review',
      'Git',
      'Cloud',
      'Notes',
      'Library',
      'Lifecycle',
      'Settings',
      'Diagnostics',
    ]);
  });

  it('removes consolidated tools from the sidebar', () => {
    const paths = toolItems().map((item) => item.path);
    for (const removed of [
      '/browser',
      '/onboard',
      '/argent',
      '/cicd',
      '/db-insights',
      '/dependencies',
      '/security',
      '/meeting-notes',
      '/workspace-notes',
      '/docs',
      '/adrs',
      '/diagrams',
      '/compliance',
    ]) {
      expect(paths).not.toContain(removed);
    }
  });

  it('groups tools by workflow', () => {
    expect(TOOL_NAV_GROUPS.map((group) => [group.label, group.items.map((i) => i.label)])).toEqual([
      ['Build', ['Editor']],
      ['Delivery', ['Work Items', 'Changes', 'PR Review', 'Git']],
      ['Inspect', ['Cloud']],
      ['Knowledge', ['Notes', 'Library']],
      ['Governance', ['Lifecycle']],
    ]);
  });

  it('demotes Browser, DB Insights and Argent to the palette', () => {
    expect(DEMOTED_NAV_ITEMS.map((item) => item.path)).toEqual([
      '/browser',
      '/db-insights',
      '/argent',
    ]);
    expect(DEMOTED_NAV_ITEMS.every((item) => isPinnableNavItem(item))).toBe(true);
  });

  it('preserves role and Cloud feature gates', () => {
    const developer = getAvailableSidebarNavigation('developer', false);
    const design = getAvailableSidebarNavigation('design', true);

    expect(developer.automate.map((item) => item.path)).toEqual([
      '/automations',
      '/workflows',
      '/dojo',
    ]);
    expect(developer.tools.flatMap((g) => g.items).some((i) => i.path === '/cloud')).toBe(false);
    expect(design.automate.map((item) => item.path)).toEqual(['/workflows', '/dojo']);
    expect(design.tools.flatMap((g) => g.items).some((i) => i.path === '/cloud')).toBe(true);
    // design has no editor, codereview, git or browser.
    expect(design.tools.map((g) => g.label)).not.toContain('Build');
    expect(design.demoted.map((item) => item.path)).toEqual(['/db-insights']);
    expect(developer.demoted.map((item) => item.path)).toEqual([
      '/browser',
      '/db-insights',
      '/argent',
    ]);
  });

  it('shows merged Notes when the role has either notes feature', () => {
    const notes = findTool('/notes');
    expect(notes.anyFeatures).toEqual(['workspace-notes', 'meeting-notes']);
    for (const role of ['developer', 'ba-brm', 'design', 'itsm'] as const) {
      const entries = getSidebarNavigationEntries(role, false).map(({ item }) => item.path);
      expect(entries).toContain('/notes');
      expect(entries).toContain('/library');
    }
  });

  it('gives the palette the same entries plus demoted tools', () => {
    const navigation = getAvailableSidebarNavigation('developer', false);
    const entries = getSidebarNavigationEntries('developer', false);
    expect(entries.map(({ item }) => item.path)).toEqual([
      ...navigation.primary.map((item) => item.path),
      ...navigation.automate.map((item) => item.path),
      ...navigation.tools.flatMap((group) => group.items.map((item) => item.path)),
      ...navigation.demoted.map((item) => item.path),
      ...SIDEBAR_FOOTER_NAV_ITEMS.map((item) => item.path),
    ]);
    expect(
      entries
        .filter(({ section }) => section === DEMOTED_NAV_SECTION)
        .map(({ item }) => item.label),
    ).toEqual(['Browser', 'DB Insights', 'Argent']);
    expect(entries.some(({ item }) => item.path === '/cloud')).toBe(false);
  });

  it('labels the two review surfaces distinctly (NV1)', () => {
    expect(findTool('/review').label).toBe('Changes');
    expect(findTool('/codereview').label).toBe('PR Review');
  });

  it('gives every tool a one-line description (NV2)', () => {
    expect([...toolItems(), ...DEMOTED_NAV_ITEMS].every((item) => !!item.description)).toBe(true);
  });
});

describe('isSidebarNavItemActive', () => {
  const workspace = PRIMARY_NAV_ITEMS.find((item) => item.path === '/workspace')!;
  const library = findTool('/library');

  it('treats the Library tab as Library, not Workspace', () => {
    expect(isSidebarNavItemActive('/workspace', library, '?view=library&kind=adr')).toBe(true);
    expect(isSidebarNavItemActive('/workspace', workspace, '?view=library')).toBe(false);
    expect(isSidebarNavItemActive('/workspace', workspace, '?view=repositories')).toBe(true);
    expect(isSidebarNavItemActive('/workspace/repos/r1/health/security', workspace)).toBe(true);
    expect(isSidebarNavItemActive('/workspace', library, '')).toBe(false);
  });

  it('matches nested routes without prefix collisions', () => {
    const item: SidebarNavItemDefinition = { path: '/review', label: 'Changes' };
    expect(isSidebarNavItemActive('/review', item)).toBe(true);
    expect(isSidebarNavItemActive('/review/x', item)).toBe(true);
    expect(isSidebarNavItemActive('/reviewers', item)).toBe(false);
    expect(isSidebarNavItemActive('/notes', findTool('/notes'), '?tab=meeting')).toBe(true);
  });
});

describe('pinned nav tools (NV2)', () => {
  const available = new Set(
    [...toolItems(), ...AUTOMATE_NAV_ITEMS, ...DEMOTED_NAV_ITEMS].map((item) => item.path),
  );

  it('only automate/tool/demoted items are pinnable', () => {
    expect(isPinnableNavItem(PRIMARY_NAV_ITEMS[0])).toBe(false);
    expect(isPinnableNavItem(SIDEBAR_FOOTER_NAV_ITEMS[0])).toBe(false);
    expect(isPinnableNavItem(AUTOMATE_NAV_ITEMS[0])).toBe(true);
  });

  it('toggles pinning on and off', () => {
    const pinned = togglePinnedNavTool([], '/git');
    expect(pinned).toEqual(['/git']);
    expect(togglePinnedNavTool(pinned, '/git')).toEqual([]);
  });

  it('caps the pinned list at MAX_PINNED_NAV_TOOLS', () => {
    let pinned: string[] = [];
    const candidates = [...available];
    for (let i = 0; i < MAX_PINNED_NAV_TOOLS + 2; i += 1) {
      pinned = togglePinnedNavTool(pinned, candidates[i]);
    }
    expect(pinned).toHaveLength(MAX_PINNED_NAV_TOOLS);
    expect(pinned).not.toContain(candidates[MAX_PINNED_NAV_TOOLS]);
  });

  it('migrates legacy pins to their new homes and drops removed ones', () => {
    expect(
      migratePinnedNavTools([
        '/meeting-notes',
        '/workspace-notes',
        '/security',
        '/adrs',
        '/diagrams',
        '/git',
        '/browser',
        '/cicd',
        '/onboard',
        '/dependencies',
      ]),
    ).toEqual(['/notes', '/library', '/git', '/browser']);
  });

  it('reads, migrates and persists stored pins', () => {
    let stored = JSON.stringify(['/git', '/not-a-route', 42, '/docs', '/security', '/argent']);
    const storage = {
      getItem: (key: string) => (key === PINNED_NAV_TOOLS_STORAGE_KEY ? stored : null),
      setItem: (_key: string, value: string) => {
        stored = value;
      },
    };
    expect(readPinnedNavTools(available, storage)).toEqual(['/git', '/library', '/argent']);
    // Unknown entries stay in storage (role-hidden pins come back); legacy ones are migrated.
    expect(JSON.parse(stored)).toEqual(['/git', '/not-a-route', '/library', '/argent']);
  });

  it('does not rewrite storage when nothing needs migrating', () => {
    let writes = 0;
    const storage = {
      getItem: () => JSON.stringify(['/git']),
      setItem: () => {
        writes += 1;
      },
    };
    expect(readPinnedNavTools(available, storage)).toEqual(['/git']);
    expect(writes).toBe(0);
  });

  it('returns no pins when storage is empty or broken', () => {
    expect(readPinnedNavTools(available, { getItem: () => null })).toEqual([]);
    expect(readPinnedNavTools(available, { getItem: () => '{oops' })).toEqual([]);
    expect(readPinnedNavTools(available, undefined)).toEqual([]);
  });
});

describe('navItemGateReason (NV3)', () => {
  const ready = { chatEnabled: true, repoFeaturesEnabled: true };

  it('returns nothing for ungated or enabled items', () => {
    const repoTool = toolItems().find((item) => item.requiresRepoFeature)!;
    expect(navItemGateReason(PRIMARY_NAV_ITEMS[0], ready)).toBeUndefined();
    expect(navItemGateReason(repoTool, ready)).toBeUndefined();
  });

  it('distinguishes chat-gated from repo-gated reasons', () => {
    const chatItem = AUTOMATE_NAV_ITEMS.find((item) => item.requiresChat)!;
    const repoItem = toolItems().find((item) => item.requiresRepoFeature)!;
    const indexing = {
      chatEnabled: false,
      repoFeaturesEnabled: false,
      repoFeatureReason: 'Index repositories to unlock this feature.',
    };

    expect(navItemGateReason(chatItem, indexing)).toBe(
      'Index repositories to unlock this feature.',
    );
    expect(navItemGateReason(repoItem, indexing)).toBe(
      'Index repositories to unlock this feature.',
    );

    const chatOnlyDown = { chatEnabled: false, repoFeaturesEnabled: true };
    expect(navItemGateReason(chatItem, chatOnlyDown)).toMatch(/Chat/);
    expect(navItemGateReason(repoItem, chatOnlyDown)).toBeUndefined();
  });
});

describe('consolidated destinations', () => {
  it('builds repo detail paths', () => {
    expect(repoDetailPath('r 1')).toBe('/workspace?view=repositories&repo=r%201');
    expect(repoDetailPath('r1', 'health', 'dependencies')).toBe(
      '/workspace/repos/r1/health/dependencies',
    );
    expect(repoDetailPath('r1', 'setup')).toBe('/workspace/repos/r1/setup');
    expect(repositoriesSectionHintPath('health', 'cicd')).toBe(
      '/workspace?view=repositories&section=health&tab=cicd',
    );
  });

  it('builds library, notes and chat paths', () => {
    expect(libraryPath()).toBe('/workspace?view=library');
    expect(libraryPath({ kind: 'all' })).toBe('/workspace?view=library');
    expect(libraryPath({ kind: 'diagram', repoId: 'r1' })).toBe(
      '/workspace?view=library&kind=diagram&repo=r1',
    );
    expect(notesPath('meeting')).toBe('/notes?tab=meeting');
    expect(chatItemPath('t1', { surfaceId: 's1' })).toBe('/chat?thread=t1&surface=s1');
    expect(chatItemPath('t1', { artifactId: 'a1' })).toBe('/chat?thread=t1&artifact=a1');
    expect(chatPromptPath('Run a security audit')).toBe('/chat?prompt=Run%20a%20security%20audit');
  });
});

describe('resolveLegacyRoute (redirects)', () => {
  it.each([
    ['/security', '/workspace?view=repositories&section=health&tab=security'],
    ['/security/r1', '/workspace/repos/r1/health/security'],
    ['/security/r1/dependencies', '/workspace/repos/r1/health/dependencies'],
    ['/dependencies', '/workspace?view=repositories&section=health&tab=dependencies'],
    ['/dependencies/r1', '/workspace/repos/r1/health/dependencies'],
    ['/cicd', '/workspace?view=repositories&section=health&tab=cicd'],
    ['/onboard', '/workspace?view=repositories&section=setup'],
    ['/adrs', '/workspace?view=library&kind=adr'],
    ['/diagrams', '/workspace?view=library&kind=diagram'],
    ['/diagrams/r1', '/workspace?view=library&kind=diagram&repo=r1'],
    ['/docs', '/workspace?view=library&kind=doc'],
    ['/compliance', '/workspace?view=library&kind=compliance'],
    ['/library', '/workspace?view=library'],
    ['/meeting-notes', '/notes?tab=meeting'],
    ['/workspace-notes', '/notes?tab=workspace'],
  ])('%s → %s', (from, to) => {
    expect(resolveLegacyRoute(from)).toBe(to);
  });

  it('keeps demoted and current routes as destinations', () => {
    for (const path of ['/browser', '/db-insights', '/argent', '/chat', '/workspace', '/notes']) {
      expect(resolveLegacyRoute(path)).toBeNull();
    }
  });

  it('sends /onboard to a remembered repo’s Setup', () => {
    expect(resolveLegacyRoute('/onboard', '', { onboardRepoId: 'r9' })).toBe(
      '/workspace/repos/r9/setup',
    );
  });

  it('carries legacy query params such as auditId and tool-window flags', () => {
    expect(resolveLegacyRoute('/security/r1', '?auditId=a1&toolWindow=1')).toBe(
      '/workspace/repos/r1/health/security?auditId=a1&toolWindow=1',
    );
    expect(resolveLegacyRoute('/adrs', '?workspaceId=w1&kind=ignored')).toBe(
      '/workspace?view=library&kind=adr&workspaceId=w1',
    );
  });

  it('decodes and re-encodes repo ids', () => {
    expect(resolveLegacyRoute('/security/repo%20one')).toBe(
      '/workspace/repos/repo%20one/health/security',
    );
  });
});
