#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const exampleDir = path.join(rootDir, "examples", "aws-preview");
const cliPath = path.join(rootDir, "packages", "cli", "dist", "index.js");
const appName = "aws-preview";

const requiredEnv = [
  "ANVIL_AWS_ARTIFACT_BUCKET",
  "ANVIL_AWS_DEPLOYMENT_METADATA_TABLE",
];
const optionalUsefulEnv = [
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "ANVIL_AWS_STACK_PREFIX",
  "ANVIL_AWS_EXPIRED_SMOKE_TOKEN",
  "ANVIL_AWS_WRONG_ISSUER_SMOKE_TOKEN",
  "ANVIL_AWS_WRONG_AUDIENCE_SMOKE_TOKEN",
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
    assert(
      deploy.resources?.runtimeUrl === deployedUrl,
      "deploy --preview --wait --json did not echo the deployed runtime URL in resources",
    );
    assert(
      typeof deploy.resources?.deploymentMetadataTable === "string" &&
        deploy.resources.deploymentMetadataTable.length > 0,
      "deploy --preview --wait --json did not return a deployment metadata table",
    );
    assert(
      typeof deploy.resources?.deploymentMetadataKey === "string" &&
        deploy.resources.deploymentMetadataKey ===
          `deployment#${appName}#preview`,
      "deploy --preview --wait --json did not return the expected deployment metadata key",
    );

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
    await assertRuntimePostRejected(
      deployedUrl,
      "query",
      "listNotes",
      {},
      401,
      ["AUTH_REQUIRED"],
    );
    await assertRuntimePostRejected(
      deployedUrl,
      "query",
      "listNotes",
      {},
      401,
      ["AUTH_REQUIRED", "TOKEN_INVALID"],
      "forged-preview-smoke-token",
    );
    if (process.env.ANVIL_AWS_EXPIRED_SMOKE_TOKEN) {
      await assertRuntimePostRejected(
        deployedUrl,
        "query",
        "listNotes",
        {},
        401,
        ["TOKEN_EXPIRED", "TOKEN_INVALID"],
        process.env.ANVIL_AWS_EXPIRED_SMOKE_TOKEN,
      );
    } else {
      console.log(
        "ANVIL_AWS_EXPIRED_SMOKE_TOKEN missing: skipped expired-token rejection check.",
      );
    }
    if (process.env.ANVIL_AWS_WRONG_ISSUER_SMOKE_TOKEN) {
      await assertRuntimePostRejected(
        deployedUrl,
        "query",
        "listNotes",
        {},
        401,
        ["ISSUER_MISMATCH", "TOKEN_INVALID"],
        process.env.ANVIL_AWS_WRONG_ISSUER_SMOKE_TOKEN,
      );
    } else {
      console.log(
        "ANVIL_AWS_WRONG_ISSUER_SMOKE_TOKEN missing: skipped wrong-issuer rejection check.",
      );
    }
    if (process.env.ANVIL_AWS_WRONG_AUDIENCE_SMOKE_TOKEN) {
      await assertRuntimePostRejected(
        deployedUrl,
        "query",
        "listNotes",
        {},
        401,
        ["AUDIENCE_MISMATCH", "TOKEN_INVALID"],
        process.env.ANVIL_AWS_WRONG_AUDIENCE_SMOKE_TOKEN,
      );
    } else {
      console.log(
        "ANVIL_AWS_WRONG_AUDIENCE_SMOKE_TOKEN missing: skipped wrong-audience rejection check.",
      );
    }

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

    const inspect = await runJson(
      process.execPath,
      [cliPath, "inspect", "--app", appName, "--env", "preview", "--json"],
      { cwd: exampleDir },
    );
    assert(inspect.ok === true, "inspect --app --env preview --json failed");
    assert(
      inspect.adapter === "aws" &&
        inspect.cell === appName &&
        inspect.environment === "preview",
      "remote inspect returned the wrong adapter/cell/environment",
    );
    assert(
      inspect.runtimeUrl === deployedUrl &&
        inspect.resources?.runtimeUrl === deployedUrl,
      "remote inspect did not return the deployed runtime URL",
    );
    assert(
      inspect.resources?.deploymentMetadataTable ===
        deploy.resources.deploymentMetadataTable,
      "remote inspect did not report the deployment metadata table",
    );
    assert(
      inspect.manifest?.cell?.name === appName,
      "remote inspect returned the wrong manifest",
    );
    assert(
      typeof inspect.artifacts?.lambda?.sha256 === "string" &&
        inspect.artifacts.lambda.sha256.length > 0,
      "remote inspect did not return the deployed Lambda artifact digest",
    );

    const logs = await runJson(
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
    assert(logs.ok === true, "logs --app --env preview --json failed");
    assert(
      logs.adapter === "aws" &&
        logs.cell === appName &&
        logs.environment === "preview",
      "remote logs returned the wrong adapter/cell/environment",
    );
    assert(Array.isArray(logs.logs), "remote logs did not return a logs array");

    console.log("AWS preview verification passed.");
  } finally {
    if (destroyRequired && process.env.ANVIL_AWS_SMOKE_KEEP_STACK !== "1") {
      const destroy = await runJson(
        process.execPath,
        [cliPath, "destroy", "--preview", "--app", appName, "--yes", "--json"],
        { cwd: exampleDir },
      );
      assert(destroy.ok === true, "destroy --preview --json failed");
      assert(
        destroy.cell === appName &&
          destroy.environment === "preview" &&
          typeof destroy.stackName === "string" &&
          destroy.stackName.length > 0,
        "destroy --preview --json returned the wrong cleanup target",
      );
      if (process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE) {
        assert(
          destroy.metadataDeleted === true,
          "destroy --preview --json did not delete deployment metadata",
        );
      }
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

async function assertRuntimePostRejected(
  runtimeUrl,
  kind,
  name,
  input,
  expectedStatus,
  expectedCodes,
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
  const allowedCodes = Array.isArray(expectedCodes)
    ? expectedCodes
    : [expectedCodes];

  assert(
    response.status === expectedStatus,
    `${kind} ${name} returned HTTP ${response.status}, expected ${expectedStatus}: ${JSON.stringify(
      payload,
    )}`,
  );
  assert(
    payload.ok === false,
    `${kind} ${name} rejection did not return ok: false`,
  );
  assert(
    allowedCodes.includes(payload.error?.code),
    `${kind} ${name} returned error ${payload.error?.code}, expected one of ${allowedCodes.join(", ")}`,
  );
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
