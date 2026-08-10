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
  AgentExecutionApprovalDecision,
  AgentExecutionEventBatch,
  AgentExecutionHandle,
  AgentExecutionInputSubmission,
  AgentExecutionProvider,
  AgentExecutionProviderResult,
  AgentExecutionRequest,
  AgentExecutionStartInput,
  AgentExecutionWorkspace,
  AgentSandboxAuthToken,
  AgentSandboxSession,
  AgentSandboxStartInput,
  AgentSandboxStatus,
} from "@anvil-cloud/runtime";

export type AwsAgentExecutionFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

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
  executionFetch?: AwsAgentExecutionFetch;
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

export class AwsAgentExecutionTransportError extends Error {
  constructor(
    readonly code:
      | "AWS_AGENT_EXECUTION_ENDPOINT_REQUIRED"
      | "AWS_AGENT_EXECUTION_REQUEST_FAILED"
      | "AWS_AGENT_EXECUTION_INVALID_RESPONSE",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AwsAgentExecutionTransportError";
  }
}

export class AwsLambdaMicroVmSandboxProvider implements AgentExecutionProvider {
  readonly id = "aws-lambda-microvm";
  readonly executionCapabilities = {
    modes: ["read-only"],
    maxTtlSeconds: 28_800,
    resumableEvents: true,
    approvals: true,
    input: true,
    steering: true,
    artifacts: true,
    patches: false,
  } as const;
  private readonly client: Pick<LambdaMicrovmsClient, "send">;
  private readonly executionFetch: AwsAgentExecutionFetch;
  private readonly sessions = new Map<string, AgentSandboxSession>();

  constructor(
    private readonly options: AwsLambdaMicroVmSandboxProviderOptions = {},
  ) {
    this.client =
      options.client ??
      new LambdaMicrovmsClient(
        options.region === undefined ? {} : { region: options.region },
      );
    this.executionFetch =
      options.executionFetch ?? (fetch as unknown as AwsAgentExecutionFetch);
  }

  supports(request: AgentExecutionRequest) {
    const reasons: string[] = [];
    const imageIdentifier =
      this.options.imageIdentifier ?? process.env.ANVIL_AWS_AGENT_SANDBOX_IMAGE;

    if (!imageIdentifier) {
      reasons.push("AWS Agent Sandbox image is not configured");
    }
    if (request.policy.mode !== "read-only") {
      reasons.push("AWS execution is read-only in the current vertical slice");
    }
    if (request.policy.ttlSeconds > this.executionCapabilities.maxTtlSeconds) {
      reasons.push("requested TTL exceeds the AWS sandbox maximum");
    }
    if (request.source.selection.includesWorkingTreePatch) {
      reasons.push(
        "working-tree patches are not accepted by the AWS read-only slice",
      );
    }

    return { supported: reasons.length === 0, reasons };
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
        executionProtocol: {
          schemaVersion: "0.1",
          transport: "https",
          basePath: "/_anvil/execution",
          resumableEvents: true,
          modelAuth: "control-plane-brokered",
        },
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

    const session = sessionFromMicrovm(
      response,
      compactContext({
        agent: input.manifest.name,
        provider: this.id,
        region: this.options.region,
      }),
    );
    this.sessions.set(session.id, session);

    return session;
  }

