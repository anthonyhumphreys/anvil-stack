import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CloudflareAuthenticationMode } from "./support.js";
import {
  runCloudflareWranglerDelete,
  runCloudflareWranglerDeploy,
  runWranglerCommand,
  type WranglerCommandRunner,
} from "./wrangler.js";

export const MESH_PROVISIONER_RECIPE_ID = "anvil-mesh-provisioner";
export const MESH_PROVISIONER_EVIDENCE_GATE_ID =
  "anvil-mesh-provisioner-evidence-gate";
export const MESH_PROVISIONER_TOKEN_NAME = "PROVISIONER_TOKEN";
export const MESH_PROVISIONER_DEFAULT_WORKER_NAME = "anvil-mesh-provisioner";

type JsonObject = Record<string, unknown>;

export type MeshProvisionerDiagnostic = {
  code:
    | "PROVISIONER_PROJECT_MISSING"
    | "PROVISIONER_CONFIG_INVALID"
    | "PROVISIONER_ENTRYPOINT_MISSING"
    | "PROVISIONER_IMAGE_MISSING"
    | "PROVISIONER_OUTPUT_OVERWRITES_INPUT"
    | "PROVISIONER_AUTH_MISSING"
    | "PROVISIONER_TOKEN_REQUIRED"
    | "PROVISIONER_PROVIDER_EVIDENCE_REQUIRED";
  severity: "info" | "review" | "block";
  message: string;
  hint?: string;
};

export type MeshProvisionerGate = {
  id: string;
  required: true;
  severity: "block";
  reason: string;
};

export type MeshProvisionerEvidence = {
  reference: string;
  recordedAt?: string;
};

export type CreateMeshProvisionerDeploymentPlanOptions = {
  /** Directory containing cloud/provisioner/wrangler.jsonc. */
  provisionerDir: string;
  workerName?: string;
  accountId?: string;
  configPath?: string;
  authentication?: CloudflareAuthenticationMode;
  /** `managed` is informational; both modes deploy the same fail-closed Worker. */
  mode?: "managed" | "byo";
};

export type MeshProvisionerDeploymentPlan = {
  schemaVersion: "0.1";
  recipe: typeof MESH_PROVISIONER_RECIPE_ID;
  adapter: "cloudflare";
  mode: "managed" | "byo";
  authentication: CloudflareAuthenticationMode;
  workerName: string;
  accountId?: string;
  provisionerDir: string;
  sourceConfigPath: string;
  config: { path: string; contents: string };
  main: string;
  containerImages: string[];
  migrations: string[];
  vars: Record<string, string>;
  requiredSecrets: [typeof MESH_PROVISIONER_TOKEN_NAME];
  diagnostics: MeshProvisionerDiagnostic[];
  gates: [MeshProvisionerGate];
  operations: {
    apply: { gated: true; command: string };
    remove: { gated: true; command: string };
    provisionToken: { gated: true; command: string };
  };
};

export type MeshProvisionerLifecycleOptions = {
  plan: MeshProvisionerDeploymentPlan;
  evidence?: MeshProvisionerEvidence;
  dryRun?: boolean;
  command?: string;
  commandPrefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  run?: WranglerCommandRunner;
};

