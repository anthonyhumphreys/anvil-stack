import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryMapGraph } from '../../../shared/types.js';

// Under Vitest the bundled worker entry doesn't exist, so
// buildRepositoryMapInWorker runs the graph build inline. Mock the graph
// service with deferred promises so the test can observe the one-at-a-time
// serialization the worker pool guarantees in production.
const state = vi.hoisted(() => ({
  builds: [] as Array<{
    resolve: (graph: RepositoryMapGraph) => void;
    reject: (error: Error) => void;
  }>,
}));

vi.mock('../repository-map-graph.service.js', () => ({
  buildRepositoryMapGraph: () =>
    new Promise<RepositoryMapGraph>((resolve, reject) => {
      state.builds.push({ resolve, reject });
    }),
}));

import { buildRepositoryMapInWorker } from '../repository-map-worker.service.js';

const input = { repoId: 'repo', repositoryName: 'Repo', repoPath: '/repo', files: [], modules: [] };

function graph(): RepositoryMapGraph {
  return {
    schemaVersion: 1,
    repoId: 'repo',
    repositoryName: 'Repo',
    generatedAt: '',
    nodes: [],
    edges: [],
    supportedSymbolLanguages: [],
    warnings: [],
  };
}

/** Wait until `count` builds have been started (the inline path resolves the
 * graph service through a dynamic import, which takes more than a microtask). */
function waitForBuilds(count: number): Promise<void> {
  return vi.waitFor(() => expect(state.builds).toHaveLength(count));
}

beforeEach(() => {
  state.builds.length = 0;
});

describe('repository map build queue', () => {
  it('waits for the in-flight build before starting the next queued parser', async () => {
    const first = buildRepositoryMapInWorker(input);
    const second = buildRepositoryMapInWorker(input);
    await waitForBuilds(1);
    state.builds[0].resolve(graph());
    await expect(first).resolves.toMatchObject({ nodes: [], edges: [] });
    await waitForBuilds(2);
    state.builds[1].resolve(graph());
    await expect(second).resolves.toMatchObject({ nodes: [], edges: [] });
  });

  it('propagates a build failure and still runs the next queued job', async () => {
    const first = buildRepositoryMapInWorker(input);
    const rejected = expect(first).rejects.toThrow('parse exploded');
    await waitForBuilds(1);
    state.builds[0].reject(new Error('parse exploded'));
    await rejected;
    const next = buildRepositoryMapInWorker(input);
    await waitForBuilds(2);
    state.builds[1].resolve(graph());
    await expect(next).resolves.toMatchObject({ nodes: [] });
  });
});
