import { describe, expect, it } from "vitest";

import {
  app,
  createInMemoryRuntimeHost,
  createWorkflowRun,
  executeWorkflowRun,
  handleRuntimeRequest,
  inspectAppDefinition,
  mutation,
  summarizeWorkflowRun,
  workflow,
  type WorkflowRun,
} from "../src/index.js";

function startRun(
  definition: ReturnType<typeof workflow>,
  input: unknown = {},
): WorkflowRun {
  return createWorkflowRun({
    runId: "run_test",
    workflow: "testWorkflow",
    definition,
    input,
  });
}

describe("executeWorkflowRun", () => {
  it("summarizes completed, failed, active, and resumable workflow positions", () => {
    const definition = workflow({
      steps: [
        { name: "fetch", handler: async () => ({}) },
        { name: "store", handler: async () => ({}) },
      ],
    });
    const run = startRun(definition);

    expect(summarizeWorkflowRun(run)).toMatchObject({
      status: "running",
      progress: {
        lifecycle: "resumable",
        resumable: true,
        inFlight: false,
        completedSteps: 0,
        totalSteps: 2,
        nextStep: "fetch",
        nextStepIndex: 0,
      },
    });

    expect(summarizeWorkflowRun(run, { active: true })).toMatchObject({
      progress: {
        lifecycle: "in-flight",
        resumable: false,
        inFlight: true,
      },
    });

    run.steps[0] = {
      name: "fetch",
      status: "completed",
      attempts: 1,
      result: { ok: true },
    };
    run.steps[1] = {
      name: "store",
      status: "running",
      attempts: 1,
    };

    expect(summarizeWorkflowRun(run)).toMatchObject({
      progress: {
        lifecycle: "resumable",
        currentStep: "store",
        currentStepIndex: 1,
        nextStep: "store",
        nextStepIndex: 1,
        completedSteps: 1,
      },
    });

    run.status = "failed";
    run.steps[1] = {
      name: "store",
      status: "failed",
      attempts: 2,
      error: { code: "INTERNAL_ERROR", message: "boom" },
    };

    expect(summarizeWorkflowRun(run)).toMatchObject({
      progress: {
        lifecycle: "failed",
        resumable: false,
        inFlight: false,
        failedSteps: 1,
        currentStep: "store",
      },
    });

    run.status = "completed";
    run.steps[1] = {
      name: "store",
      status: "completed",
      attempts: 1,
      result: { ok: true },
    };

    expect(summarizeWorkflowRun(run, { active: true })).toMatchObject({
      progress: {
        lifecycle: "completed",
        inFlight: false,
      },
    });

    run.status = "failed";
    run.steps[1] = {
      name: "store",
      status: "failed",
      attempts: 2,
      error: { code: "INTERNAL_ERROR", message: "boom" },
    };

    expect(summarizeWorkflowRun(run, { active: true })).toMatchObject({
      progress: {
        lifecycle: "failed",
        inFlight: false,
      },
    });
  });

  it("runs steps in order and threads prior results through state", async () => {
    const order: string[] = [];
    const definition = workflow({
      steps: [
        {
          name: "fetch",
          handler: async (_ctx, state) => {
            order.push("fetch");
            return { source: state.input };
          },
        },
        {
          name: "transform",
          handler: async (_ctx, state) => {
            order.push("transform");
            return {
              upstream: state.steps.fetch,
              transformed: true,
            };
          },
        },
      ],
    });
    const host = createInMemoryRuntimeHost();
    const saves: string[] = [];

    const run = await executeWorkflowRun({
      workflow: definition,
      host,
      run: startRun(definition, { url: "https://example.test" }),
      save: async (next) => {
        saves.push(next.status);
      },
    });

    expect(order).toEqual(["fetch", "transform"]);
    expect(run.status).toBe("completed");
    expect(run.steps).toMatchObject([
      {
        name: "fetch",
        status: "completed",
        attempts: 1,
        result: { source: { url: "https://example.test" } },
      },
      {
        name: "transform",
        status: "completed",
        attempts: 1,
        result: {
          upstream: { source: { url: "https://example.test" } },
          transformed: true,
        },
      },
    ]);
    expect(saves.length).toBeGreaterThanOrEqual(run.steps.length * 2);
  });

  it("runs steps with a null auth identity", async () => {
    const definition = workflow({
      steps: [
        {
          name: "checkAuth",
          handler: async (ctx) => ({ identity: ctx.auth.identity }),
        },
      ],
    });
    const host = createInMemoryRuntimeHost({
      auth: { userId: "ambient_user" },
    });

    const run = await executeWorkflowRun({
      workflow: definition,
      host,
      run: startRun(definition),
      save: async () => undefined,
    });

    expect(run.status).toBe("completed");
    expect(run.steps[0]?.result).toEqual({ identity: null });
  });

  it("retries failing steps up to 1 + retries attempts", async () => {
    let attempts = 0;
    const definition = workflow({
      steps: [
        {
          name: "flaky",
          retries: 2,
          handler: async () => {
            attempts += 1;

            if (attempts < 3) {
              throw new Error("transient failure");
            }

            return { attempts };
          },
        },
      ],
    });
    const host = createInMemoryRuntimeHost();

    const run = await executeWorkflowRun({
      workflow: definition,
      host,
      run: startRun(definition),
      save: async () => undefined,
      retryDelayMs: 1,
    });

    expect(attempts).toBe(3);
    expect(run.status).toBe("completed");
    expect(run.steps[0]).toMatchObject({
      status: "completed",
      attempts: 3,
      result: { attempts: 3 },
    });
  });

  it("fails a step when its timeout elapses", async () => {
    const definition = workflow({
      steps: [
        {
          name: "slow",
          timeoutMs: 10,
          handler: () =>
            new Promise((resolve) => {
              setTimeout(() => resolve("too late"), 250);
            }),
        },
      ],
    });
    const host = createInMemoryRuntimeHost();

    const run = await executeWorkflowRun({
      workflow: definition,
      host,
      run: startRun(definition),
      save: async () => undefined,
      retryDelayMs: 1,
    });

    expect(run.status).toBe("failed");
    expect(run.steps[0]).toMatchObject({
      name: "slow",
      status: "failed",
      attempts: 1,
      error: {
        code: "INTERNAL_ERROR",
        message: "Workflow step 'slow' timed out after 10ms.",
      },
    });
  });

  it("marks the run failed and stops after a step exhausts retries", async () => {
    let secondStepRan = false;
    const definition = workflow({
      steps: [
        {
          name: "explode",
          retries: 1,
          handler: async () => {
            throw new Error("boom");
          },
        },
        {
          name: "never",
          handler: async () => {
            secondStepRan = true;
            return {};
          },
        },
      ],
    });
    const host = createInMemoryRuntimeHost();

    const run = await executeWorkflowRun({
      workflow: definition,
      host,
      run: startRun(definition),
      save: async () => undefined,
      retryDelayMs: 1,
    });

    expect(run.status).toBe("failed");
    expect(run.steps[0]).toMatchObject({
      name: "explode",
      status: "failed",
      attempts: 2,
    });
    expect(run.steps[1]).toMatchObject({
      name: "never",
      status: "pending",
      attempts: 0,
    });
    expect(secondStepRan).toBe(false);
    expect(host.logs.entries).toHaveLength(1);
    expect(host.logs.entries[0]).toMatchObject({
      level: "error",
      kind: "workflow",
      handler: "testWorkflow.explode",
    });
  });

  it("resumes a run without re-executing completed steps", async () => {
    const executed: string[] = [];
    const definition = workflow({
      steps: [
        {
          name: "first",
          handler: async () => {
            executed.push("first");
            return { value: "fresh" };
          },
        },
        {
          name: "second",
          handler: async (_ctx, state) => {
            executed.push("second");
            return { sawFirst: state.steps.first };
          },
        },
      ],
    });
    const host = createInMemoryRuntimeHost();
    const interrupted = startRun(definition);

    interrupted.steps[0] = {
      name: "first",
      status: "completed",
      attempts: 1,
      result: { value: "persisted" },
    };

    const run = await executeWorkflowRun({
      workflow: definition,
      host,
      run: interrupted,
      save: async () => undefined,
    });

    expect(executed).toEqual(["second"]);
    expect(run.status).toBe("completed");
    expect(run.steps[1]?.result).toEqual({
      sawFirst: { value: "persisted" },
    });
  });
});

