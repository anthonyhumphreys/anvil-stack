import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  handleRuntimeRequest,
  RuntimeError,
  type AnyJobDefinition,
  type AppDefinition,
  type RuntimeHost,
} from "@anvil-cloud/runtime";

export type LocalScheduleOverlapPolicy = "skip" | "queue";

export type LocalScheduleRunStatus =
  | "completed"
  | "failed"
  | "running"
  | "skipped";

export type LocalScheduleRun = {
  id: string;
  job: string;
  trigger: "manual" | "scheduled";
  status: LocalScheduleRunStatus;
  scheduledFor?: string;
  startedAt: string;
  completedAt?: string;
  result?: unknown;
  error?: { code: string; message: string };
};

export type LocalScheduleStatus = {
  name: string;
  schedule: string;
  overlap: LocalScheduleOverlapPolicy;
  timeoutMs?: number;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: LocalScheduleRunStatus;
  running: boolean;
  runs: LocalScheduleRun[];
};

type LocalScheduleState = {
  schedules: LocalScheduleStatus[];
};

export type ParsedSchedule =
  | { kind: "interval"; intervalMs: number }
  | { kind: "cron"; fields: CronFields };

type CronFields = {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
};

export class LocalScheduleAdapter {
  private app: AppDefinition | null = null;
  private host: RuntimeHost | null = null;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly activeRuns = new Map<string, number>();

  constructor(private readonly filePath: string) {}

  bind(app: AppDefinition, host: RuntimeHost): void {
    this.app = app;
    this.host = host;
  }

  async start(): Promise<void> {
    await this.reconcile();

    for (const schedule of await this.list()) {
      await this.scheduleNext(schedule.name);
    }
  }

  async stop(): Promise<void> {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }

