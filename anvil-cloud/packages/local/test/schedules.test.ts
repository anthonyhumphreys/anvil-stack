import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { app, job } from "@anvil-cloud/runtime";

import {
  createLocalRuntimeHost,
  nextRunAt,
  parseScheduleExpression,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("local schedules", () => {
  it("parses rate, interval, and cron schedule expressions", () => {
    expect(parseScheduleExpression("rate(1 hour)")).toMatchObject({
      kind: "interval",
      intervalMs: 3_600_000,
    });
    expect(parseScheduleExpression("@every 5m")).toMatchObject({
      kind: "interval",
      intervalMs: 300_000,
    });
    expect(
      nextRunAt("*/15 * * * *", new Date("2026-07-06T12:07:30.000Z")),
    ).toEqual(new Date("2026-07-06T12:15:00.000Z"));
  });

  it("persists manual scheduled job runs", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-schedules-"));
    tempDirs.push(rootDir);
    const cell = app({
      capabilities: { scheduledJobs: true },
      jobs: {
        refresh: job({
          schedule: "rate(1 day)",
          handler: async () => ({ refreshed: true }),
        }),
      },
    });
    const host = await createLocalRuntimeHost({
      stateDir: path.join(rootDir, ".anvil/local"),
      cellName: "scheduled-cell",
    });

    host.schedules.bind(cell, host);
    await host.schedules.start();

    try {
      await expect(host.schedules.list()).resolves.toMatchObject([
        {
          name: "refresh",
          schedule: "rate(1 day)",
          overlap: "skip",
          runs: [],
        },
      ]);
      await expect(
        host.schedules.trigger("refresh", { trigger: "manual" }),
      ).resolves.toMatchObject({
        job: "refresh",
        status: "completed",
        result: { refreshed: true },
      });
      await expect(host.schedules.list()).resolves.toMatchObject([
        {
          name: "refresh",
          lastStatus: "completed",
          runs: [
            {
              job: "refresh",
              status: "completed",
              result: { refreshed: true },
            },
          ],
        },
      ]);
    } finally {
      await host.schedules.stop();
    }
  });
});
