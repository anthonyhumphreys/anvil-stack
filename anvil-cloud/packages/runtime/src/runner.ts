import type {
  AppDefinition,
  EndpointDefinition,
  JobDefinition,
  MutationDefinition,
  QueryDefinition,
} from "./app.js";
import {
  enforceAuthRequirement,
  normaliseAuthRequirement,
  type AuthPolicyInspection,
} from "./auth-policy.js";
import { createRuntimeContext } from "./context.js";
import { handlerNotFound, normaliseRuntimeError } from "./errors.js";
import type { RuntimeHost } from "./host.js";
import type {
  EndpointRuntimeRequest,
  JobRuntimeRequest,
  MutationRuntimeRequest,
  QueryRuntimeRequest,
  RuntimeRequest,
  RuntimeResponse,
  WorkflowRuntimeRequest,
} from "./request.js";

const jsonHeaders = {
  "content-type": "application/json",
};

export async function handleRuntimeRequest(
  app: AppDefinition,
  host: RuntimeHost,
  request: RuntimeRequest,
): Promise<RuntimeResponse> {
  try {
    switch (request.kind) {
      case "query":
        return await handleQuery(app, host, request);
      case "mutation":
        return await handleMutation(app, host, request);
      case "endpoint":
        return await handleEndpoint(app, host, request);
      case "job":
        return await handleJob(app, host, request);
      case "workflow":
        return await handleWorkflow(app, host, request);
      case "service":
        return errorResponse(400, {
          code: "VALIDATION_ERROR",
          message:
            "Services are long-running and supervised; they cannot be invoked as runtime requests.",
        });
    }
  } catch (error) {
    const runtimeError = normaliseRuntimeError(error);

    return errorResponse(runtimeError.status, runtimeError.toPayload());
  }
}

async function handleQuery(
  app: AppDefinition,
  host: RuntimeHost,
  request: QueryRuntimeRequest,
): Promise<RuntimeResponse> {
  const definition = app.queries?.[request.name];

  if (!definition) {
    return errorResponseFromThrown(handlerNotFound("query", request.name));
  }

  return runHandler(
    host,
    request,
    request.name,
    definition,
    () => request.input,
    normaliseAuthRequirement(definition.auth, "optional"),
  );
}

async function handleMutation(
  app: AppDefinition,
  host: RuntimeHost,
  request: MutationRuntimeRequest,
): Promise<RuntimeResponse> {
  const definition = app.mutations?.[request.name];

  if (!definition) {
    return errorResponseFromThrown(handlerNotFound("mutation", request.name));
  }

  return runHandler(
    host,
    request,
    request.name,
    definition,
    () => request.input,
    normaliseAuthRequirement(definition.auth, "optional"),
  );
}

async function handleEndpoint(
  app: AppDefinition,
  host: RuntimeHost,
  request: EndpointRuntimeRequest,
): Promise<RuntimeResponse> {
  const method = request.method.toUpperCase();
  const match = Object.entries(app.endpoints ?? {}).find(
    ([_name, definition]) => {
      return (
        definition.method.toUpperCase() === method &&
        definition.path === request.path
      );
    },
  );

  if (!match) {
    return errorResponseFromThrown(
      handlerNotFound("endpoint", `${method} ${request.path}`),
    );
  }

  const [name, definition] = match;

  return runHandler(
    host,
    request,
    name,
    definition,
    () => request,
    normaliseAuthRequirement(definition.auth, "required"),
  );
}

async function handleJob(
  app: AppDefinition,
  host: RuntimeHost,
  request: JobRuntimeRequest,
): Promise<RuntimeResponse> {
  const definition = app.jobs?.[request.name];

  if (!definition) {
    return errorResponseFromThrown(handlerNotFound("job", request.name));
  }

  return runHandler(
    host,
    request,
    request.name,
    definition,
    () => request.payload,
    { access: "public" },
  );
}

async function handleWorkflow(
  app: AppDefinition,
  host: RuntimeHost,
  request: WorkflowRuntimeRequest,
): Promise<RuntimeResponse> {
  const definition = app.workflows?.[request.name];

  if (!definition) {
    return errorResponseFromThrown(handlerNotFound("workflow", request.name));
  }

  try {
    const started = await host.workflows.start(request.name, request.input);

    return successResponse(started);
  } catch (error) {
    const runtimeError = normaliseRuntimeError(error);

    await writeRuntimeErrorLog(
      host,
      request,
      request.name,
      runtimeError.toPayload(),
    );

    return errorResponse(runtimeError.status, runtimeError.toPayload());
  }
}

async function runHandler(
  host: RuntimeHost,
  request: QueryRuntimeRequest,
  name: string,
  definition: QueryDefinition,
  getInput: () => unknown,
  authPolicy: AuthPolicyInspection,
): Promise<RuntimeResponse>;
async function runHandler(
  host: RuntimeHost,
  request: MutationRuntimeRequest,
  name: string,
  definition: MutationDefinition,
  getInput: () => unknown,
  authPolicy: AuthPolicyInspection,
): Promise<RuntimeResponse>;
async function runHandler(
  host: RuntimeHost,
  request: EndpointRuntimeRequest,
  name: string,
  definition: EndpointDefinition,
  getInput: () => EndpointRuntimeRequest,
  authPolicy: AuthPolicyInspection,
): Promise<RuntimeResponse>;
async function runHandler(
  host: RuntimeHost,
  request: JobRuntimeRequest,
  name: string,
  definition: JobDefinition,
  getInput: () => unknown,
  authPolicy: AuthPolicyInspection,
): Promise<RuntimeResponse>;
async function runHandler(
  host: RuntimeHost,
  request: RuntimeRequest,
  name: string,
  definition:
    | QueryDefinition
    | MutationDefinition
    | EndpointDefinition
    | JobDefinition,
  getInput: () => unknown,
  authPolicy: AuthPolicyInspection,
): Promise<RuntimeResponse> {
  try {
    const ctx = await createRuntimeContext(host, request, name);

    enforceAuthRequirement(authPolicy, ctx.auth.identity);

    const result = await definition.handler(ctx, getInput() as never);

    return successResponse(result);
  } catch (error) {
    const runtimeError = normaliseRuntimeError(error);

    await writeRuntimeErrorLog(host, request, name, runtimeError.toPayload());

    return errorResponse(runtimeError.status, runtimeError.toPayload());
  }
}

async function writeRuntimeErrorLog(
  host: RuntimeHost,
  request: RuntimeRequest,
  handler: string,
  error: { code: string; message: string },
): Promise<void> {
  await host.logs.write({
    timestamp: new Date().toISOString(),
    level: "error",
    requestId: request.requestId,
    kind: request.kind,
    handler,
    message: error.message,
    meta: {
      code: error.code,
    },
  });
}

function successResponse(body: unknown): RuntimeResponse {
  return {
    ok: true,
    status: 200,
    headers: jsonHeaders,
    body,
  };
}

function errorResponseFromThrown(
  error: ReturnType<typeof handlerNotFound>,
): RuntimeResponse {
  return errorResponse(error.status, error.toPayload());
}

function errorResponse(
  status: number,
  error: NonNullable<RuntimeResponse["error"]>,
): RuntimeResponse {
  return {
    ok: false,
    status,
    headers: jsonHeaders,
    body: {
      error,
    },
    error,
  };
}
