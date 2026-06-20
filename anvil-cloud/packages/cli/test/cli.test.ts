import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  main,
  parsePositiveIntegerOption,
  parsePositiveNumberOption,
  parseSinceOption,
  waitForRemoteRuntime,
} from "../src/index.js";

const testCwd = process.cwd();

afterEach(() => {
  process.chdir(testCwd);
});

describe("main", () => {
  it("prints help output", async () => {
    const output = await captureStdout(() => main(["help"]));

    expect(output).toContain("Anvil Cloud CLI");
    expect(output).toContain("anvil-cloud check");
    expect(output).toContain("anvil-cloud destroy --preview --app <name> --yes");
  });

  it("scaffolds a Vite React client by default", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cli-"));
    const originalCwd = process.cwd();

    try {
      process.chdir(rootDir);
      const output = await captureStdout(() =>
        main(["new", "react-notes", "--json"]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;
      const cellDir = path.join(rootDir, "react-notes");
      const anvilConfig = JSON.parse(
        await readFile(path.join(cellDir, "anvil.json"), "utf8"),
      ) as { entrypoints: { client: string } };
      const packageJson = JSON.parse(
        await readFile(path.join(cellDir, "package.json"), "utf8"),
      ) as {
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };

      expect(payload).toMatchObject({
        ok: true,
        cell: "react-notes",
      });
      expect(anvilConfig.entrypoints.client).toBe("src/client/main.tsx");
      expect(packageJson.dependencies).toMatchObject({
        "@anvil-cloud/client": "workspace:*",
        "@vitejs/plugin-react": expect.any(String),
        react: expect.any(String),
        "react-dom": expect.any(String),
        vite: expect.any(String),
      });
      expect(packageJson.devDependencies).toMatchObject({
        "@types/react": expect.any(String),
        "@types/react-dom": expect.any(String),
        typescript: expect.any(String),
      });
      await expect(
        readFile(path.join(cellDir, "src/client/App.tsx"), "utf8"),
      ).resolves.toContain('import { api } from "@anvil/generated/client";');
      await expect(
        readFile(path.join(cellDir, "vite.config.ts"), "utf8"),
      ).resolves.toContain("@vitejs/plugin-react");
      await expect(
        readFile(path.join(cellDir, "index.html"), "utf8"),
      ).resolves.toContain("/src/client/main.tsx");
    } finally {
      process.chdir(originalCwd);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("prints check diagnostics as stable JSON", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cli-"));
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      process.chdir(rootDir);
      await writeFile(
        path.join(rootDir, "anvil.json"),
        JSON.stringify({
          name: "bad-cell",
          runtime: "nodejs20",
          entrypoints: {
            server: "src/cell.server.ts",
            client: "src/client/main.tsx",
          },
        }),
        "utf8",
      );
      await mkdir(path.join(rootDir, "src"), { recursive: true });
      await mkdir(path.join(rootDir, "src/client"), { recursive: true });
      await writeFile(
        path.join(rootDir, "src/cell.server.ts"),
        [
          'import { readFileSync } from "node:fs";',
          'import { app } from "@anvil-cloud/runtime";',
          "",
          "void readFileSync;",
          "export default app({});",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        path.join(rootDir, "src/client/main.tsx"),
        "document.body.textContent = 'bad cell';\n",
        "utf8",
      );

      const output = await captureStdout(() => main(["check", "--json"]));
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        phase: "import-policy",
        diagnostics: [
          {
            code: "FORBIDDEN_IMPORT",
            file: "src/cell.server.ts",
            hint: "Use ctx.files for Cell-owned file storage.",
          },
        ],
        errors: [
          {
            code: "FORBIDDEN_IMPORT",
          },
        ],
      });
      expect(payload.diagnostics).toEqual(payload.errors);
      expect(process.exitCode).toBe(3);
    } finally {
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("validates, emits, and invokes mounted agents", async () => {
    const rootDir = await createAgentCell();
    const originalCwd = process.cwd();

    try {
      process.chdir(rootDir);

      const validateOutput = await captureStdout(() =>
        main(["agents", "validate", "--json"]),
      );
      const validatePayload = JSON.parse(validateOutput) as Record<
        string,
        unknown
      >;

      expect(validatePayload).toMatchObject({
        ok: true,
        agents: ["support"],
        providers: ["local"],
      });

      const manifestOutput = await captureStdout(() =>
        main(["agents", "manifest", "--json"]),
      );
      const manifestPayload = JSON.parse(manifestOutput) as Record<
        string,
        unknown
      >;

      expect(manifestPayload).toMatchObject({
        ok: true,
        agents: {
          support: {
            kind: "anvil.agent",
            name: "support",
          },
        },
      });

      const invokeOutput = await captureStdout(() =>
        main([
          "agents",
          "invoke",
          "support",
          "--input",
          "Review this Cell",
          "--json",
        ]),
      );
      const invokePayload = JSON.parse(invokeOutput) as Record<string, unknown>;

      expect(invokePayload).toMatchObject({
        ok: true,
        result: {
          agentName: "support",
          response: {
            role: "assistant",
            content: "Local stub response from Anvil Agent: Review this Cell",
          },
        },
      });
    } finally {
      process.chdir(originalCwd);
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 15_000);

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
      await writeFile(
        path.join(tempDir, "notes", "anvil.json"),
        JSON.stringify(
          {
            name: "notes",
            entrypoints: {
              server: "src/cell.server.ts",
              client: "src/cell.client.tsx",
            },
            runtime: "nodejs20",
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(
        path.join(tempDir, "notes", "src/cell.client.tsx"),
        "console.log('deploy fixture client');\n",
        "utf8",
      );
      const tsconfigPath = path.join(tempDir, "notes", "tsconfig.json");
      const tsconfig = JSON.parse(
        await readFile(tsconfigPath, "utf8"),
      ) as Record<string, unknown>;
      await writeFile(
        tsconfigPath,
        JSON.stringify(
          {
            ...tsconfig,
            include: ["src/cell.server.ts", "src/cell.client.tsx"],
          },
          null,
          2,
        ),
        "utf8",
      );
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

async function createAgentCell(): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cli-agent-"));
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );

  await mkdir(path.join(rootDir, "src"), { recursive: true });
  await mkdir(path.join(rootDir, ".anvil/generated"), { recursive: true });
  await writeFile(
    path.join(rootDir, "anvil.json"),
    JSON.stringify(
      {
        name: "agent-cell",
        runtime: "nodejs20",
        entrypoints: {
          server: "src/cell.server.ts",
          client: "src/cell.client.tsx",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(rootDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          jsx: "react-jsx",
          baseUrl: ".",
          paths: {
            "@anvil-cloud/runtime": [
              toPosixPath(path.join(repoRoot, "packages/runtime/src/index.ts")),
            ],
            "@anvil-cloud/client": [
              toPosixPath(path.join(repoRoot, "packages/client/src/index.ts")),
            ],
            "@anvil/generated/client": [".anvil/generated/client.ts"],
          },
        },
        include: ["src/**/*.ts", "src/**/*.tsx", ".anvil/generated/**/*.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(rootDir, "src/cell.server.ts"),
    [
      'import { app, defineAgent, endpoint } from "@anvil-cloud/runtime";',
      "",
      "export default app({",
      "  agents: {",
      "    support: defineAgent({",
      "      name: 'support',",
      "      instructions: 'Stay inside declared support capabilities.',",
      "      model: { provider: 'local', model: 'stub' },",
      "      capabilities: { cells: ['read'], filesystem: 'none', secrets: 'none' },",
      "    }),",
      "  },",
      "  endpoints: {",
      "    chat: endpoint({",
      "      method: 'POST',",
      "      path: '/api/chat',",
      "      auth: 'public',",
      "      agent: 'support',",
      "      handler: async () => ({ ok: true }),",
      "    }),",
      "  },",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(rootDir, "src/cell.client.tsx"),
    "document.body.textContent = 'agent cell';\n",
    "utf8",
  );
  await writeFile(
    path.join(rootDir, ".anvil/generated/client.ts"),
    [
      'import type { GeneratedAnvilApi } from "@anvil-cloud/client";',
      "",
      "export const api = { queries: {}, mutations: {} } as GeneratedAnvilApi;",
      "",
    ].join("\n"),
    "utf8",
  );

  return rootDir;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
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
