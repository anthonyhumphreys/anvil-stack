import { randomUUID } from "node:crypto";

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

export function createAwsRuntimeHandler(
  app: AppDefinition,
  host: RuntimeHost,
): AwsRuntimeHandler {
  return async (event) => {
    const request = awsHttpEventToRuntimeRequest(event);
    const response = await handleRuntimeRequest(app, host, request);

    return runtimeResponseToAwsHttpResponse(response);
  };
}

export function awsHttpEventToRuntimeRequest(
  event: AwsHttpEvent,
): RuntimeRequest {
  const method = httpMethodFrom(event);
  const path = pathFrom(event);
  const auth = authFrom(event);
  const requestId = event.requestContext?.requestId ?? randomUUID();

  if (method === "POST" && path.startsWith("/_anvil/query/")) {
    const body = parseJsonBody(event);

    return {
      kind: "query",
      name: decodeURIComponent(path.slice("/_anvil/query/".length)),
      input: inputFromBody(body),
      auth: authFromBody(body, auth),
      requestId,
    };
  }

  if (method === "POST" && path.startsWith("/_anvil/mutation/")) {
    const body = parseJsonBody(event);

    return {
      kind: "mutation",
      name: decodeURIComponent(path.slice("/_anvil/mutation/".length)),
      input: inputFromBody(body),
      auth: authFromBody(body, auth),
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

export async function runtimeResponseToAwsHttpResponse(
  response: RuntimeResponse,
): Promise<AwsHttpResponse> {
  if (response.body instanceof Response) {
    return webResponseToAwsHttpResponse(response.body);
  }

  return {
    statusCode: response.status,
    headers: {
      "content-type": "application/json",
      ...response.headers,
    },
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
): Promise<AwsHttpResponse> {
  const headers: Record<string, string> = {};

  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    statusCode: response.status,
    headers,
    body: await response.text(),
    isBase64Encoded: false,
  };
}

function httpMethodFrom(event: AwsHttpEvent): string {
  return (
    event.requestContext?.http?.method ??
    event.httpMethod ??
    "GET"
  ).toUpperCase();
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
