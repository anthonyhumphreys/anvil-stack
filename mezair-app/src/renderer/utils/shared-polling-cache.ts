export interface SharedPollingSnapshot<T> {
  value: T | undefined;
  updatedAt: number | null;
  loading: boolean;
  error?: unknown;
}

export interface SharedPollingOptions<T> {
  /** The regular fallback cadence, or null when a snapshot no longer needs polling. */
  pollIntervalMs: number | ((snapshot: SharedPollingSnapshot<T>) => number | null);
  /** Maximum age before a cached value is discarded, even while refreshes fail. */
  maxStaleMs: number;
  /** A new subscriber refreshes values older than this age. */
  maxAgeMs: number;
  /** Stop waiting for a request that never settles so stale values remain bounded. */
  requestTimeoutMs?: number;
}

interface ResourceEntry<T> {
  key: string;
  load: () => Promise<T>;
  options: SharedPollingOptions<T>;
  snapshot: SharedPollingSnapshot<T>;
  listeners: Set<(snapshot: SharedPollingSnapshot<T>) => void>;
  inFlight: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  requestTimeout: ReturnType<typeof setTimeout> | null;
  cancelRequest: (() => void) | null;
  generation: number;
  requestId: number;
  lastAttemptAt: number | null;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Deduplicates renderer read loops by key. Timers and browser wake listeners
 * exist only while at least one mounted view is subscribed to a resource.
 */
export class SharedPollingCache {
  private readonly entries = new Map<string, ResourceEntry<unknown>>();
  private lifecycleAttached = false;

  private readonly refreshVisibleResources = () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    for (const entry of this.entries.values()) void this.refreshEntry(entry, true);
  };

  private readonly onVisibilityChange = () => {
    if (typeof document !== 'undefined' && !document.hidden) this.refreshVisibleResources();
  };

