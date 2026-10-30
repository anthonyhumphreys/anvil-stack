import type { MeshMachineHost, MeshMachineRoute } from '../../cloud/contract/machine';

export interface MobileMeshCursor {
  epoch: string;
  sequence: number;
}
export interface MobileMeshEvent extends MobileMeshCursor {
  workspaceId: string;
  jobId?: string;
  eventKind: string;
  payload: unknown;
}
export interface MobileMeshHandlers {
  onEvent(event: MobileMeshEvent): void;
  onResnapshot(
    reason: 'epoch-changed' | 'cursor-expired' | 'sequence-gap' | 'delivery-failed',
  ): void;
  onClosed(cause?: string): void;
}
export interface MobileMeshConnection {
  readonly host: MeshMachineHost;
  readonly route: MeshMachineRoute;
  readonly isOpen: boolean;
  readonly streamCursor: MobileMeshCursor | null;
  readonly replayComplete: boolean;
  request(operation: string, payload: unknown, requestId?: string): Promise<unknown>;
  close(): void;
}
export interface MobileMeshStatus {
  state: 'idle' | 'connecting' | 'live' | 'reconnecting' | 'authorization-unavailable';
  path: 'direct' | 'private-network' | 'https' | 'managed' | null;
  lanAddress: boolean;
}
export interface MobileMeshManagerDependencies {
  scope(): Promise<string | null>;
  discover(signal: AbortSignal): Promise<MeshMachineHost[]>;
  connect(
    host: MeshMachineHost,
    options: {
      signal: AbortSignal;
      cursor?: MobileMeshCursor;
      handlers: MobileMeshHandlers;
    },
  ): Promise<MobileMeshConnection>;
  rank(route: MeshMachineRoute): number;
  path(route: MeshMachineRoute): NonNullable<MobileMeshStatus['path']>;
  now?: () => number;
  random?: () => number;
  idleMs?: number;
  refreshMs?: number;
  dwellMs?: number;
  retryMs?: number;
  preparationMs?: number;
}
interface OwnedConnection {
  connection: MobileMeshConnection;
  requests: number;
}
interface Preparation {
  controller: AbortController;
  connection: MobileMeshConnection | null;
  buffer: MobileMeshEvent[];
  bytes: number;
  cursor: MobileMeshCursor | null;
  ready: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}
interface HostEntry {
  id: string;
  host: MeshMachineHost | null;
  active: OwnedConnection | null;
  draining: OwnedConnection | null;
  candidate: Preparation | null;
  connecting: Promise<MobileMeshConnection> | null;
  controller: AbortController | null;
  handlers: Set<MobileMeshHandlers>;
  requests: number;
  cursor: MobileMeshCursor | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  nextUpgradeAt: number;
  failures: number;
  status: MobileMeshStatus;
}

const emptyStatus = (): MobileMeshStatus => ({ state: 'idle', path: null, lanAddress: false });
const idleStatus = Object.freeze(emptyStatus());
const failure = (code = 'machine-route-unavailable'): Error => new Error(code);
const authorizationFailure = (cause?: string): boolean =>
  cause === 'session.revoked' || cause === 'device-denied' || cause === 'authorization-unavailable';
const observe = (callback: () => void): void => {
  try {
    callback();
  } catch {
    // Status and lifecycle observers cannot prevent session cleanup or other observers.
  }
};

/** Owns demand, replay progress and requests independently of any transport socket. */
export class MobileMeshSessionManager {
  private readonly dependencies: MobileMeshManagerDependencies;
  private readonly entries = new Map<string, HostEntry>();
  private readonly statusListeners = new Set<() => void>();
  private scopeKey: string | null = null;
  private generation = 0;
  private networkGeneration = 0;
  private foreground = true;
  private upgradesEnabled = true;
  private discovery: Promise<MeshMachineHost[]> | null = null;
  private discoveryController: AbortController | null = null;
  private discovered: MeshMachineHost[] | null = null;
  private discoveredAt = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing = false;
  private refreshAgain = false;

