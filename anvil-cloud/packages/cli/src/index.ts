#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect, Either } from "effect";

import {
  AwsPreviewDeploymentAdapter,
  AwsPulumiDeployAdapter,
  AwsPreviewDestroyError,
  AwsRemoteReaderError,
  createAwsSdkPreviewDestroyerFromEnv,
  createAwsRemoteReaderFromEnv,
  createAwsSdkPreviewProvisionerFromEnv,
  BedrockInferenceProvider,
} from "@anvil-cloud/aws";
import {
  buildCell,
  checkCell,
  createAnvilCellGraph,
  validateAnvilCellGraph,
  type BuilderDiagnostic,
  type BuildResult,
  type CellManifest,
} from "@anvil-cloud/builder";
import {
  AuthError,
  LocalIdentityProvider,
  type LocalUser,
} from "@anvil-cloud/auth";
import {
  createLocalRuntimeHost,
  startLocalRuntimeServer,
} from "@anvil-cloud/local";
import {
  AgentProviderRegistry,
  AgentRuntime,
  LocalStubInferenceProvider,
  type AppDefinition,
  AuthIdentity,
  type WorkflowRun,
} from "@anvil-cloud/runtime";

type CliContext = {
  cwd: string;
  args: string[];
  flags: Set<string>;
  values: Map<string, string>;
};

