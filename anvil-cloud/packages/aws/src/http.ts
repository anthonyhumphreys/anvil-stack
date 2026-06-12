import { randomUUID } from "node:crypto";

import { AuthError } from "@anvil-cloud/auth";
import {
  handleRuntimeRequest,
  type AppDefinition,
  type AuthIdentity,
  type RuntimeHost,
  type RuntimeRequest,
  type RuntimeResponse,
} from "@anvil-cloud/runtime";

export type AwsHttpEvent = {
  version?: string;
  routeKey?: string;
  rawPath?: string;
  path?: string;
  httpMethod?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    requestId?: string;
    http?: {
      method?: string;
      path?: string;
    };
    authorizer?: {
      anvil?: AuthIdentity;
      jwt?: {
        claims?: Record<string, unknown>;
      };
    };
  };
};

export type AwsHttpResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
};

export type AwsRuntimeHandler = (
  event: AwsHttpEvent,
) => Promise<AwsHttpResponse>;

export type AwsRuntimeHandlerOptions = {
  allowBodyIdentity?: boolean;
};

export function createAwsRuntimeHandler(
  app: AppDefinition,
  host: RuntimeHost,
  options: AwsRuntimeHandlerOptions = {},
): AwsRuntimeHandler {
  return async (event) => {
    const requestId = requestIdFrom(event);

    if (httpMethodFrom(event) === "OPTIONS") {
      return corsPreflightResponse();
    }

    if (
      httpMethodFrom(event) === "GET" &&
      pathFrom(event) === "/_anvil/health"
    ) {
      return healthResponse(requestId);
    }

    let resolvedAuth: AuthIdentity | null | undefined;
    const token = bearerTokenFrom(event);

    if (token && host.auth.verifyToken) {
      try {
        resolvedAuth = await host.auth.verifyToken(token);
      } catch (error) {
        return authErrorToAwsHttpResponse(error, requestId);
      }
    }

    let request: RuntimeRequest;

    try {
      request = awsHttpEventToRuntimeRequest(event, {
        ...(resolvedAuth != null ? { resolvedAuth } : {}),
        allowBodyIdentity: options.allowBodyIdentity ?? false,
        requestId,
      });
    } catch (error) {
      if (isInvalidJsonError(error)) {
        return badRequestResponse(
          "INVALID_JSON",
          "Request body must be valid JSON.",
          requestId,
        );
      }

      throw error;
    }

    const response = await handleRuntimeRequest(app, host, request);

    return runtimeResponseToAwsHttpResponse(response, request.requestId);
  };
}

export type AwsRuntimeRequestOptions = {
  resolvedAuth?: AuthIdentity | null;
  allowBodyIdentity?: boolean;
  requestId?: string;
};

export function awsHttpEventToRuntimeRequest(
  event: AwsHttpEvent,
  options: AwsRuntimeRequestOptions = {},
): RuntimeRequest {
  const method = httpMethodFrom(event);
  const path = pathFrom(event);
  const auth =
    options.resolvedAuth !== undefined ? options.resolvedAuth : authFrom(event);
  const allowBodyIdentity = options.allowBodyIdentity ?? true;
  const requestId = options.requestId ?? requestIdFrom(event);

  if (method === "POST" && path.startsWith("/_anvil/query/")) {
    const body = parseJsonBody(event);

    return {
      kind: "query",
      name: decodeURIComponent(path.slice("/_anvil/query/".length)),
      input: inputFromBody(body),
      auth: allowBodyIdentity ? authFromBody(body, auth) : auth,
      requestId,
    };
  }

  if (method === "POST" && path.startsWith("/_anvil/mutation/")) {
    const body = parseJsonBody(event);

    return {
      kind: "mutation",
      name: decodeURIComponent(path.slice("/_anvil/mutation/".length)),
      input: inputFromBody(body),
      auth: allowBodyIdentity ? authFromBody(body, auth) : auth,
      requestId,
    };
  }

  return {
    kind: "endpoint",
    method,
    path,
    headers: headersFrom(event),
    body: rawBodyFrom(event),
    auth,
    requestId,
  };
}

function bearerTokenFrom(event: AwsHttpEvent): string | null {
  const headers = headersFrom(event);
  const header = headers.authorization;

  if (!header) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());

  return match?.[1] ?? null;
}

function authErrorToAwsHttpResponse(
  error: unknown,
  requestId: string,
): AwsHttpResponse {
  const code = error instanceof AuthError ? error.code : "TOKEN_INVALID";
  const message =
    error instanceof Error ? error.message : "Token verification failed.";

  return {
    statusCode: 401,
    headers: withRuntimeHeaders(
      { "content-type": "application/json" },
      requestId,
    ),
    body: `${JSON.stringify({ ok: false, error: { code, message } })}\n`,
    isBase64Encoded: false,
  };
}

