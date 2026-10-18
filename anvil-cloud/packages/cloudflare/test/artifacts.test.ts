import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { CLOUDFLARE_DATABASE_MIGRATION } from "../src/database.js";

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

  it("bundles backend bindings, migrations, authentication, queues and cron without secret values", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "anvil-cloudflare-backend-"),
    );
    temporaryDirectories.push(root);
    const serverBundle = path.join(root, "server.mjs");
    await writeFile(
      serverBundle,
      "export default { queries: {}, mutations: {}, endpoints: {}, jobs: {} };\n",
    );
    const manifest = createManifest();
    manifest.capabilities = {
      database: true,
      files: { publicRead: false },
      jobs: true,
      secrets: ["SOURCE_TOKEN"],
    };
    manifest.jobs = [{ name: "refresh", schedule: "*/20 * * * *" }];
    const artifacts = await createCloudflareWorkerArtifacts({
      manifest,
      buildOutput: createBuildOutput(root, serverBundle),
      resources: {
        database: { name: "stage-data", id: "stage-id" },
        files: { bucketName: "stage-files" },
        jobs: {
          queueName: "stage-jobs",
          deadLetterQueueName: "stage-failures",
        },
        auth: { issuer: "https://issuer.example/", audience: "stage-api" },
        secrets: ["SOURCE_TOKEN"],
      },
    });
    const config = JSON.parse(await readFile(artifacts.config, "utf8"));
    expect(config).toMatchObject({
      d1_databases: [{ binding: "ANVIL_DB", database_id: "stage-id" }],
      r2_buckets: [{ binding: "ANVIL_FILES" }],
      queues: {
        producers: [{ binding: "ANVIL_JOBS" }],
        consumers: [{ max_retries: 5, dead_letter_queue: "stage-failures" }],
      },
      triggers: { crons: ["*/20 * * * *"] },
      vars: { ANVIL_AUTH_AUDIENCE: "stage-api" },
      observability: { enabled: true },
    });
    expect(
      await readFile(
        path.join(artifacts.directory, "migrations", "0001_anvil_records.sql"),
        "utf8",
      ),
    ).toContain("anvil_records");
    expect(await readFile(artifacts.worker, "utf8")).not.toContain("node:fs");
    expect(config.vars).not.toHaveProperty("SOURCE_TOKEN");
  });

  it("runs the generated Worker through HTTP into a real local D1 binding", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "anvil-cloudflare-http-db-"),
    );
    temporaryDirectories.push(root);
    const serverBundle = path.join(root, "server.mjs");
    await writeFile(
      serverBundle,
      `export default {
      queries: { list: { kind: "query", auth: "public", handler: async ctx => ctx.db.notes.page({ limit: 25 }) } },
      mutations: { add: { kind: "mutation", auth: "public", handler: async (ctx, input) => ctx.db.notes.insert(input) } },
      endpoints: {}, jobs: {}, capabilities: { database: true }
    };`,
    );
    const manifest = createManifest();
    manifest.capabilities.database = true;
    const artifacts = await createCloudflareWorkerArtifacts({
      manifest,
      buildOutput: createBuildOutput(root, serverBundle),
      resources: { database: { name: "local-data", id: "local-data" } },
    });
    const worker = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: await readFile(artifacts.worker, "utf8"),
        compatibilityDate: "2026-08-01",
        d1Databases: ["ANVIL_DB"],
      }),
    );
    try {
      await (
        await worker.getD1Database("ANVIL_DB")
      ).exec(CLOUDFLARE_DATABASE_MIGRATION.replace(/\n/g, " "));
      const mutation = await worker.dispatchFetch(
        "https://cell.example/_anvil/mutation/add",
        {
          method: "POST",
          body: JSON.stringify({
            input: { id: "note1", title: "Saved through the Worker" },
          }),
        },
      );
      expect(mutation.status).toBe(200);
      const query = await worker.dispatchFetch(
        "https://cell.example/_anvil/query/list",
        { method: "POST", body: "{}" },
      );
      expect(await query.json()).toMatchObject({
        ok: true,
        result: {
          records: [{ id: "note1", title: "Saved through the Worker" }],
          cursor: null,
        },
      });
    } finally {
      await worker.dispose();
    }
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
