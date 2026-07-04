import { describe, expect, it } from "vitest";

import {
  app,
  createInMemoryRuntimeHost,
  job,
  workflow,
} from "@anvil-cloud/runtime";

import {
  createAwsLambdaRuntimeHandler,
  installOutboundFetchPolicy,
} from "../src/index.js";

describe("createAwsLambdaRuntimeHandler", () => {
  it("enforces outbound fetch allow lists in the AWS runtime", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];

    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response("ok");
      }) as typeof fetch;

      installOutboundFetchPolicy("api.example.test");

      await expect(fetch("https://api.example.test/v1")).resolves.toMatchObject(
        {
          status: 200,
        },
      );
      await expect(fetch("https://bad.example.test/v1")).rejects.toMatchObject({
        code: "OUTBOUND_FETCH_NOT_ALLOWED",
        details: {
          host: "bad.example.test",
          allowedHosts: ["api.example.test"],
        },
      });
      expect(calls).toEqual(["https://api.example.test/v1"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("runs SQS job records through the shared runtime", async () => {
    const host = createInMemoryRuntimeHost();
    const cell = app({
      jobs: {
        refreshNotes: job<{ force: boolean }>({
          handler: async (ctx, payload) => {
            await ctx.db.runs.insert({
              source: "sqs",
              force: payload.force,
            });
          },
        }),
      },
    });
    const handler = createAwsLambdaRuntimeHandler(cell, host);

    await expect(
      handler({
        Records: [
          {
            messageId: "msg_1",
            eventSource: "aws:sqs",
            body: JSON.stringify({
              name: "refreshNotes",
              payload: {
                force: true,
              },
            }),
          },
        ],
      }),
    ).resolves.toEqual({
      batchItemFailures: [],
    });
    await expect(host.db.table("runs").all()).resolves.toEqual([
      {
        id: "runs_1",
        source: "sqs",
        force: true,
      },
    ]);
  });

  it("runs scheduled EventBridge jobs through the shared runtime", async () => {
    const host = createInMemoryRuntimeHost();
    const cell = app({
      jobs: {
        refreshNotes: job({
          schedule: "rate(1 hour)",
          handler: async (ctx) => {
            await ctx.db.runs.insert({
              source: "schedule",
            });
          },
        }),
      },
    });
    const handler = createAwsLambdaRuntimeHandler(cell, host);

    await expect(
      handler({
        id: "evt_1",
        source: "anvil.jobs",
        detail: {
          name: "refreshNotes",
          payload: null,
        },
      }),
    ).resolves.toBeUndefined();
    await expect(host.db.table("runs").all()).resolves.toEqual([
      {
        id: "runs_1",
        source: "schedule",
      },
    ]);
  });

  it("runs workflow step events through the shared runtime context", async () => {
    const host = createInMemoryRuntimeHost({
      auth: { userId: "ambient_user" },
    });
    const cell = app({
      workflows: {
        syncNotes: workflow({
          steps: [
            {
              name: "transform",
              handler: async (ctx, state) => {
                await ctx.db.runs.insert({
                  source: "workflow",
                  identity: ctx.auth.identity,
                });

                return {
                  input: state.input,
                  fetched: state.steps.fetch,
                };
              },
            },
          ],
        }),
      },
    });
    const handler = createAwsLambdaRuntimeHandler(cell, host);

    await expect(
      handler({
        source: "anvil.workflows",
        detail: {
          workflow: "syncNotes",
          step: "transform",
          runId: "run_1",
          input: { userId: "user_1" },
          steps: {
            fetch: { count: 2 },
          },
        },
      }),
    ).resolves.toEqual({
      workflow: "syncNotes",
      step: "transform",
      runId: "run_1",
      input: { userId: "user_1" },
      steps: {
        fetch: { count: 2 },
        transform: {
          input: { userId: "user_1" },
          fetched: { count: 2 },
        },
      },
      result: {
        input: { userId: "user_1" },
        fetched: { count: 2 },
      },
    });
    await expect(host.db.table("runs").all()).resolves.toEqual([
      {
        id: "runs_1",
        source: "workflow",
        identity: null,
      },
    ]);
  });
});
