import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeshMachineRoute } from './machine.js';
import { boundedMeshOperation, connectMeshRoutes } from './machine-route-connect.js';

function route(kind: 'lan' | 'managed', index = 1): MeshMachineRoute {
  return {
    kind: kind === 'lan' ? 'private' : 'managed',
    ...(kind === 'lan' ? { networkKind: 'lan' as const } : {}),
    url: kind === 'lan' ? `http://192.168.1.${index}:47631` : 'https://managed.test',
    machineId: 'host',
    endpointGeneration: 'generation',
    reachableUntil: new Date(Date.now() + 60_000).toISOString(),
  };
}
afterEach(() => vi.useRealTimers());

describe('bounded Mesh route connections', () => {
  it('reserves fallback capacity while many LAN interfaces blackhole', async () => {
    vi.useFakeTimers();
    const attempts: MeshMachineRoute[] = [];
    const probeSignals: AbortSignal[] = [];
    const connect = vi.fn(async (candidate: MeshMachineRoute) => candidate.url);
    const work = connectMeshRoutes({
      routes: [...Array.from({ length: 8 }, (_, i) => route('lan', i + 1)), route('managed')],
      probe: async (candidate, signal) => {
        attempts.push(candidate);
        probeSignals.push(signal);
        if (candidate.kind === 'managed') return true;
        return new Promise<boolean>(() => undefined);
      },
      connect,
      dispose: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(attempts).toHaveLength(2);
    expect(connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(work).resolves.toBe('https://managed.test');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(probeSignals.slice(0, 2).every((signal) => signal.aborted)).toBe(true);
  });

  it('does not allocate sessions for other routes when a preferred route authenticates', async () => {
    const connect = vi.fn(async (candidate: MeshMachineRoute) => candidate.url);
    await expect(
      connectMeshRoutes({
        routes: [route('managed'), route('lan')],
        probe: async () => true,
        connect,
        dispose: vi.fn(),
      }),
    ).resolves.toContain('192.168');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0]?.[0].networkKind).toBe('lan');
  });

  it('authenticates candidates serially and closes a late aborted session', async () => {
    vi.useFakeTimers();
    let finish!: (value: string) => void;
    const disposed: string[] = [];
    const connect = vi.fn((candidate: MeshMachineRoute) =>
      candidate.kind === 'private'
        ? new Promise<string>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve('fallback'),
    );
    const work = connectMeshRoutes({
      routes: [route('lan'), route('managed')],
      probe: async () => true,
      connect,
      dispose: (value) => disposed.push(value),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(19_000);
    await expect(work).resolves.toBe('fallback');
    finish('abandoned');
    await vi.advanceTimersByTimeAsync(0);
    expect(disposed).toEqual(['abandoned']);
  });

  it('cancels every stage and ignores late probe success', async () => {
    const controller = new AbortController();
    let finish!: (value: boolean) => void;
    const connect = vi.fn(async () => 'session');
    const work = connectMeshRoutes({
      routes: [route('lan')],
      signal: controller.signal,
      probe: () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
      connect,
      dispose: vi.fn(),
    });
    const rejected = expect(work).rejects.toThrow('cancel');
    await vi.waitFor(() => expect(finish).toBeDefined());
    controller.abort(new Error('cancelled'));
    await rejected;
    finish(true);
    await Promise.resolve();
    expect(connect).not.toHaveBeenCalled();
  });

  it('bounds adapters that ignore cancellation and disposes late results', async () => {
    vi.useFakeTimers();
    let finish!: (value: string) => void;
    const dispose = vi.fn();
    const work = boundedMeshOperation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      new AbortController().signal,
      100,
      dispose,
    );
    const rejected = expect(work).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    finish('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(dispose).toHaveBeenCalledWith('late');
  });
});
