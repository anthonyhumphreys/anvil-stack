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
});