  subscribe<T>(
    key: string,
    load: () => Promise<T>,
    listener: (snapshot: SharedPollingSnapshot<T>) => void,
    options: SharedPollingOptions<T>,
  ): () => void {
    let entry = this.entries.get(key) as ResourceEntry<T> | undefined;
    if (entry === undefined) {
      entry = {
        key,
        load,
        options,
        snapshot: { value: undefined, updatedAt: null, loading: false },
        listeners: new Set(),
        inFlight: null,
        timer: null,
        requestTimeout: null,
        cancelRequest: null,
        generation: 0,
        requestId: 0,
        lastAttemptAt: null,
      };
      this.entries.set(key, entry as ResourceEntry<unknown>);
    } else {
      entry.load = load;
      entry.options = options;
    }

    entry.listeners.add(listener);
    listener(entry.snapshot);
    this.attachLifecycleListeners();

    const age =
      entry.snapshot.updatedAt === null ? Infinity : Date.now() - entry.snapshot.updatedAt;
    const attemptAge = entry.lastAttemptAt === null ? Infinity : Date.now() - entry.lastAttemptAt;
    if (age >= options.maxAgeMs && attemptAge >= options.maxAgeMs) {
      void this.refreshEntry(entry, false);
    }
    this.schedule(entry);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry?.listeners.delete(listener);
      if (!entry || entry.listeners.size > 0) return;

      entry.generation += 1;
      entry.requestId += 1;
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = null;
      entry.cancelRequest?.();
      this.entries.delete(key);
      this.detachLifecycleListenersIfIdle();
    };
  }

  refresh(key: string, minIntervalMs = 0): Promise<void> {
    const entry = this.entries.get(key);
    if (entry && entry.lastAttemptAt !== null && Date.now() - entry.lastAttemptAt < minIntervalMs)
      return Promise.resolve();
    return entry ? this.refreshEntry(entry, true) : Promise.resolve();
  }

  private async refreshEntry<T>(entry: ResourceEntry<T>, force: boolean): Promise<void> {
    if (entry.listeners.size === 0) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (entry.inFlight !== null) return entry.inFlight;

    const age =
      entry.snapshot.updatedAt === null ? Infinity : Date.now() - entry.snapshot.updatedAt;
    const attemptAge = entry.lastAttemptAt === null ? Infinity : Date.now() - entry.lastAttemptAt;
    if (!force && age < entry.options.maxAgeMs && entry.snapshot.value !== undefined) return;
    if (!force && attemptAge < entry.options.maxAgeMs) return;

    const generation = entry.generation;
    const requestId = ++entry.requestId;
    entry.lastAttemptAt = Date.now();
    entry.snapshot = { ...entry.snapshot, loading: true, error: undefined };
    this.notify(entry);

    const timeoutMs = entry.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      const rejectWith = (message: string): void => {
        if (entry.requestTimeout !== null) clearTimeout(entry.requestTimeout);
        entry.requestTimeout = null;
        entry.cancelRequest = null;
        reject(new Error(message));
      };
      entry.cancelRequest = () => rejectWith('Shared refresh was released.');
      entry.requestTimeout = setTimeout(() => rejectWith('Shared refresh timed out.'), timeoutMs);
    });
    const request = Promise.race([Promise.resolve().then(entry.load), timeoutPromise])
      .then((value) => {
        if (!this.isCurrent(entry, generation, requestId)) return;
        entry.snapshot = { value, updatedAt: Date.now(), loading: false };
        this.notify(entry);
      })
      .catch((error: unknown) => {
        if (!this.isCurrent(entry, generation, requestId)) return;
        entry.snapshot = { ...entry.snapshot, loading: false, error };
        this.discardExpiredValue(entry);
        this.notify(entry);
      })
      .finally(() => {
        if (entry.requestTimeout !== null) clearTimeout(entry.requestTimeout);
        entry.requestTimeout = null;
        entry.cancelRequest = null;
        if (!this.isCurrent(entry, generation, requestId)) return;
        entry.inFlight = null;
        this.schedule(entry);
      });
    entry.inFlight = request;
    return request;
  }

  private isCurrent<T>(entry: ResourceEntry<T>, generation: number, requestId: number): boolean {
    return (
      this.entries.get(entry.key) === entry &&
      entry.generation === generation &&
      entry.requestId === requestId &&
      entry.listeners.size > 0
    );
  }

  private schedule<T>(entry: ResourceEntry<T>): void {
    if (entry.listeners.size === 0 || entry.inFlight !== null) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;

    const configuredInterval =
      typeof entry.options.pollIntervalMs === 'function'
        ? entry.options.pollIntervalMs(entry.snapshot)
        : entry.options.pollIntervalMs;
    if (configuredInterval === null) return;

    const now = Date.now();
    const valueAge = entry.snapshot.updatedAt === null ? null : now - entry.snapshot.updatedAt;
    const hasFreshEnoughValue = entry.snapshot.value !== undefined && valueAge !== null;
    const untilStale = hasFreshEnoughValue ? entry.options.maxStaleMs - valueAge : Infinity;
    const delay = Math.max(0, Math.min(configuredInterval, untilStale));
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.discardExpiredValue(entry);
      void this.refreshEntry(entry, true);
    }, delay);
  }

  private discardExpiredValue<T>(entry: ResourceEntry<T>): void {
    if (entry.snapshot.updatedAt === null || entry.snapshot.value === undefined) return;
    if (Date.now() - entry.snapshot.updatedAt < entry.options.maxStaleMs) return;
    entry.snapshot = { ...entry.snapshot, value: undefined };
    this.notify(entry);
  }

  private notify<T>(entry: ResourceEntry<T>): void {
    for (const listener of entry.listeners) listener(entry.snapshot);
  }

  private attachLifecycleListeners(): void {
    if (this.lifecycleAttached || typeof window === 'undefined') return;
    this.lifecycleAttached = true;
    window.addEventListener('online', this.refreshVisibleResources);
    window.addEventListener('focus', this.refreshVisibleResources);
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private detachLifecycleListenersIfIdle(): void {
    if (!this.lifecycleAttached || this.entries.size > 0 || typeof window === 'undefined') return;
    this.lifecycleAttached = false;
    window.removeEventListener('online', this.refreshVisibleResources);
    window.removeEventListener('focus', this.refreshVisibleResources);
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }
}

export const sharedPollingCache = new SharedPollingCache();
