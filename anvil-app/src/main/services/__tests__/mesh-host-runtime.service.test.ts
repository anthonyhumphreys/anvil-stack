import { describe, expect, it, vi } from 'vitest';
import type { MeshMachineHost } from '../../../../cloud/contract/machine.js';
import {
  MeshHostRuntimePool,
  type MeshHostRuntimeDependencies,
  type MeshHostRuntimeContext,
} from '../mesh-host-runtime.service.js';
import type { MeshMachineSessionConnection } from '../mesh-host-client.service.js';

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
    const connect = vi.fn(async () => connection);
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
});