  constructor(dependencies: MobileMeshManagerDependencies) {
    this.dependencies = dependencies;
  }

  status(id: string): MobileMeshStatus {
    return this.entries.get(id)?.status ?? idleStatus;
  }
  onStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  hasDemand(): boolean {
    return [...this.entries.values()].some((entry) => entry.handlers.size > 0);
  }

  async get(id: string): Promise<{
    readonly host: MeshMachineHost;
    readonly route: MeshMachineRoute;
    request(operation: string, payload: unknown, requestId?: string): Promise<unknown>;
    subscribe(handlers: MobileMeshHandlers): () => void;
  }> {
    await this.checkScope();
    const entry = this.entry(id);
    await this.ensure(entry);
    if (this.entries.get(id) !== entry) throw failure('authorization-unavailable');
    this.scheduleIdle(entry);
    const manager = this;
    return {
      get host() {
        if (manager.entries.get(id) !== entry) throw failure('authorization-unavailable');
        if (entry.host === null) throw failure();
        return entry.host;
      },
      get route() {
        if (manager.entries.get(id) !== entry) throw failure('authorization-unavailable');
        if (entry.active === null) throw failure();
        return entry.active.connection.route;
      },
      request: (operation, payload, requestId) =>
        this.entries.get(id) === entry
          ? this.request(id, operation, payload, requestId)
          : Promise.reject(failure('authorization-unavailable')),
      subscribe: (handlers) => {
        if (this.entries.get(id) !== entry) throw failure('authorization-unavailable');
        return this.subscribe(id, handlers);
      },
    };
  }

