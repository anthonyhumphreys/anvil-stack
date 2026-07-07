#!/usr/bin/env node
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Cause, Effect, Exit } from "effect";

import {
  AwsPreviewDeploymentAdapter,
  AwsPulumiDeployAdapter,
  AwsPreviewDestroyError,
  AwsRemoteReaderError,
  awsPreviewStackNameFor,
  createAwsSdkPreviewDestroyerFromEnv,
  createAwsRemoteReaderFromEnv,
  createAwsSdkPreviewProvisionerFromEnv,
  BedrockInferenceProvider,
  checkAwsAgentCompatibility,
} from "@anvil-cloud/aws";
import {
  buildCell,
  checkCell,
  createAnvilCellGraph,
  diffCellManifests,
  validateAnvilCellGraph,
  type BuilderDiagnostic,
  type BuildResult,
  type CellManifest,
  type ManifestDiffResult,
} from "@anvil-cloud/builder";
import {
  AuthError,
  LocalIdentityProvider,
  runAuthConformanceSuite,
  type AuthConformanceResult,
  type LocalUser,
} from "@anvil-cloud/auth";
import {
  createLocalRuntimeHost,
  LocalUsageMeter,
  startLocalRuntimeServer,
  type LocalUsageSummary,
} from "@anvil-cloud/local";
import {
  AgentProviderRegistry,
  AgentRuntime,
  LocalStubInferenceProvider,
  AuthIdentity,
  createAgentEvalToolExecutors,
  runAgentEvalSuite,
  type AgentEvalBaseline,
  type AppDefinition,
  type WorkflowRun,
} from "@anvil-cloud/runtime";

type CliContext = {
  cwd: string;
  args: string[];
  flags: Set<string>;
  values: Map<string, string>;
};

type StarterClientKind = "vite-react" | "expo-router" | "headless";
type StarterTemplate =
  | "agent"
  | "auth"
  | "crud"
  | "sandbox"
  | "service"
  | "workflow";

type DoctorStatus = "ok" | "info" | "warning" | "error";

type DoctorCheck = {
  id: string;
  status: DoctorStatus;
  message: string;
  hint?: string | undefined;
  details?: Record<string, unknown>;
};

const publicPackageNames = new Set(["@anvilstack/cloud-cli"]);
const candidatePublicApiPackageNames = [
  "@anvil-cloud/runtime",
  "@anvil-cloud/client",
];

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
    case "review":
      await commandReview(context);
      return;
    case "build":
      await commandBuild(context);
      return;
    case "manifest":
      await commandManifest(context, subcommand);
      return;
    case "doctor":
      await commandDoctor(context);
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
    case "usage":
      await commandUsage(context);
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
    case "rollback":
      await commandRollback(context);
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
    case "eval":
      await commandEval(context, subcommand);
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
    case "discover":
      await commandAgentsDiscover(context);
      return;
    case "guardian":
      await commandAgentsGuardian(context);
      return;
    case "invoke":
      await commandAgentsInvoke(context, maybeArg);
      return;
    case "sandboxes":
      await commandAgentsSandboxes(context);
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
                "Usage: anvil-cloud agents <validate|manifest|discover|guardian|invoke|sandboxes> [agent] --input <text>",
            },
          ],
        },
        "Usage: anvil-cloud agents <validate|manifest|discover|guardian|invoke|sandboxes> [agent] --input <text>",
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
  const agentSandboxesEnabled =
    typeof process.env.ANVIL_AWS_AGENT_SANDBOX_IMAGE === "string" &&
    process.env.ANVIL_AWS_AGENT_SANDBOX_IMAGE.length > 0;
  const aws = Object.fromEntries(
    Object.entries(agents).map(([name, agent]) => [
      name,
      checkAwsAgentCompatibility(agent, { agentSandboxesEnabled }),
    ]),
  );
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
      aws,
      warnings,
    },
    [
      "Agent validation passed.",
      ...Object.keys(agents).map((name) => `  ✓ ${name}`),
      ...warnings.map((warning) => `  ⚠ ${warning.message}`),
    ].join("\n"),
  );
}

