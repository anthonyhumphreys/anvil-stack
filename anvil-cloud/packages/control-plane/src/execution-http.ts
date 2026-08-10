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

export type AgentExecutionHttpRequest = {
  method: string;
  path: string;
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

/**
 * Framework-neutral hosted API router. A server only needs to translate its
 * request into this small shape and serialize the returned body.
 */
export function createAgentExecutionHttpHandler(
  api: AgentExecutionControlPlaneApi,
): (request: AgentExecutionHttpRequest) => Promise<AgentExecutionHttpResponse> {
  return async (request) => {
    try {
      return await routeAgentExecutionRequest(api, request);
    } catch (error) {
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
  fetchImpl?: AgentExecutionFetch,
): AgentExecutionControlPlaneApi {
  const base = baseUrl.replace(/\/+$/, "");
  const fetcher = fetchImpl ?? (fetch as unknown as AgentExecutionFetch);

  async function request(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<Record<string, unknown>> {
    let response: Awaited<ReturnType<AgentExecutionFetch>>;

    try {
      response = await fetcher(`${base}${path}`, {
        method: init?.method ?? "GET",
        headers: { "content-type": "application/json" },
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

async function routeAgentExecutionRequest(
  api: AgentExecutionControlPlaneApi,
  request: AgentExecutionHttpRequest,
): Promise<AgentExecutionHttpResponse> {
  const method = request.method.toUpperCase();

  if (request.path === "/v1/executions" && method === "POST") {
    return ok({
      execution: await api.createExecution(
        request.body as AgentExecutionRequest,
      ),
    });
  }
  if (request.path === "/v1/executions" && method === "GET") {
    return ok({ executions: await api.listExecutions() });
  }
  if (request.path === "/v1/executions/reap" && method === "POST") {
    return ok({ executions: await api.reapExpired() });
  }

  const match = request.path.match(
    /^\/v1\/executions\/([^/]+)(?:\/(events|approval|input|steer|suspend|resume|collect|terminate))?$/,
  );

  if (!match) {
    return notFound(request.path);
  }

  const executionId = decodeURIComponent(match[1] ?? "");
  const action = match[2];

  if (!action && method === "GET") {
    return ok({ execution: await api.getExecution(executionId) });
  }
  if (action === "events" && method === "GET") {
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
    return ok({
      execution: await api.resolveApproval(
        executionId,
        request.body as AgentExecutionApprovalDecision,
      ),
    });
  }
  if (action === "input" && method === "POST") {
    return ok({
      execution: await api.submitInput(
        executionId,
        request.body as AgentExecutionInputSubmission,
      ),
    });
  }
  if (action === "steer" && method === "POST") {
    const body = isObject(request.body) ? request.body : {};

    return ok({
      execution: await api.steer(
        executionId,
        typeof body.message === "string" ? body.message : "",
      ),
    });
  }
  if (action === "suspend" && method === "POST") {
    return ok({ execution: await api.suspend(executionId) });
  }
  if (action === "resume" && method === "POST") {
    return ok({ execution: await api.resume(executionId) });
  }
  if (action === "collect" && method === "POST") {
    return ok({ execution: await api.collectResult(executionId) });
  }
  if (action === "terminate" && method === "POST") {
    return ok({ execution: await api.terminate(executionId) });
  }

  return notFound(request.path);
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
