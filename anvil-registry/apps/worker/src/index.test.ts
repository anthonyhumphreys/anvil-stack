import { describe, expect, it } from "vitest";
import { healthCheckWorkerDependencies, runWorkerCli } from "./index.js";
import { loadConfig } from "@anvilstack/config";

describe("worker entrypoint", () => {
  it("runs dependency health checks in memory mode", async () => {
    const config = loadConfig({ ...process.env, PERSISTENCE_DRIVER: "memory", QUEUE_DRIVER: "memory" });

    await expect(healthCheckWorkerDependencies(config)).resolves.toBeUndefined();
  });

  it("exits successfully for the health-check command", async () => {
    const previousPersistence = process.env.PERSISTENCE_DRIVER;
    const previousQueue = process.env.QUEUE_DRIVER;
    process.env.PERSISTENCE_DRIVER = "memory";
    process.env.QUEUE_DRIVER = "memory";

    try {
      await expect(runWorkerCli(["--health-check"])).resolves.toBe(0);
    } finally {
      restoreEnv("PERSISTENCE_DRIVER", previousPersistence);
      restoreEnv("QUEUE_DRIVER", previousQueue);
    }
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
