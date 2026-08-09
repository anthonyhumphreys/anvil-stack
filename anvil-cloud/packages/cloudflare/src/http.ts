import {
  handleRuntimeRequest,
  type AppDefinition,
  type RuntimeHost,
  type RuntimeRequest,
  type RuntimeResponse,
} from "@anvil-cloud/runtime";

import type { CloudflareWorkerBindings } from "./host.js";

export type CloudflareWorkerHandler = {
  fetch(
    request: Request,
    env: CloudflareWorkerBindings,
    context: ExecutionContext,
  ): Promise<Response>;
};

export type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
};

export type CreateCloudflareWorkerHandlerOptions = {
  createHost(env: CloudflareWorkerBindings): RuntimeHost;
};

export function createCloudflareWorkerHandler(
  app: AppDefinition,
  options: CreateCloudflareWorkerHandlerOptions,
): CloudflareWorkerHandler {
  return {
    async fetch(request, env) {
      const requestId =
        request.headers.get("x-anvil-request-id") ?? crypto.randomUUID();

      if (request.method.toUpperCase() === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: withRuntimeHeaders({}, requestId),
        });
      }

      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/_anvil/health") {
        return jsonResponse(
          200,
          { ok: true, runtime: "cloudflare-preview" },
          requestId,
        );
      }

      if (!isRuntimeRoute(app, request.method, url.pathname)) {
        const assets = env.ANVIL_ASSETS;

        return assets
          ? assets.fetch(request)
          : jsonResponse(
              404,
              {
                ok: false,
                error: {
                  code: "NOT_FOUND",
                  message:
                    "No Cell endpoint or static asset matched this request.",
                },
              },
              requestId,
            );
      }

      let runtimeRequest: RuntimeRequest;

      try {
        runtimeRequest = await cloudflareRequestToRuntimeRequest(
          request,
          requestId,
        );
      } catch (error) {
        if (error instanceof SyntaxError) {
          return jsonResponse(
            400,
            {
              ok: false,
              error: {
                code: "INVALID_JSON",
                message: "Request body must be valid JSON.",
              },
            },
            requestId,
          );
        }

        throw error;
      }

      const response = await handleRuntimeRequest(
        app,
        options.createHost(env),
        runtimeRequest,
      );

      return runtimeResponseToCloudflareResponse(response, requestId);
    },
  };
}

export async function cloudflareRequestToRuntimeRequest(
  request: Request,
  requestId: string = crypto.randomUUID(),
): Promise<RuntimeRequest> {
  const method = request.method.toUpperCase();
  const path = new URL(request.url).pathname;

  if (method === "POST" && path.startsWith("/_anvil/query/")) {
    return {
      kind: "query",
      name: decodeURIComponent(path.slice("/_anvil/query/".length)),
      input: inputFromBody(await readJsonBody(request)),
      auth: null,
      requestId,
    };
  }

  if (method === "POST" && path.startsWith("/_anvil/mutation/")) {
    return {
      kind: "mutation",
      name: decodeURIComponent(path.slice("/_anvil/mutation/".length)),
      input: inputFromBody(await readJsonBody(request)),
      auth: null,
      requestId,
    };
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const body =
    method === "GET" || method === "HEAD"
      ? null
      : new Uint8Array(await request.arrayBuffer());

  return {
    kind: "endpoint",
    method,
    path,
    headers,
    body,
    auth: null,
    requestId,
  };
}

export async function runtimeResponseToCloudflareResponse(
  response: RuntimeResponse,
  requestId: string,
): Promise<Response> {
  if (response.body instanceof Response) {
    const headers = new Headers(response.body.headers);
    applyRuntimeHeaders(headers, requestId);

    return new Response(response.body.body, {
      status: response.body.status,
      statusText: response.body.statusText,
      headers,
    });
  }

  return jsonResponse(
    response.status,
    {
      ok: response.ok,
      ...(response.ok ? { result: response.body } : {}),
      ...(response.error ? { error: response.error } : {}),
      ...(response.diagnostics ? { diagnostics: response.diagnostics } : {}),
    },
    requestId,
    response.headers,
  );
}

function isRuntimeRoute(
  app: AppDefinition,
  method: string,
  path: string,
): boolean {
  if (
    path.startsWith("/_anvil/query/") ||
    path.startsWith("/_anvil/mutation/")
  ) {
    return true;
  }

  return Object.values(app.endpoints ?? {}).some(
    (endpoint) =>
      endpoint.method.toUpperCase() === method.toUpperCase() &&
      endpoint.path === path,
  );
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();

  return text.length === 0 ? {} : (JSON.parse(text) as unknown);
}

function inputFromBody(body: unknown): unknown {
  return isObject(body) && "input" in body ? body.input : body;
}

function jsonResponse(
  status: number,
  body: unknown,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: withRuntimeHeaders(
      { "content-type": "application/json", ...extraHeaders },
      requestId,
    ),
  });
}

function withRuntimeHeaders(
  headers: Record<string, string>,
  requestId: string,
): Headers {
  const result = new Headers(headers);
  applyRuntimeHeaders(result, requestId);

  return result;
}

function applyRuntimeHeaders(headers: Headers, requestId: string): void {
  headers.set("access-control-allow-origin", "*");
  headers.set(
    "access-control-allow-methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );
  headers.set(
    "access-control-allow-headers",
    "authorization,content-type,x-anvil-request-id",
  );
  headers.set("access-control-max-age", "600");
  headers.set("x-anvil-request-id", requestId);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
