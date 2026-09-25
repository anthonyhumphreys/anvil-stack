import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyMeshProvisionerDeployment,
  createMeshProvisionerDeploymentPlan,
  provisionMeshProvisionerToken,
  removeMeshProvisionerDeployment,
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
    path.join(root, "images/anvil-daemon.mjs"),
    "export {};",
    "utf8",
  );
  await writeFile(
    path.join(root, "wrangler.jsonc"),
    `{
    "name": "anvil-mesh-provisioner",
    "main": "src/index.ts",
    "compatibility_date": "2026-09-01",
    "durable_objects": { "bindings": [{ "name": "Sandbox", "class_name": "Sandbox" }] },
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
    const run = vi.fn<MeshProvisionerSecretCommandRunner>().mockResolvedValue({
      exitCode: 1,
      stdout: JSON.stringify({ error: "token-123" }),
      stderr: "token-123",
    });
    const result = await provisionMeshProvisionerToken({
      plan,
      evidence: { reference: "smoke-1" },
      token: "token-123",
      runSecret: run,
    });
    expect(result.ok).toBe(false);
    expect(run.mock.calls[0]?.[0].stdin).toBe("token-123\n");
    expect(run.mock.calls[0]?.[0].args).not.toContain("token-123");
    expect(JSON.stringify(result)).not.toContain("token-123");
  });

  it("rejects empty evidence and missing staged daemon prerequisites", async () => {
    const root = await fixture();
    await rm(path.join(root, "images/anvil-daemon.mjs"));
    const plan = await createMeshProvisionerDeploymentPlan({
      provisionerDir: root,
    });
    expect(
      plan.diagnostics.some(
        (item) => item.code === "PROVISIONER_IMAGE_MISSING",
      ),
    ).toBe(true);
    const run = vi.fn<WranglerCommandRunner>();
    const result = await applyMeshProvisionerDeployment({
      plan,
      evidence: { reference: "   " },
      run,
    });
    expect(result.gated).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("allows only an explicitly staged test deployment without evidence", async () => {
    const root = await fixture();
    const plan = await createMeshProvisionerDeploymentPlan({
      provisionerDir: root,
      stage: "staging",
      testDeployment: true,
    });
    const run = vi
      .fn<WranglerCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "wrangler 4.120.0",
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "deployed", stderr: "" });
    const result = await applyMeshProvisionerDeployment({ plan, run });
    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);

    const secretRun = vi
      .fn<MeshProvisionerSecretCommandRunner>()
      .mockResolvedValue({
        exitCode: 0,
        stdout: "stored",
        stderr: "",
      });
    const secret = await provisionMeshProvisionerToken({
      plan,
      token: "staging-token",
      runSecret: secretRun,
    });
    expect(secret.ok).toBe(true);
    expect(secretRun).toHaveBeenCalledOnce();

    const removeRun = vi
      .fn<WranglerCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "wrangler 4.120.0",
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "deleted", stderr: "" });
    const removed = await removeMeshProvisionerDeployment({
      plan,
      run: removeRun,
    });
    expect(removed.ok).toBe(true);
    expect(removeRun).toHaveBeenCalledTimes(2);
  });

  it("rejects testDeployment on the production stage", async () => {
    const root = await fixture();
    const plan = await createMeshProvisionerDeploymentPlan({
      provisionerDir: root,
      testDeployment: true,
    });
    expect(plan.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PROVISIONER_TEST_DEPLOYMENT_INVALID",
        }),
      ]),
    );
  });

  it("preserves URL strings while parsing JSONC and rejects temporary accounts", async () => {
    const root = await fixture();
    await writeFile(
      path.join(root, "wrangler.jsonc"),
      (await readFile(path.join(root, "wrangler.jsonc"), "utf8")).replace(
        '"vars": { "ALLOW_UNAUTHENTICATED": "false" }',
        '"vars": { "ALLOW_UNAUTHENTICATED": "false", "ORIGIN": "https://example.test/a" }',
      ),
      "utf8",
    );
    const plan = await createMeshProvisionerDeploymentPlan({
      provisionerDir: root,
      authentication: "temporary",
    });
    expect(plan.vars.ORIGIN).toBe("https://example.test/a");
    expect(
      plan.diagnostics.some((item) =>
        item.message.includes("Temporary Accounts"),
      ),
    ).toBe(true);
  });
});
