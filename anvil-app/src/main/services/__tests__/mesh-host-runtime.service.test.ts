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
const WebSocketServer = (
  requireNode('ws') as {
    WebSocketServer: new (options: {
      port: number;
      host: string;
      perMessageDeflate: false;
    }) => TestWebSocketServer;
  }
).WebSocketServer;

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
    const pool = new MeshHostRuntimePool(context, {
      discover,
      connect,
    } as unknown as MeshHostRuntimeDependencies);

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
      async (
        _target: MeshMachineHost,
        admission: Parameters<MeshHostRuntimeDependencies['connect']>[1],
      ) => {
        expect(admission.socketFactory).toBe(createDesktopMeshMachineSocket);
        return connection;
      },
    );
    const pool = new MeshHostRuntimePool(context, {
      discover,
      connect,
    } as unknown as MeshHostRuntimeDependencies);
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

      client = createDesktopMeshMachineSocket(`ws://127.0.0.1:${(address as AddressInfo).port}`, [
        'anvil.machine.v1',
      ]);
      const messages: unknown[] = [];
      const errors: Error[] = [];
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out waiting for WebSocket close.')),
          3_000,
        );
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

interface FakeStream {
  connection: MeshMachineSessionConnection;
  admission: Parameters<MeshHostRuntimeDependencies['connect']>[1];
  cursor: { epoch: string; sequence: number };
  close: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  emit: (sequence: number) => void;
}
function fakeStream(
  target: MeshMachineHost,
  admission: FakeStream['admission'],
  sequence = 0,
): FakeStream {
  const cursor = { epoch: 'epoch', sequence };
  const close = vi.fn();
  const request = vi.fn(async () => 'ok');
  const stream: FakeStream = {
    cursor,
    close,
    request,
    admission,
    connection: {
      routeKind: target.routes[0]!.kind,
      route: target.routes[0],
      supportsHandoff: true,
      streamCursor: cursor,
      isOpen: true,
      close,
      request,
    } as unknown as MeshMachineSessionConnection,
    emit(next) {
      cursor.sequence = next;
      admission.onEvent?.({
        enrollmentId: target.enrollmentId,
        epoch: 'epoch',
        sequence: next,
        workspaceId: 'workspace',
        eventKind: 'activity',
        payload: { next },
      });
    },
  };
  return stream;
}
function migrationHost(): MeshMachineHost {
  return {
    ...host,
    capabilities: ['machine.session/1', 'machine.stream/1', 'machine.stream-handoff/1'],
    routes: [
      {
        ...host.routes[0]!,
        kind: 'managed',
        url: 'https://managed.test',
        reachableUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
  };
}
function addLan(target: MeshMachineHost): void {
  target.routes.push({
    ...target.routes[0]!,
    kind: 'private',
    networkKind: 'lan',
    url: 'http://192.168.1.50:47631',
  });
}

describe('Mesh host route migration', () => {
  it('keeps the working tunnel while LAN authentication fails', async () => {
    const target = migrationHost();
    const sessions: FakeStream[] = [];
    const connect = vi.fn(async (next: MeshMachineHost, admission: FakeStream['admission']) => {
      if (sessions.length > 0) throw new Error('route-unavailable');
      const stream = fakeStream(next, admission);
      sessions.push(stream);
      return stream.connection;
    });
    const pool = new MeshHostRuntimePool(
      context,
      { discover: async () => [target], connect },
      { dwellMs: 0 },
    );
    const release = pool.retain(target.enrollmentId);
    try {
      await vi.waitFor(() => expect(pool.hasHealthyPush(target.enrollmentId)).toBe(true));
      addLan(target);
      await pool.refresh();
      await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
      await expect(pool.request(target.enrollmentId, 'read.job', {})).resolves.toBe('ok');
      expect(sessions[0]!.close).not.toHaveBeenCalled();
      expect(pool.statuses()).toMatchObject([{ state: 'live', route: 'managed' }]);
      await pool.refresh();
      expect(connect).toHaveBeenCalledTimes(2); // failure cooldown
    } finally {
      release();
      pool.stop();
    }
  });

  it('catches up, deduplicates overlap, drains the old mutation and ignores its late close', async () => {
    const target = migrationHost();
    const sessions: FakeStream[] = [];
    const events: number[] = [];
    let finishCandidate!: () => void;
    let finishMutation!: (value: string) => void;
    const connect = vi.fn(async (next: MeshMachineHost, admission: FakeStream['admission']) => {
      const stream = fakeStream(next, admission);
      sessions.push(stream);
      if (sessions.length === 2)
        await new Promise<void>((resolve) => {
          finishCandidate = resolve;
        });
      return stream.connection;
    });
    const pool = new MeshHostRuntimePool(
      () => ({ ...context(), onEvent: (event) => events.push(event.sequence) }),
      { discover: async () => [target], connect },
      { dwellMs: 0 },
    );
    const release = pool.retain(target.enrollmentId);
    try {
      await vi.waitFor(() => expect(pool.hasHealthyPush(target.enrollmentId)).toBe(true));
      const old = sessions[0]!;
      old.emit(3); // filtered global sequence gaps are valid
      old.request.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishMutation = resolve;
          }),
      );
      const mutation = pool.request(
        target.enrollmentId,
        'command.steer',
        { text: 'once' },
        'stable-id',
      );
      await vi.waitFor(() => expect(finishMutation).toBeDefined());
      addLan(target);
      await pool.refresh();
      await vi.waitFor(() => expect(sessions).toHaveLength(2));
      const candidate = sessions[1]!;
      expect(candidate.admission.resumeCursor).toEqual({ epoch: 'epoch', sequence: 3 });
      candidate.emit(3);
      old.emit(5);
      finishCandidate();
      await Promise.resolve();
      await Promise.resolve();
      expect(pool.statuses()[0]?.route).toBe('managed');
      candidate.emit(5);
      await vi.waitFor(() => expect(pool.statuses()[0]?.path).toBe('direct'));
      expect(events).toEqual([3, 5]);
      expect(old.close).not.toHaveBeenCalled();
      await expect(pool.request(target.enrollmentId, 'read.job', {})).resolves.toBe('ok');
      expect(candidate.request).toHaveBeenCalledTimes(1);
      old.emit(6); // old event delivery is detached immediately at promotion
      candidate.emit(6);
      expect(events).toEqual([3, 5, 6]);
      finishMutation('once');
      await expect(mutation).resolves.toBe('once');
      expect(old.close).toHaveBeenCalledTimes(1);
      old.admission.onClosed?.(target.enrollmentId);
      expect(pool.hasHealthyPush(target.enrollmentId)).toBe(true);
      expect(old.request).toHaveBeenCalledTimes(1);
    } finally {
      release();
      pool.stop();
    }
  });

  it('cancels preparation when demand ends and disposes late results', async () => {
    const target = migrationHost();
    const sessions: FakeStream[] = [];
    let finish!: () => void;
    const connect = vi.fn(async (next: MeshMachineHost, admission: FakeStream['admission']) => {
      const stream = fakeStream(next, admission);
      sessions.push(stream);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return stream.connection;
    });
    const pool = new MeshHostRuntimePool(context, { discover: async () => [target], connect });
    const release = pool.retain(target.enrollmentId);
    try {
      await vi.waitFor(() => expect(sessions).toHaveLength(1));
      release();
      expect(sessions[0]!.admission.signal?.aborted).toBe(true);
      finish();
      await vi.waitFor(() => expect(sessions[0]!.close).toHaveBeenCalled());
      expect(pool.hasHealthyPush(target.enrollmentId)).toBe(false);
    } finally {
      pool.stop();
    }
  });

  it('fences backend/account replacement and never forwards stale events', async () => {
    const target = migrationHost();
    const sessions: FakeStream[] = [];
    let current = context();
    const onEvent = vi.fn();
    const pool = new MeshHostRuntimePool(() => ({ ...current, onEvent }), {
      discover: async () => [target],
      connect: async (next, admission) => {
        const stream = fakeStream(next, admission);
        sessions.push(stream);
        return stream.connection;
      },
    });
    pool.retain(target.enrollmentId);
    try {
      await vi.waitFor(() => expect(pool.hasHealthyPush(target.enrollmentId)).toBe(true));
      current = { ...context(), apiUrl: 'https://another.test/v1/' };
      sessions[0]!.emit(1);
      expect(onEvent).not.toHaveBeenCalled();
      expect(sessions[0]!.close).toHaveBeenCalled();
      expect(pool.hasActiveDemand()).toBe(false);
    } finally {
      pool.stop();
    }
  });

  it('coalesces a route hint received during discovery into a subsequent fetch', async () => {
    let finish!: (hosts: MeshMachineHost[]) => void;
    const discover = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<MeshMachineHost[]>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue([]);
    const pool = new MeshHostRuntimePool(context, { discover, connect: vi.fn() });
    try {
      const first = pool.refresh();
      const second = pool.refresh();
      finish([]);
      await Promise.all([first, second]);
      expect(discover).toHaveBeenCalledTimes(2);
    } finally {
      pool.stop();
    }
  });
});
