import { describe, expect, it } from 'vitest';
import { validateDeviceAdvertiseParams, type CompanionEndpoint } from './companion';
import {
  isMeshLoopbackHost,
  isMeshSharedAddress,
  meshMachinePrivateRoutes,
  meshMachineRoutePath,
  meshMachineRouteRank,
  meshNetworkKindForEndpoint,
  normalizeMeshNetworkKind,
} from './machine-route-policy';

describe('Mesh route preference and advertisement projection', () => {
  it('ranks explicit LAN hints ahead of other private, HTTPS and managed routes', () => {
    const routes = [
      { kind: 'managed' as const, networkKind: 'lan' as const },
      { kind: 'https' as const },
      { kind: 'private' as const },
      { kind: 'private' as const, networkKind: 'private-network' as const },
      { kind: 'private' as const, networkKind: 'lan' as const },
    ].map((route) => ({ ...route, url: 'http://192.168.1.2:47631' }));
    expect(routes.map(meshMachineRouteRank)).toEqual([3, 2, 1, 1, 0]);
    expect(routes.map(meshMachineRoutePath)).toEqual([
      'managed',
      'https',
      'private-network',
      'private-network',
      'direct',
    ]);
    expect(normalizeMeshNetworkKind('ethernet')).toBeUndefined();
    expect(normalizeMeshNetworkKind('unknown')).toBeUndefined();
  });

  it.each([
    'https://public.example',
    'http://100.64.0.1',
    'http://127.1',
    'file:///tmp/host',
    'http://user@192.168.1.2',
    'http://192.168.1.2/path',
    'invalid',
  ])('does not promote an inconsistent LAN hint for %s', (url) => {
    const route = { kind: 'private' as const, networkKind: 'lan' as const, url };
    expect(meshMachineRouteRank(route)).toBe(1);
    expect(meshMachineRoutePath(route)).toBe('private-network');
  });

  it.each([
    'localhost',
    'host.localhost.',
    '127.0.0.1',
    '127.1',
    '2130706433',
    '::1',
    '[0:0:0:0:0:0:0:1]',
    '::ffff:127.0.0.1',
  ])('recognizes loopback spelling %s', (host) => expect(isMeshLoopbackHost(host)).toBe(true));

  it.each(['localhost.example', '192.168.1.1', '100.64.0.1', 'fd00::1'])(
    'does not classify remote host %s as loopback',
    (host) => expect(isMeshLoopbackHost(host)).toBe(false),
  );

  it('recognizes only the shared 100.64/10 range', () => {
    expect(isMeshSharedAddress('100.64.0.1')).toBe(true);
    expect(isMeshSharedAddress('100.127.255.254')).toBe(true);
    expect(isMeshSharedAddress('100.63.255.254')).toBe(false);
    expect(isMeshSharedAddress('100.128.0.1')).toBe(false);
    expect(isMeshSharedAddress('100.example')).toBe(false);
  });

  it('keeps legacy LAN, explicit unknown and contradictory hints conservative', () => {
    const endpoint: CompanionEndpoint = { kind: 'lan', host: '192.168.1.2', port: 47631 };
    expect(meshNetworkKindForEndpoint(endpoint)).toBeUndefined();
    expect(meshNetworkKindForEndpoint({ ...endpoint, meshNetworkKind: 'lan' })).toBe('lan');
    expect(meshNetworkKindForEndpoint({ ...endpoint, meshNetworkKind: 'unknown' })).toBeUndefined();
    expect(
      meshNetworkKindForEndpoint({ ...endpoint, meshNetworkKind: 'loopback' }),
    ).toBeUndefined();
    expect(meshNetworkKindForEndpoint({ ...endpoint, kind: 'tailscale', host: '100.64.1.2' })).toBe(
      'private-network',
    );
    expect(
      meshNetworkKindForEndpoint({ ...endpoint, host: '100.64.1.2', meshNetworkKind: 'lan' }),
    ).toBeUndefined();
    expect(
      meshNetworkKindForEndpoint({ ...endpoint, kind: 'tailscale', host: '100.128.1.2' }),
    ).toBeUndefined();
  });

  it('projects only safe remote origins, deduplicates and ignores input ordering', () => {
    const endpoints: CompanionEndpoint[] = [
      { kind: 'lan', host: '192.168.1.2', port: 47631, meshNetworkKind: 'lan' },
      { kind: 'tailscale', host: '100.64.1.2', port: 47631 },
      { kind: 'lan', host: '192.168.1.2', port: 47631, meshNetworkKind: 'lan' },
      { kind: 'loopback', host: '127.0.0.1', port: 47631 },
      { kind: 'lan', host: '127.1', port: 47631, meshNetworkKind: 'lan' },
      { kind: 'lan', host: 'user:password@192.168.1.3', port: 47631 },
      { kind: 'lan', host: '100.128.0.1', port: 47631 },
      { kind: 'lan', host: 'host.local/path', port: 47631 },
    ];
    const expected = [
      { kind: 'private', url: 'http://100.64.1.2:47631', networkKind: 'private-network' },
      { kind: 'private', url: 'http://192.168.1.2:47631', networkKind: 'lan' },
    ];
    expect(meshMachinePrivateRoutes(endpoints)).toEqual(expected);
    expect(meshMachinePrivateRoutes([...endpoints].reverse())).toEqual(expected);
  });

  it('does not promote conflicting duplicate route hints', () => {
    const endpoint: CompanionEndpoint = { kind: 'lan', host: '192.168.1.2', port: 47631 };
    const endpoints: CompanionEndpoint[] = [
      { ...endpoint, meshNetworkKind: 'lan' },
      { ...endpoint, meshNetworkKind: 'unknown' },
      { ...endpoint, meshNetworkKind: 'lan' },
    ];
    expect(meshMachinePrivateRoutes(endpoints)).toEqual([
      { kind: 'private', url: 'http://192.168.1.2:47631' },
    ]);
  });

  it('validates optional hints and retains the advertisement endpoint bound', () => {
    const endpoint: CompanionEndpoint = { kind: 'lan', host: '192.168.1.2', port: 47631 };
    for (const meshNetworkKind of ['lan', 'private-network', 'loopback', 'unknown', undefined]) {
      expect(
        validateDeviceAdvertiseParams({
          endpoints: [{ ...endpoint, meshNetworkKind }],
          capabilities: [],
        }),
      ).toBe(true);
    }
    expect(
      validateDeviceAdvertiseParams({
        endpoints: [{ ...endpoint, meshNetworkKind: 'trusted' }],
        capabilities: [],
      }),
    ).toBe(false);
    expect(
      validateDeviceAdvertiseParams({ endpoints: Array(8).fill(endpoint), capabilities: [] }),
    ).toBe(true);
    expect(
      validateDeviceAdvertiseParams({ endpoints: Array(9).fill(endpoint), capabilities: [] }),
    ).toBe(false);
  });
});
