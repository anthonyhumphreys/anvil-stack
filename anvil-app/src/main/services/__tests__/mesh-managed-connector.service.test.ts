import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MeshManagedConnector,
  configureMeshManagedConnector,
  configureMeshManagedEndpointLifecycle,
  resetMeshManagedConnectorForTests,
  startManagedEndpointForHost,
  type ConnectorSpawn,
} from '../mesh-managed-connector.service.js';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signalCode = signal;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

const assignment = {
  machineId: 'machine-host',
  endpointGeneration: 'listener-generation-123456',
  allocationGeneration: 4,
  hostname: 'host-0123456789abcdef01234567.mesh.example.test',
  connectorToken: 'opaque-cloudflare-connector-token-that-must-not-leak',
  localOrigin: 'http://127.0.0.1:43127',
};

describe('managed machine connector process', () => {
  it('keeps tunnel credentials out of process args/status and generation-fences stops', async () => {
    const child = new FakeChild();
    let writtenSecret = '';
    let args: string[] = [];
    const spawn: ConnectorSpawn = (command, spawnArgs, options) => {
      expect(command).toBe('/opt/cloudflared');
      expect(options.shell).toBe(false);
      expect(options.stdio).toBe('ignore');
      args = spawnArgs;
      queueMicrotask(() => child.emit('spawn'));
      return child as unknown as ReturnType<ConnectorSpawn>;
    };
    const removeTempDir = vi.fn(async () => undefined);
    const connector = new MeshManagedConnector({
      enabled: () => true,
      env: { PATH: '', ANVIL_CLOUDFLARED_PATH: '/opt/cloudflared' },
      pathExists: async (path) => path === '/opt/cloudflared',
      spawn,
      makeTempDir: async () => '/tmp/anvil-managed-connector-test',
      writeSecretFile: async (_path, secret) => {
        writtenSecret = secret;
      },
      removeTempDir,
      startupTimeoutMs: 100,
      stopTimeoutMs: 100,
    });

    const status = await connector.start(assignment);
    expect(status).toMatchObject({
      state: 'running',
      machineId: assignment.machineId,
      allocationGeneration: 4,
    });
    expect(writtenSecret).toBe(assignment.connectorToken);
    expect(args).toEqual([
      'tunnel',
      '--no-autoupdate',
      '--loglevel',
      'error',
      'run',
      '--token-file',
      '/tmp/anvil-managed-connector-test/token',
    ]);
    expect(args.join(' ')).not.toContain(assignment.connectorToken);
    expect(JSON.stringify(status)).not.toContain(assignment.connectorToken);

    const staleStop = await connector.stopGeneration({
      machineId: assignment.machineId,
      endpointGeneration: assignment.endpointGeneration,
      allocationGeneration: assignment.allocationGeneration - 1,
    });
    expect(staleStop).toMatchObject({ state: 'running', reason: 'stale-generation' });
    expect(child.signalCode).toBeNull();

    const stopped = await connector.stopGeneration({
      machineId: assignment.machineId,
      endpointGeneration: assignment.endpointGeneration,
      allocationGeneration: assignment.allocationGeneration,
    });
    expect(stopped.state).toBe('stopped');
    expect(child.signalCode).toBe('SIGTERM');
    expect(removeTempDir).toHaveBeenCalledWith('/tmp/anvil-managed-connector-test');
  });

  it('finds the conventional macOS Homebrew install when PATH is empty', async () => {
    const child = new FakeChild();
    let command = '';
    const checkedPaths: string[] = [];
    const connector = new MeshManagedConnector({
      enabled: () => true,
      env: { PATH: '' },
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: '/mock/resources',
      pathExists: async (path) => {
        checkedPaths.push(path);
        return path === '/opt/homebrew/bin/cloudflared';
      },
      spawn: (binary) => {
        command = binary;
        queueMicrotask(() => child.emit('spawn'));
        return child as unknown as ReturnType<ConnectorSpawn>;
      },
      makeTempDir: async () => '/tmp/anvil-managed-connector-test',
      writeSecretFile: async () => undefined,
      removeTempDir: async () => undefined,
      startupTimeoutMs: 100,
      stopTimeoutMs: 100,
    });

    const status = await connector.start(assignment);

    expect(status.state).toBe('running');
    expect(command).toBe('/opt/homebrew/bin/cloudflared');
    expect(checkedPaths).toEqual([
      '/mock/resources/cloudflared/darwin-arm64/cloudflared',
      '/opt/homebrew/bin/cloudflared',
    ]);
    await connector.stop();
  });

  it('reports an unsupported local fallback when cloudflared is unavailable', async () => {
    const spawn = vi.fn<ConnectorSpawn>();
    const pathExists = vi.fn(async (_path: string, _executable: boolean) => false);
    const connector = new MeshManagedConnector({
      enabled: () => true,
      env: { PATH: '' },
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: '/mock/resources',
      pathExists,
      spawn,
    });

    const status = await connector.start(assignment);
    expect(status).toMatchObject({ state: 'unsupported', reason: 'binary-unavailable' });
    expect(spawn).not.toHaveBeenCalled();
    expect(pathExists.mock.calls.map(([path]) => path)).toEqual([
      '/mock/resources/cloudflared/darwin-arm64/cloudflared',
      '/opt/homebrew/bin/cloudflared',
      '/usr/local/bin/cloudflared',
    ]);
  });
});

