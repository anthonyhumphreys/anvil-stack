import { describe, expect, it } from "vitest";

import { defineAgent, createAgentManifest } from "@anvil-cloud/runtime";

import {
  BedrockInferenceProvider,
  checkAwsAgentCompatibility,
} from "../src/index.js";

describe("BedrockInferenceProvider", () => {
  it("implements the generic agent inference provider interface", async () => {
    const sent: unknown[] = [];
    const provider = new BedrockInferenceProvider({
      region: "eu-west-2",
      client: {
        send: async (command: unknown) => {
          sent.push(command);

          return {
            output: {
              message: {
                content: [{ text: "Bedrock response" }],
              },
            },
            usage: {
              inputTokens: 4,
              outputTokens: 6,
              totalTokens: 10,
            },
          };
        },
      },
    });

    const response = await provider.invoke({
      agentName: "support",
      model: {
        provider: "aws-bedrock",
        model: "test-model",
        region: "eu-west-2",
      },
      messages: [
        { role: "system", content: "Use the support policy." },
        { role: "user", content: "Hello" },
      ],
    });

    expect(provider.id).toBe("aws-bedrock");
    expect(sent).toHaveLength(1);
    expect(response).toMatchObject({
      message: {
        role: "assistant",
        content: "Bedrock response",
      },
      usage: {
        inputTokens: 4,
        outputTokens: 6,
        totalTokens: 10,
      },
    });
    expect(response.raw).toBeDefined();
  });
});

describe("checkAwsAgentCompatibility", () => {
  it("reports supported Bedrock inference and unsupported required features", () => {
    const manifest = createAgentManifest(
      defineAgent({
        name: "support",
        model: { provider: "aws-bedrock", model: "test-model" },
        memory: { retention: "session" },
        approvals: { requiredFor: ["email.sendExternal"] },
        runtime: {
          durability: "required",
          sandbox: "required",
          humanApproval: "required",
        },
      }),
      "cell.endpoint",
    );

    const result = checkAwsAgentCompatibility(manifest);

    expect(result).toMatchObject({
      adapter: "aws",
      supported: false,
      inferenceProviders: ["aws-bedrock"],
      unsupportedRequirements: ["durableExecution"],
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("sandbox"),
        expect.stringContaining("memory"),
        expect.stringContaining("approval"),
      ]),
    );
    expect(JSON.stringify(manifest)).not.toMatch(/CloudWatch|Lambda|IAM/);
  });
});
