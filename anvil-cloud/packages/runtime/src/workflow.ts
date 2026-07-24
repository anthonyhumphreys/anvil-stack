import type { AnyWorkflowDefinition, WorkflowState } from "./app.js";
import { createRuntimeContext } from "./context.js";
import { normaliseRuntimeError, RuntimeError } from "./errors.js";
import type {
  RuntimeHost,
  WorkflowRun,
  WorkflowRunProgress,
  WorkflowRunSummary,
  WorkflowStepRun,
} from "./host.js";
import type { TraceAdapter } from "./trace.js";
import { Effect, Either, Schedule } from "effect";

export type ExecuteWorkflowRunOptions = {
  workflow: AnyWorkflowDefinition;
  host: RuntimeHost;
  run: WorkflowRun;
  save: (run: WorkflowRun) => Promise<void>;
  retryDelayMs?: number;
};

export function createWorkflowRun(options: {
  runId: string;
  workflow: string;
  definition: AnyWorkflowDefinition;
  input: unknown;
}): WorkflowRun {
  const now = new Date().toISOString();

  return {
    runId: options.runId,
    workflow: options.workflow,
    status: "running",
    input: options.input,
    steps: options.definition.steps.map((step) => ({
      name: step.name,
      status: "pending",
      attempts: 0,
    })),
    createdAt: now,
    updatedAt: now,
  };
}

export function summarizeWorkflowRun(
  run: WorkflowRun,
  options: { active?: boolean } = {},
): WorkflowRunSummary {
  const completedSteps = run.steps.filter(
    (step) => step.status === "completed",
  ).length;
  const failedSteps = run.steps.filter(
    (step) => step.status === "failed",
  ).length;
  const runningSteps = run.steps.filter(
    (step) => step.status === "running",
  ).length;
  const pendingSteps = run.steps.filter(
    (step) => step.status === "pending",
  ).length;
  const currentStepIndex = run.steps.findIndex(
    (step) => step.status === "running" || step.status === "failed",
  );
  const nextStepIndex = run.steps.findIndex(
    (step) => step.status === "pending" || step.status === "running",
  );
  const active = options.active === true;
  const resumable = run.status === "running" && !active;
  const lifecycle =
    run.status === "completed"
      ? "completed"
      : run.status === "failed"
        ? "failed"
        : active
          ? "in-flight"
          : "resumable";
  const progress: WorkflowRunProgress = {
    lifecycle,
    resumable,
    inFlight: lifecycle === "in-flight",
    currentStep:
      currentStepIndex >= 0
        ? (run.steps[currentStepIndex]?.name ?? null)
        : null,
    currentStepIndex: currentStepIndex >= 0 ? currentStepIndex : null,
    nextStep:
      nextStepIndex >= 0 ? (run.steps[nextStepIndex]?.name ?? null) : null,
    nextStepIndex: nextStepIndex >= 0 ? nextStepIndex : null,
    completedSteps,
    failedSteps,
    runningSteps,
    pendingSteps,
    totalSteps: run.steps.length,
  };

  return {
    ...run,
    progress,
  };
}

/**
 * Executes (or resumes) a workflow run sequentially. The `save` callback is
 * awaited after every step transition so a crash mid-run leaves resumable
 * state behind. Steps already marked completed are skipped and their
 * persisted results are threaded back into `state.steps`.
 */
