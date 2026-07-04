import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";

import { buildCell } from "@anvil-cloud/builder";
import { createAgentManifest, defineAgent } from "@anvil-cloud/runtime";
import {
  AwsPreviewDeploymentAdapter,
  AwsPreviewProvisioningError,
  checkAwsPreviewSupport,
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
  workflows: [],
  services: [],
  capabilities: {
    database: true,
    events: true,
    files: {
      publicRead: false,
    },
  },
  agents: {},
} as const;

const tempDirs: string[] = [];
const awsPreviewExampleDir = fileURLToPath(
  new URL("../../../examples/aws-preview", import.meta.url),
);

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
        "events",
        "files",
        "jobs",
      ]),
    );
    expect(plan.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          concept: "events",
          details: {
            service: "eventbridge",
          },
        }),
      ]),
    );
    expect(plan.operations).toMatchObject({
      rollback: {
        supported: false,
        commands: expect.arrayContaining([
          "anvil-cloud deploy --preview --json",
          "anvil-cloud destroy --preview --app notes --yes --json",
        ]),
      },
      cleanup: {
        commands: ["anvil-cloud destroy --preview --app notes --yes --json"],
      },
      cost: {
        billingMode: "usage-based-preview",
        drivers: expect.arrayContaining([
          "Lambda requests and duration",
          "DynamoDB Cell data table reads and writes",
          "S3 Cell file storage and requests",
          "EventBridge event bus events",
          "SQS queue requests and retained messages",
        ]),
      },
    });
    expect(plan.review).toMatchObject({
      stableId: "aws-preview:notes:preview:deploy",
      operation: "deploy",
      summary: {
        creates: plan.changes.length,
        updates: 0,
        reuses: 0,
        total: plan.changes.length,
      },
      changeSummary: expect.arrayContaining([
        {
          concept: "database",
          creates: 1,
          updates: 0,
          reuses: 0,
          total: 1,
          changeIds: ["create:database:notes-preview"],
        },
        {
          concept: "jobs",
          creates: 1,
          updates: 0,
          reuses: 0,
          total: 1,
          changeIds: ["create:jobs:notes-preview"],
        },
      ]),
      changeSet: expect.arrayContaining([
        expect.objectContaining({
          id: "create:database:notes-preview",
          action: "create",
          concept: "database",
        }),
      ]),
      capabilityDiffs: expect.arrayContaining([
        expect.objectContaining({
          id: "database:notes-preview",
          action: "add",
          capability: "database",
        }),
      ]),
      cost: {
        drivers: expect.arrayContaining([
          expect.objectContaining({
            id: "dynamodb-data",
            label: "DynamoDB Cell data table reads and writes",
          }),
          expect.objectContaining({
            id: "sqs-jobs",
            label: "SQS queue requests and retained messages",
          }),
        ]),
        notes: plan.operations.cost.notes,
      },
      rollback: plan.operations.rollback,
      cleanup: {
        commands: ["anvil-cloud destroy --preview --app notes --yes --json"],
        notes: [
          "Destroy empties stack-owned buckets and removes deployment metadata when configured.",
        ],
      },
      approvalSummary: {
        required: 2,
        info: 0,
        review: 2,
        block: 0,
        hasBlockingGate: false,
      },
      approvalGates: expect.arrayContaining([
        expect.objectContaining({
          id: "data-resource-review",
          required: true,
          severity: "review",
          changeIds: ["create:database:notes-preview"],
        }),
        expect.objectContaining({
          id: "async-capability-review",
          required: true,
          severity: "review",
        }),
      ]),
    });
  });

  it("reports workflow resources in the preview plan without enabling deploy support", () => {
    const plan = createAwsPreviewDeploymentPlan({
      ...manifest,
      workflows: [{ name: "syncNotes", steps: ["fetch", "store"] }],
      capabilities: {
        ...manifest.capabilities,
        workflows: true,
      },
    });

    expect(plan.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          concept: "workflows",
          details: {
            service: "step-functions",
            workflows: [
              {
                name: "syncNotes",
                steps: ["fetch", "store"],
              },
            ],
          },
        }),
      ]),
    );
    expect(plan.operations.cost.drivers).toEqual(
      expect.arrayContaining(["Step Functions state transitions"]),
    );
    expect(plan.review.cost.drivers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "step-functions",
          label: "Step Functions state transitions",
        }),
      ]),
    );
    expect(plan.review.approvalGates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "aws-preview-support-gate",
          required: true,
          severity: "block",
          changeIds: ["create:workflows:notes-preview"],
        }),
      ]),
    );
    expect(plan.review.approvalSummary).toEqual({
      required: 3,
      info: 0,
      review: 2,
      block: 1,
      hasBlockingGate: true,
    });
    expect(
      checkAwsPreviewSupport({
        ...manifest,
        workflows: [{ name: "syncNotes", steps: ["fetch", "store"] }],
      }),
    ).toEqual([
      expect.objectContaining({
        feature: "workflows",
      }),
    ]);
  });

  it("reports Lambda MicroVM sandbox resources for sandbox-required agents", () => {
    const previousImage = process.env.ANVIL_AWS_AGENT_SANDBOX_IMAGE;

    try {
      process.env.ANVIL_AWS_AGENT_SANDBOX_IMAGE =
        "arn:aws:lambda-microvms:eu-west-1:123:image/anvil";
      const plan = createAwsPreviewDeploymentPlan({
        ...manifest,
        agents: {
          support: createAgentManifest(
            defineAgent({
              name: "support",
              model: { provider: "aws-bedrock", model: "test-model" },
              approvals: { requiredFor: ["git.push"] },
              runtime: { sandbox: "required" },
            }),
            "cell",
          ),
        },
      });

      expect(plan.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            concept: "agent-sandboxes",
            details: {
              service: "lambda-microvms",
              imageConfigured: true,
              agents: [
                expect.objectContaining({
                  name: "support",
                  provider: "aws-bedrock",
                  approvals: ["git.push"],
                }),
              ],
            },
          }),
        ]),
      );
      expect(plan.operations.cost.drivers).toEqual(
        expect.arrayContaining(["Lambda MicroVM agent sandbox sessions"]),
      );
      expect(plan.review.cost.drivers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "lambda-microvms-agent-sandboxes",
          }),
        ]),
      );
      expect(plan.review.approvalGates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "agent-sandbox-review",
            required: true,
            severity: "review",
          }),
        ]),
      );
      expect(checkAwsPreviewSupport(planManifestWithSandboxAgent())).toEqual(
        [],
      );
    } finally {
      if (previousImage === undefined) {
        delete process.env.ANVIL_AWS_AGENT_SANDBOX_IMAGE;
      } else {
        process.env.ANVIL_AWS_AGENT_SANDBOX_IMAGE = previousImage;
      }
    }
  });
});

