import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyMeshDeployment,
  migrateMeshDatabases,
  provisionMeshResources,
  provisionMeshSecrets,
  createMeshConnectionRecord,
  createMeshDeploymentPlan,
  MESH_PROVIDER_EVIDENCE_GATE_ID,
  removeMeshDeployment,
  writeMeshConnectionRecord,
  writeMeshWranglerConfig,
  type CreateMeshDeploymentPlanOptions,
  type MeshDeploymentPlan,
  type MeshProviderEvidence,
  type WranglerCommandRunner,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const BACKEND_WRANGLER_CONFIG = `{
  "name": "anvil-backend-spike",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "durable_objects": {
    "bindings": [
      { "name": "ACCOUNT", "class_name": "AccountCoordinator" },
      { "name": "SESSIONS", "class_name": "SessionCoordinator" },
    ],
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["AccountCoordinator"] },
    { "tag": "v2", "new_sqlite_classes": ["SessionCoordinator"] },
  ],
  "r2_buckets": [
    { "binding": "ARTIFACTS", "bucket_name": "anvil-spike-artifacts" },
  ],
  "vars": {
    // Development-only keys are intentionally absent at the top level.
  },
}
`;

async function createBackendProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "anvil-mesh-backend-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(BACKEND_WRANGLER_PATH(root), BACKEND_WRANGLER_CONFIG, "utf8");
  await writeFile(
    path.join(root, "src", "index.ts"),
    "export default { fetch: () => new Response('ok') };\n",
    "utf8",
  );

  return root;
}

function BACKEND_WRANGLER_PATH(root: string): string {
  return path.join(root, "wrangler.jsonc");
}

function baseOptions(backendDir: string): CreateMeshDeploymentPlanOptions {
  return { backendDir, workerName: "mesh-backend", firstDeploy: true };
}

function removalEvidence(
  plan: MeshDeploymentPlan,
  overrides: Partial<MeshProviderEvidence> = {},
): MeshProviderEvidence {
  return {
    evidenceVersion: 1,
    kind: "anvil-mesh-provider-evidence",
    reference: "smoke-run-1",
    recordedAt: new Date().toISOString(),
    live: true,
    workerName: plan.workerName,
    stage: plan.stage,
    configSha256: createHash("sha256")
      .update(plan.config.contents, "utf8")
      .digest("hex"),
    steps: [{ name: "apply: deploy to the clean account", ok: true }],
    ...overrides,
  };
}