export async function executeWorkflowRun(
  options: ExecuteWorkflowRunOptions,
): Promise<WorkflowRun> {
  const { workflow, host, run, save } = options;
  const retryDelayMs = options.retryDelayMs ?? 50;
  const state: WorkflowState = { input: run.input, steps: {} };
  const trace = host.traces;

  run.status = "running";
  await persist(run, save);
  await trace?.start({
    traceId: run.runId,
    kind: "workflow",
    name: run.workflow,
    subjectId: run.runId,
    startedAt: run.createdAt,
    attributes: {
      workflow: run.workflow,
      input: run.input,
    },
  });

  for (const definition of workflow.steps) {
    const stepRun = ensureStepRun(run, definition.name);

    if (stepRun.status === "completed") {
      state.steps[stepRun.name] = stepRun.result;
      continue;
    }

    let lastError: RuntimeError | null = null;

    stepRun.status = "running";
    stepRun.startedAt = new Date().toISOString();
    await persist(run, save);
    await trace?.event(run.runId, {
      type: "workflow.step.started",
      name: stepRun.name,
      status: "running",
      attributes: {
        workflow: run.workflow,
        step: stepRun.name,
        attempt: stepRun.attempts + 1,
      },
    });

    // Attempts already recorded on a resumed run keep counting up, but a
    // resumed step always gets a fresh attempt budget: the retry schedule
    // allows `retries` repeats on top of the initial attempt below.
    try {
      const stepResult = await Effect.runPromise(
        Effect.either(
          executeWorkflowStepAttempt({
            definition,
            host,
            run,
            save,
            state,
            stepRun,
          }).pipe(
            Effect.retry(
              retrySchedule(Math.max(0, definition.retries ?? 0), retryDelayMs),
            ),
          ),
        ),
      );

      if (Either.isLeft(stepResult)) {
        lastError = stepResult.left;
      } else {
        stepRun.status = "completed";
        stepRun.result = stepResult.right;
        stepRun.completedAt = new Date().toISOString();
        state.steps[stepRun.name] = stepResult.right;
        await persist(run, save);
        await traceWorkflowStepCompleted(trace, run, stepRun);
      }
    } catch (error) {
      lastError = normaliseRuntimeError(error);
    }

    if (lastError) {
      stepRun.status = "failed";
      stepRun.error = {
        code: lastError.code,
        message: lastError.message,
      };
      stepRun.completedAt = new Date().toISOString();
      run.status = "failed";
      await persist(run, save);
      await traceWorkflowStepFailed(trace, run, stepRun, lastError);
      await writeWorkflowErrorLog(host, run, stepRun, lastError);

      return run;
    }
  }

  run.status = "completed";
  await persist(run, save);
  await trace?.event(run.runId, {
    type: "workflow.completed",
    name: run.workflow,
    status: "completed",
    attributes: {
      workflow: run.workflow,
      steps: run.steps.length,
    },
  });
  await trace?.complete(run.runId, { status: "completed" });

  return run;
}

async function traceWorkflowStepCompleted(
  trace: TraceAdapter | undefined,
  run: WorkflowRun,
  stepRun: WorkflowStepRun,
): Promise<void> {
  await trace?.event(run.runId, {
    type: "workflow.step.completed",
    name: stepRun.name,
    status: "completed",
    ...durationField(stepRun.startedAt, stepRun.completedAt),
    attributes: {
      workflow: run.workflow,
      step: stepRun.name,
      attempts: stepRun.attempts,
      result: stepRun.result,
    },
  });
}

async function traceWorkflowStepFailed(
  trace: TraceAdapter | undefined,
  run: WorkflowRun,
  stepRun: WorkflowStepRun,
  error: RuntimeError,
): Promise<void> {
  await trace?.event(run.runId, {
    type: "workflow.step.failed",
    name: stepRun.name,
    status: "failed",
    ...durationField(stepRun.startedAt, stepRun.completedAt),
    attributes: {
      workflow: run.workflow,
      step: stepRun.name,
      attempts: stepRun.attempts,
      error: {
        code: error.code,
        message: error.message,
      },
    },
  });
  await trace?.event(run.runId, {
    type: "workflow.failed",
    name: run.workflow,
    status: "failed",
    attributes: {
      workflow: run.workflow,
      step: stepRun.name,
      code: error.code,
    },
  });
  await trace?.complete(run.runId, { status: "failed" });
}

function durationField(
  startedAt: string | undefined,
  completedAt: string | undefined,
): { durationMs: number } | Record<never, never> {
  const durationMs = durationBetween(startedAt, completedAt);

  return durationMs === undefined ? {} : { durationMs };
}

