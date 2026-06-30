import { describe, expect, it } from "vitest";

import { defineAgent, createAgentManifest } from "@anvil-cloud/runtime";

import {
  AwsLambdaMicroVmSandboxError,
  AwsLambdaMicroVmSandboxProvider,
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
      unsupportedRequirements: ["durableExecution", "sandbox"],
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("memory"),
        expect.stringContaining("approval"),
      ]),
    );
    expect(JSON.stringify(manifest)).not.toMatch(/CloudWatch|Lambda|IAM/);
  });

  it("supports sandbox-required agents when Lambda MicroVM sandboxes are enabled", () => {
    const manifest = createAgentManifest(
      defineAgent({
        name: "support",
        model: { provider: "aws-bedrock", model: "test-model" },
        runtime: {
          sandbox: "required",
        },
      }),
      "cell.endpoint",
    );

    expect(
      checkAwsAgentCompatibility(manifest, { agentSandboxesEnabled: true }),
    ).toMatchObject({
      adapter: "aws",
      supported: true,
      sandboxProvider: "aws-lambda-microvm",
      unsupportedRequirements: [],
    });
  });
});

describe("AwsLambdaMicroVmSandboxProvider", () => {
  it("starts, inspects, resumes, suspends, terminates, and creates auth tokens", async () => {
    const sent: unknown[] = [];
    const provider = new AwsLambdaMicroVmSandboxProvider({
      region: "eu-west-1",
      imageIdentifier: "arn:aws:lambda-microvms:eu-west-1:123:image/anvil",
      imageVersion: "1",
      executionRoleArn: "arn:aws:iam::123:role/anvil-agent-sandbox",
      logGroup: "/aws/lambda-microvms/anvil-agent-sandboxes",
      client: {
        send: async (command: unknown) => {
          sent.push(command);
          const name = command?.constructor?.name;

          if (name === "RunMicrovmCommand" || name === "GetMicrovmCommand") {
            return {
              microvmId: "mvm_123",
              state: "RUNNING",
              endpoint: "https://mvm.example.test",
              imageArn: "arn:aws:lambda-microvms:eu-west-1:123:image/anvil",
              imageVersion: "1",
              maximumDurationInSeconds: 3600,
              startedAt: new Date("2026-06-30T10:00:00.000Z"),
            };
          }

          if (name === "CreateMicrovmAuthTokenCommand") {
            return {
              authToken: {
                Authorization: "Bearer test",
              },
            };
          }

          return {};
        },
      },
      maximumDurationInSeconds: 3600,
    });
    const manifest = createAgentManifest(
      defineAgent({
        name: "release-engineer",
        model: { provider: "aws-bedrock", model: "test-model" },
        capabilities: {
          git: ["read"],
          filesystem: "read-write",
        },
        approvals: {
          requiredFor: ["git.push"],
        },
        runtime: {
          sandbox: "required",
        },
      }),
      "cell",
    );

    const session = await provider.start({
      manifest,
      cell: "notes",
      environment: "preview",
      clientToken: "token_123",
    });

    expect(session).toMatchObject({
      id: "mvm_123",
      agent: "release-engineer",
      status: "active",
      endpointUrl: "https://mvm.example.test",
      provider: "aws-lambda-microvm",
      region: "eu-west-1",
      expiresAt: "2026-06-30T11:00:00.000Z",
    });
    expect(JSON.stringify(sent[0])).toContain("release-engineer");

    await expect(provider.inspect("mvm_123")).resolves.toMatchObject({
      id: "mvm_123",
      status: "active",
    });
    await provider.suspend("mvm_123");
    await expect(provider.resume("mvm_123")).resolves.toMatchObject({
      id: "mvm_123",
    });
    await provider.terminate("mvm_123");
    await expect(
      provider.createAuthToken("mvm_123", {
        expirationMinutes: 5,
        ports: [443],
      }),
    ).resolves.toEqual({
      sessionId: "mvm_123",
      tokenParts: {
        Authorization: "Bearer test",
      },
    });
    expect(sent.map((command) => command?.constructor?.name)).toEqual([
      "RunMicrovmCommand",
      "GetMicrovmCommand",
      "SuspendMicrovmCommand",
      "ResumeMicrovmCommand",
      "GetMicrovmCommand",
      "TerminateMicrovmCommand",
      "CreateMicrovmAuthTokenCommand",
    ]);
  });

  it("requires a configured MicroVM image before starting sandboxes", async () => {
    const provider = new AwsLambdaMicroVmSandboxProvider({
      client: {
        send: async () => {
          throw new Error("send should not be called");
        },
      },
    });
    const manifest = createAgentManifest(
      defineAgent({
        name: "support",
        model: { provider: "aws-bedrock", model: "test-model" },
        runtime: { sandbox: "required" },
      }),
      "cell",
    );

    await expect(
      provider.start({
        manifest,
        cell: "notes",
        environment: "preview",
      }),
    ).rejects.toBeInstanceOf(AwsLambdaMicroVmSandboxError);
  });
});