    this.timers.clear();
  }

  async list(): Promise<LocalScheduleStatus[]> {
    await this.reconcile();

    return (await this.read()).schedules;
  }

  async trigger(
    name: string,
    options: {
      payload?: unknown;
      trigger?: "manual" | "scheduled";
      scheduledFor?: Date;
    } = {},
  ): Promise<LocalScheduleRun> {
    await this.reconcile();

    const definition = this.requireScheduledJob(name);
    const existing = await this.getSchedule(name);
    const overlap = definition.overlap ?? "skip";

    if (overlap === "skip" && this.isJobRunning(name)) {
      return this.recordRun(name, {
        id: `sched_${randomUUID()}`,
        job: name,
        trigger: options.trigger ?? "manual",
        status: "skipped",
        ...(options.scheduledFor === undefined
          ? {}
          : { scheduledFor: options.scheduledFor.toISOString() }),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: {
          code: "SCHEDULE_OVERLAP_SKIPPED",
          message: `Scheduled job '${name}' is already running.`,
        },
      });
    }

    const run: LocalScheduleRun = {
      id: `sched_${randomUUID()}`,
      job: name,
      trigger: options.trigger ?? "manual",
      status: "running",
      ...(options.scheduledFor === undefined
        ? {}
        : { scheduledFor: options.scheduledFor.toISOString() }),
      startedAt: new Date().toISOString(),
    };

    await this.recordRun(name, run);
    this.beginRun(name);

    try {
      const result = await withTimeout(
        this.executeJob(name, options.payload ?? {}),
        definition.timeoutMs,
        name,
      );
      const completed: LocalScheduleRun = {
        ...run,
        status: "completed",
        completedAt: new Date().toISOString(),
        result,
      };

      return await this.recordRun(name, completed);
    } catch (error) {
      const failed: LocalScheduleRun = {
        ...run,
        status: "failed",
        completedAt: new Date().toISOString(),
        error: errorToPayload(error),
      };

      return await this.recordRun(name, failed);
    } finally {
      this.endRun(name);
      if (existing !== null) {
        await this.scheduleNext(name);
      }
    }
  }

  private async executeJob(name: string, payload: unknown): Promise<unknown> {
    const app = this.requireApp();
    const host = this.requireHost();
    const response = await handleRuntimeRequest(app, host, {
      kind: "job",
      name,
      payload,
      requestId: `schedule_${randomUUID()}`,
    });

    if (!response.ok) {
      throw new RuntimeError(
        response.error?.code ?? "INTERNAL_ERROR",
        response.error?.message ?? `Scheduled job '${name}' failed.`,
        response.status,
        { schedule: name },
      );
    }

    return response.body;
  }

  private async reconcile(): Promise<void> {
    const app = this.requireApp();
    const declared = Object.entries(app.jobs ?? {}).filter(
      (entry): entry is [string, AnyJobDefinition] =>
        entry[1].schedule !== undefined,
    );
    const state = await this.read();
    const existing = new Map(
      state.schedules.map((schedule) => [schedule.name, schedule]),
    );
    const schedules = declared.map(([name, definition]) => {
      const previous = existing.get(name);

      const schedule: LocalScheduleStatus = {
        name,
        schedule: definition.schedule ?? "",
        overlap: definition.overlap ?? "skip",
        ...(definition.timeoutMs === undefined
          ? {}
          : { timeoutMs: definition.timeoutMs }),
        nextRunAt:
          previous?.nextRunAt ??
          nextRunAt(definition.schedule ?? "", new Date()).toISOString(),
        ...(previous?.lastRunAt === undefined
          ? {}
          : { lastRunAt: previous.lastRunAt }),
        ...(previous?.lastStatus === undefined
          ? {}
          : { lastStatus: previous.lastStatus }),
        running: this.isJobRunning(name),
        runs: previous?.runs ?? [],
      };

      return schedule;
    });

    await this.write({ schedules });
  }

  private async scheduleNext(name: string): Promise<void> {
    const app = this.app;
    const definition = app?.jobs?.[name];

    if (!definition?.schedule) {
      return;
    }

    const dueAt = nextRunAt(definition.schedule, new Date());
    const delay = Math.max(0, dueAt.getTime() - Date.now());
    const boundedDelay = Math.min(delay, 2_147_483_647);
    const existing = this.timers.get(name);

    if (existing) {
      clearTimeout(existing);
    }

    this.timers.set(
      name,
      setTimeout(() => {
        void this.trigger(name, {
          trigger: "scheduled",
          scheduledFor: dueAt,
        }).catch(() => {
          // Failures are recorded on the persisted schedule run.
        });
      }, boundedDelay),
    );

    await this.updateSchedule(name, {
      nextRunAt: dueAt.toISOString(),
      running: this.isJobRunning(name),
    });
  }

  private isJobRunning(name: string): boolean {
    return (this.activeRuns.get(name) ?? 0) > 0;
  }

  private beginRun(name: string): void {
    this.activeRuns.set(name, (this.activeRuns.get(name) ?? 0) + 1);
  }

  private endRun(name: string): void {
    const count = this.activeRuns.get(name) ?? 0;

    if (count <= 1) {
      this.activeRuns.delete(name);
      return;
    }

    this.activeRuns.set(name, count - 1);
  }

  private async getSchedule(name: string): Promise<LocalScheduleStatus | null> {
    const state = await this.read();

    return state.schedules.find((schedule) => schedule.name === name) ?? null;
  }

  private async updateSchedule(
    name: string,
    patch: Partial<LocalScheduleStatus>,
  ): Promise<void> {
    const state = await this.read();

    await this.write({
      schedules: state.schedules.map((schedule) =>
        schedule.name === name ? { ...schedule, ...patch } : schedule,
      ),
    });
  }

  private async recordRun(
    name: string,
    run: LocalScheduleRun,
  ): Promise<LocalScheduleRun> {
    const state = await this.read();
    const schedules = state.schedules.map((schedule) => {
      if (schedule.name !== name) {
        return schedule;
      }

      const runs = [
        run,
        ...schedule.runs.filter((entry) => entry.id !== run.id),
      ].slice(0, 20);

      return {
        ...schedule,
        running: run.status === "running",
        lastRunAt: run.completedAt ?? run.startedAt,
        lastStatus: run.status,
        runs,
      };
    });

    await this.write({ schedules });

    return run;
  }

  private async read(): Promise<LocalScheduleState> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as
        | LocalScheduleState
        | LocalScheduleStatus[];

      if (Array.isArray(parsed)) {
        return { schedules: parsed };
      }

      if (
        typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray(parsed.schedules)
      ) {
        return parsed;
      }
    } catch {
      return { schedules: [] };
    }

    return { schedules: [] };
  }

  private async write(state: LocalScheduleState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
  }

  private requireScheduledJob(name: string): AnyJobDefinition {
    const definition = this.requireApp().jobs?.[name];

    if (!definition?.schedule) {
      throw new RuntimeError(
        "HANDLER_NOT_FOUND",
        `No scheduled job '${name}' is defined.`,
        404,
      );
    }

    return definition;
  }

  private requireApp(): AppDefinition {
    if (!this.app) {
      throw new RuntimeError(
        "ADAPTER_ERROR",
        "Local schedule adapter is not bound to an app definition yet.",
        500,
      );
    }

    return this.app;
  }

  private requireHost(): RuntimeHost {
    if (!this.host) {
      throw new RuntimeError(
        "ADAPTER_ERROR",
        "Local schedule adapter is not bound to a runtime host yet.",
        500,
      );
    }

    return this.host;
  }
}

