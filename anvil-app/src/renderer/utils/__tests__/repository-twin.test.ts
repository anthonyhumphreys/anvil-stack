import { describe, expect, it } from 'vitest';
import type { RepositoryMapGraph } from '../../../shared/types';
import { buildRepositoryTwinSnapshot } from '../repository-twin';

const graph: RepositoryMapGraph = {
  schemaVersion: 1,
  repoId: 'repo-1',
  repositoryName: 'Anvil',
  generatedAt: '2026-08-10T10:00:00.000Z',
  nodes: [
    { id: 'root', kind: 'repository', name: 'Anvil', path: '.' },
    { id: 'chat', kind: 'module', parentId: 'root', name: 'Chat', path: 'src/chat' },
    { id: 'runs', kind: 'module', parentId: 'root', name: 'Runs', path: 'src/runs' },
  ],
  edges: [{ id: 'chat-runs', kind: 'dependency', source: 'chat', target: 'runs' }],
  supportedSymbolLanguages: ['typescript'],
  warnings: [],
};

describe('buildRepositoryTwinSnapshot', () => {
  it('maps working tree changes and live runs onto repository districts', () => {
    const snapshot = buildRepositoryTwinSnapshot(
      graph,
      {
        branch: 'feature/twin',
        ahead: 2,
        behind: 1,
        files: [{ path: 'src/chat/ChatView.tsx', status: 'modified', staged: false }],
      },
      [
        {
          id: 'run-1',
          source: 'chat',
          title: 'Build Twin',
          status: 'running',
          repoIds: ['repo-1'],
          startedAt: '2026-08-10T10:00:00.000Z',
          changedFileCount: 1,
          evidenceCount: 2,
        },
      ],
      'repo-1',
    );

    expect(snapshot.changedFileCount).toBe(1);
    expect(snapshot.districts[0].node.id).toBe('chat');
    expect(snapshot.districts[0].connectedNodes.map((node) => node.id)).toEqual(['runs']);
    expect(snapshot.activeRuns.map((run) => run.id)).toEqual(['run-1']);
  });
});
