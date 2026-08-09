import { open } from "node:fs/promises";
import path from "node:path";

import { buildCell } from "../packages/builder/dist/index.js";
import {
  checkCloudflarePreviewSupport,
  createCloudflareWorkerArtifacts,
  redactCloudflareSecrets,
  runCloudflareWranglerDeploy,
} from "../packages/cloudflare/dist/index.js";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const cellRoot = path.join(workspaceRoot, "examples", "cloudflare-smoke");
const live = process.env.ANVIL_CLOUDFLARE_LIVE === "1";
const mode = process.env.ANVIL_CLOUDFLARE_MODE ?? "permanent";

if (mode !== "permanent" && mode !== "temporary") {
  throw new Error("ANVIL_CLOUDFLARE_MODE must be 'permanent' or 'temporary'.");
}

if (live && mode === "permanent") {
  requireEnvironment("CLOUDFLARE_ACCOUNT_ID");
  requireEnvironment("CLOUDFLARE_API_TOKEN");
}
if (live && mode === "temporary" && !process.stderr.isTTY) {
  throw new Error(
    "Temporary Account verification requires an interactive terminal for the one-time claim URL handoff.",
  );
}

const build = await buildCell({ rootDir: cellRoot, target: "preview" });
if (!build.ok || !build.manifest || !build.output) {
  throw new Error(
    `Cloudflare smoke Cell build failed: ${JSON.stringify(build)}`,
  );
}

const supportDiagnostics = checkCloudflarePreviewSupport(build.manifest, {
  authentication: mode,
});
if (supportDiagnostics.length > 0) {
  throw new Error(
    `Cloudflare smoke Cell declared unsupported capabilities: ${JSON.stringify(supportDiagnostics)}`,
  );
}

const artifacts = await createCloudflareWorkerArtifacts({
  manifest: build.manifest,
  buildOutput: build.output,
  environment: "preview",
  authentication: mode,
});
const commandOptions = {
  command: "pnpm",
  commandPrefixArgs: ["exec", "wrangler"],
};

const dryRun = await runCloudflareWranglerDeploy({
  artifacts,
  authentication: mode,
  dryRun: true,
  ...commandOptions,
});
if (!dryRun.ok) {
  throw new Error(
    `Wrangler dry-run failed:\n${redactCloudflareSecrets(dryRun.stderr || dryRun.stdout)}`,
  );
}

if (!live) {
  printResult({
    ok: true,
    live: false,
    mode,
    workerName: artifacts.workerName,
    workerSha256: artifacts.workerSha256,
    wranglerDryRun: "passed",
    next: "Set ANVIL_CLOUDFLARE_LIVE=1 and choose ANVIL_CLOUDFLARE_MODE to run the provider smoke.",
  });
  process.exit(0);
}

let deployed = false;
let liveResult;
try {
  const deployment = await runCloudflareWranglerDeploy({
    artifacts,
    authentication: mode,
    async onClaimUrl(claimUrl) {
      await writeClaimUrlToTerminal(claimUrl);
    },
    ...commandOptions,
  });
  if (!deployment.ok) {
    throw new Error(
      `Wrangler deploy failed:\n${deployment.stderr || deployment.stdout}`,
    );
  }
  deployed = true;

  if (!deployment.previewUrl) {
    throw new Error(
      "Wrangler deploy succeeded without reporting a workers.dev URL.",
    );
  }

  await verifyJson(`${deployment.previewUrl}/_anvil/health`, undefined, {
    ok: true,
    runtime: "cloudflare-preview",
  });
  await verifyJson(
    `${deployment.previewUrl}/_anvil/query/ping`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { value: "live" } }),
    },
    { ok: true, result: { pong: "live" } },
  );
  await verifyJson(`${deployment.previewUrl}/api/status`, undefined, {
    ok: true,
    result: { ok: true, cell: "cloudflare-smoke" },
  });
  const asset = await fetchWithRetry(`${deployment.previewUrl}/`);
  const assetBody = await asset.text();
  if (!asset.ok || !assetBody.includes("cell.client.js")) {
    throw new Error(`Static asset smoke failed with status ${asset.status}.`);
  }

  liveResult = {
    ok: true,
    live: true,
    mode,
    workerName: artifacts.workerName,
    workerSha256: artifacts.workerSha256,
    previewUrl: deployment.previewUrl,
    checks: ["health", "query", "endpoint", "assets"],
    cleanup:
      mode === "temporary"
        ? "Cloudflare expiry lifecycle"
        : process.env.ANVIL_CLOUDFLARE_KEEP_WORKER === "1"
          ? "retained by explicit opt-in"
          : "pending",
  };
} finally {
  if (
    deployed &&
    mode === "permanent" &&
    process.env.ANVIL_CLOUDFLARE_KEEP_WORKER !== "1"
  ) {
    await deletePermanentWorker(artifacts.workerName);
    if (liveResult) liveResult.cleanup = "deleted and API-confirmed";
  }
}

printResult(liveResult);

async function verifyJson(url, init, expected) {
  const response = await fetchWithRetry(url, init);
  const body = await response.json();

  if (!response.ok || JSON.stringify(body) !== JSON.stringify(expected)) {
    throw new Error(
      `Provider smoke mismatch for ${url}: ${response.status} ${JSON.stringify(body)}`,
    );
  }
}

async function fetchWithRetry(url, init) {
  let lastResponse;
  let lastError;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const response = await fetch(url, init);
      lastResponse = response;
      if (response.ok) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  if (lastResponse) return lastResponse;
  throw lastError ?? new Error(`No response from ${url}.`);
}

async function deletePermanentWorker(workerName) {
  const accountId = requireEnvironment("CLOUDFLARE_ACCOUNT_ID");
  const token = requireEnvironment("CLOUDFLARE_API_TOKEN");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Cloudflare Worker cleanup failed with ${response.status}.`,
    );
  }
  console.error(`Deleted permanent-account smoke Worker ${workerName}.`);
}

async function writeClaimUrlToTerminal(claimUrl) {
  const terminalPath = process.platform === "win32" ? "CONOUT$" : "/dev/tty";
  const terminal = await open(terminalPath, "w");

  try {
    await terminal.write(
      `\nCloudflare Temporary Account claim URL (valid for 60 minutes):\n${claimUrl}\n\n`,
    );
  } finally {
    await terminal.close();
  }
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for this smoke mode.`);

  return value;
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
