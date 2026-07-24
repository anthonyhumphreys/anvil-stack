#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const exampleDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = path.resolve(exampleDir, "../../packages/cli/dist/index.js");

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const result = await runWithResult(process.execPath, [
    cliPath,
    "deploy",
    "--preview",
    "--wait",
    "--json",
  ]);
  const payload = parseJson(result.stdout);

  assert(
    result.code === 6,
    `deploy --preview --wait --json exited ${result.code}, expected 6 without configured AWS provisioning`,
  );
  assert(
    payload?.ok === false &&
      payload?.code === "AWS_PROVISIONER_NOT_CONFIGURED" &&
      payload?.plan?.changes?.some(
        (change) => change?.concept === "workflows",
      ) &&
      typeof payload?.artifacts?.lambda?.sha256 === "string",
    "deploy --preview --wait --json did not reach the packaged AWS plan and artifact boundary",
  );

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function runWithResult(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: exampleDir,
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

function parseJson(output) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`Command did not return JSON:\n${output}`, {
      cause: error,
    });
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
