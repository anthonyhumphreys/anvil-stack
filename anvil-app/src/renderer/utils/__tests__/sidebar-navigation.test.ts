import { describe, expect, it } from 'vitest';
import {
  AUTOMATE_NAV_ITEMS,
  getAvailableSidebarNavigation,
  isPinnableNavItem,
  isSidebarNavItemActive,
  MAX_PINNED_NAV_TOOLS,
  navItemGateReason,
  PINNED_NAV_TOOLS_STORAGE_KEY,
  PRIMARY_NAV_ITEMS,
  readPinnedNavTools,
  TOOL_NAV_GROUPS,
  togglePinnedNavTool,
} from '../sidebar-navigation';

describe('sidebar navigation', () => {
  it('keeps the primary navigation focused on Inbox, Chat, and Workspace', () => {
    expect(PRIMARY_NAV_ITEMS.map((item) => item.label)).toEqual(['Activity', 'Chat', 'Workspace']);
  });

  it('organises every existing work surface exactly once', () => {
    const paths = [
      ...PRIMARY_NAV_ITEMS.map((item) => item.path),
      ...AUTOMATE_NAV_ITEMS.map((item) => item.path),
      ...TOOL_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.path)),
    ];

    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/automations',
        '/workflows',
        '/dojo',
        '/workitems',
        '/codereview',
        '/cicd',
        '/git',
        '/editor',
        '/browser',
        '/cloud',
        '/db-insights',
        '/dependencies',
        '/security',
        '/onboard',
        '/argent',
        '/meeting-notes',
        '/workspace-notes',
        '/docs',
        '/adrs',
        '/diagrams',
        '/governance',
        '/compliance',
      ]),
    );
  });

  it('preserves role and Cloud feature gates inside the groups', () => {
    const developer = getAvailableSidebarNavigation('developer', false);
    const design = getAvailableSidebarNavigation('design', true);

    expect(developer.automate.map((item) => item.path)).toEqual([
      '/automations',
      '/workflows',
      '/dojo',
    ]);
    expect(
      developer.tools.flatMap((group) => group.items).some((item) => item.path === '/cloud'),
    ).toBe(false);
    expect(design.automate.map((item) => item.path)).toEqual(['/workflows', '/dojo']);
    expect(
      design.tools.flatMap((group) => group.items).some((item) => item.path === '/cloud'),
    ).toBe(true);
  });

  it('matches nested dependency and security routes to the correct item', () => {
    const dependency = TOOL_NAV_GROUPS.flatMap((group) => group.items).find(
      (item) => item.path === '/dependencies',
    )!;
    const security = TOOL_NAV_GROUPS.flatMap((group) => group.items).find(
      (item) => item.path === '/security',
    )!;

    expect(isSidebarNavItemActive('/security/repo-1/dependencies', dependency)).toBe(true);
    expect(isSidebarNavItemActive('/security/repo-1/dependencies', security)).toBe(false);
    expect(isSidebarNavItemActive('/security/repo-1', security)).toBe(true);
  });

  it('labels the two review surfaces distinctly (NV1)', () => {
    const review = TOOL_NAV_GROUPS.flatMap((group) => group.items).find(
      (item) => item.path === '/review',
    )!;
    const codeReview = TOOL_NAV_GROUPS.flatMap((group) => group.items).find(
      (item) => item.path === '/codereview',
    )!;

    expect(review.label).toBe('Changes');
    expect(codeReview.label).toBe('PR Review');
    expect(review.label).not.toBe(codeReview.label);
  });

  it('labels the repo-readiness wizard Repo setup (OB1)', () => {
    const onboard = TOOL_NAV_GROUPS.flatMap((group) => group.items).find(
      (item) => item.path === '/onboard',
    )!;
    expect(onboard.label).toBe('Repo setup');
  });

  it('gives every tool a one-line description (NV2)', () => {
    const tools = TOOL_NAV_GROUPS.flatMap((group) => group.items);
    expect(tools.every((item) => !!item.description)).toBe(true);
  });
});

describe('pinned nav tools (NV2)', () => {
  const available = new Set(
    TOOL_NAV_GROUPS.flatMap((group) => group.items).map((item) => item.path),
  );

  it('only automate/tool items are pinnable', () => {
    expect(isPinnableNavItem(PRIMARY_NAV_ITEMS[0])).toBe(false);
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

  it('drops stale and malformed stored pins', () => {
    const storage = {
      getItem: (key: string) =>
        key === PINNED_NAV_TOOLS_STORAGE_KEY
          ? JSON.stringify(['/git', '/not-a-route', 42, '/docs'])
          : null,
    };
    expect(readPinnedNavTools(available, storage)).toEqual(['/git', '/docs']);
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
    const plain = PRIMARY_NAV_ITEMS[0];
    const repoTool = TOOL_NAV_GROUPS.flatMap((group) => group.items).find(
      (item) => item.requiresRepoFeature,
    )!;
    expect(navItemGateReason(plain, ready)).toBeUndefined();
    expect(navItemGateReason(repoTool, ready)).toBeUndefined();
  });

  it('distinguishes chat-gated from repo-gated reasons', () => {
    const chatItem = AUTOMATE_NAV_ITEMS.find((item) => item.requiresChat)!;
    const repoItem = TOOL_NAV_GROUPS.flatMap((group) => group.items).find(
      (item) => item.requiresRepoFeature,
    )!;
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
