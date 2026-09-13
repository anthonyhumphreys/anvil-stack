import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CloudflareAuthenticationMode } from "./support.js";
import {
  runCloudflareWranglerDelete,
  runCloudflareWranglerDeploy,
  type WranglerCommandRunner,
} from "./wrangler.js";

export const MESH_RECIPE_ID = "anvil-mesh-backend";
export const MESH_BACKEND_DESCRIPTOR_PATH = "/.well-known/anvil-backend";
export const MESH_PROVIDER_EVIDENCE_GATE_ID =
  "anvil-mesh-provider-evidence-gate";
export const MESH_GENERATED_CONFIG_NAME = "wrangler.mesh.jsonc";

const DEFAULT_STAGE = "production";
const FALLBACK_COMPATIBILITY_DATE = "2026-08-01";
const DEFAULT_ENTRYPOINT = "src/index.ts";
const WORKER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const WORKER_NAME_MAX_LENGTH = 63;

/**
 * Development-only backend environment keys. They must never be emitted by a
 * non-dev recipe: the production Worker must fail closed on the development
 * bearer and admin-token issuance paths, matching the backend project's own
 * top-level/`env.dev` split.
 */
const DEV_ONLY_ENVIRONMENT_KEYS = ["ANVIL_DEV_SPIKE", "ENROLLMENT_ADMIN_TOKEN"];

const EXPECTED_DURABLE_OBJECTS = [
  { binding: "ACCOUNT", className: "AccountCoordinator" },
  { binding: "SESSIONS", className: "SessionCoordinator" },
] as const;

const EXPECTED_R2_BINDING = "ARTIFACTS";

export type MeshRecipeDiagnostic = {
  code:
    | "MESH_BACKEND_PROJECT_MISSING"
    | "MESH_BACKEND_CONFIG_INVALID"
    | "MESH_BACKEND_ENTRYPOINT_MISSING"
    | "MESH_BACKEND_BINDINGS_MISSING"
    | "MESH_WORKER_NAME_INVALID"
    | "MESH_DEV_ONLY_VALUE"
    | "MESH_TEMPORARY_UNSUPPORTED"
    | "MESH_OIDC_INCOMPLETE"
    | "MESH_ACCOUNT_INPUT_MISSING"
    | "MESH_CONNECTION_URL_INVALID"
    | "MESH_CONNECTION_URL_MISSING"
    | "MESH_PROVIDER_EVIDENCE_REQUIRED";
  severity: "info" | "review" | "block";
  message: string;
  hint?: string;
};

export type MeshRecipeGate = {
  id: string;
  required: boolean;
  severity: "info" | "review" | "block";
  reason: string;
};

export type MeshDurableObjectBinding = {
  binding: string;
  className: string;
};

export type MeshDurableObjectMigration = {
  tag: string;
  newClasses: string[];
  newSqliteClasses: string[];
};

export type MeshR2BucketBinding = {
  binding: string;
  bucketName: string;
};

export type MeshSecretInput = {
  name: string;
  required: boolean;
  devOnly: boolean;
  purpose: string;
};

export type MeshConnectionRecord = {
  schemaVersion: "0.1";
  kind: typeof MESH_RECIPE_ID;
  workerName: string;
  stage: string;
  baseUrl: string;
  descriptorUrl: string;
};

export type MeshConnectionPlan =
  | {
      ready: true;
      descriptorPath: typeof MESH_BACKEND_DESCRIPTOR_PATH;
      baseUrl: string;
      descriptorUrl: string;
      outputPath?: string;
    }
  | {
      ready: false;
      descriptorPath: typeof MESH_BACKEND_DESCRIPTOR_PATH;
      reason: string;
      outputPath?: string;
    };

export type MeshRecipeOperations = {
  apply: {
    gated: true;
    gate: string;
    commands: string[];
    notes: string[];
  };
  upgrade: {
    commands: string[];
    notes: string[];
  };
  retain: {
    notes: string[];
  };
  remove: {
    gated: true;
    gate: string;
    commands: string[];
    notes: string[];
  };
};