async function commandAgentsSandboxes(context: CliContext): Promise<void> {
  const result = await buildCell({ rootDir: context.cwd });

  if (!result.ok || !result.manifest) {
    writeBuildResult(context, result, "Agent sandbox inspection failed.");
    process.exitCode = 4;
    return;
  }

  const manifest = result.manifest as CellManifest;
  const agents = manifest.agents ?? {};
  const image = process.env.ANVIL_AWS_AGENT_SANDBOX_IMAGE;
  const agentSandboxesEnabled = typeof image === "string" && image.length > 0;
  const sandboxes = Object.entries(agents)
    .filter(([, agent]) => agent.requires.sandbox)
    .map(([mount, agent]) => ({
      mount,
      agent: agent.name,
      provider: "aws-lambda-microvm",
      required: agent.requires.sandbox,
      supported: checkAwsAgentCompatibility(agent, {
        agentSandboxesEnabled,
      }).supported,
      imageConfigured: agentSandboxesEnabled,
      approvals: agent.requires.humanApproval,
      capabilities: agent.capabilities,
    }));

  const payload = {
    ok: true,
    provider: "aws-lambda-microvm",
    imageConfigured: agentSandboxesEnabled,
    sandboxes,
    warnings: agentSandboxesEnabled
      ? []
      : sandboxes.map((sandbox) => ({
          code: "AWS_AGENT_SANDBOX_IMAGE_REQUIRED",
          message: `Agent '${sandbox.agent}' requires a sandbox but ANVIL_AWS_AGENT_SANDBOX_IMAGE is not configured.`,
        })),
  };

  writeJsonOrHuman(
    context,
    payload,
    sandboxes.length === 0
      ? "No mounted agents require Agent Sandboxes."
      : [
          "Agent Sandboxes:",
          ...sandboxes.map(
            (sandbox) =>
              `  ${sandbox.imageConfigured ? "✓" : "⚠"} ${sandbox.mount} -> ${sandbox.provider}`,
          ),
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

async function commandAgentsDiscover(context: CliContext): Promise<void> {
  const result = await buildCell({ rootDir: context.cwd });
  const projectAgents = await discoverProjectAgents(context.cwd);
  const mountedAgents =
    result.ok && result.manifest
      ? Object.values((result.manifest as CellManifest).agents ?? {}).map(
          (agent) => ({
            name: agent.name,
            exposure: agent.exposure,
            provider: agent.model.provider,
            model: agent.model.model,
            capabilities: agent.capabilities,
            approvals: agent.requires.humanApproval,
          }),
        )
      : [];
  const payload = {
    ok: result.ok,
    projectAgents,
    mountedAgents,
    diagnostics: result.diagnostics,
  };

  writeJsonOrHuman(
    context,
    payload,
    [
      "Project agents:",
      ...projectAgents.map((agent) => `  ${agent.name} (${agent.path})`),
      "Mounted agents:",
      ...mountedAgents.map(
        (agent) => `  ${agent.name} (${agent.provider}/${agent.model})`,
      ),
    ].join("\n"),
  );

  if (!result.ok) {
    process.exitCode = 3;
  }
}

async function commandAgentsGuardian(context: CliContext): Promise<void> {
  const report = await createReviewReport(context);
  const findings = createGuardianFindings(report);
  const payload = {
    ok: report.ok,
    agent: {
      name: "guardian",
      exposure: "project",
      purpose:
        "Review Cell trust, capability, deploy, rollback, and cleanup evidence before preview deployment.",
    },
    report,
    findings,
  };

  writeJsonOrHuman(
    context,
    payload,
    [
      `Guardian Agent: ${report.status}`,
      ...findings.map(
        (finding) =>
          `  ${finding.severity} ${finding.code}: ${finding.message}`,
      ),
    ].join("\n"),
  );

  if (!report.ok) {
    process.exitCode = report.status === "block" ? 6 : 3;
  }
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
            message: "Usage: anvil-cloud agents invoke <name> --input <text>",
          },
        ],
      },
      "Usage: anvil-cloud agents invoke <name> --input <text>",
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

async function commandEval(
  context: CliContext,
  name: string | undefined,
): Promise<void> {
  const result = await buildCell({ rootDir: context.cwd });

  if (!result.ok || !result.output || !result.manifest) {
    writeBuildResult(context, result, "Agent eval build failed.");
    process.exitCode = 4;
    return;
  }

  const app = await importApp(result.output.serverBundle);
  const agents = Object.entries(app.agents ?? {}).filter(([mount, agent]) => {
    if (name !== undefined && mount !== name && agent.name !== name) {
      return false;
    }

    return agent.evals !== undefined;
  });

  if (name !== undefined && agents.length === 0) {
    writeJsonOrHuman(
      context,
      {
        ok: false,
        errors: [
          {
            code: "AGENT_EVALS_NOT_FOUND",
            message: `No eval suite found for mounted agent '${name}'.`,
          },
        ],
      },
      `No eval suite found for mounted agent '${name}'.`,
    );
    process.exitCode = 4;
    return;
  }

  const baselinePath = path.resolve(
    context.cwd,
    context.values.get("baseline") ?? ".anvil/evals/baseline.json",
  );
  const baseline = await readEvalBaseline(baselinePath);
  const runtime = new AgentRuntime({
    providers: createAgentProviderRegistry(),
    baseDir: context.cwd,
  });
  const runs = await Promise.all(
    agents.map(async ([mount, agent]) => {
      const tools = createAgentEvalToolExecutors(agent);

      return {
        mount,
        ...(await runAgentEvalSuite(agent, agent.evals!, {
          runtime,
          ...(baseline === undefined ? {} : { baseline }),
          ...(tools === undefined ? {} : { tools }),
        })),
      };
    }),
  );
  const summary = {
    agents: runs.length,
    total: runs.reduce((total, run) => total + run.summary.total, 0),
    passed: runs.reduce((total, run) => total + run.summary.passed, 0),
    failed: runs.reduce((total, run) => total + run.summary.failed, 0),
  };
  const nextBaseline = mergeEvalBaselines(runs.map((run) => run.baseline));
  const baselineToWrite =
    baseline === undefined
      ? nextBaseline
      : mergeEvalBaselines([baseline, nextBaseline]);

  if (context.flags.has("write-baseline")) {
    await mkdir(path.dirname(baselinePath), { recursive: true });
    await writeFile(
      baselinePath,
      `${JSON.stringify(baselineToWrite, null, 2)}\n`,
      "utf8",
    );
  }

  const payload = {
    ok: runs.every((run) => run.ok),
    summary,
    baseline: {
      path: path.relative(context.cwd, baselinePath),
      loaded: baseline !== undefined,
      wrote: context.flags.has("write-baseline"),
    },
    agents: runs,
  };

  writeJsonOrHuman(
    context,
    payload,
    payload.ok
      ? `Agent evals passed (${summary.passed}/${summary.total}).`
      : `Agent evals failed (${summary.failed}/${summary.total}).`,
  );

  if (!payload.ok) {
    process.exitCode = 6;
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
            message: "Usage: anvil-cloud new <name>",
          },
        ],
      },
      "Usage: anvil-cloud new <name>",
    );
    process.exitCode = 2;
    return;
  }

  const clientKind = readStarterClientKind(context);
  const template = readStarterTemplate(context);

  if (!clientKind || !template) {
    writeJsonOrHuman(
      context,
      {
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
            message:
              "Usage: anvil-cloud new <name> [--client vite-react|expo-router|headless] [--template crud|auth|workflow|service|agent|sandbox]",
          },
        ],
      },
      "Usage: anvil-cloud new <name> [--client vite-react|expo-router|headless] [--template crud|auth|workflow|service|agent|sandbox]",
    );
    process.exitCode = 2;
    return;
  }

  const cellDir = path.resolve(context.cwd, name);
  const clientEntry =
    clientKind === "expo-router"
      ? "app/index.tsx"
      : clientKind === "headless"
        ? "src/client/index.ts"
        : "src/client/main.tsx";

  await mkdir(path.join(cellDir, "src"), { recursive: true });
  if (clientKind === "expo-router") {
    await mkdir(path.join(cellDir, "app"), { recursive: true });
  } else if (clientKind === "headless") {
    await mkdir(path.join(cellDir, "src", "client"), { recursive: true });
  } else {
    await mkdir(path.join(cellDir, "src", "client"), { recursive: true });
  }
  await mkdir(path.join(cellDir, ".anvil", "generated"), { recursive: true });
  await writeFile(
    path.join(cellDir, "anvil.json"),
    `${JSON.stringify(
      {
        name,
        template,
        client: {
          kind: clientKind,
        },
        entrypoints: {
          server: "src/cell.server.ts",
          client: clientEntry,
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
        scripts: createStarterScripts(name, clientKind),
        dependencies: createStarterDependencies(clientKind),
        devDependencies: createStarterDevDependencies(clientKind),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(cellDir, "tsconfig.json"),
    `${JSON.stringify(await createStarterTsconfig(cellDir, clientKind), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(cellDir, "AGENTS.md"),
    [
      "# Anvil Cell Instructions",
      "",
      "Use Anvil Runtime capabilities through ctx. Do not import provider SDKs directly.",
      `Template: ${template}. Keep the demonstrated primitive runnable before adding adjacent concepts.`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(cellDir, ".anvil", "generated", "client.ts"),
    [
      'import type { ApiMutation, ApiQuery, GeneratedAnvilApi } from "@anvil-cloud/client";',
      "",
      "export interface QueryTypes {}",
      "export interface MutationTypes {}",
      "",
      "export const api = {",
      "  queries: {",
      '    listTodos: { kind: "query", name: "listTodos" } as TypedQuery<"listTodos">,',
      "  },",
      "  mutations: {",
      '    addTodo: { kind: "mutation", name: "addTodo" } as TypedMutation<"addTodo">,',
      "  },",
      "  meta: {",
      '    schemaVersion: "0.1",',
      '    queries: ["listTodos"],',
      '    mutations: ["addTodo"],',
      "  },",
      "} as const satisfies GeneratedAnvilApi;",
      "",
      "type TypedQuery<TName extends string> = TName extends keyof QueryTypes",
      "  ? QueryTypes[TName] extends { input: infer TInput; result: infer TResult }",
      "    ? ApiQuery<TName, TInput, TResult>",
      "    : ApiQuery<TName>",
      "  : ApiQuery<TName>;",
      "",
      "type TypedMutation<TName extends string> = TName extends keyof MutationTypes",
      "  ? MutationTypes[TName] extends { input: infer TInput; result: infer TResult }",
      "    ? ApiMutation<TName, TInput, TResult>",
      "    : ApiMutation<TName>",
      "  : ApiMutation<TName>;",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(cellDir, "src", "anvil-api.d.ts"),
    [
      'declare module "@anvil/generated/client" {',
      "  interface QueryTypes {",
      "    listTodos: {",
      "      input: unknown;",
      "      result: Array<{",
      "        id?: string;",
      "        text: string;",
      "        done?: boolean;",
      "      }>;",
      "    };",
      "  }",
      "",
      "  interface MutationTypes {",
      "    addTodo: {",
      "      input: {",
      "        text: string;",
      "      };",
      "      result: {",
      "        id?: string;",
      "        text: string;",
      "        done?: boolean;",
      "      };",
      "    };",
      "  }",
      "}",
      "",
      "export {};",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(cellDir, "src", "cell.server.ts"),
    createStarterServerSource(template),
    "utf8",
  );
  if (clientKind === "expo-router") {
    await writeFile(
      path.join(cellDir, "app.json"),
      `${JSON.stringify(
        {
          expo: {
            name,
            slug: name,
            scheme: name,
            plugins: ["expo-router"],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      path.join(cellDir, "app", "_layout.tsx"),
      [
        'import { Stack } from "expo-router/stack";',
        "",
        "export default function Layout() {",
        "  return <Stack />;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(cellDir, "app", "index.tsx"),
      [
        'import { createApiClient, createClient } from "@anvil-cloud/client";',
        'import { api } from "@anvil/generated/client";',
        'import * as React from "react";',
        'import { Button, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";',
        "",
        "type Todo = {",
        "  id?: string;",
        "  text: string;",
        "  done?: boolean;",
        "};",
        "",
        'const localRuntimeUrl = Platform.OS === "android" ? "http://10.0.2.2:8787" : "http://localhost:8787";',
        "const runtimeUrl = process.env.EXPO_PUBLIC_ANVIL_RUNTIME_URL ?? localRuntimeUrl;",
        "const client = createApiClient(createClient({ runtimeUrl }), api);",
        "",
        "export default function Index() {",
        "  const [todos, setTodos] = React.useState<Todo[]>([]);",
        '  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading");',
        "  const [error, setError] = React.useState<string | null>(null);",
        '  const [submitStatus, setSubmitStatus] = React.useState<"idle" | "saving">("idle");',
        '  const [text, setText] = React.useState("");',
        "",
        "  const loadTodos = React.useCallback(async () => {",
        '    setStatus("loading");',
        "    setError(null);",
        "",
        "    try {",
        "      setTodos(await client.queries.listTodos({}));",
        '      setStatus("ready");',
        "    } catch (unknownError) {",
        "      setError(",
        "        unknownError instanceof Error",
        "          ? unknownError.message",
        '          : "Failed to load todos.",',
        "      );",
        '      setStatus("error");',
        "    }",
        "  }, []);",
        "",
        "  React.useEffect(() => {",
        "    void loadTodos();",
        "  }, [loadTodos]);",
        "",
        "  async function handleSubmit() {",
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
        "      const created = await client.mutations.addTodo({ text: nextText });",
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
        '    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.screen}>',
        "      <Text style={styles.title}>Anvil todos</Text>",
        "      <Text style={styles.meta}>Runtime: {runtimeUrl}</Text>",
        "",
        "      <View style={styles.form}>",
        "        <TextInput",
        '          accessibilityLabel="New todo"',
        '          placeholder="Add a todo"',
        "          value={text}",
        "          onChangeText={setText}",
        "          style={styles.input}",
        "        />",
        "        <Button",
        '          title={submitStatus === "saving" ? "Adding" : "Add"}',
        '          disabled={submitStatus === "saving"}',
        "          onPress={() => void handleSubmit()}",
        "        />",
        "      </View>",
        "",
        "      {error ? <Text style={styles.error}>{error}</Text> : null}",
        "",
        "      <Text style={styles.status}>Status: {status}</Text>",
        "      {todos.map((todo) => (",
        "        <View key={todo.id ?? todo.text} style={styles.todo}>",
        "          <Text>{todo.text}</Text>",
        "        </View>",
        "      ))}",
        "    </ScrollView>",
        "  );",
        "}",
        "",
        "const styles = StyleSheet.create({",
        "  screen: {",
        "    gap: 16,",
        "    padding: 24,",
        "  },",
        "  title: {",
        "    fontSize: 32,",
        '    fontWeight: "700",',
        "  },",
        "  meta: {",
        '    color: "#52605a",',
        "  },",
        "  form: {",
        "    gap: 12,",
        "  },",
        "  input: {",
        '    borderColor: "#c6c2b7",',
        "    borderRadius: 6,",
        "    borderWidth: 1,",
        "    paddingHorizontal: 12,",
        "    paddingVertical: 10,",
        "  },",
        "  status: {",
        '    color: "#52605a",',
        "  },",
        "  todo: {",
        '    borderColor: "#ece8dd",',
        "    borderRadius: 6,",
        "    borderWidth: 1,",
        "    padding: 12,",
        "  },",
        "  error: {",
        '    color: "#9f2d20",',
        "  },",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(cellDir, "src", "expo-env.d.ts"),
      [
        "declare const process: {",
        "  env: {",
        "    EXPO_PUBLIC_ANVIL_RUNTIME_URL?: string;",
        "  };",
        "};",
        "",
        "export {};",
        "",
      ].join("\n"),
      "utf8",
    );
  } else if (clientKind === "vite-react") {
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
  } else {
    await writeFile(
      path.join(cellDir, "src", "client", "index.ts"),
      [
        'import { createApiClient, createClient } from "@anvil-cloud/client";',
        'import { api } from "@anvil/generated/client";',
        "",
        "export const anvil = createApiClient(createClient(), api);",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  writeJsonOrHuman(
    context,
    {
      ok: true,
      cell: name,
      client: {
        kind: clientKind,
      },
      template,
      path: `./${name}`,
      next:
        clientKind === "expo-router"
          ? [
              `cd ${name}`,
              "anvil-cloud dev",
              "EXPO_PUBLIC_ANVIL_RUNTIME_URL=http://localhost:8787 pnpm start",
            ]
          : [`cd ${name}`, "anvil-cloud dev"],
    },
    [
      `Created Anvil Cell ${name}`,
      `Template: ${template}`,
      "",
      "Next steps:",
      `  cd ${name}`,
      "  anvil-cloud dev",
      ...(clientKind === "expo-router"
        ? ["  EXPO_PUBLIC_ANVIL_RUNTIME_URL=http://localhost:8787 pnpm start"]
        : []),
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

async function commandManifest(
  context: CliContext,
  subcommand: string | undefined,
): Promise<void> {
  if (subcommand !== "diff") {
    writeJsonOrHuman(
      context,
      {
        ok: false,
        errors: [
          {
            code: "INVALID_USAGE",
            message:
              "Usage: anvil-cloud manifest diff [--from <manifest>] [--to <manifest>] [--json]",
          },
        ],
      },
      "Usage: anvil-cloud manifest diff [--from <manifest>] [--to <manifest>] [--json]",
    );
    process.exitCode = 2;
    return;
  }

  await commandManifestDiff(context);
}

async function commandManifestDiff(context: CliContext): Promise<void> {
  const fromPath = path.resolve(
    context.cwd,
    context.values.get("from") ?? ".anvil/dist/manifest.json",
  );
  const fromResult = await readManifestForDiff(fromPath);

  if (!fromResult.ok) {
    if (fromResult.kind === "invalid-json") {
      const relativePath = path.relative(context.cwd, fromPath);
      writeJsonOrHuman(
        context,
        {
          ok: false,
          errors: [
            {
              code: "MANIFEST_INVALID_JSON",
              message: `${fromResult.message} (${relativePath})`,
            },
          ],
        },
        `${fromResult.message} (${relativePath})`,
      );
      process.exitCode = 2;
      return;
    }

    const payload = {
      ok: true,
      status: "no-baseline",
      from: null,
      to: null,
      summary: emptyManifestDiffSummary(),
      changes: [],
      diagnostics: [
        {
          code: "MANIFEST_BASELINE_NOT_FOUND",
          severity: "warning",
          message: `No manifest baseline found at ${path.relative(context.cwd, fromPath)}.`,
          hint: "Run anvil-cloud build first, or pass --from <manifest>.",
        },
      ],
    };

    writeJsonOrHuman(
      context,
      payload,
      "No manifest baseline found. Run anvil-cloud build first, or pass --from <manifest>.",
    );
    return;
  }

  const next = await loadNextManifestForDiff(context);

  if (!next.ok) {
    if (next.result) {
      writeBuildResult(context, next.result, "Manifest diff build complete.");
    } else if (next.error) {
      writeJsonOrHuman(
        context,
        {
          ok: false,
          errors: [next.error],
        },
        next.error.message,
      );
      process.exitCode = 2;
    } else {
      writeJsonOrHuman(
        context,
        {
          ok: false,
          errors: [
            {
              code: "MANIFEST_COMPARE_NOT_FOUND",
              message: `No comparison manifest found at ${path.relative(context.cwd, next.path)}.`,
            },
          ],
        },
        `No comparison manifest found at ${path.relative(context.cwd, next.path)}.`,
      );
      process.exitCode = 2;
    }
    return;
  }

  const diff = diffCellManifests(fromResult.manifest, next.manifest);
  const payload = {
    ok: diff.summary.errors === 0,
    status:
      diff.summary.errors > 0
        ? "block"
        : diff.changed
          ? "changed"
          : "unchanged",
    from: manifestDiffSource(fromPath, fromResult.manifest),
    to: manifestDiffSource(next.path, next.manifest),
    summary: diff.summary,
    changes: diff.changes,
    diagnostics: next.diagnostics,
  };

  writeJsonOrHuman(context, payload, formatManifestDiff(diff));

  if (diff.summary.errors > 0) {
    process.exitCode = 5;
  }
}

type LoadedManifestForDiff =
  | {
      ok: true;
      manifest: CellManifest;
      path: string;
      diagnostics: BuilderDiagnostic[];
    }
  | {
      ok: false;
      path: string;
      result?: BuildResult;
      error?: { code: string; message: string };
    };

async function loadNextManifestForDiff(
  context: CliContext,
): Promise<LoadedManifestForDiff> {
  const explicitTo = context.values.get("to");

  if (explicitTo) {
    const toPath = path.resolve(context.cwd, explicitTo);
    const toResult = await readManifestForDiff(toPath);

    if (toResult.ok) {
      return { ok: true, manifest: toResult.manifest, path: toPath, diagnostics: [] };
    }

    if (toResult.kind === "invalid-json") {
      const relativePath = path.relative(context.cwd, toPath);
      return {
        ok: false,
        path: toPath,
        error: {
          code: "MANIFEST_INVALID_JSON",
          message: `${toResult.message} (${relativePath})`,
        },
      };
    }

    return { ok: false, path: toPath };
  }

  const scratchDir = await mkdtemp(path.join(os.tmpdir(), "anvil-manifest-"));

  try {
    const result = await buildCell({
      rootDir: context.cwd,
      distDir: path.join(scratchDir, "dist"),
      generatedDir: path.join(scratchDir, "generated"),
    });

    if (!result.ok || !result.manifest) {
      return {
        ok: false,
        path: path.join(scratchDir, "dist/manifest.json"),
        result,
      };
    }

    return {
      ok: true,
      manifest: result.manifest as CellManifest,
      path: "current source build",
      diagnostics: result.diagnostics,
    };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

type ReadManifestForDiffResult =
  | { ok: true; manifest: CellManifest }
  | { ok: false; kind: "not-found" }
  | { ok: false; kind: "invalid-json"; message: string };

async function readManifestForDiff(
  manifestPath: string,
): Promise<ReadManifestForDiffResult> {
  let raw: string;

  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { ok: false, kind: "not-found" };
    }

    throw error;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      ok: false,
      kind: "invalid-json",
      message:
        error instanceof Error
          ? `Manifest is not valid JSON: ${error.message}`
          : "Manifest is not valid JSON.",
    };
  }

  return isCellManifestForDiff(parsed)
    ? { ok: true, manifest: parsed }
    : { ok: false, kind: "not-found" };
}

function isCellManifestForDiff(value: unknown): value is CellManifest {
  return (
    isObject(value) &&
    value.schemaVersion === "0.1" &&
    isObject(value.cell) &&
    isObject(value.schema) &&
    isObject(value.capabilities) &&
    Array.isArray(value.queries) &&
    Array.isArray(value.mutations) &&
    Array.isArray(value.endpoints) &&
    Array.isArray(value.jobs) &&
    Array.isArray(value.workflows) &&
    Array.isArray(value.services)
  );
}

function manifestDiffSource(pathValue: string, manifest: CellManifest) {
  return {
    path: pathValue,
    cell: manifest.cell.name,
    target: manifest.cell.target,
  };
}

function emptyManifestDiffSummary(): ManifestDiffResult["summary"] {
  return {
    additions: 0,
    removals: 0,
    changes: 0,
    warnings: 0,
    errors: 0,
  };
}

function formatManifestDiff(diff: ManifestDiffResult): string {
  if (!diff.changed) {
    return "Manifest unchanged.";
  }

  const header = [
    `Manifest ${diff.summary.errors > 0 ? "blocked" : "changed"}.`,
    `Additions: ${diff.summary.additions}`,
    `Removals: ${diff.summary.removals}`,
    `Changes: ${diff.summary.changes}`,
    `Warnings: ${diff.summary.warnings}`,
    `Errors: ${diff.summary.errors}`,
  ].join("\n");
  const lines = diff.changes.map(
    (change) =>
      `${change.severity.toUpperCase()} ${change.id}: ${change.message}`,
  );

  return [header, "", ...lines].join("\n");
}

async function commandReview(context: CliContext): Promise<void> {
  const report = await createReviewReport(context);

  writeJsonOrHuman(context, report, formatReviewReport(report));

  if (!report.ok) {
    process.exitCode = reviewReportExitCode(report);
  }
}

async function createReviewReport(context: CliContext) {
  const adapterName = context.values.get("adapter") ?? "aws";

  if (adapterName !== "aws") {
    return createInvalidReviewReport(
      "INVALID_USAGE",
      "Only --adapter aws is supported for review reports in alpha.",
    );
  }

  const environment = context.values.get("env") ?? "preview";

  if (environment !== "preview") {
    return createInvalidReviewReport(
      "INVALID_USAGE",
      "Only --env preview is supported for review reports in alpha.",
    );
  }

  const result = await buildCell({ rootDir: context.cwd, target: "preview" });

  if (!result.ok || !result.manifest) {
    return createBlockedReviewReportFromBuildResult(result);
  }

  const manifest = result.manifest as CellManifest;
  const adapter = new AwsPreviewDeploymentAdapter();
  const plan = adapter.plan(manifest, "preview");
  const guardSummary = summarizeBuilderDiagnostics(result.diagnostics);
  const blocking = plan.review.approvalSummary.hasBlockingGate;
  const requiredReview = plan.review.approvalSummary.required > 0;
  const status = blocking ? "block" : requiredReview ? "review" : "pass";
  const report = {
    ok: !blocking,
    schemaVersion: "0.1",
    command: "review",
    target: {
      adapter: "aws",
      environment: "preview",
      cell: manifest.cell.name,
    },
    status,
    summary: {
      guardErrors: guardSummary.errors,
      guardWarnings: guardSummary.warnings,
      approvalRequired: plan.review.approvalSummary.required,
      reviewGates: plan.review.approvalSummary.review,
      blockingGates: plan.review.approvalSummary.block,
      capabilityChanges: plan.review.capabilityDiffs.length,
      costDrivers: plan.review.cost.drivers.length,
      rollbackSupported: plan.review.rollback.supported,
    },
    guard: {
      ok: guardSummary.errors === 0,
      diagnostics: result.diagnostics,
      summary: guardSummary,
    },
    manifest: {
      cell: manifest.cell,
      capabilities: manifest.capabilities,
      queries: manifest.queries,
      mutations: manifest.mutations,
      endpoints: manifest.endpoints,
      jobs: manifest.jobs,
      workflows: manifest.workflows,
      services: manifest.services,
    },
    review: plan.review,
    warnings: plan.warnings,
    next: createReviewNextSteps(manifest.cell.name, status),
  };

  return report;
}

async function commandDoctor(context: CliContext): Promise<void> {
  const checks = await runDoctorChecks(context);
  const summary = summarizeDoctorChecks(checks);
  const payload = {
    ok: summary.errors === 0,
    checks,
    summary,
  };

  writeJsonOrHuman(context, payload, formatDoctorChecks(checks));

  if (summary.errors > 0) {
    process.exitCode = 5;
  }
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
    clientMode: manifest.client.kind === "vite-react" ? "vite" : "none",
  });
  const ready = {
    type: "ready",
    runtimeUrl: server.runtimeUrl,
    clientUrl: server.clientUrl,
    client: manifest.client,
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
        ...(manifest.client.kind === "vite-react"
          ? [`Anvil client         ${server.clientUrl}`]
          : [
              `Anvil client         ${manifest.client.kind} (start separately)`,
            ]),
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
            message: `No local runtime is reachable at ${runtimeUrl}. Start one with \`anvil-cloud dev\` first.`,
          },
        ],
      },
      `No local runtime is reachable at ${runtimeUrl}. Start one with \`anvil-cloud dev\` first.`,
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

async function commandUsage(context: CliContext): Promise<void> {
  if (context.flags.has("local")) {
    const sinceOption = context.values.get("since");
    const sinceMs =
      sinceOption === undefined ? undefined : parseSinceOption(sinceOption);

    if (sinceOption !== undefined && sinceMs === undefined) {
      writeInvalidUsage(
        context,
        "Invalid --since value. Use a duration like 10m, 1h, 30s, or a millisecond timestamp.",
      );
      return;
    }

    const meter = new LocalUsageMeter(
      path.join(context.cwd, ".anvil/local/usage.ndjson"),
      "local",
    );
    const summary = await meter.summarize({
      ...(sinceMs === undefined ? {} : { sinceMs }),
      ...usageBudgetOptionsFromEnv(),
    });

    writeJsonOrHuman(
      context,
      {
        ok: true,
        schemaVersion: "0.1",
        target: {
          adapter: "local",
          environment: "local",
        },
        usage: summary,
      },
      formatLocalUsageSummary(summary),
    );
    return;
  }

  if (!context.flags.has("preview")) {
    writeInvalidUsage(
      context,
      "Usage: anvil-cloud usage --local [--since 1h] [--json] or anvil-cloud usage --preview [--json].",
    );
    return;
  }

  const result = await buildCell({ rootDir: context.cwd, target: "preview" });

  if (!result.ok || !result.manifest) {
    writeBuildResult(context, result, "Usage report failed.");
    process.exitCode = 4;
    return;
  }

  const manifest = result.manifest as CellManifest;
  const plan = new AwsPreviewDeploymentAdapter().plan(manifest, "preview");
  const payload = {
    ok: true,
    schemaVersion: "0.1",
    target: {
      adapter: "aws",
      environment: "preview",
      cell: manifest.cell.name,
    },
    usage: {
      mode: "declared-preview",
      resources: {
        tables: Object.keys(manifest.schema.tables).length,
        files: manifest.capabilities.files ? 1 : 0,
        events: manifest.capabilities.events ? 1 : 0,
        jobs: manifest.jobs.length,
        workflows: manifest.workflows.length,
        services: manifest.services.length,
        agents: Object.keys(manifest.agents ?? {}).length,
      },
      cost: plan.operations.cost,
      cleanup: plan.operations.cleanup,
    },
  };

  writeJsonOrHuman(
    context,
    payload,
    [
      `Usage visibility for ${manifest.cell.name} (aws/preview)`,
      ...plan.operations.cost.drivers.map((driver) => `  ${driver}`),
      "",
      "Cleanup:",
      ...plan.operations.cleanup.commands.map((command) => `  ${command}`),
    ].join("\n"),
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
            "Usage: anvil-cloud db list --local or anvil-cloud db dump <table> --local",
        },
      ],
    },
    "Usage: anvil-cloud db list --local or anvil-cloud db dump <table> --local",
  );
  process.exitCode = 2;
}

function formatLocalUsageSummary(summary: LocalUsageSummary): string {
  const totals = summary.totals;
  const lines = [
    "Usage visibility for local runtime",
    `  invocations: ${totals.invocations}`,
    `  tokens: ${totals.totalTokens} (${totals.inputTokens} in / ${totals.outputTokens} out)`,
    `  estimated cost: $${totals.estimatedCostUsd.toFixed(6)}`,
    `  sandbox runtime: ${totals.sandboxRuntimeMs}ms`,
  ];

  if (summary.topConsumers.length > 0) {
    lines.push("", "Top consumers:");
    for (const consumer of summary.topConsumers) {
      lines.push(
        `  ${consumer.scope}:${consumer.name} ${consumer.totals.invocations} invocations ${consumer.totals.totalTokens} tokens $${consumer.totals.estimatedCostUsd.toFixed(6)}`,
      );
    }
  }

  if (summary.budgets.length > 0) {
    lines.push("", "Budgets:");
    for (const budget of summary.budgets) {
      lines.push(
        `  ${budget.id}: ${budget.status} $${budget.actualUsd.toFixed(6)} / $${budget.limitUsd.toFixed(6)}`,
      );
    }
  }

  return lines.join("\n");
}

function usageBudgetOptionsFromEnv(): {
  budgetUsd?: number;
  sessionBudgetUsd?: number;
} {
  const budgetUsd = usageBudgetOptionFromEnv("ANVIL_USAGE_DAILY_BUDGET_USD");
  const sessionBudgetUsd = usageBudgetOptionFromEnv(
    "ANVIL_USAGE_SESSION_BUDGET_USD",
  );

  return {
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
    ...(sessionBudgetUsd === undefined ? {} : { sessionBudgetUsd }),
  };
}

function usageBudgetOptionFromEnv(name: string): number | undefined {
  const value = process.env[name];

  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
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

async function commandRollback(context: CliContext): Promise<void> {
  if (!context.flags.has("preview")) {
    writeInvalidUsage(
      context,
      "Only anvil-cloud rollback --preview is supported in alpha.",
    );
    return;
  }

  const appName = context.values.get("app");
  const deploymentId = context.values.get("to-deployment");

  if (!appName || !deploymentId) {
    writeInvalidUsage(
      context,
      "Usage: anvil-cloud rollback --preview --app <name> --to-deployment <deploymentId> --dry-run",
    );
    return;
  }

  if (!context.flags.has("dry-run")) {
    writeJsonOrHuman(
      context,
      {
        ok: false,
        errors: [
          {
            code: "ROLLBACK_REQUIRES_DRY_RUN",
            message:
              "Preview rollback is currently exposed as dry-run intent only.",
            hint: "Use --dry-run to inspect the rollback target and redeploy commands before artifact rollback automation lands.",
          },
        ],
      },
      "Preview rollback is currently exposed as dry-run intent only.",
    );
    process.exitCode = 2;
    return;
  }

  const payload = {
    ok: true,
    schemaVersion: "0.1",
    target: {
      adapter: "aws",
      environment: "preview",
      cell: appName,
      deploymentId,
    },
    rollback: {
      mode: "dry-run",
      strategy: "redeploy-previous-artifact",
      supported: false,
      commands: [
        `anvil-cloud inspect --app ${appName} --env preview --json`,
        `anvil-cloud logs --app ${appName} --env preview --since 10m --json`,
        "anvil-cloud deploy --preview --json",
      ],
      notes: [
        "Artifact rollback promotion is not automated in alpha.",
        "Use this dry-run output to confirm the target deployment, then redeploy the known-good checkout or artifact.",
      ],
    },
  };

  writeJsonOrHuman(
    context,
    payload,
    [
      `Rollback dry-run for ${appName} -> ${deploymentId}`,
      ...payload.rollback.commands.map((command) => `  ${command}`),
    ].join("\n"),
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
            message: "Only anvil-cloud deploy --preview is supported in alpha.",
          },
        ],
      },
      "Only anvil-cloud deploy --preview is supported in alpha.",
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
        hint: "Inspect the deployed Lambda logs and CloudFormation outputs, then rerun anvil-cloud deploy --preview --wait.",
        deployment: deployResult,
        verification,
      },
    };
  });
}

