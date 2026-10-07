import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { MESH_MACHINE_MAX_FRAME_BYTES } from '../../../../cloud/contract/machine.js';
import type { MeshMachineHost } from '../../../../cloud/contract/machine.js';
import {
  createDesktopMeshMachineSocket,
  MeshHostRuntimePool,
  type MeshHostRuntimeDependencies,
  type MeshHostRuntimeContext,
} from '../mesh-host-runtime.service.js';
import type { MeshMachineSessionConnection } from '../mesh-host-client.service.js';

interface TestWebSocketPeer {
  send(data: Buffer): void;
}

interface TestWebSocketServer {
  address(): AddressInfo | string | null;
  on(event: 'connection', listener: (socket: TestWebSocketPeer) => void): void;
  once(event: 'listening', listener: () => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  close(callback: (error?: Error) => void): void;
}

const requireNode = createRequire(import.meta.url);
const WebSocketServer = (requireNode('ws') as {
  WebSocketServer: new (options: {
    port: number;
    host: string;
    perMessageDeflate: false;
  }) => TestWebSocketServer;
}).WebSocketServer;

const host: MeshMachineHost = {
  enrollmentId: 'target-enrollment',
  machineId: 'target-machine',
  endpointGeneration: 'generation-1',
  protocolVersion: 1,
  capabilities: ['machine.session/1', 'machine.stream/1'],
  operations: ['read.job'],
  online: true,
  lastSeenAt: '2026-10-04T00:00:00.000Z',
  reachableUntil: '2026-10-04T00:10:00.000Z',
  routes: [
    {
      kind: 'private',
      url: 'http://100.64.1.2:4312',
      machineId: 'target-machine',
      endpointGeneration: 'generation-1',
      reachableUntil: '2026-10-04T00:10:00.000Z',
    },
  ],
  allocationState: 'ready',
};

function context(): MeshHostRuntimeContext {
  return {
    apiUrl: 'https://backend.test/v1/',
    accessToken: 'secret-device-token',
    accountId: 'account-1',
    enrollmentId: 'source-enrollment',
  };
}

describe('MeshHostRuntimePool demand connections', () => {
  it('discovers roster entries without opening idle sessions', async () => {
    const discover = vi.fn(async () => [host]);
    const connect = vi.fn(async () => {
      throw new Error('must remain idle');
    });
    const pool = new MeshHostRuntimePool(
      context,
      { discover, connect } as unknown as MeshHostRuntimeDependencies,
    );

    pool.start();
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1));

    expect(pool.statuses()).toMatchObject([{ enrollmentId: host.enrollmentId, state: 'degraded' }]);
    expect(connect).not.toHaveBeenCalled();
    pool.stop();
  });

  it('shares one session between consumers and closes it when the final consumer releases', async () => {
    const connection = {
      routeKind: 'private',
      request: vi.fn(),
      close: vi.fn(),
    } as unknown as MeshMachineSessionConnection;
    const discover = vi.fn(async () => [host]);
    const connect = vi.fn(
      async (_target: MeshMachineHost, admission: Parameters<MeshHostRuntimeDependencies['connect']>[1]) => {
        expect(admission.socketFactory).toBe(createDesktopMeshMachineSocket);
        return connection;
      },
    );
    const pool = new MeshHostRuntimePool(
      context,
      { discover, connect } as unknown as MeshHostRuntimeDependencies,
    );
    pool.start();
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1));

    const releaseFirst = pool.retain(host.enrollmentId);
    const releaseSecond = pool.retain(host.enrollmentId);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(pool.hasHealthyPush(host.enrollmentId)).toBe(true);

    releaseFirst();
    expect(connection.close).not.toHaveBeenCalled();
    releaseSecond();
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(pool.hasHealthyPush(host.enrollmentId)).toBe(false);
    pool.stop();
  });

  it('rejects oversized WebSocket messages before delivering them to the host client', async () => {
    const server = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      perMessageDeflate: false,
    });
    let client: ReturnType<typeof createDesktopMeshMachineSocket> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected an ephemeral loopback port.');
      }
      server.on('connection', (socket) => {
        socket.send(Buffer.alloc(MESH_MACHINE_MAX_FRAME_BYTES + 1, 0x61));
      });

      client = createDesktopMeshMachineSocket(
        `ws://127.0.0.1:${(address as AddressInfo).port}`,
        ['anvil.machine.v1'],
      );
      const messages: unknown[] = [];
      const errors: Error[] = [];
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket close.')), 3_000);
        client?.on('message', (message) => messages.push(message));
        client?.on('error', (error) => errors.push(error as Error));
        client?.on('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain('Max payload size exceeded');
      expect(messages).toEqual([]);
    } finally {
      client?.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
});
