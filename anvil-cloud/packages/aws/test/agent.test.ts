import { describe, expect, it } from "vitest";

import {
  defineAgent,
  createAgentManifest,
  type AgentExecutionSource,
} from "@anvil-cloud/runtime";

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
    const runHookPayload = JSON.parse(
      String(
        (
          sent[0] as {
            input?: { runHookPayload?: string };
          }
        ).input?.runHookPayload,
      ),
    ) as Record<string, unknown>;
    expect(runHookPayload).toMatchObject({
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
    expect(JSON.stringify(runHookPayload)).not.toContain("Bearer");
    expect(JSON.stringify(runHookPayload)).not.toContain("ghp_");

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

  it("implements the read-only resumable execution transport over the MicroVM endpoint", async () => {
    const requests: Array<{
      url: string;
      method: string;
      headers?: Record<string, string>;
      body?: string;
    }> = [];
    const provider = new AwsLambdaMicroVmSandboxProvider({
      region: "eu-west-1",
      imageIdentifier: "arn:aws:lambda-microvms:eu-west-1:123:image/anvil",
      client: {
        send: async (command: unknown) => {
          const name = command?.constructor?.name;

          if (name === "RunMicrovmCommand" || name === "GetMicrovmCommand") {
            return {
              microvmId: "mvm_execution",
              state: "RUNNING",
              endpoint: "https://mvm.example.test",
              maximumDurationInSeconds: 3600,
              startedAt: new Date("2026-08-10T10:00:00.000Z"),
            };
          }

          if (name === "CreateMicrovmAuthTokenCommand") {
            return { authToken: { Authorization: "Bearer ephemeral" } };
          }

          return {};
        },
      },
      executionFetch: async (input, init) => {
        requests.push({
          url: input,
          method: init?.method ?? "GET",
          ...(init?.headers === undefined ? {} : { headers: init.headers }),
          ...(init?.body === undefined ? {} : { body: init.body }),
        });

        if (input.endsWith("/_anvil/execution/workspace")) {
          return jsonResponse({ workspace: { id: "workspace_1" } });
        }
        if (input.endsWith("/_anvil/execution/runs")) {
          return jsonResponse({ runId: "run_1" });
        }
        if (input.includes("/events")) {
          return jsonResponse({
            events: [
              {
                id: "event_1",
                type: "execution.completed",
                data: {},
              },
            ],
            cursor: "event_1",
            done: true,
          });
        }
        if (input.endsWith("/result")) {
          return jsonResponse({
            result: {
              status: "completed",
              summary: "Repository inspected.",
              changedFiles: [],
              artifacts: [],
              commands: [],
              tests: [],
              errors: [],
              evidence: [],
            },
          });
        }

        return jsonResponse({ ok: true });
      },
    });
    const manifest = createAgentManifest(
      defineAgent({
        name: "remote-reviewer",
        model: { provider: "control-plane", model: "configured" },
        capabilities: {
          filesystem: "read",
          network: { allow: ["github.com"] },
          git: ["read"],
        },
        runtime: { sandbox: "required" },
      }),
    );
    const source: AgentExecutionSource = {
      kind: "git",
      repository: "https://github.com/example/repository.git",
      commit: "a".repeat(40),
      selection: {
        includesWorkingTreePatch: false,
        excluded: [
          "git-metadata",
          "ignored-files",
          "secret-files",
          "unrelated-untracked-files",
        ],
      },
    };
    const request = {
      schemaVersion: "0.1" as const,
      clientToken: "client_1",
      workspace: "workspace-1",
      cell: "notes",
      environment: "preview",
      task: "Inspect this repository.",
      agent: manifest,
      source,
      providerPreference: {
        kind: "provider" as const,
        provider: "aws-lambda-microvm",
      },
      policy: {
        mode: "read-only" as const,
        ttlSeconds: 3600,
        network: manifest.capabilities.network,
        requireApprovalForExternalActions: true,
      },
      modelAuth: {
        kind: "control-plane" as const,
        credential: "MODEL_API_KEY",
      },
    };

    expect(provider.supports(request)).toEqual({
      supported: true,
      reasons: [],
    });
    expect(
      provider.supports({
        ...request,
        policy: { ...request.policy, mode: "read-write" },
      }),
    ).toMatchObject({ supported: false });
    expect(
      provider.supports({
        ...request,
        modelAuth: {
          kind: "provider-subscription",
          provider: "codex",
          persistence: "sandbox-session",
        },
      }),
    ).toMatchObject({
      supported: false,
      reasons: [expect.stringContaining("does not advertise codex")],
    });
    expect(
      new AwsLambdaMicroVmSandboxProvider({
        imageIdentifier: "worker-image",
        subscriptionProviders: ["codex"],
        client: { send: async () => ({}) },
      }).supports({
        ...request,
        modelAuth: {
          kind: "provider-subscription",
          provider: "codex",
          persistence: "sandbox-session",
        },
      }),
    ).toEqual({ supported: true, reasons: [] });

    const session = await provider.start({
      manifest,
      cell: "notes",
      environment: "preview",
    });
    await expect(
      provider.prepareWorkspace(session, { executionId: "exec_1", source }),
    ).resolves.toMatchObject({ id: "workspace_1", writable: false });
    const handle = await provider.startExecution(session, {
      executionId: "exec_1",
      task: request.task,
      source,
      policy: request.policy,
      modelAuth: request.modelAuth,
    });
    await expect(provider.readEvents(handle)).resolves.toMatchObject({
      cursor: "event_1",
      done: true,
    });
    await provider.resolveApproval(handle, {
      requestId: "approval_1",
      decision: "approved",
      actor: "reviewer",
    });
    await provider.submitInput(handle, {
      requestId: "input_1",
      values: { answer: "yes" },
    });
    await provider.steer(handle, "Focus on tests.");
    await expect(provider.collectResult(handle)).resolves.toMatchObject({
      status: "completed",
      changedFiles: [],
    });

    expect(requests.map((item) => item.url)).toEqual([
      "https://mvm.example.test/_anvil/execution/workspace",
      "https://mvm.example.test/_anvil/execution/runs",
      "https://mvm.example.test/_anvil/execution/runs/run_1/events",
      "https://mvm.example.test/_anvil/execution/runs/run_1/approvals/approval_1",
      "https://mvm.example.test/_anvil/execution/runs/run_1/input/input_1",
      "https://mvm.example.test/_anvil/execution/runs/run_1/steer",
      "https://mvm.example.test/_anvil/execution/runs/run_1/result",
    ]);
    expect(
      requests.every(
        (item) => item.headers?.Authorization === "Bearer ephemeral",
      ),
    ).toBe(true);
    expect(requests.map((item) => item.body ?? "").join("\n")).not.toContain(
      ".codex",
    );
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

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  };
}
