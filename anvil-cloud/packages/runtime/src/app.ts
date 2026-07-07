import type { RuntimeContext } from "./context.js";
import type { EndpointRuntimeRequest } from "./request.js";
import type { AgentDefinition } from "./agent.js";

export type MaybePromise<T> = T | Promise<T>;

export type HandlerKind =
  | "query"
  | "mutation"
  | "endpoint"
  | "job"
  | "workflow"
  | "service";

export type QueryHandler<TInput = unknown, TResult = unknown> = (
  ctx: RuntimeContext,
  input: TInput,
) => MaybePromise<TResult>;

export type MutationHandler<TInput = unknown, TResult = unknown> = (
  ctx: RuntimeContext,
  input: TInput,
) => MaybePromise<TResult>;

export type EndpointHandler<TResult = unknown> = (
  ctx: RuntimeContext,
  request: EndpointRuntimeRequest,
) => MaybePromise<TResult>;

export type JobHandler<TPayload = unknown, TResult = unknown> = (
  ctx: RuntimeContext,
  payload: TPayload,
) => MaybePromise<TResult>;

export type WorkflowState = {
  input: unknown;
  steps: Record<string, unknown>;
};

export type WorkflowStepHandler<TResult = unknown> = (
  ctx: RuntimeContext,
  state: WorkflowState,
) => MaybePromise<TResult>;

export type AuthRequirement =
  | "public"
  | "optional"
  | "required"
  | { roles: string[] };

export type FieldType = "boolean" | "text" | "userId";

export type FieldDefinition = {
  kind: "field";
  type: FieldType;
  constraints: Record<string, unknown>;
};

export type QueryDefinition<TInput = unknown, TResult = unknown> = {
  kind: "query";
  input?: unknown;
  auth?: AuthRequirement;
  handler: QueryHandler<TInput, TResult>;
};

export type MutationDefinition<TInput = unknown, TResult = unknown> = {
  kind: "mutation";
  input?: unknown;
  auth?: AuthRequirement;
  handler: MutationHandler<TInput, TResult>;
};

export type EndpointDefinition<TResult = unknown> = {
  kind: "endpoint";
  method: string;
  path: string;
  auth?: "none" | AuthRequirement;
  agent?: string;
  handler: EndpointHandler<TResult>;
};

export type JobDefinition<TPayload = unknown, TResult = unknown> = {
  kind: "job";
  schedule?: string;
  overlap?: "skip" | "queue";
  timeoutMs?: number;
  handler: JobHandler<TPayload, TResult>;
};

export type WorkflowStepDefinition<TResult = unknown> = {
  name: string;
  handler: WorkflowStepHandler<TResult>;
  retries?: number;
  timeoutMs?: number;
};

export type WorkflowDefinition = {
  kind: "workflow";
  steps: Array<WorkflowStepDefinition<any>>;
  agent?: string;
  trigger?: string;
};

export type ServiceRestartPolicy = "always" | "on-failure" | "never";

export type ServiceControls = {
  signal: AbortSignal;
  stopping: () => boolean;
};

export type ServiceHandler = (
  ctx: RuntimeContext,
  controls: ServiceControls,
) => MaybePromise<void>;

export type ServiceDefinition = {
  kind: "service";
  restart?: ServiceRestartPolicy;
  maxRestarts?: number;
  handler: ServiceHandler;
};

export type ChannelProvider = "discord" | "github" | "slack";

export type ChannelSessionKey =
  | "channel"
  | "thread"
  | "sender"
  | "sender-thread";

export type ChannelDefinition = {
  kind: "channel";
  provider: ChannelProvider;
  agent: string;
  sessionKey?: ChannelSessionKey;
  events?: string[];
};

export type AnyQueryDefinition = QueryDefinition<any, any>;
export type AnyMutationDefinition = MutationDefinition<any, any>;
export type AnyEndpointDefinition = EndpointDefinition<any>;
export type AnyJobDefinition = JobDefinition<any, any>;
export type AnyWorkflowDefinition = WorkflowDefinition;
export type AnyServiceDefinition = ServiceDefinition;
export type AnyChannelDefinition = ChannelDefinition;

export type TableDefinition<
  TFields extends Record<string, unknown> = Record<string, unknown>,
> = {
  kind: "table";
  fields: TFields;
};

