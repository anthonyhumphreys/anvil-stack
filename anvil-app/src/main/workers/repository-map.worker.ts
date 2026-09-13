import { parentPort, workerData } from 'node:worker_threads';
import { buildRepositoryMapGraph } from '../services/repository-map-graph.service.js';

parentPort?.postMessage(buildRepositoryMapGraph(workerData));
parentPort?.close();
