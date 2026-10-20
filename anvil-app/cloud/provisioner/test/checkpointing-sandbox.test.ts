import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    protected ctx: unknown;
    constructor(ctx: unknown) {
      this.ctx = ctx;
    }
  },
}));

import { ThreadSandbox } from '../src/checkpointing-sandbox';

const BOOTSTRAP = {
  kind: 'anvil.mesh-environment' as const,
  schemaVersion: '0.2' as const,
  environmentId: 'thread_1',
  backendUrl: 'https://sync.example.test',
  enrollmentCode: 'anvil-ec-AAAAA-BBBBB',
  ttlSeconds: 900,
};

const SNAPSHOT_KEY = 'anvil:thread-workspace-snapshot';

function harness(initial = new Map<string, unknown>()) {
  const values = initial;
  const alarmSchedules: number[] = [];
  const lifecycleEvents: string[] = [];
  const storage = {
    get: vi.fn(async <T>(key: string) => values.get(key) as T | undefined),
    put: vi.fn(async <T>(key: string, value: T) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => values.delete(key)),
    setAlarm: vi.fn(async (timestamp: number) => {
      alarmSchedules.push(timestamp);
    }),
    deleteAlarm: vi.fn(async () => {
      lifecycleEvents.push('delete-alarm');
    }),
  };

  let running = false;
  const starts: unknown[] = [];
  const execCalls: { command: string[]; options?: Record<string, unknown> }[] = [];
  const inactivityTimeouts: number[] = [];
  let psOutput = '';
  let pruneExitCode = 0;
  const container = {
    get running() {
      return running;
    },
    images: { base: 'base-image-ref' },
    start: vi.fn((options: unknown) => {
      starts.push(options);
      running = true;
    }),
    setInactivityTimeout: vi.fn(async (duration: number) => {
      inactivityTimeouts.push(duration);
    }),
    exec: vi.fn(async (command: string[], options?: Record<string, unknown>) => {
      execCalls.push({ command, options });
      const isPs = command[0] === 'ps';
      const isPrune = command[1] === '/opt/anvil/snapshot-lifecycle.mjs';
      const isBoot = command[0] === '/opt/anvil/bin/anvil-worker-boot';
      return {
        pid: isBoot ? 314 : 900,
        output: async () => ({
          stdout: new TextEncoder().encode(isPs ? psOutput : '').buffer,
          stderr: new ArrayBuffer(0),
          exitCode: isPrune ? pruneExitCode : 0,
        }),
      };
    }),
    snapshotContainer: vi.fn(async () => ({
      id: 'snapshot-2',
      size: 2048,
      name: 'anvil-thread-workspace',
    })),
    destroy: vi.fn(async () => {
      lifecycleEvents.push('destroy');
      running = false;
    }),
  };
  const ctx = {
    container,
    storage,
    blockConcurrencyWhile: vi.fn(async <T>(callback: () => Promise<T>) => callback()),
  };
  const SandboxCtor = ThreadSandbox as unknown as new (ctx: unknown, env: unknown) => ThreadSandbox;
  const sandbox = new SandboxCtor(ctx, {});
  return {
    sandbox,
    storage,
    container,
    values,
    starts,
    execCalls,
    inactivityTimeouts,
    alarmSchedules,
    lifecycleEvents,
    setPsOutput(value: string) {
      psOutput = value;
    },
    setPruneExitCode(value: number) {
      pruneExitCode = value;
    },
    setRunning(value: boolean) {
      running = value;
    },
  };
}