describe('managed endpoint availability', () => {
  afterEach(() => {
    resetMeshManagedConnectorForTests();
    vi.unstubAllEnvs();
  });

  it('does not contact the broker or launch a connector when explicitly disabled', async () => {
    vi.stubEnv('ANVIL_MESH_MANAGED_ENDPOINTS', 'false');
    const fetchBroker = vi.fn<typeof fetch>();
    const spawn = vi.fn<ConnectorSpawn>();
    const pathExists = vi.fn(async () => true);
    configureMeshManagedConnector({ spawn, pathExists });
    configureMeshManagedEndpointLifecycle({
      context: () => ({
        apiUrl: 'https://backend.example.test',
        accessToken: 'test-account-token',
      }),
      fetch: fetchBroker,
    });

    const result = await startManagedEndpointForHost({
      machineId: assignment.machineId,
      endpointGeneration: assignment.endpointGeneration,
      localOrigin: assignment.localOrigin,
    });

    expect(result).toEqual({
      status: { state: 'unsupported', reason: 'disabled' },
      managedOrigin: null,
      allocationGeneration: null,
    });
    expect(fetchBroker).not.toHaveBeenCalled();
    expect(pathExists).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('attempts a connector without a client feature flag', async () => {
    vi.stubEnv('ANVIL_MESH_MANAGED_ENDPOINTS', undefined);
    const pathExists = vi.fn(async () => false);
    const connector = new MeshManagedConnector({
      env: { PATH: '' },
      resourcesPath: '/mock/resources',
      platform: 'linux',
      arch: 'x64',
      pathExists,
    });

    expect(await connector.start(assignment)).toMatchObject({
      state: 'unsupported',
      reason: 'binary-unavailable',
    });
    expect(pathExists).toHaveBeenCalled();
  });

  it('releases a crashed connector once when managed endpoints are disabled', async () => {
    const child = new FakeChild();
    const connector = new MeshManagedConnector({
      enabled: () => true,
      env: { PATH: '', ANVIL_CLOUDFLARED_PATH: '/opt/cloudflared' },
      pathExists: async () => true,
      spawn: () => {
        queueMicrotask(() => child.emit('spawn'));
        return child as unknown as ReturnType<ConnectorSpawn>;
      },
      makeTempDir: async () => '/tmp/anvil-managed-connector-test',
      writeSecretFile: async () => undefined,
      removeTempDir: async () => undefined,
    });
    configureMeshManagedConnector(connector);
    await connector.start(assignment);
    child.exitCode = 1;
    child.emit('exit', 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(connector.status()).toMatchObject({ state: 'error', reason: 'process-exited' });

    vi.stubEnv('ANVIL_MESH_MANAGED_ENDPOINTS', 'false');
    const fetchBroker = vi.fn<typeof fetch>(async () => new Response('{}'));
    configureMeshManagedEndpointLifecycle({
      context: () => ({
        apiUrl: 'https://backend.example.test',
        accessToken: 'test-account-token',
      }),
      fetch: fetchBroker,
    });
    const input = {
      machineId: assignment.machineId,
      endpointGeneration: assignment.endpointGeneration,
      localOrigin: assignment.localOrigin,
    };
    await startManagedEndpointForHost(input);
    await startManagedEndpointForHost(input);

    expect(connector.status()).toEqual({ state: 'stopped' });
    expect(fetchBroker).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchBroker.mock.calls[0][1]!.body as string)).toMatchObject({
      action: 'release',
      allocationGeneration: assignment.allocationGeneration,
    });
  });
});
