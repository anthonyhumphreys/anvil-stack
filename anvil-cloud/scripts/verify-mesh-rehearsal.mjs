// IAC-02 — clean-account Mesh self-deployment rehearsal.
//
// Drives the full operator journey against a scratch Cloudflare account:
// plan → apply → descriptor → conformance suite → seeded backup → in-place
// upgrade → remove → redeploy-to-fresh-namespace → import restore → final
// remove. Every step is recorded into an evidence record whose reference
// satisfies the recipe's provider-evidence gate for subsequent runs.
//
// The deployment must stand on its own: the plan is asserted free of
// development-only keys and no Anvil-managed identity or runtime is
// consulted anywhere in the flow.
//
// Non-live (default) mode validates everything that needs no provider
// mutation: the production plan must be clean, `apply --dry-run` must
// compile, and the evidence-gate diagnostics are reported. Live mode
// requires a scratch account:
//
//   ANVIL_CLOUDFLARE_LIVE=1 \
//   CLOUDFLARE_ACCOUNT_ID=<scratch account> \
//   CLOUDFLARE_API_TOKEN=<scoped token> \
//   ANVIL_MESH_ADMIN_TOKEN=<enrollment admin secret value> \
//   node scripts/verify-mesh-rehearsal.mjs --name <worker> \
//     [--backend <path>] [--base-url <https url>|--subdomain <sub>] \
//     [--evidence-out <path>] [--keep]

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(workspaceRoot, "packages/cli/dist/index.js");

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}
const hasFlag = (name) => argv.includes(`--${name}`);

const live = process.env.ANVIL_CLOUDFLARE_LIVE === "1";
const backendDir = path.resolve(
  flag("backend", path.join(workspaceRoot, "../anvil-app/cloud/backend")),
);
const workerName = flag("name", `mesh-rehearsal-${Date.now().toString(36)}`);
const baseUrl = flag("base-url");
const subdomain = flag("subdomain");
const keepDeployed = hasFlag("keep");
const adminToken = process.env.ANVIL_MESH_ADMIN_TOKEN;
const evidenceReference = `iac02-rehearsal-${workerName}-${Date.now().toString(36)}`;
const evidenceOut = path.resolve(
  flag(
    "evidence-out",
    path.join(workspaceRoot, "evidence", `mesh-rehearsal-${Date.now()}.json`),
  ),
);

if (!baseUrl && !subdomain) {
  console.error(
    "Provide --base-url <https url> or --subdomain <workers.dev subdomain>.",
  );
  process.exit(2);
}
const publicBaseUrl =
  baseUrl ?? `https://${workerName}.${subdomain}.workers.dev`;

const steps = [];
function step(name, fn) {
  return fn().then(
    (detail) => {
      steps.push({ name, ok: true, detail });
      console.log(`  PASS ${name}`);
      return detail;
    },
    (error) => {
      steps.push({ name, ok: false, error: String(error?.message ?? error) });
      console.log(`  FAIL ${name}: ${error?.message ?? error}`);
      throw error;
    },
  );
}

