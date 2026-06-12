import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  main,
  parsePositiveIntegerOption,
  parsePositiveNumberOption,
  parseSinceOption,
  waitForRemoteRuntime,
} from "../src/index.js";

describe("main", () => {
  it("prints help output", async () => {
    const output = await captureStdout(() => main(["help"]));

    expect(output).toContain("Anvil Cloud CLI");
    expect(output).toContain("anvil check");
    expect(output).toContain("anvil destroy --preview --app <name> --yes");
  });

  it("requires explicit confirmation before destroying AWS preview stacks", async () => {
    const originalExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      const output = await captureStdout(() =>
        main(["destroy", "--preview", "--app", "notes", "--json"]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        errors: [
          {
            code: "CONFIRMATION_REQUIRED",
          },
        ],
      });
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it("requires an app name before destroying AWS preview stacks", async () => {
    const originalExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      const output = await captureStdout(() =>
        main(["destroy", "--preview", "--yes", "--json"]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
          },
        ],
      });
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it("rejects unsupported remote AWS inspect environments", async () => {
    const originalExitCode = process.exitCode;
    const originalMetadataTable =
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;

    try {
      process.exitCode = undefined;
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE = "deployments";
      const output = await captureStdout(() =>
        main(["inspect", "--app", "notes", "--env", "production", "--json"]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
            message: "Only --env preview is supported in alpha.",
          },
        ],
      });
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode;
      restoreEnv("ANVIL_AWS_DEPLOYMENT_METADATA_TABLE", originalMetadataTable);
    }
  });

  it("rejects unsupported remote AWS log environments", async () => {
    const originalExitCode = process.exitCode;
    const originalMetadataTable =
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;

    try {
      process.exitCode = undefined;
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE = "deployments";
      const output = await captureStdout(() =>
        main(["logs", "--app", "notes", "--env", "production", "--json"]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
            message: "Only --env preview is supported in alpha.",
          },
        ],
      });
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode;
      restoreEnv("ANVIL_AWS_DEPLOYMENT_METADATA_TABLE", originalMetadataTable);
    }
  });

  it("rejects invalid remote AWS log since filters", async () => {
    const originalExitCode = process.exitCode;
    const originalMetadataTable =
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;

    try {
      process.exitCode = undefined;
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE = "deployments";
      const output = await captureStdout(() =>
        main([
          "logs",
          "--app",
          "notes",
          "--env",
          "preview",
          "--since",
          "last-week-ish",
          "--json",
        ]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
          },
        ],
      });
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode;
      restoreEnv("ANVIL_AWS_DEPLOYMENT_METADATA_TABLE", originalMetadataTable);
    }
  });

  it("rejects invalid remote AWS log limits", async () => {
    const originalExitCode = process.exitCode;
    const originalMetadataTable =
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;

    try {
      process.exitCode = undefined;
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE = "deployments";
      const output = await captureStdout(() =>
        main([
          "logs",
          "--app",
          "notes",
          "--env",
          "preview",
          "--limit",
          "0",
          "--json",
        ]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
            message: "Invalid --limit value. Use a positive whole number.",
          },
        ],
      });
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode;
      restoreEnv("ANVIL_AWS_DEPLOYMENT_METADATA_TABLE", originalMetadataTable);
    }
  });

  it("rejects unsupported remote AWS destroy environments", async () => {
    const originalExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      const output = await captureStdout(() =>
        main([
          "destroy",
          "--preview",
          "--app",
          "notes",
          "--env",
          "production",
          "--yes",
          "--json",
        ]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
            message: "Only --env preview is supported in alpha.",
          },
        ],
      });
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it("rejects invalid AWS deploy wait timeouts", async () => {
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    const originalArtifactBucket = process.env.ANVIL_AWS_ARTIFACT_BUCKET;
    const originalMetadataTable =
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cli-"));

    try {
      delete process.env.ANVIL_AWS_ARTIFACT_BUCKET;
      delete process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;
      process.exitCode = undefined;
      process.chdir(tempDir);
      await captureStdout(() => main(["new", "notes", "--json"]));
      process.chdir(path.join(tempDir, "notes"));

      const output = await captureStdout(() =>
        main([
          "deploy",
          "--preview",
          "--wait",
          "--wait-timeout",
          "0",
          "--json",
        ]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
            message:
              "Invalid --wait-timeout value. Use a positive number of seconds.",
          },
        ],
      });
      expect(process.exitCode).toBe(2);
    } finally {
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
      restoreEnv("ANVIL_AWS_ARTIFACT_BUCKET", originalArtifactBucket);
      restoreEnv("ANVIL_AWS_DEPLOYMENT_METADATA_TABLE", originalMetadataTable);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("emits AWS preview deployment plan and template JSON", async () => {
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    const originalArtifactBucket = process.env.ANVIL_AWS_ARTIFACT_BUCKET;
    const originalMetadataTable =
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cli-"));

    try {
      delete process.env.ANVIL_AWS_ARTIFACT_BUCKET;
      delete process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;
      process.chdir(tempDir);
      await captureStdout(() => main(["new", "notes", "--json"]));
      process.chdir(path.join(tempDir, "notes"));

      const output = await captureStdout(() =>
        main(["deploy", "--preview", "--json"]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        code: "AWS_PROVISIONER_NOT_CONFIGURED",
        plan: {
          cell: "notes",
        },
        template: {
          Resources: {
            RuntimeFunction: {
              Type: "AWS::Lambda::Function",
            },
          },
        },
      });
    } finally {
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
      restoreEnv("ANVIL_AWS_ARTIFACT_BUCKET", originalArtifactBucket);
      restoreEnv("ANVIL_AWS_DEPLOYMENT_METADATA_TABLE", originalMetadataTable);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("waits for remote runtime health", async () => {
    const fetches: string[] = [];
    const result = await waitForRemoteRuntime("https://runtime.example.test", {
      intervalMs: 0,
      timeoutMs: 100,
      fetchImpl: async (url) => {
        fetches.push(String(url));

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    });

    expect(result).toEqual({
      ok: true,
      url: "https://runtime.example.test/_anvil/health",
      attempts: 1,
      status: 200,
    });
    expect(fetches).toEqual(["https://runtime.example.test/_anvil/health"]);
  });

  it("waits for remote runtime health when the runtime URL has a trailing slash", async () => {
    const fetches: string[] = [];
    const result = await waitForRemoteRuntime("https://runtime.example.test/", {
      intervalMs: 0,
      timeoutMs: 100,
      fetchImpl: async (url) => {
        fetches.push(String(url));

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    });

    expect(result).toEqual({
      ok: true,
      url: "https://runtime.example.test/_anvil/health",
      attempts: 1,
      status: 200,
    });
    expect(fetches).toEqual(["https://runtime.example.test/_anvil/health"]);
  });

  it("returns a stable unhealthy result when remote runtime health never passes", async () => {
    const result = await waitForRemoteRuntime("https://runtime.example.test", {
      intervalMs: 0,
      timeoutMs: 1,
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: false }), {
          status: 503,
          headers: {
            "content-type": "application/json",
          },
        }),
    });

    expect(result).toMatchObject({
      ok: false,
      url: "https://runtime.example.test/_anvil/health",
      code: "AWS_RUNTIME_UNHEALTHY",
      status: 503,
    });
  });
});

describe("parseSinceOption", () => {
  it("parses relative log durations into CloudWatch start timestamps", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);

    expect(parseSinceOption("30s", now)).toBe(now - 30_000);
    expect(parseSinceOption("10m", now)).toBe(now - 10 * 60_000);
    expect(parseSinceOption("1h", now)).toBe(now - 60 * 60_000);
    expect(parseSinceOption("2d", now)).toBe(now - 2 * 24 * 60 * 60_000);
    expect(parseSinceOption("123456789", now)).toBe(123456789);
  });

  it("rejects ambiguous log since filters", () => {
    expect(parseSinceOption("yesterday")).toBeUndefined();
    expect(parseSinceOption("10fortnights")).toBeUndefined();
    expect(parseSinceOption("")).toBeUndefined();
  });
});

describe("positive option parsers", () => {
  it("parses positive numeric CLI options", () => {
    expect(parsePositiveNumberOption("1.5")).toBe(1.5);
    expect(parsePositiveIntegerOption("5")).toBe(5);
  });

  it("rejects zero, negative, non-numeric, and fractional integer options", () => {
    expect(parsePositiveNumberOption("0")).toBeUndefined();
    expect(parsePositiveNumberOption("-1")).toBeUndefined();
    expect(parsePositiveNumberOption("soon")).toBeUndefined();
    expect(parsePositiveIntegerOption("1.5")).toBeUndefined();
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write;
  let output = "";

  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();

    return true;
  }) as typeof process.stdout.write;

  try {
    await run();
  } finally {
    process.stdout.write = originalWrite;
  }

  return output;
}