describe("checkAwsPreviewSupport", () => {
  it("flags service declarations because AWS preview cannot execute them yet", () => {
    const diagnostics = checkAwsPreviewSupport({
      ...manifest,
      services: [{ name: "heartbeat", restart: "always", maxRestarts: 3 }],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "AWS_PREVIEW_UNSUPPORTED_FEATURE",
        feature: "services",
        names: ["heartbeat"],
      }),
    ]);
  });

  it("flags workflow declarations because AWS preview cannot execute them yet", () => {
    const diagnostics = checkAwsPreviewSupport({
      ...manifest,
      workflows: [{ name: "syncNotes", steps: ["fetch", "store"] }],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "AWS_PREVIEW_UNSUPPORTED_FEATURE",
        feature: "workflows",
        names: ["syncNotes"],
      }),
    ]);
  });

  it("flags outbound fetch because AWS preview cannot enforce its allow list yet", () => {
    const diagnostics = checkAwsPreviewSupport({
      ...manifest,
      capabilities: {
        ...manifest.capabilities,
        outboundFetch: { allow: ["api.example.test"] },
      },
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "AWS_PREVIEW_UNSUPPORTED_FEATURE",
        feature: "outboundFetch",
        names: ["api.example.test"],
      }),
    ]);
  });

  it("flags sandbox-required agents when no MicroVM image is configured", () => {
    const previousImage = process.env.ANVIL_AWS_AGENT_SANDBOX_IMAGE;

    try {
      delete process.env.ANVIL_AWS_AGENT_SANDBOX_IMAGE;
      const diagnostics = checkAwsPreviewSupport(
        planManifestWithSandboxAgent(),
      );

      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: "AWS_PREVIEW_UNSUPPORTED_FEATURE",
          feature: "agentSandboxes",
          names: ["support"],
        }),
      ]);
    } finally {
      if (previousImage !== undefined) {
        process.env.ANVIL_AWS_AGENT_SANDBOX_IMAGE = previousImage;
      }
    }
  });
});

