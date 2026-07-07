import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
  type GetMicrovmCommandOutput,
  type RunMicrovmCommandInput,
  type RunMicrovmCommandOutput,
} from "@aws-sdk/client-lambda-microvms";
import type {
  AgentSandboxAuthToken,
  AgentSandboxProvider,
  AgentSandboxSession,
  AgentSandboxStartInput,
  AgentSandboxStatus,
} from "@anvil-cloud/runtime";

export type AwsLambdaMicroVmSandboxProviderOptions = {
  region?: string;
  imageIdentifier?: string;
  imageVersion?: string;
  executionRoleArn?: string;
  ingressNetworkConnectors?: string[];
  egressNetworkConnectors?: string[];
  maxIdleDurationSeconds?: number;
  suspendedDurationSeconds?: number;
  maximumDurationInSeconds?: number;
  logGroup?: string;
  client?: Pick<LambdaMicrovmsClient, "send">;
};

export class AwsLambdaMicroVmSandboxError extends Error {
  constructor(
    readonly code: "AWS_AGENT_SANDBOX_IMAGE_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "AwsLambdaMicroVmSandboxError";
  }
}

export class AwsLambdaMicroVmSandboxProvider implements AgentSandboxProvider {
  readonly id = "aws-lambda-microvm";
  private readonly client: Pick<LambdaMicrovmsClient, "send">;

  constructor(
    private readonly options: AwsLambdaMicroVmSandboxProviderOptions = {},
  ) {
    this.client =
      options.client ??
      new LambdaMicrovmsClient(
        options.region === undefined ? {} : { region: options.region },
      );
  }

  async start(input: AgentSandboxStartInput): Promise<AgentSandboxSession> {
    const imageIdentifier =
      this.options.imageIdentifier ?? process.env.ANVIL_AWS_AGENT_SANDBOX_IMAGE;

    if (!imageIdentifier) {
      throw new AwsLambdaMicroVmSandboxError(
        "AWS_AGENT_SANDBOX_IMAGE_REQUIRED",
        "AWS Lambda MicroVM Agent Sandboxes require ANVIL_AWS_AGENT_SANDBOX_IMAGE or imageIdentifier.",
      );
    }

    const commandInput: RunMicrovmCommandInput = {
      imageIdentifier,
      clientToken:
        input.clientToken ??
        `anvil-${input.cell}-${input.environment}-${input.manifest.name}`,
      maximumDurationInSeconds: this.options.maximumDurationInSeconds ?? 28_800,
      idlePolicy: {
        maxIdleDurationSeconds: this.options.maxIdleDurationSeconds ?? 900,
        suspendedDurationSeconds:
          this.options.suspendedDurationSeconds ?? 28_800,
        autoResumeEnabled: true,
      },
      runHookPayload: JSON.stringify({
        kind: "anvil.agent-sandbox",
        schemaVersion: "0.1",
        cell: input.cell,
        environment: input.environment,
        agent: input.manifest.name,
        capabilities: input.manifest.capabilities,
        approvals: input.manifest.requires.humanApproval,
        credentialBroker:
          input.credentialBroker ?? input.manifest.credentialBroker,
        workspace: input.workspace,
      }),
    };

    if (this.options.imageVersion !== undefined) {
      commandInput.imageVersion = this.options.imageVersion;
    }

    if (this.options.executionRoleArn !== undefined) {
      commandInput.executionRoleArn = this.options.executionRoleArn;
    }

    if (this.options.ingressNetworkConnectors !== undefined) {
      commandInput.ingressNetworkConnectors =
        this.options.ingressNetworkConnectors;
    }

    if (this.options.egressNetworkConnectors !== undefined) {
      commandInput.egressNetworkConnectors =
        this.options.egressNetworkConnectors;
    }

    if (this.options.logGroup !== undefined) {
      commandInput.logging = {
        cloudWatch: {
          logGroup: this.options.logGroup,
        },
      };
    }

    const response = await this.client.send(
      new RunMicrovmCommand(commandInput),
    );

    return sessionFromMicrovm(
      response,
      compactContext({
        agent: input.manifest.name,
        provider: this.id,
        region: this.options.region,
      }),
    );
  }

  async inspect(sessionId: string): Promise<AgentSandboxSession> {
    const response = await this.client.send(
      new GetMicrovmCommand({ microvmIdentifier: sessionId }),
    );

    return sessionFromMicrovm(
      response,
      compactContext({
        agent: "unknown",
        provider: this.id,
        region: this.options.region,
      }),
    );
  }

