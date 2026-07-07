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
  createInMemoryRuntimeHost,
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

  it("compiles brokered credential policy into the manifest without secret values", () => {
    const manifest = createAgentManifest(
      defineAgent({
        name: "repo-helper",
        model: { provider: "local", model: "stub" },
        capabilities: {
          network: { allow: ["github.com"] },
          secrets: "brokered",
        },
        credentialBroker: {
          credentials: [
            {
              credential: "GITHUB_TOKEN",
              domains: ["github.com"],
              inject: {
                kind: "header",
                name: "authorization",
                scheme: "bearer",
              },
            },
          ],
        },
        runtime: { sandbox: "required" },
      }),
      "cell",
    );

    expect(manifest).toMatchObject({
      credentialBroker: {
        credentials: [
          {
            credential: "GITHUB_TOKEN",
            domains: ["github.com"],
            inject: {
              kind: "header",
              name: "authorization",
              scheme: "bearer",
            },
          },
        ],
      },
    });
    expect(JSON.stringify(manifest)).not.toContain("ghp_");
  });

  it("rejects brokered credentials without sandboxed broker capabilities", () => {
    const issues = validateAgentDefinition(
      defineAgent({
        name: "unsafe",
        model: { provider: "local", model: "stub" },
        capabilities: {
          network: { allow: ["github.com"] },
          secrets: "none",
        },
        credentialBroker: {
          credentials: [
            {
              credential: "GITHUB_TOKEN",
              domains: ["github.com"],
              inject: { kind: "query", name: "token" },
            },
          ],
        },
      }),
    );

    return expect(issues).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "AGENT_CREDENTIAL_BROKER_REQUIRES_BROKERED_SECRETS",
        }),
        expect.objectContaining({
          code: "AGENT_CREDENTIAL_BROKER_REQUIRES_SANDBOX",
        }),
      ]),
    );
  });

  it("rejects brokered credential domains outside the network allowlist", async () => {
    await expect(
      validateAgentDefinition(
        defineAgent({
          name: "unsafe-network",
          model: { provider: "local", model: "stub" },
          capabilities: {
            network: { allow: ["api.github.com"] },
            secrets: "brokered",
          },
          credentialBroker: {
            credentials: [
              {
                credential: "GITHUB_TOKEN",
                domains: ["github.com"],
                inject: { kind: "header", name: "authorization" },
              },
            ],
          },
          runtime: { sandbox: "required" },
        }),
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "AGENT_CREDENTIAL_BROKER_DOMAIN_NOT_ALLOWED",
        }),
      ]),
    );
  });

  it("compiles explicit subagents into the manifest", () => {
    const manifest = createAgentManifest(
      defineAgent({
        name: "support-orchestrator",
        model: { provider: "local", model: "stub" },
        capabilities: {
          cells: ["read"],
          database: ["supportTickets.read"],
          filesystem: "read",
          secrets: "brokered",
        },
        subagents: {
          triage: defineAgent({
            name: "triage",
            purpose: "Classify incoming support requests.",
            model: { provider: "local", model: "stub" },
            capabilities: {
              cells: ["read"],
              database: ["supportTickets.read"],
              filesystem: "none",
              secrets: "none",
            },
          }),
        },
      }),
      "cell",
    );

    expect(manifest).toMatchObject({
      name: "support-orchestrator",
      subagents: {
        triage: {
          kind: "anvil.agent",
          name: "triage",
          purpose: "Classify incoming support requests.",
          exposure: "agent.subagent",
          capabilities: {
            database: ["supportTickets.read"],
            filesystem: "none",
            secrets: "none",
          },
          subagents: {},
        },
      },
    });
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

  it("rejects subagent capability escalation and nested subagents", async () => {
    const agent = defineAgent({
      name: "parent",
      model: { provider: "local", model: "stub" },
      capabilities: {
        database: ["tickets.read"],
        filesystem: "read",
        secrets: "brokered",
      },
      subagents: {
        writer: defineAgent({
          name: "writer",
          model: { provider: "local", model: "stub" },
          capabilities: {
            database: ["tickets.write"],
            filesystem: "read-write",
            secrets: "read",
          },
        }),
        nested: defineAgent({
          name: "nested",
          model: { provider: "local", model: "stub" },
          subagents: {
            tooDeep: defineAgent({
              name: "too-deep",
              model: { provider: "local", model: "stub" },
            }),
          },
        }),
      },
    });

    await expect(validateAgentDefinition(agent)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "AGENT_SUBAGENT_CAPABILITY_ESCALATION",
          path: "subagents.writer.capabilities",
        }),
        expect.objectContaining({
          code: "AGENT_SUBAGENT_NESTING_UNSUPPORTED",
          path: "subagents.nested.subagents",
        }),
      ]),
    );
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

  it("records model-call and invocation trace events when a trace adapter is available", async () => {
    const host = createInMemoryRuntimeHost();
    const runtime = new AgentRuntime({
      providers: new AgentProviderRegistry([
        new LocalStubInferenceProvider({ echoInput: true }),
      ]),
      traces: host.traces,
    });

    const result = await runtime.invoke(
      defineAgent({
        name: "cell-reviewer",
        model: { provider: "local", model: "stub" },
      }),
      { input: "Trace this." },
    );

    expect(result.traceId).toMatch(/^agent_/);
    await expect(host.traces.get(result.traceId ?? "")).resolves.toMatchObject({
      kind: "agent",
      name: "cell-reviewer",
      status: "completed",
      events: expect.arrayContaining([
        expect.objectContaining({ type: "agent.invoke.started" }),
        expect.objectContaining({ type: "agent.model.completed" }),
        expect.objectContaining({ type: "agent.invoke.completed" }),
      ]),
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

  it("invokes declared subagents and rejects undeclared delegation", async () => {
    const parent = defineAgent({
      name: "orchestrator",
      model: { provider: "local", model: "stub" },
      capabilities: { cells: ["read"] },
      subagents: {
        triage: defineAgent({
          name: "triage",
          model: { provider: "local", model: "stub" },
          capabilities: { cells: ["read"] },
        }),
      },
    });
    const runtime = new AgentRuntime({
      providers: new AgentProviderRegistry([
        new LocalStubInferenceProvider({ echoInput: true }),
      ]),
    });

    await expect(
      runtime.invokeSubagent(parent, "triage", { input: "classify this" }),
    ).resolves.toMatchObject({
      agentName: "triage",
      parentAgentName: "orchestrator",
      subagentMount: "triage",
      response: {
        content: "Local stub response from Anvil Agent: classify this",
      },
    });

    await expect(
      runtime.invokeSubagent(parent, "missing", { input: "nope" }),
    ).rejects.toMatchObject({
      code: "HANDLER_NOT_FOUND",
    });
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