  subscribe(id: string, handlers: MobileMeshHandlers): () => void {
    const entry = this.entry(id);
    entry.handlers.add(handlers);
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    void this.checkScope()
      .then(() => {
        if (this.entries.get(id) !== entry || !entry.handlers.has(handlers)) return;
        return this.ensure(entry);
      })
      .catch((error: unknown) => {
        if (this.entries.get(id) !== entry || !entry.handlers.has(handlers)) return;
        observe(() => handlers.onClosed(error instanceof Error ? error.message : undefined));
        this.retry(entry);
      });
    this.armRefresh();
    return () => {
      entry.handlers.delete(handlers);
      if (entry.handlers.size === 0) {
        this.cancelCandidate(entry);
        if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
        entry.retryTimer = null;
        if (entry.requests === 0) this.closeIdle(entry);
      }
      if (!this.hasDemand() && this.refreshTimer !== null) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
      }
    };
  }

  async request(
    id: string,
    operation: string,
    payload: unknown,
    requestId?: string,
  ): Promise<unknown> {
    await this.checkScope();
    const entry = this.entry(id);
    const generation = this.generation;
    entry.requests += 1;
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    let owner: OwnedConnection | null = null;
    try {
      await this.ensure(entry);
      if (generation !== this.generation || this.entries.get(id) !== entry)
        throw failure('authorization-unavailable');
      owner = entry.active;
      if (owner === null) throw failure();
      owner.requests += 1;
      try {
        const result = await owner.connection.request(operation, payload, requestId);
        await this.checkScope();
        if (
          generation !== this.generation ||
          this.entries.get(id) !== entry ||
          (entry.active !== owner && entry.draining !== owner)
        )
          throw failure('authorization-unavailable');
        return result;
      } catch (error) {
        // A sent mutation can have succeeded even when its response disappeared.
        if (
          !operation.startsWith('read.') &&
          !(error instanceof Error && 'definitive' in error && error.definitive === true)
        )
          throw failure('machine-request-uncertain');
        throw error;
      }
    } finally {
      entry.requests = Math.max(0, entry.requests - 1);
      if (owner !== null) {
        owner.requests = Math.max(0, owner.requests - 1);
        if (entry.draining === owner && owner.requests === 0) {
          entry.draining = null;
          owner.connection.close();
        }
      }
      if (this.entries.get(id) === entry) this.scheduleIdle(entry);
    }
  }

  setForeground(active: boolean): void {
    this.foreground = active;
    if (!active) {
      this.discoveryController?.abort();
      this.discoveryController = null;
      this.discovery = null;
      for (const entry of this.entries.values()) {
        entry.controller?.abort();
        this.cancelCandidate(entry);
        if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
        entry.retryTimer = null;
      }
      if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    } else {
      void this.refresh(true);
      this.armRefresh();
    }
  }
  setUpgradesEnabled(enabled: boolean): void {
    this.upgradesEnabled = enabled;
    if (!enabled) for (const entry of this.entries.values()) this.cancelCandidate(entry);
  }
  networkChanged(): void {
    this.networkGeneration += 1;
    this.discovered = null;
    this.discoveryController?.abort();
    this.discoveryController = null;
    this.discovery = null;
    for (const entry of this.entries.values()) {
      entry.controller?.abort();
      if (entry.connecting !== null) {
        // A cancelled initial dial must not defer the new network to the retry timer.
        void entry.connecting
          .catch(() => undefined)
          .then(() => {
            if (
              this.foreground &&
              this.entries.get(entry.id) === entry &&
              entry.handlers.size > 0 &&
              entry.active === null
            )
              void this.ensure(entry).catch(() => this.retry(entry));
          });
      }
      this.cancelCandidate(entry);
      entry.nextUpgradeAt = 0;
      entry.failures = 0;
    }
    void this.refresh(true);
  }

  reset(): void {
    this.generation += 1;
    this.scopeKey = null;
    this.discoveryController?.abort();
    this.discoveryController = null;
    this.discovery = null;
    this.discovered = null;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      entry.controller?.abort();
      this.cancelCandidate(entry);
      if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
      if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
      entry.active?.connection.close();
      entry.draining?.connection.close();
      for (const handler of [...entry.handlers])
        observe(() => handler.onClosed('authorization-unavailable'));
      entry.handlers.clear();
    }
    this.notify();
  }

  async refresh(force = false): Promise<void> {
    if (!this.foreground || !this.hasDemand()) return;
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      await this.checkScope();
      const hosts = await this.roster(force);
      for (const entry of this.entries.values()) {
        if (entry.handlers.size === 0) continue;
        const host = hosts.find((candidate) => candidate.enrollmentId === entry.id);
        if (host === undefined || !host.online || host.routes.length === 0) {
          this.invalidateHost(entry);
          continue;
        }
        if (entry.host !== null && !sameHost(entry.host, host)) this.invalidateHost(entry);
        entry.host = host;
        if (entry.active === null) void this.ensure(entry).catch(() => this.retry(entry));
        else void this.upgrade(entry).catch(() => undefined);
      }
    } catch {
      /* The authorized working connection retains its own authorization deadline. */
    } finally {
      this.refreshing = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh(true);
      }
    }
  }

  private entry(id: string): HostEntry {
    let entry = this.entries.get(id);
    if (entry === undefined) {
      entry = {
        id,
        host: null,
        active: null,
        draining: null,
        candidate: null,
        connecting: null,
        controller: null,
        handlers: new Set(),
        requests: 0,
        cursor: null,
        idleTimer: null,
        retryTimer: null,
        nextUpgradeAt: 0,
        failures: 0,
        status: emptyStatus(),
      };
      this.entries.set(id, entry);
    }
    return entry;
  }
  private async checkScope(): Promise<void> {
    const generation = this.generation;
    const scope = await this.dependencies.scope();
    if (generation !== this.generation) throw failure('authorization-unavailable');
    if (scope === null) {
      this.reset();
      throw failure('account-sign-in-required');
    }
    if (this.scopeKey !== null && scope !== this.scopeKey) {
      this.reset();
      this.scopeKey = scope;
      throw failure('authorization-unavailable');
    }
    this.scopeKey = scope;
  }
  private async roster(force = false): Promise<MeshMachineHost[]> {
    if (this.discovery !== null) return this.discovery;
    if (!force && this.discovered !== null && this.now() - this.discoveredAt < 5_000)
      return this.discovered;
    const generation = this.generation;
    const controller = new AbortController();
    this.discoveryController = controller;
    const work = this.dependencies
      .discover(controller.signal)
      .then(async (hosts) => {
        await this.checkScope();
        if (generation !== this.generation || controller.signal.aborted) throw failure();
        this.discovered = hosts;
        this.discoveredAt = this.now();
        return hosts;
      })
      .finally(() => {
        if (this.discovery === work) {
          this.discovery = null;
          this.discoveryController = null;
        }
      });
    this.discovery = work;
    return work;
  }
  private async ensure(entry: HostEntry): Promise<MobileMeshConnection> {
    if (this.entries.get(entry.id) !== entry) throw failure('authorization-unavailable');
    if (entry.active?.connection.isOpen) return entry.active.connection;
    if (entry.active !== null) {
      const expired = entry.active;
      entry.active = null;
      expired.connection.close();
    }
    if (entry.connecting !== null) return entry.connecting;
    const generation = this.generation;
    const network = this.networkGeneration;
    const controller = new AbortController();
    entry.controller = controller;
    entry.status = { ...emptyStatus(), state: 'connecting' };
    this.notify();
    const work = (async () => {
      const host = (await this.roster()).find((candidate) => candidate.enrollmentId === entry.id);
      if (host === undefined || !host.online) throw failure();
      if (entry.host !== null && !sameHost(entry.host, host)) entry.cursor = null;
      entry.host = host;
      let opened: MobileMeshConnection | null = null;
      let adopted = false;
      const early: MobileMeshEvent[] = [];
      let earlyBytes = 0;
      const connection = await this.dependencies.connect(host, {
        signal: controller.signal,
        ...(entry.cursor === null ? {} : { cursor: entry.cursor }),
        handlers: {
          onEvent: (event) => {
            if (adopted && opened !== null && entry.active?.connection === opened)
              this.deliver(entry, event);
            else if (!adopted) {
              earlyBytes += new TextEncoder().encode(JSON.stringify(event)).byteLength;
              if (early.length >= 512 || earlyBytes > 2 * 1024 * 1024) controller.abort();
              else early.push(event);
            }
          },
          onResnapshot: (reason) => {
            if (this.entries.get(entry.id) !== entry || controller.signal.aborted) return;
            if (opened === null || entry.active?.connection === opened) {
              entry.cursor = null;
              this.notifyResnapshot(entry, reason);
            }
          },
          onClosed: (cause) => {
            if (opened !== null) this.closed(entry, opened, cause);
          },
        },
      });
      opened = connection;
      try {
        await this.checkScope();
        if (
          generation !== this.generation ||
          network !== this.networkGeneration ||
          this.entries.get(entry.id) !== entry ||
          controller.signal.aborted ||
          !connection.isOpen
        )
          throw failure();
        entry.active = { connection, requests: 0 };
        adopted = true;
        for (const event of early) {
          if (!this.deliver(entry, event)) {
            throw failure(
              this.entries.get(entry.id) === entry
                ? 'machine-event-delivery-failed'
                : 'authorization-unavailable',
            );
          }
          if (this.entries.get(entry.id) !== entry || entry.active?.connection !== connection)
            throw failure('authorization-unavailable');
        }
        this.advanceCursor(entry, connection.streamCursor);
        this.live(entry);
        if (this.entries.get(entry.id) !== entry || entry.active?.connection !== connection)
          throw failure('authorization-unavailable');
        return connection;
      } catch (error) {
        connection.close();
        throw error;
      }
    })()
      .catch((error: unknown) => {
        if (this.entries.get(entry.id) === entry && entry.active === null) {
          entry.status = {
            ...emptyStatus(),
            state: authorizationFailure(error instanceof Error ? error.message : undefined)
              ? 'authorization-unavailable'
              : 'reconnecting',
          };
          this.notify();
        }
        throw error;
      })
      .finally(() => {
        if (entry.connecting === work) {
          entry.connecting = null;
          entry.controller = null;
        }
      });
    entry.connecting = work;
    return work;
  }

  private async upgrade(entry: HostEntry): Promise<void> {
    if (
      !this.foreground ||
      !this.upgradesEnabled ||
      entry.handlers.size === 0 ||
      entry.active === null ||
      entry.host === null ||
      entry.candidate !== null ||
      entry.draining !== null ||
      this.now() < entry.nextUpgradeAt ||
      !entry.host.capabilities.includes('machine.stream-handoff/1') ||
      !entry.active.connection.replayComplete
    )
      return;
    const routes = entry.host.routes.filter(
      (route) =>
        this.dependencies.rank(route) < this.dependencies.rank(entry.active!.connection.route),
    );
    if (routes.length === 0) return;
    const generation = this.generation;
    const network = this.networkGeneration;
    const host = entry.host;
    const candidate: Preparation = {
      controller: new AbortController(),
      connection: null,
      buffer: [],
      bytes: 0,
      cursor: entry.cursor,
      ready: false,
      timer: null,
    };
    entry.candidate = candidate;
    candidate.timer = setTimeout(
      () => this.failCandidate(entry, candidate),
      this.dependencies.preparationMs ?? 30_000,
    );
    try {
      const connection = await this.dependencies.connect(
        { ...host, routes },
        {
          signal: candidate.controller.signal,
          ...(entry.cursor === null ? {} : { cursor: { ...entry.cursor } }),
          handlers: {
            onEvent: (event) => {
              if (
                candidate.connection !== null &&
                entry.active?.connection === candidate.connection
              ) {
                this.deliver(entry, event);
              } else if (entry.candidate === candidate) {
                candidate.bytes += new TextEncoder().encode(JSON.stringify(event)).byteLength;
                if (
                  candidate.buffer.length >= 512 ||
                  candidate.bytes > 2 * 1024 * 1024 ||
                  (candidate.cursor !== null && candidate.cursor.epoch !== event.epoch)
                ) {
                  this.failCandidate(entry, candidate);
                  return;
                }
                candidate.buffer.push(event);
                candidate.cursor = { epoch: event.epoch, sequence: event.sequence };
                this.promote(entry, candidate);
              }
            },
            onResnapshot: (reason) => {
              if (
                candidate.connection !== null &&
                entry.active?.connection === candidate.connection
              ) {
                entry.cursor = null;
                this.notifyResnapshot(entry, reason);
              } else this.failCandidate(entry, candidate);
            },
            onClosed: (cause) => {
              if (
                this.entries.get(entry.id) !== entry ||
                (entry.candidate !== candidate &&
                  entry.active?.connection !== candidate.connection &&
                  entry.draining?.connection !== candidate.connection)
              )
                return;
              if (cause === 'session.revoked' || cause === 'device-denied')
                this.invalidateHost(entry, cause);
              else if (
                candidate.connection !== null &&
                entry.active?.connection === candidate.connection
              )
                this.closed(entry, candidate.connection, cause);
              else if (entry.candidate === candidate) this.failCandidate(entry, candidate);
            },
          },
        },
      );
      candidate.connection = connection;
      await this.checkScope();
      if (
        generation !== this.generation ||
        network !== this.networkGeneration ||
        entry.candidate !== candidate ||
        entry.host === null ||
        !sameHost(host, entry.host) ||
        !connection.isOpen ||
        !connection.replayComplete ||
        candidate.controller.signal.aborted ||
        !this.foreground
      )
        throw failure();
      const cursor = connection.streamCursor;
      if (
        cursor !== null &&
        (candidate.cursor === null || cursor.sequence > candidate.cursor.sequence)
      )
        candidate.cursor = cursor;
      candidate.ready = true;
      this.promote(entry, candidate);
    } catch {
      candidate.connection?.close();
      this.failCandidate(entry, candidate);
    }
  }
  private promote(entry: HostEntry, candidate: Preparation): void {
    if (
      this.entries.get(entry.id) !== entry ||
      entry.candidate !== candidate ||
      !candidate.ready ||
      candidate.connection === null ||
      !candidate.connection.isOpen ||
      !this.foreground ||
      entry.handlers.size === 0 ||
      entry.active === null ||
      candidate.controller.signal.aborted
    )
      return;
    if (
      entry.cursor !== null &&
      (candidate.cursor?.epoch !== entry.cursor.epoch ||
        candidate.cursor.sequence < entry.cursor.sequence)
    )
      return;
    const old = entry.active;
    entry.active = { connection: candidate.connection, requests: 0 };
    entry.candidate = null;
    if (candidate.timer !== null) clearTimeout(candidate.timer);
    candidate.timer = null;
    // Own both sockets before a consumer callback can reset the account.
    if (old.requests > 0) entry.draining = old;
    else old.connection.close();
    for (const event of candidate.buffer) {
      if (!this.deliver(entry, event)) {
        candidate.buffer = [];
        return;
      }
      if (
        this.entries.get(entry.id) !== entry ||
        entry.active?.connection !== candidate.connection
      ) {
        candidate.buffer = [];
        return;
      }
    }
    this.advanceCursor(entry, candidate.cursor);
    candidate.buffer = [];
    entry.failures = 0;
    entry.nextUpgradeAt = this.now() + (this.dependencies.dwellMs ?? 60_000);
    this.live(entry);
  }
  private failCandidate(entry: HostEntry, candidate: Preparation): void {
    if (entry.candidate !== candidate) return;
    entry.failures += 1;
    entry.nextUpgradeAt =
      this.now() +
      Math.min(300_000, 30_000 * 2 ** Math.min(4, entry.failures - 1)) *
        (0.9 + this.random() * 0.2);
    this.cancelCandidate(entry);
  }
  private cancelCandidate(entry: HostEntry): void {
    const candidate = entry.candidate;
    entry.candidate = null;
    if (candidate === null) return;
    if (candidate.timer !== null) clearTimeout(candidate.timer);
    candidate.controller.abort();
    candidate.connection?.close();
    candidate.buffer = [];
  }
  private closed(entry: HostEntry, connection: MobileMeshConnection, cause?: string): void {
    if (this.entries.get(entry.id) !== entry) return;
    if (entry.active?.connection !== connection && entry.draining?.connection !== connection)
      return;
    if (cause === 'session.revoked' || cause === 'device-denied') {
      this.invalidateHost(entry, cause);
      return;
    }
    if (entry.active?.connection !== connection) return;
    entry.active = null;
    this.cancelCandidate(entry);
    entry.status = {
      ...emptyStatus(),
      state: authorizationFailure(cause) ? 'authorization-unavailable' : 'reconnecting',
    };
    this.notifyClosed(entry, cause);
    this.notify();
    this.retry(entry);
  }
  private invalidateHost(entry: HostEntry, cause?: string): void {
    entry.controller?.abort();
    this.cancelCandidate(entry);
    const active = entry.active;
    const draining = entry.draining;
    entry.active = null;
    entry.draining = null;
    entry.cursor = null;
    active?.connection.close();
    draining?.connection.close();
    entry.status = {
      ...emptyStatus(),
      state: authorizationFailure(cause) ? 'authorization-unavailable' : 'reconnecting',
    };
    this.notifyClosed(entry, cause);
    this.notify();
  }
  private deliver(entry: HostEntry, event: MobileMeshEvent): boolean {
    if (this.entries.get(entry.id) !== entry) return false;
    const connection = entry.active?.connection;
    if (connection === undefined) return false;
    if (entry.cursor !== null && entry.cursor.epoch !== event.epoch) {
      entry.cursor = null;
      this.notifyResnapshot(entry, 'epoch-changed');
      if (this.entries.get(entry.id) !== entry || entry.active?.connection !== connection)
        return false;
    }
    if (entry.cursor !== null && event.sequence <= entry.cursor.sequence) return true;
    for (const handler of [...entry.handlers]) {
      if (!entry.handlers.has(handler)) continue;
      try {
        handler.onEvent(event);
      } catch {
        this.recoverEventDelivery(entry, connection);
        return false;
      }
      if (this.entries.get(entry.id) !== entry || entry.active?.connection !== connection)
        return false;
    }
    entry.cursor = { epoch: event.epoch, sequence: event.sequence };
    return true;
  }
  private recoverEventDelivery(entry: HostEntry, connection: MobileMeshConnection): void {
    if (this.entries.get(entry.id) !== entry || entry.active?.connection !== connection) return;
    // Some consumers may have applied only part of the event. Drop replay progress and
    // request a snapshot, rather than claiming delivery or replaying a command.
    this.invalidateHost(entry, 'machine-event-delivery-failed');
    if (this.entries.get(entry.id) !== entry) return;
    this.retry(entry);
    this.notifyResnapshot(entry, 'delivery-failed');
  }
  private notifyClosed(entry: HostEntry, cause?: string): void {
    for (const handler of [...entry.handlers]) {
      if (this.entries.get(entry.id) !== entry) return;
      if (entry.handlers.has(handler)) observe(() => handler.onClosed(cause));
    }
  }
  private notifyResnapshot(
    entry: HostEntry,
    reason: Parameters<MobileMeshHandlers['onResnapshot']>[0],
  ): void {
    for (const handler of [...entry.handlers]) {
      if (this.entries.get(entry.id) !== entry) return;
      if (entry.handlers.has(handler)) observe(() => handler.onResnapshot(reason));
    }
  }
  private advanceCursor(entry: HostEntry, cursor: MobileMeshCursor | null): void {
    if (
      cursor !== null &&
      (entry.cursor === null ||
        (entry.cursor.epoch === cursor.epoch && cursor.sequence > entry.cursor.sequence))
    )
      entry.cursor = { ...cursor };
  }
  private live(entry: HostEntry): void {
    if (this.entries.get(entry.id) !== entry) return;
    const route = entry.active?.connection.route;
    if (route === undefined) return;
    entry.status = {
      state: 'live',
      path: this.dependencies.path(route),
      lanAddress: this.dependencies.path(route) === 'direct',
    };
    this.notify();
  }
  private retry(entry: HostEntry): void {
    if (
      entry.retryTimer !== null ||
      entry.handlers.size === 0 ||
      !this.foreground ||
      this.entries.get(entry.id) !== entry ||
      entry.status.state === 'authorization-unavailable'
    )
      return;
    entry.retryTimer = setTimeout(
      () => {
        entry.retryTimer = null;
        if (!this.foreground || this.entries.get(entry.id) !== entry || entry.handlers.size === 0)
          return;
        void this.checkScope()
          .then(() => this.ensure(entry))
          .catch(() => this.retry(entry));
      },
      this.dependencies.retryMs ?? 25_000 + Math.floor(this.random() * 10_000),
    );
  }
  private scheduleIdle(entry: HostEntry): void {
    if (
      entry.handlers.size > 0 ||
      entry.requests > 0 ||
      entry.idleTimer !== null ||
      entry.active === null
    )
      return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      this.closeIdle(entry);
    }, this.dependencies.idleMs ?? 30_000);
  }
  private closeIdle(entry: HostEntry): void {
    if (entry.handlers.size > 0 || entry.requests > 0) return;
    entry.controller?.abort();
    this.cancelCandidate(entry);
    const active = entry.active;
    entry.active = null;
    active?.connection.close();
    entry.status = emptyStatus();
    this.notify();
  }
  private armRefresh(): void {
    if (!this.foreground || !this.hasDemand() || this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(
      () => {
        this.refreshTimer = null;
        void this.refresh(true).finally(() => this.armRefresh());
      },
      (this.dependencies.refreshMs ?? 60_000) * (0.9 + this.random() * 0.2),
    );
  }
  private notify(): void {
    for (const listener of [...this.statusListeners]) observe(listener);
  }
  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }
  private random(): number {
    return this.dependencies.random?.() ?? Math.random();
  }
}

function sameHost(left: MeshMachineHost, right: MeshMachineHost): boolean {
  return (
    left.enrollmentId === right.enrollmentId &&
    left.machineId === right.machineId &&
    left.endpointGeneration === right.endpointGeneration
  );
}