  async suspend(sessionId: string): Promise<void> {
    await this.client.send(
      new SuspendMicrovmCommand({ microvmIdentifier: sessionId }),
    );
  }

  async resume(sessionId: string): Promise<AgentSandboxSession> {
    await this.client.send(
      new ResumeMicrovmCommand({ microvmIdentifier: sessionId }),
    );
    return this.inspect(sessionId);
  }

  async terminate(sessionId: string): Promise<void> {
    await this.client.send(
      new TerminateMicrovmCommand({ microvmIdentifier: sessionId }),
    );
  }

  async createAuthToken(
    sessionId: string,
    options: { expirationMinutes?: number; ports?: number[] } = {},
  ): Promise<AgentSandboxAuthToken> {
    const response = await this.client.send(
      new CreateMicrovmAuthTokenCommand({
        microvmIdentifier: sessionId,
        expirationInMinutes: options.expirationMinutes ?? 15,
        allowedPorts:
          options.ports && options.ports.length > 0
            ? options.ports.map((port) => ({ port }))
            : [{ allPorts: {} }],
      }),
    );

    return {
      sessionId,
      tokenParts: response.authToken ?? {},
    };
  }
}

export function createAwsLambdaMicroVmSandboxProviderFromEnv(
  options: Omit<
    AwsLambdaMicroVmSandboxProviderOptions,
    "imageIdentifier" | "region"
  > = {},
): AwsLambdaMicroVmSandboxProvider {
  const envOptions: AwsLambdaMicroVmSandboxProviderOptions = {
    ...options,
  };
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

  if (region !== undefined) {
    envOptions.region = region;
  }

  if (process.env.ANVIL_AWS_AGENT_SANDBOX_IMAGE !== undefined) {
    envOptions.imageIdentifier = process.env.ANVIL_AWS_AGENT_SANDBOX_IMAGE;
  }

  return new AwsLambdaMicroVmSandboxProvider(envOptions);
}

function compactContext(context: {
  agent: string;
  provider: string;
  region: string | undefined;
}): {
  agent: string;
  provider: string;
  region?: string;
} {
  const compacted: {
    agent: string;
    provider: string;
    region?: string;
  } = {
    agent: context.agent,
    provider: context.provider,
  };

  if (context.region !== undefined) {
    compacted.region = context.region;
  }

  return compacted;
}

function sessionFromMicrovm(
  response: RunMicrovmCommandOutput | GetMicrovmCommandOutput,
  context: {
    agent: string;
    provider: string;
    region?: string;
  },
): AgentSandboxSession {
  const session: AgentSandboxSession = {
    id: response.microvmId ?? "unknown",
    agent: context.agent,
    status: mapMicrovmState(response.state),
    provider: context.provider,
    metadata: {
      stateReason: response.stateReason,
      maximumDurationInSeconds: response.maximumDurationInSeconds,
      ingressNetworkConnectors: response.ingressNetworkConnectors ?? [],
      egressNetworkConnectors: response.egressNetworkConnectors ?? [],
    },
  };

  if (response.endpoint !== undefined) {
    session.endpointUrl = response.endpoint;
  }

  if (context.region !== undefined) {
    session.region = context.region;
  }

  if (response.startedAt !== undefined) {
    session.startedAt = response.startedAt.toISOString();
  }

  if (response.terminatedAt !== undefined) {
    session.terminatedAt = response.terminatedAt.toISOString();
  }

  if (response.imageArn !== undefined) {
    session.image = {
      arn: response.imageArn,
      ...(response.imageVersion === undefined
        ? {}
        : { version: response.imageVersion }),
    };
  }

  if (
    response.startedAt !== undefined &&
    response.maximumDurationInSeconds !== undefined
  ) {
    session.expiresAt = new Date(
      response.startedAt.getTime() + response.maximumDurationInSeconds * 1000,
    ).toISOString();
  }

  return session;
}

function mapMicrovmState(state: string | undefined): AgentSandboxStatus {
  switch (state) {
    case "PENDING":
      return "starting";
    case "RUNNING":
      return "active";
    case "SUSPENDING":
      return "waiting-for-approval";
    case "SUSPENDED":
      return "suspended";
    case "TERMINATING":
      return "terminating";
    case "TERMINATED":
      return "terminated";
    default:
      return "failed";
  }
}
