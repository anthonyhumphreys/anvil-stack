import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRepositoryMapGraph,
  REPOSITORY_MAP_GRAPH_LIMITS,
} from '../repository-map-graph.service.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('repository-map-graph.service', () => {
  it('builds module, directory, file, symbol, and dependency nodes', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-repository-map-'));
    temporaryDirectories.push(repoPath);
    fs.mkdirSync(path.join(repoPath, 'src/components'), { recursive: true });
    fs.mkdirSync(path.join(repoPath, 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, 'src/components/App.tsx'),
      "import { sum } from '../../lib/math';\nexport function App() { return <main>{sum(1, 2)}</main>; }\n",
    );
    fs.writeFileSync(
      path.join(repoPath, 'lib/math.ts'),
      'export const sum = (left: number, right: number) => left + right;\n',
    );

    const graph = buildRepositoryMapGraph({
      repoId: 'repo-1',
      repositoryName: 'Example',
      repoPath,
      indexedCommitSha: 'abc123',
      files: [
        { relativePath: 'src/components/App.tsx', extension: '.tsx', sizeBytes: 100 },
        { relativePath: 'lib/math.ts', extension: '.ts', sizeBytes: 70 },
      ],
      modules: [
        {
          path: 'src',
          purpose: 'Application',
          fileCount: 1,
          keyFiles: ['src/components/App.tsx'],
          dependencies: [],
        },
        {
          path: 'lib',
          purpose: 'Shared library',
          fileCount: 1,
          keyFiles: ['lib/math.ts'],
          dependencies: [],
        },
      ],
    });

    expect(graph).toMatchObject({
      schemaVersion: 1,
      repoId: 'repo-1',
      repositoryName: 'Example',
      indexedCommitSha: 'abc123',
      supportedSymbolLanguages: ['TypeScript', 'JavaScript'],
    });
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'module:src', kind: 'module' }),
        expect.objectContaining({ id: 'directory:src/components', parentId: 'module:src' }),
        expect.objectContaining({ id: 'file:src/components/App.tsx', kind: 'file' }),
        expect.objectContaining({ name: 'App', symbolKind: 'component', exported: true }),
        expect.objectContaining({ name: 'sum', symbolKind: 'variable', exported: true }),
      ]),
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'dependency',
          source: 'file:src/components/App.tsx',
          target: 'file:lib/math.ts',
        }),
        expect.objectContaining({
          kind: 'dependency',
          source: 'module:src',
          target: 'module:lib',
          count: 1,
        }),
      ]),
    );
  });

  it('caps the complete graph for very large repositories', () => {
    const graph = buildRepositoryMapGraph({
      repoId: 'large-repo',
      repositoryName: 'Large repository',
      repoPath: os.tmpdir(),
      files: Array.from(
        { length: REPOSITORY_MAP_GRAPH_LIMITS.nodes + 100 },
        (_, index) => ({
          relativePath: `file-${String(index).padStart(5, '0')}.md`,
          extension: '.md',
          sizeBytes: 10,
        }),
      ),
      modules: [
        {
          path: '.',
          purpose: 'Repository root',
          fileCount: REPOSITORY_MAP_GRAPH_LIMITS.nodes + 100,
          keyFiles: [],
          dependencies: [],
        },
      ],
    });

    expect(graph.nodes.length).toBeLessThanOrEqual(REPOSITORY_MAP_GRAPH_LIMITS.nodes);
    expect(graph.edges.length).toBeLessThanOrEqual(REPOSITORY_MAP_GRAPH_LIMITS.edges);
    expect(graph.warnings).toContain(
      `Limited repository map to ${REPOSITORY_MAP_GRAPH_LIMITS.nodes.toLocaleString()} nodes; some files and symbols were omitted.`,
    );
  });
});
