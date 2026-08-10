import type {
  AgentExecutionApprovalDecision,
  AgentExecutionInputSubmission,
  AgentExecutionRequest,
} from "@anvil-cloud/runtime";

import {
  AgentExecutionControlPlaneError,
  type AgentExecutionControlPlaneApi,
  type AgentExecutionCursorBatch,
  type AgentExecutionLease,
} from "./execution.js";
import {
  AgentExecutionSnapshotStoreError,
  type AgentExecutionSnapshotStore,
  type AgentExecutionSnapshotUpload,
} from "./execution-snapshot-store.js";

export type AgentExecutionHttpRequest = {
  method: string;
  path: string;
  headers?: Record<string, string | undefined>;
  query?: URLSearchParams;
  body?: unknown;
};

export type AgentExecutionHttpResponse = {
  status: number;
  body: Record<string, unknown>;
};

export type AgentExecutionFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export type AgentExecutionHttpPrincipal = {
  subject: string;
  roles?: string[];
};

export type AgentExecutionHttpAction =
  | "create"
  | "list"
  | "read"
  | "events"
  | "approval"
  | "input"
  | "steer"
  | "suspend"
  | "resume"
  | "collect"
  | "terminate"
  | "reap"
  | "snapshot.create";

export type AgentExecutionHttpAuthorizationContext = {
  principal: AgentExecutionHttpPrincipal;
  action: AgentExecutionHttpAction;
  httpRequest: AgentExecutionHttpRequest;
  executionRequest?: AgentExecutionRequest;
  execution?: AgentExecutionLease;
  workspace?: string;
};

export type AgentExecutionHttpSecurity = {
  authenticate(
    request: AgentExecutionHttpRequest,
  ):
    | AgentExecutionHttpPrincipal
    | null
    | Promise<AgentExecutionHttpPrincipal | null>;
  authorize(
    context: AgentExecutionHttpAuthorizationContext,
  ): boolean | Promise<boolean>;
};

export type AgentExecutionHttpClientOptions = {
  fetch?: AgentExecutionFetch;
  headers?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>);
};

export type AgentExecutionHttpHandlerOptions = {
  snapshots?: AgentExecutionSnapshotStore;
};

export interface AgentExecutionSourceHttpClient {
  uploadSnapshot(
    input: AgentExecutionSnapshotUpload,
  ): Promise<Extract<AgentExecutionRequest["source"], { kind: "snapshot" }>>;
}

export class AgentExecutionHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AgentExecutionHttpError";
  }
}

class AgentExecutionHttpAccessError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code:
      | "EXECUTION_AUTHENTICATION_REQUIRED"
      | "EXECUTION_AUTHORIZATION_DENIED",
    message: string,
  ) {
    super(message);
    this.name = "AgentExecutionHttpAccessError";
  }
}

/**
 * Framework-neutral hosted API router. A server only needs to translate its
 * request into this small shape and serialize the returned body.
 */
