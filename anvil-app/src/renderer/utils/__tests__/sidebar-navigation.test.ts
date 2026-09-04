import { describe, expect, it } from 'vitest';
import {
  AUTOMATE_NAV_ITEMS,
  getAvailableSidebarNavigation,
  isSidebarNavItemActive,
  PRIMARY_NAV_ITEMS,
  TOOL_NAV_GROUPS,
} from '../sidebar-navigation';

describe('sidebar navigation', () => {
  it('keeps the primary navigation focused on Inbox, Chat, and Workspace', () => {
    expect(PRIMARY_NAV_ITEMS.map((item) => item.label)).toEqual(['Inbox', 'Chat', 'Workspace']);
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
    expect(isSidebarNavItemActive('/security/repo-1/pentest', security)).toBe(true);
  });
});