function mesh(subcommand, extraArgs = []) {
  const args = [
    cli,
    "mesh",
    subcommand,
    "--backend",
    backendDir,
    "--name",
    workerName,
    "--json",
    ...extraArgs,
  ];
  const run = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      // The recipe spawns `wrangler` by name; resolve it from the backend
      // project's devDependencies.
      PATH: `${path.join(backendDir, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  const stdout = run.stdout ?? "";
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    /* keep raw output for diagnostics */
  }
  return { code: run.status ?? 1, stdout, stderr: run.stderr ?? "", parsed };
}

function mustMesh(subcommand, extraArgs = []) {
  const run = mesh(subcommand, extraArgs);
  if (run.code !== 0 || run.parsed?.ok !== true) {
    throw new Error(
      `mesh ${subcommand} failed (exit ${run.code}): ${run.stderr || run.stdout}`,
    );
  }
  return run.parsed;
}

const planArgs = [
  "--enrollment-admin",
  ...(baseUrl ? ["--base-url", baseUrl] : ["--subdomain", subdomain]),
];

// ---- conformance-suite-free helpers (the rehearsal seeds/restores itself) ---

function canonicalize(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  return "null";
}
const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

async function postJson(base, route, body, authorization) {
  const res = await fetch(`${base.replace(/\/+$/, "")}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function rpc(base, operation, params, authorization) {
  const { status, body } = await postJson(
    base,
    "/v1/rpc",
    { protocol: "anvil-backend/1", requestId: randomUUID(), operation, params },
    authorization,
  );
  if (status !== 200 || body?.error) {
    throw new Error(
      `${operation} failed: HTTP ${status} ${JSON.stringify(body)}`,
    );
  }
  return body.result;
}

async function enroll(base, accountId) {
  const issued = await postJson(
    base,
    "/v1/enrollment-codes",
    { accountId },
    `Bearer ${adminToken}`,
  );
  if (issued.status !== 200)
    throw new Error(`enrollment-code issue: ${JSON.stringify(issued.body)}`);
  const enroll = await postJson(base, "/v1/enroll", {
    proof: { method: "enrollment-code", code: issued.body.code },
    installationId: "iac02-rehearsal",
  });
  if (enroll.status !== 200)
    throw new Error(`enroll: ${JSON.stringify(enroll.body)}`);
  return enroll.body;
}

function hashedChange(enrollmentSequence, entityId, payload) {
  const change = {
    changeId: randomUUID(),
    enrollmentSequence,
    entityType: "workspace",
    entityId,
    schemaVersion: 1,
    baseRevision: null,
    operation: "create",
    payload,
  };
  change.payloadHash = sha256Hex(
    canonicalize({
      baseRevision: null,
      entityId: change.entityId,
      entityType: change.entityType,
      operation: "create",
      payload,
      schemaVersion: 1,
    }),
  );
  return change;
}

async function exportAll(base, session) {
  const auth = `Bearer ${session.accessToken}`;
  const begin = await rpc(base, "data.export.begin", {}, auth);
  const entities = [];
  let cursor = null;
  for (let i = 0; i < 64; i += 1) {
    const page = await rpc(
      base,
      "data.export.page",
      { operationId: begin.operationId, cursor, maxBytes: 262144 },
      auth,
    );
    entities.push(...page.entities);
    if (page.done) break;
    cursor = page.nextCursor;
  }
  return entities;
}

// ---- rehearsal ---------------------------------------------------------------

console.log(`iac-02 rehearsal: worker=${workerName} live=${live}`);
console.log(`  backend=${backendDir} base=${publicBaseUrl}`);

try {
  await step(
    "plan: first-deploy production plan is clean",
    async () => {
      const run = mustMesh("plan", ["--first-deploy", ...planArgs]);
      const plan = run.plan;
      const serialized = JSON.stringify(plan);
      if (serialized.includes("ANVIL_DEV_SPIKE")) {
        throw new Error("development-only key leaked into the production plan");
      }
      if (
        !plan.secrets.some(
          (s) => s.name === "ENROLLMENT_ADMIN_TOKEN" && !s.devOnly,
        )
      ) {
        throw new Error("deployment-admin secret missing from production plan");
      }
      const bindings = plan.durableObjects.map((d) => d.binding).sort();
      if (bindings.join(",") !== "ACCOUNT,SESSIONS") {
        throw new Error(`unexpected DO bindings: ${bindings}`);
      }
      if (!plan.r2Buckets.some((b) => b.binding === "ARTIFACTS")) {
        throw new Error("ARTIFACTS R2 binding missing");
      }
      return {
        migrationMode: plan.migrationMode,
        secrets: plan.secrets.map((s) => s.name),
      };
    },
  );

  await step("apply: dry-run compiles without provider mutation", async () => {
    const run = mesh("apply", ["--dry-run", ...planArgs]);
    if (run.code !== 0 || run.parsed?.ok !== true) {
      throw new Error(`dry-run failed: ${run.stderr || run.stdout}`);
    }
    return { dryRun: true };
  });

  if (!live) {
    steps.push({
      name: "live rehearsal",
      ok: true,
      detail:
        "skipped — set ANVIL_CLOUDFLARE_LIVE=1 with CLOUDFLARE_ACCOUNT_ID, " +
        "CLOUDFLARE_API_TOKEN, and ANVIL_MESH_ADMIN_TOKEN to run the full " +
        "deploy → conformance → upgrade → restore sequence",
    });
    console.log("  SKIP live rehearsal (ANVIL_CLOUDFLARE_LIVE != 1)");
  } else {
    for (const required of [
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "ANVIL_MESH_ADMIN_TOKEN",
    ]) {
      if (!process.env[required])
        throw new Error(`live rehearsal requires ${required}`);
    }

    await step("apply: provision ENROLLMENT_ADMIN_TOKEN secret", async () => {
      const put = spawnSync(
        "pnpm",
        [
          "exec",
          "wrangler",
          "secret",
          "put",
          "ENROLLMENT_ADMIN_TOKEN",
          "--name",
          workerName,
        ],
        { cwd: backendDir, encoding: "utf8", input: `${adminToken}\n` },
      );
      if (put.status !== 0)
        throw new Error(`secret put failed: ${put.stderr || put.stdout}`);
      return { provisioned: true };
    });

    const deploy = await step(
      "apply: deploy to the clean account",
      async () => {
        const run = mustMesh("apply", [
          "--evidence",
          evidenceReference,
          ...planArgs,
        ]);
        return { workerUrl: run.result?.workerUrl ?? null };
      },
    );
    const deployedUrl = deploy.workerUrl ?? publicBaseUrl;

    // Everything after deploy is best-effort until the remove step: a failed
    // check must not leak the rehearsal worker on the clean account.
    let liveError = null;
    let restoredName = null;
    try {
      await step("descriptor: frozen contract advertised", async () => {
        const res = await fetch(`${deployedUrl}/.well-known/anvil-backend`);
        if (!res.ok) throw new Error(`descriptor HTTP ${res.status}`);
        const d = await res.json();
        if (
          d.descriptorVersion !== 1 ||
          !d.protocols.includes("anvil-backend/1")
        ) {
          throw new Error(
            `descriptor mismatch: ${JSON.stringify(d).slice(0, 200)}`,
          );
        }
        if (
          !d.profiles.includes("sync/1") ||
          !d.authModes.includes("enrollment-code")
        ) {
          throw new Error("descriptor must advertise sync/1 + enrollment-code");
        }
        return { deploymentId: d.deploymentId, profiles: d.profiles };
      });

      await step(
        "conformance: standalone suite passes on the fresh deploy",
        async () => {
          const suitePath = path.join(backendDir, "conformance/suite.mjs");
          const run = spawnSync(
            process.execPath,
            [suitePath, "--url", deployedUrl, "--admin-token", adminToken],
            { encoding: "utf8" },
          );
          if (run.status !== 0) {
            throw new Error(
              `conformance failed:\n${run.stdout}\n${run.stderr}`,
            );
          }
          return { output: run.stdout.trim().split("\n").pop() };
        },
      );

      const seedAccount = `iac02-${randomUUID()}`;
      const seeded = await step("backup: enroll + seed + export", async () => {
        const s = await enroll(deployedUrl, seedAccount);
        const auth = `Bearer ${s.accessToken}`;
        for (let i = 0; i < 3; i += 1) {
          await rpc(
            deployedUrl,
            "sync.push",
            { changes: [hashedChange(i + 1, `rehearsal-${i}`, { n: i })] },
            auth,
          );
        }
        const entities = await exportAll(deployedUrl, s);
        if (entities.length !== 3)
          throw new Error(
            `expected 3 exported entities, got ${entities.length}`,
          );
        return { exported: entities.length, entities, session: s };
      });
      const backup = seeded.entities;

      await step(
        "upgrade: re-apply over existing deployment, data intact",
        async () => {
          // No --first-deploy: migrationMode 'existing', same bindings.
          mustMesh("apply", ["--evidence", evidenceReference, ...planArgs]);
          const pull = await rpc(
            deployedUrl,
            "sync.pull",
            { cursor: null, maxBytes: 262144 },
            `Bearer ${seeded.session.accessToken}`,
          );
          if ((pull.changes ?? []).length < 3) {
            throw new Error(
              `expected >=3 changes after upgrade, got ${(pull.changes ?? []).length}`,
            );
          }
          return { changesAfterUpgrade: pull.changes.length };
        },
      );

      if (baseUrl) {
        // A second worker on a custom domain cannot be guessed; the restore leg
        // needs a workers.dev subdomain to resolve the restored worker URL.
        steps.push({
          name: "restore",
          ok: true,
          detail:
            "skipped — restore leg requires --subdomain (custom base-url cannot host a second worker)",
        });
        console.log(
          "  SKIP restore (needs --subdomain for the restored worker URL)",
        );
      } else {
        restoredName = `${workerName}-restored`.slice(0, 63);
        const restoredUrl = `https://${restoredName}.${subdomain}.workers.dev`;
        await step(
          "restore: redeploy to a fresh namespace and import the backup",
          async () => {
            const restored = spawnSync(
              process.execPath,
              [
                cli,
                "mesh",
                "apply",
                "--backend",
                backendDir,
                "--name",
                restoredName,
                "--first-deploy",
                "--evidence",
                evidenceReference,
                "--json",
                ...planArgs,
              ],
              { encoding: "utf8" },
            );
            let parsed = null;
            try {
              parsed = JSON.parse(restored.stdout ?? "");
            } catch {
              /* keep raw */
            }
            if (restored.status !== 0 || parsed?.ok !== true) {
              throw new Error(
                `restore apply failed: ${restored.stderr || restored.stdout}`,
              );
            }
            const secretPut = spawnSync(
              "pnpm",
              [
                "exec",
                "wrangler",
                "secret",
                "put",
                "ENROLLMENT_ADMIN_TOKEN",
                "--name",
                restoredName,
              ],
              { cwd: backendDir, encoding: "utf8", input: `${adminToken}\n` },
            );
            if (secretPut.status !== 0)
              throw new Error(
                `restored secret put failed: ${secretPut.stderr}`,
              );
            const s2 = await enroll(
              restoredUrl,
              `iac02-restore-${randomUUID()}`,
            );
            const auth2 = `Bearer ${s2.accessToken}`;
            const preview = await rpc(
              restoredUrl,
              "data.import.preview",
              {
                formatVersion: 1,
                entities: backup,
              },
              auth2,
            );
            if (preview.summary.creates !== backup.length) {
              throw new Error(
                `preview creates ${preview.summary.creates} != ${backup.length}`,
              );
            }
            const commit = await rpc(
              restoredUrl,
              "data.import.commit",
              {
                operationId: preview.operationId,
              },
              auth2,
            );
            if (commit.applied !== backup.length) {
              throw new Error(
                `commit applied ${commit.applied} != ${backup.length}`,
              );
            }
            const pull = await rpc(
              restoredUrl,
              "sync.pull",
              { cursor: null, maxBytes: 262144 },
              auth2,
            );
            if ((pull.changes ?? []).length !== backup.length) {
              throw new Error(
                `restored pull ${(pull.changes ?? []).length} != ${backup.length}`,
              );
            }
            return { restored: commit.applied, restoredWorker: restoredName };
          },
        );
      }
    } catch (error) {
      // Defer the failure until after cleanup — a failed check must not leak
      // rehearsal workers on the clean account.
      liveError = error;
    }

    await step(
      "remove: delete rehearsal workers (state retained)",
      async () => {
        const removed = [];
        if (!keepDeployed) {
          mustMesh("remove", ["--evidence", evidenceReference, ...planArgs]);
          removed.push(workerName);
        }
        if (restoredName !== null) {
          const rm = spawnSync(
            process.execPath,
            [
              cli,
              "mesh",
              "remove",
              "--backend",
              backendDir,
              "--name",
              restoredName,
              "--evidence",
              evidenceReference,
              "--json",
              ...planArgs,
            ],
            { encoding: "utf8" },
          );
          if (rm.status !== 0) {
            throw new Error(
              `restored worker remove failed: ${rm.stderr || rm.stdout}`,
            );
          }
          removed.push(restoredName);
        }
        return { removed };
      },
    ).catch((cleanupError) => {
      // Cleanup failure is recorded by `step`; only mask the real failure when
      // nothing else failed.
      if (liveError === null) liveError = cleanupError;
    });

    if (liveError !== null) throw liveError;
  }
} catch {
  process.exitCode = 1;
} finally {
  mkdirSync(path.dirname(evidenceOut), { recursive: true });
  writeFileSync(
    evidenceOut,
    JSON.stringify(
      {
        reference: evidenceReference,
        recordedAt: new Date().toISOString(),
        live,
        workerName,
        backendDir,
        baseUrl: publicBaseUrl,
        steps,
      },
      null,
      2,
    ),
  );
  console.log(`\nevidence: ${evidenceOut}`);
  console.log(
    `${steps.filter((s) => s.ok).length}/${steps.length} rehearsal steps passed`,
  );
}
