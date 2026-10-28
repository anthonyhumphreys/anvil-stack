import type { CompanionEndpoint } from './companion';
import type { MeshMachineRoute } from './machine';

export type MeshNetworkKind = NonNullable<MeshMachineRoute['networkKind']>;
export type MeshMachineRoutePath = 'direct' | 'private-network' | 'https' | 'managed';

/** Unknown hints must never promote a private route to LAN priority. */
export function normalizeMeshNetworkKind(value: unknown): MeshNetworkKind | undefined {
  return value === 'lan' || value === 'private-network' || value === 'loopback' ? value : undefined;
}

function canonicalHostname(value: string): string {
  const hostname = value
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  try {
    return new URL(
      `http://${hostname.includes(':') ? `[${hostname}]` : hostname}`,
    ).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return hostname;
  }
}

export function isMeshLoopbackHost(value: string): boolean {
  const hostname = canonicalHostname(value);
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '::1' ||
    /^127\./.test(hostname) ||
    /^::ffff:7f[0-9a-f]{2}:/.test(hostname)
  );
}

/** The shared address range is an overlay hint, not a claim that Tailscale is installed. */
export function isMeshSharedAddress(value: string): boolean {
  const parts = canonicalHostname(value).split('.').map(Number);
  return (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    parts[0] === 100 &&
    parts[1]! >= 64 &&
    parts[1]! <= 127
  );
}

function isPrivateHostname(value: string): boolean {
  const hostname = canonicalHostname(value);
  if (isMeshLoopbackHost(hostname) || hostname.endsWith('.local')) return true;
  if (hostname.includes(':')) return /^(?:fc|fd)[0-9a-f]{2}:|^fe80:/.test(hostname);
  const parts = hostname.split('.').map(Number);
  if (
    parts.length !== 4 ||
    !parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  )
    return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254) ||
    isMeshSharedAddress(hostname)
  );
}

type RoutePreference = Pick<MeshMachineRoute, 'kind' | 'networkKind' | 'url'>;

function hasConservativeLanHint(route: RoutePreference): boolean {
  if (route.kind !== 'private' || normalizeMeshNetworkKind(route.networkKind) !== 'lan')
    return false;
  try {
    const url = new URL(route.url);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/' &&
      isPrivateHostname(url.hostname) &&
      !isMeshLoopbackHost(url.hostname) &&
      !isMeshSharedAddress(url.hostname)
    );
  } catch {
    return false;
  }
}

export function meshMachineRouteRank(route: RoutePreference): number {
  if (route.kind === 'managed') return 3;
  if (route.kind === 'https') return 2;
  return hasConservativeLanHint(route) ? 0 : 1;
}

export function meshMachineRoutePath(route: RoutePreference): MeshMachineRoutePath {
  if (route.kind === 'managed') return 'managed';
  if (route.kind === 'https') return 'https';
  return hasConservativeLanHint(route) ? 'direct' : 'private-network';
}

/** Preserves an explicit conservative hint while handling older companion advertisements. */
export function meshNetworkKindForEndpoint(
  endpoint: CompanionEndpoint,
): MeshNetworkKind | undefined {
  if (isMeshLoopbackHost(endpoint.host)) return 'loopback';
  if (endpoint.kind === 'loopback') return undefined;
  if (endpoint.meshNetworkKind === 'unknown') return undefined;
  const explicit = normalizeMeshNetworkKind(endpoint.meshNetworkKind);
  if (explicit === 'loopback') return undefined;
  if (explicit === 'lan' && (endpoint.kind === 'tailscale' || isMeshSharedAddress(endpoint.host)))
    return undefined;
  if (explicit !== undefined) return explicit;
  return endpoint.kind === 'tailscale' && isMeshSharedAddress(endpoint.host)
    ? 'private-network'
    : undefined;
}

export type MeshPrivateRouteAdvertisement = Pick<MeshMachineRoute, 'kind' | 'url' | 'networkKind'>;

/** The same normalized effective routes drive discovery and change notifications. */
export function meshMachinePrivateRoutes(
  endpoints: readonly CompanionEndpoint[],
): MeshPrivateRouteAdvertisement[] {
  const routes = new Map<string, MeshPrivateRouteAdvertisement>();
  for (const endpoint of endpoints) {
    if (
      endpoint.kind === 'loopback' ||
      endpoint.host.length > 253 ||
      endpoint.host.includes('://') ||
      endpoint.host.includes('/') ||
      !Number.isInteger(endpoint.port) ||
      endpoint.port < 1 ||
      endpoint.port > 65535
    )
      continue;
    try {
      const url = new URL(`http://${endpoint.host}:${endpoint.port}`);
      if (
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        isMeshLoopbackHost(url.hostname) ||
        !isPrivateHostname(url.hostname)
      )
        continue;
      const networkKind = meshNetworkKindForEndpoint(endpoint);
      const route: MeshPrivateRouteAdvertisement = {
        kind: 'private',
        url: url.origin,
        ...(networkKind === undefined ? {} : { networkKind }),
      };
      const existing = routes.get(route.url);
      // Conflicting duplicate hints resolve conservatively and independently of input order.
      if (existing !== undefined && existing.networkKind !== route.networkKind) {
        routes.set(route.url, { kind: 'private', url: route.url });
      } else {
        routes.set(route.url, route);
      }
    } catch {
      // Unsafe origins are not dialable machine routes.
    }
  }
  return [...routes.values()].sort((left, right) => left.url.localeCompare(right.url));
}
