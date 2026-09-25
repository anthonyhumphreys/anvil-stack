import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "anvil-provisioner-cli-"));
  directories.push(dir);
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src/index.ts"), "export default {};\n");
  await writeFile(path.join(dir, "Dockerfile"), "FROM scratch\n");
  await writeFile(path.join(dir, "anvil-daemon.mjs"), "export {};\n");
  await writeFile(
    path.join(dir, "wrangler.jsonc"),
    JSON.stringify({
      name: "source-provisioner",
      main: "src/index.ts",
      compatibility_date: "2026-09-01",
      durable_objects: {
        bindings: [{ name: "Sandbox", class_name: "Sandbox" }],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["Sandbox"] }],
      containers: [
        { class_name: "Sandbox", image: "./Dockerfile", max_instances: 2 },
      ],
      vars: { ALLOW_UNAUTHENTICATED: "false" },
    }),
  );
  return dir;
}

async function invoke(args: string[]): Promise<Record<string, unknown>> {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  await main(["mesh", "provisioner", ...args, "--json"]);
  return JSON.parse(output) as Record<string, unknown>;
}

describe("mesh provisioner CLI", () => {
  it("routes plan and writes the requested target without changing its source", async () => {
    const dir = await fixture();
    const source = await readFile(path.join(dir, "wrangler.jsonc"), "utf8");
    const target = path.join(dir, "generated/staging.jsonc");
    const result = await invoke([
      "plan",
      "--provisioner",
      dir,
      "--name",
      "mesh-staging-provisioner",
      "--mode",
      "managed",
      "--account-id",
      "account-staging",
      "--config-out",
      target,
      "--write",
    ]);
    expect(result.ok).toBe(true);
    expect(JSON.parse(await readFile(target, "utf8"))).toMatchObject({
      name: "mesh-staging-provisioner",
      account_id: "account-staging",
      main: "../src/index.ts",
      containers: [{ image: "../Dockerfile" }],
    });
    expect(await readFile(path.join(dir, "wrangler.jsonc"), "utf8")).toBe(
      source,
    );
  });

  it("rejects ambiguous secret inputs before reading either source", async () => {
    const result = await invoke([
      "secrets",
      "--provisioner",
      "/missing",
      "--name",
      "mesh-test",
      "--from-file",
      "/missing-token",
      "--from-stdin",
    ]);
    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: "INVALID_USAGE" }],
    });
    expect(process.exitCode).toBe(2);
  });

  it("keeps provider mutations behind the evidence gate", async () => {
    const dir = await fixture();
    const result = await invoke([
      "apply",
      "--provisioner",
      dir,
      "--name",
      "mesh-staging-provisioner",
    ]);
    expect(result).toMatchObject({ ok: false, result: { gated: true } });
    expect(process.exitCode).toBe(2);
  });

  it("rejects dry-run on secret installation", async () => {
    const result = await invoke([
      "secrets",
      "--provisioner",
      "/missing",
      "--name",
      "mesh-test",
      "--from-file",
      "/missing-token",
      "--dry-run",
    ]);
    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: "INVALID_USAGE" }],
    });
  });
});