export type MeshDeploymentPlan = {
  schemaVersion: "0.1";
  recipe: typeof MESH_RECIPE_ID;
  adapter: "cloudflare";
  stage: string;
  dev: boolean;
  authentication: CloudflareAuthenticationMode;
  workerName: string;
  backendDir: string;
  config: {
    path: string;
    contents: string;
    environmentName?: string;
  };
  durableObjects: MeshDurableObjectBinding[];
  migrations: MeshDurableObjectMigration[];
  migrationMode: "create" | "existing";
  r2Buckets: MeshR2BucketBinding[];
  vars: Record<string, string>;
  secrets: MeshSecretInput[];
  advertisedAuthModes: string[];
  diagnostics: MeshRecipeDiagnostic[];
  gates: MeshRecipeGate[];
  connection: MeshConnectionPlan;
  operations: MeshRecipeOperations;
  warnings: string[];
};

export type CreateMeshDeploymentPlanOptions = {
  /** Directory containing the Mesh backend Worker project. */
  backendDir: string;
  /** Worker script name to deploy (`wrangler` `name`). */
  workerName: string;
  /** Deployment stage label recorded in the plan. Defaults to "production". */
  stage?: string;
  /** Optional Wrangler named environment emitted under `env`. */
  environmentName?: string;
  /** Cloudflare account id emitted as `account_id` when supplied. */
  accountId?: string;
  /** Absolute base URL the deployment will be reachable at. */
  baseUrl?: string;
  /** workers.dev subdomain used to derive the base URL when absent. */
  workersDevSubdomain?: string;
  /** Permit plain http base URLs for loopback development endpoints only. */
  allowInsecureBaseUrl?: boolean;
  /** R2 bucket name override for the ARTIFACTS binding. */
  artifactsBucketName?: string;
  /** Non-secret Worker vars (for example OIDC_ISSUER/OIDC_CLIENT_ID). */
  vars?: Record<string, string>;
  /** Secret names the operator provisions out of band. Never values. */
  secrets?: string[];
  /** Emit the first-deploy Durable Object new-class migrations. */
  firstDeploy?: boolean;
  /** Development recipe: permits development-only environment keys. */
  dev?: boolean;
  authentication?: CloudflareAuthenticationMode;
  /** Generated config path; defaults to `<backendDir>/wrangler.mesh.jsonc`. */
  configPath?: string;
  /** Where the connection export should be written once a base URL is known. */
  connectionPath?: string;
};

export type MeshProviderEvidence = {
  /** Reference identifying recorded provider lifecycle evidence. */
  reference: string;
  recordedAt?: string;
};

