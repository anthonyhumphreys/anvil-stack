#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const exampleDir = path.join(rootDir, "examples", "notes");
const cliPath = path.join(rootDir, "packages", "cli", "dist", "index.js");
const lockParentDir = path.join(rootDir, ".anvil", "locks");
const lockDir = path.join(lockParentDir, "notes-golden-path");

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const releaseLock = await acquireVerifierLock();

  try {
    await runVerifier();
  } finally {
    await releaseLock();
  }
}

async function runVerifier() {
  console.log("Notes golden path verification");
  console.log(`example: ${path.relative(process.cwd(), exampleDir)}`);

  if (process.env.ANVIL_NOTES_SMOKE_SKIP_BUILD !== "1") {
    await run("pnpm", ["build"], { cwd: rootDir });
  }

  await verifyNewScaffoldContract();

  await rm(path.join(exampleDir, ".anvil", "local"), {
    recursive: true,
    force: true,
  });

  const dev = startDevServer();

  try {
    const ready = await dev.ready;
    const runtimeUrl = ready.runtimeUrl;
    const userId = `notes_smoke_${Date.now()}`;

    console.log(`runtime: ${runtimeUrl}`);
    console.log(`client: ${ready.clientUrl}`);

    const checkResult = await runJson("pnpm", ["--silent", "run", "check"], {
      cwd: exampleDir,
    });
    assert(checkResult.ok === true, "check --json did not return ok: true");

    const buildResult = await runJson("pnpm", ["--silent", "run", "build"], {
      cwd: exampleDir,
    });
    assert(buildResult.ok === true, "build --json did not return ok: true");
    assert(
      buildResult.result?.manifest?.cell?.name === "notes",
      "build --json returned the wrong Cell manifest",
    );

    await runJson(
      process.execPath,
      [cliPath, "auth", "login", userId, "--ttl", "3600", "--json"],
      { cwd: exampleDir },
    );
    const tokenResult = await runJson(
      process.execPath,
      [cliPath, "auth", "whoami", "--json"],
      { cwd: exampleDir },
    );
    const loginResult = await runJson(
      process.execPath,
      [cliPath, "auth", "token", userId, "--ttl", "3600", "--json"],
      { cwd: exampleDir },
    );
    const token = loginResult.token;

    assert(typeof token === "string" && token.length > 0, "token missing");
    assert(
      tokenResult.identity?.userId === userId,
      "auth login did not set the local smoke user",
    );

    await assertRuntimePost(runtimeUrl, "query", "status", {}, (payload) => {
      assert(payload.ok === true, "status query failed");
      assert(payload.result?.cell === "notes", "status returned wrong cell");
    });

    const title = `Local notes smoke ${Date.now()}`;

    await assertRuntimePost(
      runtimeUrl,
      "mutation",
      "createNote",
      { title, body: "Created by scripts/verify-notes-local.mjs" },
      (payload) => {
        assert(payload.ok === true, "createNote failed");
        assert(payload.result?.title === title, "createNote title mismatch");
      },
      token,
    );

    await assertRuntimePost(
      runtimeUrl,
      "query",
      "listNotes",
      {},
      (payload) => {
        assert(payload.ok === true, "listNotes failed");
        assert(Array.isArray(payload.result), "listNotes did not return rows");
        assert(
          payload.result.some((note) => note.title === title),
          "created note was not listed",
        );
      },
      token,
    );

    const workflowRun = await runJson(
      process.execPath,
      [
        cliPath,
        "workflows",
        "run",
        "onboardUser",
        "--input",
        JSON.stringify({ userId }),
        "--json",
      ],
      { cwd: exampleDir },
    );
    assert(workflowRun.ok === true, "workflows run --json failed");
    assert(
      workflowRun.run?.workflow === "onboardUser" &&
        workflowRun.run?.status === "completed",
      "workflows run --json did not complete onboardUser",
    );
    assert(
      typeof workflowRun.run?.runId === "string" &&
        workflowRun.run.runId.length > 0,
      "workflows run --json did not return a run id",
    );

    const workflowList = await runJson(
      process.execPath,
      [cliPath, "workflows", "list", "--json"],
      { cwd: exampleDir },
    );
    assert(workflowList.ok === true, "workflows list --json failed");
    assert(
      Array.isArray(workflowList.runs) &&
        workflowList.runs.some((run) => run.runId === workflowRun.run.runId),
      "workflows list --json did not include the completed run",
    );

    const workflowShow = await runJson(
      process.execPath,
      [cliPath, "workflows", "show", workflowRun.run.runId, "--json"],
      { cwd: exampleDir },
    );
    assert(workflowShow.ok === true, "workflows show --json failed");
    assert(
      workflowShow.run?.runId === workflowRun.run.runId &&
        workflowShow.run?.status === "completed",
      "workflows show --json did not return the completed run",
    );
    assert(
      workflowShow.run?.steps?.some(
        (step) =>
          step?.name === "seedWelcomeNote" &&
          step?.status === "completed" &&
          step?.result?.ownerId === userId,
      ),
      "workflows show --json did not persist the workflow step result",
    );

    const inspectResult = await runJson(
      "pnpm",
      ["--silent", "run", "inspect:local"],
      { cwd: exampleDir },
    );
    assert(inspectResult.ok === true, "inspect --local --json failed");
    assert(
      inspectResult.manifest?.cell?.name === "notes",
      "inspect --local --json returned the wrong Cell manifest",
    );
    assert(
      inspectResult.auth?.currentUser === userId,
      "inspect --local --json did not report the smoke user",
    );
    assert(
      inspectResult.database?.tables?.notes?.rows >= 1,
      "inspect --local --json did not report persisted notes rows",
    );

    const dbDumpResult = await runJson(
      process.execPath,
      [cliPath, "db", "dump", "notes", "--local", "--json"],
      { cwd: exampleDir },
    );
    assert(dbDumpResult.ok === true, "db dump notes --local --json failed");
    assert(
      dbDumpResult.table === "notes" && Array.isArray(dbDumpResult.rows),
      "db dump notes --local --json did not return notes rows",
    );
    assert(
      dbDumpResult.rows.some(
        (row) => row?.title === title && row?.ownerId === userId,
      ),
      "db dump notes --local --json did not include the created smoke note",
    );
    assert(
      dbDumpResult.rows.some(
        (row) =>
          row?.title === "Welcome to Anvil Notes" && row?.ownerId === userId,
      ),
      "db dump notes --local --json did not include the workflow-created welcome note",
    );

    const logsResult = await runJson(
      "pnpm",
      ["--silent", "run", "logs:local"],
      { cwd: exampleDir },
    );
    assert(logsResult.ok === true, "logs --local --json failed");
    assert(
      Array.isArray(logsResult.logs),
      "logs --local --json did not return a logs array",
    );

    const doctorResult = await runJson(
      process.execPath,
      [
        cliPath,
        "doctor",
        "--port",
        String(portFromUrl(runtimeUrl)),
        "--client-port",
        String(portFromUrl(ready.clientUrl)),
        "--json",
      ],
      { cwd: exampleDir },
    );
    assert(doctorResult.ok === true, "doctor --json reported errors");
    assertDoctorCheck(
      doctorResult,
      "project.build",
      "ok",
      "doctor --json did not see the Notes build manifest",
    );
    assertDoctorCheck(
      doctorResult,
      "project.generatedClient",
      "ok",
      "doctor --json did not see fresh generated client metadata",
    );
    assertDoctorCheck(
      doctorResult,
      "local.state",
      "ok",
      "doctor --json did not see Notes local state",
    );
    assert(
      findDoctorCheck(doctorResult, "local.state")?.details?.files
        ?.workflows === true,
      "doctor --json did not see Notes local workflow state",
    );
    assertDoctorCheck(
      doctorResult,
      "local.runtime",
      "ok",
      "doctor --json did not see the running Notes local runtime",
    );

    const deployGate = await runJsonAllowFailure(
      "pnpm",
      ["--silent", "run", "deploy:preview:gate"],
      { cwd: exampleDir },
    );
    assert(
      deployGate.code === 0,
      `deploy:preview:gate exited ${deployGate.code}, expected 0 after verifying the packaged preview boundary`,
    );
    assert(
      deployGate.payload?.ok === false &&
        deployGate.payload?.code === "AWS_PROVISIONER_NOT_CONFIGURED" &&
        deployGate.payload?.plan?.changes?.some(
          (change) => change?.concept === "workflows",
        ) &&
        typeof deployGate.payload?.artifacts?.lambda?.sha256 === "string",
      "deploy --preview --wait --json did not reach the packaged AWS plan and artifact boundary",
    );

    const destroyDryRun = await runJson(
      "pnpm",
      ["--silent", "run", "destroy:preview:dry-run"],
      { cwd: exampleDir },
    );
    assert(
      destroyDryRun.ok === true,
      "destroy --preview --dry-run --json failed",
    );
    assert(
      destroyDryRun.dryRun === true,
      "destroy --preview --dry-run --json did not report dryRun: true",
    );
    assert(
      destroyDryRun.stackName === "anvil-notes-preview",
      "destroy --preview --dry-run --json returned the wrong stack name",
    );
    assert(
      destroyDryRun.cleanup?.stack?.action === "delete",
      "destroy --preview --dry-run --json did not report stack cleanup",
    );
    assert(
      destroyDryRun.cleanup?.stackOwnedBuckets?.action ===
        "empty-before-delete",
      "destroy --preview --dry-run --json did not report bucket cleanup",
    );
    assert(
      destroyDryRun.cleanup?.deploymentMetadata === null,
      "destroy --preview --dry-run --json should omit metadata cleanup without a metadata table",
    );
    assert(
      Array.isArray(destroyDryRun.next) &&
        destroyDryRun.next.includes(
          "anvil-cloud destroy --preview --app notes --yes --json",
        ),
      "destroy --preview --dry-run --json did not include the real destroy command",
    );

    console.log("Notes golden path verification passed.");
  } finally {
    await dev.close();
  }
}

