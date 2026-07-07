import { RuntimeError } from "./errors.js";
import { Cause, Effect, Exit } from "effect";

export type AgentModelConfig = {
  provider: string;
  model: string;
  region?: string;
  options?: Record<string, unknown>;
};

export type AgentNetworkCapability =
  | "none"
  | "restricted"
  | {
      allow?: string[];
      deny?: string[];
    };

export type AgentCapabilities = {
  cells?: string[];
  database?: string[];
  network?: AgentNetworkCapability;
  filesystem?: "none" | "read" | "read-write";
  secrets?: "none" | "brokered" | "read";
  git?: string[];
  deployments?: string[];
};

export type NormalizedAgentCapabilities = {
  cells: string[];
  database: string[];
  network: AgentNetworkCapability;
  filesystem: "none" | "read" | "read-write";
  secrets: "none" | "brokered" | "read";
  git: string[];
  deployments: string[];
};

export type AgentApprovals = {
  requiredFor: string[];
};

export type AgentRuntimeRequirements = {
  durability?: "none" | "optional" | "required";
  sandbox?: "optional" | "required";
  humanApproval?: "optional" | "required";
};

export type AgentMemoryConfig = {
  schema?: string;
  retention?: "session" | "persistent" | "none";
};

export type AgentFileSet = {
  include?: string[];
};

export type AgentToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  requiredCapabilities?: string[];
  action?: string;
};

export type AgentToolContext = {
  agentName: string;
  capabilities: NormalizedAgentCapabilities;
  metadata?: Record<string, unknown>;
};

export type AgentToolResult = {
  ok: boolean;
  output?: unknown;
  error?: {
    code: string;
    message: string;
  };
  approval?: AgentApprovalDecision;
};

export type AgentToolExecutor = {
  definition: AgentToolDefinition;
  execute(input: unknown, context: AgentToolContext): Promise<AgentToolResult>;
};

export type AgentDefinitionInput = {
  name: string;
  description?: string;
  purpose?: string;
  instructions?: string;
  model: AgentModelConfig;
  tools?: AgentFileSet | AgentToolDefinition[];
  skills?: AgentFileSet;
  memory?: AgentMemoryConfig;
  capabilities?: AgentCapabilities;
  approvals?: AgentApprovals;
  runtime?: AgentRuntimeRequirements;
  subagents?: Record<string, AgentDefinition>;
  metadata?: Record<string, unknown>;
};

export type AgentDefinition = AgentDefinitionInput & {
  kind: "agent";
};

export type AgentManifest = {
  kind: "anvil.agent";
  name: string;
  description?: string;
  purpose?: string;
  exposure: AgentExposure;
  model: AgentModelConfig;
  requires: {
    inference: true;
    toolCalling: boolean;
    memory: boolean;
    durableExecution: boolean;
    sandbox: boolean;
    humanApproval: string[];
  };
  capabilities: NormalizedAgentCapabilities;
  runtime: {
    durability: "none" | "optional" | "required";
    sandbox: "optional" | "required";
    approval: "optional" | "required";
  };
  tools: AgentToolDefinition[];
  skills: string[];
  subagents: Record<string, AgentManifest>;
  metadata: Record<string, unknown>;
};

export type AgentExposure =
  | "project"
  | "cell"
  | "cell.endpoint"
  | "cell.workflow"
  | "agent.subagent";

export type AgentValidationIssue = {
  code: string;
  message: string;
  severity: "error" | "warning";
  path?: string;
};

export type AgentContentPart =
  | { type: "text"; text: string }
  | { type: "json"; value: unknown };

export type AgentMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | AgentContentPart[];
  name?: string;
  toolCallId?: string;
};

export type AgentToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type AgentResponseFormat =
  | { type: "text" }
  | { type: "json"; schema?: unknown };