export type MeshLifecycleResult = {
  ok: boolean;
  operation: "apply" | "remove";
  gated: boolean;
  workerName: string;
  diagnostics: MeshRecipeDiagnostic[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  workerUrl?: string;
  connection?: MeshConnectionRecord;
  evidence?: MeshProviderEvidence;
};

export type MeshLifecycleOptions = {
  plan: MeshDeploymentPlan;
  /**
   * Recorded provider lifecycle evidence that opens the apply/remove gate.
   * Without it, mutating lifecycle calls return MESH_PROVIDER_EVIDENCE_REQUIRED
   * and never spawn Wrangler.
   */
  evidence?: MeshProviderEvidence;
  /**
   * `wrangler deploy --dry-run` compiles locally without provider mutation and
   * does not require evidence, matching the package's non-live verify path.
   */
  dryRun?: boolean;
  command?: string;
  commandPrefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  run?: WranglerCommandRunner;
  onClaimUrl?: (claimUrl: string) => void | Promise<void>;
};

export type CreateMeshConnectionRecordOptions = {
  workerName: string;
  stage?: string;
  baseUrl: string;
  allowInsecureBaseUrl?: boolean;
};

export type MeshConnectionRecordResult =
  | { ok: true; record: MeshConnectionRecord }
  | {
      ok: false;
      errors: { code: "MESH_CONNECTION_URL_INVALID"; message: string }[];
    };

/**
 * Plans a bounded Cloudflare deployment of the Mesh backend Worker project.
 * The recipe consumes the project directory as the deployable artifact: it
 * reads the project's own Wrangler configuration for bindings and migrations,
 * then renders a generated overlay config. No provider calls are made.
 */
export async function createMeshDeploymentPlan(
  options: CreateMeshDeploymentPlanOptions,
): Promise<MeshDeploymentPlan> {
  const backendDir = path.resolve(options.backendDir);
  const stage = options.stage ?? DEFAULT_STAGE;
  const dev = options.dev === true;
  const authentication = options.authentication ?? "permanent";
  const diagnostics: MeshRecipeDiagnostic[] = [];

  if (!isValidWorkerName(options.workerName)) {
    diagnostics.push({
      code: "MESH_WORKER_NAME_INVALID",
      severity: "block",
      message:
        "Worker name must be 1-63 lowercase alphanumeric characters or hyphens and cannot start or end with a hyphen.",
      hint: "Supply --name with a valid Cloudflare Worker script name.",
    });
  }

  const source = await readBackendProject(backendDir, diagnostics);

  const durableObjects =
    source?.durableObjects ??
    EXPECTED_DURABLE_OBJECTS.map((item) => ({ ...item }));
  const r2Buckets = source
    ? source.r2Buckets.map((bucket) => ({
        binding: bucket.binding,
        bucketName:
          options.artifactsBucketName && bucket.binding === EXPECTED_R2_BINDING
            ? options.artifactsBucketName
            : bucket.bucketName,
      }))
    : options.artifactsBucketName
      ? [
          {
            binding: EXPECTED_R2_BINDING,
            bucketName: options.artifactsBucketName,
          },
        ]
      : [];

  if (source) {
    const missingDurableObjects = EXPECTED_DURABLE_OBJECTS.filter(
      (expected) =>
        !source.durableObjects.some(
          (binding) =>
            binding.binding === expected.binding &&
            binding.className === expected.className,
        ),
    );
    const missingR2 = source.r2Buckets.every(
      (bucket) => bucket.binding !== EXPECTED_R2_BINDING,
    );
    if (missingDurableObjects.length > 0 || missingR2) {
      diagnostics.push({
        code: "MESH_BACKEND_BINDINGS_MISSING",
        severity: "block",
        message:
          "The backend Wrangler configuration does not declare the expected Mesh bindings.",
        hint: `Expected Durable Object bindings ${EXPECTED_DURABLE_OBJECTS.map(
          (item) => `${item.binding} (${item.className})`,
        ).join(", ")} and R2 bucket binding ${EXPECTED_R2_BINDING}.`,
      });
    }
  }

  const vars: Record<string, string> = {};
  let rejectedDevValues = 0;
  for (const [name, value] of Object.entries(options.vars ?? {}).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (DEV_ONLY_ENVIRONMENT_KEYS.includes(name) && !dev) {
      rejectedDevValues += 1;
      continue;
    }
    vars[name] = value;
  }

  const secrets: MeshSecretInput[] = [];
  for (const name of [...(options.secrets ?? [])].sort()) {
    if (DEV_ONLY_ENVIRONMENT_KEYS.includes(name) && !dev) {
      rejectedDevValues += 1;
      continue;
    }
    secrets.push({
      name,
      required: false,
      devOnly: DEV_ONLY_ENVIRONMENT_KEYS.includes(name),
      purpose:
        name === "ENROLLMENT_ADMIN_TOKEN"
          ? "Enables admin-issued enrollment codes."
          : "Operator-provisioned Worker secret.",
    });
  }

  if (rejectedDevValues > 0) {
    diagnostics.push({
      code: "MESH_DEV_ONLY_VALUE",
      severity: "block",
      message:
        "Development-only backend environment keys were requested for a non-dev recipe and were removed.",
      hint: "Use the dev recipe (--dev) for local fixtures; production plans fail closed on development-only keys.",
    });
  }

  const oidcIssuer = vars.OIDC_ISSUER;
  const oidcClientId = vars.OIDC_CLIENT_ID;
  const oidcConfigured = Boolean(oidcIssuer && oidcClientId);
  if (Boolean(oidcIssuer) !== Boolean(oidcClientId)) {
    diagnostics.push({
      code: "MESH_OIDC_INCOMPLETE",
      severity: "review",
      message:
        "OIDC issuer and client id must be configured together; the backend advertises oidc-pkce only when both are set.",
      hint: "Set OIDC_ISSUER and OIDC_CLIENT_ID vars, or neither.",
    });
  }

  if (authentication === "temporary" && r2Buckets.length > 0) {
    diagnostics.push({
      code: "MESH_TEMPORARY_UNSUPPORTED",
      severity: "block",
      message:
        "Cloudflare Temporary Accounts do not list R2 as a supported resource; the Mesh backend requires the ARTIFACTS bucket binding.",
      hint: "Use a permanent Cloudflare account for Mesh backend deployments.",
    });
  }

  if (!options.accountId) {
    diagnostics.push({
      code: "MESH_ACCOUNT_INPUT_MISSING",
      severity: "info",
      message:
        "No Cloudflare account id was supplied; apply requires CLOUDFLARE_ACCOUNT_ID or an authenticated Wrangler login.",
      hint: "Pass the account id or ensure Wrangler credentials resolve one.",
    });
  }

  const migrationMode = options.firstDeploy ? "create" : "existing";
  const migrations =
    migrationMode === "create" ? (source?.newClassMigrations ?? []) : [];

  const connection = resolveConnectionPlan(options, diagnostics);

  const configPath = path.resolve(
    options.configPath ?? path.join(backendDir, MESH_GENERATED_CONFIG_NAME),
  );
  const configObject = buildMeshConfigObject({
    backendDir,
    workerName: options.workerName,
    stage,
    ...(options.environmentName
      ? { environmentName: options.environmentName }
      : {}),
    ...(options.accountId ? { accountId: options.accountId } : {}),
    main: source?.main ?? DEFAULT_ENTRYPOINT,
    compatibilityDate: source?.compatibilityDate ?? FALLBACK_COMPATIBILITY_DATE,
    durableObjects,
    migrations,
    r2Buckets,
    vars,
    configPath,
  });

  const deployCommand = `wrangler deploy --config ${configPath}`;
  const deleteCommand = `wrangler delete --config ${configPath}`;

  return {
    schemaVersion: "0.1",
    recipe: MESH_RECIPE_ID,
    adapter: "cloudflare",
    stage,
    dev,
    authentication,
    workerName: options.workerName,
    backendDir,
    config: {
      path: configPath,
      contents: `${JSON.stringify(configObject, null, 2)}\n`,
      ...(options.environmentName
        ? { environmentName: options.environmentName }
        : {}),
    },
    durableObjects,
    migrations,
    migrationMode,
    r2Buckets,
    vars,
    secrets,
    advertisedAuthModes: oidcConfigured
      ? ["enrollment-code", "oidc-pkce"]
      : ["enrollment-code"],
    diagnostics,
    gates: [
      {
        id: MESH_PROVIDER_EVIDENCE_GATE_ID,
        required: true,
        severity: "block",
        reason:
          "Mesh apply/remove stay gated until provider lifecycle smoke evidence is recorded against the generated configuration, matching the adapter's plan-only convention.",
      },
    ],
    connection,
    operations: {
      apply: {
        gated: true,
        gate: MESH_PROVIDER_EVIDENCE_GATE_ID,
        commands: [deployCommand],
        notes: [
          "Apply compiles and uploads the backend Worker through Wrangler. It stays gated until provider lifecycle smoke evidence is recorded for this recipe.",
        ],
      },
      upgrade: {
        commands: [deployCommand],
        notes: [
          "Re-running the same generated config upgrades the Worker in place; Durable Object migration tags are idempotent.",
          "New Durable Object classes must ship as new migration tags; never reuse an applied tag.",
        ],
      },
      retain: {
        notes: [
          "Removing the Worker script retains Durable Object storage and R2 objects under the account; delete that data explicitly only when a full teardown is intended.",
        ],
      },
      remove: {
        gated: true,
        gate: MESH_PROVIDER_EVIDENCE_GATE_ID,
        commands: [deleteCommand],
        notes: [
          "Remove deletes the Worker script through Wrangler. It stays gated until provider lifecycle smoke evidence is recorded for this recipe.",
        ],
      },
    },
    warnings: diagnostics.map((diagnostic) => diagnostic.message),
  };
}

/**
 * Writes the plan's generated Wrangler config to `plan.config.path`.
 */
export async function writeMeshWranglerConfig(
  plan: MeshDeploymentPlan,
): Promise<{ path: string }> {
  await mkdir(path.dirname(plan.config.path), { recursive: true });
  await writeFile(plan.config.path, plan.config.contents, "utf8");

  return { path: plan.config.path };
}

/**
 * Builds the desktop-pinnable connection record. The descriptor URL is always
 * `<base>/.well-known/anvil-backend`, matching the backend's discovery route.
 */
export function createMeshConnectionRecord(
  options: CreateMeshConnectionRecordOptions,
): MeshConnectionRecordResult {
  const normalized = normalizeMeshBaseUrl(options.baseUrl, {
    allowInsecureBaseUrl: options.allowInsecureBaseUrl === true,
  });

  if (!normalized.ok) {
    return {
      ok: false,
      errors: [
        { code: "MESH_CONNECTION_URL_INVALID", message: normalized.message },
      ],
    };
  }

  return {
    ok: true,
    record: {
      schemaVersion: "0.1",
      kind: MESH_RECIPE_ID,
      workerName: options.workerName,
      stage: options.stage ?? DEFAULT_STAGE,
      baseUrl: normalized.url,
      descriptorUrl: `${normalized.url}${MESH_BACKEND_DESCRIPTOR_PATH}`,
    },
  };
}

/**
 * Writes a connection record as JSON for the desktop to pin.
 */
export async function writeMeshConnectionRecord(
  record: MeshConnectionRecord,
  outputPath: string,
): Promise<{ path: string }> {
  const resolved = path.resolve(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  return { path: resolved };
}

/**
 * Gated apply: compiles and uploads the backend Worker through
 * `wrangler deploy` against the generated config. Mutating applies require
 * recorded provider evidence; `--dry-run` compilation does not. Blocking plan
 * diagnostics always fail closed.
 */
export async function applyMeshDeployment(
  options: MeshLifecycleOptions,
): Promise<MeshLifecycleResult> {
  const gate = evaluateLifecycleGate(options.plan, "apply", options);
  if (gate) return gate;

  await writeMeshWranglerConfig(options.plan);

  const deployment = await runCloudflareWranglerDeploy({
    artifacts: {
      directory: options.plan.backendDir,
      config: options.plan.config.path,
      workerName: options.plan.workerName,
    },
    authentication: options.plan.authentication,
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.command ? { command: options.command } : {}),
    ...(options.commandPrefixArgs
      ? { commandPrefixArgs: options.commandPrefixArgs }
      : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.run ? { run: options.run } : {}),
    ...(options.onClaimUrl ? { onClaimUrl: options.onClaimUrl } : {}),
  });

  const connection = resolveAppliedConnection(
    options.plan,
    deployment.previewUrl,
  );
  if (connection && options.plan.connection.outputPath) {
    await writeMeshConnectionRecord(
      connection,
      options.plan.connection.outputPath,
    );
  }

  return {
    ok: deployment.ok,
    operation: "apply",
    gated: false,
    workerName: options.plan.workerName,
    diagnostics: [],
    exitCode: deployment.exitCode,
    stdout: deployment.stdout,
    stderr: deployment.stderr,
    ...(deployment.previewUrl ? { workerUrl: deployment.previewUrl } : {}),
    ...(connection ? { connection } : {}),
    ...(options.evidence ? { evidence: options.evidence } : {}),
  };
}

/**
 * Gated remove: deletes the Worker script through `wrangler delete` against the
 * generated config. Always requires recorded provider evidence; there is no
 * un-gated path.
 */
export async function removeMeshDeployment(
  options: MeshLifecycleOptions,
): Promise<MeshLifecycleResult> {
  const gate = evaluateLifecycleGate(options.plan, "remove", options);
  if (gate) return gate;

  const deletion = await runCloudflareWranglerDelete({
    artifacts: {
      directory: options.plan.backendDir,
      config: options.plan.config.path,
      workerName: options.plan.workerName,
    },
    authentication: options.plan.authentication,
    ...(options.command ? { command: options.command } : {}),
    ...(options.commandPrefixArgs
      ? { commandPrefixArgs: options.commandPrefixArgs }
      : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.run ? { run: options.run } : {}),
  });

  return {
    ok: deletion.ok,
    operation: "remove",
    gated: false,
    workerName: options.plan.workerName,
    diagnostics: [],
    exitCode: deletion.exitCode,
    stdout: deletion.stdout,
    stderr: deletion.stderr,
    ...(options.evidence ? { evidence: options.evidence } : {}),
  };
}

function evaluateLifecycleGate(
  plan: MeshDeploymentPlan,
  operation: "apply" | "remove",
  options: MeshLifecycleOptions,
): MeshLifecycleResult | undefined {
  const blocking = plan.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "block",
  );
  if (blocking.length > 0) {
    return {
      ok: false,
      operation,
      gated: true,
      workerName: plan.workerName,
      diagnostics: blocking,
    };
  }

  if (operation === "apply" && options.dryRun === true) {
    return undefined;
  }

  if (!options.evidence?.reference) {
    return {
      ok: false,
      operation,
      gated: true,
      workerName: plan.workerName,
      diagnostics: [
        {
          code: "MESH_PROVIDER_EVIDENCE_REQUIRED",
          severity: "block",
          message: `Mesh ${operation} is gated until provider lifecycle smoke evidence is recorded against the generated configuration.`,
          hint: `Record provider lifecycle evidence for ${plan.recipe}, then pass its reference as evidence. ${operation === "apply" ? "`wrangler deploy --dry-run` remains available without evidence." : ""}`.trim(),
        },
      ],
    };
  }

  return undefined;
}

