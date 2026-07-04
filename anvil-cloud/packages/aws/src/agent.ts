import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConversationRole,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  AgentInferenceProvider,
  AgentInferenceRequest,
  AgentInferenceResponse,
  AgentManifest,
  AgentMessage,
} from "@anvil-cloud/runtime";

export type BedrockInferenceProviderOptions = {
  region?: string;
  client?: Pick<BedrockRuntimeClient, "send">;
};

export class BedrockInferenceProvider implements AgentInferenceProvider {
  readonly id = "aws-bedrock";
  private readonly client: Pick<BedrockRuntimeClient, "send"> | undefined;

  constructor(private readonly options: BedrockInferenceProviderOptions = {}) {
    this.client = options.client;
  }

  async invoke(
    request: AgentInferenceRequest,
  ): Promise<AgentInferenceResponse> {
    const client = this.client ?? this.createClient(request);
    const systemText = request.messages
      .filter((message) => message.role === "system")
      .map((message) => contentText(message.content))
      .filter((text) => text.length > 0);
    const messages = request.messages
      .filter((message) => message.role !== "system")
      .map(toBedrockMessage);
    const response = await client.send(
      new ConverseCommand({
        modelId: request.model.model,
        ...(systemText.length > 0
          ? {
              system: systemText.map((text) => ({ text })),
            }
          : {}),
        messages,
      }),
    );
    const outputMessage = response.output?.message;

    const usage: AgentInferenceResponse["usage"] = {};

    if (response.usage?.inputTokens !== undefined) {
      usage.inputTokens = response.usage.inputTokens;
    }

    if (response.usage?.outputTokens !== undefined) {
      usage.outputTokens = response.usage.outputTokens;
    }

    if (response.usage?.totalTokens !== undefined) {
      usage.totalTokens = response.usage.totalTokens;
    }

    return {
      message: {
        role: "assistant",
        content:
          outputMessage?.content
            ?.map((part) => ("text" in part ? part.text : ""))
            .join("") ?? "",
      },
      usage,
      raw: response,
    };
  }

  private createClient(
    request: AgentInferenceRequest,
  ): Pick<BedrockRuntimeClient, "send"> {
    const region =
      request.model.region ??
      this.options.region ??
      process.env.AWS_REGION ??
      process.env.AWS_DEFAULT_REGION;

    return new BedrockRuntimeClient(region === undefined ? {} : { region });
  }
}

export type AwsAgentCompatibilityResult = {
  adapter: "aws";
  supported: boolean;
  inferenceProviders: string[];
  sandboxProvider?: "aws-lambda-microvm";
  unsupportedRequirements: string[];
  warnings: string[];
};

export type AwsAgentCompatibilityOptions = {
  agentSandboxesEnabled?: boolean;
};

export function checkAwsAgentCompatibility(
  manifest: AgentManifest,
  options: AwsAgentCompatibilityOptions = {},
): AwsAgentCompatibilityResult {
  const unsupportedRequirements: string[] = [];
  const warnings: string[] = [];

  if (manifest.model.provider !== "aws-bedrock") {
    unsupportedRequirements.push(
      `inference provider '${manifest.model.provider}'`,
    );
  }

  if (manifest.requires.durableExecution) {
    unsupportedRequirements.push("durableExecution");
  }

  if (manifest.requires.sandbox && !options.agentSandboxesEnabled) {
    unsupportedRequirements.push("sandbox");
  }

  if (manifest.requires.sandbox && options.agentSandboxesEnabled) {
    warnings.push(
      "AWS preview maps sandbox-required agents to Lambda MicroVM Agent Sandboxes. Verify sandbox image, role, network, and cleanup policy before deployment.",
    );
  }

  if (manifest.requires.memory) {
    warnings.push("AWS preview does not yet implement an agent memory store.");
  }

  if (manifest.requires.humanApproval.length > 0) {
    warnings.push(
      "AWS preview reports agent approval requirements but does not provide a production approval UI.",
    );
  }

  const result: AwsAgentCompatibilityResult = {
    adapter: "aws",
    supported: unsupportedRequirements.length === 0,
    inferenceProviders: ["aws-bedrock"],
    unsupportedRequirements,
    warnings,
  };

  if (manifest.requires.sandbox && options.agentSandboxesEnabled) {
    result.sandboxProvider = "aws-lambda-microvm";
  }

  return result;
}

function toBedrockMessage(message: AgentMessage): Message {
  const role: ConversationRole =
    message.role === "assistant" ? "assistant" : "user";

  return {
    role,
    content: [{ text: contentText(message.content) }],
  };
}

function contentText(content: AgentMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) =>
      part.type === "text" ? part.text : JSON.stringify(part.value),
    )
    .join("");
}
