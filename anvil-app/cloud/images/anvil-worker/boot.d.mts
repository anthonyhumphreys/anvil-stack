import type { SpawnSyncReturns } from 'node:child_process';

export interface MeshEnvironmentBootstrap {
  kind: 'anvil.mesh-environment';
  schemaVersion: '0.2';
  environmentId: string;
  provider?: string;
  backendUrl: string;
  enrollmentCode: string;
  ttlSeconds: number;
  networkPolicy?: unknown;
}

export function parseBootstrapPayload(raw: string): MeshEnvironmentBootstrap;

export function prepareWorkerStorage(
  dataDir: string,
  keyFilePath: string,
  run?: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; encoding: 'utf8'; timeout: number; maxBuffer: number },
  ) => SpawnSyncReturns<string>,
): void;

export function readBootstrap(
  argv?: string[],
  env?: Record<string, string | undefined>,
  readFile?: (path: string) => string,
): MeshEnvironmentBootstrap;
