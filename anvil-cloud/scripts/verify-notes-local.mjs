#!/usr/bin/env node
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const exampleDir = path.join(rootDir, "examples", "notes");
const cliPath = path.join(rootDir, "packages", "cli", "dist", "index.js");

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  console.log("Notes local verification");
  console.log(`example: ${path.relative(process.cwd(), exampleDir)}`);

  if (process.env.ANVIL_NOTES_SMOKE_SKIP_BUILD !== "1") {
    await run("pnpm", ["build"], { cwd: rootDir });
  }

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

    await runJson(
      process.execPath,
      [
        cliPath,
        "auth",
        "add-user",
        userId,
        "--email",
        `${userId}@example.test`,
        "--roles",
        "admin",
        "--json",
      ],
      { cwd: exampleDir },
    );

    const tokenResult = await runJson(
      process.execPath,
      [cliPath, "auth", "token", userId, "--ttl", "3600", "--json"],
      { cwd: exampleDir },
    );
    const token = tokenResult.token;

    assert(typeof token === "string" && token.length > 0, "token missing");

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

    await runJson(process.execPath, [cliPath, "inspect", "--local", "--json"], {
      cwd: exampleDir,
    });
    await runJson(process.execPath, [cliPath, "logs", "--local", "--json"], {
      cwd: exampleDir,
    });

    console.log("Notes local verification passed.");
  } finally {
    await dev.close();
  }
}

function startDevServer() {
  const child = spawn(
    process.execPath,
    [cliPath, "dev", "--agent", "--json", "--port", "0", "--client-port", "0"],
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
          `anvil dev exited before ready (${code}).\n${stderr}\n${stdout}`,
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
        new Error(
          [
            `Command failed (${code}): ${command} ${args.join(" ")}`,
            stderr.trim(),
            stdout.trim(),
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      );
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
