import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeshMachineHost } from '../../../../cloud/contract/machine.js';
import type { MeshMachineSessionConnection } from '../mesh-host-client.service.js';
import {
  MeshHostRuntimePool,
  type MeshHostRuntimeContext,
  type MeshHostRuntimeDependencies,
  type MeshHostRuntimeOptions,
} from '../mesh-host-runtime.service.js';

type Admission = Parameters<MeshHostRuntimeDependencies['connect']>[1];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function stream(target: MeshMachineHost, admission: Admission, sequence: number) {
  const ready = deferred<MeshMachineSessionConnection>();
  const cursor = { epoch: 'stream-epoch', sequence };
  let open = true;
  const close = vi.fn(() => {
    open = false;
  });
  const request = vi.fn(async () => 'result');
  const connection = {
    routeKind: target.routes[0]!.kind,
    route: target.routes[0],
    supportsHandoff: true,
    get streamCursor() {
      return { ...cursor };
    },
    get isOpen() {
      return open;
    },
    close,
    request,
  } as unknown as MeshMachineSessionConnection;
  return {
    admission,
    cursor,
    close,
    request,
    connection,
    ready: ready.promise,
    complete: () => ready.resolve(connection),
    emit(sequence: number, payload: unknown = {}) {
      cursor.sequence = sequence;
      admission.onEvent?.({
        enrollmentId: target.enrollmentId,
        epoch: cursor.epoch,
        sequence,
        workspaceId: 'workspace',
        eventKind: 'activity',
        payload,
      });
    },
    ended(reason: string) {
      open = false;
      admission.onClosed?.(target.enrollmentId, reason);
    },
  };
}

type Stream = ReturnType<typeof stream>;
const pools: MeshHostRuntimePool[] = [];