describe("AWS preview example", () => {
  it("builds and produces an AWS-compatible preview deployment plan", async () => {
    const build = await buildCell({ rootDir: awsPreviewExampleDir });

    expect(build.ok).toBe(true);

    if (!build.ok) {
      return;
    }

    expect(checkAwsPreviewSupport(build.manifest)).toEqual([]);

    const result = await new AwsPreviewDeploymentAdapter().deploy({
      manifest: build.manifest,
      buildOutput: build.output,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "AWS_PROVISIONER_NOT_CONFIGURED",
      plan: {
        cell: "aws-preview",
      },
      artifacts: {
        lambda: expect.objectContaining({
          sha256: expect.any(String),
        }),
      },
    });
    expect(result.plan.changes.map((change) => change.concept)).toEqual(
      expect.arrayContaining([
        "runtime",
        "http-ingress",
        "client-assets",
        "logs",
        "database",
        "events",
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
        operations: {
          cleanup: {
            commands: [
              "anvil-cloud destroy --preview --app notes --yes --json",
            ],
          },
        },
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

  it("fails before provisioning when the manifest uses unsupported AWS preview features", async () => {
    const adapter = new AwsPreviewDeploymentAdapter({
      provisioner: {
        async provision() {
          throw new Error("Provisioner should not be called.");
        },
      },
    });
    const result = await adapter.deploy({
      manifest: {
        ...manifest,
        services: [{ name: "heartbeat", restart: "always", maxRestarts: 3 }],
      },
      environment: "preview",
      buildOutput: {
        distDir: "/tmp/missing",
        generatedDir: "/tmp/missing",
        serverBundle: "/tmp/missing/server.mjs",
        clientIndex: "/tmp/missing/index.html",
        manifest: "/tmp/missing/manifest.json",
        buildMeta: "/tmp/missing/build-meta.json",
        generatedClient: "/tmp/missing/client.ts",
        generatedTypes: "/tmp/missing/api.d.ts",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "AWS_PREVIEW_UNSUPPORTED_FEATURE",
      diagnostics: [
        {
          feature: "services",
          names: ["heartbeat"],
        },
      ],
    });
  });

  it("fails before provisioning when outbound fetch is declared", async () => {
    const adapter = new AwsPreviewDeploymentAdapter({
      provisioner: {
        async provision() {
          throw new Error("Provisioner should not be called.");
        },
      },
    });
    const result = await adapter.deploy({
      manifest: {
        ...manifest,
        capabilities: {
          ...manifest.capabilities,
          outboundFetch: { allow: ["api.example.test"] },
        },
      },
      environment: "preview",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "AWS_PREVIEW_UNSUPPORTED_FEATURE",
      diagnostics: [
        {
          feature: "outboundFetch",
          names: ["api.example.test"],
        },
      ],
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
          key: expect.stringMatching(/^notes\/server-[a-f0-9]{12}\.zip$/),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    expect(provisionCalls).toHaveLength(1);
    expect(provisionCalls[0]).toMatchObject({
      environment: "preview",
      artifacts: {
        lambda: {
          key: expect.stringMatching(/^notes\/server-[a-f0-9]{12}\.zip$/),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("returns stable JSON when AWS provisioning reports a stack failure", async () => {
    const rootDir = await createBuildOutputFixture();
    const adapter = new AwsPreviewDeploymentAdapter({
      provisioner: {
        async provision() {
          throw new AwsPreviewProvisioningError(
            "AWS_STACK_FAILED",
            "CloudFormation stack 'anvil-notes-preview' finished with status 'CREATE_FAILED'. Recent failures: RuntimeFunction: denied",
            {
              stackName: "anvil-notes-preview",
              status: "CREATE_FAILED",
              events: [
                {
                  logicalResourceId: "RuntimeFunction",
                  resourceStatus: "CREATE_FAILED",
                  reason: "denied",
                },
              ],
            },
          );
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
      ok: false,
      code: "AWS_STACK_FAILED",
      details: {
        stackName: "anvil-notes-preview",
        status: "CREATE_FAILED",
        events: [
          {
            logicalResourceId: "RuntimeFunction",
            resourceStatus: "CREATE_FAILED",
            reason: "denied",
          },
        ],
      },
      artifacts: {
        lambda: {
          key: expect.stringMatching(/^notes\/server-[a-f0-9]{12}\.zip$/),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("returns stable JSON when AWS provisioning times out waiting for the stack", async () => {
    const rootDir = await createBuildOutputFixture();
    const adapter = new AwsPreviewDeploymentAdapter({
      provisioner: {
        async provision() {
          throw new AwsPreviewProvisioningError(
            "AWS_STACK_TIMEOUT",
            "CloudFormation stack 'anvil-notes-preview' did not finish within 2 attempts. Last status: UPDATE_IN_PROGRESS.",
            {
              stackName: "anvil-notes-preview",
              lastStatus: "UPDATE_IN_PROGRESS",
              attempts: 2,
              delayMs: 0,
            },
          );
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
      ok: false,
      code: "AWS_STACK_TIMEOUT",
      details: {
        stackName: "anvil-notes-preview",
        lastStatus: "UPDATE_IN_PROGRESS",
        attempts: 2,
        delayMs: 0,
      },
      artifacts: {
        lambda: {
          key: expect.stringMatching(/^notes\/server-[a-f0-9]{12}\.zip$/),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("returns stable JSON when AWS provisioning reports a missing stack output", async () => {
    const rootDir = await createBuildOutputFixture();
    const adapter = new AwsPreviewDeploymentAdapter({
      provisioner: {
        async provision() {
          throw new AwsPreviewProvisioningError(
            "AWS_STACK_OUTPUT_MISSING",
            "CloudFormation stack 'anvil-notes-preview' is missing required output 'RuntimeUrl'.",
            {
              stackName: "anvil-notes-preview",
              output: "RuntimeUrl",
            },
          );
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
      ok: false,
      code: "AWS_STACK_OUTPUT_MISSING",
      details: {
        stackName: "anvil-notes-preview",
        output: "RuntimeUrl",
      },
      artifacts: {
        lambda: {
          key: expect.stringMatching(/^notes\/server-[a-f0-9]{12}\.zip$/),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
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

function planManifestWithSandboxAgent() {
  return {
    ...manifest,
    agents: {
      support: createAgentManifest(
        defineAgent({
          name: "support",
          model: { provider: "aws-bedrock", model: "test-model" },
          runtime: { sandbox: "required" },
        }),
        "cell",
      ),
    },
  };
}
