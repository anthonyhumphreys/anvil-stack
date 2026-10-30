import type { NetworkInterfaceInfo } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LatestMeshAdvertisementPublisher,
  MeshNetworkMonitor,
  meshAdvertisedInterfaces,
  meshNetworkFingerprint,
} from '../mesh-network.service.js';

function address(value: string, internal = false): NetworkInterfaceInfo {
  return {
    address: value,
    family: 'IPv4',
    netmask: '255.255.255.0',
    mac: '00:00:00:00:00:00',
    cidr: `${value}/24`,
    internal,
  };
}

afterEach(() => vi.useRealTimers());

describe('Mesh interface observation', () => {
  it('ignores OS ordering and duplicate entries but observes addresses and netmasks', () => {
    const first = { en0: [address('192.168.1.2')], utun3: [address('100.64.1.2')] };
    expect(meshNetworkFingerprint(first)).toBe(
      meshNetworkFingerprint({
        utun3: [address('100.64.1.2')],
        en0: [address('192.168.1.2'), address('192.168.1.2')],
        lo0: [address('127.0.0.1', true)],
      }),
    );
    expect(meshNetworkFingerprint(first)).not.toBe(
      meshNetworkFingerprint({
        ...first,
        en0: [{ ...address('192.168.1.2'), netmask: '255.255.0.0' }],
      }),
    );
  });

  it('emits bounded, deterministic hints with conservative unknown and overlay classifications', () => {
    const interfaces = {
      mystery: [address('10.2.0.1')],
      en0: [address('192.168.1.2')],
      utun1: [address('10.0.0.2')],
      en1: [address('100.64.0.2')],
      en2: [address('100.63.255.255'), address('100.128.0.1'), address('8.8.8.8')],
      lo0: [address('127.0.0.1', true)],
    };
    const endpoints = meshAdvertisedInterfaces(47631, interfaces).map((value) => value.endpoint);
    expect(endpoints).toEqual([
      { kind: 'lan', meshNetworkKind: 'lan', host: '192.168.1.2', port: 47631 },
      { kind: 'lan', meshNetworkKind: 'private-network', host: '10.0.0.2', port: 47631 },
      { kind: 'tailscale', meshNetworkKind: 'private-network', host: '100.64.0.2', port: 47631 },
      { kind: 'lan', meshNetworkKind: 'unknown', host: '10.2.0.1', port: 47631 },
      { kind: 'loopback', meshNetworkKind: 'loopback', host: '127.0.0.1', port: 47631 },
    ]);
    expect(
      meshAdvertisedInterfaces(47631, Object.fromEntries(Object.entries(interfaces).reverse())),
    ).toEqual(meshAdvertisedInterfaces(47631, interfaces));
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`en${i}`, [address(`10.1.0.${i + 1}`)]]),
    );
    const bounded = meshAdvertisedInterfaces(47631, many);
    expect(bounded).toHaveLength(8);
    expect(bounded.at(-1)?.endpoint.meshNetworkKind).toBe('loopback');
  });

  it('deduplicates conflicting interface classifications as unknown', () => {
    const interfaces = { en0: [address('10.0.0.2')], utun1: [address('10.0.0.2')] };
    expect(meshAdvertisedInterfaces(47631, interfaces)[0]?.endpoint.meshNetworkKind).toBe(
      'unknown',
    );
    expect(meshAdvertisedInterfaces(47631, interfaces)).toEqual(
      meshAdvertisedInterfaces(47631, Object.fromEntries(Object.entries(interfaces).reverse())),
    );
  });

  it('samples active demand every 15 seconds and debounces changing interfaces for 500ms', async () => {
    vi.useFakeTimers();
    let active = false;
    let interfaces = { en0: [address('192.168.1.2')] };
    const enumerate = vi.fn(() => interfaces);
    const changed = vi.fn();
    const monitor = new MeshNetworkMonitor({
      isActive: () => active,
      interfaces: enumerate,
      onChanged: changed,
    });
    monitor.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(enumerate).not.toHaveBeenCalled();
    active = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(enumerate).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
    interfaces = { en0: [address('192.168.2.2')] };
    monitor.sampleNow();
    await vi.advanceTimersByTimeAsync(300);
    interfaces = { en0: [address('192.168.3.2')] };
    monitor.sampleNow();
    await vi.advanceTimersByTimeAsync(499);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(changed).toHaveBeenCalledTimes(1);
    monitor.sampleNow(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(changed).toHaveBeenCalledTimes(2);
    monitor.sampleNow(true);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a pending change when demand disappears and tolerates enumeration failures', async () => {
    vi.useFakeTimers();
    let active = true;
    const enumerate = vi.fn(() => ({ en0: [address('192.168.1.2')] }));
    const changed = vi.fn();
    const monitor = new MeshNetworkMonitor({
      isActive: () => active,
      interfaces: enumerate,
      onChanged: changed,
    });
    monitor.start();
    enumerate.mockImplementationOnce(() => {
      throw new Error('temporarily unavailable');
    });
    expect(() => monitor.sampleNow()).not.toThrow();
    monitor.sampleNow(true);
    active = false;
    monitor.sampleNow();
    await vi.advanceTimersByTimeAsync(500);
    expect(changed).not.toHaveBeenCalled();
    monitor.stop();
  });
});

