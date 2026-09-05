import { Worker } from 'node:worker_threads';
import type { RepositoryMapGraph } from '../../shared/types.js';
import type { BuildRepositoryMapGraphInput } from './repository-map-graph.service.js';

// Avoid loading multiple TypeScript compilers when several repositories finish indexing together.
let pending: Promise<unknown> = Promise.resolve();

export function buildRepositoryMapInWorker(
  input: BuildRepositoryMapGraphInput,
): Promise<RepositoryMapGraph> {
  const result = pending.then(() => runWorker(input));
  pending = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function runWorker(input: BuildRepositoryMapGraphInput): Promise<RepositoryMapGraph> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./repository-map.worker.js', import.meta.url), {
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
