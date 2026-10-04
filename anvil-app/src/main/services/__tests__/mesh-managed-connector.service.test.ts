import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  MeshManagedConnector,
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
      writeSecretFile: async (_path, secret) => { writtenSecret = secret; },
      removeTempDir,
      startupTimeoutMs: 100,
      stopTimeoutMs: 100,
    });

    const status = await connector.start(assignment);
    expect(status).toMatchObject({ state: 'running', machineId: assignment.machineId, allocationGeneration: 4 });
    expect(writtenSecret).toBe(assignment.connectorToken);
    expect(args).toEqual([
      'tunnel', '--no-autoupdate', '--loglevel', 'error', 'run', '--token-file',
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

  it('reports an unsupported local fallback when cloudflared is unavailable', async () => {
    const spawn = vi.fn<ConnectorSpawn>();
    const connector = new MeshManagedConnector({
      enabled: () => true,
      env: { PATH: '' },
      pathExists: async () => false,
      spawn,
    });

    const status = await connector.start(assignment);
    expect(status).toMatchObject({ state: 'unsupported', reason: 'binary-unavailable' });
    expect(spawn).not.toHaveBeenCalled();
  });
});
