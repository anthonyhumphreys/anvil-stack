import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { RepositoryMapGraph } from '../../shared/types.js';
import type { BuildRepositoryMapGraphInput } from './repository-map-graph.service.js';

// Avoid loading multiple TypeScript compilers when several repositories finish indexing together.
let pending: Promise<unknown> = Promise.resolve();

/**
 * electron-vite emits the worker entry as `repository-map.worker.js` next to
 * the bundled main process (`out/main/index.js`). Under Vitest the source tree
 * runs directly, so that file doesn't exist — build the graph inline instead.
 * The inline path stays serialized through `pending`, so the same one-parser-
 * at-a-time guarantee holds in tests.
 */
const WORKER_URL = new URL('./repository-map.worker.js', import.meta.url);
const canSpawnWorker = existsSync(fileURLToPath(WORKER_URL));

export function buildRepositoryMapInWorker(
  input: BuildRepositoryMapGraphInput,
): Promise<RepositoryMapGraph> {
  const result = pending.then(() => (canSpawnWorker ? runWorker(input) : runInline(input)));
  pending = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function runInline(input: BuildRepositoryMapGraphInput): Promise<RepositoryMapGraph> {
  const { buildRepositoryMapGraph } = await import('./repository-map-graph.service.js');
  return buildRepositoryMapGraph(input);
}

function runWorker(input: BuildRepositoryMapGraphInput): Promise<RepositoryMapGraph> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, {
      workerData: input,
    });
    let graph: RepositoryMapGraph | undefined;
    let failure: Error | undefined;
    const timeout = setTimeout(() => {
      failure = new Error('Repository map generation timed out');
      void worker.terminate();
    }, 60_000);
    worker.once('message', (result: RepositoryMapGraph) => {
      graph = result;
    });
    worker.once('error', (error) => {
      clearTimeout(timeout);
      failure = error instanceof Error ? error : new Error(String(error));
    });
    worker.once('exit', (code) => {
      clearTimeout(timeout);
      if (failure) reject(failure);
      else if (code === 0 && graph) resolve(graph);
      else reject(new Error(`Repository map worker exited without a result (code ${code})`));
    });
  });
}
