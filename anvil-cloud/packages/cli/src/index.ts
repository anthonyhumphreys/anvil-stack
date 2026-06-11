#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AwsPreviewDeploymentAdapter,
  createAwsRemoteReaderFromEnv,
  createAwsSdkPreviewProvisionerFromEnv,
} from "@anvil-cloud/aws";
import {
  buildCell,
  checkCell,
  type BuilderDiagnostic,
  type BuildResult,
  type CellManifest,
} from "@anvil-cloud/builder";
import { startLocalRuntimeServer } from "@anvil-cloud/local";
import type { AppDefinition } from "@anvil-cloud/runtime";

type CliContext = {
  cwd: string;
  args: string[];
  flags: Set<string>;
  values: Map<string, string>;
};

if (isDirectCliEntry()) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    writeJsonOrHuman(
      createContext(process.argv.slice(2)),
      {
        ok: false,
        errors: [
          {
            code: "CLI_ERROR",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      },
      "CLI failed.",
    );
    process.exitCode = 1;
  });
}

export async function main(argv: string[]): Promise<void> {
  const context = createContext(argv);
  const [command, subcommand, maybeArg] = context.args;

  if (!command || command === "help" || context.flags.has("help")) {
    writeHelp();
    return;
  }

  switch (command) {
    case "new":
      await commandNew(context, subcommand);
      return;
    case "check":
      await commandCheck(context);
      return;
    case "build":
      await commandBuild(context);
      return;
    case "dev":
      await commandDev(context);
      return;
    case "inspect":
      await commandInspect(context);
      return;
    case "logs":
      await commandLogs(context);
      return;
    case "db":
      await commandDb(context, subcommand, maybeArg);
      return;
    case "deploy":
      await commandDeploy(context);
      return;
    default:
      writeJsonOrHuman(
        context,
        {
          ok: false,
          errors: [
            {
              code: "INVALID_COMMAND",
              message: `Unknown command '${command}'.`,
            },
          ],
        },
        `Unknown command '${command}'.`,
      );
      process.exitCode = 2;
  }
}

