#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const wranglerCli = path.join(
  workspaceRoot,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
const commandTimeoutMs = 10_000;
const maxOutputBytes = 1024 * 1024;
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export function parseArgs(args) {
  const options = args.filter((argument) => argument !== "--");
  let provider;
  let accountId;

  for (let index = 0; index < options.length; index += 1) {
    const argument = options[index];
    if (argument === "--provider") {
      provider = requireOptionValue(options, index);
      index += 1;
    } else if (argument.startsWith("--provider=")) {
      provider = argument.slice("--provider=".length);
    } else if (argument === "--account") {
      accountId = requireOptionValue(options, index);
      index += 1;
    } else if (argument.startsWith("--account=")) {
      accountId = argument.slice("--account=".length);
    } else {
      throw new Error(usage());
    }
  }

  if (
    (provider !== "aws" && provider !== "cloudflare") ||
    (accountId !== undefined &&
      (provider !== "cloudflare" || accountId.length === 0))
  ) {
    throw new Error(usage());
  }

  return { provider, accountId };
}

export async function preflightCloudflare({
  accountId,
  runWhoami = runWranglerWhoami,
} = {}) {
  let identity;

  try {
    identity = JSON.parse(await runWhoami());
  } catch {
    return blockedCloudflare(
      "Wrangler could not confirm Cloudflare identity. Run `pnpm exec wrangler login` or configure credentials supported by Wrangler, then retry.",
    );
  }

  if (identity?.loggedIn !== true || !Array.isArray(identity.accounts)) {
    return blockedCloudflare(
      "Wrangler did not return an authenticated Cloudflare account list. Check the local Wrangler login and try again.",
    );
  }

  const hasMalformedAccount = identity.accounts.some(
    (account) =>
      !account ||
      typeof account.id !== "string" ||
      account.id.length === 0 ||
      (account.name !== undefined && typeof account.name !== "string"),
  );

  if (hasMalformedAccount) {
    return blockedCloudflare(
      "Wrangler returned malformed account membership data. No account was selected; check the installed Wrangler version and retry.",
    );
  }

  const accounts = identity.accounts;

  if (accounts.length === 0) {
    return blockedCloudflare(
      "Wrangler is authenticated but returned no usable Cloudflare accounts. Check account membership and try again.",
    );
  }

  let selected;
  if (accountId) {
    const matches = accounts.filter(
      (account) => account.id === accountId || account.name === accountId,
    );
    if (matches.length !== 1) {
      return blockedCloudflare(
        matches.length === 0
          ? "The selected Cloudflare account is not in Wrangler's accessible account list. Check the account id or name and access, then retry."
          : "The selected Cloudflare account name is ambiguous. Pass its account id with `--account` or `CLOUDFLARE_ACCOUNT_ID`.",
      );
    }
    [selected] = matches;
  } else if (accounts.length === 1) {
    [selected] = accounts;
  } else {
    return blockedCloudflare(
      `Wrangler is authenticated with access to ${accounts.length} Cloudflare accounts. Select one with --account <account-id> or CLOUDFLARE_ACCOUNT_ID, then retry.`,
    );
  }

  return {
    ok: true,
    method: "Cloudflare Wrangler whoami --json",
    summary: `Wrangler confirmed identity and access to Cloudflare account ${selected.id}. This confirms identity only; it does not test resource permissions or live backend acceptance.`,
    accountRef: selected.id,
  };
}

export function runWranglerWhoami(runCommand = runBoundedCommand) {
  return runCommand(process.execPath, [wranglerCli, "whoami", "--json"], {
    cwd: workspaceRoot,
    env: process.env,
    timeoutMs: commandTimeoutMs,
    maxOutputBytes,
  });
}

async function main() {
  const startedAt = new Date().toISOString();
  const { provider, accountId } = parseArgs(process.argv.slice(2));
  const result =
    provider === "aws"
      ? await preflightAws()
      : await preflightCloudflare({
          accountId: accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID,
        });
  const now = new Date().toISOString();
  const report = {
    schemaVersion: 1,
    rehearsalId: `preflight-${provider}-${Date.now()}`,
    evidenceKind: "provider-preflight",
    startedAt,
    finishedAt: now,
    target: {
      provider,
      cell: "portable-backends",
      stage: "preflight",
      ...(result.accountRef ? { accountRef: result.accountRef } : {}),
      ...(result.region ? { region: result.region } : {}),
      resources: [],
    },
    checks: [
      {
        id: "credential_and_account_access",
        status: result.ok ? "passed" : "blocked",
        method: result.method,
        summary: result.summary,
        artifacts: [],
      },
    ],
    cleanup: {
      status: "not-applicable",
      resourcesCreated: [],
      resourcesDeleted: [],
      resourcesRemaining: [],
    },
    liveCloudEvidence: false,
    limitations: [
      "This read-only preflight confirms provider identity only. It does not deploy or create resources, prove resource permissions, exercise the Cell, or establish live backend acceptance.",
      "Cloudflare authentication is delegated to the installed Wrangler CLI. The report excludes Wrangler's email and credentials.",
      "Store provider evidence separately from credentials. Never include bearer tokens, access keys, secrets, or source data in the rehearsal record.",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
  if (!result.ok) process.exitCode = 1;
}

function usage() {
  return "Usage: pnpm preflight:application-backends -- --provider <aws|cloudflare> [--account <account-id-or-name>]";
}

function requireOptionValue(args, index) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(usage());
  return value;
}

async function preflightAws() {
  const identity = await runAwsIdentity();
  if (!identity) {
    return {
      ok: false,
      method: "AWS STS GetCallerIdentity via AWS CLI",
      summary:
        "AWS identity lookup failed. Configure the AWS CLI credential chain and region, then retry.",
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
    };
  }

  return {
    ok: true,
    method: "AWS STS GetCallerIdentity via AWS CLI",
    summary: `Read-only AWS identity check passed for account ${identity.Account} (${identity.Arn}).`,
    accountRef: identity.Account,
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
  };
}

async function runAwsIdentity() {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(
      "aws",
      ["sts", "get-caller-identity", "--output", "json"],
      {
        env: { ...process.env, AWS_PAGER: "" },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const timeout = setTimeout(() => child.kill("SIGTERM"), commandTimeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        const value = JSON.parse(stdout);
        if (
          typeof value?.Account === "string" &&
          typeof value?.Arn === "string"
        ) {
          resolve(value);
          return;
        }
      } catch {
        // Invalid CLI output is a failed preflight, not useful evidence.
      }
      resolve(null);
    });
  });
}

function blockedCloudflare(summary) {
  return {
    ok: false,
    method: "Cloudflare Wrangler whoami --json",
    summary,
  };
}

function runBoundedCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const finish = (error, stdout) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(stdout);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("command timed out"));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > options.maxOutputBytes) {
        child.kill("SIGTERM");
        finish(new Error("command output exceeded the limit"));
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => finish(new Error("command could not start")));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error("command failed"));
        return;
      }
      finish(null, Buffer.concat(chunks).toString("utf8"));
    });
  });
}