export function parseScheduleExpression(expression: string): ParsedSchedule {
  const trimmed = expression.trim();
  const every = /^@every\s+(\d+)\s*(ms|s|m|h|d)$/.exec(trimmed);

  if (every) {
    return {
      kind: "interval",
      intervalMs: durationToMs(every[1] ?? "0", every[2] ?? "ms"),
    };
  }

  const rate =
    /^rate\(\s*(\d+)\s+(minute|minutes|hour|hours|day|days)\s*\)$/.exec(
      trimmed,
    );

  if (rate) {
    return {
      kind: "interval",
      intervalMs: durationToMs(rate[1] ?? "0", rate[2] ?? "minutes"),
    };
  }

  const cron = trimmed.split(/\s+/);

  if (cron.length === 5) {
    return {
      kind: "cron",
      fields: {
        minutes: parseCronField(cron[0] ?? "*", 0, 59),
        hours: parseCronField(cron[1] ?? "*", 0, 23),
        days: parseCronField(cron[2] ?? "*", 1, 31),
        months: parseCronField(cron[3] ?? "*", 1, 12),
        weekdays: parseCronField(cron[4] ?? "*", 0, 7),
      },
    };
  }

  throw new RuntimeError(
    "VALIDATION_ERROR",
    `Unsupported schedule expression '${expression}'. Use rate(1 hour), @every 5m, or a five-field cron expression.`,
    400,
  );
}

export function nextRunAt(expression: string, from: Date = new Date()): Date {
  const parsed = parseScheduleExpression(expression);

  if (parsed.kind === "interval") {
    return new Date(from.getTime() + parsed.intervalMs);
  }

  const candidate = new Date(from);

  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  for (let index = 0; index < 366 * 24 * 60; index += 1) {
    const weekday = candidate.getUTCDay();
    const weekdayMatches =
      parsed.fields.weekdays.has(weekday) ||
      (weekday === 0 && parsed.fields.weekdays.has(7));

    if (
      parsed.fields.minutes.has(candidate.getUTCMinutes()) &&
      parsed.fields.hours.has(candidate.getUTCHours()) &&
      parsed.fields.days.has(candidate.getUTCDate()) &&
      parsed.fields.months.has(candidate.getUTCMonth() + 1) &&
      weekdayMatches
    ) {
      return candidate;
    }

    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  throw new RuntimeError(
    "VALIDATION_ERROR",
    `Could not find the next run for '${expression}' within one year.`,
    400,
  );
}

function parseCronField(raw: string, min: number, max: number): Set<number> {
  if (raw === "*") {
    return range(min, max);
  }

  const step = /^\*\/(\d+)$/.exec(raw);

  if (step) {
    const interval = Number(step[1]);

    if (!Number.isInteger(interval) || interval <= 0) {
      throw invalidCron(raw);
    }

    const values = new Set<number>();

    for (let value = min; value <= max; value += interval) {
      values.add(value);
    }

    return values;
  }

  const values = new Set<number>();

  for (const part of raw.split(",")) {
    const value = Number(part);

    if (!Number.isInteger(value) || value < min || value > max) {
      throw invalidCron(raw);
    }

    values.add(value);
  }

  return values;
}

function range(min: number, max: number): Set<number> {
  const values = new Set<number>();

  for (let value = min; value <= max; value += 1) {
    values.add(value);
  }

  return values;
}

function invalidCron(value: string): RuntimeError {
  return new RuntimeError(
    "VALIDATION_ERROR",
    `Unsupported cron field '${value}'. Use '*', '*/n', or comma-separated numbers.`,
    400,
  );
}

function durationToMs(amountText: string, unit: string): number {
  const amount = Number(amountText);
  const normalized = unit.toLowerCase();
  const multiplier =
    normalized === "ms"
      ? 1
      : normalized === "s"
        ? 1_000
        : normalized === "m" ||
            normalized === "minute" ||
            normalized === "minutes"
          ? 60_000
          : normalized === "h" ||
              normalized === "hour" ||
              normalized === "hours"
            ? 60 * 60_000
            : normalized === "d" ||
                normalized === "day" ||
                normalized === "days"
              ? 24 * 60 * 60_000
              : 0;

  if (!Number.isInteger(amount) || amount <= 0 || multiplier === 0) {
    throw new RuntimeError(
      "VALIDATION_ERROR",
      `Invalid schedule duration '${amountText}${unit}'.`,
      400,
    );
  }

  return amount * multiplier;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  name: string,
): Promise<T> {
  if (timeoutMs === undefined) {
    return promise;
  }

  let timer: NodeJS.Timeout;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new RuntimeError(
              "INTERNAL_ERROR",
              `Scheduled job '${name}' exceeded timeout ${timeoutMs}ms.`,
              500,
              { name, timeoutMs },
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

function errorToPayload(error: unknown): { code: string; message: string } {
  if (error instanceof RuntimeError) {
    return { code: error.code, message: error.message };
  }

  return {
    code: "SCHEDULE_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}