function resolveAppliedConnection(
  plan: MeshDeploymentPlan,
  previewUrl: string | undefined,
): MeshConnectionRecord | undefined {
  if (previewUrl) {
    const derived = createMeshConnectionRecord({
      workerName: plan.workerName,
      stage: plan.stage,
      baseUrl: previewUrl,
      allowInsecureBaseUrl: true,
    });
    if (derived.ok) return derived.record;
  }

  return plan.connection.ready
    ? {
        schemaVersion: "0.1",
        kind: MESH_RECIPE_ID,
        workerName: plan.workerName,
        stage: plan.stage,
        baseUrl: plan.connection.baseUrl,
        descriptorUrl: plan.connection.descriptorUrl,
      }
    : undefined;
}

function resolveConnectionPlan(
  options: CreateMeshDeploymentPlanOptions,
  diagnostics: MeshRecipeDiagnostic[],
): MeshConnectionPlan {
  const outputPath = options.connectionPath
    ? path.resolve(options.connectionPath)
    : undefined;
  const baseUrl =
    options.baseUrl ??
    (options.workersDevSubdomain
      ? `https://${options.workerName}.${options.workersDevSubdomain}.workers.dev`
      : undefined);

  if (baseUrl === undefined) {
    diagnostics.push({
      code: "MESH_CONNECTION_URL_MISSING",
      severity: "info",
      message:
        "No base URL was supplied, so the connection export is deferred until apply reports a workers.dev URL or one is provided.",
      hint: "Pass a base URL or workers.dev subdomain to emit the connection record at plan time.",
    });
    return {
      ready: false,
      descriptorPath: MESH_BACKEND_DESCRIPTOR_PATH,
      reason:
        "Supply a base URL or workers.dev subdomain to emit the connection record at plan time.",
      ...(outputPath ? { outputPath } : {}),
    };
  }

  const normalized = normalizeMeshBaseUrl(baseUrl, {
    allowInsecureBaseUrl: options.allowInsecureBaseUrl === true,
  });
  if (!normalized.ok) {
    diagnostics.push({
      code: "MESH_CONNECTION_URL_INVALID",
      severity: "block",
      message: normalized.message,
      hint: "Use an https base URL (or a loopback http URL with the explicit insecure opt-in).",
    });
    return {
      ready: false,
      descriptorPath: MESH_BACKEND_DESCRIPTOR_PATH,
      reason: normalized.message,
      ...(outputPath ? { outputPath } : {}),
    };
  }

  return {
    ready: true,
    descriptorPath: MESH_BACKEND_DESCRIPTOR_PATH,
    baseUrl: normalized.url,
    descriptorUrl: `${normalized.url}${MESH_BACKEND_DESCRIPTOR_PATH}`,
    ...(outputPath ? { outputPath } : {}),
  };
}

