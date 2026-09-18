export interface MeshEnvironmentBootstrap {
  kind: 'anvil.mesh-environment';
  schemaVersion: '0.1';
  environmentId: string;
  provider?: string;
  backendUrl: string;
  pairing: string;
  ttlSeconds: number;
  networkPolicy?: unknown;
}

export function parseBootstrapPayload(raw: string): MeshEnvironmentBootstrap;

export function readBootstrap(
  argv?: string[],
  env?: Record<string, string | undefined>,
  readFile?: (path: string) => string,
): MeshEnvironmentBootstrap;
