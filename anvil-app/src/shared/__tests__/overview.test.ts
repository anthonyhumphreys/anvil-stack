import { describe, expect, it } from 'vitest';
import {
  addOverviewModule,
  buildDefaultOverviewLayout,
  createOverviewModule,
  moveOverviewModule,
  normalizeOverviewLayout,
  removeOverviewModule,
  sourceAvailable,
  updateOverviewModule,
  visibleColumns,
  OVERVIEW_MAX_MODULES,
  type OverviewLayout,
  type OverviewSources,
} from '../overview';

const noSources: OverviewSources = {
  workItemConnections: [],
  workspaceConnectionIds: {},
  docs: { provider: 'none', configured: false },
};

const withTickets: OverviewSources = {
  workItemConnections: [{ id: 'conn-1', name: 'Platform', provider: 'linear' }],
  workspaceConnectionIds: { 'ws-1': 'conn-1' },
  docs: { provider: 'none', configured: false },
};

function layoutOf(...ids: string[]): OverviewLayout {
  return {
    version: 1,
    modules: ids.map((id) => createOverviewModule('activity', { id })),
  };
}

describe('overview defaults', () => {
  it('only offers Tickets once a connection is configured for the scope', () => {
    const global = { kind: 'global' } as const;
    const workspace = { kind: 'workspace', workspaceId: 'ws-1' } as const;
    const other = { kind: 'workspace', workspaceId: 'ws-2' } as const;

    expect(buildDefaultOverviewLayout(global, noSources).modules.map((m) => m.type)).not.toContain(
      'tickets',
    );
    const globalTickets = buildDefaultOverviewLayout(global, withTickets).modules.find(
      (module) => module.type === 'tickets',
    );
    expect(globalTickets?.config.connectionId).toBe('conn-1');
    expect(sourceAvailable('tickets', workspace, withTickets)).toBe(true);
    expect(sourceAvailable('tickets', other, withTickets)).toBe(false);
  });

  it('keeps workspace-only and global-only modules in their scopes', () => {
    const global = buildDefaultOverviewLayout({ kind: 'global' }, noSources);
    const workspace = buildDefaultOverviewLayout(
      { kind: 'workspace', workspaceId: 'ws-1' },
      noSources,
    );
    expect(global.modules.map((m) => m.type)).toContain('workspaces');
    expect(global.modules.map((m) => m.type)).not.toContain('repositories');
    expect(workspace.modules.map((m) => m.type)).toContain('repositories');
    expect(workspace.modules.map((m) => m.type)).not.toContain('workspaces');
  });
});

describe('overview layout operations', () => {
  it('moves modules to a target position without losing any', () => {
    const layout = layoutOf('a', 'b', 'c', 'd');
    expect(moveOverviewModule(layout, 'a', 2).modules.map((m) => m.id)).toEqual([
      'b',
      'c',
      'a',
      'd',
    ]);
    expect(moveOverviewModule(layout, 'd', 0).modules.map((m) => m.id)).toEqual([
      'd',
      'a',
      'b',
      'c',
    ]);
    expect(moveOverviewModule(layout, 'b', 99).modules.map((m) => m.id)).toEqual([
      'a',
      'c',
      'd',
      'b',
    ]);
    expect(moveOverviewModule(layout, 'missing', 0)).toBe(layout);
  });

  it('supports multiple instances and caps the module count', () => {
    let layout = layoutOf('a');
    layout = addOverviewModule(layout, createOverviewModule('activity', { id: 'b' }), 0);
    expect(layout.modules.map((m) => m.id)).toEqual(['b', 'a']);
    for (let index = 0; index < OVERVIEW_MAX_MODULES + 4; index += 1) {
      layout = addOverviewModule(layout, createOverviewModule('tickets'));
    }
    expect(layout.modules).toHaveLength(OVERVIEW_MAX_MODULES);
  });

  it('clamps rows and removes only the targeted instance', () => {
    const layout = layoutOf('a', 'b');
    expect(updateOverviewModule(layout, 'a', { rows: 400 }).modules[0].rows).toBe(25);
    expect(updateOverviewModule(layout, 'a', { rows: 0 }).modules[0].rows).toBe(3);
    expect(removeOverviewModule(layout, 'a').modules.map((m) => m.id)).toEqual(['b']);
  });

  it('treats required columns as always visible', () => {
    const module = createOverviewModule('pull-requests', { config: { columns: ['status'] } });
    expect([...visibleColumns(module)].sort()).toEqual(['status', 'title']);
  });
});

describe('normalizeOverviewLayout', () => {
  it('drops unknown types, out-of-scope modules, duplicates and unknown config', () => {
    const layout = normalizeOverviewLayout(
      {
        modules: [
          { id: 'x', type: 'kanban', width: 'half', rows: 5, config: {} },
          { id: 'r', type: 'repositories', width: 'half', rows: 5, config: {} },
          {
            id: 'p',
            type: 'pull-requests',
            width: 'enormous',
            rows: 3.6,
            config: { prStates: ['merged', 'bogus'], connectionId: 'nope', columns: ['zzz'] },
          },
          { id: 'p', type: 'findings', width: 'third', rows: 4, config: {} },
        ],
      },
      { kind: 'global' },
    );
    expect(layout.modules).toHaveLength(1);
    expect(layout.modules[0]).toMatchObject({
      id: 'p',
      width: 'two-thirds',
      rows: 4,
      config: { prStates: ['merged'], columns: [] },
    });
    expect(layout.modules[0].config.connectionId).toBeUndefined();
  });

  it('keeps only in-app routes and http(s) links', () => {
    const layout = normalizeOverviewLayout(
      {
        modules: [
          {
            id: 'links',
            type: 'pinned-links',
            width: 'third',
            rows: 6,
            config: {
              links: [
                { id: '1', label: 'Chat', target: '/chat' },
                { id: '2', label: 'Docs', target: 'https://example.com/docs' },
                { id: '3', label: 'Bad', target: 'javascript:alert(1)' },
                { id: '4', label: 'Proto', target: '//evil.example' },
                { id: '5', label: '', target: '/inbox' },
              ],
            },
          },
        ],
      },
      { kind: 'workspace', workspaceId: 'ws-1' },
    );
    expect(layout.modules[0].config.links?.map((link) => link.id)).toEqual(['1', '2']);
  });
});