function normalizeMeshBaseUrl(
  value: string,
  options: { allowInsecureBaseUrl: boolean },
): { ok: true; url: string } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: "Base URL is not a valid absolute URL." };
  }

  if (url.username !== "" || url.password !== "") {
    return { ok: false, message: "Base URL must not embed credentials." };
  }

  const secure = url.protocol === "https:";
  const loopbackHttp =
    url.protocol === "http:" &&
    options.allowInsecureBaseUrl &&
    isLoopbackHostname(url.hostname);
  if (!secure && !loopbackHttp) {
    return {
      ok: false,
      message:
        "Base URL must use https; http is allowed only for loopback endpoints with the explicit insecure opt-in.",
    };
  }

  url.hash = "";
  url.search = "";
  const normalized = url.href.replace(/\/+$/, "");

  return { ok: true, url: normalized };
}

function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  return (
    lower === "localhost" ||
    lower === "::1" ||
    lower === "[::1]" ||
    lower === "127.0.0.1" ||
    /^127\./.test(lower)
  );
}

function isValidWorkerName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= WORKER_NAME_MAX_LENGTH &&
    WORKER_NAME_PATTERN.test(name)
  );
}

type BackendProjectSource = {
  main: string;
  compatibilityDate: string;
  durableObjects: MeshDurableObjectBinding[];
  newClassMigrations: MeshDurableObjectMigration[];
  r2Buckets: MeshR2BucketBinding[];
};

