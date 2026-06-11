import type { RuntimeContext } from "./context.js";
import type { EndpointRuntimeRequest } from "./request.js";

export type MaybePromise<T> = T | Promise<T>;

export type HandlerKind = "query" | "mutation" | "endpoint" | "job";

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

export type FieldType = "boolean" | "text" | "userId";

export type FieldDefinition = {
  kind: "field";
  type: FieldType;
  constraints: Record<string, unknown>;
};

export type QueryDefinition<TInput = unknown, TResult = unknown> = {
  kind: "query";
  input?: unknown;
  handler: QueryHandler<TInput, TResult>;
};

export type MutationDefinition<TInput = unknown, TResult = unknown> = {
  kind: "mutation";
  input?: unknown;
  handler: MutationHandler<TInput, TResult>;
};

export type EndpointDefinition<TResult = unknown> = {
  kind: "endpoint";
  method: string;
  path: string;
  auth?: "none" | "optional" | "required";
  handler: EndpointHandler<TResult>;
};

export type JobDefinition<TPayload = unknown, TResult = unknown> = {
  kind: "job";
  schedule?: string;
  handler: JobHandler<TPayload, TResult>;
};

export type AnyQueryDefinition = QueryDefinition<any, any>;
export type AnyMutationDefinition = MutationDefinition<any, any>;
export type AnyEndpointDefinition = EndpointDefinition<any>;
export type AnyJobDefinition = JobDefinition<any, any>;

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
  queries?: Record<string, AnyQueryDefinition>;
  mutations?: Record<string, AnyMutationDefinition>;
  endpoints?: Record<string, AnyEndpointDefinition>;
  jobs?: Record<string, AnyJobDefinition>;
};

export type AppDefinitionInput = {
  schema?: Record<string, TableDefinition>;
  capabilities?: Record<string, unknown>;
  queries?: Record<string, AnyQueryDefinition>;
  mutations?: Record<string, AnyMutationDefinition>;
  endpoints?: Record<string, AnyEndpointDefinition>;
  jobs?: Record<string, AnyJobDefinition>;
};

export function app(definition: AppDefinitionInput): AppDefinition {
  return {
    schema: definition.schema ?? {},
    capabilities: definition.capabilities ?? {},
    queries: definition.queries ?? {},
    mutations: definition.mutations ?? {},
    endpoints: definition.endpoints ?? {},
    jobs: definition.jobs ?? {},
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
