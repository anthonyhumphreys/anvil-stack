#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const exampleDir = path.join(rootDir, "examples", "aws-preview");
const cliPath = path.join(rootDir, "packages", "cli", "dist", "index.js");
const appName = "aws-preview";

const requiredEnv = ["ANVIL_AWS_ARTIFACT_BUCKET"];
const optionalUsefulEnv = [
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "ANVIL_AWS_STACK_PREFIX",
  "ANVIL_AWS_DEPLOYMENT_METADATA_TABLE",
];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const missing = requiredEnv.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required AWS preview environment: ${missing.join(", ")}`,
    );
  }

  console.log("AWS preview verification");
  console.log(`example: ${path.relative(process.cwd(), exampleDir)}`);
  for (const name of optionalUsefulEnv) {
    console.log(`${name}: ${process.env[name] ? "present" : "missing"}`);
  }

  if (process.env.ANVIL_AWS_SMOKE_SKIP_BUILD !== "1") {
    await run("pnpm", ["build"], { cwd: rootDir });
  }

  let deployedUrl;
  let destroyRequired = false;

  try {
    const deploy = await runJson(
      process.execPath,
      [cliPath, "deploy", "--preview", "--wait", "--json"],
      { cwd: exampleDir },
    );

    if (deploy.ok !== true && typeof deploy.deployment?.url === "string") {
      deployedUrl = deploy.deployment.url;
      destroyRequired = true;
    }

    if (deploy.ok !== true || typeof deploy.url !== "string") {
      throw new Error(`Deploy failed: ${JSON.stringify(deploy)}`);
    }

    deployedUrl = deploy.url;
    destroyRequired = true;
    console.log(`deployed: ${deployedUrl}`);

    await assertJsonGet(
      runtimePath(deployedUrl, "/_anvil/health"),
      (payload) => {
        assert(payload.ok === true, "health response did not return ok: true");
      },
    );
    await assertRuntimePost(deployedUrl, "query", "status", {}, (payload) => {
      assert(payload.ok === true, "status query did not return ok: true");
      assert(
        payload.result?.cell === appName,
        `status query returned unexpected cell: ${payload.result?.cell}`,
      );
    });

    const token = process.env.ANVIL_AWS_SMOKE_TOKEN;

    if (token) {
      const title = `AWS preview smoke ${Date.now()}`;

      await assertRuntimePost(
        deployedUrl,
        "mutation",
        "createNote",
        { title, body: "Created by scripts/verify-aws-preview.mjs" },
        (payload) => {
          assert(payload.ok === true, "createNote mutation failed");
          assert(
            payload.result?.title === title,
            "createNote returned an unexpected note title",
          );
        },
        token,
      );
      await assertRuntimePost(
        deployedUrl,
        "query",
        "listNotes",
        {},
        (payload) => {
          assert(payload.ok === true, "listNotes query failed");
          assert(
            Array.isArray(payload.result),
            "listNotes did not return rows",
          );
        },
        token,
      );
    } else {
      console.log(
        "ANVIL_AWS_SMOKE_TOKEN missing: skipped authenticated mutation/list checks.",
      );
    }

    await runJson(
      process.execPath,
      [cliPath, "inspect", "--app", appName, "--env", "preview", "--json"],
      { cwd: exampleDir },
    );
    await runJson(
      process.execPath,
      [
        cliPath,
        "logs",
        "--app",
        appName,
        "--env",
        "preview",
        "--since",
        "10m",
        "--json",
      ],
      { cwd: exampleDir },
    );

    console.log("AWS preview verification passed.");
  } finally {
    if (destroyRequired && process.env.ANVIL_AWS_SMOKE_KEEP_STACK !== "1") {
      await runJson(
        process.execPath,
        [cliPath, "destroy", "--preview", "--app", appName, "--yes", "--json"],
        { cwd: exampleDir },
      );
      console.log("destroyed preview stack.");
    } else if (deployedUrl) {
      console.log("left preview stack in place.");
    }
  }
}

async function assertJsonGet(url, validate) {
  const response = await fetch(url);
  const payload = await response.json();

  assert(response.ok, `${url} returned HTTP ${response.status}`);
  validate(payload);
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

async function runJson(command, args, options) {
  let output;

  try {
    output = await run(command, args, options);
  } catch (error) {
    if (error instanceof CommandError && error.stdout.trim().startsWith("{")) {
      return JSON.parse(error.stdout);
    }

    throw error;
  }

  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(
      `Command did not return JSON: ${command} ${args.join(" ")}\n${output}`,
      { cause: error },
    );
  }
}

function run(command, args, options) {
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
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(
        new CommandError(
          [
            `Command failed (${code}): ${command} ${args.join(" ")}`,
            stderr.trim(),
            stdout.trim(),
          ]
            .filter(Boolean)
            .join("\n"),
          stdout,
          stderr,
          code,
        ),
      );
    });
  });
}

class CommandError extends Error {
  constructor(message, stdout, stderr, code) {
    super(message);
    this.name = "CommandError";
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = code;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