export type RemoteRuntimeVerification =
  | {
      ok: true;
      url: string;
      attempts: number;
      status: number;
    }
  | {
      ok: false;
      url: string;
      attempts: number;
      code: "AWS_RUNTIME_UNHEALTHY";
      message: string;
      status?: number;
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
    case "lens":
      await commandLens(context);
      return;
    case "logs":
      await commandLogs(context);
      return;
    case "db":
      await commandDb(context, subcommand, maybeArg);
      return;
    case "plan":
      await commandPlan(context);
      return;
    case "deploy":
      await commandDeploy(context);
      return;
    case "remove":
      await commandRemove(context);
      return;
    case "destroy":
      await commandDestroy(context);
      return;
    case "auth":
      await commandAuth(context, subcommand, maybeArg);
      return;
    case "agents":
      await commandAgents(context, subcommand, maybeArg);
      return;
    case "workflows":
      await commandWorkflows(context, subcommand, maybeArg);
      return;
    case "services":
      await commandServices(context, subcommand);
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

async function commandAgents(
  context: CliContext,
  subcommand: string | undefined,
  maybeArg: string | undefined,
): Promise<void> {
  switch (subcommand) {
    case "validate":
      await commandAgentsValidate(context);
      return;
    case "manifest":
      await commandAgentsManifest(context);
      return;
    case "invoke":
      await commandAgentsInvoke(context, maybeArg);
      return;
    default:
      writeJsonOrHuman(
        context,
        {
          ok: false,
          errors: [
            {
              code: "INVALID_USAGE",
              message:
                "Usage: anvil agents <validate|manifest|invoke> [agent] --input <text>",
            },
          ],
        },
        "Usage: anvil agents <validate|manifest|invoke> [agent] --input <text>",
      );
      process.exitCode = 2;
  }
}

async function commandAgentsValidate(context: CliContext): Promise<void> {
  const result = await buildCell({ rootDir: context.cwd });

  if (!result.ok || !result.manifest) {
    writeBuildResult(context, result, "Agent validation failed.");
    process.exitCode = 4;
    return;
  }

  const manifest = result.manifest as CellManifest;
  const agents = manifest.agents ?? {};
  const warnings = Object.values(agents)
    .flatMap((agent) => agent.requires.humanApproval)
    .map((action) => ({
      code: "AGENT_APPROVAL_REQUIRED",
      message: `Approval is required for ${action}.`,
      severity: "warning" as const,
    }));

  writeJsonOrHuman(
    context,
    {
      ok: true,
      agents: Object.keys(agents),
      providers: unique(
        Object.values(agents).map((agent) => agent.model.provider),
      ),
      warnings,
    },
    [
      "Agent validation passed.",
      ...Object.keys(agents).map((name) => `  ✓ ${name}`),
      ...warnings.map((warning) => `  ⚠ ${warning.message}`),
    ].join("\n"),
  );
}

async function commandAgentsManifest(context: CliContext): Promise<void> {
  const result = await buildCell({ rootDir: context.cwd });

  if (!result.ok || !result.manifest) {
    writeBuildResult(context, result, "Agent manifest failed.");
    process.exitCode = 4;
    return;
  }

  const payload = {
    ok: true,
    agents: (result.manifest as CellManifest).agents ?? {},
  };

  writeJsonOrHuman(context, payload, JSON.stringify(payload, null, 2));
}

async function commandAgentsInvoke(
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
            message: "Usage: anvil agents invoke <name> --input <text>",
          },
        ],
      },
      "Usage: anvil agents invoke <name> --input <text>",
    );
    process.exitCode = 2;
    return;
  }

  const input = context.values.get("input");

  if (!input) {
    writeJsonOrHuman(
      context,
      {
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
            message: "Agent invocation requires --input <text>.",
          },
        ],
      },
      "Agent invocation requires --input <text>.",
    );
    process.exitCode = 2;
    return;
  }

  const result = await buildCell({ rootDir: context.cwd });

  if (!result.ok || !result.output || !result.manifest) {
    writeBuildResult(context, result, "Agent invocation build failed.");
    process.exitCode = 4;
    return;
  }

  const app = await importApp(result.output.serverBundle);
  const agent = app.agents?.[name];

  if (!agent) {
    writeJsonOrHuman(
      context,
      {
        ok: false,
        errors: [
          {
            code: "AGENT_NOT_FOUND",
            message: `No mounted agent '${name}' is defined.`,
          },
        ],
      },
      `No mounted agent '${name}' is defined.`,
    );
    process.exitCode = 4;
    return;
  }

  const providers = createAgentProviderRegistry();
  const runtime = new AgentRuntime({
    providers,
    baseDir: context.cwd,
  });
  const invocation = await runtime.invoke(agent, { input });
  const payload = { ok: true, result: invocation };

  writeJsonOrHuman(context, payload, JSON.stringify(payload, null, 2));
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
  await mkdir(path.join(cellDir, "src", "client"), { recursive: true });
  await mkdir(path.join(cellDir, ".anvil", "generated"), { recursive: true });
  await writeFile(
    path.join(cellDir, "anvil.json"),
    `${JSON.stringify(
      {
        name,
        entrypoints: {
          server: "src/cell.server.ts",
          client: "src/client/main.tsx",
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
          "@vitejs/plugin-react": "^4.3.4",
          vite: "^5.4.21",
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
        devDependencies: {
          "@types/react": "^18.3.12",
          "@types/react-dom": "^18.3.1",
          typescript: "^5.7.2",
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
    path.join(cellDir, ".anvil", "generated", "client.ts"),
    [
      'import type { GeneratedAnvilApi } from "@anvil-cloud/client";',
      "",
      "export const api = {",
      "  queries: {",
      '    listTodos: { kind: "query", name: "listTodos" },',
      "  },",
      "  mutations: {",
      '    addTodo: { kind: "mutation", name: "addTodo" },',
      "  },",
      "} as const satisfies GeneratedAnvilApi;",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(cellDir, "src", "cell.server.ts"),
    [
      'import { app, boolean, mutation, query, table, text } from "@anvil-cloud/runtime";',
      "",
      "export default app({",
      "  schema: {",
      "    todos: table({",
      "      text: text().min(1).max(500),",
      "      done: boolean().default(false),",
      "    }),",
      "  },",
      "  capabilities: {",
      "    database: true,",
      "  },",
      "  queries: {",
      "    listTodos: query({",
      '      auth: "public",',
      "      handler: async (ctx) => {",
      "        return ctx.db.todos.all();",
      "      },",
      "    }),",
      "  },",
      "  mutations: {",
      "    addTodo: mutation<{ text: string }>({",
      '      auth: "public",',
      "      handler: async (ctx, input) => {",
      "        return ctx.db.todos.insert({",
      "          text: input.text,",
      "          done: false,",
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
    path.join(cellDir, "index.html"),
    [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="utf-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
      `    <title>${name}</title>`,
      "  </head>",
      "  <body>",
      '    <div id="root"></div>',
      '    <script type="module" src="/src/client/main.tsx"></script>',
      "  </body>",
      "</html>",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(cellDir, "vite.config.ts"),
    [
      'import react from "@vitejs/plugin-react";',
      'import { defineConfig } from "vite";',
      "",
      "export default defineConfig({",
      "  plugins: [react()],",
      "  resolve: {",
      "    alias: {",
      '      "@anvil/generated/client": "/.anvil/generated/client.ts",',
      "    },",
      "  },",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(cellDir, "src", "client", "main.tsx"),
    [
      'import React from "react";',
      'import { createRoot } from "react-dom/client";',
      "",
      'import { App } from "./App";',
      'import "./styles.css";',
      "",
      'const root = document.getElementById("root");',
      "",
      "if (!root) {",
      '  throw new Error("Anvil client root element was not found.");',
      "}",
      "",
      "createRoot(root).render(",
      "  <React.StrictMode>",
      "    <App />",
      "  </React.StrictMode>,",
      ");",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(cellDir, "src", "client", "App.tsx"),
    [
      'import { createClient } from "@anvil-cloud/client";',
      'import { api } from "@anvil/generated/client";',
      'import * as React from "react";',
      "",
      "type Todo = {",
      "  id?: string;",
      "  text: string;",
      "  done?: boolean;",
      "};",
      "",
      "const client = createClient();",
      "",
      "export function App() {",
      "  const [todos, setTodos] = React.useState<Todo[]>([]);",
      '  const [status, setStatus] = React.useState<"loading" | "ready" | "error">(',
      '    "loading",',
      "  );",
      "  const [error, setError] = React.useState<string | null>(null);",
      '  const [submitStatus, setSubmitStatus] = React.useState<"idle" | "saving">(',
      '    "idle",',
      "  );",
      '  const [text, setText] = React.useState("");',
      "",
      "  React.useEffect(() => {",
      "    let active = true;",
      "",
      "    client",
      "      .query<unknown, Todo[]>(api.queries.listTodos, {})",
      "      .then((result) => {",
      "        if (active) {",
      "          setTodos(result);",
      '          setStatus("ready");',
      "        }",
      "      })",
      "      .catch((unknownError: unknown) => {",
      "        if (active) {",
      "          setError(",
      "            unknownError instanceof Error",
      "              ? unknownError.message",
      '              : "Failed to load todos.",',
      "          );",
      '          setStatus("error");',
      "        }",
      "      });",
      "",
      "    return () => {",
      "      active = false;",
      "    };",
      "  }, []);",
      "",
      "  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {",
      "    event.preventDefault();",
      "    const nextText = text.trim();",
      "",
      '    if (!nextText || submitStatus === "saving") {',
      "      return;",
      "    }",
      "",
      '    setSubmitStatus("saving");',
      "    setError(null);",
      "",
      "    try {",
      "      const created = await client.mutation<{ text: string }, Todo>(",
      "        api.mutations.addTodo,",
      "        { text: nextText },",
      "      );",
      "",
      "      setTodos((current) => [created, ...current]);",
      '      setText("");',
      '      setStatus("ready");',
      "    } catch (unknownError) {",
      "      setError(",
      "        unknownError instanceof Error",
      "          ? unknownError.message",
      '          : "Failed to add todo.",',
      "      );",
      "    } finally {",
      '      setSubmitStatus("idle");',
      "    }",
      "  }",
      "",
      "  return (",
      '    <main className="shell">',
      '      <section className="hero" aria-labelledby="app-title">',
      '        <h1 id="app-title">Build the thing. Keep the runtime boring.</h1>',
      "        <p>",
      "          This React app talks to Anvil Runtime through generated query and",
      "          mutation metadata. The cloud plumbing can stay outside the UI,",
      "          where it belongs.",
      "        </p>",
      "      </section>",
      "",
      '      <section className="panel" aria-labelledby="todos-title">',
      '        <div className="panelHeader">',
      '          <h2 id="todos-title">Todos</h2>',
      "          <span>{status}</span>",
      "        </div>",
      "",
      '        <form className="todoForm" onSubmit={handleSubmit}>',
      "          <input",
      '            aria-label="New todo"',
      '            placeholder="Add a todo"',
      "            value={text}",
      "            onChange={(event) => setText(event.currentTarget.value)}",
      "          />",
      '          <button type="submit" disabled={submitStatus === "saving"}>',
      '            {submitStatus === "saving" ? "Adding" : "Add"}',
      "          </button>",
      "        </form>",
      "",
      "        {error ? (",
      '          <p className="error">{error}</p>',
      "        ) : null}",
      "",
      '        {status === "ready" ? (',
      '          <ul className="todoList">',
      "            {todos.map((todo) => (",
      "              <li key={todo.id ?? todo.text}>{todo.text}</li>",
      "            ))}",
      "          </ul>",
      "        ) : (",
      '          <p className="muted">Loading todos...</p>',
      "        )}",
      "      </section>",
      "    </main>",
      "  );",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(cellDir, "src", "client", "styles.css"),
    [
      ":root {",
      "  color: #172019;",
      "  background: #f6f5ef;",
      '  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
      "  font-synthesis: none;",
      "  text-rendering: optimizeLegibility;",
      "}",
      "",
      "* {",
      "  box-sizing: border-box;",
      "}",
      "",
      "body {",
      "  margin: 0;",
      "  min-width: 320px;",
      "  min-height: 100vh;",
      "}",
      "",
      "button, input {",
      "  font: inherit;",
      "}",
      "",
      ".shell {",
      "  width: min(960px, calc(100vw - 32px));",
      "  margin: 0 auto;",
      "  padding: 56px 0;",
      "}",
      "",
      ".hero {",
      "  margin-bottom: 32px;",
      "}",
      "",
      "h1 {",
      "  max-width: 760px;",
      "  margin: 0;",
      "  font-size: clamp(2.3rem, 7vw, 5.5rem);",
      "  line-height: 0.96;",
      "}",
      "",
      ".hero p {",
      "  max-width: 680px;",
      "  margin: 20px 0 0;",
      "  color: #465349;",
      "  font-size: 1.05rem;",
      "  line-height: 1.7;",
      "}",
      "",
      ".panel {",
      "  border: 1px solid #d4d0c4;",
      "  border-radius: 8px;",
      "  background: #ffffff;",
      "  padding: 20px;",
      "  box-shadow: 0 18px 45px rgb(23 32 25 / 8%);",
      "}",
      "",
      ".panelHeader {",
      "  display: flex;",
      "  align-items: center;",
      "  justify-content: space-between;",
      "  gap: 16px;",
      "  margin-bottom: 16px;",
      "}",
      "",
      "h2 {",
      "  margin: 0;",
      "  font-size: 1rem;",
      "}",
      "",
      ".panelHeader span, .muted {",
      "  color: #68746b;",
      "}",
      "",
      ".todoForm {",
      "  display: flex;",
      "  gap: 10px;",
      "  margin-bottom: 16px;",
      "}",
      "",
      ".todoForm input {",
      "  min-width: 0;",
      "  flex: 1;",
      "  border: 1px solid #c6c2b7;",
      "  border-radius: 6px;",
      "  padding: 11px 12px;",
      "}",
      "",
      ".todoForm button {",
      "  border: 0;",
      "  border-radius: 6px;",
      "  background: #172019;",
      "  color: #ffffff;",
      "  padding: 11px 16px;",
      "  cursor: pointer;",
      "}",
      "",
      ".todoForm button:disabled {",
      "  cursor: wait;",
      "  opacity: 0.7;",
      "}",
      "",
      ".todoList {",
      "  display: grid;",
      "  gap: 8px;",
      "  margin: 0;",
      "  padding: 0;",
      "  list-style: none;",
      "}",
      "",
      ".todoList li {",
      "  border: 1px solid #ece8dd;",
      "  border-radius: 6px;",
      "  padding: 10px 12px;",
      "}",
      "",
      ".error {",
      "  color: #9f2d20;",
      "}",
      "",
      "@media (max-width: 640px) {",
      "  .shell {",
      "    padding: 32px 0;",
      "  }",
      "",
      "  .todoForm {",
      "    flex-direction: column;",
      "  }",
      "}",
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
    clientMode: "vite",
  });
  const ready = {
    type: "ready",
    runtimeUrl: server.runtimeUrl,
    clientUrl: server.clientUrl,
    lensUrl: `${server.runtimeUrl}/_anvil/lens`,
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
        `Anvil Lens           ${server.runtimeUrl}/_anvil/lens`,
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

    const environment = readEnvironment(context);

    if (environment === undefined) {
      return;
    }

    let payload: Awaited<ReturnType<typeof reader.inspect>>;

    try {
      payload = await reader.inspect({
        cell: remoteApp,
        environment,
      });
    } catch (error) {
      if (writeAwsRemoteReaderError(context, error)) {
        return;
      }

      throw error;
    }

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

async function commandLens(context: CliContext): Promise<void> {
  const port = Number(context.values.get("port") ?? "8787");
  const runtimeUrl = `http://localhost:${port}`;
  const lensUrl = `${runtimeUrl}/_anvil/lens`;

  try {
    const response = await fetch(`${runtimeUrl}/_anvil/health`);
    const payload = (await response.json()) as { ok?: boolean };

    if (!response.ok || payload.ok !== true) {
      throw new Error(`Health check returned status ${response.status}.`);
    }
  } catch {
    writeJsonOrHuman(
      context,
      {
        ok: false,
        errors: [
          {
            code: "LENS_SERVER_NOT_RUNNING",
            message: `No local runtime is reachable at ${runtimeUrl}. Start one with \`anvil dev\` first.`,
          },
        ],
      },
      `No local runtime is reachable at ${runtimeUrl}. Start one with \`anvil dev\` first.`,
    );
    process.exitCode = 5;
    return;
  }

  writeJsonOrHuman(
    context,
    { ok: true, url: lensUrl },
    `Anvil Lens  ${lensUrl}`,
  );
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
      sinceMs?: number;
      limit?: number;
    } = { cell: remoteApp, environment: "preview" };
    const environment = readEnvironment(context);

    if (environment === undefined) {
      return;
    }

    logInput.environment = environment;
    const limitOption = context.values.get("limit");
    const sinceOption = context.values.get("since");

    if (limitOption !== undefined) {
      const limit = parsePositiveIntegerOption(limitOption);

      if (limit === undefined) {
        writeInvalidUsage(
          context,
          "Invalid --limit value. Use a positive whole number.",
        );
        return;
      }

      logInput.limit = limit;
    }

    if (sinceOption !== undefined) {
      const sinceMs = parseSinceOption(sinceOption);

      if (sinceMs === undefined) {
        writeInvalidUsage(
          context,
          "Invalid --since value. Use a duration like 10m, 1h, 30s, or a millisecond timestamp.",
        );
        return;
      }

      logInput.sinceMs = sinceMs;
    }

    let payload: Awaited<ReturnType<typeof reader.readLogs>>;

    try {
      payload = await reader.readLogs(logInput);
    } catch (error) {
      if (writeAwsRemoteReaderError(context, error)) {
        return;
      }

      throw error;
    }

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

