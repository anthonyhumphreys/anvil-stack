import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";

import {
  AwsPreviewDeploymentAdapter,
  createAwsPreviewDeploymentPlan,
  synthesizeAwsPreviewDeployment,
} from "../src/index.js";

const manifest = {
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
    tables: {
      notes: {
        fields: {},
      },
    },
  },
  queries: ["listNotes"],
  mutations: ["createNote"],
  endpoints: [],
  jobs: [
    {
      name: "refresh",
      schedule: "rate(1 hour)",
    },
  ],
  capabilities: {
    database: true,
    files: {
      publicRead: false,
    },
  },
} as const;

const tempDirs: string[] = [];

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("createAwsPreviewDeploymentPlan", () => {
  it("maps provider-neutral manifest capabilities to AWS preview concepts", () => {
    const plan = createAwsPreviewDeploymentPlan(manifest);

    expect(plan).toMatchObject({
      schemaVersion: "0.1",
      adapter: "aws",
      environment: "preview",
      cell: "notes",
    });
    expect(plan.changes.map((change) => change.concept)).toEqual(
      expect.arrayContaining([
        "runtime",
        "http-ingress",
        "client-assets",
        "logs",
        "database",
        "files",
        "jobs",
      ]),
    );
  });
});

describe("synthesizeAwsPreviewDeployment", () => {
  it("returns the deployment plan and CloudFormation template", () => {
    const synthesis = synthesizeAwsPreviewDeployment(manifest);

    expect(synthesis.plan.cell).toBe("notes");
    expect(synthesis.template.Resources.RuntimeFunction).toMatchObject({
      Type: "AWS::Lambda::Function",
    });
  });
});

describe("AwsPreviewDeploymentAdapter", () => {
  it("returns deploy-ready artifacts when no live provisioner is configured", async () => {
    const adapter = new AwsPreviewDeploymentAdapter();
    const result = await adapter.deploy(manifest, "preview");

    expect(result).toMatchObject({
      ok: false,
      code: "AWS_PROVISIONER_NOT_CONFIGURED",
      plan: {
        cell: "notes",
      },
      template: {
        Resources: {
          RuntimeFunction: {
            Type: "AWS::Lambda::Function",
          },
        },
      },
    });
  });

  it("returns a successful deploy result when a provisioner is configured", async () => {
    const rootDir = await createBuildOutputFixture();
    const provisionCalls: unknown[] = [];
    const adapter = new AwsPreviewDeploymentAdapter({
      provisioner: {
        async provision(input) {
          provisionCalls.push(input);

          return {
            deploymentId: "dep_test",
            url: "https://runtime.example.test",
            resources: {
              lambda: "anvil-notes-preview",
            },
          };
        },
      },
    });
    const result = await adapter.deploy({
      manifest,
      environment: "preview",
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

    expect(result).toMatchObject({
      ok: true,
      deploymentId: "dep_test",
      environment: "preview",
      url: "https://runtime.example.test",
      resources: {
        lambda: "anvil-notes-preview",
      },
      artifacts: {
        lambda: {
          key: "notes/server.zip",
        },
      },
    });
    expect(provisionCalls).toHaveLength(1);
    expect(provisionCalls[0]).toMatchObject({
      environment: "preview",
      artifacts: {
        lambda: {
          key: "notes/server.zip",
        },
      },
    });
  });
});

async function createBuildOutputFixture(): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-aws-plan-"));

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
    "<!doctype html>",
    "utf8",
  );
  await writeFile(
    path.join(rootDir, ".anvil/dist/client/assets/cell.client.js"),
    "console.log('client');",
    "utf8",
  );
  await writeFile(
    path.join(rootDir, ".anvil/dist/manifest.json"),
    JSON.stringify(manifest),
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
