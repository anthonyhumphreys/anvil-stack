import { DurableObject } from 'cloudflare:workers';
import type { MeshEnvironmentBootstrap } from './bootstrap';

const THREAD_SNAPSHOT_KEY = 'anvil:thread-workspace-snapshot';
const WORKER_BOOT = '/opt/anvil/bin/anvil-worker-boot';
const STANDARD_INSTANCE = 'standard-1';
const KEEP_ALIVE_MS = 6 * 60 * 60 * 1000;
const KEEP_ALIVE_REFRESH_MS = 3 * 60 * 60 * 1000;

interface SavedSnapshot {
  id: string;
  size: number;
  name?: string;
}

/** Native Durable Object Container runner for thread-owned, snapshot-backed environments. */
export class ThreadSandbox extends DurableObject {
  private lifecycleQueue: Promise<void> = Promise.resolve();

  private get container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error('The thread container binding is not configured');
    return container;
  }

  /** Start from the saved rootfs when one exists; otherwise start the base image. */
  async start(): Promise<void> {
    await this.withLifecycleLock(async () => {
      await this.ensureContainerStarted();
    });
  }

  /** Read status without starting a stopped container. */
  async lifecycleStatus(): Promise<{ running: boolean; hasSnapshot: boolean }> {
    return {
      running: this.ctx.container?.running === true,
      hasSnapshot: (await this.ctx.storage.get<SavedSnapshot>(THREAD_SNAPSHOT_KEY)) !== undefined,
    };
  }

  async hasSnapshot(): Promise<boolean> {
    return (await this.ctx.storage.get<SavedSnapshot>(THREAD_SNAPSHOT_KEY)) !== undefined;
  }

  /** Renew the maximum supported timeout while compute is live, without waking stopped instances. */
  async alarm(): Promise<void> {
    await this.withLifecycleLock(async () => {
      const container = this.ctx.container;
      if (!container?.running) {
        await this.ctx.storage.deleteAlarm();
        return;
      }

      await container.setInactivityTimeout(KEEP_ALIVE_MS);
      await this.scheduleKeepAliveRefresh();
    });
  }

  /** The native API exposes process handles only at launch, so inspect `ps` for later RPCs. */
  async listProcesses(): Promise<{ id: string; state: string; command?: readonly string[] }[]> {
    const container = this.ctx.container;
    if (!container?.running) return [];

    const process = await container.exec(['ps', '-eo', 'pid=,stat=,args=']);
    const { stdout, exitCode } = await process.output();
    if (exitCode !== 0) throw new Error('could not inspect thread worker processes');

    const text = new TextDecoder().decode(stdout);
    const processes: { id: string; state: string; command?: readonly string[] }[] = [];
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      const [, id, state, argv] = match;
      if (argv !== WORKER_BOOT && argv !== `node /opt/anvil/boot.mjs`) continue;
      processes.push({
        id,
        state: state.startsWith('Z') ? 'exited' : 'running',
        command: [WORKER_BOOT],
      });
    }
    return processes;
  }

  /** Start the worker once, returning its native container process ID immediately. */
  async boot(bootstrap: MeshEnvironmentBootstrap): Promise<{ processId: string; reused: boolean }> {
    return this.withLifecycleLock(async () => {
      const existing = (await this.listProcesses()).find((process) => process.state === 'running');
      if (existing) return { processId: existing.id, reused: true };

      const snapshot = await this.ctx.storage.get<SavedSnapshot>(THREAD_SNAPSHOT_KEY);
      await this.ensureContainerStarted();

      // Snapshot restore discards all running processes and volatile credentials.
      // The boot script uses this flag to clear credentials before worker startup.
      const resumedBootstrap = snapshot ? { ...bootstrap, resumeFromSnapshot: true } : bootstrap;
      const process = await this.container.exec([WORKER_BOOT], {
        env: { ANVIL_BOOTSTRAP_JSON: JSON.stringify(resumedBootstrap) },
      });
      return { processId: String(process.pid), reused: false };
    });
  }

  /** Prune source authentication state, snapshot the writable rootfs, and stop compute. */
  async suspendAndSnapshot(): Promise<{ snapshotId: string; size: number }> {
    return this.withLifecycleLock(async () => this.snapshotRunningContainer());
  }

  private async snapshotRunningContainer(): Promise<{ snapshotId: string; size: number }> {
    const container = this.ctx.container;
    if (!container?.running) {
      const saved = await this.ctx.storage.get<SavedSnapshot>(THREAD_SNAPSHOT_KEY);
      if (saved) {
        await this.ctx.storage.deleteAlarm();
        return { snapshotId: saved.id, size: 0 };
      }
      throw new Error('environment is not running and has no saved snapshot');
    }

    let stopTimeoutApplied = false;
    try {
      // A Durable Object can restart without carrying its timeout configuration.
      // Keep compute available through pruning/snapshotting, then stop it explicitly.
      await container.setInactivityTimeout(KEEP_ALIVE_MS);
      const prune = await container.exec(['node', '/opt/anvil/snapshot-lifecycle.mjs', 'prune'], {
        cwd: '/opt/anvil',
        env: { ANVIL_DATA_DIR: '/var/lib/anvil' },
      });
      const pruneResult = await prune.output();
      if (pruneResult.exitCode !== 0) throw new Error('source credential pruning failed');

      const snapshot = await container.snapshotContainer({ name: 'anvil-thread-workspace' });
      const saved: SavedSnapshot = {
        id: snapshot.id,
        size: snapshot.size,
        ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
      };
      await this.ctx.storage.put(THREAD_SNAPSHOT_KEY, saved);
      await container.setInactivityTimeout(1);
      stopTimeoutApplied = true;
      await container.destroy();
      await this.ctx.storage.deleteAlarm();
      return { snapshotId: snapshot.id, size: snapshot.size };
    } catch (error) {
      // The pointer must remain retryable if destroy fails after it was stored.
      if (container.running && stopTimeoutApplied)
        await container.setInactivityTimeout(KEEP_ALIVE_MS).catch(() => undefined);
      throw error;
    }
  }

  /** Stop compute and forget the pointer; Cloudflare expires the immutable handle automatically. */
  async discardSnapshot(): Promise<void> {
    await this.withLifecycleLock(async () => {
      const container = this.ctx.container;
      if (container?.running) {
        await container.setInactivityTimeout(1);
        await container.destroy();
      }
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.delete(THREAD_SNAPSHOT_KEY);
    });
  }

  private withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation);
    this.lifecycleQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async ensureContainerStarted(): Promise<void> {
    const container = this.container;
    if (container.running) {
      await container.setInactivityTimeout(KEEP_ALIVE_MS);
      await this.scheduleKeepAliveRefresh();
      return;
    }

    const snapshot = await this.ctx.storage.get<SavedSnapshot>(THREAD_SNAPSHOT_KEY);
    if (snapshot) {
      container.start({
        containerSnapshot: { id: snapshot.id },
        enableInternet: true,
        instance: STANDARD_INSTANCE,
      });
    } else {
      container.start({
        image: container.images.base,
        enableInternet: true,
        instance: STANDARD_INSTANCE,
      });
    }
    await container.setInactivityTimeout(KEEP_ALIVE_MS);
    await this.scheduleKeepAliveRefresh();
  }

  private async scheduleKeepAliveRefresh(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + KEEP_ALIVE_REFRESH_MS);
  }
}
