import type { MeshMachineHost, MeshMachineOperation } from '../../../cloud/contract/machine.js';
import type { MeshHostConnectionStatus } from '../../shared/sync-runtime.js';
import {
  connectMeshMachineHost,
  fetchMeshMachineHosts,
  safeMachineErrorCode,
  type MeshMachineAdmissionContext,
  type MeshMachineSessionConnection,
} from './mesh-host-client.service.js';

export interface MeshHostRuntimeContext extends Omit<
  MeshMachineAdmissionContext,
  'onEvent' | 'onResnapshotRequired' | 'onClosed'
> {
  onEvent?: MeshMachineAdmissionContext['onEvent'];
  onResnapshotRequired?: MeshMachineAdmissionContext['onResnapshotRequired'];
  onConnectivityChanged?: () => void;
}

export interface MeshHostRuntimeDependencies {
  discover: typeof fetchMeshMachineHosts;
  connect: typeof connectMeshMachineHost;
}

interface HostEntry {
  host: MeshMachineHost;
  connection: MeshMachineSessionConnection | null;
  connecting: Promise<MeshMachineSessionConnection | null> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  activeRequests: number;
  status: MeshHostConnectionStatus;
}

/** Account-scoped direct host pool. Discovery is event-driven; reconnects use bounded jitter. */
export class MeshHostRuntimePool {
  private readonly getContext: () => MeshHostRuntimeContext | null;
  private entries = new Map<string, HostEntry>();
  private retainers = new Map<string, Set<symbol>>();
  private refreshInFlight: Promise<void> | null = null;
  private generation = 0;
  private readonly dependencies: MeshHostRuntimeDependencies;

  constructor(
    getContext: () => MeshHostRuntimeContext | null,
    dependencies: MeshHostRuntimeDependencies = {
      discover: fetchMeshMachineHosts,
      connect: connectMeshMachineHost,
    },
  ) {
    this.getContext = getContext;
    this.dependencies = dependencies;
  }

  start(): void {
    void this.refresh().catch(() => undefined);
  }

  stop(): void {
    this.generation += 1;
    for (const entry of this.entries.values()) {
      if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
      if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
      entry.connection?.close();
    }
    this.entries.clear();
    this.retainers.clear();
    this.refreshInFlight = null;
  }

  statuses(): MeshHostConnectionStatus[] {
    return [...this.entries.values()]
      .map((entry) => ({ ...entry.status, capabilities: [...entry.status.capabilities] }))
      .sort((a, b) => a.enrollmentId.localeCompare(b.enrollmentId));
  }

  hasHealthyPush(enrollmentId: string): boolean {
    const entry = this.entries.get(enrollmentId);
    return entry !== undefined && entry.connection !== null;
  }

  /** Retains one authenticated stream for a live consumer; release closes the last idle consumer. */
  retain(enrollmentId: string): () => void {
    const lease = Symbol(enrollmentId);
    let leases = this.retainers.get(enrollmentId);
    if (leases === undefined) {
      leases = new Set();
      this.retainers.set(enrollmentId, leases);
    }
    leases.add(lease);
    const entry = this.entries.get(enrollmentId);
    if (entry?.idleTimer !== null && entry?.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    void this.ensureConnected(enrollmentId).catch(() => null);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.retainers.get(enrollmentId);
      current?.delete(lease);
      if (current?.size === 0) this.retainers.delete(enrollmentId);
      const currentEntry = this.entries.get(enrollmentId);
      if (currentEntry !== undefined && !this.isRetained(enrollmentId)) {
        if (currentEntry.retryTimer !== null) {
          clearTimeout(currentEntry.retryTimer);
          currentEntry.retryTimer = null;
        }
        if (currentEntry.activeRequests === 0) this.closeIfIdle(currentEntry);
      }
    };
  }