function harness(options: MeshHostRuntimeOptions & { initialCheckpoint?: number } = {}) {
  const target: MeshMachineHost = {
    enrollmentId: 'target-enrollment',
    machineId: 'target-machine',
    endpointGeneration: 'generation-1',
    protocolVersion: 1,
    capabilities: ['machine.session/1', 'machine.stream/1', 'machine.stream-handoff/1'],
    operations: ['read.job', 'command.steer'],
    online: true,
    lastSeenAt: new Date().toISOString(),
    reachableUntil: new Date(Date.now() + 60_000).toISOString(),
    routes: [
      {
        kind: 'managed',
        url: 'https://managed.test',
        machineId: 'target-machine',
        endpointGeneration: 'generation-1',
        reachableUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
    allocationState: 'ready',
  };
  const onEvent = vi.fn<NonNullable<MeshHostRuntimeContext['onEvent']>>();
  const onConnectivityChanged = vi.fn();
  let context: MeshHostRuntimeContext = {
    apiUrl: 'https://backend.test/v1/',
    accessToken: 'device-token',
    accountId: 'account-1',
    enrollmentId: 'source-enrollment',
    workspaceIds: ['workspace'],
    onEvent,
    onConnectivityChanged,
  };
  const sessions: Stream[] = [];
  const connect = vi.fn((host: MeshMachineHost, admission: Admission) => {
    const next = stream(
      host,
      admission,
      admission.resumeCursor?.sequence ?? options.initialCheckpoint ?? 0,
    );
    sessions.push(next);
    if (sessions.length === 1) next.complete();
    return next.ready;
  });
  const pool = new MeshHostRuntimePool(
    () => context,
    { discover: async () => [target], connect },
    { random: () => 0, dwellMs: 0, ...options },
  );
  pools.push(pool);
  return {
    target,
    pool,
    sessions,
    connect,
    onEvent,
    onConnectivityChanged,
    release: pool.retain(target.enrollmentId),
    replaceContext(next: Partial<MeshHostRuntimeContext>) {
      context = { ...context, ...next };
    },
    async prepareLan() {
      target.routes.push({
        ...target.routes[0]!,
        kind: 'private',
        networkKind: 'lan',
        url: 'http://192.168.50.20:47631',
      });
      await pool.refresh();
      await settle();
      expect(sessions).toHaveLength(2);
      return sessions[1]!;
    },
  };
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-27T12:00:00Z'));
});
afterEach(() => {
  for (const pool of pools.splice(0)) pool.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Mesh migration lifecycle races', () => {
  it.each(['account replacement', 'stop'] as const)(
    'stops replay and status publication after %s from the first buffered callback',
    async (change) => {
      const test = harness();
      await settle();
      const candidate = await test.prepareLan();
      candidate.emit(1);
      candidate.emit(2);
      const replacementEvents = vi.fn();
      const replacementStatus = vi.fn();
      test.onEvent.mockImplementationOnce(() => {
        if (change === 'stop') test.pool.stop();
        test.replaceContext({
          accountId: 'account-2',
          onEvent: replacementEvents,
          onConnectivityChanged: replacementStatus,
        });
      });
      test.onConnectivityChanged.mockClear();
      candidate.complete();
      await settle();

      expect(test.onEvent.mock.calls.map(([event]) => event.sequence)).toEqual([1]);
      expect(replacementEvents).not.toHaveBeenCalled();
      expect(replacementStatus).not.toHaveBeenCalled();
      expect(test.onConnectivityChanged).not.toHaveBeenCalled();
      expect(candidate.close).toHaveBeenCalled();
      expect(test.sessions[0]!.close).toHaveBeenCalled();
      expect(test.pool.hasHealthyPush(test.target.enrollmentId)).toBe(false);
    },
  );

  it('fences a read and mutation which resolve after an unobserved account change', async () => {
    const test = harness();
    await settle();
    const readResult = deferred<string>();
    const mutationResult = deferred<string>();
    const active = test.sessions[0]!;
    active.request
      .mockImplementationOnce(() => readResult.promise)
      .mockImplementationOnce(() => mutationResult.promise);
    const read = test.pool.request(test.target.enrollmentId, 'read.job', {});
    const mutation = test.pool.request(test.target.enrollmentId, 'command.steer', {}, 'stable-id');
    const uncertain = expect(mutation).rejects.toThrow('mesh-host-request-uncertain');
    await settle();
    expect(active.request).toHaveBeenCalledTimes(2);

    test.replaceContext({ accountId: 'account-2' });
    // Do not call statuses/stop or deliver an event: the response itself must enforce the fence.
    readResult.resolve('old-account-data');
    mutationResult.resolve('old-account-command-result');
    await expect(read).resolves.toBeNull();
    await uncertain;
    expect(active.close).toHaveBeenCalled();
    expect(test.connect).toHaveBeenCalledTimes(1);
  });

  it('migrates a quiet filtered stream using its authenticated checkpoint', async () => {
    const test = harness({ initialCheckpoint: 41 });
    await settle();
    const candidate = await test.prepareLan();
    expect(candidate.admission.resumeCursor).toEqual({ epoch: 'stream-epoch', sequence: 41 });
    expect(candidate.admission.workspaceIds).toEqual(['workspace']);
    candidate.complete();
    await settle();

    expect(test.pool.statuses()).toMatchObject([{ state: 'live', path: 'direct' }]);
    expect(test.onEvent).not.toHaveBeenCalled();
    expect(test.sessions[0]!.close).toHaveBeenCalledTimes(1);
    expect(candidate.close).not.toHaveBeenCalled();
  });

  it('rejects an obsolete network candidate even when it completes after the new winner', async () => {
    const test = harness();
    await settle();
    const obsolete = await test.prepareLan();
    obsolete.emit(1);
    test.pool.networkChanged();
    await settle();
    expect(obsolete.admission.signal?.aborted).toBe(true);
    expect(test.sessions).toHaveLength(3);
    const winner = test.sessions[2]!;
    winner.complete();
    await settle();
    obsolete.complete();
    obsolete.emit(2);
    obsolete.ended('machine-session-expired');
    await settle();

    expect(obsolete.close).toHaveBeenCalled();
    expect(winner.close).not.toHaveBeenCalled();
    expect(test.onEvent).not.toHaveBeenCalled();
    await expect(test.pool.request(test.target.enrollmentId, 'read.job', {})).resolves.toBe(
      'result',
    );
    expect(winner.request).toHaveBeenCalledTimes(1);
    expect(test.pool.statuses()).toMatchObject([{ state: 'live', path: 'direct' }]);
  });

  it('cancels preparation when the kill switch changes and preserves the working tunnel', async () => {
    let enabled = true;
    const test = harness({ upgradesEnabled: () => enabled });
    await settle();
    const candidate = await test.prepareLan();
    enabled = false;
    await test.pool.refresh();
    expect(candidate.admission.signal?.aborted).toBe(true);
    candidate.complete();
    await settle();

    expect(candidate.close).toHaveBeenCalled();
    expect(test.sessions[0]!.close).not.toHaveBeenCalled();
    expect(test.pool.statuses()).toMatchObject([{ state: 'live', path: 'managed' }]);
    await test.pool.refresh();
    expect(test.connect).toHaveBeenCalledTimes(2);
  });

  it('cancels preparation and all periodic work when the final retainer releases', async () => {
    const test = harness();
    await settle();
    const candidate = await test.prepareLan();
    test.release();
    expect(candidate.admission.signal?.aborted).toBe(true);
    candidate.complete();
    await settle();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(candidate.close).toHaveBeenCalled();
    expect(test.sessions[0]!.close).toHaveBeenCalledTimes(1);
    expect(test.pool.hasActiveDemand()).toBe(false);
    expect(test.pool.hasHealthyPush(test.target.enrollmentId)).toBe(false);
    expect(test.connect).toHaveBeenCalledTimes(2);
  });

  it('cancels proactive preparation on final release while preserving a pending mutation', async () => {
    const test = harness();
    await settle();
    const old = test.sessions[0]!;
    const result = deferred<string>();
    old.request.mockImplementationOnce(() => result.promise);
    const mutation = test.pool.request(test.target.enrollmentId, 'command.steer', {}, 'once');
    await settle();
    const candidate = await test.prepareLan();
    test.release();

    expect(candidate.admission.signal?.aborted).toBe(true);
    expect(old.close).not.toHaveBeenCalled();
    candidate.complete();
    await settle();
    expect(candidate.close).toHaveBeenCalled();
    result.resolve('completed-once');
    await expect(mutation).resolves.toBe('completed-once');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(old.close).toHaveBeenCalledTimes(1);
    expect(test.connect).toHaveBeenCalledTimes(2);
    expect(candidate.request).not.toHaveBeenCalled();
  });

  it.each(['event count', 'event bytes'] as const)(
    'discards candidate replay at the %s bound without advancing the application cursor',
    async (limit) => {
      const test = harness();
      await settle();
      const candidate = await test.prepareLan();
      if (limit === 'event count') {
        for (let sequence = 1; sequence <= 512; sequence += 1) candidate.emit(sequence);
        expect(candidate.admission.signal?.aborted).toBe(false);
        candidate.emit(513);
      } else candidate.emit(1, { text: 'x'.repeat(2 * 1024 * 1024) });

      expect(candidate.admission.signal?.aborted).toBe(true);
      candidate.complete();
      await settle();
      expect(candidate.close).toHaveBeenCalled();
      expect(test.onEvent).not.toHaveBeenCalled();
      test.sessions[0]!.emit(1);
      expect(test.onEvent.mock.calls.map(([event]) => event.sequence)).toEqual([1]);
      expect(test.pool.statuses()).toMatchObject([{ state: 'live', path: 'managed' }]);
      expect(test.sessions[0]!.close).not.toHaveBeenCalled();
    },
  );

  it('keeps an authorized active stream when candidate replay needs a snapshot', async () => {
    const test = harness();
    const resnapshot = vi.fn();
    test.replaceContext({ onResnapshotRequired: resnapshot });
    await settle();
    const candidate = await test.prepareLan();
    candidate.admission.onResnapshotRequired?.({
      enrollmentId: test.target.enrollmentId,
      reason: 'cursor-expired',
    });
    expect(candidate.admission.signal?.aborted).toBe(true);
    candidate.complete();
    await settle();

    expect(resnapshot).not.toHaveBeenCalled();
    expect(candidate.close).toHaveBeenCalled();
    expect(test.sessions[0]!.close).not.toHaveBeenCalled();
    expect(test.pool.statuses()).toMatchObject([{ state: 'live', path: 'managed' }]);
  });

  it.each(['authentication', 'catch-up'] as const)(
    'bounds the complete preparation deadline during %s',
    async (stage) => {
      const test = harness({ preparationTimeoutMs: 100 });
      await settle();
      test.sessions[0]!.emit(5);
      const candidate = await test.prepareLan();
      if (stage === 'catch-up') {
        candidate.cursor.sequence = 4;
        candidate.complete();
        await settle();
      }
      await vi.advanceTimersByTimeAsync(100);
      if (stage === 'authentication') candidate.complete();
      await settle();

      expect(candidate.close).toHaveBeenCalled();
      expect(test.sessions[0]!.close).not.toHaveBeenCalled();
      expect(test.pool.statuses()).toMatchObject([{ state: 'live', path: 'managed' }]);
      expect(test.pool.statuses()[0]?.migration).toBeUndefined();
      await expect(test.pool.request(test.target.enrollmentId, 'read.job', {})).resolves.toBe(
        'result',
      );
    },
  );

  it('keeps the winner when the draining session expires without replaying its mutation', async () => {
    const test = harness();
    await settle();
    const old = test.sessions[0]!;
    const result = deferred<string>();
    old.request.mockImplementationOnce(() => result.promise);
    const mutation = test.pool.request(test.target.enrollmentId, 'command.steer', {}, 'once');
    const uncertain = expect(mutation).rejects.toThrow('mesh-host-request-uncertain');
    await settle();
    const candidate = await test.prepareLan();
    candidate.complete();
    await settle();
    expect(test.pool.statuses()[0]?.migration).toBe('draining');
    expect(old.close).not.toHaveBeenCalled();

    old.ended('machine-session-expired');
    result.resolve('late-result');
    await uncertain;
    await expect(test.pool.request(test.target.enrollmentId, 'read.job', {})).resolves.toBe(
      'result',
    );
    expect(test.pool.statuses()).toMatchObject([{ state: 'live', path: 'direct' }]);
    expect(test.pool.statuses()[0]?.migration).toBeUndefined();
    expect(candidate.close).not.toHaveBeenCalled();
    expect(old.request).toHaveBeenCalledTimes(1);
    expect(candidate.request).toHaveBeenCalledTimes(1);
    expect(candidate.request).toHaveBeenCalledWith('read.job', {}, undefined);
  });

  it.each(['initial promotion', 'event-driven catch-up'] as const)(
    'requests a snapshot and reconnects when event delivery throws during %s',
    async (stage) => {
      const test = harness();
      const resnapshot = vi.fn();
      test.replaceContext({ onResnapshotRequired: resnapshot });
      await settle();
      const old = test.sessions[0]!;
      if (stage === 'event-driven catch-up') old.emit(5);
      const mutationResult = deferred<string>();
      old.request.mockImplementationOnce(() => mutationResult.promise);
      const mutation = test.pool.request(test.target.enrollmentId, 'command.steer', {}, 'once');
      const uncertain = expect(mutation).rejects.toThrow('mesh-host-request-uncertain');
      await settle();
      const candidate = await test.prepareLan();
      test.onEvent.mockClear();
      test.onEvent.mockImplementationOnce(() => {
        throw new Error('consumer failed after partial application');
      });
      if (stage === 'initial promotion') {
        candidate.emit(1);
        candidate.emit(2);
        candidate.complete();
      } else {
        candidate.cursor.sequence = 4;
        candidate.complete();
        await settle();
        expect(() => candidate.emit(6)).not.toThrow();
      }
      await settle();

      expect(resnapshot).toHaveBeenCalledExactlyOnceWith({
        enrollmentId: test.target.enrollmentId,
        reason: 'delivery-failed',
      });
      expect(test.onEvent).toHaveBeenCalledTimes(1);
      expect(old.close).toHaveBeenCalled();
      expect(candidate.close).toHaveBeenCalled();
      mutationResult.resolve('late-command-result');
      await uncertain;
      expect(old.request).toHaveBeenCalledTimes(1);
      expect(candidate.request).not.toHaveBeenCalled();
      expect(test.pool.hasHealthyPush(test.target.enrollmentId)).toBe(false);
      expect(test.pool.statuses()).toMatchObject([
        { state: 'degraded', lastError: 'event-delivery-failed' },
      ]);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(test.sessions).toHaveLength(3);
      const recovery = test.sessions[2]!;
      expect(recovery.admission.resumeCursor).toBeUndefined();
      recovery.complete();
      await settle();
      await expect(test.pool.request(test.target.enrollmentId, 'read.job', {})).resolves.toBe(
        'result',
      );
      expect(recovery.request).toHaveBeenCalledTimes(1);
    },
  );

  it('isolates throwing connectivity observers throughout connection and promotion', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const test = harness();
    test.onConnectivityChanged.mockImplementation(() => {
      throw new Error('status observer unavailable');
    });
    await settle();
    expect(test.pool.hasHealthyPush(test.target.enrollmentId)).toBe(true);
    const candidate = await test.prepareLan();
    candidate.complete();
    await settle();

    expect(test.pool.statuses()).toMatchObject([{ state: 'live', path: 'direct' }]);
    expect(test.sessions[0]!.close).toHaveBeenCalledTimes(1);
    expect(candidate.close).not.toHaveBeenCalled();
    expect(() => candidate.emit(1)).not.toThrow();
    expect(test.onEvent).toHaveBeenCalledTimes(1);
    await expect(test.pool.request(test.target.enrollmentId, 'read.job', {})).resolves.toBe(
      'result',
    );
    expect(warning).toHaveBeenCalledWith('[Mesh] Host connectivity observer failed.');
  });

  it('keeps recovery scheduled even when the resnapshot observer also throws', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const test = harness();
    const resnapshot = vi.fn(() => {
      throw new Error('resnapshot observer unavailable');
    });
    test.replaceContext({ onResnapshotRequired: resnapshot });
    await settle();
    test.onEvent.mockImplementationOnce(() => {
      throw new Error('event consumer unavailable');
    });
    expect(() => test.sessions[0]!.emit(1)).not.toThrow();
    expect(resnapshot).toHaveBeenCalledTimes(1);
    expect(test.pool.statuses()).toMatchObject([
      { state: 'degraded', lastError: 'event-delivery-failed' },
    ]);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(test.sessions).toHaveLength(2);
    const recovery = test.sessions[1]!;
    expect(recovery.admission.resumeCursor).toBeUndefined();
    recovery.complete();
    await settle();
    expect(test.pool.hasHealthyPush(test.target.enrollmentId)).toBe(true);
    expect(warning).toHaveBeenCalledWith('[Mesh] Host resnapshot observer failed.');
  });

  it('does not throw through the socket callback when a catch-up event stops the pool', async () => {
    const test = harness();
    await settle();
    test.sessions[0]!.emit(5);
    const candidate = await test.prepareLan();
    candidate.cursor.sequence = 4;
    candidate.complete();
    await settle();
    test.onEvent.mockImplementationOnce(() => test.pool.stop());

    expect(() => candidate.emit(6)).not.toThrow();
    await settle();
    expect(test.sessions[0]!.close).toHaveBeenCalled();
    expect(candidate.close).toHaveBeenCalled();
    expect(test.pool.hasActiveDemand()).toBe(false);
    expect(test.pool.hasHealthyPush(test.target.enrollmentId)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.connect).toHaveBeenCalledTimes(2);
  });
});