async function commandPlan(context: CliContext): Promise<void> {
  const adapterName = context.values.get("adapter") ?? "aws";
  if (adapterName !== "aws") {
    writeInvalidUsage(
      context,
      "Only --adapter aws is supported for cloud plans in alpha.",
    );
    return;
  }
  const stage = context.values.get("stage") ?? "dev";
  const result = await buildCell({ rootDir: context.cwd, target: stage });
  if (!result.ok || !result.manifest) {
    writeBuildResult(context, result, "Build failed.");
    process.exitCode = 4;
    return;
  }
  const cellGraph = createAnvilCellGraph(result.manifest as CellManifest);
  const diagnostics = validateAnvilCellGraph(cellGraph);
  if (diagnostics.length > 0) {
    writeJsonOrHuman(
      context,
      { ok: false, errors: diagnostics },
      "Cell graph validation failed.",
    );
    process.exitCode = 4;
    return;
  }
  const adapter = new AwsPulumiDeployAdapter();
  const plan = await adapter.plan({
    appName: cellGraph.appName,
    stage,
    cellGraph,
  });
  writeJsonOrHuman(
    context,
    { ok: true, graph: cellGraph, plan },
    formatAnvilPlan(
      plan,
      context.flags.has("verbose") || context.flags.has("debug"),
    ),
  );
}

