import { spawn } from "node:child_process";

import type { CloudflareWorkerArtifacts } from "./artifacts.js";
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
}) => Promise<WranglerCommandResult>;

export type RunCloudflareWranglerDeployOptions = {
  artifacts: CloudflareWorkerArtifacts;
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

export async function runCloudflareWranglerDeploy(
  options: RunCloudflareWranglerDeployOptions,
): Promise<CloudflareWranglerDeployResult> {
  const run = options.run ?? runWranglerCommand;
  const command = options.command ?? "wrangler";
  const prefix = options.commandPrefixArgs ?? [];
  const inheritedEnv =
    options.authentication === "temporary"
      ? sanitizeTemporaryCloudflareEnvironment(options.env ?? process.env)
      : { ...(options.env ?? process.env) };
  const env = {
    ...inheritedEnv,
    FORCE_COLOR: "0",
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_SEND_ERROR_REPORTS: "false",
    WRANGLER_SEND_METRICS: "false",
  };
  const version = await run({
    command,
    args: [...prefix, "--version"],
    cwd: options.artifacts.directory,
    env,
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
    options.authentication === "temporary" &&
    compareVersions(parsedVersion, MINIMUM_TEMPORARY_WRANGLER_VERSION) < 0
  ) {
    throw new Error(
      `Cloudflare Temporary Accounts require Wrangler ${MINIMUM_TEMPORARY_WRANGLER_VERSION} or later; found ${parsedVersion}.`,
    );
  }

  const args = [
    ...prefix,
    "deploy",
    "--config",
    options.artifacts.config,
    ...(options.dryRun ? ["--dry-run"] : []),
    ...(options.authentication === "temporary" && !options.dryRun
      ? ["--temporary"]
      : []),
  ];
  const result = await run({
    command,
    args,
    cwd: options.artifacts.directory,
    env,
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
      stdio: ["ignore", "pipe", "pipe"],
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
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });

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
