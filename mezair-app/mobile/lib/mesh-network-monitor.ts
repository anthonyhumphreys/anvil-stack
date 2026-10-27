export interface MobileMeshNetworkState {
  type?: string;
  isConnected?: boolean;
  ip?: string | null;
}

/** Network APIs supply reassessment hints; they never establish host reachability. */
export class MobileMeshNetworkMonitor {
  private readonly dependencies: {
    read(): Promise<MobileMeshNetworkState>;
    listen(listener: () => void): () => void;
    hasDemand(): boolean;
    changed(): void;
    foreground(active: boolean): void;
    pollMs?: number;
    debounceMs?: number;
  };
  private active = false;
  private stopped = true;
  private generation = 0;
  private fingerprint: string | null = null;
  private removeListener: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private reading = false;
  private readAgain = false;

  constructor(dependencies: MobileMeshNetworkMonitor['dependencies']) {
    this.dependencies = dependencies;
  }

  start(active: boolean): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.removeListener = this.dependencies.listen(() => {
      if (!this.active || this.stopped || !this.dependencies.hasDemand()) return;
      if (this.debounce !== null) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {
        this.debounce = null;
        void this.sample();
      }, this.dependencies.debounceMs ?? 500);
    });
    this.setForeground(active);
  }

  setForeground(active: boolean): void {
    this.active = active;
    this.generation += 1;
    this.clearTimers();
    this.dependencies.foreground(active);
    if (active && !this.stopped) void this.sample();
  }

  demandChanged(): void {
    if (this.stopped || !this.active) return;
    if (!this.dependencies.hasDemand()) this.clearTimers();
    else if (this.timer === null) void this.sample();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.removeListener?.();
    this.removeListener = null;
    this.clearTimers();
    this.dependencies.foreground(false);
  }

  private async sample(): Promise<void> {
    if (this.stopped || !this.active || !this.dependencies.hasDemand()) return;
    if (this.reading) {
      this.readAgain = true;
      return;
    }
    this.reading = true;
    const generation = this.generation;
    try {
      const state = await this.dependencies.read();
      if (
        generation !== this.generation ||
        this.stopped ||
        !this.active ||
        !this.dependencies.hasDemand()
      )
        return;
      const next = JSON.stringify([
        state.type ?? 'unknown',
        state.isConnected ?? null,
        state.ip === '0.0.0.0' ? null : (state.ip ?? null),
      ]);
      if (this.fingerprint !== null && this.fingerprint !== next) this.dependencies.changed();
      this.fingerprint = next;
    } catch {
      /* Unknown network information leaves authenticated routes usable. */
    } finally {
      this.reading = false;
      if (this.readAgain) {
        this.readAgain = false;
        void this.sample();
      } else if (
        !this.stopped &&
        this.active &&
        this.dependencies.hasDemand() &&
        this.timer === null
      ) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.sample();
        }, this.dependencies.pollMs ?? 15_000);
      }
    }
  }

  private clearTimers(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
  }
}
