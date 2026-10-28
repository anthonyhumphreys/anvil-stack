import { describe, expect, it } from "vitest";

import { app, service } from "../src/app.js";
import { ServiceSupervisor, type ServiceStatus } from "../src/service.js";
import { createInMemoryRuntimeHost } from "../src/test-host.js";

describe("ServiceSupervisor", () => {
  it("runs a service until it is stopped cleanly through the abort signal", async () => {
    const host = createInMemoryRuntimeHost();
    const cell = app({
      capabilities: { services: true },
      services: {
        heartbeat: service({
          handler: async (ctx, controls) => {
            await ctx.log.info("heartbeat started");
            await waitForAbort(controls.signal);
            expect(controls.stopping()).toBe(true);
          },
        }),
      },
    });
    const supervisor = new ServiceSupervisor({ app: cell, host });

    const started = await supervisor.start("heartbeat");

    expect(started).toMatchObject({
      name: "heartbeat",
      state: "running",
      restarts: 0,
    });
    expect(started.startedAt).toBeDefined();

    const stopped = await supervisor.stop("heartbeat");

    expect(stopped).toMatchObject({
      name: "heartbeat",
      state: "stopped",
      restarts: 0,
    });
    expect(stopped.lastError).toBeUndefined();
    expect(
      host.logs.entries.filter((entry) => entry.kind === "service"),
    ).not.toHaveLength(0);
    expect(
      host.logs.entries.find(
        (entry) =>
          entry.kind === "service" && entry.message === "Service stopped",
      ),
    ).toBeDefined();
  });

  it("restarts failing services with on-failure policy until maxRestarts", async () => {
    const host = createInMemoryRuntimeHost();
    let runs = 0;
    const cell = app({
      capabilities: { services: true },
      services: {
        flaky: service({
          restart: "on-failure",
          maxRestarts: 2,
          handler: async () => {
            runs += 1;
            throw new Error("boom");
          },
        }),
      },
    });
    const transitions: string[] = [];
    const supervisor = new ServiceSupervisor({
      app: cell,
      host,
      backoffMs: 1,
      onTransition: (status) => {
        transitions.push(status.state);
      },
    });

    await supervisor.start("flaky");
    await waitFor(
      () => supervisor.status()[0]?.state === "failed",
      "service should fail after exhausting restarts",
    );

    const [status] = supervisor.status();

    expect(status).toMatchObject({
      name: "flaky",
      state: "failed",
      restarts: 2,
    });
    expect(status?.lastError).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(runs).toBe(3);
    expect(transitions).toEqual([
      "running",
      "restarting",
      "running",
      "restarting",
      "running",
      "failed",
    ]);
  });

  it("does not restart services with the never policy", async () => {
    const host = createInMemoryRuntimeHost();
    let runs = 0;
    const cell = app({
      capabilities: { services: true },
      services: {
        once: service({
          restart: "never",
          handler: async () => {
            runs += 1;
            throw new Error("boom");
          },
        }),
      },
    });
    const supervisor = new ServiceSupervisor({ app: cell, host });

    await supervisor.start("once");
    await waitFor(
      () => supervisor.status()[0]?.state === "failed",
      "service should fail without restarting",
    );

    expect(supervisor.status()[0]).toMatchObject({
      name: "once",
      state: "failed",
      restarts: 0,
    });
    expect(runs).toBe(1);
  });

  it("restarts clean exits with the always policy and stops at the cap", async () => {
    const host = createInMemoryRuntimeHost();
    let runs = 0;
    const cell = app({
      capabilities: { services: true },
      services: {
        looping: service({
          restart: "always",
          maxRestarts: 1,
          handler: async () => {
            runs += 1;
          },
        }),
      },
    });
    const transitions: ServiceStatus[] = [];
    const supervisor = new ServiceSupervisor({
      app: cell,
      host,
      backoffMs: 1,
      onTransition: (status) => {
        transitions.push(status);
      },
    });

    await supervisor.start("looping");
    await waitFor(
      () => supervisor.status()[0]?.state === "stopped",
      "service should stop after the restart cap",
    );

    expect(supervisor.status()[0]).toMatchObject({
      name: "looping",
      state: "stopped",
      restarts: 1,
    });
    expect(runs).toBe(2);
    expect(transitions.map((status) => status.state)).toEqual([
      "running",
      "restarting",
      "running",
      "stopped",
    ]);
  });

  it("rejects unknown service names", async () => {
    const host = createInMemoryRuntimeHost();
    const supervisor = new ServiceSupervisor({ app: app({}), host });

    await expect(supervisor.start("missing")).rejects.toMatchObject({
      code: "HANDLER_NOT_FOUND",
    });
    expect(supervisor.status()).toEqual([]);
  });
});

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function waitFor(
  condition: () => boolean,
  message: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`Timed out waiting: ${message}`);
}