describe("workflow runtime requests", () => {
  it("starts a workflow run through handleRuntimeRequest", async () => {
    const cell = app({
      capabilities: { workflows: true },
      workflows: {
        syncNotes: workflow({
          steps: [{ name: "fetch", handler: async () => ({}) }],
        }),
      },
    });
    const host = createInMemoryRuntimeHost();

    const response = await handleRuntimeRequest(cell, host, {
      kind: "workflow",
      name: "syncNotes",
      input: { full: true },
      requestId: "req_workflow_1",
    });

    expect(response).toMatchObject({
      ok: true,
      status: 200,
      body: { runId: "run_1" },
    });
    expect(host.workflows.runs).toMatchObject([
      {
        runId: "run_1",
        workflow: "syncNotes",
        status: "running",
        input: { full: true },
      },
    ]);
  });

  it("returns HANDLER_NOT_FOUND for unknown workflows", async () => {
    const cell = app({});
    const host = createInMemoryRuntimeHost();

    const response = await handleRuntimeRequest(cell, host, {
      kind: "workflow",
      name: "missing",
      input: {},
      requestId: "req_workflow_2",
    });

    expect(response).toMatchObject({
      ok: false,
      status: 404,
      error: {
        code: "HANDLER_NOT_FOUND",
        message: "No workflow handler named 'missing' is defined.",
      },
    });
  });

  it("exposes ctx.workflows.start to handlers", async () => {
    const cell = app({
      capabilities: { workflows: true },
      mutations: {
        kickOff: mutation({
          handler: async (ctx) => ctx.workflows.start("syncNotes", { n: 1 }),
        }),
      },
      workflows: {
        syncNotes: workflow({
          steps: [{ name: "fetch", handler: async () => ({}) }],
        }),
      },
    });
    const host = createInMemoryRuntimeHost();

    const response = await handleRuntimeRequest(cell, host, {
      kind: "mutation",
      name: "kickOff",
      input: {},
      auth: { userId: "user_1" },
      requestId: "req_workflow_3",
    });

    expect(response).toMatchObject({
      ok: true,
      body: { runId: "run_1" },
    });
    expect(host.workflows.runs).toMatchObject([
      { workflow: "syncNotes", input: { n: 1 } },
    ]);
  });
});

describe("inspectAppDefinition workflows", () => {
  it("lists workflow names and step order", () => {
    const cell = app({
      capabilities: { workflows: true },
      workflows: {
        syncNotes: workflow({
          steps: [
            { name: "fetch", handler: async () => ({}) },
            { name: "store", handler: async () => ({}) },
          ],
        }),
      },
    });

    expect(inspectAppDefinition(cell).workflows).toEqual([
      { name: "syncNotes", steps: ["fetch", "store"] },
    ]);
  });
});
