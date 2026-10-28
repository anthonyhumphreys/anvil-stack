import { boundedMeshOperation } from '../../../cloud/contract/machine-route-connect.js';
import {
  meshMachineRouteRank,
  meshMachineRoutePath,
} from '../../../cloud/contract/machine-route-policy.js';
import { createRequire } from 'node:module';
import { MESH_MACHINE_MAX_FRAME_BYTES } from '../../../cloud/contract/machine.js';
import type { MeshMachineHost, MeshMachineOperation } from '../../../cloud/contract/machine.js';
import type { MeshHostConnectionStatus } from '../../shared/sync-runtime.js';
import {
  connectMeshMachineHost,
  meshMachineRouteCandidates,
  fetchMeshMachineHosts,
  safeMachineErrorCode,
  type MeshMachineAdmissionContext,
  type MeshMachineSessionConnection,
  type MeshMachineWebSocketFactory,
} from './mesh-host-client.service.js';

const requireNode = createRequire(import.meta.url);

interface DesktopWebSocketLike {
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: () => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const NodeWebSocket = requireNode('ws') as new (
  url: string,
  protocols: string[],
  options: { maxPayload: number; perMessageDeflate: false },
) => DesktopWebSocketLike;

/** Node-only desktop transport with an inbound message cap before payload allocation. */
export function createDesktopMeshMachineSocket(
  url: string,
  protocols: string[],
): ReturnType<MeshMachineWebSocketFactory> {
  const socket = new NodeWebSocket(url, protocols, {
    maxPayload: MESH_MACHINE_MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  return {
    on(event, listener) {
      switch (event) {
        case 'message':
          socket.on('message', (data) => listener(data));
          break;
        case 'error':
          socket.on('error', (error) => listener(error));
          break;
        case 'close':
          socket.on('close', () => listener());
          break;
      }
    },
    send(data) {
      socket.send(data);
    },
    close(code, reason) {
      socket.close(code, reason);
    },
  };
}

export interface MeshHostRuntimeContext extends Omit<
  MeshMachineAdmissionContext,
  'onEvent' | 'onResnapshotRequired' | 'onClosed'
> {
  backendId?: string;
  datasetEpoch?: string;
  onEvent?: MeshMachineAdmissionContext['onEvent'];
  onResnapshotRequired?: (input: {
    enrollmentId: string;
    reason: 'epoch-changed' | 'cursor-expired' | 'delivery-failed';
  }) => void;
  onConnectivityChanged?: () => void;
}

export interface MeshHostRuntimeDependencies {
  discover: typeof fetchMeshMachineHosts;
  connect: typeof connectMeshMachineHost;
}

type HostEvent = Parameters<NonNullable<MeshMachineAdmissionContext['onEvent']>>[0];
type Cursor = { epoch: string; sequence: number };
interface ConnectionSlot {
  connection: MeshMachineSessionConnection | null;
  controller: AbortController;
  scope: string;
  network: number;
  base: ConnectionSlot | null;
  requests: number;
  events: HostEvent[];
  bytes: number;
  invalid: boolean;
  progress?: () => void;
}
interface HostEntry {
  host: MeshMachineHost;
  active: ConnectionSlot | null;
  candidate: ConnectionSlot | null;
  draining: ConnectionSlot | null;
  connecting: Promise<MeshMachineSessionConnection | null> | null;
  cursor: Cursor | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  upgradeAfter: number;
  failures: number;
  preferredUrl: string | null;
  status: MeshHostConnectionStatus;
}

export interface MeshHostRuntimeOptions {
  now?: () => number;
  random?: () => number;
  upgradesEnabled?: () => boolean;
  refreshIntervalMs?: number;
  dwellMs?: number;
  preparationTimeoutMs?: number;
}

/** Demand-owned host sessions; route changes never replay application commands. */
export class MeshHostRuntimePool {
  private readonly entries = new Map<string, HostEntry>();
  private readonly retainers = new Map<string, Set<symbol>>();
  private readonly requestDemand = new Map<string, number>();
  private refreshInFlight: Promise<void> | null = null;
  private refreshAgain = false;
  private periodicTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private networkGeneration = 0;
  private scope: string | null = null;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly getContext: () => MeshHostRuntimeContext | null,
    private readonly dependencies: MeshHostRuntimeDependencies = {
      discover: fetchMeshMachineHosts,
      connect: connectMeshMachineHost,
    },
    private readonly options: MeshHostRuntimeOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    void this.refresh().catch(() => undefined);
  }

  stop(): void {
    this.generation += 1;
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    this.retainers.clear();
    this.requestDemand.clear();
    if (this.periodicTimer !== null) clearTimeout(this.periodicTimer);
    this.periodicTimer = null;
    this.refreshInFlight = null;
    this.refreshAgain = false;
    this.scope = null;
  }

  networkChanged(): void {
    this.networkGeneration += 1;
    for (const entry of this.entries.values()) {
      this.cancelCandidate(entry);
      entry.upgradeAfter = 0;
      entry.failures = 0;
      entry.preferredUrl = null;
    }
    this.start();
  }

  hasActiveDemand(): boolean {
    return this.retainers.size > 0 || this.requestDemand.size > 0;
  }

  statuses(): MeshHostConnectionStatus[] {
    this.context();
    return [...this.entries.values()]
      .map((entry) => ({ ...entry.status, capabilities: [...entry.status.capabilities] }))
      .sort((a, b) => a.enrollmentId.localeCompare(b.enrollmentId));
  }

  hasHealthyPush(enrollmentId: string): boolean {
    this.context();
    const connection = this.entries.get(enrollmentId)?.active?.connection;
    return connection != null && connection.isOpen !== false;
  }

  retain(enrollmentId: string): () => void {
    if (this.context() === null) return () => undefined;
    const scope = this.scope;
    const lease = Symbol(enrollmentId);
    const leases = this.retainers.get(enrollmentId) ?? new Set<symbol>();
    leases.add(lease);
    this.retainers.set(enrollmentId, leases);
    const entry = this.entries.get(enrollmentId);
    if (entry?.idleTimer != null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    this.armPeriodic();
    void this.ensureConnected(enrollmentId).catch(() => null);
    let released = false;
    return () => {
      if (released || scope !== this.scope) return;
      released = true;
      const current = this.retainers.get(enrollmentId);
      current?.delete(lease);
      if (current?.size === 0) this.retainers.delete(enrollmentId);
      const target = this.entries.get(enrollmentId);
      if (target?.candidate?.base != null && !this.retainers.has(enrollmentId)) {
        this.cancelCandidate(target);
      }
      if (target !== undefined && !this.hasDemand(enrollmentId)) {
        this.cancelCandidate(target);
        if (target.retryTimer !== null) clearTimeout(target.retryTimer);
        target.retryTimer = null;
        this.closeIfIdle(target);
      }
      this.armPeriodic();
    };
  }

  async request<T = unknown>(
    enrollmentId: string,
    operation: MeshMachineOperation,
    payload: unknown,
    requestId?: string,
  ): Promise<T | null> {
    if (this.context() === null) return this.unavailable(operation);
    const scope = this.scope;
    this.requestDemand.set(enrollmentId, (this.requestDemand.get(enrollmentId) ?? 0) + 1);
    try {
      await this.ensureConnected(enrollmentId);
      if (this.context() === null || scope !== this.scope) return this.unavailable(operation);
      // Select and count the current owner synchronously after the await: promotion may have occurred.
      const slot = this.entries.get(enrollmentId)?.active ?? null;
      if (slot?.connection == null) return this.unavailable(operation);
      slot.requests += 1;
      try {
        const result = await slot.connection.request<T>(operation, payload, requestId);
        const current = this.entries.get(enrollmentId);
        if (
          !this.isCurrent(scope) ||
          slot.invalid ||
          current === undefined ||
          (current.active !== slot && current.draining !== slot)
        ) {
          if (operation.startsWith('read.')) return null;
          throw new Error('mesh-host-request-uncertain');
        }
        return result;
      } catch {
        if (operation.startsWith('read.')) return null;
        throw new Error('mesh-host-request-uncertain');
      } finally {
        slot.requests -= 1;
        const entry = this.entries.get(enrollmentId);
        if (entry?.draining === slot && slot.requests === 0) {
          this.retire(slot);
          entry.draining = null;
          this.liveStatus(entry);
        }
      }
    } finally {
      if (scope === this.scope) {
        const count = (this.requestDemand.get(enrollmentId) ?? 1) - 1;
        if (count <= 0) this.requestDemand.delete(enrollmentId);
        else this.requestDemand.set(enrollmentId, count);
        const entry = this.entries.get(enrollmentId);
        if (entry !== undefined && !this.hasDemand(enrollmentId)) this.scheduleIdleClose(entry);
      }
    }
  }

  async refresh(): Promise<void> {
    if (this.context() === null) return;
    if (this.refreshInFlight !== null) {
      this.refreshAgain = true;
      return this.refreshInFlight;
    }
    const generation = this.generation;
    const work = (async () => {
      do {
        this.refreshAgain = false;
        const context = this.context();
        if (context === null || generation !== this.generation) return;
        const scope = this.scope;
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
        if (!this.isCurrent(scope, generation)) return;
        const discovered = new Map(
          hosts
            .filter((host) => host.enrollmentId !== context.enrollmentId)
            .map((host) => [host.enrollmentId, host]),
        );
        for (const [id, entry] of this.entries) {
          const host = discovered.get(id);
          if (
            host === undefined ||
            host.machineId !== entry.host.machineId ||
            host.endpointGeneration !== entry.host.endpointGeneration
          ) {
            this.disposeEntry(entry);
            this.entries.delete(id);
          }
        }
        for (const host of discovered.values()) {
          let entry = this.entries.get(host.enrollmentId);
          if (entry === undefined) {
            entry = {
              host,
              active: null,
              candidate: null,
              draining: null,
              connecting: null,
              cursor: null,
              retryTimer: null,
              idleTimer: null,
              upgradeAfter: 0,
              failures: 0,
              preferredUrl: null,
              status: statusFor(host, host.online ? 'degraded' : 'offline'),
            };
            this.entries.set(host.enrollmentId, entry);
          }
          entry.host = host;
          if (!host.online || host.routes.length === 0) {
            this.disposeEntry(entry);
            entry.status = statusFor(host, 'offline');
          } else if (this.hasDemand(host.enrollmentId)) {
            if (entry.active === null) void this.connectEntry(entry).catch(() => null);
            else this.maybeUpgrade(entry);
          }
        }
        this.notifyConnectivityChanged(context);
      } while (this.refreshAgain && generation === this.generation);
    })();
    this.refreshInFlight = work;
    try {
      await work;
    } finally {
      if (this.refreshInFlight === work) this.refreshInFlight = null;
      this.armPeriodic();
    }
  }

  private context(): MeshHostRuntimeContext | null {
    const context = this.getContext();
    const key =
      context === null
        ? null
        : JSON.stringify([
            context.apiUrl,
            context.backendId,
            context.accountId,
            context.enrollmentId,
            context.datasetEpoch,
            [...(context.workspaceIds ?? [])].sort(),
          ]);
    if (this.scope !== null && this.scope !== key) this.stop();
    this.scope = key;
    return context;
  }

  private isCurrent(scope: string | null, generation = this.generation): boolean {
    return this.context() !== null && this.scope === scope && generation === this.generation;
  }

  private hasDemand(id: string): boolean {
    return this.isRetained(id) || (this.requestDemand.get(id) ?? 0) > 0;
  }
  private isRetained(id: string): boolean {
    return (this.retainers.get(id)?.size ?? 0) > 0;
  }

  private async ensureConnected(id: string): Promise<MeshMachineSessionConnection | null> {
    if (this.context() === null) return null;
    if (!this.entries.has(id)) await this.refresh();
    const entry = this.entries.get(id);
    if (entry === undefined || !entry.host.online || entry.host.routes.length === 0) return null;
    if (entry.active?.connection != null) return entry.active.connection;
    return this.connectEntry(entry);
  }

  private connectEntry(entry: HostEntry): Promise<MeshMachineSessionConnection | null> {
    if (entry.connecting !== null) return entry.connecting;
    const work = this.prepare(entry, false);
    entry.connecting = work;
    void work.finally(() => {
      if (entry.connecting === work) entry.connecting = null;
    });
    return work;
  }

  private upgradesEnabled(): boolean {
    return this.options.upgradesEnabled?.() ?? process.env['MEZAIR_MESH_ROUTE_UPGRADES'] !== 'false';
  }

  private maybeUpgrade(entry: HostEntry): void {
    if (!this.upgradesEnabled()) {
      this.cancelCandidate(entry);
      return;
    }
    if (
      !this.isRetained(entry.host.enrollmentId) ||
      entry.candidate !== null ||
      entry.draining !== null ||
      this.now() < entry.upgradeAfter ||
      !entry.host.capabilities.includes('machine.stream-handoff/1')
    )
      return;
    const active = entry.active?.connection;
    if (active == null || !active.supportsHandoff) return;
    if (
      !meshMachineRouteCandidates(entry.host).some(
        (route) => meshMachineRouteRank(route) < meshMachineRouteRank(active.route),
      )
    )
      return;
    void this.prepare(entry, true);
  }

  private async prepare(
    entry: HostEntry,
    upgrade: boolean,
  ): Promise<MeshMachineSessionConnection | null> {
    const context = this.context();
    if (context === null || entry.candidate !== null) return null;
    const slot: ConnectionSlot = {
      connection: null,
      controller: new AbortController(),
      scope: this.scope!,
      network: this.networkGeneration,
      base: entry.active,
      requests: 0,
      events: [],
      bytes: 0,
      invalid: false,
    };
    entry.candidate = slot;
    const generation = this.generation;
    if (upgrade) this.liveStatus(entry);
    else {
      entry.status = statusFor(entry.host, 'connecting');
      this.notifyConnectivityChanged(context);
    }
    const timer = setTimeout(
      () => slot.controller.abort(new Error('machine-preparation-timeout')),
      this.options.preparationTimeoutMs ?? 30_000,
    );
    timer.unref?.();
    const abort = (): void => {
      slot.invalid = true;
      slot.progress?.();
    };
    slot.controller.signal.addEventListener('abort', abort, { once: true });
    const host =
      upgrade && slot.base?.connection != null
        ? {
            ...entry.host,
            routes: meshMachineRouteCandidates(entry.host).filter(
              (route) =>
                meshMachineRouteRank(route) < meshMachineRouteRank(slot.base!.connection!.route),
            ),
          }
        : {
            ...entry.host,
            routes: [...entry.host.routes].sort(
              (a, b) =>
                meshMachineRouteRank(a) - meshMachineRouteRank(b) ||
                Number(b.url === entry.preferredUrl) - Number(a.url === entry.preferredUrl),
            ),
          };
    try {
      const connection = await boundedMeshOperation(
        (signal) =>
          this.dependencies.connect(host, {
            ...context,
            socketFactory: context.socketFactory ?? createDesktopMeshMachineSocket,
            signal,
            ...(entry.cursor === null ? {} : { resumeCursor: { ...entry.cursor } }),
            requireReplayComplete: upgrade,
            onEvent: (event) => this.receive(entry, slot, event),
            onResnapshotRequired: (reason) => {
              if (!this.slotCurrent(entry, slot)) return;
              if (upgrade && entry.candidate === slot) {
                slot.controller.abort();
                return;
              }
              entry.cursor = null;
              this.notifyResnapshotRequired(reason, context);
            },
            onClosed: (_id, reason) => this.closed(entry, slot, reason),
          }),
        slot.controller.signal,
        this.options.preparationTimeoutMs ?? 30_000,
        (late) => late.close(),
      );
      slot.connection = connection;
      if (
        !this.slotCurrent(entry, slot) ||
        generation !== this.generation ||
        connection.isOpen === false ||
        (upgrade && (!this.upgradesEnabled() || !connection.supportsHandoff))
      )
        throw new Error('machine-preparation-stale');
      const promote = (): boolean => {
        if (
          !this.slotCurrent(entry, slot) ||
          entry.candidate !== slot ||
          slot.network !== this.networkGeneration ||
          entry.active !== slot.base ||
          !this.hasDemand(entry.host.enrollmentId) ||
          (upgrade && (!this.isRetained(entry.host.enrollmentId) || !this.upgradesEnabled()))
        ) {
          slot.invalid = true;
          return false;
        }
        const checkpoint = connection.streamCursor;
        if (
          upgrade &&
          entry.cursor !== null &&
          (checkpoint == null ||
            checkpoint.epoch !== entry.cursor.epoch ||
            checkpoint.sequence < entry.cursor.sequence)
        )
          return false;
        entry.candidate = null;
        entry.active = slot;
        entry.draining = slot.base;
        slot.base = null;
        if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
        entry.retryTimer = null;
        const buffered = slot.events;
        slot.events = [];
        slot.bytes = 0;
        for (const event of buffered) {
          if (!this.deliver(entry, event, slot)) throw new Error('machine-promotion-stale');
        }
        if (!this.slotCurrent(entry, slot) || entry.active !== slot)
          throw new Error('machine-promotion-stale');
        if (
          checkpoint != null &&
          (entry.cursor === null ||
            entry.cursor.epoch !== checkpoint.epoch ||
            checkpoint.sequence > entry.cursor.sequence)
        )
          entry.cursor = { ...checkpoint };
        if (entry.draining !== null && entry.draining.requests === 0) {
          this.retire(entry.draining);
          entry.draining = null;
        }
        entry.failures = 0;
        entry.preferredUrl = connection.route?.url ?? null;
        entry.upgradeAfter = this.now() + (this.options.dwellMs ?? 60_000);
        this.liveStatus(entry);
        return true;
      };
      if (!promote()) {
        await new Promise<void>((resolve, reject) => {
          slot.progress = () => {
            try {
              if (
                slot.invalid ||
                slot.controller.signal.aborted ||
                !this.slotCurrent(entry, slot)
              ) {
                reject(new Error('machine-preparation-stale'));
                return;
              }
              if (promote()) resolve();
            } catch (error) {
              reject(error);
            }
          };
          slot.progress();
        });
      }
      return connection;
    } catch (error) {
      // Ownership may already have changed before a reentrant callback interrupted promotion.
      if (entry.active === slot) this.recoverEventDelivery(entry, slot);
      if (entry.candidate === slot) {
        entry.candidate = null;
        if (upgrade) {
          entry.failures += 1;
          entry.upgradeAfter =
            this.now() +
            Math.min(300_000, 30_000 * 2 ** Math.min(4, entry.failures - 1)) *
              (1 + this.random() * 0.1);
          this.liveStatus(entry);
        } else if (this.entries.get(entry.host.enrollmentId) === entry) {
          entry.status = statusFor(
            entry.host,
            'degraded',
            safeMachineErrorCode(error) ??
              (error instanceof Error && error.message === 'protocol-mismatch'
                ? 'protocol-mismatch'
                : 'route-unavailable'),
          );
          this.notifyConnectivityChanged();
          this.scheduleReconnect(entry);
        }
      }
      this.retire(slot);
      return null;
    } finally {
      clearTimeout(timer);
      slot.progress = undefined;
      slot.controller.signal.removeEventListener('abort', abort);
    }
  }

  private slotCurrent(entry: HostEntry, slot: ConnectionSlot): boolean {
    return (
      !slot.invalid &&
      this.isCurrent(slot.scope) &&
      this.entries.get(entry.host.enrollmentId) === entry &&
      (entry.active === slot || entry.candidate === slot || entry.draining === slot)
    );
  }

  private receive(entry: HostEntry, slot: ConnectionSlot, event: HostEvent): void {
    if (!this.slotCurrent(entry, slot)) return;
    if (entry.active === slot) {
      this.deliver(entry, event);
      return;
    }
    if (entry.candidate !== slot) return;
    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    if (slot.events.length >= 512 || slot.bytes + bytes > 2 * 1024 * 1024) {
      slot.controller.abort(new Error('machine-replay-overflow'));
      return;
    }
    slot.events.push(event);
    slot.bytes += bytes;
    slot.progress?.();
  }

  private deliver(entry: HostEntry, event: HostEvent, slot = entry.active): boolean {
    if (slot === null || !this.slotCurrent(entry, slot) || entry.active !== slot) return false;
    if (
      entry.cursor !== null &&
      entry.cursor.epoch === event.epoch &&
      event.sequence <= entry.cursor.sequence
    )
      return true;
    const context = this.getContext();
    entry.cursor = { epoch: event.epoch, sequence: event.sequence };
    try {
      context?.onEvent?.(event);
    } catch {
      // A consumer may have applied only part of the event. A fresh snapshot, rather than a
      // replayed mutation or a silently advanced cursor, restores a known application state.
      this.recoverEventDelivery(entry, slot);
      return false;
    }
    // Consumer callbacks may sign out, change workspace/account, or stop this pool synchronously.
    return this.slotCurrent(entry, slot) && entry.active === slot;
  }

  private closed(entry: HostEntry, slot: ConnectionSlot, reason?: string): void {
    if (!this.slotCurrent(entry, slot)) return;
    if (reason === 'device-denied') {
      this.disposeEntry(entry);
      entry.status = statusFor(entry.host, 'degraded', 'device-denied');
      this.notifyConnectivityChanged();
      this.scheduleReconnect(entry);
    } else if (entry.active === slot) {
      entry.active = null;
      this.retire(slot);
      this.cancelCandidate(entry);
      entry.status = statusFor(
        entry.host,
        'degraded',
        reason === 'authorization-unavailable' ? reason : 'route-unavailable',
      );
      this.notifyConnectivityChanged();
      this.scheduleReconnect(entry);
    } else if (entry.candidate === slot) slot.controller.abort();
    else if (entry.draining === slot) {
      entry.draining = null;
      this.retire(slot);
      this.liveStatus(entry);
    }
  }

  private liveStatus(entry: HostEntry): void {
    const connection = entry.active?.connection;
    if (connection == null) return;
    entry.status = {
      ...statusFor(entry.host, 'live', undefined, connection.routeKind),
      ...(connection.route === undefined ? {} : { path: meshMachineRoutePath(connection.route) }),
      ...(entry.candidate !== null
        ? { migration: 'preparing' as const }
        : entry.draining !== null
          ? { migration: 'draining' as const }
          : {}),
    };
    this.notifyConnectivityChanged();
  }

  private recoverEventDelivery(entry: HostEntry, slot: ConnectionSlot): void {
    if (!this.slotCurrent(entry, slot) || entry.active !== slot) return;
    const context = this.getContext();
    this.disposeEntry(entry);
    entry.status = statusFor(entry.host, 'degraded', 'event-delivery-failed');
    this.scheduleReconnect(entry);
    this.notifyResnapshotRequired(
      { enrollmentId: entry.host.enrollmentId, reason: 'delivery-failed' },
      context,
    );
    if (this.isCurrent(slot.scope) && this.entries.get(entry.host.enrollmentId) === entry)
      this.notifyConnectivityChanged(context);
  }

  private notifyConnectivityChanged(context = this.getContext()): void {
    try {
      context?.onConnectivityChanged?.();
    } catch {
      console.warn('[Mesh] Host connectivity observer failed.');
    }
  }

  private notifyResnapshotRequired(
    reason: Parameters<NonNullable<MeshHostRuntimeContext['onResnapshotRequired']>>[0],
    context = this.getContext(),
  ): void {
    try {
      context?.onResnapshotRequired?.(reason);
    } catch {
      console.warn('[Mesh] Host resnapshot observer failed.');
    }
  }

  private retire(slot: ConnectionSlot): void {
    slot.invalid = true;
    slot.controller.abort();
    slot.connection?.close();
    slot.progress?.();
    slot.events = [];
    slot.bytes = 0;
  }
  private cancelCandidate(entry: HostEntry): void {
    const candidate = entry.candidate;
    entry.candidate = null;
    if (candidate !== null) this.retire(candidate);
    this.liveStatus(entry);
  }
  private disposeEntry(entry: HostEntry): void {
    if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
    entry.retryTimer = null;
    entry.idleTimer = null;
    for (const slot of [entry.active, entry.candidate, entry.draining])
      if (slot !== null) this.retire(slot);
    entry.active = null;
    entry.candidate = null;
    entry.draining = null;
    entry.cursor = null;
  }
  private scheduleReconnect(entry: HostEntry): void {
    if (entry.retryTimer !== null || !this.hasDemand(entry.host.enrollmentId) || !entry.host.online)
      return;
    entry.retryTimer = setTimeout(
      () => {
        entry.retryTimer = null;
        if (
          this.entries.get(entry.host.enrollmentId) === entry &&
          this.hasDemand(entry.host.enrollmentId)
        )
          this.start();
      },
      25_000 + Math.floor(this.random() * 10_001),
    );
    entry.retryTimer.unref?.();
  }
  private scheduleIdleClose(entry: HostEntry): void {
    if (entry.idleTimer !== null) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      this.closeIfIdle(entry);
    }, 30_000);
    entry.idleTimer.unref?.();
  }
  private closeIfIdle(entry: HostEntry): void {
    if (
      this.hasDemand(entry.host.enrollmentId) ||
      (entry.active?.requests ?? 0) > 0 ||
      (entry.draining?.requests ?? 0) > 0
    )
      return;
    this.disposeEntry(entry);
    entry.status = statusFor(entry.host, 'degraded');
    this.notifyConnectivityChanged();
  }
  private armPeriodic(): void {
    if (!this.hasActiveDemand()) {
      if (this.periodicTimer !== null) clearTimeout(this.periodicTimer);
      this.periodicTimer = null;
      return;
    }
    if (this.periodicTimer !== null) return;
    this.periodicTimer = setTimeout(
      () => {
        this.periodicTimer = null;
        this.start();
      },
      (this.options.refreshIntervalMs ?? 60_000) * (1 + this.random() * 0.1),
    );
    this.periodicTimer.unref?.();
  }
  private unavailable(operation: MeshMachineOperation): null {
    if (operation.startsWith('read.')) return null;
    throw new Error('mesh-host-route-unavailable');
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
