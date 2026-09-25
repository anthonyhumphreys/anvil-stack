import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { CloudflareAuthenticationMode } from "./support.js";

export const MINIMUM_TEMPORARY_WRANGLER_VERSION = "4.102.0";

export type WranglerCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type WranglerCommandRunner = (options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  stdin?: string;
}) => Promise<WranglerCommandResult>;

/**
 * Structural deploy target: everything a Wrangler lifecycle command needs.
 * `CloudflareWorkerArtifacts` satisfies this shape, and the Mesh recipe can
 * point at a generated configuration inside an existing Worker project.
 */
export type WranglerDeployTarget = {
  /** Working directory the Wrangler process runs in. */
  directory: string;
  /** Path to the Wrangler configuration file. */
  config: string;
  /** Worker script name used for result reporting. */
  workerName: string;
  environmentName?: string;
};

export type RunCloudflareWranglerDeployOptions = {
  artifacts: WranglerDeployTarget;
  authentication: CloudflareAuthenticationMode;
  dryRun?: boolean;
  command?: string;
  commandPrefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  run?: WranglerCommandRunner;
  onClaimUrl?: (claimUrl: string) => void | Promise<void>;
};

export type CloudflareWranglerDeployResult = {
  ok: boolean;
  dryRun: boolean;
  authentication: CloudflareAuthenticationMode;
  workerName: string;
  previewUrl?: string;
  claimUrlCaptured: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type RunCloudflareWranglerDeleteOptions = {
  artifacts: WranglerDeployTarget;
  authentication: CloudflareAuthenticationMode;
  command?: string;
  commandPrefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  run?: WranglerCommandRunner;
};

export type CloudflareWranglerDeleteResult = {
  ok: boolean;
  authentication: CloudflareAuthenticationMode;
  workerName: string;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export async function runCloudflareWranglerDeploy(
  options: RunCloudflareWranglerDeployOptions,
): Promise<CloudflareWranglerDeployResult> {
  const run = options.run ?? runWranglerCommand;
  const invocation = prepareWranglerInvocation({
    ...options,
    cwd: options.artifacts.directory,
  });
  await assertWranglerVersion(
    invocation,
    run,
    options.artifacts.directory,
    options.authentication,
  );

  const args = [
    ...invocation.prefix,
    "deploy",
    "--config",
    options.artifacts.config,
    ...(options.artifacts.environmentName
      ? ["--env", options.artifacts.environmentName]
      : []),
    ...(options.dryRun ? ["--dry-run"] : []),
    ...(options.authentication === "temporary" && !options.dryRun
      ? ["--temporary"]
      : []),
  ];
  const result = await run({
    command: invocation.command,
    args,
    cwd: options.artifacts.directory,
    env: invocation.env,
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  const claimUrl = extractClaimUrl(combined);
  const previewUrl = extractPreviewUrl(combined);

  if (claimUrl) {
    await options.onClaimUrl?.(claimUrl);
  }

  return {
    ok: result.exitCode === 0,
    dryRun: options.dryRun ?? false,
    authentication: options.authentication,
    workerName: options.artifacts.workerName,
    ...(previewUrl ? { previewUrl } : {}),
    claimUrlCaptured: claimUrl !== undefined,
    stdout: redactCloudflareSecrets(result.stdout),
    stderr: redactCloudflareSecrets(result.stderr),
    exitCode: result.exitCode,
  };
}

/**
 * Runs `wrangler delete` against a generated configuration. The same
 * environment isolation rules apply as deploy: temporary mode strips inherited
 * Cloudflare credentials and captured output is redacted.
 */
export async function runCloudflareWranglerDelete(
  options: RunCloudflareWranglerDeleteOptions,
): Promise<CloudflareWranglerDeleteResult> {
  const run = options.run ?? runWranglerCommand;
  const invocation = prepareWranglerInvocation({
    ...options,
    cwd: options.artifacts.directory,
  });
  await assertWranglerVersion(
    invocation,
    run,
    options.artifacts.directory,
    options.authentication,
  );

  const result = await run({
    command: invocation.command,
    args: [
      ...invocation.prefix,
      "delete",
      "--config",
      options.artifacts.config,
      ...(options.artifacts.environmentName
        ? ["--env", options.artifacts.environmentName]
        : []),
    ],
    cwd: options.artifacts.directory,
    env: invocation.env,
  });

  return {
    ok: result.exitCode === 0,
    authentication: options.authentication,
    workerName: options.artifacts.workerName,
    stdout: redactCloudflareSecrets(result.stdout),
    stderr: redactCloudflareSecrets(result.stderr),
    exitCode: result.exitCode,
  };
}

export function sanitizeTemporaryCloudflareEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        !name.startsWith("CF_") &&
        !name.startsWith("CLOUDFLARE_") &&
        !name.startsWith("WRANGLER_"),
    ),
  );
}

export function redactCloudflareSecrets(value: string): string {
  return value.replace(
    /https:\/\/dash\.cloudflare\.com\/claim-preview\?claimToken=[^\s]+/g,
    "[REDACTED_CLOUDFLARE_CLAIM_URL]",
  );
}

export const runWranglerCommand: WranglerCommandRunner = async (options) =>
  new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const input = options.input ?? options.stdin;
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });

