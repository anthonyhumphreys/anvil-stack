import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyMeshDeployment,
  createMeshConnectionRecord,
  createMeshDeploymentPlan,
  MESH_PROVIDER_EVIDENCE_GATE_ID,
  removeMeshDeployment,
  writeMeshConnectionRecord,
  writeMeshWranglerConfig,
  type CreateMeshDeploymentPlanOptions,
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

  it("omits new-class migrations for an existing deployment", async () => {
    const backendDir = await createBackendProject();

    const plan = await createMeshDeploymentPlan({
      backendDir,
      workerName: "mesh-backend",
    });
    const config = JSON.parse(plan.config.contents);

    expect(plan.migrationMode).toBe("existing");
    expect(plan.migrations).toEqual([]);
    expect(config).not.toHaveProperty("migrations");
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
        required: false,
      }),
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
    expect(plan.vars).toEqual({ ANVIL_DEV_SPIKE: "true" });
    expect(plan.secrets).toEqual([
      expect.objectContaining({
        name: "ENROLLMENT_ADMIN_TOKEN",
        devOnly: false,
        required: false,
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
      evidence: { reference: "smoke-run-1" },
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
});