describe('latest Mesh advertisement publisher', () => {
  it('serializes concurrent changes and only clears the revision it published', async () => {
    let value = 'first';
    let release: (() => void) | undefined;
    const publish = vi.fn(async (_value: string, _scope: string): Promise<void> => undefined);
    publish.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const publisher = new LatestMeshAdvertisementPublisher({
      scope: () => 'account-a',
      build: () => value,
      publish,
    });
    const first = publisher.request();
    value = 'second';
    const second = publisher.request();
    value = 'latest';
    const latest = publisher.request();
    expect(publish.mock.calls).toEqual([['first', 'account-a']]);
    release?.();
    await Promise.all([first, second, latest]);
    expect(publish.mock.calls).toEqual([
      ['first', 'account-a'],
      ['latest', 'account-a'],
    ]);
    publisher.stop();
  });

  it('retries failures with bounded backoff and rebuilds the latest address set', async () => {
    vi.useFakeTimers();
    let value = 'old';
    const publish = vi.fn(async (_value: string, _scope: string): Promise<void> => {
      throw new Error('offline');
    });
    const publisher = new LatestMeshAdvertisementPublisher({
      scope: () => 'account',
      build: () => value,
      publish,
      retryMs: 100,
      maxRetryMs: 200,
    });
    await publisher.request();
    value = 'latest';
    await vi.advanceTimersByTimeAsync(99);
    expect(publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(publish.mock.calls[1]).toEqual(['latest', 'account']);
    await vi.advanceTimersByTimeAsync(200);
    expect(publish).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(publish).toHaveBeenCalledTimes(4);
    publish.mockResolvedValueOnce(undefined);
    await vi.advanceTimersByTimeAsync(200);
    expect(publish).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
    publisher.stop();
  });

  it('fences old completion and retry work after account replacement or shutdown', async () => {
    vi.useFakeTimers();
    let scope: string | null = 'old-account';
    let release: (() => void) | undefined;
    const publish = vi.fn(async (_value: string, _scope: string): Promise<void> => undefined);
    publish.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const publisher = new LatestMeshAdvertisementPublisher({
      scope: () => scope,
      build: () => 'routes',
      publish,
    });
    const old = publisher.request();
    scope = 'new-account';
    await publisher.request();
    release?.();
    await old;
    expect(publish.mock.calls).toEqual([
      ['routes', 'old-account'],
      ['routes', 'new-account'],
    ]);
    publish.mockRejectedValueOnce(new Error('offline'));
    await publisher.request();
    publisher.stop();
    scope = null;
    await publisher.request();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