// Runs a CLI effect at the Promise boundary. Typed failures and defects are
// both rethrown as their original values so callers keep the pre-Effect
// error contract.
async function runCliEffect<T>(effect: Effect.Effect<T, Error>): Promise<T> {
  const exit = await Effect.runPromiseExit(effect);

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  throw Cause.squash(exit.cause);
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
            message:
              "Only anvil-cloud destroy --preview is supported in alpha.",
          },
        ],
      },
      "Only anvil-cloud destroy --preview is supported in alpha.",
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
            message: "Usage: anvil-cloud destroy --preview --app <name> --yes",
          },
        ],
      },
      "Usage: anvil-cloud destroy --preview --app <name> --yes",
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

  try {
    const environment = readEnvironment(context);

    if (environment === undefined) {
      return;
    }

    if (context.flags.has("dry-run")) {
      const stackName = awsPreviewStackNameFor(
        app,
        environment,
        process.env.ANVIL_AWS_STACK_PREFIX,
      );
      const metadataTable = process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;
      const result = {
        ok: true,
        adapter: "aws",
        cell: app,
        environment,
        dryRun: true,
        stackName,
        cleanup: {
          stack: {
            name: stackName,
            action: "delete",
          },
          stackOwnedBuckets: {
            action: "empty-before-delete",
          },
          deploymentMetadata:
            metadataTable === undefined
              ? null
              : {
                  action: "delete",
                  table: metadataTable,
                  key: `deployment#${app}#${environment}`,
                },
        },
        next: [`anvil-cloud destroy --preview --app ${app} --yes --json`],
      };

      writeJsonOrHuman(
        context,
        result,
        `Would delete AWS preview stack '${stackName}'.`,
      );
      return;
    }

    const destroyer = createAwsSdkPreviewDestroyerFromEnv();
    let result: Awaited<ReturnType<typeof destroyer.destroy>>;

    result = await destroyer.destroy({
      cell: app,
      environment,
    });

    writeJsonOrHuman(
      context,
      result,
      result.deleted
        ? `Deleted AWS preview stack '${result.stackName}'.`
        : `AWS preview stack '${result.stackName}' was already absent.`,
    );
  } catch (error) {
    if (error instanceof AwsPreviewDestroyError) {
      writeJsonOrHuman(
        context,
        {
          ok: false,
          code: error.code,
          message: error.message,
          hint: "Inspect the CloudFormation stack status and any retained S3 buckets, then rerun anvil-cloud destroy --preview --app <name> --yes.",
          details: error.details,
        },
        error.message,
      );
      process.exitCode = 6;
      return;
    }

    throw error;
  }
}

