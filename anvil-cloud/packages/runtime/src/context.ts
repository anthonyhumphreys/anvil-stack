import { RuntimeError } from "./errors.js";
import type {
  AuthIdentity,
  DatabaseAdapter,
  DatabaseClient,
  DatabaseTableClient,
  EnvAdapter,
  EventAdapter,
  FileAdapter,
  JobAdapter,
  LogAdapter,
  RuntimeHost,
} from "./host.js";
import type { RuntimeRequest } from "./request.js";

export type AuthContext = {
  identity: AuthIdentity | null;
  userId: string | null;
  requireUser: () => string;
  hasRole: (role: string) => boolean;
  requireRole: (role: string) => AuthIdentity;
};

export type EnvClient = {
  get: (name: string) => string | undefined;
  require: (name: string) => string;
};

export type LogClient = {
  info: (message: string, meta?: Record<string, unknown>) => Promise<void>;
  warn: (message: string, meta?: Record<string, unknown>) => Promise<void>;
  error: (message: string, meta?: Record<string, unknown>) => Promise<void>;
  debug: (message: string, meta?: Record<string, unknown>) => Promise<void>;
};

export type FileClient = FileAdapter;
export type EventClient = EventAdapter;
export type JobClient = JobAdapter;

export type RequestContext = {
  id: string;
  kind: RuntimeRequest["kind"];
  handler: string;
  method?: string;
  path?: string;
};

export type RuntimeContext = {
  auth: AuthContext;
  db: DatabaseClient;
  files: FileClient;
  env: EnvClient;
  log: LogClient;
  events: EventClient;
  jobs: JobClient;
  request: RequestContext;
};

export async function createRuntimeContext(
  host: RuntimeHost,
  request: RuntimeRequest,
  handler: string,
): Promise<RuntimeContext> {
  const identity = requestHasAuth(request)
    ? (request.auth ?? (await host.auth.current()))
    : await host.auth.current();

  return {
    auth: createAuthContext(identity),
    db: createDatabaseClient(host.db),
    files: host.files,
    env: createEnvClient(host.env),
    log: createLogClient(host.logs, request, handler),
    events: host.events,
    jobs: host.jobs,
    request: createRequestContext(request, handler),
  };
}

function requestHasAuth(
  request: RuntimeRequest,
): request is RuntimeRequest & { auth: AuthIdentity | null } {
  return "auth" in request;
}

function createAuthContext(identity: AuthIdentity | null): AuthContext {
  return {
    identity,
    userId: identity?.userId ?? null,
    requireUser() {
      if (!identity) {
        throw new RuntimeError(
          "AUTH_REQUIRED",
          "A signed-in user is required.",
          401,
        );
      }

      return identity.userId;
    },
    hasRole(role) {
      return identity?.roles?.includes(role) ?? false;
    },
    requireRole(role) {
      if (!identity) {
        throw new RuntimeError(
          "AUTH_REQUIRED",
          "A signed-in user is required.",
          401,
        );
      }

      if (!identity.roles?.includes(role)) {
        throw new RuntimeError("FORBIDDEN", `Role '${role}' is required.`, 403);
      }

      return identity;
    },
  };
}

function createDatabaseClient(adapter: DatabaseAdapter): DatabaseClient {
  return new Proxy<Record<string, DatabaseTableClient>>(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string" || property === "then") {
          return undefined;
        }

        return adapter.table(property);
      },
    },
  );
}

function createEnvClient(adapter: EnvAdapter): EnvClient {
  return {
    get(name) {
      return adapter.get(name);
    },
    require(name) {
      const value = adapter.get(name);

      if (value === undefined) {
        throw new RuntimeError(
          "NOT_FOUND",
          `Required environment value '${name}' is not defined.`,
          404,
        );
      }

      return value;
    },
  };
}

function createLogClient(
  adapter: LogAdapter,
  request: RuntimeRequest,
  handler: string,
): LogClient {
  const write = async (
    level: "debug" | "error" | "info" | "warn",
    message: string,
    meta?: Record<string, unknown>,
  ) => {
    await adapter.write({
      level,
      message,
      meta: meta ?? {},
      requestId: request.requestId,
      handler,
      kind: request.kind,
      timestamp: new Date().toISOString(),
    });
  };

  return {
    debug(message, meta) {
      return write("debug", message, meta);
    },
    error(message, meta) {
      return write("error", message, meta);
    },
    info(message, meta) {
      return write("info", message, meta);
    },
    warn(message, meta) {
      return write("warn", message, meta);
    },
  };
}

function createRequestContext(
  request: RuntimeRequest,
  handler: string,
): RequestContext {
  if (request.kind === "endpoint") {
    return {
      id: request.requestId,
      kind: request.kind,
      handler,
      method: request.method,
      path: request.path,
    };
  }

  return {
    id: request.requestId,
    kind: request.kind,
    handler,
  };
}
