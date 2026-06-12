import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { app, service } from "@anvil-cloud/runtime";

import { startLocalRuntimeServer } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function heartbeatApp() {
  return app({
    capabilities: { services: true },
    services: {
      heartbeat: service({
        handler: async (_ctx, controls) => {
          await new Promise<void>((resolve) => {
            if (controls.signal.aborted) {
              resolve();
              return;
            }

            controls.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        },
      }),
    },
  });
}

describe("local service supervision", () => {
  it("starts declared services with the server and serves status routes", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-services-"));
    tempDirs.push(rootDir);

    const server = await startLocalRuntimeServer({
      app: heartbeatApp(),
      manifest: {},
      rootDir,
      cellName: "notes",
      port: 0,
      clientPort: 0,
    });

    try {
      expect(server.services.status()).toMatchObject([
        { name: "heartbeat", state: "running", restarts: 0 },
      ]);

      await expect(
        fetchJson(`${server.runtimeUrl}/_anvil/services`),
      ).resolves.toMatchObject({
        ok: true,
        services: [{ name: "heartbeat", state: "running", restarts: 0 }],
      });
    } finally {
      await server.close();
    }

    expect(server.services.status()).toMatchObject([
      { name: "heartbeat", state: "stopped" },
    ]);
  });

  it("supports stop and start routes and persists status snapshots", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-services-"));
    tempDirs.push(rootDir);

    const server = await startLocalRuntimeServer({
      app: heartbeatApp(),
      manifest: {},
      rootDir,
      cellName: "notes",
      port: 0,
      clientPort: 0,
    });

    try {
      await expect(
        postJson(`${server.runtimeUrl}/_anvil/services/heartbeat/stop`, {}),
      ).resolves.toMatchObject({
        ok: true,
        service: { name: "heartbeat", state: "stopped" },
      });

      const snapshotPath = path.join(rootDir, ".anvil/local/services.json");
      const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
        updatedAt: string;
        services: Array<Record<string, unknown>>;
      };

      expect(snapshot.updatedAt).toBeDefined();
      expect(snapshot.services).toMatchObject([
        { name: "heartbeat", state: "stopped" },
      ]);

      await expect(
        postJson(`${server.runtimeUrl}/_anvil/services/heartbeat/start`, {}),
      ).resolves.toMatchObject({
        ok: true,
        service: { name: "heartbeat", state: "running" },
      });

      await expect(
        postJson(`${server.runtimeUrl}/_anvil/services/missing/stop`, {}),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "HANDLER_NOT_FOUND" },
      });
    } finally {
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
