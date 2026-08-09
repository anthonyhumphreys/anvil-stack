import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BuildOutput, CellManifest } from "@anvil-cloud/builder";
import {
  createCloudflareWorkerArtifacts,
  createCloudflareWorkerName,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Cloudflare Worker artifacts", () => {
  it("bundles a module Worker and deterministic Wrangler configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "anvil-cloudflare-"));
    temporaryDirectories.push(root);
    const serverBundle = path.join(root, "dist", "server", "index.mjs");
    await mkdir(path.dirname(serverBundle), { recursive: true });
    await writeFile(
      serverBundle,
      `export default { queries: {}, mutations: {}, endpoints: {} };\n`,
      "utf8",
    );
    const buildOutput = createBuildOutput(root, serverBundle);
    const manifest = createManifest();

    const artifacts = await createCloudflareWorkerArtifacts({
      manifest,
      buildOutput,
      environment: "preview",
    });
    const worker = await readFile(artifacts.worker, "utf8");
    const config = JSON.parse(await readFile(artifacts.config, "utf8"));

    expect(worker).toContain("cloudflare-preview");
    expect(worker).not.toContain("node:fs");
    expect(config).toMatchObject({
      name: createCloudflareWorkerName("Collision Prone Cell", "preview"),
      main: "./worker.mjs",
      workers_dev: true,
    });
    expect(artifacts.workerSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("adds a hash so normalized names cannot collide", () => {
    expect(createCloudflareWorkerName("a_b", "preview")).not.toBe(
      createCloudflareWorkerName("a-b", "preview"),
    );
  });

  it("refuses to emit an artifact for unsupported capabilities", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "anvil-cloudflare-"));
    temporaryDirectories.push(root);
    const serverBundle = path.join(root, "dist", "server", "index.mjs");
    await mkdir(path.dirname(serverBundle), { recursive: true });
    await writeFile(serverBundle, "export default {};\n", "utf8");
    const manifest = createManifest();
    manifest.capabilities.database = true;

    await expect(
      createCloudflareWorkerArtifacts({
        manifest,
        buildOutput: createBuildOutput(root, serverBundle),
      }),
    ).rejects.toMatchObject({
      name: "CloudflareWorkerCompatibilityError",
      diagnostics: [expect.objectContaining({ feature: "database" })],
    });
  });
});

function createBuildOutput(root: string, serverBundle: string): BuildOutput {
  return {
    distDir: path.join(root, "dist"),
    generatedDir: path.join(root, "generated"),
    serverBundle,
    clientIndex: path.join(root, "dist", "client", "index.html"),
    manifest: path.join(root, "dist", "manifest.json"),
    buildMeta: path.join(root, "dist", "build-meta.json"),
    generatedClient: path.join(root, "generated", "client.ts"),
    generatedTypes: path.join(root, "generated", "api.d.ts"),
  };
}

function createManifest(): CellManifest {
  return {
    schemaVersion: "0.1",
    cell: {
      name: "Collision Prone Cell",
      runtime: "nodejs20",
      target: "preview",
    },
    entrypoints: {
      server: "dist/server/index.mjs",
      client: "dist/client/index.html",
    },
    client: { kind: "headless" },
    schema: { tables: {} },
    queries: [],
    mutations: [],
    endpoints: [],
    jobs: [],
    workflows: [],
    services: [],
    channels: [],
    agents: {},
    capabilities: {},
  };
}
