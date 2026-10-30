import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import {
  COMPANION_MAX_ENDPOINTS,
  type CompanionEndpoint,
} from '../../../cloud/contract/companion.js';
import {
  isMeshSharedAddress,
  meshMachinePrivateRoutes,
} from '../../../cloud/contract/machine-route-policy.js';

type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>;
export const MESH_NETWORK_SAMPLE_MS = 15_000;
export const MESH_NETWORK_DEBOUNCE_MS = 500;

/** Order-independent local observation; no interface data leaves this process. */
export function meshNetworkFingerprint(interfaces: Interfaces): string {
  const values = new Set<string>();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      values.add(JSON.stringify([name, entry.family, entry.address, entry.netmask]));
    }
  }
  return [...values].sort().join('\n');
}

export interface MeshAdvertisedInterface {
  name: string;
  endpoint: CompanionEndpoint;
}

/** A conservative preference hint, not a claim about the actual route packets take. */
function classifyInterface(
  name: string,
  address: string,
): NonNullable<CompanionEndpoint['meshNetworkKind']> {
  if (
    isMeshSharedAddress(address) ||
    /^(?:utun|tun|tap|wg|tailscale|vpn|zt|ipsec|ppp)/i.test(name)
  ) {
    return 'private-network';
  }
  if (
    /^(?:en\d+|eth\d+|en[opsx][a-z0-9]+|wl[px][a-z0-9]+|wlan\d+|wi-?fi|ethernet)(?:$|\s)/i.test(
      name,
    )
  ) {
    return 'lan';
  }
  return 'unknown';
}

/** Preserve one explicit local companion endpoint within the shared eight-endpoint limit. */
export function meshAdvertisedInterfaces(
  port: number,
  interfaces: Interfaces = networkInterfaces(),
): MeshAdvertisedInterface[] {
  const addresses = new Map<string, MeshAdvertisedInterface>();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const endpoint: CompanionEndpoint = {
        kind: isMeshSharedAddress(entry.address) ? 'tailscale' : 'lan',
        meshNetworkKind: classifyInterface(name, entry.address),
        host: entry.address,
        port,
      };
      if (meshMachinePrivateRoutes([endpoint]).length === 0) continue;
      const existing = addresses.get(entry.address);
      if (existing === undefined) addresses.set(entry.address, { name, endpoint });
      else if (existing.endpoint.meshNetworkKind !== endpoint.meshNetworkKind) {
        addresses.set(entry.address, {
          name: [name, existing.name].sort()[0]!,
          endpoint: { ...endpoint, meshNetworkKind: 'unknown' },
        });
      } else if (name < existing.name) {
        addresses.set(entry.address, { name, endpoint });
      }
    }
  }
  const rank = (value: MeshAdvertisedInterface): number =>
    value.endpoint.meshNetworkKind === 'lan'
      ? 0
      : value.endpoint.meshNetworkKind === 'private-network'
        ? 1
        : 2;
  const selected = [...addresses.values()]
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        a.endpoint.host.localeCompare(b.endpoint.host) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, COMPANION_MAX_ENDPOINTS - 1);
  selected.push({
    name: 'This Mac',
    endpoint: { kind: 'loopback', meshNetworkKind: 'loopback', host: '127.0.0.1', port },
  });
  return selected;
}

/** Shared desktop/daemon sampler. Inactive clients perform no interface enumeration. */
export class MeshNetworkMonitor {
  private interval: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private fingerprint: string | null = null;

  constructor(
    private readonly dependencies: {
      isActive: () => boolean;
      onChanged: () => void;
      interfaces?: () => Interfaces;
      sampleMs?: number;
      debounceMs?: number;
    },
  ) {}

  start(): void {
    if (this.interval !== null) return;
    this.sampleNow();
    this.interval = setInterval(
      () => this.sampleNow(),
      this.dependencies.sampleMs ?? MESH_NETWORK_SAMPLE_MS,
    );
    this.interval.unref?.();
  }

  sampleNow(force = false): void {
    if (!this.dependencies.isActive()) {
      this.fingerprint = null;
      if (this.debounce !== null) clearTimeout(this.debounce);
      this.debounce = null;
      return;
    }
    let next: string;
    try {
      next = meshNetworkFingerprint((this.dependencies.interfaces ?? networkInterfaces)());
    } catch {
      return;
    }
    const changed = this.fingerprint !== null && next !== this.fingerprint;
    this.fingerprint = next;
    if (!changed && !force) return;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      if (this.dependencies.isActive()) this.dependencies.onChanged();
    }, this.dependencies.debounceMs ?? MESH_NETWORK_DEBOUNCE_MS);
    this.debounce.unref?.();
  }

  stop(): void {
    if (this.interval !== null) clearInterval(this.interval);
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.interval = null;
    this.debounce = null;
    this.fingerprint = null;
  }
}

/** Serial latest-value publishing with generation fencing and bounded retry cadence. */
export class LatestMeshAdvertisementPublisher<T> {
  private generation = 0;
  private scope: string | null = null;
  private revision = 0;
  private publishedRevision = 0;
  private inFlight: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs: number;

  constructor(
    private readonly dependencies: {
      scope: () => string | null;
      build: () => T;
      publish: (payload: T, scope: string) => Promise<unknown>;
      retryMs?: number;
      maxRetryMs?: number;
    },
  ) {
    this.retryMs = dependencies.retryMs ?? 1_000;
  }

  request(): Promise<void> {
    const scope = this.dependencies.scope();
    if (scope !== this.scope) {
      this.stop();
      this.scope = scope;
    }
    if (scope === null) return Promise.resolve();
    this.revision += 1;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    return this.flush();
  }

  stop(): void {
    this.generation += 1;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.inFlight = null;
    this.scope = null;
    this.revision = 0;
    this.publishedRevision = 0;
    this.retryMs = this.dependencies.retryMs ?? 1_000;
  }

  private flush(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const generation = this.generation;
    const scope = this.scope;
    if (scope === null || scope !== this.dependencies.scope()) return Promise.resolve();
    const current = (): boolean =>
      generation === this.generation && scope === this.dependencies.scope();
    const running = (async () => {
      while (current() && this.publishedRevision < this.revision) {
        const revision = this.revision;
        try {
          const payload = this.dependencies.build();
          if (!current()) return;
          await this.dependencies.publish(payload, scope);
          if (!current()) return;
          this.publishedRevision = revision;
          this.retryMs = this.dependencies.retryMs ?? 1_000;
        } catch {
          if (current()) this.scheduleRetry(generation);
          return;
        }
      }
    })().finally(() => {
      if (this.inFlight === running) this.inFlight = null;
    });
    this.inFlight = running;
    return running;
  }

  private scheduleRetry(generation: number): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (generation === this.generation) void this.flush();
    }, this.retryMs);
    this.retryTimer.unref?.();
    this.retryMs = Math.min(this.dependencies.maxRetryMs ?? 30_000, this.retryMs * 2);
  }
}
