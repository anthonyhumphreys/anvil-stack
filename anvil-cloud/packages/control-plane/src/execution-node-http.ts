import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";

import type {
  AgentExecutionHttpRequest,
  AgentExecutionHttpResponse,
} from "./execution-http.js";

const DEFAULT_MAX_BODY_BYTES = 384 * 1024 * 1024;

export type AgentExecutionNodeHttpServerOptions = {
  handler(
    request: AgentExecutionHttpRequest,
  ): Promise<AgentExecutionHttpResponse>;
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  authenticateHeaders?(
    request: Omit<AgentExecutionHttpRequest, "body">,
  ): boolean | Promise<boolean>;
};

export type AgentExecutionNodeHttpServer = {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
};

/**
 * Small Node adapter for the framework-neutral control-plane and worker
 * handlers. Authentication and authorisation remain mandatory in the handler.
 */
export async function startAgentExecutionNodeHttpServer(
  options: AgentExecutionNodeHttpServerOptions,
): Promise<AgentExecutionNodeHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 4764;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (
    !Number.isSafeInteger(requestedPort) ||
    requestedPort < 0 ||
    requestedPort > 65_535
  ) {
    throw new Error(`Execution server port '${requestedPort}' is invalid.`);
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("Execution server body limit must be a positive integer.");
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${host}`);
      const requestMetadata = {
        method: request.method ?? "GET",
        path: url.pathname,
        headers: normalizeHeaders(request.headers),
        query: url.searchParams,
      };
      if (
        options.authenticateHeaders &&
        !(await options.authenticateHeaders(requestMetadata))
      ) {
        request.resume();
        writeJson(response, 401, {
          ok: false,
          error: {
            code: "EXECUTION_AUTHENTICATION_REQUIRED",
            message: "Execution service authentication is required.",
          },
        });
        return;
      }
      const body = await readJsonBody(request, maxBodyBytes);
      const result = await options.handler({
        ...requestMetadata,
        ...(body === undefined ? {} : { body }),
      });

      writeJson(response, result.status, result.body);
    } catch (error) {
      const tooLarge =
        error instanceof AgentExecutionNodeHttpError && error.status === 413;
      writeJson(response, tooLarge ? 413 : 400, {
        ok: false,
        error: {
          code: tooLarge
            ? "EXECUTION_HTTP_BODY_TOO_LARGE"
            : "EXECUTION_HTTP_INVALID_REQUEST",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });
  await listen(server, requestedPort, host);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Execution server did not expose a TCP address.");
  }

  return {
    host,
    port: address.port,
    url: `http://${formatHostForUrl(host)}:${address.port}`,
    close: () => closeServer(server),
  };
}

class AgentExecutionNodeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentExecutionNodeHttpError";
  }
}

async function readJsonBody(
  request: NodeJS.ReadableStream,
  maxBodyBytes: number,
): Promise<unknown | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBodyBytes) {
      throw new AgentExecutionNodeHttpError(
        413,
        `Execution request exceeds ${maxBodyBytes} bytes.`,
      );
    }
    chunks.push(bytes);
  }

  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AgentExecutionNodeHttpError(
      400,
      "Execution request body must be valid JSON.",
    );
  }
}

function normalizeHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};

  for (const [name, value] of Object.entries(headers)) {
    normalized[name] = Array.isArray(value) ? value.join(", ") : value;
  }

  return normalized;
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function listen(
  server: Server,
  port: number,
  host: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
