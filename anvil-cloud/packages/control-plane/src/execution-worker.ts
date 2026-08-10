import { createHash, timingSafeEqual } from "node:crypto";

import type {
  AgentExecutionApprovalDecision,
  AgentExecutionEventBatch,
  AgentExecutionInputSubmission,
  AgentExecutionProviderResult,
  AgentExecutionSource,
  AgentExecutionSourceAccess,
  AgentExecutionStartInput,
  AgentExecutionWorkspace,
} from "@anvil-cloud/runtime";

import type {
  AgentExecutionHttpRequest,
  AgentExecutionHttpResponse,
} from "./execution-http.js";

export type AgentExecutionWorkerWorkspaceMaterial = {
  executionId: string;
  source: AgentExecutionSource;
  archive?: Uint8Array;
  workingTreePatch?: Uint8Array;
};

/**
 * Provider-neutral execution engine behind a private sandbox HTTP boundary.
 * Source grant credentials are resolved by the boundary and never reach this
 * driver or any of its durable execution state.
 */
export interface AgentExecutionWorkerDriver {
  prepareWorkspace(
    input: AgentExecutionWorkerWorkspaceMaterial,
  ): Promise<AgentExecutionWorkspace>;
  startExecution(input: AgentExecutionStartInput): Promise<{ runId: string }>;
  readEvents(
    runId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<AgentExecutionEventBatch>;
  resolveApproval(
    runId: string,
    decision: AgentExecutionApprovalDecision,
  ): Promise<void>;
  submitInput(
    runId: string,
    input: AgentExecutionInputSubmission,
  ): Promise<void>;
  steer(runId: string, message: string): Promise<void>;
  collectResult(runId: string): Promise<AgentExecutionProviderResult>;
}

export type AgentExecutionWorkerFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export type AgentExecutionWorkerSecurity = {
  authenticate(request: AgentExecutionHttpRequest): boolean | Promise<boolean>;
};

export type AgentExecutionWorkerHandlerOptions = {
  fetch?: AgentExecutionWorkerFetch;
};

export class AgentExecutionWorkerError extends Error {
  constructor(
    readonly code:
      | "EXECUTION_WORKER_AUTHENTICATION_REQUIRED"
      | "EXECUTION_WORKER_INVALID_REQUEST"
      | "EXECUTION_WORKER_SOURCE_REQUIRED"
      | "EXECUTION_WORKER_SOURCE_UNREACHABLE"
      | "EXECUTION_WORKER_SOURCE_INVALID",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AgentExecutionWorkerError";
  }
}

/** Implements the private `/_anvil/execution/*` protocol used by sandboxes. */
export function createAgentExecutionWorkerHttpHandler(
  driver: AgentExecutionWorkerDriver,
  security: AgentExecutionWorkerSecurity,
  options: AgentExecutionWorkerHandlerOptions = {},
): (request: AgentExecutionHttpRequest) => Promise<AgentExecutionHttpResponse> {
  const sourceFetch =
    options.fetch ?? (fetch as unknown as AgentExecutionWorkerFetch);

  return async (request) => {
    try {
      if (!(await security.authenticate(request))) {
        throw new AgentExecutionWorkerError(
          "EXECUTION_WORKER_AUTHENTICATION_REQUIRED",
          "Sandbox execution authentication is required.",
          401,
        );
      }

      return await routeWorkerRequest(driver, sourceFetch, request);
    } catch (error) {
      if (error instanceof AgentExecutionWorkerError) {
        return {
          status: error.status,
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
            code: "EXECUTION_WORKER_ERROR",
            message: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }
  };
}

async function routeWorkerRequest(
  driver: AgentExecutionWorkerDriver,
  sourceFetch: AgentExecutionWorkerFetch,
  request: AgentExecutionHttpRequest,
): Promise<AgentExecutionHttpResponse> {
  const method = request.method.toUpperCase();
  const path = stripWorkerPrefix(request.path);

  if (path === "/workspace" && method === "POST") {
    const input = readWorkspaceInput(request.body);
    const material = await resolveWorkspaceMaterial(input, sourceFetch);

    return ok({ workspace: await driver.prepareWorkspace(material) });
  }

  if (path === "/runs" && method === "POST") {
    const input = readStartInput(request.body);
    const started = await driver.startExecution(input);

    if (started.runId.trim().length === 0) {
      throw invalidRequest("Execution driver returned an empty run id.");
    }

    return ok({ runId: started.runId });
  }

  const parts = path.split("/");
  if (
    parts.length < 3 ||
    parts.length > 5 ||
    parts[0] !== "" ||
    parts[1] !== "runs" ||
    !parts[2]
  ) {
    return notFound(request.path);
  }

  const runId = decodePathSegment(parts[2]);
  const action = parts[3];
  const requestId = parts[4] ? decodePathSegment(parts[4]) : undefined;

  if (action === "events" && !requestId && method === "GET") {
    const cursor = request.query?.get("cursor") ?? undefined;
    const limit = readLimit(request.query?.get("limit"));
    const batch = await driver.readEvents(runId, {
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    });

    return ok({
      events: batch.events,
      done: batch.done,
      ...(batch.cursor === undefined ? {} : { cursor: batch.cursor }),
    });
  }
  if (action === "approvals" && requestId && method === "POST") {
    const decision = request.body as AgentExecutionApprovalDecision;
    if (!isObject(decision) || decision.requestId !== requestId) {
      throw invalidRequest(
        "Approval request id must match the execution worker route.",
      );
    }
    await driver.resolveApproval(runId, decision);
    return ok({ accepted: true });
  }
  if (action === "input" && requestId && method === "POST") {
    const input = request.body as AgentExecutionInputSubmission;
    if (!isObject(input) || input.requestId !== requestId) {
      throw invalidRequest(
        "Input request id must match the execution worker route.",
      );
    }
    await driver.submitInput(runId, input);
    return ok({ accepted: true });
  }
  if (action === "steer" && !requestId && method === "POST") {
    const body = isObject(request.body) ? request.body : {};
    if (typeof body.message !== "string" || body.message.trim().length === 0) {
      throw invalidRequest("Execution steering requires a non-empty message.");
    }
    await driver.steer(runId, body.message);
    return ok({ accepted: true });
  }
  if (action === "result" && !requestId && method === "GET") {
    return ok({ result: await driver.collectResult(runId) });
  }

  return notFound(request.path);
}

function stripWorkerPrefix(path: string): string {
  const prefix = "/_anvil/execution";

  return path.startsWith(prefix) ? path.slice(prefix.length) || "/" : path;
}

function readWorkspaceInput(body: unknown): {
  executionId: string;
  source: AgentExecutionSource;
  access?: AgentExecutionSourceAccess;
} {
  if (
    !isObject(body) ||
    typeof body.executionId !== "string" ||
    !isObject(body.source)
  ) {
    throw invalidRequest(
      "Workspace preparation requires executionId and source.",
    );
  }

  return {
    executionId: body.executionId,
    source: body.source as AgentExecutionSource,
    ...(isObject(body.access)
      ? { access: body.access as AgentExecutionSourceAccess }
      : {}),
  };
}

function readStartInput(body: unknown): AgentExecutionStartInput {
  if (
    !isObject(body) ||
    typeof body.executionId !== "string" ||
    typeof body.task !== "string" ||
    !isObject(body.source) ||
    !isObject(body.policy) ||
    !isObject(body.modelAuth)
  ) {
    throw invalidRequest(
      "Execution start requires executionId, task, source, policy, and modelAuth.",
    );
  }

  return body as AgentExecutionStartInput;
}

async function resolveWorkspaceMaterial(
  input: {
    executionId: string;
    source: AgentExecutionSource;
    access?: AgentExecutionSourceAccess;
  },
  sourceFetch: AgentExecutionWorkerFetch,
): Promise<AgentExecutionWorkerWorkspaceMaterial> {
  if (input.source.kind === "git") {
    return { executionId: input.executionId, source: input.source };
  }
  if (!input.access) {
    throw new AgentExecutionWorkerError(
      "EXECUTION_WORKER_SOURCE_REQUIRED",
      "Snapshot workspace preparation requires a source grant.",
      400,
    );
  }

  validateSourceAccess(input.access);
  let response: Awaited<ReturnType<AgentExecutionWorkerFetch>>;

  try {
    response = await sourceFetch(input.access.endpoint, {
      method: "GET",
      headers: {
        authorization: `Bearer ${input.access.token}`,
        "x-anvil-execution-id": input.executionId,
      },
    });
  } catch (error) {
    throw new AgentExecutionWorkerError(
      "EXECUTION_WORKER_SOURCE_UNREACHABLE",
      `Could not fetch the execution source: ${
        error instanceof Error ? error.message : String(error)
      }`,
      502,
    );
  }

  const payload = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok || !isObject(payload)) {
    throw new AgentExecutionWorkerError(
      "EXECUTION_WORKER_SOURCE_UNREACHABLE",
      `Execution source grant returned status ${response.status}.`,
      502,
    );
  }
  if (typeof payload.archiveBase64 !== "string") {
    throw invalidSource("Execution source response contains no archive.");
  }

  const archive = decodeCanonicalBase64(payload.archiveBase64, "archive");
  verifyContent(
    archive,
    input.source.sha256,
    input.source.sizeBytes,
    "archive",
  );
  const workingTreePatch =
    typeof payload.workingTreePatchBase64 === "string"
      ? decodeCanonicalBase64(
          payload.workingTreePatchBase64,
          "working-tree patch",
        )
      : undefined;

  if (input.source.patch) {
    if (!workingTreePatch) {
      throw invalidSource(
        "Execution source response contains no declared patch.",
      );
    }
    verifyContent(
      workingTreePatch,
      input.source.patch.sha256,
      input.source.patch.sizeBytes,
      "working-tree patch",
    );
  } else if (workingTreePatch) {
    throw invalidSource(
      "Execution source response contains an undeclared patch.",
    );
  }

  return {
    executionId: input.executionId,
    source: input.source,
    archive,
    ...(workingTreePatch === undefined ? {} : { workingTreePatch }),
  };
}

function validateSourceAccess(access: AgentExecutionSourceAccess): void {
  let endpoint: URL;

  try {
    endpoint = new URL(access.endpoint);
  } catch {
    throw invalidSource("Execution source grant endpoint is invalid.");
  }
  if (
    access.kind !== "control-plane-grant" ||
    endpoint.protocol !== "https:" ||
    access.token.length < 16 ||
    access.token.length > 512 ||
    new Date(access.expiresAt).getTime() <= Date.now()
  ) {
    throw invalidSource("Execution source grant is invalid or expired.");
  }
}

function verifyContent(
  content: Uint8Array,
  expectedSha256: string,
  expectedSize: number,
  label: string,
): void {
  const actualSha256 = createHash("sha256").update(content).digest("hex");
  const actualBytes = Buffer.from(actualSha256, "hex");
  const expectedBytes = Buffer.from(expectedSha256, "hex");

  if (
    content.byteLength !== expectedSize ||
    actualBytes.byteLength !== expectedBytes.byteLength ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    throw invalidSource(`Execution source ${label} failed integrity checks.`);
  }
}

function readLimit(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw invalidRequest(`Execution event limit '${value}' is invalid.`);
  }

  return parsed;
}

function decodeCanonicalBase64(value: string, label: string): Uint8Array {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw invalidSource(`Execution source ${label} is not canonical base64.`);
  }

  return decoded;
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw invalidRequest(
      "Execution worker path contains invalid URL encoding.",
    );
  }
}

function invalidRequest(message: string): AgentExecutionWorkerError {
  return new AgentExecutionWorkerError(
    "EXECUTION_WORKER_INVALID_REQUEST",
    message,
    400,
  );
}

function invalidSource(message: string): AgentExecutionWorkerError {
  return new AgentExecutionWorkerError(
    "EXECUTION_WORKER_SOURCE_INVALID",
    message,
    400,
  );
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
        code: "EXECUTION_WORKER_ROUTE_NOT_FOUND",
        message: `No execution worker route matches '${path}'.`,
      },
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
