import type {
  AnyServiceDefinition,
  AppDefinition,
  ServiceRestartPolicy,
} from "./app.js";
import { createRuntimeContext } from "./context.js";
import { normaliseRuntimeError, RuntimeError } from "./errors.js";
import type { RuntimeHost } from "./host.js";

export type ServiceRunState = "running" | "stopped" | "failed" | "restarting";

export type ServiceStatus = {
  name: string;
  state: ServiceRunState;
  restarts: number;
  startedAt?: string;
  lastError?: { code: string; message: string };
};

export type ServiceSupervisorOptions = {
  app: AppDefinition;
  host: RuntimeHost;
  /** Base backoff before the first restart. Defaults to 100ms. */
  backoffMs?: number;
  /** Upper bound for exponential backoff. Defaults to 5000ms. */
  maxBackoffMs?: number;
  /** How long stop() waits for a handler to exit. Defaults to 5000ms. */
  stopTimeoutMs?: number;
  /** Invoked after every recorded state transition. */
  onTransition?: (status: ServiceStatus) => void | Promise<void>;
};

type ServiceRecord = {
  name: string;
  definition: AnyServiceDefinition;
  state: ServiceRunState;
  restarts: number;
  startedAt?: string;
  lastError?: { code: string; message: string };
  controller: AbortController | null;
  runPromise: Promise<void> | null;
  stopRequested: boolean;
};

const defaultRestartPolicy: ServiceRestartPolicy = "on-failure";
const defaultMaxRestarts = 5;

/**
 * Provider-neutral supervisor for long-running service handlers.
 *
 * The supervisor owns the lifecycle of every service declared on an app
 * definition: it starts handlers, applies the restart policy with capped
 * exponential backoff, stops handlers through an AbortSignal, and records
 * state transitions through the host log adapter.
 */
export class ServiceSupervisor {
  private readonly records = new Map<string, ServiceRecord>();
  private readonly app: AppDefinition;
  private readonly host: RuntimeHost;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly stopTimeoutMs: number;
  private readonly onTransition:
    | ((status: ServiceStatus) => void | Promise<void>)
    | undefined;

  constructor(options: ServiceSupervisorOptions) {
    this.app = options.app;
    this.host = options.host;
    this.backoffMs = options.backoffMs ?? 100;
    this.maxBackoffMs = options.maxBackoffMs ?? 5000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5000;
    this.onTransition = options.onTransition;

    for (const [name, definition] of Object.entries(this.app.services ?? {})) {
      this.records.set(name, {
        name,
        definition,
        state: "stopped",
        restarts: 0,
        controller: null,
        runPromise: null,
        stopRequested: false,
      });
    }
  }

  /** Starts every declared service that is not already running. */
  async startAll(): Promise<ServiceStatus[]> {
    const started: ServiceStatus[] = [];

    for (const name of this.records.keys()) {
      started.push(await this.start(name));
    }

    return started;
  }

  /** Stops every active service and waits (bounded) for handlers to exit. */
  async stopAll(): Promise<ServiceStatus[]> {
    const stopped: ServiceStatus[] = [];

    for (const name of this.records.keys()) {
      stopped.push(await this.stop(name));
    }

    return stopped;
  }