export type FieldBuilder = FieldDefinition & {
  min: (value: number) => FieldBuilder;
  max: (value: number) => FieldBuilder;
  default: (value: unknown) => FieldBuilder;
  optional: () => FieldBuilder;
};

export type AppDefinition = {
  schema?: Record<string, TableDefinition>;
  capabilities?: Record<string, unknown>;
  agents?: Record<string, AgentDefinition>;
  queries?: Record<string, AnyQueryDefinition>;
  mutations?: Record<string, AnyMutationDefinition>;
  endpoints?: Record<string, AnyEndpointDefinition>;
  jobs?: Record<string, AnyJobDefinition>;
  workflows?: Record<string, AnyWorkflowDefinition>;
  services?: Record<string, AnyServiceDefinition>;
  channels?: Record<string, AnyChannelDefinition>;
};

export type AppDefinitionInput = {
  schema?: Record<string, TableDefinition>;
  capabilities?: Record<string, unknown>;
  agents?: Record<string, AgentDefinition>;
  queries?: Record<string, AnyQueryDefinition>;
  mutations?: Record<string, AnyMutationDefinition>;
  endpoints?: Record<string, AnyEndpointDefinition>;
  jobs?: Record<string, AnyJobDefinition>;
  workflows?: Record<string, AnyWorkflowDefinition>;
  services?: Record<string, AnyServiceDefinition>;
  channels?: Record<string, AnyChannelDefinition>;
};

export function app(definition: AppDefinitionInput): AppDefinition {
  return {
    schema: definition.schema ?? {},
    capabilities: definition.capabilities ?? {},
    agents: definition.agents ?? {},
    queries: definition.queries ?? {},
    mutations: definition.mutations ?? {},
    endpoints: definition.endpoints ?? {},
    jobs: definition.jobs ?? {},
    workflows: definition.workflows ?? {},
    services: definition.services ?? {},
    channels: definition.channels ?? {},
  };
}

export function query<TInput = unknown, TResult = unknown>(
  definition: Omit<QueryDefinition<TInput, TResult>, "kind">,
): QueryDefinition<TInput, TResult> {
  return {
    ...definition,
    kind: "query",
  };
}

export function mutation<TInput = unknown, TResult = unknown>(
  definition: Omit<MutationDefinition<TInput, TResult>, "kind">,
): MutationDefinition<TInput, TResult> {
  return {
    ...definition,
    kind: "mutation",
  };
}

export function endpoint<TResult = unknown>(
  definition: Omit<EndpointDefinition<TResult>, "kind">,
): EndpointDefinition<TResult> {
  return {
    ...definition,
    method: definition.method.toUpperCase(),
    kind: "endpoint",
  };
}

export function job<TPayload = unknown, TResult = unknown>(
  definition: Omit<JobDefinition<TPayload, TResult>, "kind">,
): JobDefinition<TPayload, TResult> {
  return {
    ...definition,
    kind: "job",
  };
}

export function workflow(
  definition: Omit<WorkflowDefinition, "kind">,
): WorkflowDefinition {
  return {
    ...definition,
    kind: "workflow",
  };
}

export function service(
  definition: Omit<ServiceDefinition, "kind">,
): ServiceDefinition {
  return {
    ...definition,
    kind: "service",
  };
}

export function channel(
  definition: Omit<ChannelDefinition, "kind">,
): ChannelDefinition {
  return {
    ...definition,
    kind: "channel",
  };
}

export function table<TFields extends Record<string, unknown>>(
  fields: TFields,
): TableDefinition<TFields> {
  return {
    kind: "table",
    fields,
  };
}

export function text(): FieldBuilder {
  return createFieldBuilder("text");
}

export function boolean(): FieldBuilder {
  return createFieldBuilder("boolean");
}

export function userId(): FieldBuilder {
  return createFieldBuilder("userId");
}

function createFieldBuilder(
  type: FieldType,
  constraints: Record<string, unknown> = {},
): FieldBuilder {
  return {
    kind: "field",
    type,
    constraints,
    min(value) {
      return createFieldBuilder(type, { ...constraints, min: value });
    },
    max(value) {
      return createFieldBuilder(type, { ...constraints, max: value });
    },
    default(value) {
      return createFieldBuilder(type, { ...constraints, default: value });
    },
    optional() {
      return createFieldBuilder(type, { ...constraints, optional: true });
    },
  };
}