function durationBetween(
  startedAt: string | undefined,
  completedAt: string | undefined,
): number | undefined {
  if (!startedAt || !completedAt) {
    return undefined;
  }

  const durationMs = Date.parse(completedAt) - Date.parse(startedAt);

  return Number.isFinite(durationMs) && durationMs >= 0
    ? durationMs
    : undefined;
}

type WorkflowStepAttemptOptions = {
  definition: AnyWorkflowDefinition["steps"][number];
  host: RuntimeHost;
  run: WorkflowRun;
  save: (run: WorkflowRun) => Promise<void>;
  state: WorkflowState;
  stepRun: WorkflowStepRun;
};

function executeWorkflowStepAttempt(
  options: WorkflowStepAttemptOptions,
): Effect.Effect<unknown, RuntimeError> {
  const { definition, host, run, save, state, stepRun } = options;

  return Effect.gen(function* () {
    stepRun.attempts += 1;
    yield* persistEffect(run, save);

    const ctx = yield* Effect.tryPromise({
      try: () =>
        createRuntimeContext(
          host,
          {
            kind: "workflow",
            name: run.workflow,
            input: run.input,
            requestId: `${run.runId}:${stepRun.name}:${stepRun.attempts}`,
          },
          `${run.workflow}.${stepRun.name}`,
        ),
      catch: normaliseRuntimeError,
    });

    return yield* withStepTimeout(
      Effect.tryPromise({
        try: () => Promise.resolve(definition.handler(ctx, state)),
        catch: normaliseRuntimeError,
      }),
      definition.timeoutMs,
      stepRun.name,
    );
  });
}

function persistEffect(
  run: WorkflowRun,
  save: (run: WorkflowRun) => Promise<void>,
): Effect.Effect<void, RuntimeError> {
  return Effect.tryPromise({
    try: () => persist(run, save),
    catch: normaliseRuntimeError,
  });
}

function withStepTimeout<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeoutMs: number | undefined,
  stepName: string,
): Effect.Effect<A, E | RuntimeError, R> {
  if (timeoutMs === undefined) {
    return effect;
  }

  return effect.pipe(
    Effect.timeoutFail({
      duration: `${timeoutMs} millis`,
      onTimeout: () =>
        new RuntimeError(
          "INTERNAL_ERROR",
          `Workflow step '${stepName}' timed out after ${timeoutMs}ms.`,
          500,
          { step: stepName, timeoutMs },
        ),
    }),
  );
}

function retrySchedule(retries: number, retryDelayMs: number) {
  const retryLimit = Schedule.recurs(retries);

  if (retryDelayMs <= 0) {
    return retryLimit;
  }

  return retryLimit.pipe(Schedule.addDelay(() => `${retryDelayMs} millis`));
}

function ensureStepRun(run: WorkflowRun, name: string): WorkflowStepRun {
  const existing = run.steps.find((step) => step.name === name);

  if (existing) {
    return existing;
  }

  const created: WorkflowStepRun = {
    name,
    status: "pending",
    attempts: 0,
  };

  run.steps.push(created);

  return created;
}

async function persist(
  run: WorkflowRun,
  save: (run: WorkflowRun) => Promise<void>,
): Promise<void> {
  run.updatedAt = new Date().toISOString();
  await save(run);
}

async function writeWorkflowErrorLog(
  host: RuntimeHost,
  run: WorkflowRun,
  stepRun: WorkflowStepRun,
  error: RuntimeError,
): Promise<void> {
  await host.logs.write({
    timestamp: new Date().toISOString(),
    level: "error",
    requestId: run.runId,
    kind: "workflow",
    handler: `${run.workflow}.${stepRun.name}`,
    message: error.message,
    meta: {
      code: error.code,
      runId: run.runId,
      step: stepRun.name,
      attempts: stepRun.attempts,
    },
  });
}