  /** Starts a declared service. No-op if the service is already active. */
  async start(name: string): Promise<ServiceStatus> {
    const record = this.requireRecord(name);

    if (record.runPromise) {
      return this.statusOf(record);
    }

    record.stopRequested = false;
    record.restarts = 0;
    delete record.lastError;

    let onStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      onStarted = resolve;
    });

    record.runPromise = this.runSupervised(record, onStarted).finally(() => {
      record.runPromise = null;
      record.controller = null;
      onStarted();
    });

    // Wait for the first recorded transition so callers immediately observe
    // a running (or already exited) state.
    await started;

    return this.statusOf(record);
  }

  /**
   * Stops a service by aborting its AbortSignal, then waits for the handler
   * to exit. The wait is bounded by stopTimeoutMs; a handler that ignores the
   * signal is recorded as stopped anyway and a warning is logged.
   */
  async stop(name: string): Promise<ServiceStatus> {
    const record = this.requireRecord(name);

    if (!record.runPromise) {
      return this.statusOf(record);
    }

    record.stopRequested = true;
    record.controller?.abort();

    const exited = await withinTimeout(record.runPromise, this.stopTimeoutMs);

    if (!exited) {
      await this.writeLog(record, "warn", "Service did not exit in time", {
        stopTimeoutMs: this.stopTimeoutMs,
      });
      await this.transition(record, "stopped");
    }

    return this.statusOf(record);
  }

  /** Snapshot of every declared service. */
  status(): ServiceStatus[] {
    return Array.from(this.records.values(), (record) => this.statusOf(record));
  }

  private async runSupervised(
    record: ServiceRecord,
    onStarted: () => void,
  ): Promise<void> {
    const restartPolicy = record.definition.restart ?? defaultRestartPolicy;
    const maxRestarts = record.definition.maxRestarts ?? defaultMaxRestarts;
    let run = 0;

    while (!record.stopRequested) {
      const controller = new AbortController();

      record.controller = controller;
      record.startedAt = new Date().toISOString();
      run += 1;
      await this.transition(record, "running");
      onStarted();

      let failure: RuntimeError | null = null;

      try {
        const ctx = await createRuntimeContext(
          this.host,
          {
            kind: "service",
            name: record.name,
            requestId: `service:${record.name}:${run}`,
          },
          record.name,
        );

        await record.definition.handler(ctx, {
          signal: controller.signal,
          stopping: () => controller.signal.aborted,
        });
      } catch (error) {
        failure = normaliseRuntimeError(error);
      }

      if (record.stopRequested) {
        await this.transition(record, "stopped");
        return;
      }

      if (failure) {
        record.lastError = {
          code: failure.code,
          message: failure.message,
        };
        await this.writeLog(record, "error", failure.message, {
          code: failure.code,
        });

        if (restartPolicy === "never" || record.restarts >= maxRestarts) {
          await this.transition(record, "failed");
          return;
        }
      } else if (restartPolicy !== "always" || record.restarts >= maxRestarts) {
        // The handler returned cleanly; only "always" services restart.
        await this.transition(record, "stopped");
        return;
      }

      await this.transition(record, "restarting");
      record.restarts += 1;

      // A fresh controller lets stop() interrupt the backoff delay.
      const backoffController = new AbortController();

      record.controller = backoffController;
      await abortableDelay(
        this.backoffDelay(record.restarts),
        backoffController.signal,
      );
    }

    await this.transition(record, "stopped");
  }

  private backoffDelay(restarts: number): number {
    return Math.min(
      this.backoffMs * 2 ** Math.max(0, restarts - 1),
      this.maxBackoffMs,
    );
  }

  private async transition(
    record: ServiceRecord,
    state: ServiceRunState,
  ): Promise<void> {
    record.state = state;
    await this.writeLog(record, "info", `Service ${state}`, {
      state,
      restarts: record.restarts,
    });
    await this.onTransition?.(this.statusOf(record));
  }

  private async writeLog(
    record: ServiceRecord,
    level: "info" | "warn" | "error",
    message: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.host.logs.write({
        timestamp: new Date().toISOString(),
        level,
        requestId: `service:${record.name}`,
        kind: "service",
        handler: record.name,
        message,
        meta,
      });
    } catch {
      // Lifecycle bookkeeping must not crash the supervisor.
    }
  }

  private statusOf(record: ServiceRecord): ServiceStatus {
    const status: ServiceStatus = {
      name: record.name,
      state: record.state,
      restarts: record.restarts,
    };

    if (record.startedAt !== undefined) {
      status.startedAt = record.startedAt;
    }

    if (record.lastError !== undefined) {
      status.lastError = { ...record.lastError };
    }

    return status;
  }

  private requireRecord(name: string): ServiceRecord {
    const record = this.records.get(name);

    if (!record) {
      throw new RuntimeError(
        "HANDLER_NOT_FOUND",
        `No service handler named '${name}' is defined.`,
        404,
        { kind: "service", name },
      );
    }

    return record;
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function withinTimeout(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