export function createAgentExecutionHttpHandler(
  api: AgentExecutionControlPlaneApi,
  security: AgentExecutionHttpSecurity,
  options: AgentExecutionHttpHandlerOptions = {},
): (request: AgentExecutionHttpRequest) => Promise<AgentExecutionHttpResponse> {
  return async (request) => {
    try {
      if (
        options.snapshots &&
        request.method.toUpperCase() === "GET" &&
        request.path.startsWith("/v1/source-grants/")
      ) {
        return await consumeSourceGrant(options.snapshots, request);
      }

      const principal = await security.authenticate(request);

      if (!principal) {
        throw new AgentExecutionHttpAccessError(
          401,
          "EXECUTION_AUTHENTICATION_REQUIRED",
          "Execution control-plane authentication is required.",
        );
      }

      return await routeAgentExecutionRequest(
        api,
        security,
        principal,
        request,
        options,
      );
    } catch (error) {
      if (error instanceof AgentExecutionHttpAccessError) {
        return {
          status: error.status,
          body: {
            ok: false,
            error: { code: error.code, message: error.message },
          },
        };
      }
      if (error instanceof AgentExecutionControlPlaneError) {
        return {
          status: statusForControlPlaneError(error),
          body: {
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              details: error.details,
            },
          },
        };
      }
      if (error instanceof AgentExecutionSnapshotStoreError) {
        return {
          status: statusForSnapshotError(error),
          body: {
            ok: false,
            error: { code: error.code, message: error.message },
          },
        };
      }

      return {
        status: 500,
        body: {
          ok: false,
          error: {
            code: "EXECUTION_CONTROL_PLANE_ERROR",
            message: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }
  };
}

/** Creates the Desktop/CLI execution client for a hosted Anvil control plane. */
export function createHttpAgentExecutionControlPlane(
  baseUrl: string,
  options: AgentExecutionHttpClientOptions = {},
): AgentExecutionControlPlaneApi {
  const base = trimTrailingCharacter(baseUrl, "/");
  const fetcher = options.fetch ?? (fetch as unknown as AgentExecutionFetch);

  async function request(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<Record<string, unknown>> {
    let response: Awaited<ReturnType<AgentExecutionFetch>>;

    try {
      const requestHeaders =
        typeof options.headers === "function"
          ? await options.headers()
          : (options.headers ?? {});
      response = await fetcher(`${base}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          ...requestHeaders,
          "content-type": "application/json",
        },
        ...(init?.body === undefined
          ? {}
          : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      throw new AgentExecutionHttpError(
        "EXECUTION_CONTROL_PLANE_UNREACHABLE",
        `Could not reach the execution control plane at ${base}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        0,
      );
    }

    const payload = (await response.json().catch(() => ({}))) as unknown;
    const record = isObject(payload) ? payload : {};

    if (!response.ok) {
      const error = isObject(record.error) ? record.error : {};

      throw new AgentExecutionHttpError(
        typeof error.code === "string"
          ? error.code
          : "EXECUTION_CONTROL_PLANE_ERROR",
        typeof error.message === "string"
          ? error.message
          : `Execution request failed with status ${response.status}.`,
        response.status,
        isObject(error.details) ? error.details : {},
      );
    }

    return record;
  }

  return {
    async createExecution(input) {
      const payload = await request("/v1/executions", {
        method: "POST",
        body: input,
      });

      return readLease(payload);
    },
    async getExecution(executionId) {
      return readLease(
        await request(`/v1/executions/${encodeURIComponent(executionId)}`),
      );
    },
    async listExecutions() {
      const payload = await request("/v1/executions");

      return Array.isArray(payload.executions)
        ? (payload.executions as AgentExecutionLease[])
        : [];
    },
    async streamEvents(executionId, cursor, limit) {
      const query = new URLSearchParams();

      if (cursor !== undefined) {
        query.set("cursor", cursor);
      }
      if (limit !== undefined) {
        query.set("limit", String(limit));
      }

      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      const payload = await request(
        `/v1/executions/${encodeURIComponent(executionId)}/events${suffix}`,
      );

      return payload.batch as AgentExecutionCursorBatch;
    },
    async resolveApproval(executionId, decision) {
      return readLease(
        await request(
          `/v1/executions/${encodeURIComponent(executionId)}/approval`,
          { method: "POST", body: decision },
        ),
      );
    },
    async submitInput(executionId, input) {
      return readLease(
        await request(
          `/v1/executions/${encodeURIComponent(executionId)}/input`,
          {
            method: "POST",
            body: input,
          },
        ),
      );
    },
    async steer(executionId, message) {
      return readLease(
        await request(
          `/v1/executions/${encodeURIComponent(executionId)}/steer`,
          {
            method: "POST",
            body: { message },
          },
        ),
      );
    },
    async suspend(executionId) {
      return readLease(
        await request(
          `/v1/executions/${encodeURIComponent(executionId)}/suspend`,
          { method: "POST" },
        ),
      );
    },
    async resume(executionId) {
      return readLease(
        await request(
          `/v1/executions/${encodeURIComponent(executionId)}/resume`,
          {
            method: "POST",
          },
        ),
      );
    },
    async collectResult(executionId) {
      return readLease(
        await request(
          `/v1/executions/${encodeURIComponent(executionId)}/collect`,
          { method: "POST" },
        ),
      );
    },
    async terminate(executionId) {
      return readLease(
        await request(
          `/v1/executions/${encodeURIComponent(executionId)}/terminate`,
          { method: "POST" },
        ),
      );
    },
    async reapExpired() {
      const payload = await request("/v1/executions/reap", { method: "POST" });

      return Array.isArray(payload.executions)
        ? (payload.executions as AgentExecutionLease[])
        : [];
    },
  };
}

/** Uploads immutable execution snapshots without exposing storage details. */
export function createHttpAgentExecutionSourceClient(
  baseUrl: string,
  options: AgentExecutionHttpClientOptions = {},
): AgentExecutionSourceHttpClient {
  const base = trimTrailingCharacter(baseUrl, "/");
  const fetcher = options.fetch ?? (fetch as unknown as AgentExecutionFetch);

  return {
    async uploadSnapshot(input) {
      const requestHeaders =
        typeof options.headers === "function"
          ? await options.headers()
          : (options.headers ?? {});
      let response: Awaited<ReturnType<AgentExecutionFetch>>;

      try {
        response = await fetcher(`${base}/v1/source-snapshots`, {
          method: "POST",
          headers: {
            ...requestHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            workspace: input.workspace,
            baseCommit: input.baseCommit,
            archiveBase64: Buffer.from(input.archive).toString("base64"),
            ...(input.repository === undefined
              ? {}
              : { repository: input.repository }),
            ...(input.branch === undefined ? {} : { branch: input.branch }),
            ...(input.workingTreePatch === undefined
              ? {}
              : {
                  workingTreePatchBase64: Buffer.from(
                    input.workingTreePatch,
                  ).toString("base64"),
                }),
          }),
        });
      } catch (error) {
        throw new AgentExecutionHttpError(
          "EXECUTION_CONTROL_PLANE_UNREACHABLE",
          `Could not reach the execution control plane at ${base}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          0,
        );
      }

      const payload = (await response.json().catch(() => ({}))) as unknown;
      const record = isObject(payload) ? payload : {};
      if (!response.ok) {
        const error = isObject(record.error) ? record.error : {};
        throw new AgentExecutionHttpError(
          typeof error.code === "string"
            ? error.code
            : "EXECUTION_CONTROL_PLANE_ERROR",
          typeof error.message === "string"
            ? error.message
            : `Snapshot upload failed with status ${response.status}.`,
          response.status,
        );
      }
      if (!isObject(record.snapshot) || record.snapshot.kind !== "snapshot") {
        throw new AgentExecutionHttpError(
          "EXECUTION_CONTROL_PLANE_INVALID_RESPONSE",
          "Execution control plane returned no snapshot source.",
          response.status,
        );
      }

      return record.snapshot as Extract<
        AgentExecutionRequest["source"],
        { kind: "snapshot" }
      >;
    },
  };
}

async function routeAgentExecutionRequest(
  api: AgentExecutionControlPlaneApi,
  security: AgentExecutionHttpSecurity,
  principal: AgentExecutionHttpPrincipal,
  request: AgentExecutionHttpRequest,
  options: AgentExecutionHttpHandlerOptions,
): Promise<AgentExecutionHttpResponse> {
  const method = request.method.toUpperCase();

  if (request.path === "/v1/source-snapshots" && method === "POST") {
    if (!options.snapshots) {
      return notFound(request.path);
    }

    const upload = readSnapshotUpload(request.body);
    await requireAuthorization(security, {
      principal,
      action: "snapshot.create",
      httpRequest: request,
      workspace: upload.workspace,
    });
    const record = await options.snapshots.put(upload);

    return ok({ snapshot: record.source });
  }

  if (request.path === "/v1/executions" && method === "POST") {
    const executionRequest = request.body as AgentExecutionRequest;
    await requireAuthorization(security, {
      principal,
      action: "create",
      httpRequest: request,
      executionRequest,
    });

    return ok({
      execution: await api.createExecution(executionRequest),
    });
  }
  if (request.path === "/v1/executions" && method === "GET") {
    const executions: AgentExecutionLease[] = [];

    for (const execution of await api.listExecutions()) {
      if (
        await security.authorize({
          principal,
          action: "list",
          httpRequest: request,
          execution,
        })
      ) {
        executions.push(execution);
      }
    }

    return ok({ executions });
  }
  if (request.path === "/v1/executions/reap" && method === "POST") {
    await requireAuthorization(security, {
      principal,
      action: "reap",
      httpRequest: request,
    });

    return ok({ executions: await api.reapExpired() });
  }

  const parts = request.path.split("/");

  if (
    parts.length < 4 ||
    parts.length > 5 ||
    parts[0] !== "" ||
    parts[1] !== "v1" ||
    parts[2] !== "executions" ||
    !parts[3]
  ) {
    return notFound(request.path);
  }

  const executionId = decodePathSegment(parts[3]);
  const action = parts[4];

  if (!action && method === "GET") {
    const execution = await authorizedExecution(
      api,
      security,
      principal,
      request,
      executionId,
      "read",
    );

    return ok({ execution });
  }
  if (action === "events" && method === "GET") {
    await authorizedExecution(
      api,
      security,
      principal,
      request,
      executionId,
      "events",
    );
    const limitValue = request.query?.get("limit");
    const limit =
      limitValue === null || limitValue === undefined
        ? undefined
        : Number(limitValue);

    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw new AgentExecutionControlPlaneError(
        "EXECUTION_INVALID_REQUEST",
        `Execution event limit '${limitValue}' is invalid.`,
      );
    }

    return ok({
      batch: await api.streamEvents(
        executionId,
        request.query?.get("cursor") ?? undefined,
        limit,
      ),
    });
  }
  if (action === "approval" && method === "POST") {
    await authorizedExecution(
      api,
      security,
      principal,
      request,
      executionId,
      "approval",
    );
    return ok({
      execution: await api.resolveApproval(
        executionId,
        request.body as AgentExecutionApprovalDecision,
      ),
    });
  }
  if (action === "input" && method === "POST") {
    await authorizedExecution(
      api,
      security,
      principal,
      request,
      executionId,
      "input",
    );
    return ok({
      execution: await api.submitInput(
        executionId,
        request.body as AgentExecutionInputSubmission,
      ),
    });
  }
  if (action === "steer" && method === "POST") {
    await authorizedExecution(
      api,
      security,
      principal,
      request,
      executionId,
      "steer",
    );
    const body = isObject(request.body) ? request.body : {};

    return ok({
      execution: await api.steer(
        executionId,
        typeof body.message === "string" ? body.message : "",
      ),
    });
  }
  if (action === "suspend" && method === "POST") {
    await authorizedExecution(
      api,
      security,
      principal,
      request,
      executionId,
      "suspend",
    );
    return ok({ execution: await api.suspend(executionId) });
  }
  if (action === "resume" && method === "POST") {
    await authorizedExecution(
      api,
      security,
      principal,
      request,
      executionId,
      "resume",
    );
    return ok({ execution: await api.resume(executionId) });
  }
  if (action === "collect" && method === "POST") {
    await authorizedExecution(
      api,
      security,
      principal,
      request,
      executionId,
      "collect",
    );
    return ok({ execution: await api.collectResult(executionId) });
  }
  if (action === "terminate" && method === "POST") {
    await authorizedExecution(
      api,
      security,
      principal,
      request,
      executionId,
      "terminate",
    );
    return ok({ execution: await api.terminate(executionId) });
  }

  return notFound(request.path);
}

async function authorizedExecution(
  api: AgentExecutionControlPlaneApi,
  security: AgentExecutionHttpSecurity,
  principal: AgentExecutionHttpPrincipal,
  httpRequest: AgentExecutionHttpRequest,
  executionId: string,
  action: AgentExecutionHttpAction,
): Promise<AgentExecutionLease> {
  const execution = await api.getExecution(executionId);
  await requireAuthorization(security, {
    principal,
    action,
    httpRequest,
    execution,
  });

  return execution;
}

async function requireAuthorization(
  security: AgentExecutionHttpSecurity,
  context: AgentExecutionHttpAuthorizationContext,
): Promise<void> {
  if (!(await security.authorize(context))) {
    throw new AgentExecutionHttpAccessError(
      403,
      "EXECUTION_AUTHORIZATION_DENIED",
      "The authenticated principal cannot perform this execution action.",
    );
  }
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AgentExecutionControlPlaneError(
      "EXECUTION_INVALID_REQUEST",
      "Execution path contains invalid URL encoding.",
    );
  }
}

async function consumeSourceGrant(
  snapshots: AgentExecutionSnapshotStore,
  request: AgentExecutionHttpRequest,
): Promise<AgentExecutionHttpResponse> {
  const prefix = "/v1/source-grants/";
  const encodedGrantId = request.path.slice(prefix.length);
  if (encodedGrantId.length === 0 || encodedGrantId.includes("/")) {
    return notFound(request.path);
  }

  const authorization = readHeader(request.headers, "authorization");
  const executionId = readHeader(request.headers, "x-anvil-execution-id");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;

  if (!token || !executionId) {
    throw new AgentExecutionSnapshotStoreError(
      "EXECUTION_SNAPSHOT_GRANT_INVALID",
      "Snapshot grant authentication is required.",
    );
  }

  const download = await snapshots.consumeGrant({
    grantId: decodePathSegment(encodedGrantId),
    executionId,
    token,
  });

  return ok({
    snapshot: download.record.source,
    archiveBase64: Buffer.from(download.archive).toString("base64"),
    ...(download.workingTreePatch === undefined
      ? {}
      : {
          workingTreePatchBase64: Buffer.from(
            download.workingTreePatch,
          ).toString("base64"),
        }),
  });
}

function readSnapshotUpload(body: unknown): AgentExecutionSnapshotUpload {
  if (!isObject(body)) {
    throw new AgentExecutionSnapshotStoreError(
      "EXECUTION_SNAPSHOT_INVALID",
      "Snapshot upload body must be an object.",
    );
  }
  if (
    typeof body.workspace !== "string" ||
    typeof body.baseCommit !== "string" ||
    typeof body.archiveBase64 !== "string"
  ) {
    throw new AgentExecutionSnapshotStoreError(
      "EXECUTION_SNAPSHOT_INVALID",
      "Snapshot upload requires workspace, baseCommit, and archiveBase64.",
    );
  }
  if (body.repository !== undefined && typeof body.repository !== "string") {
    throw new AgentExecutionSnapshotStoreError(
      "EXECUTION_SNAPSHOT_INVALID",
      "Snapshot repository must be a string.",
    );
  }
  if (body.branch !== undefined && typeof body.branch !== "string") {
    throw new AgentExecutionSnapshotStoreError(
      "EXECUTION_SNAPSHOT_INVALID",
      "Snapshot branch must be a string.",
    );
  }
  if (
    body.workingTreePatchBase64 !== undefined &&
    typeof body.workingTreePatchBase64 !== "string"
  ) {
    throw new AgentExecutionSnapshotStoreError(
      "EXECUTION_SNAPSHOT_INVALID",
      "Snapshot working-tree patch must be base64 text.",
    );
  }

  return {
    workspace: body.workspace,
    baseCommit: body.baseCommit,
    archive: decodeBase64(body.archiveBase64, "snapshot archive"),
    ...(body.repository === undefined ? {} : { repository: body.repository }),
    ...(body.branch === undefined ? {} : { branch: body.branch }),
    ...(body.workingTreePatchBase64 === undefined
      ? {}
      : {
          workingTreePatch: decodeBase64(
            body.workingTreePatchBase64,
            "working-tree patch",
          ),
        }),
  };
}

function decodeBase64(value: string, label: string): Uint8Array {
  const decoded = Buffer.from(value, "base64");

  if (decoded.toString("base64") !== value) {
    throw new AgentExecutionSnapshotStoreError(
      "EXECUTION_SNAPSHOT_INVALID",
      `${label} must use canonical base64 encoding.`,
    );
  }

  return decoded;
}

function readHeader(
  headers: AgentExecutionHttpRequest["headers"],
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name) return value;
  }

  return undefined;
}

function readLease(payload: Record<string, unknown>): AgentExecutionLease {
  if (!isObject(payload.execution)) {
    throw new AgentExecutionHttpError(
      "EXECUTION_CONTROL_PLANE_INVALID_RESPONSE",
      "Execution control plane returned no execution lease.",
      502,
    );
  }

  return payload.execution as AgentExecutionLease;
}

function statusForControlPlaneError(
  error: AgentExecutionControlPlaneError,
): number {
  switch (error.code) {
    case "EXECUTION_NOT_FOUND":
      return 404;
    case "EXECUTION_INVALID_STATE":
    case "EXECUTION_IDEMPOTENCY_CONFLICT":
      return 409;
    case "EXECUTION_PROVIDER_NOT_FOUND":
    case "EXECUTION_PROVIDER_UNSUPPORTED":
      return 422;
    case "EXECUTION_START_FAILED":
      return 502;
    case "EXECUTION_INVALID_CURSOR":
    case "EXECUTION_INVALID_REQUEST":
      return 400;
  }
}

function statusForSnapshotError(
  error: AgentExecutionSnapshotStoreError,
): number {
  switch (error.code) {
    case "EXECUTION_SNAPSHOT_NOT_FOUND":
      return 404;
    case "EXECUTION_SNAPSHOT_TOO_LARGE":
      return 413;
    case "EXECUTION_SNAPSHOT_GRANT_USED":
      return 409;
    case "EXECUTION_SNAPSHOT_GRANT_EXPIRED":
      return 410;
    case "EXECUTION_SNAPSHOT_GRANT_INVALID":
      return 401;
    case "EXECUTION_SNAPSHOT_INVALID":
      return 400;
  }
}

function ok(body: Record<string, unknown>): AgentExecutionHttpResponse {
  return { status: 200, body: { ok: true, ...body } };
}

function notFound(path: string): AgentExecutionHttpResponse {
  return {
    status: 404,
    body: {
      ok: false,
      error: {
        code: "EXECUTION_ROUTE_NOT_FOUND",
        message: `No execution control-plane route matches '${path}'.`,
      },
    },
  };
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
