#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const workspaceRoot = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const cellRoot = path.join(workspaceRoot, "examples", "portable-backends");
const cliPath = path.join(workspaceRoot, "packages", "cli", "dist", "index.js");
const cellBundlePath = path.join(
  cellRoot,
  ".mezair",
  "dist",
  "server",
  "index.mjs",
);
const manifestPath = path.join(cellRoot, ".mezair", "dist", "manifest.json");
const localPackagePath = path.join(
  workspaceRoot,
  "packages",
  "local",
  "dist",
  "index.js",
);
const runtimePackagePath = path.join(
  workspaceRoot,
  "packages",
  "runtime",
  "dist",
  "index.js",
);

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});

async function main() {
  const startedAt = new Date().toISOString();
  const build = await runJson(process.execPath, [cliPath, "build", "--json"], {
    cwd: cellRoot,
  });
  assert.equal(build.ok, true, "portable-backends build failed");

  const [{ default: cell }, manifest, local, runtime] = await Promise.all([
    import(pathToFileURL(cellBundlePath).href),
    readJson(manifestPath),
    import(pathToFileURL(localPackagePath).href),
    import(pathToFileURL(runtimePackagePath).href),
  ]);
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "mezair-app-backends-"),
  );
  const stateDir = path.join(tempRoot, "state");
  const runId = `local-${Date.now()}`;
  const passed = [];
  let server;

  try {
    server = await startServer(local, cell, manifest, stateDir);
    const baseUrl = server.runtimeUrl;
    const token = await issueToken(baseUrl, "catalogue-owner");
    const otherToken = await issueToken(baseUrl, "different-owner");

    const unauthenticated = await postJson(baseUrl, "/api/catalogue/import", {
      batchId: "no-auth",
      source: "[]",
      expectedQuota: null,
    });
    assert.equal(unauthenticated.response.status, 401);

    const quotaPayload = await postJson(
      baseUrl,
      "/_mezair/query/quota",
      {},
      token,
    );
    assert.equal(quotaPayload.response.status, 200);
    assert.equal(quotaPayload.payload.result, null);
    const expectedQuota = quotaPayload.payload.result;

    const candidates = [
      {
        batchId: "catalogue-a",
        source: JSON.stringify([{ id: "item-a", name: "Copper kettle" }]),
      },
      {
        batchId: "catalogue-b",
        source: JSON.stringify([{ id: "item-b", name: "Tin cup" }]),
      },
    ];
    const race = await Promise.all(
      candidates.map((candidate) =>
        postJson(
          baseUrl,
          "/api/catalogue/import",
          { ...candidate, expectedQuota },
          token,
        ),
      ),
    );
    assert.deepEqual(
      race.map(({ response }) => response.status).sort(),
      [200, 409],
      "one stale conditional commit should conflict",
    );

    const winnerIndex = race.findIndex(
      ({ response }) => response.status === 200,
    );
    const winner = candidates[winnerIndex];
    const quotaAfterRace = await postJson(
      baseUrl,
      "/_mezair/query/quota",
      {},
      token,
    );
    assert.deepEqual(quotaAfterRace.payload.result, {
      id: "catalogue-owner",
      used: "1",
    });
    const recordsAfterRace = await server.host.db.table("batches").all();
    assert.deepEqual(
      recordsAfterRace.map((record) => record.batchId),
      [winner.batchId],
    );
    const outboxRows = await server.host.db.table("__mezair_job_outbox").all();
    assert.equal(
      outboxRows.length,
      1,
      "only the winner's outbox write should commit",
    );
    assert.equal(await countFiles(path.join(stateDir, "files")), 1);
    passed.push("authenticated_http");
    passed.push("conditional_commit_conflict");

    const privateFileDenied = await fetch(`${baseUrl}/api/catalogue/source`, {
      headers: { "x-batch-id": winner.batchId },
    });
    assert.equal(privateFileDenied.status, 401);
    const privateFileOtherOwner = await fetch(
      `${baseUrl}/api/catalogue/source`,
      {
        headers: {
          authorization: `Bearer ${otherToken}`,
          "x-batch-id": winner.batchId,
        },
      },
    );
    assert.equal(privateFileOtherOwner.status, 404);
    assert.deepEqual((await privateFileOtherOwner.json()).error, {
      code: "NOT_FOUND",
      message: "Import batch not found.",
    });
    const privateFile = await fetch(`${baseUrl}/api/catalogue/source`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-batch-id": winner.batchId,
      },
    });
    assert.equal(privateFile.status, 200);
    assert.equal((await privateFile.json()).result.source, winner.source);
    passed.push("private_file_access");

    const schedule = await postJson(
      baseUrl,
      "/_mezair/schedules/recoverPendingImports/run",
      { payload: {} },
    );
    assert.equal(schedule.response.status, 200);
    assert.equal(schedule.payload.run.status, "completed");
    assert.deepEqual(schedule.payload.run.result, {
      cursor: null,
      published: 1,
      failed: 0,
    });
    const queuedBeforeRestart = await readJson(
      path.join(stateDir, "jobs.json"),
    );
    assert.equal(queuedBeforeRestart.length, 1);
    assert.equal(queuedBeforeRestart[0].id, outboxRows[0].id);
    assert.equal(
      (await server.host.db.table("__mezair_job_outbox").all()).length,
      0,
    );
    passed.push("scheduled_outbox_dispatch");

    await server.close();
    passed.push("local_server_restart");
    server = await startServer(local, cell, manifest, stateDir);
    const recoveredQuota = await postJson(
      server.runtimeUrl,
      "/_mezair/query/quota",
      {},
      token,
    );
    assert.deepEqual(
      recoveredQuota.payload.result,
      quotaAfterRace.payload.result,
    );
    const queuedAfterRestart = await readJson(path.join(stateDir, "jobs.json"));
    assert.deepEqual(queuedAfterRestart, queuedBeforeRestart);
    const recoveredBatch = await postJson(
      server.runtimeUrl,
      "/_mezair/query/batch",
      { input: { batchId: winner.batchId } },
      token,
    );
    assert.equal(recoveredBatch.payload.result.state, "queued");

    const jobMessage = queuedAfterRestart[0];
    const processRequest = {
      kind: "job",
      name: jobMessage.name,
      payload: jobMessage.payload,
      requestId: jobMessage.id,
    };
    const firstDelivery = await runtime.handleRuntimeRequest(
      cell,
      server.host,
      processRequest,
    );
    assert.equal(firstDelivery.ok, true);
    assert.deepEqual(firstDelivery.body, {
      duplicate: false,
      importedCount: 1,
    });
    const duplicateDelivery = await runtime.handleRuntimeRequest(
      cell,
      server.host,
      processRequest,
    );
    assert.equal(duplicateDelivery.ok, true);
    assert.deepEqual(duplicateDelivery.body, {
      duplicate: true,
      importedCount: 1,
    });
    assert.equal((await server.host.db.table("catalogue").all()).length, 1);
    assert.equal((await server.host.db.table("receipts").all()).length, 1);
    passed.push("duplicate_delivery_receipt");

    const poisonQuota = await postJson(
      server.runtimeUrl,
      "/_mezair/query/quota",
      {},
      token,
    );
    const poisonImport = await postJson(
      server.runtimeUrl,
      "/api/catalogue/import",
      {
        batchId: "poison-batch",
        source: "not-json",
        expectedQuota: poisonQuota.payload.result,
      },
      token,
    );
    assert.equal(poisonImport.response.status, 200);
    const poisonSchedule = await postJson(
      server.runtimeUrl,
      "/_mezair/schedules/recoverPendingImports/run",
      { payload: {} },
    );
    assert.equal(poisonSchedule.payload.run.result.published, 1);
    const poisonMessage = (
      await readJson(path.join(stateDir, "jobs.json"))
    ).find((entry) => entry.payload.batchId === "poison-batch");
    assert.ok(
      poisonMessage,
      "scheduled recovery did not publish poison message",
    );
    const poisonResult = await runtime.handleRuntimeRequest(cell, server.host, {
      kind: "job",
      name: poisonMessage.name,
      payload: poisonMessage.payload,
      requestId: poisonMessage.id,
    });
    assert.equal(poisonResult.ok, false);
    assert.equal(poisonResult.error?.code, "VALIDATION_ERROR");
    const poisonBatch = await postJson(
      server.runtimeUrl,
      "/_mezair/query/batch",
      { input: { batchId: "poison-batch" } },
      token,
    );
    assert.equal(poisonBatch.payload.result.state, "failed");
    assert.equal(poisonBatch.payload.result.failureCode, "INVALID_SOURCE");
    passed.push("poison_failure_visibility");

    await server.close();
    server = await startServer(local, cell, manifest, stateDir);
    const poisonAfterRestart = await postJson(
      server.runtimeUrl,
      "/_mezair/query/batch",
      { input: { batchId: "poison-batch" } },
      token,
    );
    assert.equal(poisonAfterRestart.payload.result.state, "failed");
    passed.push("failure_state_restart");

    const sourceRecord = await server.host.db
      .table("batches")
      .get(`${encodeURIComponent("catalogue-owner")}:${winner.batchId}`);
    assert.ok(sourceRecord);
    assert.equal(
      await server.host.files.delete(String(sourceRecord.sourceKey)),
      true,
    );
    assert.equal(
      await server.host.files.get(String(sourceRecord.sourceKey)),
      null,
    );
    passed.push("private_file_deletion");
  } finally {
    try {
      await server?.close();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  passed.push("local_state_cleanup");
  const report = {
    schemaVersion: 1,
    rehearsalId: runId,
    evidenceKind: "local-acceptance",
    startedAt,
    finishedAt: new Date().toISOString(),
    target: {
      provider: "local",
      cell: "portable-backends",
      stage: "temporary-local-state",
      resources: [],
    },
    checks: passed.map((id) => ({
      id,
      status: "passed",
      method: "local Mezair Runtime and JSON state",
      summary: localCheckSummary(id),
      artifacts: [],
    })),
    cleanup: {
      status: "verified",
      verifiedAt: new Date().toISOString(),
      resourcesCreated: [
        "temporary local HTTP server",
        "temporary local state directory",
      ],
      resourcesDeleted: [
        "temporary local HTTP server",
        "temporary local state directory",
      ],
      resourcesRemaining: [],
    },
    liveCloudEvidence: false,
    limitations: [
      "The local scheduled adapter publishes to jobs.json and does not exercise a provider queue or dead-letter queue.",
      "The Cell job handler is called with the persisted logical id to simulate at-least-once delivery; local /_mezair/jobs/run generates a new request id.",
      "No AWS or Cloudflare account, live resources, deployment, backup restore, or production migration was exercised.",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
}

function localCheckSummary(id) {
  const summaries = {
    authenticated_http:
      "Bearer-authenticated import succeeds and unauthenticated import is rejected.",
    conditional_commit_conflict:
      "A stale quota snapshot conflicts; batch, quota, and outbox records remain all-or-nothing.",
    private_file_access:
      "The owner reads a private source file; unauthenticated and other-user reads are rejected.",
    scheduled_outbox_dispatch:
      "A scheduled Cell job publishes one committed outbox message with its stable id.",
    local_server_restart:
      "Quota, batch, and queued message state remain available after restarting the local server.",
    duplicate_delivery_receipt:
      "Two deliveries with one logical id create one catalogue row and one receipt.",
    poison_failure_visibility:
      "Malformed source data returns a job failure and stores a failed batch state.",
    failure_state_restart:
      "The failed batch remains visible after another local server restart.",
    private_file_deletion:
      "The local file adapter deletes the private source and returns no bytes afterward.",
    local_state_cleanup:
      "The temporary local server and state directory were removed; no resources remain.",
  };
  return summaries[id] ?? id;
}

async function startServer(local, cell, manifest, stateDir) {
  return local.startLocalRuntimeServer({
    app: cell,
    manifest,
    rootDir: cellRoot,
    stateDir,
    cellName: "portable-backends",
    port: 0,
    clientPort: 0,
    clientMode: "none",
  });
}

async function issueToken(baseUrl, userId) {
  const { response, payload } = await postJson(baseUrl, "/_mezair/auth/token", {
    userId,
    ttlSeconds: 3600,
  });
  assert.equal(response.status, 200);
  assert.equal(typeof payload.token, "string");
  return payload.token;
}

async function postJson(baseUrl, pathname, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function countFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    count += entry.isDirectory() ? await countFiles(entryPath) : 1;
  }
  return count;
}

function runJson(command, args, options) {
  return run(command, args, options).then((stdout) => JSON.parse(stdout));
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} exited ${code}\n${stderr}\n${stdout}`,
          ),
        );
    });
  });
}
