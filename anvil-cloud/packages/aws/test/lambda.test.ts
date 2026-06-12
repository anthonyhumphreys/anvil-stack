import { describe, expect, it } from "vitest";

import { app, createInMemoryRuntimeHost, job } from "@anvil-cloud/runtime";

import { createAwsLambdaRuntimeHandler } from "../src/index.js";

describe("createAwsLambdaRuntimeHandler", () => {
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
});
