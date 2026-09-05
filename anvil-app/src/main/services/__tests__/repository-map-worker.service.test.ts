import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ workers: [] as EventEmitter[] }));
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    constructor() {
      super();
      state.workers.push(this);
    }
    terminate() {
      this.emit('exit', 1);
      return Promise.resolve(1);
    }
  },
}));

import { buildRepositoryMapInWorker } from '../repository-map-worker.service.js';

const input = { repoId: 'repo', repositoryName: 'Repo', repoPath: '/repo', files: [], modules: [] };

beforeEach(() => {
  state.workers.length = 0;
});

describe('repository map worker lifecycle', () => {
  it('waits for worker exit before starting the next queued parser', async () => {
    const first = buildRepositoryMapInWorker(input);
    const second = buildRepositoryMapInWorker(input);
    await Promise.resolve();
    expect(state.workers).toHaveLength(1);
    state.workers[0].emit('message', { nodes: [], edges: [] });
    expect(state.workers).toHaveLength(1);
    state.workers[0].emit('exit', 0);
    await first;
    await Promise.resolve();
    expect(state.workers).toHaveLength(2);
    state.workers[1].emit('message', { nodes: [], edges: [] });
    state.workers[1].emit('exit', 0);
    await expect(second).resolves.toMatchObject({ nodes: [], edges: [] });
  });

  it('rejects an empty result and allows the next job to run', async () => {
    const first = buildRepositoryMapInWorker(input);
    const rejected = expect(first).rejects.toThrow('without a result');
    await Promise.resolve();
    state.workers[0].emit('exit', 1);
    await rejected;
    const next = buildRepositoryMapInWorker(input);
    await Promise.resolve();
    state.workers[1].emit('message', { nodes: [], edges: [] });
    state.workers[1].emit('exit', 0);
    await expect(next).resolves.toMatchObject({ nodes: [] });
  });
});
