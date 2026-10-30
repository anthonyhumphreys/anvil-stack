import { describe, expect, it } from 'vitest';
import type { RepositoryMapGraph } from '../../../shared/types';
import { buildRepositoryGardenLayout } from '../repository-garden-layout';

describe('repository-garden-layout', () => {
  it('places modules deterministically and turns module dependencies into paths', () => {
    const graph: RepositoryMapGraph = {
      schemaVersion: 1,
      repoId: 'repo-1',
      repositoryName: 'Example',
      generatedAt: '2026-08-03T00:00:00.000Z',
      supportedSymbolLanguages: ['TypeScript'],
      warnings: [],
      nodes: [
        { id: 'repository:repo-1', kind: 'repository', name: 'Example', path: '.' },
        {
          id: 'module:src',
          kind: 'module',
          parentId: 'repository:repo-1',
          name: 'src',
          path: 'src',
          fileCount: 12,
        },
        {
          id: 'module:lib',
          kind: 'module',
          parentId: 'repository:repo-1',
          name: 'lib',
          path: 'lib',
          fileCount: 4,
        },
        {
          id: 'directory:src/components',
          kind: 'directory',
          parentId: 'module:src',
          name: 'components',
          path: 'src/components',
        },
        {
          id: 'file:src/index.ts',
          kind: 'file',
          parentId: 'module:src',
          name: 'index.ts',
          path: 'src/index.ts',
        },
      ],
      edges: [
        {
          id: 'dependency:module:src->module:lib',
          kind: 'dependency',
          source: 'module:src',
          target: 'module:lib',
          count: 3,
        },
      ],
    };

    const first = buildRepositoryGardenLayout(graph);
    const second = buildRepositoryGardenLayout(graph);
    expect(second).toEqual(first);
    expect(first.plots.map((plot) => plot.node.id)).toEqual(['module:lib', 'module:src']);
    expect(first.paths).toEqual([
      expect.objectContaining({ sourceId: 'module:src', targetId: 'module:lib', count: 3 }),
    ]);
  });

  it('lays out the direct children of a nested scope and reports paging metadata', () => {
    const graph: RepositoryMapGraph = {
      schemaVersion: 1,
      repoId: 'repo-1',
      repositoryName: 'Example',
      generatedAt: '2026-08-03T00:00:00.000Z',
      supportedSymbolLanguages: ['TypeScript'],
      warnings: [],
      nodes: [
        { id: 'repository:repo-1', kind: 'repository', name: 'Example', path: '.' },
        {
          id: 'module:src',
          kind: 'module',
          parentId: 'repository:repo-1',
          name: 'src',
          path: 'src',
        },
        ...Array.from({ length: 5 }, (_, index) => ({
          id: `file:src/${index}.ts`,
          kind: 'file' as const,
          parentId: 'module:src',
          name: `${index}.ts`,
          path: `src/${index}.ts`,
        })),
      ],
      edges: [],
    };

    const layout = buildRepositoryGardenLayout(graph, {
      scopeId: 'module:src',
      offset: 2,
      limit: 2,
    });

    expect(layout.scopeNode.id).toBe('module:src');
    expect(layout.totalChildren).toBe(5);
    expect(layout.plots.map((plot) => plot.node.name)).toEqual(['2.ts', '3.ts']);
    expect(layout).toMatchObject({ offset: 2, limit: 2 });
  });
});