describe('ThreadSandbox native container runner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('boots the base image with standard-1 and passes bootstrap only through the process env', async () => {
    const h = harness();

    await expect(h.sandbox.boot(BOOTSTRAP)).resolves.toEqual({ processId: '314', reused: false });

    expect(h.starts).toEqual([
      { image: 'base-image-ref', enableInternet: true, instance: 'standard-1' },
    ]);
    expect(h.execCalls[0]).toEqual({
      command: ['/opt/anvil/bin/anvil-worker-boot'],
      options: { env: { ANVIL_BOOTSTRAP_JSON: JSON.stringify(BOOTSTRAP) } },
    });
  });

  it('reuses a live worker process without restarting the container', async () => {
    const h = harness();
    h.setRunning(true);
    h.setPsOutput('  314 S node /opt/anvil/boot.mjs\n');

    await expect(h.sandbox.boot(BOOTSTRAP)).resolves.toEqual({ processId: '314', reused: true });

    expect(h.container.start).not.toHaveBeenCalled();
    expect(h.execCalls).toEqual([
      { command: ['ps', '-eo', 'pid=,stat=,args='], options: undefined },
    ]);
  });

  it('restores the snapshot and marks the bootstrap to clear volatile credentials', async () => {
    const h = harness(new Map([[SNAPSHOT_KEY, { id: 'snapshot-1', size: 512 }]]));

    await expect(h.sandbox.boot(BOOTSTRAP)).resolves.toEqual({ processId: '314', reused: false });

    expect(h.starts).toEqual([
      { containerSnapshot: { id: 'snapshot-1' }, enableInternet: true, instance: 'standard-1' },
    ]);
    const bootCall = h.execCalls.find(
      ({ command }) => command[0] === '/opt/anvil/bin/anvil-worker-boot',
    );
    expect(bootCall?.options).toEqual({
      env: { ANVIL_BOOTSTRAP_JSON: JSON.stringify({ ...BOOTSTRAP, resumeFromSnapshot: true }) },
    });
  });

  it('reports snapshots without waking a stopped container', async () => {
    const h = harness(new Map([[SNAPSHOT_KEY, { id: 'snapshot-1', size: 512 }]]));

    await expect(h.sandbox.lifecycleStatus()).resolves.toEqual({
      running: false,
      hasSnapshot: true,
    });
    await expect(h.sandbox.listProcesses()).resolves.toEqual([]);

    expect(h.container.start).not.toHaveBeenCalled();
    expect(h.container.exec).not.toHaveBeenCalled();
  });

  it('does not wake a stopped container when its refresh alarm fires', async () => {
    const h = harness(new Map([[SNAPSHOT_KEY, { id: 'snapshot-1', size: 512 }]]));

    await h.sandbox.alarm();

    expect(h.container.start).not.toHaveBeenCalled();
    expect(h.container.exec).not.toHaveBeenCalled();
    expect(h.storage.deleteAlarm).toHaveBeenCalledOnce();
    expect(h.storage.setAlarm).not.toHaveBeenCalled();
  });

  it('renews a running container and schedules the next three-hour refresh', async () => {
    const h = harness();
    h.setRunning(true);
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);

    try {
      await h.sandbox.alarm();
    } finally {
      now.mockRestore();
    }

    expect(h.inactivityTimeouts).toEqual([6 * 60 * 60 * 1000]);
    expect(h.alarmSchedules).toEqual([10_000 + 3 * 60 * 60 * 1000]);
  });

  it('serializes lifecycle calls and releases the queue after completion', async () => {
    const h = harness();

    await Promise.all([h.sandbox.start(), h.sandbox.start()]);

    expect(h.container.start).toHaveBeenCalledOnce();
    expect(h.inactivityTimeouts).toEqual([6 * 60 * 60 * 1000, 6 * 60 * 60 * 1000]);
    expect(h.alarmSchedules).toHaveLength(2);
  });

  it('prunes before checkpointing, stores the handle, and stops compute', async () => {
    const h = harness();
    h.setRunning(true);

    await expect(h.sandbox.suspendAndSnapshot()).resolves.toEqual({
      snapshotId: 'snapshot-2',
      size: 2048,
    });

    expect(h.execCalls[0]).toEqual({
      command: ['node', '/opt/anvil/snapshot-lifecycle.mjs', 'prune'],
      options: { cwd: '/opt/anvil', env: { ANVIL_DATA_DIR: '/var/lib/anvil' } },
    });
    expect(h.container.snapshotContainer).toHaveBeenCalledWith({ name: 'anvil-thread-workspace' });
    expect(h.values.get(SNAPSHOT_KEY)).toEqual({
      id: 'snapshot-2',
      size: 2048,
      name: 'anvil-thread-workspace',
    });
    expect(h.container.destroy).toHaveBeenCalledOnce();
    expect(h.inactivityTimeouts).toEqual([6 * 60 * 60 * 1000, 1]);
    expect(h.storage.deleteAlarm).toHaveBeenCalledOnce();
    expect(h.lifecycleEvents).toEqual(['destroy', 'delete-alarm']);
  });

  it('deletes the refresh alarm after discarding a running container', async () => {
    const h = harness();
    h.setRunning(true);

    await h.sandbox.discardSnapshot();

    expect(h.container.destroy).toHaveBeenCalledOnce();
    expect(h.storage.deleteAlarm).toHaveBeenCalledOnce();
    expect(h.storage.delete).toHaveBeenCalledWith(SNAPSHOT_KEY);
    expect(h.lifecycleEvents).toEqual(['destroy', 'delete-alarm']);
  });

  it('does not snapshot when credential pruning fails and restores the keep-alive timeout', async () => {
    const h = harness();
    h.setRunning(true);
    h.setPruneExitCode(1);

    await expect(h.sandbox.suspendAndSnapshot()).rejects.toThrow(
      'source credential pruning failed',
    );

    expect(h.container.snapshotContainer).not.toHaveBeenCalled();
    expect(h.container.destroy).not.toHaveBeenCalled();
    expect(h.inactivityTimeouts).toEqual([6 * 60 * 60 * 1000]);
  });
});