describe("Mesh backend recipe planning", () => {
  it("produces a bounded deployment plan from the backend project", async () => {
    const backendDir = await createBackendProject();

    const plan = await createMeshDeploymentPlan({
      ...baseOptions(backendDir),
      baseUrl: "https://mesh.example.com",
      accountId: "acct-1",
      vars: {
        OIDC_ISSUER: "https://issuer.example.com",
        OIDC_CLIENT_ID: "anvil-desktop",
      },
    });

    expect(plan).toMatchObject({
      schemaVersion: "0.1",
      recipe: "anvil-mesh-backend",
      adapter: "cloudflare",
      stage: "production",
      dev: false,
      authentication: "permanent",
      workerName: "mesh-backend",
      migrationMode: "create",
      advertisedAuthModes: ["enrollment-code", "oidc-pkce"],
    });
    expect(plan.durableObjects).toEqual([
      { binding: "ACCOUNT", className: "AccountCoordinator" },
      { binding: "SESSIONS", className: "SessionCoordinator" },
    ]);
    expect(plan.migrations).toEqual([
      { tag: "v1", newClasses: [], newSqliteClasses: ["AccountCoordinator"] },
      { tag: "v2", newClasses: [], newSqliteClasses: ["SessionCoordinator"] },
    ]);
    expect(plan.r2Buckets).toEqual([
      { binding: "ARTIFACTS", bucketName: "anvil-spike-artifacts" },
    ]);
    expect(plan.connection).toMatchObject({
      ready: true,
      baseUrl: "https://mesh.example.com",
      descriptorUrl: "https://mesh.example.com/.well-known/anvil-backend",
    });
    expect(plan.gates).toContainEqual(
      expect.objectContaining({
        id: MESH_PROVIDER_EVIDENCE_GATE_ID,
        severity: "block",
      }),
    );
    expect(plan.operations.apply.gated).toBe(true);
    expect(plan.operations.remove.gated).toBe(true);
    expect(plan.diagnostics).toEqual([]);
    expect(plan.vars).toMatchObject({
      ANVIL_DEPLOYMENT_ID: "anvil-mesh-backend-production-acct-1",
      ANVIL_DEPLOYMENT_NAME: "Anvil Backend (mesh-backend-production-acct-1)",
    });
  });

  it("derives distinct identities for staging targets and permits explicit values", async () => {
    const backendDir = await createBackendProject();

    const first = await createMeshDeploymentPlan({
      ...baseOptions(backendDir),
      stage: "staging",
      workerName: "mesh-backend-a",
      accountId: "account-a",
    });
    const second = await createMeshDeploymentPlan({
      ...baseOptions(backendDir),
      stage: "staging",
      workerName: "mesh-backend-b",
      accountId: "account-b",
    });
    expect(first.vars).toMatchObject({
      ANVIL_DEPLOYMENT_ID: "anvil-mesh-backend-a-staging-account-a",
      ANVIL_DEPLOYMENT_NAME: "Anvil Backend (mesh-backend-a-staging-account-a)",
    });
    expect(second.vars.ANVIL_DEPLOYMENT_ID).not.toBe(
      first.vars.ANVIL_DEPLOYMENT_ID,
    );

    const migrated = await createMeshDeploymentPlan({
      ...baseOptions(backendDir),
      stage: "staging",
      accountId: "account-a",
      vars: {
        ANVIL_DEPLOYMENT_ID: "anvil-mesh-backend-staging-v2",
        ANVIL_DEPLOYMENT_NAME: "Anvil Backend (mesh-backend-staging-v2)",
      },
    });
    expect(migrated.vars).toMatchObject({
      ANVIL_DEPLOYMENT_ID: "anvil-mesh-backend-staging-v2",
      ANVIL_DEPLOYMENT_NAME: "Anvil Backend (mesh-backend-staging-v2)",
    });
  });

  it("selects the hosted config and preserves D1, cron, and service bindings", async () => {
    const backendDir = await createBackendProject();
    await writeFile(
      path.join(backendDir, "wrangler.hosted.jsonc"),
      `{
        "name": "anvil-backend-hosted",
        "main": "src/index.ts",
        "compatibility_date": "2026-09-01",
        "durable_objects": { "bindings": [
          { "name": "ACCOUNT", "class_name": "AccountCoordinator" },
          { "name": "SESSIONS", "class_name": "SessionCoordinator" }
        ] },
        "migrations": [{ "tag": "v1", "new_sqlite_classes": ["AccountCoordinator"] }],
        "r2_buckets": [{ "binding": "ARTIFACTS", "bucket_name": "hosted-artifacts" }],
        "triggers": { "crons": ["17 * * * *"] },
        "services": [{ "binding": "MANAGED_PROVISIONER", "service": "anvil-mesh-provisioner" }],
        "d1_databases": [{ "binding": "HOSTED_DB", "database_name": "anvil-hosted-billing", "database_id": "db-1", "migrations_dir": "migrations/hosted-billing" }]
      }`,
      "utf8",
    );

    const plan = await createMeshDeploymentPlan({
      ...baseOptions(backendDir),
      deploymentMode: "hosted",
    });
    const config = JSON.parse(plan.config.contents);

    expect(plan.d1Databases).toEqual([
      expect.objectContaining({ binding: "HOSTED_DB", databaseId: "db-1" }),
    ]);
    expect(config.triggers).toEqual({ crons: ["17 * * * *"] });
    expect(config.services).toEqual([
      { binding: "MANAGED_PROVISIONER", service: "anvil-mesh-provisioner" },
    ]);
    expect(config.d1_databases[0]).toMatchObject({
      binding: "HOSTED_DB",
      database_name: "anvil-hosted-billing",
      database_id: "db-1",
      migrations_dir: "./migrations/hosted-billing",
    });
  });

  it("renders a Wrangler config with DO bindings and first-deploy migrations", async () => {
    const backendDir = await createBackendProject();

    const plan = await createMeshDeploymentPlan(baseOptions(backendDir));
    const written = await writeMeshWranglerConfig(plan);
    const config = JSON.parse(await readFile(written.path, "utf8"));

    expect(written.path).toBe(path.join(backendDir, "wrangler.mesh.jsonc"));
    expect(config).toMatchObject({
      name: "mesh-backend",
      main: "./src/index.ts",
      compatibility_date: "2026-09-01",
      workers_dev: true,
      durable_objects: {
        bindings: [
          { name: "ACCOUNT", class_name: "AccountCoordinator" },
          { name: "SESSIONS", class_name: "SessionCoordinator" },
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["AccountCoordinator"] },
        { tag: "v2", new_sqlite_classes: ["SessionCoordinator"] },
      ],
      r2_buckets: [
        { binding: "ARTIFACTS", bucket_name: "anvil-spike-artifacts" },
      ],
    });
    expect(config).not.toHaveProperty("env");
  });

  it("carries cumulative migrations on every deploy, including existing", async () => {
    const backendDir = await createBackendProject();

    const plan = await createMeshDeploymentPlan({
      backendDir,
      workerName: "mesh-backend",
    });
    const config = JSON.parse(plan.config.contents);

    // Wrangler dedupes migrations by tag; omitting them produces a config the
    // API rejects (10061) on fresh workers and restored namespaces.
    expect(plan.migrationMode).toBe("existing");
    expect(plan.migrations).toEqual([
      { tag: "v1", newClasses: [], newSqliteClasses: ["AccountCoordinator"] },
      { tag: "v2", newClasses: [], newSqliteClasses: ["SessionCoordinator"] },
    ]);
    expect(config.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["AccountCoordinator"] },
      { tag: "v2", new_sqlite_classes: ["SessionCoordinator"] },
    ]);
  });

  it("emits an optional named environment that repeats the bindings", async () => {
    const backendDir = await createBackendProject();

    const plan = await createMeshDeploymentPlan({
      ...baseOptions(backendDir),
      environmentName: "staging",
      artifactsBucketName: "staging-artifacts",
    });
    const config = JSON.parse(plan.config.contents);

    expect(config.env).toMatchObject({
      staging: {
        name: "mesh-backend-staging",
        durable_objects: {
          bindings: [
            { name: "ACCOUNT", class_name: "AccountCoordinator" },
            { name: "SESSIONS", class_name: "SessionCoordinator" },
          ],
        },
        r2_buckets: [
          { binding: "ARTIFACTS", bucket_name: "staging-artifacts" },
        ],
      },
    });
    expect(config.r2_buckets[0].bucket_name).toBe("staging-artifacts");
  });

  it("fails closed on development-only keys outside the dev recipe", async () => {
    const backendDir = await createBackendProject();

    const plan = await createMeshDeploymentPlan({
      backendDir,
      workerName: "mesh-backend",
      vars: {
        ANVIL_DEV_SPIKE: "true",
        OIDC_ISSUER: "https://issuer.example.com",
      },
    });

    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "MESH_DEV_ONLY_VALUE",
        severity: "block",
      }),
    );
    expect(plan.vars).toEqual({
      ANVIL_DEPLOYMENT_ID: "anvil-mesh-backend-production",
      ANVIL_DEPLOYMENT_NAME: "Anvil Backend (mesh-backend-production)",
      OIDC_ISSUER: "https://issuer.example.com",
    });
    expect(JSON.stringify(plan)).not.toContain("ANVIL_DEV_SPIKE");
  });

  it("keeps the deployment-admin credential as a production secret", async () => {
    const backendDir = await createBackendProject();

    const plan = await createMeshDeploymentPlan({
      backendDir,
      workerName: "mesh-backend",
      secrets: ["ENROLLMENT_ADMIN_TOKEN"],
    });

    expect(plan.dev).toBe(false);
    expect(plan.secrets).toEqual([
      expect.objectContaining({
        name: "ENROLLMENT_ADMIN_TOKEN",
        devOnly: false,
        required: true,
      }),
    ]);
    expect(plan.operations.apply.commands).toEqual([
      `wrangler deploy --config ${plan.config.path}`,
      `wrangler secret bulk --config ${plan.config.path}`,
    ]);
    expect(
      plan.diagnostics.filter((item) => item.severity === "block"),
    ).toEqual([]);
  });

  it("lists the admin token for the dev recipe", async () => {
    const backendDir = await createBackendProject();

    const plan = await createMeshDeploymentPlan({
      backendDir,
      workerName: "mesh-backend",
      dev: true,
      vars: { ANVIL_DEV_SPIKE: "true" },
      secrets: ["ENROLLMENT_ADMIN_TOKEN"],
    });

    expect(plan.dev).toBe(true);
    expect(plan.vars).toEqual({
      ANVIL_DEPLOYMENT_ID: "anvil-mesh-backend-production",
      ANVIL_DEPLOYMENT_NAME: "Anvil Backend (mesh-backend-production)",
      ANVIL_DEV_SPIKE: "true",
    });
    expect(plan.secrets).toEqual([
      expect.objectContaining({
        name: "ENROLLMENT_ADMIN_TOKEN",
        devOnly: false,
        required: true,
      }),
    ]);
    expect(
      plan.diagnostics.filter((item) => item.severity === "block"),
    ).toEqual([]);
  });

  it("blocks Temporary Account mode because the backend needs R2", async () => {
    const backendDir = await createBackendProject();

    const plan = await createMeshDeploymentPlan({
      ...baseOptions(backendDir),
      authentication: "temporary",
    });

    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "MESH_TEMPORARY_UNSUPPORTED",
        severity: "block",
      }),
    );
  });

  it("reports missing prerequisites instead of throwing", async () => {
    const missing = path.join(tmpdir(), "anvil-mesh-no-such-backend");
    temporaryDirectories.push(missing);

    const plan = await createMeshDeploymentPlan({
      backendDir: missing,
      workerName: "mesh-backend",
    });

    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "MESH_BACKEND_PROJECT_MISSING",
        severity: "block",
      }),
    );
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({ code: "MESH_ACCOUNT_INPUT_MISSING" }),
    );
  });

  it("blocks invalid worker names and base URLs", async () => {
    const backendDir = await createBackendProject();

    const badName = await createMeshDeploymentPlan({
      backendDir,
      workerName: "Mesh_Backend",
    });
    expect(badName.diagnostics).toContainEqual(
      expect.objectContaining({ code: "MESH_WORKER_NAME_INVALID" }),
    );

    const badUrl = await createMeshDeploymentPlan({
      ...baseOptions(backendDir),
      baseUrl: "http://mesh.example.com",
    });
    expect(badUrl.diagnostics).toContainEqual(
      expect.objectContaining({ code: "MESH_CONNECTION_URL_INVALID" }),
    );
    expect(badUrl.connection.ready).toBe(false);
  });

  it("derives a workers.dev base URL from the subdomain", async () => {
    const backendDir = await createBackendProject();

    const plan = await createMeshDeploymentPlan({
      ...baseOptions(backendDir),
      workersDevSubdomain: "acct-sub",
    });

    expect(plan.connection).toMatchObject({
      ready: true,
      baseUrl: "https://mesh-backend.acct-sub.workers.dev",
      descriptorUrl:
        "https://mesh-backend.acct-sub.workers.dev/.well-known/anvil-backend",
    });
  });
});

