import { describe, expect, it } from "vitest";

import {
  AgentProviderRegistry,
  AgentRuntime,
  defineAgent,
  defineAgentEvalSuite,
  runAgentEvalSuite,
  type AgentInferenceProvider,
  type AgentToolExecutor,
} from "../src/index.js";

describe("Agent evals", () => {
  it("runs typed scenarios against an agent runtime", async () => {
    const providers = new AgentProviderRegistry([
      new StaticEvalProvider("Use deploy.preview carefully.", [
        { id: "call_1", name: "deployPreview", arguments: {} },
      ]),
    ]);
    const runtime = new AgentRuntime({ providers });
    const agent = defineAgent({
      name: "release-agent",
      model: { provider: "eval", model: "stub" },
      capabilities: {
        deployments: ["preview"],
      },
      approvals: {
        requiredFor: ["deploy.preview"],
      },
      evals: defineAgentEvalSuite({
        scenarios: [
          {
            name: "requires approval before deploy",
            input: "Deploy a preview.",
            expect: {
              responseIncludes: "deploy.preview",
              toolCalls: {
                count: 1,
                names: ["deployPreview"],
              },
              approvalsRequired: ["deploy.preview"],
              capabilities: {
                used: ["deployments.preview"],
                notUsed: ["network.github.com"],
              },
            },
          },
        ],
      }),
    });
    const tools: AgentToolExecutor[] = [
      {
        definition: {
          name: "deployPreview",
          action: "deploy.preview",
          requiredCapabilities: ["deployments.preview"],
        },
        execute: async () => ({ ok: true }),
      },
    ];

    const result = await runAgentEvalSuite(agent, agent.evals!, {
      runtime,
      tools,
    });

    expect(result).toMatchObject({
      ok: true,
      summary: {
        total: 1,
        passed: 1,
        failed: 0,
        score: 1,
      },
      scenarios: [
        {
          name: "requires approval before deploy",
          ok: true,
          toolCalls: ["deployPreview"],
          approvalsRequired: ["deploy.preview"],
          capabilityUsage: ["deployments.preview"],
        },
      ],
    });
    expect(result.baseline.agents["release-agent"]?.scenarios).toMatchObject({
      "requires approval before deploy": {
        responseText: "Use deploy.preview carefully.",
        toolCalls: ["deployPreview"],
        approvalsRequired: ["deploy.preview"],
      },
    });
  });

  it("reports baseline diffs as failed scenarios", async () => {
    const runtime = new AgentRuntime({
      providers: new AgentProviderRegistry([
        new StaticEvalProvider("New answer", []),
      ]),
    });
    const agent = defineAgent({
      name: "support",
      model: { provider: "eval", model: "stub" },
    });
    const suite = defineAgentEvalSuite({
      scenarios: [
        {
          name: "stable answer",
          input: "Hello",
        },
      ],
    });

    const result = await runAgentEvalSuite(agent, suite, {
      runtime,
      baseline: {
        agents: {
          support: {
            scenarios: {
              "stable answer": {
                responseText: "Old answer",
                toolCalls: [],
                approvalsRequired: [],
              },
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.scenarios[0]?.baseline).toMatchObject({
      ok: false,
      diffs: [
        expect.objectContaining({
          code: "BASELINE_RESPONSE",
          ok: false,
        }),
        expect.objectContaining({
          code: "BASELINE_TOOL_CALLS",
          ok: true,
        }),
        expect.objectContaining({
          code: "BASELINE_APPROVALS",
          ok: true,
        }),
      ],
    });
  });
});

class StaticEvalProvider implements AgentInferenceProvider {
  readonly id = "eval";

  constructor(
    private readonly response: string,
    private readonly toolCalls: {
      id: string;
      name: string;
      arguments: unknown;
    }[],
  ) {}

  async invoke() {
    return {
      message: {
        role: "assistant" as const,
        content: this.response,
      },
      toolCalls: this.toolCalls,
      usage: {
        totalTokens: 0,
      },
    };
  }
}