function formatAnvilPlan(
  plan: {
    changes: Array<{ kind: string; concept: string; name: string }>;
    review?: {
      cost?: {
        drivers?: Array<{ label: string; reason: string }>;
      };
      rollback?: {
        supported: boolean;
        notes: string[];
      };
      approvalGates?: Array<{
        id: string;
        required: boolean;
        severity: string;
        reason: string;
      }>;
    };
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
  const requiredGates =
    plan.review?.approvalGates?.filter((gate) => gate.required) ?? [];

  if (requiredGates.length > 0) {
    lines.push(
      "",
      "Review gates:",
      ...requiredGates.map((gate) => `* ${gate.severity}: ${gate.reason}`),
    );
  }

  if (plan.review?.cost?.drivers && plan.review.cost.drivers.length > 0) {
    lines.push(
      "",
      "Cost drivers:",
      ...plan.review.cost.drivers.map((driver) => `* ${driver.label}`),
    );
  }

  if (plan.review?.rollback) {
    lines.push(
      "",
      `Rollback: ${plan.review.rollback.supported ? "supported" : "manual"}`,
      ...plan.review.rollback.notes.map((note) => `* ${note}`),
    );
  }

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

function createBlockedReviewReportFromBuildResult(result: BuildResult) {
  const guardSummary = summarizeBuilderDiagnostics(result.diagnostics);

  return {
    ok: false,
    schemaVersion: "0.1",
    command: "review",
    target: {
      adapter: "aws",
      environment: "preview",
      cell: null,
    },
    status: "block",
    summary: {
      guardErrors: guardSummary.errors,
      guardWarnings: guardSummary.warnings,
      approvalRequired: 0,
      reviewGates: 0,
      blockingGates: 1,
      capabilityChanges: 0,
      costDrivers: 0,
      rollbackSupported: false,
    },
    guard: {
      ok: false,
      phase: result.phase,
      diagnostics: result.diagnostics,
      summary: guardSummary,
    },
    manifest: null,
    review: null,
    warnings: [],
    next: [
      "Fix Anvil Guard diagnostics, then rerun anvil-cloud review --json.",
    ],
  };
}

function createInvalidReviewReport(code: string, message: string) {
  return {
    ok: false,
    schemaVersion: "0.1",
    command: "review",
    target: {
      adapter: "aws",
      environment: "preview",
      cell: null,
    },
    status: "block",
    summary: {
      guardErrors: 1,
      guardWarnings: 0,
      approvalRequired: 0,
      reviewGates: 0,
      blockingGates: 1,
      capabilityChanges: 0,
      costDrivers: 0,
      rollbackSupported: false,
    },
    guard: {
      ok: false,
      diagnostics: [
        {
          code,
          severity: "error" as const,
          message,
        },
      ],
      summary: {
        errors: 1,
        warnings: 0,
        info: 0,
      },
    },
    manifest: null,
    review: null,
    warnings: [],
    next: ["Fix the invalid review command options, then rerun review."],
  };
}

function reviewReportExitCode(report: {
  status: string;
  guard: Record<string, unknown>;
}): number {
  const phase = report.guard.phase;

  if (phase === "typecheck" || phase === "import-policy") {
    return 3;
  }

  return report.status === "block" ? 6 : 3;
}

function summarizeBuilderDiagnostics(diagnostics: BuilderDiagnostic[]): {
  errors: number;
  warnings: number;
  info: number;
} {
  return {
    errors: diagnostics.filter((diagnostic) => diagnostic.severity === "error")
      .length,
    warnings: diagnostics.filter(
      (diagnostic) => diagnostic.severity === "warning",
    ).length,
    info: 0,
  };
}

function createReviewNextSteps(cell: string, status: string): string[] {
  if (status === "block") {
    return [
      "Resolve blocking review gates before deploying.",
      "anvil-cloud review --json",
    ];
  }

  if (status === "review") {
    return [
      "Review required approval gates before deploying.",
      "anvil-cloud deploy --preview --json",
      `anvil-cloud destroy --preview --app ${cell} --yes --json`,
    ];
  }

  return [
    "No required review gates were detected.",
    "anvil-cloud deploy --preview --json",
  ];
}

function formatReviewReport(report: {
  status: string;
  summary: {
    guardErrors: number;
    guardWarnings: number;
    approvalRequired: number;
    reviewGates: number;
    blockingGates: number;
    capabilityChanges: number;
    costDrivers: number;
    rollbackSupported: boolean;
  };
  target: {
    cell: string | null;
    adapter: string;
    environment: string;
  };
  guard: {
    diagnostics: BuilderDiagnostic[];
  };
  review: {
    approvalGates: Array<{
      id: string;
      severity: string;
      required: boolean;
      reason: string;
    }>;
  } | null;
  next: string[];
}): string {
  const lines = [
    `Anvil Cloud review: ${report.status}`,
    `Cell: ${report.target.cell ?? "unknown"} (${report.target.adapter}/${report.target.environment})`,
    `Guard: ${report.summary.guardErrors} error(s), ${report.summary.guardWarnings} warning(s)`,
    `Capabilities: ${report.summary.capabilityChanges} change(s), ${report.summary.costDrivers} cost driver(s)`,
    `Approval: ${report.summary.approvalRequired} required, ${report.summary.blockingGates} blocking`,
    `Rollback: ${report.summary.rollbackSupported ? "supported" : "manual"}`,
  ];

  if (report.guard.diagnostics.length > 0) {
    lines.push("", "Guard diagnostics:");
    lines.push(...formatDiagnostics(report.guard.diagnostics).split("\n"));
  }

  if (report.review && report.review.approvalGates.length > 0) {
    lines.push("", "Approval gates:");
    lines.push(
      ...report.review.approvalGates.map(
        (gate) =>
          `  ${gate.severity}${gate.required ? " required" : ""} ${gate.id}: ${gate.reason}`,
      ),
    );
  }

  lines.push("", "Next:");
  lines.push(...report.next.map((step) => `  ${step}`));

  return lines.join("\n");
}

async function discoverProjectAgents(rootDir: string): Promise<
  Array<{
    name: string;
    path: string;
    kind: "instructions";
  }>
> {
  const agentsDir = path.join(rootDir, "agents");
  const discovered: Array<{
    name: string;
    path: string;
    kind: "instructions";
  }> = [];

  if (!(await pathExists(agentsDir))) {
    return discovered;
  }

  for (const file of await walkFiles(agentsDir)) {
    if (path.basename(file) !== "instructions.md") {
      continue;
    }

    const relativePath = path.relative(rootDir, file);
    const name = path.basename(path.dirname(file));

    discovered.push({
      name,
      path: relativePath,
      kind: "instructions",
    });
  }

  return discovered.sort((left, right) => left.path.localeCompare(right.path));
}

async function walkFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function createGuardianFindings(report: {
  ok: boolean;
  status: string;
  summary: {
    guardErrors: number;
    guardWarnings: number;
    approvalRequired: number;
    blockingGates: number;
    rollbackSupported: boolean;
  };
  review: {
    approvalGates: Array<{
      id: string;
      severity: string;
      reason: string;
    }>;
  } | null;
}): Array<{
  severity: "info" | "review" | "block";
  code: string;
  message: string;
}> {
  const findings: Array<{
    severity: "info" | "review" | "block";
    code: string;
    message: string;
  }> = [];

  if (report.summary.guardErrors > 0) {
    findings.push({
      severity: "block",
      code: "GUARD_ERRORS",
      message: `${report.summary.guardErrors} Guard error(s) must be fixed before deploy.`,
    });
  }

  for (const gate of report.review?.approvalGates ?? []) {
    findings.push({
      severity: gate.severity as "info" | "review" | "block",
      code: `APPROVAL_${gate.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
      message: gate.reason,
    });
  }

  if (!report.summary.rollbackSupported) {
    findings.push({
      severity: "info",
      code: "ROLLBACK_MANUAL",
      message:
        "Preview rollback is manual; keep the previous checkout or deployment artifact available before mutating preview resources.",
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: "info",
      code: "NO_FINDINGS",
      message: "No Guardian findings were produced.",
    });
  }

  return findings;
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
            ? "No local users. Create one with `anvil-cloud auth add-user <id>`."
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
            : "Not signed in. Use `anvil-cloud auth login <id>`.",
        );
        return;
      }
      case "test": {
        const result = await runAuthConformanceSuite();

        if (!result.ok) {
          process.exitCode = 1;
        }

        writeJsonOrHuman(context, result, formatAuthConformanceResult(result));
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
                  "Usage: anvil-cloud auth <users|add-user|remove-user|login|token|whoami|test>",
              },
            ],
          },
          "Usage: anvil-cloud auth <users|add-user|remove-user|login|token|whoami|test>",
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
        ? "No local workflow runs. Start one with `anvil-cloud workflows run <name>`."
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
            message: "Usage: anvil-cloud services list [--json]",
          },
        ],
      },
      "Usage: anvil-cloud services list [--json]",
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
            "Usage: anvil-cloud workflows <list|show <runId>|run <name> [--input '<json>']>",
        },
      ],
    },
    "Usage: anvil-cloud workflows <list|show <runId>|run <name> [--input '<json>']>",
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

function readStarterClientKind(context: CliContext): StarterClientKind | null {
  const value = context.values.get("client") ?? "vite-react";

  if (
    value === "vite-react" ||
    value === "expo-router" ||
    value === "headless"
  ) {
    return value;
  }

  return null;
}

function readStarterTemplate(context: CliContext): StarterTemplate | null {
  const value = context.values.get("template") ?? "crud";

  if (
    value === "agent" ||
    value === "auth" ||
    value === "crud" ||
    value === "sandbox" ||
    value === "service" ||
    value === "workflow"
  ) {
    return value;
  }

  return null;
}

function writeHelp(): void {
  process.stdout.write(
    [
      "Anvil Cloud CLI",
      "",
      "Commands:",
      "  anvil-cloud new <name> [--client vite-react|expo-router|headless] [--template crud|auth|workflow|service|agent|sandbox]",
      "  anvil-cloud dev [--json] [--agent] [--port 8787] [--client-port 5173]",
      "  anvil-cloud doctor [--json] [--port 8787] [--client-port 5173]",
      "  anvil-cloud check [--json]",
      "  anvil-cloud review [--adapter aws] [--env preview] [--json]",
      "  anvil-cloud build [--json]",
      "  anvil-cloud eval [agent] [--baseline .anvil/evals/baseline.json] [--write-baseline] [--json]",
      "  anvil-cloud manifest diff [--from .anvil/dist/manifest.json] [--to manifest.json] [--json]",
      "  anvil-cloud inspect --local [--json]",
      "  anvil-cloud lens [--port 8787] [--json]",
      "  anvil-cloud logs --local [--json]",
      "  anvil-cloud logs --app <name> --env preview [--since 10m] [--limit 50] [--json]",
      "  anvil-cloud usage --local [--since 1h] [--json]",
      "  anvil-cloud usage --preview [--json]",
      "  anvil-cloud db list --local [--json]",
      "  anvil-cloud db dump <table> --local [--json]",
      "  anvil-cloud plan --stage dev --adapter aws [--verbose] [--json]",
      "  anvil-cloud deploy --stage dev --adapter aws [--verbose] [--json]",
      "  anvil-cloud remove --stage dev --adapter aws [--verbose] [--json]",
      "  anvil-cloud deploy --preview [--wait] [--wait-timeout 60] [--json]",
      "  anvil-cloud rollback --preview --app <name> --to-deployment <id> --dry-run [--json]",
      "  anvil-cloud destroy --preview --app <name> --yes [--dry-run] [--json]",
      "  anvil-cloud auth users [--json]",
      "  anvil-cloud auth add-user <id> [--email x@y] [--roles admin,editor] [--json]",
      "  anvil-cloud auth remove-user <id> [--json]",
      "  anvil-cloud auth login <id> [--json]",
      "  anvil-cloud auth token <id> [--ttl 3600] [--json]",
      "  anvil-cloud auth whoami [--json]",
      "  anvil-cloud auth test [--json]",
      "  anvil-cloud agents discover [--json]",
      "  anvil-cloud agents guardian [--json]",
      "  anvil-cloud workflows list [--json]",
      "  anvil-cloud workflows show <runId> [--json]",
      "  anvil-cloud workflows run <name> [--input '<json>'] [--json]",
      "  anvil-cloud services list [--json]",
      "",
    ].join("\n"),
  );
}

async function runDoctorChecks(context: CliContext): Promise<DoctorCheck[]> {
  const runtimePort = parseDoctorPort(context.values.get("port"), 8787);
  const clientPort = parseDoctorPort(context.values.get("client-port"), 5173);
  const runtimeUrl = `http://localhost:${runtimePort}`;
  const runtimeHealth = await checkLocalRuntimeHealth(runtimeUrl);
  const checks: DoctorCheck[] = [
    checkNodeVersion(),
    await checkPnpm(),
    await checkBuiltCli(),
    await checkPackagePublishingBoundary(),
    await checkProjectConfig(context.cwd),
    await checkBuildArtifacts(context.cwd),
    await checkGeneratedClient(context.cwd),
    await checkLocalState(context.cwd),
    runtimeHealth,
    await checkPort(
      "ports.runtime",
      runtimePort,
      runtimeHealth.status === "ok",
    ),
    await checkPort("ports.client", clientPort, false),
    checkAwsRegion(),
    checkEnvPresence(
      "aws.artifactBucket",
      "ANVIL_AWS_ARTIFACT_BUCKET",
      "AWS preview deploys require an artifact bucket.",
      "Set ANVIL_AWS_ARTIFACT_BUCKET before running deploy --preview.",
    ),
    checkEnvPresence(
      "aws.deploymentMetadataTable",
      "ANVIL_AWS_DEPLOYMENT_METADATA_TABLE",
      "Remote inspect/logs need deployment metadata.",
      "Set ANVIL_AWS_DEPLOYMENT_METADATA_TABLE to enable remote inspect/logs.",
    ),
    checkOidcConfig(),
    checkEnvPresence(
      "auth.smokeToken",
      "ANVIL_AWS_SMOKE_TOKEN",
      "No AWS preview smoke token is configured.",
      "Set ANVIL_AWS_SMOKE_TOKEN to exercise authenticated AWS preview query and mutation calls.",
    ),
    checkOptionalEnvPresence(
      "auth.expiredSmokeToken",
      "ANVIL_AWS_EXPIRED_SMOKE_TOKEN",
      "No expired AWS preview smoke token is configured.",
      "Set ANVIL_AWS_EXPIRED_SMOKE_TOKEN when you want verify:aws-preview to prove expired-token rejection.",
    ),
    checkOptionalEnvPresence(
      "auth.wrongIssuerSmokeToken",
      "ANVIL_AWS_WRONG_ISSUER_SMOKE_TOKEN",
      "No wrong-issuer AWS preview smoke token is configured.",
      "Set ANVIL_AWS_WRONG_ISSUER_SMOKE_TOKEN when you want verify:aws-preview to prove issuer rejection.",
    ),
    checkOptionalEnvPresence(
      "auth.wrongAudienceSmokeToken",
      "ANVIL_AWS_WRONG_AUDIENCE_SMOKE_TOKEN",
      "No wrong-audience AWS preview smoke token is configured.",
      "Set ANVIL_AWS_WRONG_AUDIENCE_SMOKE_TOKEN when you want verify:aws-preview to prove audience rejection.",
    ),
  ];

  return checks;
}

function checkNodeVersion(): DoctorCheck {
  const current = process.versions.node;
  const ok = compareVersions(current, "20.11.0") >= 0;

  return {
    id: "node.version",
    status: ok ? "ok" : "error",
    message: ok
      ? `Node ${current} satisfies >=20.11.0.`
      : `Node ${current} is below the required >=20.11.0.`,
    hint: ok ? undefined : "Install Node 20.11.0 or newer.",
    details: {
      current,
      required: ">=20.11.0",
    },
  };
}

async function checkPnpm(): Promise<DoctorCheck> {
  const result = await execFileResult("pnpm", ["--version"]);

  if (result.ok) {
    const version = result.stdout.trim();
    const ok = isPnpmVersionSupported(version);

    return {
      id: "pnpm.version",
      status: ok ? "ok" : "warning",
      message: ok
        ? `pnpm ${version} satisfies >=9.0.0.`
        : `pnpm ${version} is below the required >=9.0.0.`,
      hint: ok
        ? undefined
        : "Install pnpm 9.x before running workspace builds or example checks.",
      details: {
        version,
        required: ">=9.0.0",
      },
    };
  }

  return {
    id: "pnpm.version",
    status: "warning",
    message: "pnpm was not found on PATH.",
    hint: "Install pnpm 9.x before running workspace builds or example checks.",
    details: {
      error: result.error,
    },
  };
}

async function checkBuiltCli(): Promise<DoctorCheck> {
  const builtCliPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../dist/index.js",
  );
  const exists = await fileExists(builtCliPath);

  return {
    id: "cli.built",
    status: exists ? "ok" : "warning",
    message: exists
      ? "Built CLI entrypoint exists."
      : "Built CLI entrypoint was not found.",
    hint: exists
      ? undefined
      : "Run pnpm build in anvil-cloud before testing packaged CLI flows.",
    details: {
      path: builtCliPath,
    },
  };
}

async function checkPackagePublishingBoundary(): Promise<DoctorCheck> {
  const packageRoot = packageWorkspaceRoot();
  const packages = await readWorkspacePackageJsons(packageRoot);
  const violations: Array<{ packageName: string; message: string }> = [];
  const publicPackages: string[] = [];
  const internalPackages: string[] = [];

  for (const packageJson of packages) {
    const shouldBePublic = publicPackageNames.has(packageJson.name);

    if (shouldBePublic) {
      publicPackages.push(packageJson.name);

      if (packageJson.private !== false) {
        violations.push({
          packageName: packageJson.name,
          message: "public package must set private: false",
        });
      }

      if (packageJson.publishConfig?.access !== "public") {
        violations.push({
          packageName: packageJson.name,
          message: "public package must set publishConfig.access: public",
        });
      }

      for (const dependency of publishedWorkspaceDependencies(packageJson)) {
        violations.push({
          packageName: packageJson.name,
          message: `public package must not publish workspace dependency ${dependency}`,
        });
      }
    } else {
      internalPackages.push(packageJson.name);

      if (packageJson.private !== true) {
        violations.push({
          packageName: packageJson.name,
          message: "internal workspace package must remain private",
        });
      }
    }
  }

  return {
    id: "packages.publicBoundary",
    status: violations.length === 0 ? "ok" : "warning",
    message:
      violations.length === 0
        ? "Package publishing boundary matches the alpha contract."
        : "Package publishing boundary has drifted from the alpha contract.",
    hint:
      violations.length === 0
        ? undefined
        : "Update docs/contributing/package-publishing.md and the package-boundary test before changing public packages.",
    details: {
      publicPackages: publicPackages.sort(),
      candidatePublicApis: candidatePublicApiPackageNames,
      internalPackages: internalPackages.sort(),
      violations,
    },
  };
}

async function checkProjectConfig(rootDir: string): Promise<DoctorCheck> {
  const configPath = path.join(rootDir, "anvil.json");
  const config = await readOptionalJson(configPath);

  if (!config) {
    return {
      id: "project.config",
      status: "warning",
      message: "No anvil.json found in the current directory.",
      hint: "Run doctor inside a Cell project when checking local runtime state.",
      details: {
        path: configPath,
      },
    };
  }

  return {
    id: "project.config",
    status: "ok",
    message: "Cell config found.",
    details: {
      path: configPath,
      name: isObject(config) ? config.name : undefined,
    },
  };
}

async function checkBuildArtifacts(rootDir: string): Promise<DoctorCheck> {
  const manifestPath = path.join(rootDir, ".anvil/dist/manifest.json");
  const manifest = await readOptionalJson(manifestPath);

  if (!manifest) {
    return {
      id: "project.build",
      status: "warning",
      message: "No built manifest found.",
      hint: "Run anvil-cloud build --json before deploy, inspect, or generated client checks.",
      details: {
        path: manifestPath,
      },
    };
  }

  return {
    id: "project.build",
    status: "ok",
    message: "Built manifest found.",
    details: {
      path: manifestPath,
      cell:
        isObject(manifest) && isObject(manifest.cell)
          ? manifest.cell.name
          : undefined,
    },
  };
}

async function checkGeneratedClient(rootDir: string): Promise<DoctorCheck> {
  const generatedClientPath = path.join(rootDir, ".anvil/generated/client.ts");
  const manifestPath = path.join(rootDir, ".anvil/dist/manifest.json");
  const exists = await fileExists(generatedClientPath);

  if (!exists) {
    return {
      id: "project.generatedClient",
      status: "warning",
      message: "Generated client metadata was not found.",
      hint: "Run anvil-cloud build --json so @anvil/generated/client imports resolve.",
      details: {
        path: generatedClientPath,
      },
    };
  }

  const manifest = await readOptionalJson(manifestPath);
  const source = await readFile(generatedClientPath, "utf8");
  const generatedMetadata = extractGeneratedClientMetadata(source);
  const generatedQueries =
    generatedMetadata?.queries ??
    extractGeneratedClientRouteNames(source, "query");
  const generatedMutations =
    generatedMetadata?.mutations ??
    extractGeneratedClientRouteNames(source, "mutation");
  const manifestQueries = manifestRouteNames(manifest, "queries");
  const manifestMutations = manifestRouteNames(manifest, "mutations");
  const missingQueries = difference(manifestQueries, generatedQueries);
  const staleQueries = difference(generatedQueries, manifestQueries);
  const missingMutations = difference(manifestMutations, generatedMutations);
  const staleMutations = difference(generatedMutations, manifestMutations);
  const hasMismatch =
    missingQueries.length > 0 ||
    staleQueries.length > 0 ||
    missingMutations.length > 0 ||
    staleMutations.length > 0;

  return {
    id: "project.generatedClient",
    status: hasMismatch ? "warning" : "ok",
    message: hasMismatch
      ? "Generated client metadata does not match the built manifest."
      : "Generated client metadata matches the built manifest.",
    hint: hasMismatch
      ? "Run anvil-cloud build --json to refresh @anvil/generated/client."
      : undefined,
    details: {
      path: generatedClientPath,
      manifestPath,
      queries: {
        manifest: manifestQueries,
        generated: generatedQueries,
        missing: missingQueries,
        stale: staleQueries,
      },
      mutations: {
        manifest: manifestMutations,
        generated: generatedMutations,
        missing: missingMutations,
        stale: staleMutations,
      },
    },
  };
}

async function checkLocalState(rootDir: string): Promise<DoctorCheck> {
  const localDir = path.join(rootDir, ".anvil/local");
  const files = {
    authUsers: await fileExists(path.join(localDir, "auth/users.json")),
    authKeys: await fileExists(path.join(localDir, "auth/keys.json")),
    database: await fileExists(path.join(localDir, "dev.db")),
    logs: await fileExists(path.join(localDir, "logs.ndjson")),
    jobs: await fileExists(path.join(localDir, "jobs.json")),
    workflows: await fileExists(path.join(localDir, "workflows.json")),
    services: await fileExists(path.join(localDir, "services.json")),
  };
  const hasAnyState = Object.values(files).some(Boolean);

  return {
    id: "local.state",
    status: hasAnyState ? "ok" : "warning",
    message: hasAnyState
      ? "Local runtime state exists."
      : "No local runtime state found.",
    hint: hasAnyState
      ? undefined
      : "Run anvil-cloud dev or the notes verifier to create local auth, database, jobs, and logs state.",
    details: {
      path: localDir,
      files,
    },
  };
}

function extractGeneratedClientMetadata(
  source: string,
): { queries: string[]; mutations: string[] } | undefined {
  const metaMatch = source.match(/meta:\s*\{([\s\S]*?)\n\s*\}/);

  if (!metaMatch?.[1]) {
    return undefined;
  }

  const queries = extractStringArrayProperty(metaMatch[1], "queries");
  const mutations = extractStringArrayProperty(metaMatch[1], "mutations");

  if (!queries || !mutations) {
    return undefined;
  }

  return { queries, mutations };
}

function extractGeneratedClientRouteNames(
  source: string,
  kind: "query" | "mutation",
): string[] {
  return Array.from(
    source.matchAll(
      new RegExp(
        `kind:\\s*${JSON.stringify(kind)},\\s*name:\\s*"([^"]+)"`,
        "g",
      ),
    ),
    (match) => match[1],
  )
    .filter((name): name is string => typeof name === "string")
    .sort();
}

function extractStringArrayProperty(
  source: string,
  property: "queries" | "mutations",
): string[] | undefined {
  const arrayMatch = source.match(
    new RegExp(`${property}:\\s*\\[([\\s\\S]*?)\\]`),
  );

  if (!arrayMatch?.[1]) {
    return undefined;
  }

  return Array.from(arrayMatch[1].matchAll(/"((?:\\.|[^"\\])*)"/g), (match) =>
    parseJsonStringLiteral(match[0]),
  )
    .filter((name): name is string => typeof name === "string")
    .sort();
}

function parseJsonStringLiteral(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value);

    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

type WorkspacePackageJson = {
  name: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  publishConfig?: {
    access?: string;
  };
};

function packageWorkspaceRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

async function readWorkspacePackageJsons(
  rootDir: string,
): Promise<WorkspacePackageJson[]> {
  const packagesDir = path.join(rootDir, "packages");
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const packageJsons: WorkspacePackageJson[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packagePath = path.join(packagesDir, entry.name, "package.json");
    const packageJson = await readPackageJson(packagePath);

    if (packageJson) {
      packageJsons.push(packageJson);
    }
  }

  return packageJsons.sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

async function readPackageJson(
  packagePath: string,
): Promise<WorkspacePackageJson | null> {
  const value = await readOptionalJson(packagePath);

  if (!isObject(value) || typeof value.name !== "string") {
    return null;
  }

  return value as WorkspacePackageJson;
}

function publishedWorkspaceDependencies(
  packageJson: WorkspacePackageJson,
): string[] {
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
    ...packageJson.peerDependencies,
  };

  return Object.entries(dependencies)
    .filter(([, version]) => version.startsWith("workspace:"))
    .map(([name]) => name)
    .sort();
}

function manifestRouteNames(
  manifest: unknown,
  key: "queries" | "mutations",
): string[] {
  if (!isObject(manifest) || !Array.isArray(manifest[key])) {
    return [];
  }

  return manifest[key]
    .filter((value): value is string => typeof value === "string")
    .sort();
}

function difference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);

  return left.filter((value) => !rightSet.has(value));
}