async function readBackendProject(
  backendDir: string,
  diagnostics: MeshRecipeDiagnostic[],
): Promise<BackendProjectSource | undefined> {
  const configFile = ["wrangler.jsonc", "wrangler.json"]
    .map((name) => path.join(backendDir, name))
    .find((candidate) => existsSync(candidate));

  if (!configFile) {
    diagnostics.push({
      code: "MESH_BACKEND_PROJECT_MISSING",
      severity: "block",
      message: `No wrangler.jsonc or wrangler.json found in ${backendDir}.`,
      hint: "Point --backend at the Mesh backend Worker project directory.",
    });
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonc(await readFile(configFile, "utf8"));
  } catch (error) {
    diagnostics.push({
      code: "MESH_BACKEND_CONFIG_INVALID",
      severity: "block",
      message: `Could not parse ${path.basename(configFile)}: ${error instanceof Error ? error.message : String(error)}`,
      hint: "The recipe reads bindings and migrations from the backend's Wrangler configuration.",
    });
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    diagnostics.push({
      code: "MESH_BACKEND_CONFIG_INVALID",
      severity: "block",
      message: `${path.basename(configFile)} must contain a JSON object.`,
      hint: "The recipe reads bindings and migrations from the backend's Wrangler configuration.",
    });
    return undefined;
  }

  const config = parsed as Record<string, unknown>;
  const main =
    typeof config["main"] === "string" ? config["main"] : DEFAULT_ENTRYPOINT;
  const compatibilityDate =
    typeof config["compatibility_date"] === "string"
      ? config["compatibility_date"]
      : FALLBACK_COMPATIBILITY_DATE;

  if (!existsSync(path.join(backendDir, main))) {
    diagnostics.push({
      code: "MESH_BACKEND_ENTRYPOINT_MISSING",
      severity: "block",
      message: `Backend entrypoint ${main} does not exist under ${backendDir}.`,
      hint: "The recipe deploys the backend project in place; its entrypoint must exist.",
    });
  }

  const durableObjects = readDurableObjectBindings(config["durable_objects"]);
  const newClassMigrations = readNewClassMigrations(config["migrations"]);
  const r2Buckets = readR2Buckets(config["r2_buckets"]);

  return {
    main,
    compatibilityDate,
    durableObjects,
    newClassMigrations,
    r2Buckets,
  };
}