  async inspect(sessionId: string): Promise<AgentSandboxSession> {
    const response = await this.client.send(
      new GetMicrovmCommand({ microvmIdentifier: sessionId }),
    );

    const session = sessionFromMicrovm(
      response,
      compactContext({
        agent: "unknown",
        provider: this.id,
        region: this.options.region,
      }),
    );
    this.sessions.set(session.id, session);

    return session;
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

  async prepareWorkspace(
    session: AgentSandboxSession,
    input: { executionId: string; source: AgentExecutionStartInput["source"] },
  ): Promise<AgentExecutionWorkspace> {
    const payload = await this.executionRequest(session.id, "/workspace", {
      method: "POST",
      body: input,
    });

    if (
      !isObject(payload.workspace) ||
      typeof payload.workspace.id !== "string"
    ) {
      throw invalidExecutionResponse(
        "Workspace preparation returned no workspace id.",
      );
    }

    return {
      id: payload.workspace.id,
      source: input.source,
      writable: false,
      metadata: isObject(payload.workspace.metadata)
        ? payload.workspace.metadata
        : {},
    };
  }

  async startExecution(
    session: AgentSandboxSession,
    input: AgentExecutionStartInput,
  ): Promise<AgentExecutionHandle> {
    const payload = await this.executionRequest(session.id, "/runs", {
      method: "POST",
      body: input,
    });

    if (typeof payload.runId !== "string" || payload.runId.length === 0) {
      throw invalidExecutionResponse("Execution start returned no run id.");
    }

    return { sessionId: session.id, runId: payload.runId };
  }

  async readEvents(
    handle: AgentExecutionHandle,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<AgentExecutionEventBatch> {
    const query = new URLSearchParams();

    if (options.cursor !== undefined) {
      query.set("cursor", options.cursor);
    }
    if (options.limit !== undefined) {
      query.set("limit", String(options.limit));
    }

    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const payload = await this.executionRequest(
      handle.sessionId,
      `/runs/${encodeURIComponent(handle.runId)}/events${suffix}`,
    );

    if (!Array.isArray(payload.events) || typeof payload.done !== "boolean") {
      throw invalidExecutionResponse("Execution event response is invalid.");
    }

    return {
      events: payload.events as AgentExecutionEventBatch["events"],
      done: payload.done,
      ...(typeof payload.cursor === "string" ? { cursor: payload.cursor } : {}),
    };
  }

  async resolveApproval(
    handle: AgentExecutionHandle,
    decision: AgentExecutionApprovalDecision,
  ): Promise<void> {
    await this.executionRequest(
      handle.sessionId,
      `/runs/${encodeURIComponent(handle.runId)}/approvals/${encodeURIComponent(
        decision.requestId,
      )}`,
      { method: "POST", body: decision },
    );
  }

  async submitInput(
    handle: AgentExecutionHandle,
    input: AgentExecutionInputSubmission,
  ): Promise<void> {
    await this.executionRequest(
      handle.sessionId,
      `/runs/${encodeURIComponent(handle.runId)}/input/${encodeURIComponent(
        input.requestId,
      )}`,
      { method: "POST", body: input },
    );
  }

  async steer(handle: AgentExecutionHandle, message: string): Promise<void> {
    await this.executionRequest(
      handle.sessionId,
      `/runs/${encodeURIComponent(handle.runId)}/steer`,
      { method: "POST", body: { message } },
    );
  }

  async collectResult(
    handle: AgentExecutionHandle,
  ): Promise<AgentExecutionProviderResult> {
    const payload = await this.executionRequest(
      handle.sessionId,
      `/runs/${encodeURIComponent(handle.runId)}/result`,
    );

    if (
      !isObject(payload.result) ||
      typeof payload.result.status !== "string"
    ) {
      throw invalidExecutionResponse("Execution result response is invalid.");
    }

    return payload.result as AgentExecutionProviderResult;
  }

  private async executionRequest(
    sessionId: string,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<Record<string, unknown>> {
    const session =
      this.sessions.get(sessionId) ?? (await this.inspect(sessionId));

    if (!session.endpointUrl) {
      throw new AwsAgentExecutionTransportError(
        "AWS_AGENT_EXECUTION_ENDPOINT_REQUIRED",
        `AWS Agent Sandbox '${sessionId}' has no execution endpoint.`,
        { sessionId },
      );
    }

    const auth = await this.createAuthToken(sessionId, {
      expirationMinutes: 5,
      ports: [443],
    });
    let response: Awaited<ReturnType<AwsAgentExecutionFetch>>;

    try {
      response = await this.executionFetch(
        `${trimTrailingCharacter(session.endpointUrl, "/")}/_anvil/execution${path}`,
        {
          method: init?.method ?? "GET",
          headers: {
            "content-type": "application/json",
            ...auth.tokenParts,
          },
          ...(init?.body === undefined
            ? {}
            : { body: JSON.stringify(init.body) }),
        },
      );
    } catch (error) {
      throw new AwsAgentExecutionTransportError(
        "AWS_AGENT_EXECUTION_REQUEST_FAILED",
        `AWS Agent Sandbox execution request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { sessionId, path },
      );
    }

    const payload = (await response.json().catch(() => ({}))) as unknown;

    if (!response.ok) {
      const record = isObject(payload) ? payload : {};
      const error = isObject(record.error) ? record.error : {};

      throw new AwsAgentExecutionTransportError(
        "AWS_AGENT_EXECUTION_REQUEST_FAILED",
        typeof error.message === "string"
          ? error.message
          : `AWS Agent Sandbox request returned status ${response.status}.`,
        {
          sessionId,
          path,
          status: response.status,
          providerCode: typeof error.code === "string" ? error.code : "UNKNOWN",
        },
      );
    }

    if (!isObject(payload)) {
      throw invalidExecutionResponse(
        "AWS Agent Sandbox returned non-object JSON.",
      );
    }

    return payload;
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

function invalidExecutionResponse(
  message: string,
): AwsAgentExecutionTransportError {
  return new AwsAgentExecutionTransportError(
    "AWS_AGENT_EXECUTION_INVALID_RESPONSE",
    message,
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimTrailingCharacter(value: string, character: string): string {
  let end = value.length;

  while (end > 0 && value[end - 1] === character) {
    end -= 1;
  }

  return value.slice(0, end);
}
