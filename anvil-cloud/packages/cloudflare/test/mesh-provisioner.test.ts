import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyMeshProvisionerDeployment,
  createMeshProvisionerDeploymentPlan,
  provisionMeshProvisionerToken,
  type MeshProvisionerSecretCommandRunner,
  type WranglerCommandRunner,
} from "../src/mesh-provisioner.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "anvil-provisioner-"));
  roots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "images"), { recursive: true });
  await writeFile(path.join(root, "src/index.ts"), "export default {}", "utf8");
  await writeFile(
    path.join(root, "images/Dockerfile.cloudflare"),
    "FROM scratch",
    "utf8",
  );
  await writeFile(
    path.join(root, "wrangler.jsonc"),
    `{
    "name": "anvil-mesh-provisioner",
    "main": "src/index.ts",
    "compatibility_date": "2026-09-01",
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }],
    "containers": [{ "class_name": "Sandbox", "image": "images/Dockerfile.cloudflare" }],
    "vars": { "ALLOW_UNAUTHENTICATED": "false" },
  }`,
    "utf8",
  );
  return root;
}

describe("Mesh provisioner deployment lifecycle", () => {
  it("renders an independent config with paths relative to its output", async () => {
    const root = await fixture();
    const output = path.join(root, "generated", "wrangler.jsonc");
    const plan = await createMeshProvisionerDeploymentPlan({
      provisionerDir: root,
      configPath: output,
      workerName: "mesh-provisioner-test",
      accountId: "acct-1",
      mode: "byo",
    });
    const config = JSON.parse(plan.config.contents) as Record<string, unknown>;
    expect(config.name).toBe("mesh-provisioner-test");
    expect(config.account_id).toBe("acct-1");
    expect(config.main).toBe("../src/index.ts");
    expect(
      (config.containers as Array<Record<string, unknown>>)[0]?.image,
    ).toBe("../images/Dockerfile.cloudflare");
    expect(plan.requiredSecrets).toEqual(["PROVISIONER_TOKEN"]);
    expect(plan.diagnostics).toEqual([]);
    expect(await readFile(path.join(root, "wrangler.jsonc"), "utf8")).toContain(
      "anvil-mesh-provisioner",
    );
  });

  it("gates a real apply without spawning Wrangler and permits dry run", async () => {
    const root = await fixture();
    const plan = await createMeshProvisionerDeploymentPlan({
      provisionerDir: root,
    });
    const run = vi
      .fn<WranglerCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "wrangler 4.120.0",
        stderr: "",
      })
      .mockResolvedValue({ exitCode: 0, stdout: "dry run", stderr: "" });
    const gated = await applyMeshProvisionerDeployment({ plan, run });
    expect(gated.gated).toBe(true);
    expect(run).not.toHaveBeenCalled();
    const dryRun = await applyMeshProvisionerDeployment({
      plan,
      dryRun: true,
      run,
    });
    expect(dryRun.ok).toBe(true);
    expect(run.mock.calls.at(-1)?.[0].args).toContain("--dry-run");
  });

  it("sends the token on stdin and never in argv or captured output", async () => {
    const root = await fixture();
    const plan = await createMeshProvisionerDeploymentPlan({
      provisionerDir: root,
    });
    const run = vi
      .fn<MeshProvisionerSecretCommandRunner>()
      .mockResolvedValue({
        exitCode: 0,
        stdout: "stored token-123",
        stderr: "",
      });
    const result = await provisionMeshProvisionerToken({
      plan,
      evidence: { reference: "smoke-1" },
      token: "token-123",
      runSecret: run,
    });
    expect(result.ok).toBe(true);
    expect(run.mock.calls[0]?.[0].stdin).toBe("token-123\n");
    expect(run.mock.calls[0]?.[0].args).not.toContain("token-123");
    expect(JSON.stringify(result)).not.toContain("token-123");
  });
});