async function commandRemove(context: CliContext): Promise<void> {
  const adapterName = context.values.get("adapter") ?? "aws";
  if (adapterName !== "aws") {
    writeInvalidUsage(
      context,
      "Only --adapter aws is supported for cloud removes in alpha.",
    );
    return;
  }
  const stage = context.values.get("stage") ?? "dev";
  const result = await buildCell({ rootDir: context.cwd, target: stage });
  if (!result.ok || !result.manifest) {
    writeBuildResult(context, result, "Build failed.");
    process.exitCode = 4;
    return;
  }
  const cellGraph = createAnvilCellGraph(result.manifest as CellManifest);
  const adapter = new AwsPulumiDeployAdapter();
  const removeResult = await adapter.remove({
    appName: cellGraph.appName,
    stage,
    cellGraph,
  });
  writeJsonOrHuman(
    context,
    removeResult,
    formatAnvilPlan(
      removeResult.plan,
      context.flags.has("verbose") || context.flags.has("debug"),
    ),
  );
}

async function commandDeploy(context: CliContext): Promise<void> {
  if (context.values.has("adapter") || context.values.has("stage")) {
    const adapterName = context.values.get("adapter") ?? "aws";
    if (adapterName !== "aws") {
      writeInvalidUsage(
        context,
        "Only --adapter aws is supported for cloud deploys in alpha.",
      );
      return;
    }
    const stage = context.values.get("stage") ?? "dev";
    const result = await buildCell({ rootDir: context.cwd, target: stage });
    if (!result.ok || !result.manifest) {
      writeBuildResult(context, result, "Build failed.");
      process.exitCode = 4;
      return;
    }
    const cellGraph = createAnvilCellGraph(result.manifest as CellManifest);
    const adapter = new AwsPulumiDeployAdapter();
    const deployResult = await adapter.deploy({
      appName: cellGraph.appName,
      stage,
      cellGraph,
    });
    writeJsonOrHuman(
      context,
      deployResult,
      formatAnvilPlan(
        deployResult.plan,
        context.flags.has("verbose") || context.flags.has("debug"),
      ),
    );
    return;
  }

  if (!context.flags.has("preview")) {
    writeJsonOrHuman(
      context,
      {
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
            message: "Only anvil deploy --preview is supported in alpha.",
          },
        ],
      },
      "Only anvil deploy --preview is supported in alpha.",
    );
    process.exitCode = 2;
    return;
  }

  const waitTimeoutOption = context.values.get("wait-timeout");
  const waitTimeoutSeconds =
    waitTimeoutOption === undefined
      ? 60
      : parsePositiveNumberOption(waitTimeoutOption);

  if (context.flags.has("wait") && waitTimeoutSeconds === undefined) {
    writeInvalidUsage(
      context,
      "Invalid --wait-timeout value. Use a positive number of seconds.",
    );
    return;
  }

  const previewResult = await runCliEffect(
    commandDeployPreviewEffect(context, waitTimeoutSeconds ?? 60),
  );

  if (previewResult.kind === "build-failed") {
    writeBuildResult(context, previewResult.result, "Build failed.");
    process.exitCode = 4;
    return;
  }

  writeJsonOrHuman(
    context,
    previewResult.output,
    JSON.stringify(previewResult.output, null, 2),
  );

  if (!previewResult.ok) {
    process.exitCode = 6;
  }
}