  async request<T = unknown>(
    enrollmentId: string,
    operation: MeshMachineOperation,
    payload: unknown,
    requestId?: string,
  ): Promise<T | null> {
    const connection = await this.ensureConnected(enrollmentId);
    if (connection === null) {
      if (operation.startsWith('read.')) return null;
      throw new Error('mesh-host-route-unavailable');
    }
    const entry = this.entries.get(enrollmentId);
    if (entry !== undefined) {
      entry.activeRequests += 1;
      if (entry.idleTimer !== null) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
    }
    try {
      return await connection.request<T>(operation, payload, requestId);
    } catch {
      if (operation.startsWith('read.')) return null;
      // Once a mutating frame may have been sent, callers must surface the
      // uncertain result and let the durable host receipt resolve it. Falling
      // back here could execute the same intent on another route.
      throw new Error('mesh-host-request-uncertain');
    } finally {
      if (entry !== undefined) {
        entry.activeRequests = Math.max(0, entry.activeRequests - 1);
        if (!this.isRetained(enrollmentId) && entry.activeRequests === 0) {
          this.scheduleIdleClose(entry);
        }
      }
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshInFlight !== null) return this.refreshInFlight;
    const context = this.getContext();
    if (context === null) {
      this.stop();
      return;
    }
    const generation = this.generation;
    this.refreshInFlight = (async () => {
      let hosts: MeshMachineHost[];
      try {
        hosts = await this.dependencies.discover({
          apiUrl: context.apiUrl,
          accessToken: context.accessToken,
          ...(context.fetchFn === undefined ? {} : { fetchFn: context.fetchFn }),
        });
      } catch {
        return;
      }
      if (generation !== this.generation || this.getContext()?.accountId !== context.accountId) return;

      const discovered = new Map(
        hosts
          .filter((host) => host.enrollmentId !== context.enrollmentId)
          .map((host) => [host.enrollmentId, host]),
      );
      for (const [enrollmentId, entry] of this.entries) {
        const host = discovered.get(enrollmentId);
        if (
          host === undefined ||
          host.machineId !== entry.host.machineId ||
          host.endpointGeneration !== entry.host.endpointGeneration
        ) {
          if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
          if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
          entry.connection?.close();
          this.entries.delete(enrollmentId);
        }
      }

      for (const host of discovered.values()) {
        const existing = this.entries.get(host.enrollmentId);
        if (existing !== undefined) {
          existing.host = host;
          if (!host.online || host.routes.length === 0) {
            existing.connection?.close();
            existing.connection = null;
            existing.status = statusFor(host, 'offline');
          }
          continue;
        }
        const entry: HostEntry = {
          host,
          connection: null,
          connecting: null,
          retryTimer: null,
          idleTimer: null,
          activeRequests: 0,
          status: statusFor(host, host.online ? 'degraded' : 'offline'),
        };
        this.entries.set(host.enrollmentId, entry);
      }

      const targets = [...this.entries.values()].filter(
        (entry) =>
          this.isRetained(entry.host.enrollmentId) &&
          entry.host.online &&
          entry.host.routes.length > 0 &&
          entry.connection === null,
      );
      await mapConcurrent(targets, 4, async (entry) => {
        await this.connectEntry(entry, generation);
      });
      context.onConnectivityChanged?.();
    })().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async ensureConnected(enrollmentId: string): Promise<MeshMachineSessionConnection | null> {
    const context = this.getContext();
    if (context === null) return null;
    let entry = this.entries.get(enrollmentId);
    if (entry === undefined) {
      await this.refresh();
      entry = this.entries.get(enrollmentId);
    }
    if (entry === undefined || !entry.host.online || entry.host.routes.length === 0) return null;
    if (entry.connection !== null) return entry.connection;
    return this.connectEntry(entry, this.generation);
  }

  private async connectEntry(
    entry: HostEntry,
    generation: number,
  ): Promise<MeshMachineSessionConnection | null> {
    if (entry.connection !== null) return entry.connection;
    if (entry.connecting !== null) return entry.connecting;
    const context = this.getContext();
    if (context === null) return null;
    entry.status = statusFor(entry.host, 'connecting');
    const connect = this.dependencies.connect(entry.host, {
      apiUrl: context.apiUrl,
      accessToken: context.accessToken,
      accountId: context.accountId,
      enrollmentId: context.enrollmentId,
      ...(context.fetchFn === undefined ? {} : { fetchFn: context.fetchFn }),
      ...(context.socketFactory === undefined ? {} : { socketFactory: context.socketFactory }),
      ...(context.onEvent === undefined ? {} : { onEvent: context.onEvent }),
      ...(context.onResnapshotRequired === undefined
        ? {}
        : { onResnapshotRequired: context.onResnapshotRequired }),
      onClosed: (closedEnrollmentId) => {
        const current = this.entries.get(closedEnrollmentId);
        if (current === undefined || generation !== this.generation) return;
        current.connection = null;
        current.status = statusFor(current.host, 'degraded', 'route-unavailable');
        context.onConnectivityChanged?.();
        if (this.isRetained(closedEnrollmentId)) this.scheduleReconnect(current, generation);
      },
    })
      .then((connection) => {
        if (generation !== this.generation || this.entries.get(entry.host.enrollmentId) !== entry) {
          connection.close();
          return null;
        }
        entry.connection = connection;
        if (entry.idleTimer !== null) {
          clearTimeout(entry.idleTimer);
          entry.idleTimer = null;
        }
        entry.status = statusFor(entry.host, 'live', undefined, connection.routeKind);
        context.onConnectivityChanged?.();
        if (!this.isRetained(entry.host.enrollmentId) && entry.activeRequests === 0) {
          this.scheduleIdleClose(entry);
        }
        return connection;
      })
      .catch((error: unknown) => {
        if (generation === this.generation && this.entries.get(entry.host.enrollmentId) === entry) {
          const code = error instanceof Error && error.message === 'protocol-mismatch'
            ? 'protocol-mismatch'
            : safeMachineErrorCode(error) ?? 'route-unavailable';
          entry.status = statusFor(entry.host, 'degraded', code);
          context.onConnectivityChanged?.();
          if (this.isRetained(entry.host.enrollmentId)) this.scheduleReconnect(entry, generation);
        }
        return null;
      })
      .finally(() => {
        entry.connecting = null;
      });
    entry.connecting = connect;
    return connect;
  }

  private scheduleReconnect(entry: HostEntry, generation: number): void {
    if (entry.retryTimer !== null || !entry.host.online || entry.host.routes.length === 0) return;
    const delay = 25_000 + Math.floor(Math.random() * 10_001);
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      if (generation !== this.generation || this.entries.get(entry.host.enrollmentId) !== entry) return;
      if (this.isRetained(entry.host.enrollmentId)) {
        void this.ensureConnected(entry.host.enrollmentId).catch(() => null);
      }
    }, delay);
    entry.retryTimer.unref?.();
  }

  private isRetained(enrollmentId: string): boolean {
    return (this.retainers.get(enrollmentId)?.size ?? 0) > 0;
  }

  private scheduleIdleClose(entry: HostEntry): void {
    if (entry.idleTimer !== null || entry.connection === null || this.isRetained(entry.host.enrollmentId)) {
      return;
    }
    // A short grace absorbs one-off reads while keeping unused sessions bounded.
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.activeRequests === 0 && !this.isRetained(entry.host.enrollmentId)) {
        this.closeIfIdle(entry);
      }
    }, 30_000);
    entry.idleTimer.unref?.();
  }

  private closeIfIdle(entry: HostEntry): void {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (entry.connection === null || entry.activeRequests > 0 || this.isRetained(entry.host.enrollmentId)) {
      return;
    }
    entry.connection.close();
    entry.connection = null;
    entry.status = statusFor(entry.host, 'degraded');
    this.getContext()?.onConnectivityChanged?.();
  }
}

function statusFor(
  host: MeshMachineHost,
  state: MeshHostConnectionStatus['state'],
  lastError?: string,
  route?: MeshHostConnectionStatus['route'],
): MeshHostConnectionStatus {
  return {
    enrollmentId: host.enrollmentId,
    state,
    route: route ?? (state === 'degraded' ? 'account' : null),
    capabilities: [...host.capabilities],
    ...(lastError === undefined ? {} : { lastError }),
  };
}

async function mapConcurrent<T>(
  values: readonly T[],
  limit: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      await run(values[index]!);
    }
  });
  await Promise.all(workers);
}
