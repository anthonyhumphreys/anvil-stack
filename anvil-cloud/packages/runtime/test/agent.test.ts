import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentProviderRegistry,
  AgentRuntime,
  LocalStubInferenceProvider,
  RuntimeError,
  app,
  createAgentManifest,
  createAutoApproveApprovalProvider,
  createAutoRejectApprovalProvider,
  createPendingApprovalProvider,
  defineAgent,
  endpoint,
  inspectAppDefinition,
  normalizeAgentCapabilities,
  validateAgentDefinition,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("defineAgent", () => {
  it("returns a typed agent definition and least-privilege defaults", () => {
    const agent = defineAgent({
      name: "cell-reviewer",
      model: { provider: "local", model: "stub" },
    });

    expect(agent.kind).toBe("agent");
    expect(normalizeAgentCapabilities(agent.capabilities)).toEqual({
      cells: [],
      database: [],
      network: "restricted",
      filesystem: "none",
      secrets: "none",
      git: [],
      deployments: [],
    });
  });

  it("compiles dangerous capabilities and approvals into the manifest", () => {
    const manifest = createAgentManifest(
      defineAgent({
        name: "release-helper",
        model: { provider: "local", model: "stub" },
        capabilities: {
          filesystem: "read-write",
          secrets: "read",
          deployments: ["preview.deploy"],
        },
        approvals: {
          requiredFor: ["deploy.production"],
        },
      }),
      "project",
    );

    expect(manifest).toMatchObject({
      kind: "anvil.agent",
      exposure: "project",
      capabilities: {
        filesystem: "read-write",
        secrets: "read",
        deployments: ["preview.deploy"],
      },
      requires: {
        humanApproval: ["deploy.production"],
      },
    });
    expect(JSON.stringify(manifest)).not.toMatch(
      /Lambda|IAM|CloudWatch|DynamoDB|Step Functions/,
    );
  });

  it("validates file-based instructions", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-agent-"));
    tempDirs.push(rootDir);
    await mkdir(path.join(rootDir, "agents/reviewer"), { recursive: true });
    const instructionsPath = path.join(
      rootDir,
      "agents/reviewer/instructions.md",
    );

    await writeFile(instructionsPath, "Review Cell manifests.", "utf8");

    await expect(
      validateAgentDefinition(
        defineAgent({
          name: "reviewer",
          instructions: instructionsPath,
          model: { provider: "local", model: "stub" },
        }),
        { baseDir: rootDir },
      ),
    ).resolves.toEqual([]);

    await expect(
      validateAgentDefinition(
        defineAgent({
          name: "missing",
          instructions: "./agents/missing/instructions.md",
          model: { provider: "local", model: "stub" },
        }),
        { baseDir: rootDir },
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        code: "AGENT_INSTRUCTIONS_NOT_FOUND",
      }),
    ]);
  });
});

describe("AgentProviderRegistry and AgentRuntime", () => {
  it("invokes the selected provider through the provider interface", async () => {
    const registry = new AgentProviderRegistry([
      new LocalStubInferenceProvider({ echoInput: true }),
    ]);
    const runtime = new AgentRuntime({ providers: registry });
    const result = await runtime.invoke(
      defineAgent({
        name: "cell-reviewer",
        model: { provider: "local", model: "stub" },
      }),
      { input: "Review the support-desk Cell." },
    );

    expect(registry.has("local")).toBe(true);
    expect(result).toMatchObject({
      agentName: "cell-reviewer",
      response: {
        role: "assistant",
        content:
          "Local stub response from Anvil Agent: Review the support-desk Cell.",
      },
      usage: {
        totalTokens: 0,
      },
    });
  });

  it("fails missing providers with a useful runtime error", async () => {
    const runtime = new AgentRuntime({
      providers: new AgentProviderRegistry(),
    });

    await expect(
      runtime.invoke(
        defineAgent({
          name: "bedrock-agent",
          model: { provider: "aws-bedrock", model: "model-id" },
        }),
        { input: "hello" },
      ),
    ).rejects.toMatchObject({
      code: "ADAPTER_ERROR",
      message: "No agent inference provider 'aws-bedrock' is registered.",
    });
  });

  it("checks capabilities before tool execution", async () => {
    const runtime = new AgentRuntime();

    await expect(
      runtime.executeTool(
        defineAgent({
          name: "limited",
          model: { provider: "local", model: "stub" },
          capabilities: { cells: ["read"] },
        }),
        {
          definition: {
            name: "deploy",
            requiredCapabilities: ["deployments.production"],
          },
          execute: async () => ({ ok: true }),
        },
        {},
      ),
    ).rejects.toBeInstanceOf(RuntimeError);
  });

  it("returns approval states for gated tool execution", async () => {
    const agent = defineAgent({
      name: "support-assistant",
      model: { provider: "local", model: "stub" },
      capabilities: { database: ["supportTickets.update"] },
      approvals: { requiredFor: ["supportTickets.bulkUpdate"] },
    });
    const tool = {
      definition: {
        name: "bulkUpdateTickets",
        action: "supportTickets.bulkUpdate",
        requiredCapabilities: ["database.supportTickets.update"],
      },
      execute: async () => ({ ok: true, output: { updated: 2 } }),
    };

    await expect(
      new AgentRuntime({
        approvalProvider: createPendingApprovalProvider("approval_1"),
      }).executeTool(agent, tool, {}),
    ).resolves.toMatchObject({
      ok: false,
      approval: { status: "pending", approvalId: "approval_1" },
    });
    await expect(
      new AgentRuntime({
        approvalProvider: createAutoRejectApprovalProvider("Nope."),
      }).executeTool(agent, tool, {}),
    ).resolves.toMatchObject({
      ok: false,
      approval: { status: "rejected", reason: "Nope." },
    });
    await expect(
      new AgentRuntime({
        approvalProvider: createAutoApproveApprovalProvider("tester"),
      }).executeTool(agent, tool, {}),
    ).resolves.toEqual({ ok: true, output: { updated: 2 } });
  });
});

describe("Cell-mounted agents", () => {
  it("inspects mounted agents and endpoint references", () => {
    const cell = app({
      agents: {
        support: defineAgent({
          name: "support",
          model: { provider: "local", model: "stub" },
        }),
      },
      endpoints: {
        chat: endpoint({
          method: "POST",
          path: "/api/chat",
          auth: "public",
          agent: "support",
          handler: async () => ({ ok: true }),
        }),
      },
    });

    expect(inspectAppDefinition(cell)).toMatchObject({
      agents: {
        support: {
          kind: "anvil.agent",
          name: "support",
          exposure: "cell",
        },
      },
      endpoints: [
        {
          name: "chat",
          agent: "support",
        },
      ],
    });
  });
});