type PreviewDeployCommandResult =
  | {
      kind: "build-failed";
      result: BuildResult;
    }
  | {
      kind: "completed";
      ok: boolean;
      output: unknown;
    };

function commandDeployPreviewEffect(
  context: CliContext,
  waitTimeoutSeconds: number,
): Effect.Effect<PreviewDeployCommandResult, Error> {
  return Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () => buildCell({ rootDir: context.cwd, target: "preview" }),
      catch: toCliEffectError,
    });

    if (!result.ok || !result.manifest || !result.output) {
      return {
        kind: "build-failed" as const,
        result,
      };
    }

    const manifest = result.manifest as CellManifest;
    const buildOutput = result.output;
    const provisioner = createAwsSdkPreviewProvisionerFromEnv();
    const adapter = new AwsPreviewDeploymentAdapter(
      provisioner ? { provisioner } : {},
    );
    const deployResult = yield* Effect.tryPromise({
      try: () =>
        adapter.deploy({
          manifest,
          buildOutput,
          environment: "preview",
        }),
      catch: toCliEffectError,
    });

    if (!deployResult.ok || !context.flags.has("wait")) {
      return {
        kind: "completed" as const,
        ok: deployResult.ok,
        output: deployResult,
      };
    }

    const verification = yield* Effect.tryPromise({
      try: () =>
        waitForRemoteRuntime(deployResult.url, {
          timeoutMs: waitTimeoutSeconds * 1000,
        }),
      catch: toCliEffectError,
    });

    if (verification.ok) {
      return {
        kind: "completed" as const,
        ok: true,
        output: {
          ...deployResult,
          verification,
        },
      };
    }

    return {
      kind: "completed" as const,
      ok: false,
      output: {
        ok: false,
        code: verification.code,
        message: verification.message,
        hint: "Inspect the deployed Lambda logs and CloudFormation outputs, then rerun anvil deploy --preview --wait.",
        deployment: deployResult,
        verification,
      },
    };
  });
}

async function runCliEffect<T>(effect: Effect.Effect<T, Error>): Promise<T> {
  const result = await Effect.runPromise(Effect.either(effect));

  if (Either.isLeft(result)) {
    throw result.left;
  }

  return result.right;
}

function toCliEffectError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function commandDestroy(context: CliContext): Promise<void> {
  if (!context.flags.has("preview")) {
    writeJsonOrHuman(
      context,
      {
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
            message: "Only anvil destroy --preview is supported in alpha.",
          },
        ],
      },
      "Only anvil destroy --preview is supported in alpha.",
    );
    process.exitCode = 2;
    return;
  }

  const app = context.values.get("app");

  if (!app) {
    writeJsonOrHuman(
      context,
      {
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
            message: "Usage: anvil destroy --preview --app <name> --yes",
          },
        ],
      },
      "Usage: anvil destroy --preview --app <name> --yes",
    );
    process.exitCode = 2;
    return;
  }

  if (!context.flags.has("yes")) {
    writeJsonOrHuman(
      context,
      {
        ok: false,
        errors: [
          {
            code: "CONFIRMATION_REQUIRED",
            message: "Destroying an AWS preview stack requires --yes in alpha.",
          },
        ],
      },
      "Destroying an AWS preview stack requires --yes in alpha.",
    );
    process.exitCode = 2;
    return;
  }

  const destroyer = createAwsSdkPreviewDestroyerFromEnv();
  let result: Awaited<ReturnType<typeof destroyer.destroy>>;

  try {
    const environment = readEnvironment(context);

    if (environment === undefined) {
      return;
    }

    result = await destroyer.destroy({
      cell: app,
      environment,
    });
  } catch (error) {
    if (error instanceof AwsPreviewDestroyError) {
      writeJsonOrHuman(
        context,
        {
          ok: false,
          code: error.code,
          message: error.message,
          hint: "Inspect the CloudFormation stack status and any retained S3 buckets, then rerun anvil destroy --preview --app <name> --yes.",
          details: error.details,
        },
        error.message,
      );
      process.exitCode = 6;
      return;
    }

    throw error;
  }

  writeJsonOrHuman(
    context,
    result,
    result.deleted
      ? `Deleted AWS preview stack '${result.stackName}'.`
      : `AWS preview stack '${result.stackName}' was already absent.`,
  );
}