type PreparedWranglerInvocation = {
  command: string;
  prefix: string[];
  env: NodeJS.ProcessEnv;
};

function prepareWranglerInvocation(options: {
  authentication: CloudflareAuthenticationMode;
  command?: string;
  commandPrefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  cwd: string;
}): PreparedWranglerInvocation {
  const inheritedEnv =
    options.authentication === "temporary"
      ? sanitizeTemporaryCloudflareEnvironment(options.env ?? process.env)
      : { ...(options.env ?? process.env) };

  return {
    command:
      options.command ??
      (existsSync(path.join(options.cwd, "node_modules", ".bin", "wrangler"))
        ? path.join(options.cwd, "node_modules", ".bin", "wrangler")
        : "wrangler"),
    prefix: options.commandPrefixArgs ?? [],
    env: {
      ...inheritedEnv,
      FORCE_COLOR: "0",
      WRANGLER_HIDE_BANNER: "true",
      WRANGLER_LOG_SANITIZE: "true",
      WRANGLER_SEND_ERROR_REPORTS: "false",
      WRANGLER_SEND_METRICS: "false",
    },
  };
}

async function assertWranglerVersion(
  invocation: PreparedWranglerInvocation,
  run: WranglerCommandRunner,
  cwd: string,
  authentication: CloudflareAuthenticationMode,
): Promise<void> {
  const version = await run({
    command: invocation.command,
    args: [...invocation.prefix, "--version"],
    cwd,
    env: invocation.env,
  });

  if (version.exitCode !== 0) {
    throw new Error(`Wrangler version check failed: ${version.stderr.trim()}`);
  }

  const parsedVersion = extractWranglerVersion(
    `${version.stdout}\n${version.stderr}`,
  );
  if (!parsedVersion) {
    throw new Error("Could not determine the installed Wrangler version.");
  }
  if (
    authentication === "temporary" &&
    compareVersions(parsedVersion, MINIMUM_TEMPORARY_WRANGLER_VERSION) < 0
  ) {
    throw new Error(
      `Cloudflare Temporary Accounts require Wrangler ${MINIMUM_TEMPORARY_WRANGLER_VERSION} or later; found ${parsedVersion}.`,
    );
  }
}

function extractClaimUrl(output: string): string | undefined {
  return /https:\/\/dash\.cloudflare\.com\/claim-preview\?claimToken=[^\s]+/.exec(
    output,
  )?.[0];
}

function extractPreviewUrl(output: string): string | undefined {
  const matched = output.match(/https:\/\/[^\s]+\.workers\.dev\/?/g)?.[0];

  return matched?.endsWith("/") ? matched.slice(0, -1) : matched;
}

function extractWranglerVersion(output: string): string | undefined {
  return /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/m.exec(output)?.[1];
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);

  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }

  return 0;
}