describe("Mesh connection export", () => {
  it("emits a pinnable record with the discovery descriptor URL", async () => {
    const result = createMeshConnectionRecord({
      workerName: "mesh-backend",
      stage: "production",
      baseUrl: "https://mesh.example.com/",
    });

    expect(result).toEqual({
      ok: true,
      record: {
        schemaVersion: "0.1",
        kind: "anvil-mesh-backend",
        workerName: "mesh-backend",
        stage: "production",
        baseUrl: "https://mesh.example.com",
        descriptorUrl: "https://mesh.example.com/.well-known/anvil-backend",
      },
    });
  });

  it("rejects credentials and non-loopback http", () => {
    expect(
      createMeshConnectionRecord({
        workerName: "mesh-backend",
        baseUrl: "https://user:pass@mesh.example.com",
      }).ok,
    ).toBe(false);
    expect(
      createMeshConnectionRecord({
        workerName: "mesh-backend",
        baseUrl: "http://mesh.example.com",
      }).ok,
    ).toBe(false);
    expect(
      createMeshConnectionRecord({
        workerName: "mesh-backend",
        baseUrl: "http://localhost:8787",
        allowInsecureBaseUrl: true,
      }).ok,
    ).toBe(true);
  });

  it("writes the record as JSON to a chosen path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "anvil-mesh-conn-"));
    temporaryDirectories.push(root);
    const output = path.join(root, "connection.json");
    const result = createMeshConnectionRecord({
      workerName: "mesh-backend",
      baseUrl: "https://mesh.example.com",
    });
    if (!result.ok) throw new Error("expected record");

    const written = await writeMeshConnectionRecord(result.record, output);
    const parsed = JSON.parse(await readFile(written.path, "utf8"));

    expect(parsed).toMatchObject({
      kind: "anvil-mesh-backend",
      baseUrl: "https://mesh.example.com",
      descriptorUrl: "https://mesh.example.com/.well-known/anvil-backend",
    });
  });
});

