import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SharedPollingCache } from '../shared-polling-cache';

let windowStub: EventTarget;
let documentStub: EventTarget & { hidden: boolean };

beforeEach(() => {
  vi.useFakeTimers();
  windowStub = new EventTarget();
  documentStub = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('window', windowStub);
  vi.stubGlobal('document', documentStub);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('shared polling cache', () => {
  it('shares one request and stops timers and late updates after the last view leaves', async () => {
    const cache = new SharedPollingCache();
    let resolveLoad!: (value: string[]) => void;
    const load = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const firstSnapshots: Array<string[] | undefined> = [];
    const secondSnapshots: Array<string[] | undefined> = [];
    const options = { pollIntervalMs: 1_000, maxAgeMs: 1_000, maxStaleMs: 2_000 };
    const stopFirst = cache.subscribe(
      'trusted-devices',
      load,
      (snapshot) => firstSnapshots.push(snapshot.value),
      options,
    );
    const stopSecond = cache.subscribe(
      'trusted-devices',
      load,
      (snapshot) => secondSnapshots.push(snapshot.value),
      options,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledOnce();
    stopFirst();
    stopSecond();
    expect(vi.getTimerCount()).toBe(0);

    resolveLoad(['enrollment-1']);
    await Promise.resolve();
    await Promise.resolve();

    expect(firstSnapshots).not.toContainEqual(['enrollment-1']);
    expect(secondSnapshots).not.toContainEqual(['enrollment-1']);
  });

  it('expires a trusted roster at its maximum age and refreshes when focus returns', async () => {
    const cache = new SharedPollingCache();
    const load = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(['enrollment-1'])
      .mockRejectedValue(new Error('backend unavailable'));
    const snapshots: Array<string[] | undefined> = [];
    const stop = cache.subscribe(
      'trusted-devices',
      load,
      (snapshot) => snapshots.push(snapshot.value),
      { pollIntervalMs: 1_000, maxAgeMs: 1_000, maxStaleMs: 2_500 },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).toContainEqual(['enrollment-1']);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(snapshots).toContain(undefined);

    load.mockResolvedValueOnce(['enrollment-2']);
    windowStub.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).toContainEqual(['enrollment-2']);
    expect(load).toHaveBeenCalledTimes(5);

    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes only while visible and retries after an online event', async () => {
    const cache = new SharedPollingCache();
    const load = vi.fn().mockResolvedValue('ready');
    const stop = cache.subscribe('settings', load, () => undefined, {
      pollIntervalMs: 60_000,
      maxAgeMs: 60_000,
      maxStaleMs: 120_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledOnce();

    documentStub.hidden = true;
    documentStub.dispatchEvent(new Event('visibilitychange'));
    windowStub.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledOnce();

    documentStub.hidden = false;
    documentStub.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);

    stop();
  });

  it('coalesces pushed refreshes inside the configured minimum interval', async () => {
    const cache = new SharedPollingCache();
    const load = vi.fn().mockResolvedValue('ready');
    const stop = cache.subscribe('mesh-job', load, () => undefined, {
      pollIntervalMs: 60_000,
      maxAgeMs: 60_000,
      maxStaleMs: 120_000,
    });
    await vi.advanceTimersByTimeAsync(0);

    await cache.refresh('mesh-job', 2_000);
    expect(load).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    await cache.refresh('mesh-job', 2_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);

    stop();
  });
});