async function checkLocalRuntimeHealth(
  runtimeUrl: string,
): Promise<DoctorCheck> {
  const healthUrl = new URL("/_anvil/health", runtimeUrl).toString();

  try {
    const response = await fetch(healthUrl);
    const body = await response.text();
    let payload: unknown;

    try {
      payload = body.length > 0 ? JSON.parse(body) : null;
    } catch {
      return {
        id: "local.runtime",
        status: "warning",
        message: `Runtime health endpoint did not return JSON at ${runtimeUrl}.`,
        hint: "Check whether another process is using the runtime port, or restart anvil-cloud dev with --port.",
        details: {
          url: healthUrl,
          status: response.status,
          reason: "invalid-json",
          contentType: response.headers.get("content-type") ?? null,
          body: body.slice(0, 200),
        },
      };
    }

    if (response.ok && isObject(payload) && payload.ok === true) {
      return {
        id: "local.runtime",
        status: "ok",
        message: `Anvil Local runtime is reachable at ${runtimeUrl}.`,
        details: {
          url: healthUrl,
          status: response.status,
        },
      };
    }

    return {
      id: "local.runtime",
      status: "warning",
      message: `Runtime health endpoint did not report ok: true at ${runtimeUrl}.`,
      hint: "Check whether this is an Anvil Local runtime, then restart anvil-cloud dev if routes are behaving strangely.",
      details: {
        url: healthUrl,
        status: response.status,
        reason: response.ok ? "not-anvil-health" : "http-status",
        payload,
      },
    };
  } catch (error) {
    return {
      id: "local.runtime",
      status: "warning",
      message: `No Anvil Local runtime is reachable at ${runtimeUrl}.`,
      hint: "Start one with anvil-cloud dev, or pass --port if it is running elsewhere.",
      details: {
        url: healthUrl,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function checkPort(
  id: string,
  port: number,
  occupiedByExpectedRuntime: boolean,
): Promise<DoctorCheck> {
  const available = await isPortAvailable(port);

  if (available) {
    return {
      id,
      status: "ok",
      message: `Port ${port} is available.`,
      details: { port },
    };
  }

  return {
    id,
    status: occupiedByExpectedRuntime ? "ok" : "warning",
    message: occupiedByExpectedRuntime
      ? `Port ${port} is in use by the Anvil Local runtime.`
      : `Port ${port} is already in use.`,
    hint: occupiedByExpectedRuntime
      ? undefined
      : "Use --port/--client-port with anvil-cloud dev, or stop the process using this port.",
    details: { port },
  };
}

function checkAwsRegion(): DoctorCheck {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

  return {
    id: "aws.region",
    status: region ? "ok" : "warning",
    message: region
      ? `AWS region is set to ${region}.`
      : "No AWS region is configured.",
    hint: region
      ? undefined
      : "Set AWS_REGION or AWS_DEFAULT_REGION before AWS preview verification.",
    details: {
      AWS_REGION: redactEnvPresence("AWS_REGION"),
      AWS_DEFAULT_REGION: redactEnvPresence("AWS_DEFAULT_REGION"),
    },
  };
}

function checkOidcConfig(): DoctorCheck {
  const issuer = process.env.ANVIL_AUTH_ISSUER;
  const audience = process.env.ANVIL_AUTH_AUDIENCE;
  const jwksUri = process.env.ANVIL_AUTH_JWKS_URI;
  const claims = oidcClaimMappingDetails();

  if (issuer && (audience || jwksUri)) {
    return {
      id: "auth.oidc",
      status: "ok",
      message: "OIDC token verification config is present.",
      details: {
        ANVIL_AUTH_ISSUER: true,
        ANVIL_AUTH_AUDIENCE: Boolean(audience),
        ANVIL_AUTH_JWKS_URI: Boolean(jwksUri),
        claims,
      },
    };
  }

  return {
    id: "auth.oidc",
    status: "warning",
    message: "OIDC token verification config is incomplete.",
    hint: "Set ANVIL_AUTH_ISSUER plus ANVIL_AUTH_AUDIENCE or ANVIL_AUTH_JWKS_URI before authenticated AWS preview smoke tests.",
    details: {
      ANVIL_AUTH_ISSUER: Boolean(issuer),
      ANVIL_AUTH_AUDIENCE: Boolean(audience),
      ANVIL_AUTH_JWKS_URI: Boolean(jwksUri),
      claims,
    },
  };
}

function oidcClaimMappingDetails(): Record<
  "userId" | "email" | "roles",
  { env: string; claim: string; configured: boolean }
> {
  return {
    userId: oidcClaimDetail("ANVIL_AUTH_USER_ID_CLAIM", "sub"),
    email: oidcClaimDetail("ANVIL_AUTH_EMAIL_CLAIM", "email"),
    roles: oidcClaimDetail("ANVIL_AUTH_ROLES_CLAIM", "roles"),
  };
}

function oidcClaimDetail(
  envName:
    | "ANVIL_AUTH_USER_ID_CLAIM"
    | "ANVIL_AUTH_EMAIL_CLAIM"
    | "ANVIL_AUTH_ROLES_CLAIM",
  defaultClaim: string,
): { env: string; claim: string; configured: boolean } {
  const configuredClaim = process.env[envName];

  return {
    env: envName,
    claim: configuredClaim ?? defaultClaim,
    configured: configuredClaim !== undefined,
  };
}

function checkEnvPresence(
  id: string,
  name: string,
  missingMessage: string,
  hint: string,
): DoctorCheck {
  const present = Boolean(process.env[name]);

  return {
    id,
    status: present ? "ok" : "warning",
    message: present ? `${name} is configured.` : missingMessage,
    hint: present ? undefined : hint,
    details: {
      [name]: present,
    },
  };
}

function checkOptionalEnvPresence(
  id: string,
  name: string,
  missingMessage: string,
  hint: string,
): DoctorCheck {
  const present = Boolean(process.env[name]);

  return {
    id,
    status: present ? "ok" : "info",
    message: present ? `${name} is configured.` : missingMessage,
    hint: present ? undefined : hint,
    details: {
      [name]: present,
    },
  };
}

function summarizeDoctorChecks(checks: DoctorCheck[]): {
  ok: number;
  info: number;
  warnings: number;
  errors: number;
} {
  return {
    ok: checks.filter((check) => check.status === "ok").length,
    info: checks.filter((check) => check.status === "info").length,
    warnings: checks.filter((check) => check.status === "warning").length,
    errors: checks.filter((check) => check.status === "error").length,
  };
}

function formatDoctorChecks(checks: DoctorCheck[]): string {
  const icons: Record<DoctorStatus, string> = {
    ok: "ok",
    info: "info",
    warning: "warn",
    error: "error",
  };

  return checks
    .map((check) => `${icons[check.status]} ${check.id}: ${check.message}`)
    .join("\n");
}

function formatAuthConformanceResult(result: AuthConformanceResult): string {
  const lines = [
    result.ok ? "Auth conformance passed." : "Auth conformance failed.",
    `Passed: ${result.summary.passed}; failed: ${result.summary.failed}.`,
    ...result.checks.map(
      (check) => `${check.status} ${check.id}: ${check.message}`,
    ),
    `Provider fixtures: ${result.fixtures
      .map((fixture) => fixture.provider)
      .join(", ")}.`,
  ];

  return lines.join("\n");
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

function parseDoctorPort(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = parsePositiveIntegerOption(value);

  return parsed ?? fallback;
}

function compareVersions(current: string, required: string): number {
  const currentParts = current.split(".").map((part) => Number(part));
  const requiredParts = required.split(".").map((part) => Number(part));
  const length = Math.max(currentParts.length, requiredParts.length);

  for (let index = 0; index < length; index += 1) {
    const currentPart = currentParts[index] ?? 0;
    const requiredPart = requiredParts[index] ?? 0;

    if (currentPart > requiredPart) {
      return 1;
    }

    if (currentPart < requiredPart) {
      return -1;
    }
  }

  return 0;
}

export function isPnpmVersionSupported(version: string): boolean {
  return compareVersions(version, "9.0.0") >= 0;
}

function execFileResult(
  command: string,
  args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { timeout: 3000 },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, error: error.message });
          return;
        }

        resolve({ ok: true, stdout });
      },
    );

    child.on("error", (error) => {
      resolve({ ok: false, error: error.message });
    });
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port, "127.0.0.1");
  });
}