export type AgentInferenceRequest = {
  agentName: string;
  model: AgentModelConfig;
  messages: AgentMessage[];
  tools?: AgentToolDefinition[];
  responseFormat?: AgentResponseFormat;
  metadata?: Record<string, unknown>;
};

export type AgentInferenceResponse = {
  message: AgentMessage;
  toolCalls?: AgentToolCall[];
  usage?: AgentTokenUsage;
  raw?: unknown;
};

export type AgentTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type AgentInferenceProvider = {
  id: string;
  invoke(request: AgentInferenceRequest): Promise<AgentInferenceResponse>;
};

export type AgentApprovalRequest = {
  action: string;
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type AgentApprovalDecision =
  | { status: "approved"; approvedBy?: string }
  | { status: "rejected"; rejectedBy?: string; reason?: string }
  | { status: "pending"; approvalId?: string };

export type AgentApprovalProvider = {
  requestApproval(
    request: AgentApprovalRequest,
  ): Promise<AgentApprovalDecision>;
};

export type AgentRuntimeInvokeInput = {
  input: string;
  context?: Record<string, unknown>;
  messages?: AgentMessage[];
  tools?: AgentToolExecutor[];
};

export type AgentRuntimeInvokeResult = {
  agentName: string;
  response: AgentMessage;
  toolCalls: AgentToolCall[];
  approvalsRequired: AgentApprovalRequest[];
  usage: AgentTokenUsage;
};

export type AgentRuntimeDelegationResult = AgentRuntimeInvokeResult & {
  parentAgentName: string;
  subagentMount: string;
};

export function defineAgent(definition: AgentDefinitionInput): AgentDefinition {
  return {
    ...definition,
    kind: "agent",
  };
}

export function normalizeAgentCapabilities(
  capabilities: AgentCapabilities = {},
): NormalizedAgentCapabilities {
  return {
    cells: capabilities.cells ?? [],
    database: capabilities.database ?? [],
    network: capabilities.network ?? "restricted",
    filesystem: capabilities.filesystem ?? "none",
    secrets: capabilities.secrets ?? "none",
    git: capabilities.git ?? [],
    deployments: capabilities.deployments ?? [],
  };
}

export function createAgentManifest(
  agent: AgentDefinition,
  exposure: AgentExposure = "project",
): AgentManifest {
  const capabilities = normalizeAgentCapabilities(agent.capabilities);
  const approvals = agent.approvals?.requiredFor ?? [];
  const runtime = {
    durability: agent.runtime?.durability ?? "none",
    sandbox: agent.runtime?.sandbox ?? "optional",
    approval: agent.runtime?.humanApproval ?? "optional",
  } as const;
  const tools = Array.isArray(agent.tools) ? agent.tools : [];
  const skills = agent.skills?.include ?? [];
  const manifest: AgentManifest = {
    kind: "anvil.agent",
    name: agent.name,
    exposure,
    model: sanitizeModelConfig(agent.model),
    requires: {
      inference: true,
      toolCalling: tools.length > 0,
      memory: agent.memory !== undefined && agent.memory.retention !== "none",
      durableExecution: runtime.durability === "required",
      sandbox: runtime.sandbox === "required",
      humanApproval: approvals,
    },
    capabilities,
    runtime,
    tools,
    skills,
    subagents:
      exposure === "agent.subagent"
        ? {}
        : Object.fromEntries(
            Object.entries(
              isObject(agent.subagents) ? agent.subagents : {},
            ).map(([mount, subagent]) => [
              mount,
              createAgentManifest(subagent, "agent.subagent"),
            ]),
          ),
    metadata: agent.metadata ?? {},
  };

  if (agent.description !== undefined) {
    manifest.description = agent.description;
  }

  if (agent.purpose !== undefined) {
    manifest.purpose = agent.purpose;
  }

  return manifest;
}

export async function validateAgentDefinition(
  agent: AgentDefinition,
  options: { baseDir?: string } = {},
): Promise<AgentValidationIssue[]> {
  const issues = validateAgentDefinitionShape(agent);

  if (
    typeof agent.instructions === "string" &&
    isFileReference(agent.instructions)
  ) {
    try {
      await readTextFile(resolveAgentPath(agent.instructions, options.baseDir));
    } catch {
      issues.push({
        code: "AGENT_INSTRUCTIONS_NOT_FOUND",
        severity: "error",
        message: `Agent '${agent.name}' references missing instructions file '${agent.instructions}'.`,
        path: "instructions",
      });
    }
  }

  return issues;
}

export function validateAgentDefinitionShape(
  agent: AgentDefinition,
  options: { includeSubagents?: boolean } = {},
): AgentValidationIssue[] {
  const includeSubagents = options.includeSubagents ?? true;
  const issues: AgentValidationIssue[] = [];

  if (agent.kind !== "agent") {
    issues.push({
      code: "AGENT_INVALID",
      severity: "error",
      message: "Agent definitions must be created with defineAgent().",
    });
  }

  if (typeof agent.name !== "string" || agent.name.trim().length === 0) {
    issues.push({
      code: "AGENT_NAME_REQUIRED",
      severity: "error",
      message: "Agent definitions must include a non-empty name.",
      path: "name",
    });
  }

  if (!isObject(agent.model)) {
    issues.push({
      code: "AGENT_MODEL_REQUIRED",
      severity: "error",
      message: `Agent '${agent.name}' must declare a model provider and model id.`,
      path: "model",
    });
  } else {
    if (
      typeof agent.model.provider !== "string" ||
      agent.model.provider.length === 0
    ) {
      issues.push({
        code: "AGENT_MODEL_PROVIDER_REQUIRED",
        severity: "error",
        message: `Agent '${agent.name}' must declare model.provider.`,
        path: "model.provider",
      });
    }

    if (
      typeof agent.model.model !== "string" ||
      agent.model.model.length === 0
    ) {
      issues.push({
        code: "AGENT_MODEL_ID_REQUIRED",
        severity: "error",
        message: `Agent '${agent.name}' must declare model.model.`,
        path: "model.model",
      });
    }
  }

  issues.push(...validateCapabilities(agent.name, agent.capabilities));
  issues.push(...validateApprovals(agent.name, agent.approvals));
  issues.push(...validateRuntimeRequirements(agent.name, agent.runtime));
  if (includeSubagents) {
    issues.push(...validateSubagents(agent));
  }

  return issues;
}

export function validateAgentManifest(
  manifest: AgentManifest,
): AgentValidationIssue[] {
  const issues: AgentValidationIssue[] = [];

  if (manifest.kind !== "anvil.agent") {
    issues.push({
      code: "AGENT_MANIFEST_INVALID",
      severity: "error",
      message: "Agent manifest kind must be 'anvil.agent'.",
    });
  }

  if (!manifest.model.provider || !manifest.model.model) {
    issues.push({
      code: "AGENT_MANIFEST_MODEL_INVALID",
      severity: "error",
      message: `Agent manifest '${manifest.name}' must include model provider and model id.`,
    });
  }

  return issues;
}

export class AgentProviderRegistry {
  private readonly providers = new Map<string, AgentInferenceProvider>();

  constructor(providers: AgentInferenceProvider[] = []) {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  register(provider: AgentInferenceProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(providerId: string): AgentInferenceProvider {
    const provider = this.providers.get(providerId);

    if (!provider) {
      throw new RuntimeError(
        "ADAPTER_ERROR",
        `No agent inference provider '${providerId}' is registered.`,
        500,
        { providerId },
      );
    }

    return provider;
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  list(): string[] {
    return [...this.providers.keys()].sort();
  }
}

export class LocalStubInferenceProvider implements AgentInferenceProvider {
  readonly id = "local";

  constructor(
    private readonly options: { echoInput?: boolean; response?: string } = {},
  ) {}

  async invoke(
    request: AgentInferenceRequest,
  ): Promise<AgentInferenceResponse> {
    const lastUserMessage = [...request.messages]
      .reverse()
      .find((message) => message.role === "user");
    const content =
      this.options.response ??
      (this.options.echoInput && lastUserMessage
        ? `Local stub response from Anvil Agent: ${messageText(lastUserMessage.content)}`
        : "Local stub response from Anvil Agent.");

    return {
      message: {
        role: "assistant",
        content,
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    };
  }
}

export class StaticAgentApprovalProvider implements AgentApprovalProvider {
  constructor(private readonly decision: AgentApprovalDecision) {}

  async requestApproval(): Promise<AgentApprovalDecision> {
    return this.decision;
  }
}

export function createAutoApproveApprovalProvider(
  approvedBy = "local",
): AgentApprovalProvider {
  return new StaticAgentApprovalProvider({ status: "approved", approvedBy });
}

export function createAutoRejectApprovalProvider(
  reason = "Rejected by local approval provider.",
): AgentApprovalProvider {
  return new StaticAgentApprovalProvider({ status: "rejected", reason });
}

export function createPendingApprovalProvider(
  approvalId = "local-pending",
): AgentApprovalProvider {
  return new StaticAgentApprovalProvider({ status: "pending", approvalId });
}

export class AgentRuntime {
  private readonly providers: AgentProviderRegistry;
  private readonly approvalProvider: AgentApprovalProvider;
  private readonly baseDir: string | undefined;

  constructor(
    options: {
      providers?: AgentProviderRegistry;
      approvalProvider?: AgentApprovalProvider;
      baseDir?: string;
    } = {},
  ) {
    this.providers = options.providers ?? new AgentProviderRegistry();
    this.approvalProvider =
      options.approvalProvider ?? createPendingApprovalProvider();
    this.baseDir = options.baseDir;
  }

  async invoke(
    agent: AgentDefinition,
    input: AgentRuntimeInvokeInput,
  ): Promise<AgentRuntimeInvokeResult> {
    return runAgentRuntimeEffect(this.invokeEffect(agent, input));
  }

  async invokeSubagent(
    parent: AgentDefinition,
    mount: string,
    input: AgentRuntimeInvokeInput,
  ): Promise<AgentRuntimeDelegationResult> {
    const subagent = parent.subagents?.[mount];

    if (!subagent) {
      throw new RuntimeError(
        "HANDLER_NOT_FOUND",
        `Agent '${parent.name}' does not declare subagent '${mount}'.`,
        404,
        { agent: parent.name, subagent: mount },
      );
    }

    const result = await this.invoke(subagent, {
      ...input,
      context: {
        ...(input.context ?? {}),
        parentAgentName: parent.name,
        subagentMount: mount,
      },
    });

    return {
      ...result,
      parentAgentName: parent.name,
      subagentMount: mount,
    };
  }

  private invokeEffect(
    agent: AgentDefinition,
    input: AgentRuntimeInvokeInput,
  ): Effect.Effect<AgentRuntimeInvokeResult, RuntimeError> {
    const validationOptions =
      this.baseDir === undefined ? {} : { baseDir: this.baseDir };

    return Effect.gen(this, function* () {
      const issues = yield* runtimeEffectFromPromise(() =>
        validateAgentDefinition(agent, validationOptions),
      );
      const errors = issues.filter((issue) => issue.severity === "error");

      if (errors.length > 0) {
        return yield* Effect.fail(
          new RuntimeError(
            "VALIDATION_ERROR",
            `Agent '${agent.name}' is not valid.`,
            400,
            { issues: errors },
          ),
        );
      }

      const provider = yield* runtimeEffectFromSync(() =>
        this.providers.get(agent.model.provider),
      );
      const instructions = yield* runtimeEffectFromPromise(() =>
        resolveInstructions(agent, this.baseDir),
      );
      const messages: AgentMessage[] = [];

      if (instructions.length > 0) {
        messages.push({
          role: "system",
          content: instructions,
        });
      }

      messages.push(...(input.messages ?? []));
      messages.push({
        role: "user",
        content: input.input,
      });

      const request: AgentInferenceRequest = {
        agentName: agent.name,
        model: agent.model,
        messages,
      };

      if (input.tools !== undefined) {
        request.tools = input.tools.map((tool) => tool.definition);
      }

      if (input.context !== undefined) {
        request.metadata = input.context;
      }

      const response = yield* runtimeEffectFromPromise(() =>
        provider.invoke(request),
      );
      const toolCalls = response.toolCalls ?? [];
      const approvalsRequired: AgentApprovalRequest[] = [];

      for (const call of toolCalls) {
        const tool = input.tools?.find(
          (candidate) => candidate.definition.name === call.name,
        );

        if (!tool) {
          continue;
        }

        const approval = yield* runtimeEffectFromPromise(() =>
          this.prepareToolExecution(agent, tool.definition),
        );

        if (approval) {
          approvalsRequired.push(approval);
        }
      }

      return {
        agentName: agent.name,
        response: response.message,
        toolCalls,
        approvalsRequired,
        usage: response.usage ?? {},
      };
    });
  }

  async executeTool(
    agent: AgentDefinition,
    tool: AgentToolExecutor,
    input: unknown,
    metadata?: Record<string, unknown>,
  ): Promise<AgentToolResult> {
    return runAgentRuntimeEffect(
      this.executeToolEffect(agent, tool, input, metadata),
    );
  }

  private executeToolEffect(
    agent: AgentDefinition,
    tool: AgentToolExecutor,
    input: unknown,
    metadata?: Record<string, unknown>,
  ): Effect.Effect<AgentToolResult, RuntimeError> {
    return Effect.gen(this, function* () {
      const approval = yield* runtimeEffectFromPromise(() =>
        this.prepareToolExecution(agent, tool.definition),
      );

      if (approval) {
        const decision = yield* runtimeEffectFromPromise(() =>
          this.approvalProvider.requestApproval(approval),
        );

        if (decision.status !== "approved") {
          return {
            ok: false,
            approval: decision,
            error: {
              code: "AGENT_APPROVAL_REQUIRED",
              message: `Action '${approval.action}' requires approval before execution.`,
            },
          };
        }
      }

      const context: AgentToolContext = {
        agentName: agent.name,
        capabilities: normalizeAgentCapabilities(agent.capabilities),
      };

      if (metadata !== undefined) {
        context.metadata = metadata;
      }

      return yield* runtimeEffectFromPromise(() =>
        tool.execute(input, context),
      );
    });
  }

  private async prepareToolExecution(
    agent: AgentDefinition,
    definition: AgentToolDefinition,
  ): Promise<AgentApprovalRequest | null> {
    for (const capability of definition.requiredCapabilities ?? []) {
      if (!agentHasCapability(agent, capability)) {
        throw new RuntimeError(
          "CAPABILITY_NOT_DECLARED",
          `Agent '${agent.name}' cannot execute tool '${definition.name}' because capability '${capability}' is not declared.`,
          403,
          { agent: agent.name, tool: definition.name, capability },
        );
      }
    }

    const action = definition.action ?? definition.name;

    if (agent.approvals?.requiredFor.includes(action)) {
      return {
        action,
        reason: `Agent '${agent.name}' requested approval-gated action '${action}'.`,
        metadata: {
          agent: agent.name,
          tool: definition.name,
        },
      };
    }

    return null;
  }
}

// Runs an agent-runtime effect at the Promise boundary. Expected failures
// (RuntimeError) and defects (anything else thrown inside the effect) are both
// rethrown as their original values so callers keep the pre-Effect contract.
async function runAgentRuntimeEffect<T>(
  effect: Effect.Effect<T, RuntimeError>,
): Promise<T> {
  const exit = await Effect.runPromiseExit(effect);

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  throw Cause.squash(exit.cause);
}

// RuntimeError is the agent runtime's expected failure channel. Anything else
// (provider/tool errors of unknown shape) is treated as a defect and preserved
// as-is by runAgentRuntimeEffect.
function runtimeEffectFromPromise<T>(
  run: () => Promise<T> | T,
): Effect.Effect<T, RuntimeError> {
  return Effect.tryPromise({
    try: async () => run(),
    catch: (error) => error,
  }).pipe(Effect.catchAll(failOrDie));
}

function runtimeEffectFromSync<T>(
  run: () => T,
): Effect.Effect<T, RuntimeError> {
  return Effect.try({
    try: run,
    catch: (error) => error,
  }).pipe(Effect.catchAll(failOrDie));
}

function failOrDie(error: unknown): Effect.Effect<never, RuntimeError> {
  return error instanceof RuntimeError ? Effect.fail(error) : Effect.die(error);
}

export async function resolveInstructions(
  agent: AgentDefinition,
  baseDir?: string,
): Promise<string> {
  if (!agent.instructions) {
    return "";
  }

  if (!isFileReference(agent.instructions)) {
    return agent.instructions;
  }

  return readTextFile(resolveAgentPath(agent.instructions, baseDir));
}

export function agentHasCapability(
  agent: AgentDefinition,
  capability: string,
): boolean {
  const capabilities = normalizeAgentCapabilities(agent.capabilities);
  const [group, ...rest] = capability.split(".");
  const value = rest.join(".");

  switch (group) {
    case "cells":
      return (
        capabilities.cells.includes(value) || capabilities.cells.includes("*")
      );
    case "database":
      return (
        capabilities.database.includes(value) ||
        capabilities.database.includes("*")
      );
    case "git":
      return capabilities.git.includes(value) || capabilities.git.includes("*");
    case "deployments":
      return (
        capabilities.deployments.includes(value) ||
        capabilities.deployments.includes("*")
      );
    case "filesystem":
      return capabilities.filesystem === value;
    case "secrets":
      return capabilities.secrets === value;
    case "network":
      return networkAllows(capabilities.network, value);
    default:
      return false;
  }
}

function sanitizeModelConfig(model: AgentModelConfig): AgentModelConfig {
  const sanitized: AgentModelConfig = {
    provider: model.provider,
    model: model.model,
  };

  if (model.region !== undefined) {
    sanitized.region = model.region;
  }

  if (model.options !== undefined) {
    sanitized.options = model.options;
  }

  return sanitized;
}

function validateCapabilities(
  agentName: string,
  capabilities: AgentCapabilities | undefined,
): AgentValidationIssue[] {
  if (capabilities === undefined) {
    return [];
  }

  if (!isObject(capabilities)) {
    return [
      {
        code: "AGENT_CAPABILITIES_INVALID",
        severity: "error",
        message: `Agent '${agentName}' capabilities must be an object.`,
        path: "capabilities",
      },
    ];
  }

  const issues: AgentValidationIssue[] = [];

  if (
    capabilities.filesystem !== undefined &&
    !["none", "read", "read-write"].includes(capabilities.filesystem)
  ) {
    issues.push({
      code: "AGENT_CAPABILITY_INVALID",
      severity: "error",
      message: `Agent '${agentName}' filesystem capability must be none, read, or read-write.`,
      path: "capabilities.filesystem",
    });
  }

  if (
    capabilities.secrets !== undefined &&
    !["none", "brokered", "read"].includes(capabilities.secrets)
  ) {
    issues.push({
      code: "AGENT_CAPABILITY_INVALID",
      severity: "error",
      message: `Agent '${agentName}' secrets capability must be none, brokered, or read.`,
      path: "capabilities.secrets",
    });
  }

  if (
    capabilities.network !== undefined &&
    capabilities.network !== "none" &&
    capabilities.network !== "restricted" &&
    !isObject(capabilities.network)
  ) {
    issues.push({
      code: "AGENT_CAPABILITY_INVALID",
      severity: "error",
      message: `Agent '${agentName}' network capability must be none, restricted, or an allow/deny object.`,
      path: "capabilities.network",
    });
  }

  return issues;
}

function validateApprovals(
  agentName: string,
  approvals: AgentApprovals | undefined,
): AgentValidationIssue[] {
  if (approvals === undefined) {
    return [];
  }

  if (
    !isObject(approvals) ||
    !Array.isArray(approvals.requiredFor) ||
    approvals.requiredFor.some((action) => typeof action !== "string")
  ) {
    return [
      {
        code: "AGENT_APPROVALS_INVALID",
        severity: "error",
        message: `Agent '${agentName}' approvals.requiredFor must be a string array.`,
        path: "approvals.requiredFor",
      },
    ];
  }

  return [];
}

function validateRuntimeRequirements(
  agentName: string,
  runtime: AgentRuntimeRequirements | undefined,
): AgentValidationIssue[] {
  if (runtime === undefined) {
    return [];
  }

  const issues: AgentValidationIssue[] = [];

  if (
    runtime.durability !== undefined &&
    !["none", "optional", "required"].includes(runtime.durability)
  ) {
    issues.push({
      code: "AGENT_RUNTIME_INVALID",
      severity: "error",
      message: `Agent '${agentName}' runtime.durability is invalid.`,
      path: "runtime.durability",
    });
  }

  if (
    runtime.sandbox !== undefined &&
    !["optional", "required"].includes(runtime.sandbox)
  ) {
    issues.push({
      code: "AGENT_RUNTIME_INVALID",
      severity: "error",
      message: `Agent '${agentName}' runtime.sandbox is invalid.`,
      path: "runtime.sandbox",
    });
  }

  if (
    runtime.humanApproval !== undefined &&
    !["optional", "required"].includes(runtime.humanApproval)
  ) {
    issues.push({
      code: "AGENT_RUNTIME_INVALID",
      severity: "error",
      message: `Agent '${agentName}' runtime.humanApproval is invalid.`,
      path: "runtime.humanApproval",
    });
  }

  return issues;
}

function validateSubagents(agent: AgentDefinition): AgentValidationIssue[] {
  const issues: AgentValidationIssue[] = [];

  if (agent.subagents !== undefined && !isObject(agent.subagents)) {
    issues.push({
      code: "AGENT_SUBAGENTS_INVALID",
      severity: "error",
      message: `Agent '${agent.name}' subagents must be an object mapping mount names to agent definitions.`,
      path: "subagents",
    });
    return issues;
  }

  const entries = Object.entries(agent.subagents ?? {});

  for (const [mount, subagent] of entries) {
    if (!isObject(subagent) || subagent.kind !== "agent") {
      issues.push({
        code: "AGENT_SUBAGENT_INVALID",
        severity: "error",
        message: `Subagent '${mount}' on agent '${agent.name}' must be created with defineAgent().`,
        path: `subagents.${mount}`,
      });
      continue;
    }

    for (const issue of validateAgentDefinitionShape(subagent, {
      includeSubagents: false,
    })) {
      issues.push({
        ...issue,
        path: issue.path
          ? `subagents.${mount}.${issue.path}`
          : `subagents.${mount}`,
      });
    }

    if (Object.keys(subagent.subagents ?? {}).length > 0) {
      issues.push({
        code: "AGENT_SUBAGENT_NESTING_UNSUPPORTED",
        severity: "error",
        message: `Subagent '${subagent.name}' cannot declare nested subagents during alpha.`,
        path: `subagents.${mount}.subagents`,
      });
    }

    if (!capabilitiesAreSubset(agent.capabilities, subagent.capabilities)) {
      issues.push({
        code: "AGENT_SUBAGENT_CAPABILITY_ESCALATION",
        severity: "error",
        message: `Subagent '${subagent.name}' declares capabilities outside parent agent '${agent.name}'.`,
        path: `subagents.${mount}.capabilities`,
      });
    }
  }

  return issues;
}

function capabilitiesAreSubset(
  parent: AgentCapabilities | undefined,
  child: AgentCapabilities | undefined,
): boolean {
  const parentCapabilities = normalizeAgentCapabilities(parent);
  const childCapabilities = normalizeAgentCapabilities(child);

  return (
    stringListIsSubset(parentCapabilities.cells, childCapabilities.cells) &&
    stringListIsSubset(
      parentCapabilities.database,
      childCapabilities.database,
    ) &&
    stringListIsSubset(parentCapabilities.git, childCapabilities.git) &&
    stringListIsSubset(
      parentCapabilities.deployments,
      childCapabilities.deployments,
    ) &&
    filesystemLevel(childCapabilities.filesystem) <=
      filesystemLevel(parentCapabilities.filesystem) &&
    secretsLevel(childCapabilities.secrets) <=
      secretsLevel(parentCapabilities.secrets) &&
    networkIsSubset(parentCapabilities.network, childCapabilities.network)
  );
}

function stringListIsSubset(parent: string[], child: string[]): boolean {
  return child.every((value) => parent.includes("*") || parent.includes(value));
}

function filesystemLevel(value: "none" | "read" | "read-write"): number {
  return { none: 0, read: 1, "read-write": 2 }[value];
}

function secretsLevel(value: "none" | "brokered" | "read"): number {
  return { none: 0, brokered: 1, read: 2 }[value];
}

function networkIsSubset(
  parent: AgentNetworkCapability,
  child: AgentNetworkCapability,
): boolean {
  if (child === "none") {
    return true;
  }

  if (parent === "none") {
    return false;
  }

  if (child === "restricted") {
    return parent === "restricted" || isObject(parent);
  }

  if (parent === "restricted") {
    return false;
  }

  if (!isObject(parent)) {
    return false;
  }

  const parentAllow = parent.allow ?? [];
  const childAllow = child.allow ?? [];
  const childDeny = child.deny ?? [];

  return (
    childAllow.every((host) => parentAllow.includes(host)) &&
    childDeny.every((host) => typeof host === "string")
  );
}

function networkAllows(network: AgentNetworkCapability, host: string): boolean {
  if (network === "none") {
    return false;
  }

  if (network === "restricted") {
    return false;
  }

  if (network.deny?.includes(host)) {
    return false;
  }

  return network.allow?.includes(host) ?? false;
}

function messageText(content: string | AgentContentPart[]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) =>
      part.type === "text" ? part.text : JSON.stringify(part.value),
    )
    .join("");
}

function isFileReference(value: string): boolean {
  return (
    value.startsWith("./") || value.startsWith("../") || value.endsWith(".md")
  );
}

function resolveAgentPath(
  filePath: string,
  baseDir = currentWorkingDirectory(),
): string {
  if (filePath.startsWith("/")) {
    return filePath;
  }

  const stack = [...baseDir.split("/"), ...filePath.split("/")];
  const resolved: string[] = [];

  for (const segment of stack) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment === "..") {
      resolved.pop();
      continue;
    }

    resolved.push(segment);
  }

  return `/${resolved.join("/")}`;
}

async function readTextFile(filePath: string): Promise<string> {
  // @ts-ignore Cell project typechecks may not install Node types.
  const fs = (await import("node:fs/promises")) as {
    readFile: (path: string, encoding: "utf8") => Promise<string>;
  };

  return fs.readFile(filePath, "utf8");
}

function currentWorkingDirectory(): string {
  const globalProcess = (globalThis as { process?: { cwd?: () => string } })
    .process;

  return globalProcess?.cwd?.() ?? "/";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