export type MeshProvisionerLifecycleResult = {
  ok: boolean;
  operation: "apply" | "remove" | "provision-token";
  gated: boolean;
  workerName: string;
  diagnostics: MeshProvisionerDiagnostic[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  evidence?: MeshProvisionerEvidence;
};

export type MeshProvisionerSecretCommandRunner = WranglerCommandRunner;

export type ProvisionMeshProvisionerTokenOptions =
  MeshProvisionerLifecycleOptions & {
    token?: string;
    tokenFile?: string;
    stdin?: NodeJS.ReadableStream;
    runSecret?: WranglerCommandRunner;
  };

/**
 * Reads the reference provisioner config and renders an independent overlay.
 * All paths are made relative to the generated config, so a config written by
 * `--write` remains reproducible when its output directory differs.
 */
export async function createMeshProvisionerDeploymentPlan(
  options: CreateMeshProvisionerDeploymentPlanOptions,
): Promise<MeshProvisionerDeploymentPlan> {
  const provisionerDir = path.resolve(options.provisionerDir);
  const sourceConfigPath = path.join(provisionerDir, "wrangler.jsonc");
  const configPath = path.resolve(
    options.configPath ??
      path.join(provisionerDir, "wrangler.provisioner.jsonc"),
  );
  const diagnostics: MeshProvisionerDiagnostic[] = [];
  const mode = options.mode ?? "byo";
  let source: JsonObject = {};

  if (!existsSync(sourceConfigPath)) {
    diagnostics.push({
      code: "PROVISIONER_PROJECT_MISSING",
      severity: "block",
      message: `No provisioner wrangler.jsonc found in ${provisionerDir}.`,
      hint: "Point --provisioner at anvil-app/cloud/provisioner.",
    });
  } else if (path.resolve(sourceConfigPath) === configPath) {
    diagnostics.push({
      code: "PROVISIONER_OUTPUT_OVERWRITES_INPUT",
      severity: "block",
      message:
        "Generated provisioner config must not overwrite wrangler.jsonc.",
    });
  } else {
    try {
      const parsed = parseJsonc(await readFile(sourceConfigPath, "utf8"));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error("configuration must contain a JSON object");
      }
      source = parsed as JsonObject;
    } catch (error) {
      diagnostics.push({
        code: "PROVISIONER_CONFIG_INVALID",
        severity: "block",
        message: `Could not parse ${sourceConfigPath}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const workerName =
    options.workerName ??
    stringValue(source.name) ??
    MESH_PROVISIONER_DEFAULT_WORKER_NAME;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workerName)) {
    diagnostics.push({
      code: "PROVISIONER_CONFIG_INVALID",
      severity: "block",
      message: `Invalid provisioner Worker name: ${workerName}.`,
    });
  }
  if (options.authentication === "temporary") {
    diagnostics.push({
      code: "PROVISIONER_CONFIG_INVALID",
      severity: "block",
      message:
        "Cloudflare Temporary Accounts do not support the Sandbox container deployment.",
      hint: "Use a permanent Cloudflare account for the provisioner Worker.",
    });
  }
  const sourceMain = stringValue(source.main) ?? "src/index.ts";
  const generatedMain = relativeSourcePath(
    configPath,
    path.resolve(provisionerDir, sourceMain),
  );
  if (!existsSync(path.resolve(provisionerDir, sourceMain))) {
    diagnostics.push({
      code: "PROVISIONER_ENTRYPOINT_MISSING",
      severity: "block",
      message: `Provisioner entrypoint does not exist: ${path.resolve(provisionerDir, sourceMain)}.`,
    });
  }

  const config = structuredClone(source) as JsonObject;
  config.name = workerName;
  config.main = generatedMain;
  if (options.accountId) config.account_id = options.accountId;
  const containers = Array.isArray(config.containers) ? config.containers : [];
  const imagePaths: string[] = [];
  config.containers = containers.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      return item;
    const container = { ...(item as JsonObject) };
    const image = stringValue(container.image);
    if (image) {
      const resolved = path.resolve(provisionerDir, image);
      imagePaths.push(resolved);
      container.image = relativeSourcePath(configPath, resolved);
      if (!existsSync(resolved)) {
        diagnostics.push({
          code: "PROVISIONER_IMAGE_MISSING",
          severity: "block",
          message: `Provisioner container image does not exist: ${resolved}.`,
          hint: "Run the image prepare step before deploy.",
        });
      }
    }
    return container;
  });
  const hasSandboxBinding =
    typeof config.durable_objects === "object" &&
    config.durable_objects !== null &&
    Array.isArray((config.durable_objects as JsonObject).bindings) &&
    ((config.durable_objects as JsonObject).bindings as unknown[]).some(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        (item as JsonObject).name === "Sandbox" &&
        (item as JsonObject).class_name === "Sandbox",
    );
  const hasSandboxContainer = containers.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as JsonObject).class_name === "Sandbox",
  );
  if (!hasSandboxBinding || !hasSandboxContainer) {
    diagnostics.push({
      code: "PROVISIONER_CONFIG_INVALID",
      severity: "block",
      message:
        "Provisioner config must declare the Sandbox Durable Object and Sandbox container.",
    });
  }
  if (
    typeof config.vars !== "object" ||
    config.vars === null ||
    Array.isArray(config.vars)
  )
    config.vars = {};
  const vars = Object.fromEntries(
    Object.entries(config.vars as JsonObject).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  config.vars = vars;
  if (vars.ALLOW_UNAUTHENTICATED !== "false") {
    diagnostics.push({
      code: "PROVISIONER_AUTH_MISSING",
      severity: "block",
      message: "Provisioner must deploy with ALLOW_UNAUTHENTICATED=false.",
      hint: "Keep public deployments bearer-authenticated.",
    });
  }
  const migrations = Array.isArray(config.migrations)
    ? config.migrations.flatMap((m) =>
        typeof m === "object" &&
        m !== null &&
        typeof (m as JsonObject).tag === "string"
          ? [(m as JsonObject).tag as string]
          : [],
      )
    : [];

  return {
    schemaVersion: "0.1",
    recipe: MESH_PROVISIONER_RECIPE_ID,
    adapter: "cloudflare",
    mode,
    authentication: options.authentication ?? "permanent",
    workerName,
    ...(options.accountId ? { accountId: options.accountId } : {}),
    provisionerDir,
    sourceConfigPath,
    config: {
      path: configPath,
      contents: `${JSON.stringify(config, null, 2)}\n`,
    },
    main: generatedMain,
    containerImages: imagePaths,
    migrations,
    vars,
    requiredSecrets: [MESH_PROVISIONER_TOKEN_NAME],
    diagnostics,
    gates: [
      {
        id: MESH_PROVISIONER_EVIDENCE_GATE_ID,
        required: true,
        severity: "block",
        reason:
          "Provisioner lifecycle mutates Cloudflare and requires recorded provider evidence.",
      },
    ],
    operations: {
      apply: { gated: true, command: `wrangler deploy --config ${configPath}` },
      remove: {
        gated: true,
        command: `wrangler delete --config ${configPath}`,
      },
      provisionToken: {
        gated: true,
        command: `wrangler secret put ${MESH_PROVISIONER_TOKEN_NAME} --config ${configPath}`,
      },
    },
  };
}

export async function writeMeshProvisionerWranglerConfig(
  plan: MeshProvisionerDeploymentPlan,
): Promise<{ path: string }> {
  await mkdir(path.dirname(plan.config.path), { recursive: true });
  await writeFile(plan.config.path, plan.config.contents, "utf8");
  return { path: plan.config.path };
}

export async function applyMeshProvisionerDeployment(
  options: MeshProvisionerLifecycleOptions,
): Promise<MeshProvisionerLifecycleResult> {
  const gate = lifecycleGate(options, "apply");
  if (gate) return gate;
  await writeMeshProvisionerWranglerConfig(options.plan);
  const result = await runCloudflareWranglerDeploy({
    artifacts: {
      directory: options.plan.provisionerDir,
      config: options.plan.config.path,
      workerName: options.plan.workerName,
    },
    authentication: options.plan.authentication,
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    command: resolveWranglerCommand(
      options.command,
      options.plan.provisionerDir,
    ),
    ...(options.commandPrefixArgs
      ? { commandPrefixArgs: options.commandPrefixArgs }
      : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.run ? { run: options.run } : {}),
  });
  return {
    ok: result.ok,
    operation: "apply",
    gated: false,
    workerName: options.plan.workerName,
    diagnostics: [],
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(options.evidence ? { evidence: options.evidence } : {}),
  };
}

export async function removeMeshProvisionerDeployment(
  options: MeshProvisionerLifecycleOptions,
): Promise<MeshProvisionerLifecycleResult> {
  const gate = lifecycleGate(options, "remove");
  if (gate) return gate;
  await writeMeshProvisionerWranglerConfig(options.plan);
  const result = await runCloudflareWranglerDelete({
    artifacts: {
      directory: options.plan.provisionerDir,
      config: options.plan.config.path,
      workerName: options.plan.workerName,
    },
    authentication: options.plan.authentication,
    command: resolveWranglerCommand(
      options.command,
      options.plan.provisionerDir,
    ),
    ...(options.commandPrefixArgs
      ? { commandPrefixArgs: options.commandPrefixArgs }
      : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.run ? { run: options.run } : {}),
  });
  return {
    ok: result.ok,
    operation: "remove",
    gated: false,
    workerName: options.plan.workerName,
    diagnostics: [],
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(options.evidence ? { evidence: options.evidence } : {}),
  };
}

/** Puts PROVISIONER_TOKEN through stdin; it is never included in argv or results. */
export async function provisionMeshProvisionerToken(
  options: ProvisionMeshProvisionerTokenOptions,
): Promise<MeshProvisionerLifecycleResult> {
  const gate = lifecycleGate(options, "provision-token");
  if (gate) return gate;
  const token = await readProvisionerToken(options);
  if (!token)
    return {
      ok: false,
      operation: "provision-token",
      gated: true,
      workerName: options.plan.workerName,
      diagnostics: [
        {
          code: "PROVISIONER_TOKEN_REQUIRED",
          severity: "block",
          message:
            "A non-empty PROVISIONER_TOKEN is required via token, tokenFile, or stdin.",
        },
      ],
    };
  await writeMeshProvisionerWranglerConfig(options.plan);
  const run = options.runSecret ?? runWranglerCommand;
  const result = await run({
    command: resolveWranglerCommand(
      options.command,
      options.plan.provisionerDir,
    ),
    args: [
      ...(options.commandPrefixArgs ?? []),
      "secret",
      "put",
      MESH_PROVISIONER_TOKEN_NAME,
      "--config",
      options.plan.config.path,
    ],
    cwd: options.plan.provisionerDir,
    env: {
      ...(options.env ?? process.env),
      FORCE_COLOR: "0",
      WRANGLER_HIDE_BANNER: "true",
      WRANGLER_LOG_SANITIZE: "true",
    },
    stdin: `${token}\n`,
  });
  return {
    ok: result.exitCode === 0,
    operation: "provision-token",
    gated: false,
    workerName: options.plan.workerName,
    diagnostics: [],
    exitCode: result.exitCode,
    stdout: redactToken(result.stdout, token),
    stderr: redactToken(result.stderr, token),
    ...(options.evidence ? { evidence: options.evidence } : {}),
  };
}

function lifecycleGate(
  options: MeshProvisionerLifecycleOptions,
  operation: "apply" | "remove" | "provision-token",
): MeshProvisionerLifecycleResult | undefined {
  const blocking = options.plan.diagnostics.filter(
    (item) => item.severity === "block",
  );
  if (blocking.length > 0)
    return {
      ok: false,
      operation,
      gated: true,
      workerName: options.plan.workerName,
      diagnostics: blocking,
    };
  if (operation === "apply" && options.dryRun === true) return undefined;
  if (!options.evidence?.reference)
    return {
      ok: false,
      operation,
      gated: true,
      workerName: options.plan.workerName,
      diagnostics: [
        {
          code: "PROVISIONER_PROVIDER_EVIDENCE_REQUIRED",
          severity: "block",
          message:
            "Provisioner lifecycle is gated until provider evidence is supplied.",
        },
      ],
    };
  return undefined;
}

async function readProvisionerToken(
  options: ProvisionMeshProvisionerTokenOptions,
): Promise<string> {
  if (options.token !== undefined) return options.token.trim();
  if (options.tokenFile !== undefined)
    return (await readFile(options.tokenFile, "utf8")).trim();
  if (!options.stdin) return "";
  let value = "";
  for await (const chunk of options.stdin) value += String(chunk);
  return value.trim();
}

function resolveWranglerCommand(command?: string, directory?: string): string {
  if (command) return command;
  const candidates = [
    ...(directory
      ? [path.resolve(directory, "node_modules/.bin/wrangler")]
      : []),
    path.resolve(process.cwd(), "node_modules/.bin/wrangler"),
    path.resolve(process.cwd(), "../node_modules/.bin/wrangler"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "wrangler";
}

function relativeSourcePath(configPath: string, sourcePath: string): string {
  const relative = path
    .relative(path.dirname(configPath), sourcePath)
    .split(path.sep)
    .join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function redactToken(value: string, token: string): string {
  return value.split(token).join("[REDACTED_PROVISIONER_TOKEN]");
}

function parseJsonc(source: string): unknown {
  let output = "";
  let quote = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (lineComment) {
      if (current === "\n") {
        lineComment = false;
        output += current;
      }
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (current === "\n") output += current;
      continue;
    }
    if (quote) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') quote = false;
      continue;
    }
    if (current === '"') {
      quote = true;
      output += current;
    } else if (current === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else output += current;
  }
  return JSON.parse(output.replace(/,\s*([}\]])/g, "$1"));
}