function redactEnvPresence(name: string): boolean {
  return Boolean(process.env[name]);
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

async function readEvalBaseline(
  filePath: string,
): Promise<AgentEvalBaseline | undefined> {
  const json = await readOptionalJson(filePath);

  if (!isObject(json) || !isObject(json.agents)) {
    return undefined;
  }

  return json as AgentEvalBaseline;
}

function mergeEvalBaselines(baselines: AgentEvalBaseline[]): AgentEvalBaseline {
  const agents: AgentEvalBaseline["agents"] = {};

  for (const baseline of baselines) {
    for (const [agentName, agentBaseline] of Object.entries(
      baseline.agents ?? {},
    )) {
      const existing = agents[agentName];

      agents[agentName] = {
        scenarios: {
          ...(existing?.scenarios ?? {}),
          ...(agentBaseline.scenarios ?? {}),
        },
      };
    }
  }

  return { agents };
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

function createStarterScripts(
  name: string,
  clientKind: StarterClientKind,
): Record<string, string> {
  return {
    check: "anvil-cloud check --json",
    build: "anvil-cloud build --json",
    "manifest:diff": "anvil-cloud manifest diff --json",
    dev: "anvil-cloud dev --json",
    "inspect:local": "anvil-cloud inspect --local --json",
    "logs:local": "anvil-cloud logs --local --json",
    "deploy:preview:gate": "anvil-cloud deploy --preview --wait --json",
    "destroy:preview:dry-run": `anvil-cloud destroy --preview --app ${name} --yes --dry-run --json`,
    ...(clientKind === "expo-router" ? { start: "expo start" } : {}),
  };
}

function createStarterServerSource(template: StarterTemplate): string {
  const imports = new Set([
    "app",
    "boolean",
    "mutation",
    "query",
    "table",
    "text",
  ]);
  const capabilities = ["    database: true,"];
  const extraBlocks: string[] = [];

  if (template === "auth") {
    imports.add("userId");
  }

  if (template === "workflow") {
    imports.add("workflow");
    capabilities.push("    workflows: true,");
    extraBlocks.push(
      [
        "  workflows: {",
        "    onboardUser: workflow({",
        "      steps: [",
        "        {",
        '          name: "seedWelcomeTodo",',
        "          handler: async (ctx) => {",
        "            return ctx.db.todos.insert({",
        '              text: "Welcome to your new Cell",',
        "              done: false,",
        "            });",
        "          },",
        "        },",
        "      ],",
        "    }),",
        "  },",
      ].join("\n"),
    );
  }

  if (template === "service") {
    imports.add("service");
    capabilities.push("    services: true,");
    extraBlocks.push(
      [
        "  services: {",
        "    heartbeat: service({",
        '      restart: "always",',
        "      handler: async (ctx, controls) => {",
        "        while (!controls.stopping()) {",
        '          await ctx.log.info("Heartbeat service tick");',
        "          await new Promise((resolve) => setTimeout(resolve, 30000));",
        "        }",
        "      },",
        "    }),",
        "  },",
      ].join("\n"),
    );
  }

  if (template === "agent" || template === "sandbox") {
    imports.add("defineAgent");
    imports.add("endpoint");
    const runtime =
      template === "sandbox"
        ? [
            "      runtime: {",
            '        sandbox: "required",',
            '        humanApproval: "required",',
            "      },",
          ]
        : [];
    extraBlocks.push(
      [
        "  agents: {",
        "    support: defineAgent({",
        '      name: "support",',
        '      instructions: "Stay inside the declared Cell contract.",',
        '      model: { provider: "local", model: "stub" },',
        "      capabilities: {",
        '        cells: ["read"],',
        '        filesystem: "none",',
        '        secrets: "none",',
        "      },",
        "      approvals: {",
        '        requiredFor: ["email.sendExternal"],',
        "      },",
        ...runtime,
        "    }),",
        "  },",
        "  endpoints: {",
        "    chat: endpoint({",
        '      method: "POST",',
        '      path: "/api/chat",',
        '      auth: "public",',
        '      agent: "support",',
        "      handler: async () => ({ ok: true }),",
        "    }),",
        "  },",
      ].join("\n"),
    );
  }

  const schemaFields =
    template === "auth"
      ? [
          "      text: text().min(1).max(500),",
          "      done: boolean().default(false),",
          "      ownerId: userId(),",
        ]
      : [
          "      text: text().min(1).max(500),",
          "      done: boolean().default(false),",
        ];
  const listTodos =
    template === "auth"
      ? [
          "        return ctx.db.todos",
          '          .where("ownerId", "=", ctx.auth.requireUser())',
          "          .all();",
        ]
      : ["        return ctx.db.todos.all();"];
  const insertFields =
    template === "auth"
      ? [
          "          text: input.text,",
          "          done: false,",
          "          ownerId: ctx.auth.requireUser(),",
        ]
      : ["          text: input.text,", "          done: false,"];
  const auth = template === "auth" ? "required" : "public";
  const sections = [
    "  schema: {",
    "    todos: table({",
    ...schemaFields,
    "    }),",
    "  },",
    "  capabilities: {",
    ...capabilities,
    "  },",
    "  queries: {",
    "    listTodos: query({",
    `      auth: "${auth}",`,
    "      handler: async (ctx) => {",
    ...listTodos,
    "      },",
    "    }),",
    "  },",
    "  mutations: {",
    "    addTodo: mutation<{ text: string }>({",
    `      auth: "${auth}",`,
    "      handler: async (ctx, input) => {",
    "        return ctx.db.todos.insert({",
    ...insertFields,
    "        });",
    "      },",
    "    }),",
    "  },",
    ...extraBlocks,
  ];

  return [
    `import { ${Array.from(imports).sort().join(", ")} } from "@anvil-cloud/runtime";`,
    "",
    "export default app({",
    sections.join("\n"),
    "});",
    "",
  ].join("\n");
}

function createStarterDependencies(
  clientKind: StarterClientKind,
): Record<string, string> {
  const dependencies: Record<string, string> = {
    "@anvil-cloud/client": "workspace:*",
    "@anvil-cloud/runtime": "workspace:*",
  };

  if (clientKind === "expo-router") {
    return {
      ...dependencies,
      expo: "^56.0.12",
      "expo-router": "^56.2.11",
      react: "^19.2.7",
      "react-native": "^0.86.0",
    };
  }

  if (clientKind === "vite-react") {
    return {
      ...dependencies,
      "@vitejs/plugin-react": "^4.3.4",
      vite: "^5.4.21",
      react: "^18.3.1",
      "react-dom": "^18.3.1",
    };
  }

  return dependencies;
}

function createStarterDevDependencies(
  clientKind: StarterClientKind,
): Record<string, string> {
  if (clientKind === "expo-router") {
    return {
      "@types/react": "^19.2.17",
      typescript: "^5.7.2",
    };
  }

  if (clientKind === "vite-react") {
    return {
      "@types/react": "^18.3.12",
      "@types/react-dom": "^18.3.1",
      typescript: "^5.7.2",
    };
  }

  return {
    typescript: "^5.7.2",
  };
}

async function createStarterTsconfig(
  cellDir: string,
  clientKind: StarterClientKind,
): Promise<Record<string, unknown>> {
  const compilerOptions: Record<string, unknown> =
    clientKind === "expo-router"
      ? {
          target: "ES2022",
          lib: ["ES2022"],
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          jsx: "react-jsx",
          skipLibCheck: true,
        }
      : {
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

  const config: Record<string, unknown> = {
    compilerOptions,
    include:
      clientKind === "expo-router"
        ? [
            "app/**/*.ts",
            "app/**/*.tsx",
            "src/**/*.ts",
            "src/**/*.tsx",
            ".anvil/generated/**/*.ts",
          ]
        : ["src/**/*.ts", "src/**/*.tsx", ".anvil/generated/**/*.ts"],
  };

  if (clientKind === "expo-router") {
    config.extends = "expo/tsconfig.base";
  }

  return config;
}

async function detectLocalPackagePaths(
  cellDir: string,
): Promise<Record<string, string[]>> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const workspacePackagesRoot = path.resolve(currentDir, "..", "..");
  const packedPackagesRoot = path.resolve(currentDir, "packages");
  const candidates = {
    "@anvil-cloud/client": [
      path.join(workspacePackagesRoot, "client", "src", "index.ts"),
      path.join(packedPackagesRoot, "client", "src", "index.ts"),
    ],
    "@anvil-cloud/runtime": [
      path.join(workspacePackagesRoot, "runtime", "src", "index.ts"),
      path.join(packedPackagesRoot, "runtime", "src", "index.ts"),
    ],
  };
  const paths: Record<string, string[]> = {};

  for (const [specifier, sources] of Object.entries(candidates)) {
    const source = await firstExistingPath(sources);

    if (source) {
      paths[specifier] = [toPosixPath(path.relative(cellDir, source))];
    }
  }

  return paths;
}

async function firstExistingPath(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  return null;
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

  if (!entry) return false;

  if (pathToFileURL(entry).href === import.meta.url) return true;

  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}
