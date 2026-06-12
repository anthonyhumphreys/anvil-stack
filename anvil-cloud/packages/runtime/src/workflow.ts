import type { AnyWorkflowDefinition, WorkflowState } from "./app.js";
import { createRuntimeContext } from "./context.js";
import { normaliseRuntimeError, RuntimeError } from "./errors.js";
import type { RuntimeHost, WorkflowRun, WorkflowStepRun } from "./host.js";

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

    // Attempts already recorded on a resumed run keep counting up, but a
    // resumed step always gets a fresh attempt budget.
    const maxAttempts =
      stepRun.attempts + 1 + Math.max(0, definition.retries ?? 0);
    let lastError: RuntimeError | null = null;

    stepRun.status = "running";
    stepRun.startedAt = new Date().toISOString();
    await persist(run, save);

    while (stepRun.attempts < maxAttempts) {
      stepRun.attempts += 1;
      await persist(run, save);

      try {
        const ctx = await createRuntimeContext(
          host,
          {
            kind: "workflow",
            name: run.workflow,
            input: run.input,
            requestId: `${run.runId}:${stepRun.name}:${stepRun.attempts}`,
          },
          `${run.workflow}.${stepRun.name}`,
        );
        const result = await withTimeout(
          Promise.resolve(definition.handler(ctx, state)),
          definition.timeoutMs,
          stepRun.name,
        );

        stepRun.status = "completed";
        stepRun.result = result;
        stepRun.completedAt = new Date().toISOString();
        state.steps[stepRun.name] = result;
        lastError = null;
        await persist(run, save);
        break;
      } catch (error) {
        lastError = normaliseRuntimeError(error);

        if (stepRun.attempts < maxAttempts) {
          await delay(retryDelayMs);
        }
      }
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  stepName: string,
): Promise<T> {
  if (timeoutMs === undefined) {
    return promise;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new RuntimeError(
              "INTERNAL_ERROR",
              `Workflow step '${stepName}' timed out after ${timeoutMs}ms.`,
              500,
              { step: stepName, timeoutMs },
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
