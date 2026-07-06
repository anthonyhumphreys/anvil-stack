import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { app, workflow, type WorkflowRun } from "@anvil-cloud/runtime";

import {
  createLocalRuntimeHost,
  startLocalRuntimeServer,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function syncWorkflowApp() {
  return app({
    capabilities: { workflows: true },
    workflows: {
      syncNotes: workflow({
        steps: [
          {
            name: "fetch",
            handler: async (_ctx, state) => ({ fetched: state.input }),
          },
          {
            name: "store",
            handler: async (_ctx, state) => ({
              stored: state.steps.fetch,
            }),
          },
        ],
      }),
    },
  });
}

describe("LocalWorkflowAdapter", () => {
  it("persists run state to workflows.json after every step transition", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-workflows-"));
    tempDirs.push(rootDir);

    const stateDir = path.join(rootDir, ".anvil/local");
    const host = await createLocalRuntimeHost({
      stateDir,
      cellName: "notes",
    });

    host.workflows.bind(syncWorkflowApp(), host);

    const run = await host.workflows.startAndWait("syncNotes", { n: 1 });

    expect(run.status).toBe("completed");
    expect(run.steps).toMatchObject([
      { name: "fetch", status: "completed", attempts: 1 },
      {
        name: "store",
        status: "completed",
        attempts: 1,
        result: { stored: { fetched: { n: 1 } } },
      },
    ]);

    const persisted = JSON.parse(
      await readFile(path.join(stateDir, "workflows.json"), "utf8"),
    ) as WorkflowRun[];

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      runId: run.runId,
      workflow: "syncNotes",
      status: "completed",
      steps: [
        { name: "fetch", status: "completed" },
        { name: "store", status: "completed" },
      ],
    });
  });

  it("persists a failed run with step error details", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-workflows-"));
    tempDirs.push(rootDir);

    const stateDir = path.join(rootDir, ".anvil/local");
    const host = await createLocalRuntimeHost({
      stateDir,
      cellName: "notes",
    });

    host.workflows.bind(
      app({
        capabilities: { workflows: true },
        workflows: {
          failing: workflow({
            steps: [
              {
                name: "explode",
                retries: 1,
                handler: async () => {
                  throw new Error("boom");
                },
              },
            ],
          }),
        },
      }),
      host,
    );

    const run = await host.workflows.startAndWait("failing", {});

    expect(run.status).toBe("failed");

    const persisted = JSON.parse(
      await readFile(path.join(stateDir, "workflows.json"), "utf8"),
    ) as WorkflowRun[];

    expect(persisted[0]).toMatchObject({
      status: "failed",
      steps: [
        {
          name: "explode",
          status: "failed",
          attempts: 2,
          error: { code: "INTERNAL_ERROR" },
        },
      ],
    });
  });

  it("resumes interrupted runs without re-executing completed steps", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-workflows-"));
    tempDirs.push(rootDir);

    const stateDir = path.join(rootDir, ".anvil/local");
    const interrupted: WorkflowRun = {
      runId: "run_interrupted",
      workflow: "syncNotes",
      status: "running",
      input: { n: 7 },
      steps: [
        {
          name: "fetch",
          status: "completed",
          attempts: 1,
          result: { fetched: "persisted-before-crash" },
        },
        { name: "store", status: "running", attempts: 1 },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "workflows.json"),
      `${JSON.stringify([interrupted], null, 2)}\n`,
      "utf8",
    );

    const host = await createLocalRuntimeHost({
      stateDir,
      cellName: "notes",
    });

    host.workflows.bind(syncWorkflowApp(), host);

    const [resumed] = await host.workflows.resumeInterrupted();

    expect(resumed).toMatchObject({
      runId: "run_interrupted",
      status: "completed",
      steps: [
        {
          name: "fetch",
          status: "completed",
          attempts: 1,
          result: { fetched: "persisted-before-crash" },
        },
        {
          name: "store",
          status: "completed",
          attempts: 2,
          result: { stored: { fetched: "persisted-before-crash" } },
        },
      ],
    });
    await expect(
      host.workflows.getRun("run_interrupted"),
    ).resolves.toMatchObject({
      status: "completed",
    });
  });
});

describe("local workflow HTTP routes", () => {
  it("starts, lists, and shows workflow runs", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-workflows-"));
    tempDirs.push(rootDir);

    const server = await startLocalRuntimeServer({
      app: syncWorkflowApp(),
      manifest: { workflows: [{ name: "syncNotes" }] },
      rootDir,
      cellName: "notes",
      port: 0,
      clientPort: 0,
    });

    try {
      const started = (await postJson(
        `${server.runtimeUrl}/_anvil/workflows/run/syncNotes`,
        { input: { n: 2 } },
      )) as { ok: boolean; runId: string };

      expect(started.ok).toBe(true);
      expect(started.runId).toMatch(/^run_/);

      await server.host.workflows.waitForActiveRuns();

      await expect(
        fetchJson(`${server.runtimeUrl}/_anvil/workflows`),
      ).resolves.toMatchObject({
        ok: true,
        runs: [
          {
            runId: started.runId,
            workflow: "syncNotes",
            status: "completed",
          },
        ],
      });
      await expect(
        fetchJson(`${server.runtimeUrl}/_anvil/workflows/${started.runId}`),
      ).resolves.toMatchObject({
        ok: true,
        run: {
          runId: started.runId,
          status: "completed",
          steps: [
            { name: "fetch", status: "completed" },
            { name: "store", status: "completed" },
          ],
        },
      });
      await expect(
        fetchJson(`${server.runtimeUrl}/_anvil/workflows/run_missing`),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
      await expect(
        postJson(`${server.runtimeUrl}/_anvil/workflows/run/missing`, {}),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "HANDLER_NOT_FOUND" },
      });
    } finally {
      await server.close();
    }
  });

  it("enforces outbound fetch allow lists during local workflow runs", async () => {
    const originalFetch = globalThis.fetch;
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-workflows-"));
    tempDirs.push(rootDir);

    const server = await startLocalRuntimeServer({
      app: app({
        capabilities: {
          workflows: true,
          outboundFetch: { allow: ["api.example.test"] },
        },
        workflows: {
          blockedSync: workflow({
            steps: [
              {
                name: "fetch",
                handler: async () => {
                  await fetch("https://billing.example.test/v1");
                },
              },
            ],
          }),
        },
      }),
      manifest: {
        capabilities: {
          outboundFetch: { allow: ["api.example.test"] },
        },
        workflows: [{ name: "blockedSync", steps: ["fetch"] }],
      },
      rootDir,
      cellName: "notes",
      port: 0,
      clientPort: 0,
    });

    try {
      globalThis.fetch = (async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);

        if (url.startsWith(server.runtimeUrl)) {
          return originalFetch(input, init);
        }

        return new Response("ok");
      }) as typeof fetch;

      const started = (await postJson(
        `${server.runtimeUrl}/_anvil/workflows/run/blockedSync`,
        { input: {} },
      )) as { ok: boolean; runId: string };

      expect(started.ok).toBe(true);

      await server.host.workflows.waitForActiveRuns();
      await expect(
        fetchJson(`${server.runtimeUrl}/_anvil/workflows/${started.runId}`),
      ).resolves.toMatchObject({
        ok: true,
        run: {
          status: "failed",
          steps: [
            {
              name: "fetch",
              status: "failed",
              error: {
                code: "OUTBOUND_FETCH_NOT_ALLOWED",
              },
            },
          ],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
      await server.close();
    }
  });
});

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return response.json();
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);

  return response.json();
}