function formatAnvilPlan(
  plan: {
    changes: Array<{ kind: string; concept: string; name: string }>;
    pulumi?: Array<{ type: string; name: string }>;
  },
  verbose: boolean,
): string {
  const verb = plan.changes.some((change) => change.kind === "delete")
    ? "Will remove:"
    : "Will create:";
  const lines = [
    verb,
    "",
    ...plan.changes.map((change) => `* ${change.concept}: ${change.name}`),
  ];
  if (verbose && plan.pulumi && plan.pulumi.length > 0) {
    lines.push(
      "",
      "Pulumi resources (debug):",
      ...plan.pulumi.map((resource) => `* ${resource.type}: ${resource.name}`),
    );
  }
  return lines.join("\n");
}

export async function waitForRemoteRuntime(
  runtimeUrl: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<RemoteRuntimeVerification> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const healthUrl = remoteHealthUrl(runtimeUrl);
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastStatus: number | undefined;
  let lastMessage = "Runtime health check did not complete.";

  do {
    attempts += 1;

    try {
      const response = await fetchImpl(healthUrl);
      lastStatus = response.status;

      if (response.ok) {
        const payload = (await response.json()) as { ok?: unknown };

        if (payload.ok === true) {
          return {
            ok: true,
            url: healthUrl,
            attempts,
            status: response.status,
          };
        }

        lastMessage = `Health check returned status ${response.status} without ok: true.`;
      } else {
        lastMessage = `Health check returned status ${response.status}.`;
      }
    } catch (error) {
      lastMessage =
        error instanceof Error ? error.message : "Runtime health check failed.";
    }

    if (Date.now() < deadline) {
      await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
  } while (Date.now() < deadline);

  return {
    ok: false,
    url: healthUrl,
    attempts,
    code: "AWS_RUNTIME_UNHEALTHY",
    message: `AWS preview runtime did not become healthy within ${timeoutMs}ms. ${lastMessage}`,
    ...(lastStatus !== undefined ? { status: lastStatus } : {}),
  };
}

function remoteHealthUrl(runtimeUrl: string): string {
  const url = new URL(runtimeUrl);

  url.pathname = "/_anvil/health";
  url.search = "";
  url.hash = "";

  return url.toString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      diagnostics: result.diagnostics,
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

async function commandAuth(
  context: CliContext,
  subcommand: string | undefined,
  maybeArg: string | undefined,
): Promise<void> {
  const stateDir = path.join(context.cwd, ".anvil/local");
  const idp = new LocalIdentityProvider({
    stateDir: path.join(stateDir, "auth"),
  });
  const ambientPath = path.join(stateDir, "auth.json");

  try {
    switch (subcommand) {
      case "users": {
        const users = await idp.listUsers();

        writeJsonOrHuman(
          context,
          { ok: true, users },
          users.length === 0
            ? "No local users. Create one with `anvil auth add-user <id>`."
            : users
                .map(
                  (user) =>
                    `${user.userId}  ${user.email ?? "-"}  [${(user.roles ?? []).join(", ")}]`,
                )
                .join("\n"),
        );
        return;
      }
      case "add-user": {
        const userId = requireAuthUserId(context, maybeArg);

        if (!userId) {
          return;
        }

        const definition: LocalUser = { userId };
        const email = context.values.get("email");
        const roles = context.values.get("roles");

        if (email) {
          definition.email = email;
        }

        if (roles) {
          definition.roles = roles
            .split(",")
            .map((role) => role.trim())
            .filter((role) => role.length > 0);
        }

        const user = await idp.createUser(definition);

        writeJsonOrHuman(
          context,
          { ok: true, user },
          `Created local user '${user.userId}'.`,
        );
        return;
      }
      case "remove-user": {
        const userId = requireAuthUserId(context, maybeArg);

        if (!userId) {
          return;
        }

        const deleted = await idp.deleteUser(userId);

        if (!deleted) {
          process.exitCode = 1;
        }

        writeJsonOrHuman(
          context,
          { ok: deleted, deleted },
          deleted
            ? `Removed local user '${userId}'.`
            : `Local user '${userId}' was not found.`,
        );
        return;
      }
      case "login": {
        const userId = requireAuthUserId(context, maybeArg);

        if (!userId) {
          return;
        }

        const identity = await ensureCliLocalUser(idp, userId);

        await mkdir(path.dirname(ambientPath), { recursive: true });
        await writeFile(
          ambientPath,
          `${JSON.stringify({ currentUser: identity }, null, 2)}\n`,
          "utf8",
        );

        const issued = await idp.issueToken(userId, {
          ttlSeconds: readNumberOption(context, "ttl") ?? 60 * 60,
        });

        writeJsonOrHuman(
          context,
          {
            ok: true,
            identity,
            token: issued.token,
            expiresAt: issued.expiresAt,
          },
          [
            `Signed in as '${userId}' for local development.`,
            `Token (expires ${issued.expiresAt}):`,
            issued.token,
          ].join("\n"),
        );
        return;
      }
      case "token": {
        const userId = requireAuthUserId(context, maybeArg);

        if (!userId) {
          return;
        }

        await ensureCliLocalUser(idp, userId);

        const issued = await idp.issueToken(userId, {
          ttlSeconds: readNumberOption(context, "ttl") ?? 60 * 60,
        });

        writeJsonOrHuman(context, { ok: true, ...issued }, issued.token);
        return;
      }
      case "whoami": {
        const ambient = await readOptionalJson(ambientPath);
        const identity =
          isObject(ambient) && isObject(ambient.currentUser)
            ? ambient.currentUser
            : null;

        writeJsonOrHuman(
          context,
          { ok: true, identity },
          identity
            ? `Signed in as '${String(identity.userId)}'.`
            : "Not signed in. Use `anvil auth login <id>`.",
        );
        return;
      }
      default:
        writeJsonOrHuman(
          context,
          {
            ok: false,
            errors: [
              {
                code: "INVALID_USAGE",
                message:
                  "Usage: anvil auth <users|add-user|remove-user|login|token|whoami>",
              },
            ],
          },
          "Usage: anvil auth <users|add-user|remove-user|login|token|whoami>",
        );
        process.exitCode = 2;
    }
  } catch (error) {
    const code = error instanceof AuthError ? error.code : "AUTH_ERROR";
    const message = error instanceof Error ? error.message : String(error);

    writeJsonOrHuman(
      context,
      { ok: false, errors: [{ code, message }] },
      message,
    );
    process.exitCode = 1;
  }
}

async function commandWorkflows(
  context: CliContext,
  subcommand: string | undefined,
  maybeArg: string | undefined,
): Promise<void> {
  if (subcommand === "list") {
    const runs = await readWorkflowRuns(context.cwd);

    writeJsonOrHuman(
      context,
      { ok: true, runs },
      runs.length === 0
        ? "No local workflow runs. Start one with `anvil workflows run <name>`."
        : runs
            .map((run) => `${run.runId}  ${run.workflow}  ${run.status}`)
            .join("\n"),
    );
    return;
  }

  if (subcommand === "show") {
    if (!maybeArg) {
      writeWorkflowsUsage(context);
      return;
    }

    const runs = await readWorkflowRuns(context.cwd);
    const run = runs.find((entry) => entry.runId === maybeArg) ?? null;

    if (!run) {
      writeJsonOrHuman(
        context,
        {
          ok: false,
          errors: [
            {
              code: "NOT_FOUND",
              message: `No workflow run '${maybeArg}' was found.`,
            },
          ],
        },
        `No workflow run '${maybeArg}' was found.`,
      );
      process.exitCode = 1;
      return;
    }

    writeJsonOrHuman(context, { ok: true, run }, JSON.stringify(run, null, 2));
    return;
  }

  if (subcommand === "run") {
    if (!maybeArg) {
      writeWorkflowsUsage(context);
      return;
    }

    let input: unknown = {};
    const rawInput = context.values.get("input");

    if (rawInput !== undefined) {
      try {
        input = JSON.parse(rawInput) as unknown;
      } catch {
        writeJsonOrHuman(
          context,
          {
            ok: false,
            errors: [
              {
                code: "INVALID_USAGE",
                message: "--input must be valid JSON.",
              },
            ],
          },
          "--input must be valid JSON.",
        );
        process.exitCode = 2;
        return;
      }
    }

    const result = await buildCell({ rootDir: context.cwd });

    if (!result.ok || !result.output || !result.manifest) {
      writeBuildResult(context, result, "Build failed.");
      process.exitCode = 4;
      return;
    }

    const app = await importApp(result.output.serverBundle);
    const manifest = result.manifest as CellManifest;
    const host = await createLocalRuntimeHost({
      stateDir: path.join(context.cwd, ".anvil/local"),
      cellName: manifest.cell.name,
    });

    host.workflows.bind(app, host);

    try {
      const run = await host.workflows.startAndWait(maybeArg, input);

      if (run.status === "failed") {
        process.exitCode = 1;
      }

      writeJsonOrHuman(
        context,
        { ok: run.status === "completed", run },
        JSON.stringify(run, null, 2),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      writeJsonOrHuman(
        context,
        { ok: false, errors: [{ code: "WORKFLOW_ERROR", message }] },
        message,
      );
      process.exitCode = 1;
    }
    return;
  }

  writeWorkflowsUsage(context);
}

async function commandServices(
  context: CliContext,
  subcommand: string | undefined,
): Promise<void> {
  if (subcommand !== "list") {
    writeJsonOrHuman(
      context,
      {
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
            message: "Usage: anvil services list [--json]",
          },
        ],
      },
      "Usage: anvil services list [--json]",
    );
    process.exitCode = 2;
    return;
  }

  const snapshot = await readOptionalJson(
    path.join(context.cwd, ".anvil/local/services.json"),
  );
  const services =
    isObject(snapshot) && Array.isArray(snapshot.services)
      ? (snapshot.services as Array<Record<string, unknown>>)
      : [];
  const updatedAt =
    isObject(snapshot) && typeof snapshot.updatedAt === "string"
      ? snapshot.updatedAt
      : null;
  const note =
    "Snapshot of the last recorded service states. Live state requires a running dev server (GET /_anvil/services).";

  writeJsonOrHuman(
    context,
    { ok: true, services, updatedAt, note },
    services.length === 0
      ? `No local service snapshot. Start the dev server with declared services first.\n${note}`
      : [
          ...services.map(
            (service) =>
              `${String(service.name)}  ${String(service.state)}  restarts=${String(service.restarts)}`,
          ),
          "",
          note,
        ].join("\n"),
  );
}

function writeWorkflowsUsage(context: CliContext): void {
  writeJsonOrHuman(
    context,
    {
      ok: false,
      errors: [
        {
          code: "INVALID_USAGE",
          message:
            "Usage: anvil workflows <list|show <runId>|run <name> [--input '<json>']>",
        },
      ],
    },
    "Usage: anvil workflows <list|show <runId>|run <name> [--input '<json>']>",
  );
  process.exitCode = 2;
}

async function readWorkflowRuns(rootDir: string): Promise<WorkflowRun[]> {
  const runs = await readOptionalJson(
    path.join(rootDir, ".anvil/local/workflows.json"),
  );

  return Array.isArray(runs) ? (runs as WorkflowRun[]) : [];
}

function requireAuthUserId(
  context: CliContext,
  maybeArg: string | undefined,
): string | undefined {
  if (maybeArg) {
    return maybeArg;
  }

  writeJsonOrHuman(
    context,
    {
      ok: false,
      errors: [
        { code: "INVALID_USAGE", message: "A user id argument is required." },
      ],
    },
    "A user id argument is required.",
  );
  process.exitCode = 2;

  return undefined;
}

async function ensureCliLocalUser(
  idp: LocalIdentityProvider,
  userId: string,
): Promise<AuthIdentity> {
  const existing = await idp.getUser(userId);
  const user =
    existing ??
    (await idp.createUser({
      userId,
      email: `${userId}@local.anvil`,
      roles: ["admin"],
    }));
  const identity: AuthIdentity = { userId: user.userId };

  if (user.email !== undefined) {
    identity.email = user.email;
  }

  if (user.roles !== undefined) {
    identity.roles = user.roles;
  }

  identity.claims = user.claims ?? {};

  return identity;
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
      "  anvil lens [--port 8787] [--json]",
      "  anvil logs --local [--json]",
      "  anvil logs --app <name> --env preview [--since 10m] [--limit 50] [--json]",
      "  anvil db list --local [--json]",
      "  anvil db dump <table> --local [--json]",
      "  anvil plan --stage dev --adapter aws [--verbose] [--json]",
      "  anvil deploy --stage dev --adapter aws [--verbose] [--json]",
      "  anvil remove --stage dev --adapter aws [--verbose] [--json]",
      "  anvil deploy --preview [--wait] [--wait-timeout 60] [--json]",
      "  anvil destroy --preview --app <name> --yes [--json]",
      "  anvil auth users [--json]",
      "  anvil auth add-user <id> [--email x@y] [--roles admin,editor] [--json]",
      "  anvil auth remove-user <id> [--json]",
      "  anvil auth login <id> [--json]",
      "  anvil auth token <id> [--ttl 3600] [--json]",
      "  anvil auth whoami [--json]",
      "  anvil workflows list [--json]",
      "  anvil workflows show <runId> [--json]",
      "  anvil workflows run <name> [--input '<json>'] [--json]",
      "  anvil services list [--json]",
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

function writeAwsRemoteReaderError(
  context: CliContext,
  error: unknown,
): boolean {
  if (!(error instanceof AwsRemoteReaderError)) {
    return false;
  }

  writeJsonOrHuman(
    context,
    {
      ok: false,
      errors: [
        {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      ],
    },
    error.message,
  );
  process.exitCode = 5;
  return true;
}

function writeInvalidUsage(context: CliContext, message: string): void {
  writeJsonOrHuman(
    context,
    {
      ok: false,
      errors: [
        {
          code: "INVALID_USAGE",
          message,
        },
      ],
    },
    message,
  );
  process.exitCode = 2;
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

function readEnvironment(context: CliContext): "preview" | undefined {
  const environment = context.values.get("env") ?? "preview";

  if (environment !== "preview") {
    writeInvalidUsage(context, "Only --env preview is supported in alpha.");
    return undefined;
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

function createAgentProviderRegistry(): AgentProviderRegistry {
  const registry = new AgentProviderRegistry([
    new LocalStubInferenceProvider({ echoInput: true }),
  ]);

  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

  registry.register(
    new BedrockInferenceProvider(region === undefined ? {} : { region }),
  );

  return registry;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function parsePositiveNumberOption(value: string): number | undefined {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function parsePositiveIntegerOption(value: string): number | undefined {
  const parsed = parsePositiveNumberOption(value);

  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
}

export function parseSinceOption(
  value: string,
  nowMs: number = Date.now(),
): number | undefined {
  const trimmed = value.trim().toLowerCase();

  if (!trimmed) {
    return undefined;
  }

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(trimmed);

  if (!match) {
    return undefined;
  }

  const [, rawAmount, unit] = match;

  if (rawAmount === undefined || unit === undefined) {
    return undefined;
  }

  const amount = Number(rawAmount);
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 60 * 60_000,
    d: 24 * 60 * 60_000,
  };
  const multiplier = multipliers[unit];

  if (!Number.isFinite(amount) || multiplier === undefined) {
    return undefined;
  }

  return Math.max(0, Math.floor(nowMs - amount * multiplier));
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
  const paths = {
    ...localPaths,
    "@anvil/generated/client": [".anvil/generated/client.ts"],
  };

  compilerOptions.baseUrl = ".";
  compilerOptions.paths = paths;

  return {
    compilerOptions,
    include: ["src/**/*.ts", "src/**/*.tsx", ".anvil/generated/**/*.ts"],
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