function readDurableObjectBindings(value: unknown): MeshDurableObjectBinding[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const bindings = (value as Record<string, unknown>)["bindings"];
  if (!Array.isArray(bindings)) return [];

  return bindings.flatMap((binding): MeshDurableObjectBinding[] => {
    if (typeof binding !== "object" || binding === null) return [];
    const record = binding as Record<string, unknown>;
    const name = record["name"];
    const className = record["class_name"];
    return typeof name === "string" && typeof className === "string"
      ? [{ binding: name, className }]
      : [];
  });
}

function readNewClassMigrations(value: unknown): MeshDurableObjectMigration[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((migration): MeshDurableObjectMigration[] => {
    if (typeof migration !== "object" || migration === null) return [];
    const record = migration as Record<string, unknown>;
    const tag = record["tag"];
    const newClasses = readStringList(record["new_classes"]);
    const newSqliteClasses = readStringList(record["new_sqlite_classes"]);
    if (
      typeof tag !== "string" ||
      (newClasses.length === 0 && newSqliteClasses.length === 0)
    ) {
      return [];
    }
    return [{ tag, newClasses, newSqliteClasses }];
  });
}

function readR2Buckets(value: unknown): MeshR2BucketBinding[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((bucket): MeshR2BucketBinding[] => {
    if (typeof bucket !== "object" || bucket === null) return [];
    const record = bucket as Record<string, unknown>;
    const binding = record["binding"];
    const bucketName = record["bucket_name"];
    return typeof binding === "string" && typeof bucketName === "string"
      ? [{ binding, bucketName }]
      : [];
  });
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function buildMeshConfigObject(input: {
  backendDir: string;
  workerName: string;
  stage: string;
  environmentName?: string;
  accountId?: string;
  main: string;
  compatibilityDate: string;
  durableObjects: MeshDurableObjectBinding[];
  migrations: MeshDurableObjectMigration[];
  r2Buckets: MeshR2BucketBinding[];
  vars: Record<string, string>;
  configPath: string;
}): Record<string, unknown> {
  const bindings = {
    durable_objects: {
      bindings: input.durableObjects.map((binding) => ({
        name: binding.binding,
        class_name: binding.className,
      })),
    },
    ...(input.migrations.length > 0
      ? {
          migrations: input.migrations.map((migration) => ({
            tag: migration.tag,
            ...(migration.newClasses.length > 0
              ? { new_classes: migration.newClasses }
              : {}),
            ...(migration.newSqliteClasses.length > 0
              ? { new_sqlite_classes: migration.newSqliteClasses }
              : {}),
          })),
        }
      : {}),
    ...(input.r2Buckets.length > 0
      ? {
          r2_buckets: input.r2Buckets.map((bucket) => ({
            binding: bucket.binding,
            bucket_name: bucket.bucketName,
          })),
        }
      : {}),
  };

  const config: Record<string, unknown> = {
    name: input.workerName,
    main: relativeConfigPath(
      path.dirname(input.configPath),
      path.join(input.backendDir, input.main),
    ),
    compatibility_date: input.compatibilityDate,
    workers_dev: true,
    ...(input.accountId ? { account_id: input.accountId } : {}),
    ...bindings,
    vars: input.vars,
  };

  if (input.environmentName) {
    config["env"] = {
      [input.environmentName]: {
        name: `${input.workerName}-${input.environmentName}`,
        ...bindings,
        vars: input.vars,
      },
    };
  }

  return config;
}

function relativeConfigPath(from: string, to: string): string {
  const relative = path.relative(from, to).split(path.sep).join("/");

  return relative.startsWith(".") ? relative : `./${relative}`;
}

/**
 * Minimal JSONC reader for the backend's Wrangler configuration: strips
 * line/block comments and trailing commas without touching string literals.
 */
function parseJsonc(source: string): unknown {
  return JSON.parse(stripJsonc(source));
}

function stripJsonc(source: string): string {
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  let output = "";
  let index = 0;

  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      index += 1;
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 2;
      continue;
    }
    output += char;
    index += 1;
  }

  return stripTrailingCommas(output);
}

function stripTrailingCommas(source: string): string {
  let inString = false;
  let escaped = false;
  let output = "";

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";

    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < source.length && /\s/.test(source[lookahead] ?? "")) {
        lookahead += 1;
      }
      const closing = source[lookahead];
      if (closing === "}" || closing === "]") {
        continue;
      }
    }
    output += char;
  }

  return output;
}