async function acquireVerifierLock() {
  await mkdir(lockParentDir, { recursive: true });
  const startedAt = Date.now();
  const timeoutMs = 120_000;

  while (true) {
    try {
      await mkdir(lockDir);
      return () => rm(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (!isNodeErrorWithCode(error, "EEXIST")) {
        throw error;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(
          "Timed out waiting for another Notes golden path verifier run to finish.",
          { cause: error },
        );
      }

      await delay(500);
    }
  }
}

async function verifyNewScaffoldContract() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "anvil-notes-new-"));

  try {
    const result = await runJson(
      process.execPath,
      [cliPath, "new", "notes-golden", "--json"],
      { cwd: tempDir },
    );
    const cellDir = path.join(tempDir, "notes-golden");
    const packageJson = JSON.parse(
      await readFile(path.join(cellDir, "package.json"), "utf8"),
    );
    const generatedClient = await readFile(
      path.join(cellDir, ".anvil/generated/client.ts"),
      "utf8",
    );

    assert(result.ok === true, "new --json did not return ok: true");
    assert(result.cell === "notes-golden", "new --json returned wrong cell");
    assert(
      result.client?.kind === "vite-react",
      "new --json did not default to vite-react",
    );
    assert(
      packageJson.scripts?.check === "anvil-cloud check --json",
      "new scaffold did not include check --json script",
    );
    assert(
      packageJson.scripts?.build === "anvil-cloud build --json",
      "new scaffold did not include build --json script",
    );
    assert(
      packageJson.scripts?.dev === "anvil-cloud dev --json",
      "new scaffold did not include dev --json script",
    );
    assert(
      packageJson.scripts?.["inspect:local"] ===
        "anvil-cloud inspect --local --json",
      "new scaffold did not include inspect --local --json script",
    );
    assert(
      packageJson.scripts?.["logs:local"] === "anvil-cloud logs --local --json",
      "new scaffold did not include logs --local --json script",
    );
    assert(
      packageJson.scripts?.["deploy:preview:gate"] ===
        "anvil-cloud deploy --preview --wait --json",
      "new scaffold did not include deploy --preview --wait --json script",
    );
    assert(
      packageJson.scripts?.["destroy:preview:dry-run"] ===
        "anvil-cloud destroy --preview --app notes-golden --yes --dry-run --json",
      "new scaffold did not include destroy --preview dry-run script",
    );
    assert(
      generatedClient.includes("meta: {") &&
        generatedClient.includes('queries: ["listTodos"]') &&
        generatedClient.includes('mutations: ["addTodo"]'),
      "new scaffold did not include stable generated client metadata",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isNodeErrorWithCode(error, code) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function startDevServer() {
  const child = spawn(
    "pnpm",
    [
      "--silent",
      "run",
      "dev",
      "--",
      "--agent",
      "--port",
      "0",
      "--client-port",
      "0",
    ],
    {
      cwd: exampleDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  let settled = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();

    for (const line of stdout.split("\n")) {
      if (!line.trim().startsWith("{")) {
        continue;
      }

      try {
        const payload = JSON.parse(line);

        if (payload.type === "ready") {
          settled = true;
          readyResolve(payload);
        }
      } catch {
        // Ignore partial JSON lines until more stdout arrives.
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.on("error", (error) => {
    if (!settled) {
      settled = true;
      readyReject(error);
    }
  });
  child.on("close", (code) => {
    if (!settled) {
      settled = true;
      readyReject(
        new Error(
          `anvil-cloud dev exited before ready (${code}).\n${stderr}\n${stdout}`,
        ),
      );
    }
  });

  return {
    ready,
    close: async () => {
      if (child.exitCode !== null) {
        return;
      }

      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
    },
  };
}

async function assertRuntimePost(
  runtimeUrl,
  kind,
  name,
  input,
  validate,
  token,
) {
  const headers = {
    "content-type": "application/json",
  };

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(
    runtimePath(runtimeUrl, `/_anvil/${kind}/${name}`),
    {
      method: "POST",
      headers,
      body: JSON.stringify({ input }),
    },
  );
  const payload = await response.json();

  assert(
    response.ok,
    `${kind} ${name} returned HTTP ${response.status}: ${JSON.stringify(
      payload,
    )}`,
  );
  validate(payload);
}

function runtimePath(runtimeUrl, pathname) {
  const url = new URL(runtimeUrl);

  url.pathname = pathname;
  url.search = "";
  url.hash = "";

  return url.toString();
}

function portFromUrl(value) {
  const url = new URL(value);

  if (url.port) {
    return Number(url.port);
  }

  return url.protocol === "https:" ? 443 : 80;
}

function assertDoctorCheck(payload, id, status, message) {
  const check = findDoctorCheck(payload, id);

  assert(
    check?.status === status,
    `${message}: ${JSON.stringify(check ?? null)}`,
  );
}

function findDoctorCheck(payload, id) {
  return Array.isArray(payload.checks)
    ? payload.checks.find((candidate) => candidate?.id === id)
    : undefined;
}

async function runJson(command, args, options) {
  const output = await run(command, args, options);

  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(
      `Command did not return JSON: ${command} ${args.join(" ")}\n${output}`,
      { cause: error },
    );
  }
}

async function runJsonAllowFailure(command, args, options) {
  const result = await runWithResult(command, args, options);

  try {
    return {
      code: result.code,
      payload: JSON.parse(result.stdout),
    };
  } catch (error) {
    throw new Error(
      `Command did not return JSON: ${command} ${args.join(" ")}\n${result.stdout}`,
      { cause: error },
    );
  }
}

function run(command, args, options) {
  return runWithResult(command, args, options).then((result) => {
    if (result.code === 0) {
      return result.stdout;
    }

    throw new Error(
      [
        `Command failed (${result.code}): ${command} ${args.join(" ")}`,
        result.stderr.trim(),
        result.stdout.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  });
}

function runWithResult(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