async function commandNew(
  context: CliContext,
  name: string | undefined,
): Promise<void> {
  if (!name) {
    writeJsonOrHuman(
      context,
      {
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
            message: "Usage: anvil new <name>",
          },
        ],
      },
      "Usage: anvil new <name>",
    );
    process.exitCode = 2;
    return;
  }

  const cellDir = path.resolve(context.cwd, name);

  await mkdir(path.join(cellDir, "src"), { recursive: true });
  await writeFile(
    path.join(cellDir, "anvil.json"),
    `${JSON.stringify(
      {
        name,
        entrypoints: {
          server: "src/cell.server.ts",
          client: "src/cell.client.tsx",
        },
        runtime: "nodejs20",
        region: "eu-west-2",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(cellDir, "package.json"),
    `${JSON.stringify(
      {
        name,
        private: true,
        type: "module",
        dependencies: {
          "@anvil-cloud/client": "workspace:*",
          "@anvil-cloud/runtime": "workspace:*",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(cellDir, "tsconfig.json"),
    `${JSON.stringify(await createStarterTsconfig(cellDir), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(cellDir, "AGENTS.md"),
    [
      "# Anvil Cell Instructions",
      "",
      "Use Anvil Runtime capabilities through ctx. Do not import provider SDKs directly.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(cellDir, "src", "cell.server.ts"),
    [
      'import { app, boolean, mutation, query, table, text, userId } from "@anvil-cloud/runtime";',
      "",
      "export default app({",
      "  schema: {",
      "    todos: table({",
      "      text: text().min(1).max(500),",
      "      done: boolean().default(false),",
      "      ownerId: userId(),",
      "    }),",
      "  },",
      "  capabilities: {",
      "    database: true,",
      "  },",
      "  queries: {",
      "    listTodos: query({",
      "      handler: async (ctx) => {",
      '        return ctx.db.todos.where("ownerId", "=", ctx.auth.requireUser()).all();',
      "      },",
      "    }),",
      "  },",
      "  mutations: {",
      "    addTodo: mutation<{ text: string }>({",
      "      handler: async (ctx, input) => {",
      "        return ctx.db.todos.insert({",
      "          text: input.text,",
      "          done: false,",
      "          ownerId: ctx.auth.requireUser(),",
      "        });",
      "      },",
      "    }),",
      "  },",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(cellDir, "src", "cell.client.tsx"),
    [
      'import { createClient } from "@anvil-cloud/client";',
      "",
      "const client = createClient();",
      "",
      'console.log("Anvil client ready", client);',
      "",
    ].join("\n"),
    "utf8",
  );

  writeJsonOrHuman(
    context,
    {
      ok: true,
      cell: name,
      path: `./${name}`,
      next: [`cd ${name}`, "anvil dev"],
    },
    [
      `Created Anvil Cell ${name}`,
      "",
      "Next steps:",
      `  cd ${name}`,
      "  anvil dev",
    ].join("\n"),
  );
}

async function commandCheck(context: CliContext): Promise<void> {
  const result = await checkCell({ rootDir: context.cwd });

  writeBuildResult(context, result, "Check passed.");
}

async function commandBuild(context: CliContext): Promise<void> {
  const result = await buildCell({ rootDir: context.cwd });

  writeBuildResult(context, result, "Build complete.");
}

async function commandDev(context: CliContext): Promise<void> {
  const result = await buildCell({ rootDir: context.cwd });

  if (!result.ok || !result.output || !result.manifest) {
    writeBuildResult(context, result, "Build failed.");
    process.exitCode = 4;
    return;
  }

  const app = await importApp(result.output.serverBundle);
  const manifest = result.manifest as CellManifest;
  const port = Number(context.values.get("port") ?? "8787");
  const clientPort = Number(context.values.get("client-port") ?? "5173");
  const server = await startLocalRuntimeServer({
    app,
    manifest,
    rootDir: context.cwd,
    cellName: manifest.cell.name,
    port,
    clientPort,
  });
  const ready = {
    type: "ready",
    runtimeUrl: server.runtimeUrl,
    clientUrl: server.clientUrl,
    queries: manifest.queries,
    mutations: manifest.mutations,
  };

  if (context.flags.has("json") || context.flags.has("agent")) {
    process.stdout.write(
      `${JSON.stringify(context.flags.has("agent") ? ready : { ok: true, result: ready })}\n`,
    );
  } else {
    process.stdout.write(
      [
        `Anvil Local runtime  ${server.runtimeUrl}`,
        `Anvil client         ${server.clientUrl}`,
        "",
      ].join("\n"),
    );
  }

  await waitForShutdown(server.close);
}

async function commandInspect(context: CliContext): Promise<void> {
  const remoteApp = context.values.get("app");

  if (remoteApp) {
    const reader = createAwsRemoteReaderFromEnv();

    if (!reader) {
      writeJsonOrHuman(
        context,
        {
          ok: false,
          errors: [
            {
              code: "AWS_REMOTE_READER_NOT_CONFIGURED",
              message:
                "Remote AWS inspect requires ANVIL_AWS_DEPLOYMENT_METADATA_TABLE.",
            },
          ],
        },
        "Remote AWS inspect requires ANVIL_AWS_DEPLOYMENT_METADATA_TABLE.",
      );
      process.exitCode = 5;
      return;
    }

    const payload = await reader.inspect({
      cell: remoteApp,
      environment: readEnvironment(context),
    });

    writeJsonOrHuman(context, payload, JSON.stringify(payload, null, 2));
    return;
  }

  const manifest = await readOptionalJson(
    path.join(context.cwd, ".anvil/dist/manifest.json"),
  );
  const auth = await readOptionalJson(
    path.join(context.cwd, ".anvil/local/auth.json"),
  );
  const database = await readDatabase(context.cwd);
  const logs = await readLogs(context.cwd);
  const payload = {
    ok: true,
    status: manifest ? "built" : "not-built",
    manifest,
    auth: {
      currentUser:
        isObject(auth) && isObject(auth.currentUser)
          ? (auth.currentUser.userId ?? null)
          : null,
    },
    database: {
      tables: Object.fromEntries(
        Object.entries(database).map(([name, rows]) => [
          name,
          { rows: rows.length },
        ]),
      ),
    },
    recentErrors: logs.filter((entry) => entry.level === "error").slice(-10),
  };

  writeJsonOrHuman(context, payload, JSON.stringify(payload, null, 2));
}

async function commandLogs(context: CliContext): Promise<void> {
  const remoteApp = context.values.get("app");

  if (remoteApp) {
    const reader = createAwsRemoteReaderFromEnv();

    if (!reader) {
      writeJsonOrHuman(
        context,
        {
          ok: false,
          errors: [
            {
              code: "AWS_REMOTE_READER_NOT_CONFIGURED",
              message:
                "Remote AWS logs require ANVIL_AWS_DEPLOYMENT_METADATA_TABLE.",
            },
          ],
        },
        "Remote AWS logs require ANVIL_AWS_DEPLOYMENT_METADATA_TABLE.",
      );
      process.exitCode = 5;
      return;
    }

    const logInput: {
      cell: string;
      environment: "preview";
      limit?: number;
    } = {
      cell: remoteApp,
      environment: readEnvironment(context),
    };
    const limit = readNumberOption(context, "limit");

    if (limit !== undefined) {
      logInput.limit = limit;
    }

    const payload = await reader.readLogs(logInput);

    writeJsonOrHuman(
      context,
      payload,
      payload.logs
        .map(
          (entry) =>
            `${entry.timestamp} ${entry.level ?? "info"} ${entry.message}`,
        )
        .join("\n"),
    );
    return;
  }

  const logs = await readLogs(context.cwd);

  writeJsonOrHuman(
    context,
    {
      ok: true,
      logs,
    },
    logs
      .map((entry) => `${entry.timestamp} ${entry.level} ${entry.message}`)
      .join("\n"),
  );
}

async function commandDb(
  context: CliContext,
  subcommand: string | undefined,
  table: string | undefined,
): Promise<void> {
  const database = await readDatabase(context.cwd);

  if (subcommand === "list") {
    writeJsonOrHuman(
      context,
      {
        ok: true,
        tables: Object.entries(database).map(([name, rows]) => ({
          name,
          rows: rows.length,
        })),
      },
      Object.keys(database).join("\n"),
    );
    return;
  }

  if (subcommand === "dump" && table) {
    writeJsonOrHuman(
      context,
      {
        ok: true,
        table,
        rows: database[table] ?? [],
      },
      JSON.stringify(database[table] ?? [], null, 2),
    );
    return;
  }

  writeJsonOrHuman(
    context,
    {
      ok: false,
      errors: [
        {
          code: "INVALID_USAGE",
          message:
            "Usage: anvil db list --local or anvil db dump <table> --local",
        },
      ],
    },
    "Usage: anvil db list --local or anvil db dump <table> --local",
  );
  process.exitCode = 2;
}

async function commandDeploy(context: CliContext): Promise<void> {
  if (!context.flags.has("preview")) {
    writeJsonOrHuman(
      context,
      {
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
            message: "Only anvil deploy --preview is supported in v0.",
          },
        ],
      },
      "Only anvil deploy --preview is supported in v0.",
    );
    process.exitCode = 2;
    return;
  }

  const result = await buildCell({ rootDir: context.cwd, target: "preview" });

  if (!result.ok || !result.manifest || !result.output) {
    writeBuildResult(context, result, "Build failed.");
    process.exitCode = 4;
    return;
  }

  const provisioner = createAwsSdkPreviewProvisionerFromEnv();
  const adapter = new AwsPreviewDeploymentAdapter(
    provisioner ? { provisioner } : {},
  );
  const deployResult = await adapter.deploy({
    manifest: result.manifest as CellManifest,
    buildOutput: result.output,
    environment: "preview",
  });

  writeJsonOrHuman(
    context,
    deployResult,
    JSON.stringify(deployResult, null, 2),
  );

  if (!deployResult.ok) {
    process.exitCode = 6;
  }
}

function writeBuildResult(
  context: CliContext,
  result: BuildResult,
  successMessage: string,
): void {
  if (result.ok) {
    writeJsonOrHuman(
      context,
      {
        ok: true,
        result: {
          output: result.output,
          manifest: result.manifest,
          diagnostics: result.diagnostics,
        },
      },
      successMessage,
    );
    return;
  }

  writeJsonOrHuman(
    context,
    {
      ok: false,
      phase: result.phase,
      errors: result.diagnostics,
    },
    formatDiagnostics(result.diagnostics),
  );
  process.exitCode =
    result.phase === "typecheck" || result.phase === "import-policy" ? 3 : 1;
}

async function importApp(serverBundle: string): Promise<AppDefinition> {
  const imported = (await import(
    `${pathToFileURL(serverBundle).href}?cli=${Date.now()}`
  )) as { default?: unknown };

  if (!isAppDefinition(imported.default)) {
    throw new Error("Server bundle did not default-export an app definition.");
  }

  return imported.default;
}

function createContext(argv: string[]): CliContext {
  const args: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token?.startsWith("--")) {
      const [flag, inlineValue] = token.slice(2).split("=", 2);

      if (!flag) {
        continue;
      }

      if (inlineValue !== undefined) {
        values.set(flag, inlineValue);
      } else {
        const next = argv[index + 1];

        if (next && !next.startsWith("--")) {
          values.set(flag, next);
          index += 1;
        } else {
          flags.add(flag);
        }
      }
    } else if (token) {
      args.push(token);
    }
  }

  return {
    cwd: process.cwd(),
    args,
    flags,
    values,
  };
}

function writeHelp(): void {
  process.stdout.write(
    [
      "Anvil Cloud CLI",
      "",
      "Commands:",
      "  anvil new <name>",
      "  anvil dev [--json] [--agent] [--port 8787] [--client-port 5173]",
      "  anvil check [--json]",
      "  anvil build [--json]",
      "  anvil inspect --local [--json]",
      "  anvil logs --local [--json]",
      "  anvil db list --local [--json]",
      "  anvil db dump <table> --local [--json]",
      "  anvil deploy --preview [--json]",
      "",
    ].join("\n"),
  );
}

function writeJsonOrHuman(
  context: CliContext,
  payload: unknown,
  human: string,
): void {
  if (context.flags.has("json") || context.flags.has("agent")) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stdout.write(`${human}\n`);
  }
}

function formatDiagnostics(diagnostics: BuilderDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "No diagnostics.";
  }

  return diagnostics
    .map((diagnostic) => {
      const location = diagnostic.file
        ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""}`
        : "";

      return [location, diagnostic.code, diagnostic.message]
        .filter(Boolean)
        .join(" ");
    })
    .join("\n");
}

function readEnvironment(context: CliContext): "preview" {
  const environment = context.values.get("env") ?? "preview";

  if (environment !== "preview") {
    throw new Error("Only --env preview is supported in v0.");
  }

  return "preview";
}

function readNumberOption(
  context: CliContext,
  name: string,
): number | undefined {
  const value = context.values.get(name);

  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

async function waitForShutdown(
  closeServer: () => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      resolve();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
  await closeServer();
}

async function readDatabase(
  rootDir: string,
): Promise<Record<string, unknown[]>> {
  return readOptionalJson(path.join(rootDir, ".anvil/local/dev.db")).then(
    (value) => (isRecordOfArrays(value) ? value : {}),
  );
}

async function readLogs(
  rootDir: string,
): Promise<Array<Record<string, unknown>>> {
  const filePath = path.join(rootDir, ".anvil/local/logs.ndjson");

  try {
    const data = await readFile(filePath, "utf8");

    return data
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function readOptionalJson(filePath: string): Promise<unknown | null> {
  try {
    await stat(filePath);
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function isAppDefinition(value: unknown): value is AppDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "queries" in value &&
    "mutations" in value &&
    "endpoints" in value &&
    "jobs" in value
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordOfArrays(value: unknown): value is Record<string, unknown[]> {
  if (!isObject(value)) {
    return false;
  }

  return Object.values(value).every(Array.isArray);
}

async function createStarterTsconfig(
  cellDir: string,
): Promise<Record<string, unknown>> {
  const compilerOptions: Record<string, unknown> = {
    target: "ES2022",
    lib: ["ES2022", "DOM", "DOM.Iterable"],
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    jsx: "react-jsx",
    skipLibCheck: true,
  };
  const localPaths = await detectLocalPackagePaths(cellDir);

  if (Object.keys(localPaths).length > 0) {
    compilerOptions.baseUrl = ".";
    compilerOptions.paths = localPaths;
  }

  return {
    compilerOptions,
    include: ["src/**/*.ts", "src/**/*.tsx"],
  };
}

async function detectLocalPackagePaths(
  cellDir: string,
): Promise<Record<string, string[]>> {
  const packagesRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const candidates = {
    "@anvil-cloud/client": path.join(packagesRoot, "client", "src", "index.ts"),
    "@anvil-cloud/runtime": path.join(
      packagesRoot,
      "runtime",
      "src",
      "index.ts",
    ),
  };
  const paths: Record<string, string[]> = {};

  for (const [specifier, source] of Object.entries(candidates)) {
    if (await exists(source)) {
      paths[specifier] = [toPosixPath(path.relative(cellDir, source))];
    }
  }

  return paths;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);

    return true;
  } catch {
    return false;
  }
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function isDirectCliEntry(): boolean {
  const entry = process.argv[1];

  return entry ? pathToFileURL(entry).href === import.meta.url : false;
}
