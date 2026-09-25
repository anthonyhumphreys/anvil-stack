import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyMeshDeployment,
  createMeshDeploymentPlan,
  migrateMeshDatabases,
  provisionMeshResources,
  provisionMeshSecrets,
  removeMeshDeployment,
  type WranglerCommandRunner,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const databaseId = "12345678-1234-4123-8123-123456789012";
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mesh-resources-"));
  roots.push(root);
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "migrations"));
  await writeFile(path.join(root, "src/index.ts"), "export default {};\n");
  const source = {
    main: "src/index.ts",
    compatibility_date: "2026-09-01",
    durable_objects: {
      bindings: [
        { name: "ACCOUNT", class_name: "AccountCoordinator" },
        { name: "SESSIONS", class_name: "SessionCoordinator" },
      ],
    },
    migrations: [
      {
        tag: "v1",
        new_sqlite_classes: ["AccountCoordinator", "SessionCoordinator"],
      },
    ],
    r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "artifacts-test" }],
    d1_databases: [
      {
        binding: "HOSTED_DB",
        database_name: "billing-test",
        database_id: "<placeholder>",
        migrations_dir: "migrations",
      },
    ],
    vars: { HOSTED_BILLING_ENFORCEMENT: "true" },
  };
  await writeFile(
    path.join(root, "wrangler.hosted.jsonc"),
    JSON.stringify(source),
  );
  return {
    root,
    source,
    options: {
      backendDir: root,
      workerName: "mesh-test",
      stage: "staging",
      accountId: "account-a",
      deploymentMode: "hosted" as const,
      configPath: path.join(root, "generated/config.jsonc"),
    },
  };
}
function runner(existing: { name: string; uuid: string }[] = []) {
  return vi.fn<WranglerCommandRunner>(async ({ args }) => {
    if (args[0] === "--version")
      return { exitCode: 0, stdout: "4.131.0", stderr: "" };
    if (args[0] === "d1" && args[1] === "list")
      return { exitCode: 0, stdout: JSON.stringify(existing), stderr: "" };
    if (args[0] === "d1" && args[1] === "create")
      return {
        exitCode: 0,
        stdout: JSON.stringify({ database_id: databaseId }),
        stderr: "",
      };
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
}

describe("Mesh resource lifecycle", () => {
  it("provisions a fresh target, persists its ID, migrates and applies the same named environment", async () => {
    const { root, options } = await fixture();
    const inputs = { ...options, environmentName: "test" };
    const plan = await createMeshDeploymentPlan(inputs);
    const run = runner();
    run.mockImplementationOnce(async ({ args }) => {
      expect(args.slice(0, 3)).toEqual(["d1", "list", "--json"]);
      expect(
        JSON.parse(await readFile(plan.config.path, "utf8")),
      ).toMatchObject({ account_id: "account-a", name: "mesh-test" });
      return { exitCode: 0, stdout: "[]", stderr: "" };
    });
    expect((await provisionMeshResources({ plan, run })).ok).toBe(true);
    const replan = await createMeshDeploymentPlan(inputs);
    expect(replan.d1Databases[0]?.databaseId).toBe(databaseId);
    expect(
      path.resolve(
        path.dirname(replan.config.path),
        replan.d1Databases[0]!.migrationsDir!,
      ),
    ).toBe(path.join(root, "migrations"));
    const emitted = JSON.parse(replan.config.contents);
    expect(emitted.env.test.d1_databases[0].database_id).toBe(databaseId);
    expect((await migrateMeshDatabases({ plan: replan, run })).ok).toBe(true);
    expect(
      (await applyMeshDeployment({ plan: replan, run, testDeployment: true }))
        .ok,
    ).toBe(true);
    for (const [{ args }] of run.mock.calls.filter(
      ([call]) => call.args[0] !== "--version",
    ))
      expect(args.slice(-2)).toEqual(["--env", "test"]);
    expect(
      run.mock.calls.some(([call]) => call.args.includes("--remote")),
    ).toBe(true);
  });

  it("never carries a cached ID to another worker, account, environment or database", async () => {
    const { options } = await fixture();
    await provisionMeshResources({
      plan: await createMeshDeploymentPlan(options),
      run: runner(),
    });
    for (const change of [
      { workerName: "other" },
      { accountId: "account-b" },
      { environmentName: "other" },
      { databaseName: "other" },
    ]) {
      expect(
        (await createMeshDeploymentPlan({ ...options, ...change }))
          .d1Databases[0]?.databaseId,
      ).not.toBe(databaseId);
    }
    expect(
      (await createMeshDeploymentPlan(options)).d1Databases[0]?.databaseId,
    ).toBe(databaseId);
  });

  it("recovers a named database after the generated config is lost", async () => {
    const { options } = await fixture();
    const run = runner([{ name: "billing-test", uuid: databaseId }]);
    const result = await provisionMeshResources({
      plan: await createMeshDeploymentPlan(options),
      run,
    });
    expect(result).toMatchObject({ ok: true, reused: ["d1:billing-test"] });
    expect(
      run.mock.calls.some(
        ([call]) => call.args[0] === "d1" && call.args[1] === "create",
      ),
    ).toBe(false);
  });

  it("stops before R2 after D1 creation fails", async () => {
    const { options } = await fixture();
    const run = runner();
    run.mockResolvedValueOnce({ exitCode: 0, stdout: "[]", stderr: "" });
    run.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "denied" });
    expect(
      (
        await provisionMeshResources({
          plan: await createMeshDeploymentPlan(options),
          run,
        })
      ).ok,
    ).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("returns no provider output from a secret failure, including escaped values", async () => {
    const { options } = await fixture();
    const plan = await createMeshDeploymentPlan(options);
    const secret = 'sensitive-"value"';
    const run = vi.fn<WranglerCommandRunner>(async ({ args, input }) => {
      expect(args.join(" ")).not.toContain(secret);
      expect(JSON.parse(input!)).toEqual({ HOSTED_SERVICE_KEYS: secret });
      return { exitCode: 1, stdout: secret, stderr: JSON.stringify(secret) };
    });
    const result = await provisionMeshSecrets({
      plan,
      secrets: { HOSTED_SERVICE_KEYS: secret },
      run,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });

  it("blocks unresolved live deploys and production test bypasses before spawning", async () => {
    const { options } = await fixture();
    const run = runner();
    const plan = await createMeshDeploymentPlan(options);
    expect(
      (await applyMeshDeployment({ plan, run, testDeployment: true })).gated,
    ).toBe(true);
    const production = await createMeshDeploymentPlan({
      ...options,
      stage: "production",
    });
    expect(
      (
        await removeMeshDeployment({
          plan: production,
          run,
          testDeployment: true,
        })
      ).gated,
    ).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects credentials in vars without returning their values", async () => {
    const { options } = await fixture();
    const plan = await createMeshDeploymentPlan({
      ...options,
      vars: { STRIPE_SECRET_KEY: "sensitive-test-value" },
    });
    const run = runner();
    expect((await provisionMeshResources({ plan, run })).ok).toBe(false);
    expect(JSON.stringify(plan)).not.toContain("sensitive-test-value");
    expect(run).not.toHaveBeenCalled();
  });
  it("uses an explicit provisioner override instead of the template service", async () => {
    const { root, options, source } = await fixture();
    await writeFile(
      path.join(root, "wrangler.hosted.jsonc"),
      JSON.stringify({
        ...source,
        services: [
          { binding: "MANAGED_PROVISIONER", service: "production-provisioner" },
        ],
      }),
    );
    const plan = await createMeshDeploymentPlan({
      ...options,
      managedProvisionerService: "staging-provisioner",
      baseUrl: "https://staging.example.com",
    });
    expect(plan.services).toEqual([
      { binding: "MANAGED_PROVISIONER", service: "staging-provisioner" },
    ]);
    expect(plan.vars.ANVIL_PUBLIC_API_URL).toBe("https://staging.example.com");
  });
});
