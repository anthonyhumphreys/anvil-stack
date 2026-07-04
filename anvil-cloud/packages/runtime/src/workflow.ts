import type { AnyWorkflowDefinition, WorkflowState } from "./app.js";
import { createRuntimeContext } from "./context.js";
import { normaliseRuntimeError, RuntimeError } from "./errors.js";
import type { RuntimeHost, WorkflowRun, WorkflowStepRun } from "./host.js";
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

  run.status = "running";
  await persist(run, save);

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
      await writeWorkflowErrorLog(host, run, stepRun, lastError);

      return run;
    }
  }

  run.status = "completed";
  await persist(run, save);

  return run;
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
