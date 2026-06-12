import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAwsPreviewCloudFormationTemplate,
  createAwsPreviewDeployArtifacts,
  summarizeAwsPreviewDeployArtifacts,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("createAwsPreviewDeployArtifacts", () => {
  it("packages Lambda, manifest, template, and client assets from build output", async () => {
    const rootDir = await createBuildOutputFixture();
    const manifest = createManifest();
    const artifacts = await createAwsPreviewDeployArtifacts({
      manifest,
      template: createAwsPreviewCloudFormationTemplate(manifest),
      buildOutput: {
        distDir: path.join(rootDir, ".anvil/dist"),
        generatedDir: path.join(rootDir, ".anvil/generated"),
        serverBundle: path.join(rootDir, ".anvil/dist/server/index.mjs"),
        clientIndex: path.join(rootDir, ".anvil/dist/client/index.html"),
        manifest: path.join(rootDir, ".anvil/dist/manifest.json"),
        buildMeta: path.join(rootDir, ".anvil/dist/build-meta.json"),
        generatedClient: path.join(rootDir, ".anvil/generated/client.ts"),
        generatedTypes: path.join(rootDir, ".anvil/generated/api.d.ts"),
      },
    });
    const summary = summarizeAwsPreviewDeployArtifacts(artifacts);

    expect(Buffer.from(artifacts.lambda.body).subarray(0, 2).toString()).toBe(
      "PK",
    );
    expect(Buffer.from(artifacts.lambda.body).toString("utf8")).toContain(
      "createAwsRuntimeHostFromEnv",
    );
    expect(Buffer.from(artifacts.lambda.body).toString("utf8")).toContain(
      "createAwsLambdaRuntimeHandler",
    );
    expect(Buffer.from(artifacts.lambda.body).toString("utf8")).not.toContain(
      "AWS_RUNTIME_HOST_NOT_CONFIGURED",
    );
    expect(summary).toMatchObject({
      lambda: {
        key: "notes/server.zip",
      },
      template: {
        key: "notes/template.json",
      },
      manifest: {
        key: "notes/manifest.json",
      },
      clientAssets: expect.arrayContaining([
        expect.objectContaining({
          key: "notes/client/index.html",
          contentType: "text/html",
        }),
        expect.objectContaining({
          key: "notes/client/assets/cell.client.js",
          contentType: "text/javascript",
        }),
      ]),
    });
  });
});

async function createBuildOutputFixture(): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-aws-artifacts-"));

  tempDirs.push(rootDir);
  await mkdir(path.join(rootDir, ".anvil/dist/server"), { recursive: true });
  await mkdir(path.join(rootDir, ".anvil/dist/client/assets"), {
    recursive: true,
  });
  await mkdir(path.join(rootDir, ".anvil/generated"), { recursive: true });
  await writeFile(
    path.join(rootDir, ".anvil/dist/server/index.mjs"),
    "export default { queries: {}, mutations: {}, endpoints: {}, jobs: {} };",
    "utf8",
  );
  await writeFile(
    path.join(rootDir, ".anvil/dist/client/index.html"),
    '<!doctype html><div id="root"></div>',
    "utf8",
  );
  await writeFile(
    path.join(rootDir, ".anvil/dist/client/assets/cell.client.js"),
    "console.log('client');",
    "utf8",
  );
  await writeFile(
    path.join(rootDir, ".anvil/dist/manifest.json"),
    JSON.stringify(createManifest()),
    "utf8",
  );
  await writeFile(
    path.join(rootDir, ".anvil/dist/build-meta.json"),
    "{}",
    "utf8",
  );
  await writeFile(
    path.join(rootDir, ".anvil/generated/client.ts"),
    "export {};",
    "utf8",
  );
  await writeFile(
    path.join(rootDir, ".anvil/generated/api.d.ts"),
    "export {};",
    "utf8",
  );

  return rootDir;
}

function createManifest() {
  return {
    schemaVersion: "0.1",
    cell: {
      name: "notes",
      runtime: "nodejs20",
      target: "preview",
    },
    entrypoints: {
      server: "dist/server/index.mjs",
      client: "dist/client/index.html",
    },
    schema: {
      tables: {},
    },
    queries: [],
    mutations: [],
    endpoints: [],
    jobs: [],
    capabilities: {},
  } as const;
}