function badRequestResponse(
  code: string,
  message: string,
  requestId: string,
): AwsHttpResponse {
  return {
    statusCode: 400,
    headers: withRuntimeHeaders(
      { "content-type": "application/json" },
      requestId,
    ),
    body: `${JSON.stringify({ ok: false, error: { code, message } })}\n`,
    isBase64Encoded: false,
  };
}

export async function runtimeResponseToAwsHttpResponse(
  response: RuntimeResponse,
  requestId?: string,
): Promise<AwsHttpResponse> {
  if (response.body instanceof Response) {
    return webResponseToAwsHttpResponse(response.body, requestId);
  }

  return {
    statusCode: response.status,
    headers: withRuntimeHeaders(
      {
        "content-type": "application/json",
        ...response.headers,
      },
      requestId,
    ),
    body: `${JSON.stringify({
      ok: response.ok,
      result: response.ok ? response.body : undefined,
      error: response.error,
      diagnostics: response.diagnostics,
    })}\n`,
    isBase64Encoded: false,
  };
}

async function webResponseToAwsHttpResponse(
  response: Response,
  requestId?: string,
): Promise<AwsHttpResponse> {
  const headers: Record<string, string> = {};

  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = new Uint8Array(await response.arrayBuffer());
  const contentType = headers["content-type"] ?? "";

  if (!isTextualContentType(contentType)) {
    return {
      statusCode: response.status,
      headers: withRuntimeHeaders(headers, requestId),
      body: Buffer.from(body).toString("base64"),
      isBase64Encoded: true,
    };
  }

  return {
    statusCode: response.status,
    headers: withRuntimeHeaders(headers, requestId),
    body: Buffer.from(body).toString("utf8"),
    isBase64Encoded: false,
  };
}

function corsPreflightResponse(): AwsHttpResponse {
  return {
    statusCode: 204,
    headers: withCorsHeaders({}),
    body: "",
    isBase64Encoded: false,
  };
}

function healthResponse(requestId: string): AwsHttpResponse {
  return {
    statusCode: 200,
    headers: withRuntimeHeaders(
      { "content-type": "application/json" },
      requestId,
    ),
    body: `${JSON.stringify({
      ok: true,
      runtime: "aws-preview",
    })}\n`,
    isBase64Encoded: false,
  };
}

function withRuntimeHeaders(
  headers: Record<string, string>,
  requestId?: string,
): Record<string, string> {
  return withCorsHeaders({
    ...headers,
    ...(requestId ? { "x-anvil-request-id": requestId } : {}),
  });
}

function withCorsHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers":
      "authorization,content-type,x-anvil-request-id",
    "access-control-max-age": "600",
    ...headers,
  };
}

function isTextualContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase().split(";")[0]?.trim() ?? "";

  return (
    normalized === "" ||
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized.endsWith("+json") ||
    normalized === "application/javascript" ||
    normalized === "application/xml" ||
    normalized.endsWith("+xml") ||
    normalized === "application/x-www-form-urlencoded" ||
    normalized === "image/svg+xml"
  );
}

function httpMethodFrom(event: AwsHttpEvent): string {
  return (
    event.requestContext?.http?.method ??
    event.httpMethod ??
    "GET"
  ).toUpperCase();
}

function requestIdFrom(event: AwsHttpEvent): string {
  return event.requestContext?.requestId ?? randomUUID();
}

function pathFrom(event: AwsHttpEvent): string {
  return event.rawPath ?? event.requestContext?.http?.path ?? event.path ?? "/";
}

function headersFrom(event: AwsHttpEvent): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) {
      headers[key.toLowerCase()] = value;
    }
  }

  return headers;
}

function rawBodyFrom(event: AwsHttpEvent): Uint8Array | null {
  if (!event.body) {
    return null;
  }

  const buffer = Buffer.from(
    event.body,
    event.isBase64Encoded ? "base64" : "utf8",
  );

  return new Uint8Array(buffer);
}

function parseJsonBody(event: AwsHttpEvent): unknown {
  const rawBody = rawBodyFrom(event);

  if (!rawBody || rawBody.byteLength === 0) {
    return {};
  }

  return JSON.parse(Buffer.from(rawBody).toString("utf8")) as unknown;
}

function isInvalidJsonError(error: unknown): boolean {
  return error instanceof SyntaxError;
}

function inputFromBody(body: unknown): unknown {
  return isObject(body) && "input" in body ? body.input : body;
}

function authFromBody(
  body: unknown,
  fallback: AuthIdentity | null,
): AuthIdentity | null {
  if (isObject(body) && "auth" in body) {
    return body.auth === null ? null : (body.auth as AuthIdentity);
  }

  return fallback;
}

function authFrom(event: AwsHttpEvent): AuthIdentity | null {
  const anvilAuth = event.requestContext?.authorizer?.anvil;

  if (anvilAuth) {
    return anvilAuth;
  }

  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const subject = claims?.sub;

  if (!claims || typeof subject !== "string") {
    return null;
  }

  const identity: AuthIdentity = {
    userId: subject,
  };

  if (typeof claims.email === "string") {
    identity.email = claims.email;
  }

  identity.claims = claims;

  return identity;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