describe("Mesh lifecycle gating", () => {
  it("refuses apply without recorded provider evidence", async () => {
    const backendDir = await createBackendProject();
    const plan = await createMeshDeploymentPlan(baseOptions(backendDir));
    const run = vi.fn<WranglerCommandRunner>();

    const result = await applyMeshDeployment({ plan, run });

    expect(result).toMatchObject({
      ok: false,
      operation: "apply",
      gated: true,
      workerName: "mesh-backend",
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "MESH_PROVIDER_EVIDENCE_REQUIRED" }),
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses remove without recorded provider evidence", async () => {
    const backendDir = await createBackendProject();
    const plan = await createMeshDeploymentPlan(baseOptions(backendDir));
    const run = vi.fn<WranglerCommandRunner>();

    const result = await removeMeshDeployment({ plan, run });

    expect(result).toMatchObject({
      ok: false,
      operation: "remove",
      gated: true,
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "MESH_PROVIDER_EVIDENCE_REQUIRED" }),
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed when the plan has blocking diagnostics", async () => {
    const backendDir = await createBackendProject();
    const plan = await createMeshDeploymentPlan({
      backendDir,
      workerName: "Invalid_Name",
    });
    const run = vi.fn<WranglerCommandRunner>();

    const result = await applyMeshDeployment({
      plan,
      run,
      evidence: { reference: "smoke-run-1" },
      dryRun: true,
    });

    expect(result.gated).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "MESH_WORKER_NAME_INVALID" }),
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("runs wrangler deploy --dry-run without evidence", async () => {
    const backendDir = await createBackendProject();
    const plan = await createMeshDeploymentPlan(baseOptions(backendDir));
    const run = vi
      .fn<WranglerCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "wrangler 4.120.0",
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "compiled", stderr: "" });

    const result = await applyMeshDeployment({ plan, run, dryRun: true });

    expect(result).toMatchObject({ ok: true, gated: false });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0].args).toContain("--dry-run");
    expect(run.mock.calls[1]?.[0].args).toContain(plan.config.path);
    expect(run.mock.calls[1]?.[0].cwd).toBe(backendDir);
  });

  it("deploys and exports the connection when evidence is supplied", async () => {
    const backendDir = await createBackendProject();
    const connectionPath = path.join(backendDir, "mesh-connection.json");
    const plan = await createMeshDeploymentPlan({
      ...baseOptions(backendDir),
      connectionPath,
    });
    const run = vi
      .fn<WranglerCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "wrangler 4.120.0",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "Uploaded https://mesh-backend.acct.workers.dev/",
        stderr: "",
      });

    const result = await applyMeshDeployment({
      plan,
      run,
      evidence: {
        reference: "smoke-run-1",
        recordedAt: "2026-09-14T00:00:00Z",
      },
    });

    expect(result).toMatchObject({ ok: true, gated: false });
    expect(result.workerUrl).toBe("https://mesh-backend.acct.workers.dev");
    expect(result.connection).toMatchObject({
      baseUrl: "https://mesh-backend.acct.workers.dev",
      descriptorUrl:
        "https://mesh-backend.acct.workers.dev/.well-known/anvil-backend",
    });
    expect(run.mock.calls[1]?.[0].args).not.toContain("--dry-run");

    const exported = JSON.parse(await readFile(connectionPath, "utf8"));
    expect(exported.descriptorUrl).toBe(
      "https://mesh-backend.acct.workers.dev/.well-known/anvil-backend",
    );
  });

  it("deletes the Worker through wrangler when evidence is supplied", async () => {
    const backendDir = await createBackendProject();
    const plan = await createMeshDeploymentPlan(baseOptions(backendDir));
    const run = vi
      .fn<WranglerCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "wrangler 4.120.0",
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "deleted", stderr: "" });

    const result = await removeMeshDeployment({
      plan,
      run,
      evidence: removalEvidence(plan),
    });

    expect(result).toMatchObject({
      ok: true,
      operation: "remove",
      gated: false,
    });
    expect(run.mock.calls[1]?.[0].args).toEqual([
      "delete",
      "--config",
      plan.config.path,
    ]);
  });

  it("rejects removal evidence for another config or an unverified reference", async () => {
    const backendDir = await createBackendProject();
    const plan = await createMeshDeploymentPlan(baseOptions(backendDir));
    const run = vi.fn<WranglerCommandRunner>();

    const arbitrary = await removeMeshDeployment({
      plan,
      run,
      evidence: { reference: "looks-like-evidence" },
    });
    const wrongConfig = await removeMeshDeployment({
      plan,
      run,
      evidence: removalEvidence(plan, { configSha256: "0".repeat(64) }),
    });

    expect(arbitrary.diagnostics).toContainEqual(
      expect.objectContaining({ code: "MESH_PROVIDER_EVIDENCE_INVALID" }),
    );
    expect(wrongConfig.diagnostics).toContainEqual(
      expect.objectContaining({ code: "MESH_PROVIDER_EVIDENCE_INVALID" }),
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("installs a planned enrollment admin secret after deploy without exposing it", async () => {
    const backendDir = await createBackendProject();
    const plan = await createMeshDeploymentPlan({
      ...baseOptions(backendDir),
      secrets: ["ENROLLMENT_ADMIN_TOKEN"],
    });
    const secret = "sensitive-admin-token";
    const run = vi
      .fn<WranglerCommandRunner>()
      .mockImplementationOnce(async ({ env }) => {
        expect(env.ANVIL_MESH_ADMIN_TOKEN).toBeUndefined();
        return { exitCode: 0, stdout: "wrangler 4.120.0", stderr: "" };
      })
      .mockImplementationOnce(async ({ env }) => {
        expect(env.ANVIL_MESH_ADMIN_TOKEN).toBeUndefined();
        return {
          exitCode: 0,
          stdout: "Uploaded https://mesh-backend.acct.workers.dev/",
          stderr: "",
        };
      })
      .mockImplementationOnce(async ({ args, input, env }) => {
        expect(args.slice(0, 2)).toEqual(["secret", "bulk"]);
        expect(args).not.toContain(secret);
        expect(env.ANVIL_MESH_ADMIN_TOKEN).toBeUndefined();
        expect(input).toBe(
          JSON.stringify({ ENROLLMENT_ADMIN_TOKEN: secret }) + "\n",
        );
        return { exitCode: 0, stdout: secret, stderr: "" };
      });

    const result = await applyMeshDeployment({
      plan,
      run,
      enrollmentAdminToken: secret,
      env: { ANVIL_MESH_ADMIN_TOKEN: secret },
      evidence: { reference: "verified-smoke" },
    });

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("requires the planned enrollment admin secret before a mutating apply", async () => {
    const backendDir = await createBackendProject();
    const plan = await createMeshDeploymentPlan({
      ...baseOptions(backendDir),
      secrets: ["ENROLLMENT_ADMIN_TOKEN"],
    });
    const run = vi.fn<WranglerCommandRunner>();

    const result = await applyMeshDeployment({
      plan,
      run,
      evidence: { reference: "verified-smoke" },
    });

    expect(result).toMatchObject({ gated: true, ok: false });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "MESH_REQUIRED_SECRET_MISSING" }),
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("writes the generated config before provisioning resources and keeps secret values off argv", async () => {
    const backendDir = await createBackendProject();
    await writeFile(
      path.join(backendDir, "wrangler.hosted.jsonc"),
      `{"name":"hosted","main":"src/index.ts","compatibility_date":"2026-09-01","durable_objects":{"bindings":[{"name":"ACCOUNT","class_name":"AccountCoordinator"},{"name":"SESSIONS","class_name":"SessionCoordinator"}]},"migrations":[{"tag":"v1","new_sqlite_classes":["AccountCoordinator"]}],"r2_buckets":[{"binding":"ARTIFACTS","bucket_name":"artifacts"}],"d1_databases":[{"binding":"HOSTED_DB","database_name":"billing","database_id":"<placeholder>"}],"vars":{"HOSTED_BILLING_ENFORCEMENT":"true"}}`,
      "utf8",
    );
    const plan = await createMeshDeploymentPlan({
      ...baseOptions(backendDir),
      deploymentMode: "hosted",
      secrets: ["ENROLLMENT_ADMIN_TOKEN"],
    });
    const run = vi.fn<WranglerCommandRunner>(async ({ args }) => {
      expect(
        JSON.parse(await readFile(plan.config.path, "utf8")),
      ).toMatchObject({
        name: "mesh-backend",
      });
      if (args[0] === "d1" && args[1] === "list")
        return { exitCode: 0, stdout: "[]", stderr: "" };
      if (args[0] === "d1")
        return {
          exitCode: 0,
          stdout: '{"database_id":"db-resolved"}',
          stderr: "",
        };
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });
    const provisioned = await provisionMeshResources({ plan, run });
    expect(provisioned.ok).toBe(true);
    expect(provisioned.plan.d1Databases[0]?.databaseId).toBe("db-resolved");
    const secretResult = await provisionMeshSecrets({
      plan: provisioned.plan,
      secrets: { ENROLLMENT_ADMIN_TOKEN: "secret-value" },
      run,
    });
    expect(secretResult.ok).toBe(true);
    const secretCall = run.mock.calls.find(
      (call) => call[0].args[0] === "secret",
    );
    expect(secretCall?.[0].args.join(" ")).not.toContain("secret-value");
    expect(secretCall?.[0].input).toContain("secret-value");
  });

  it("stops migration before invoking Wrangler for an unresolved D1", async () => {
    const backendDir = await createBackendProject();
    await writeFile(
      path.join(backendDir, "wrangler.hosted.jsonc"),
      `${BACKEND_WRANGLER_CONFIG.slice(0, -2)}, "d1_databases":[{"binding":"HOSTED_DB","database_name":"billing","database_id":"<placeholder>","migrations_dir":"migrations"}], "vars":{"HOSTED_BILLING_ENFORCEMENT":"true"}}`,
      "utf8",
    );
    const plan = await createMeshDeploymentPlan({
      ...baseOptions(backendDir),
      deploymentMode: "hosted",
    });
    const run = vi.fn<WranglerCommandRunner>();
    const result = await migrateMeshDatabases({ plan, run });
    expect(result.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
