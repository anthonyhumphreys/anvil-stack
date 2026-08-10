import type { LogEntry } from "@anvil-cloud/runtime";

export {
  AgentExecutionControlPlane,
  AgentExecutionControlPlaneError,
  type AgentExecutionCleanupReceipt,
  type AgentExecutionControlPlaneApi,
  type AgentExecutionControlPlaneOptions,
  type AgentExecutionCursorBatch,
  type AgentExecutionLease,
  type AgentExecutionSourceBroker,
} from "./execution.js";
export {
  InMemoryAgentExecutionStore,
  JsonFileAgentExecutionStore,
  type AgentExecutionStore,
} from "./execution-store.js";
export {
  AgentExecutionSnapshotStoreError,
  FileAgentExecutionSnapshotStore,
  InMemoryAgentExecutionSnapshotStore,
  SnapshotStoreAgentExecutionSourceBroker,
  type AgentExecutionSnapshotDownload,
  type AgentExecutionSnapshotGrant,
  type AgentExecutionSnapshotRecord,
  type AgentExecutionSnapshotStore,
  type AgentExecutionSnapshotStoreOptions,
  type AgentExecutionSnapshotUpload,
} from "./execution-snapshot-store.js";
export {
  FakeAgentExecutionProvider,
  type FakeAgentExecutionProviderOptions,
} from "./fake-execution-provider.js";
export {
  runAgentExecutionConformance,
  type AgentExecutionConformanceCheck,
  type AgentExecutionConformanceResult,
} from "./execution-conformance.js";
export {
  AgentExecutionHttpError,
  createAgentExecutionHttpHandler,
  createHttpAgentExecutionControlPlane,
  createHttpAgentExecutionSourceClient,
  type AgentExecutionFetch,
  type AgentExecutionHttpAction,
  type AgentExecutionHttpAuthorizationContext,
  type AgentExecutionHttpClientOptions,
  type AgentExecutionHttpHandlerOptions,
  type AgentExecutionHttpPrincipal,
  type AgentExecutionHttpRequest,
  type AgentExecutionHttpResponse,
  type AgentExecutionHttpSecurity,
  type AgentExecutionSourceHttpClient,
} from "./execution-http.js";
export {
  AgentExecutionWorkerError,
  createAgentExecutionWorkerHttpHandler,
  type AgentExecutionWorkerDriver,
  type AgentExecutionWorkerFetch,
  type AgentExecutionWorkerHandlerOptions,
  type AgentExecutionWorkerSecurity,
  type AgentExecutionWorkerWorkspaceMaterial,
} from "./execution-worker.js";
export {
  startAgentExecutionNodeHttpServer,
  type AgentExecutionNodeHttpServer,
  type AgentExecutionNodeHttpServerOptions,
} from "./execution-node-http.js";

/**
 * A log entry as reported by a management plane. Local entries carry the
 * runtime `LogEntry` shape plus the cell name; hosted planes may add fields.
 */
export type ControlPlaneLogEntry = LogEntry & {
  cell?: string;
  [key: string]: unknown;
};

export type ControlPlaneDescription = {
  cell: string;
  target: "local" | string;
  runtimeUrl?: string;
};

export type ControlPlaneLogOptions = {
  limit?: number;
  level?: string;
};

/**
 * Management-plane contract for Anvil Lens and other inspection tooling.
 *
 * The local runtime implements every read and action over its `/_anvil/*`
 * JSON routes. A hosted control plane is an adapter swap: implement this
 * interface against the hosted API and Lens-style tooling keeps working.
 */
export interface ControlPlaneApi {
  describe(): Promise<ControlPlaneDescription>;
  manifest(): Promise<unknown>;
  inspect(): Promise<unknown>;
  logs(options?: ControlPlaneLogOptions): Promise<ControlPlaneLogEntry[]>;
  dbTables(): Promise<Record<string, { rows: number }>>;
  dbDump(table: string): Promise<unknown[]>;
  authUsers(): Promise<unknown[]>;
  traces(): Promise<unknown[]>;
  trace(traceId: string): Promise<unknown | null>;
  workflows(): Promise<unknown[]>;
  workflowRun(runId: string): Promise<unknown | null>;
  services(): Promise<unknown[]>;
  serviceAction(name: string, action: "start" | "stop"): Promise<unknown>;
}

export class ControlPlaneError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Creates a `ControlPlaneApi` backed by a local runtime server's
 * `/_anvil/*` JSON routes.
 */
export function createHttpControlPlane(
  baseUrl: string,
  fetchImpl?: FetchLike,
): ControlPlaneApi {
  const base = baseUrl.replace(/\/+$/, "");
  const fetcher: FetchLike = fetchImpl ?? (fetch as unknown as FetchLike);

  async function request(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<Record<string, unknown>> {
    let response: Awaited<ReturnType<FetchLike>>;

    try {
      response = await fetcher(`${base}${path}`, {
        method: init?.method ?? "GET",
        headers: { "content-type": "application/json" },
        ...(init?.body === undefined
          ? {}
          : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      throw new ControlPlaneError(
        "CONTROL_PLANE_UNREACHABLE",
        `Could not reach the runtime at ${base}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const payload = (await response.json().catch(() => ({}))) as unknown;
    const record = isObject(payload) ? payload : {};

    if (!response.ok) {
      const error = isObject(record.error) ? record.error : {};

      throw new ControlPlaneError(
        typeof error.code === "string" ? error.code : "CONTROL_PLANE_ERROR",
        typeof error.message === "string"
          ? error.message
          : `Request to ${path} failed with status ${response.status}.`,
        response.status,
      );
    }

    return record;
  }

  return {
    async describe() {
      const payload = await request("/_anvil/inspect");
      const manifest = isObject(payload.manifest) ? payload.manifest : {};
      const cell = isObject(manifest.cell) ? manifest.cell : {};
      const description: ControlPlaneDescription = {
        cell: typeof cell.name === "string" ? cell.name : "unknown",
        target: "local",
      };

      if (typeof payload.runtimeUrl === "string") {
        description.runtimeUrl = payload.runtimeUrl;
      }

      return description;
    },
    async manifest() {
      const payload = await request("/_anvil/manifest");

      return payload.manifest ?? null;
    },
    async inspect() {
      return request("/_anvil/inspect");
    },
    async logs(options) {
      const payload = await request("/_anvil/logs");
      let entries = Array.isArray(payload.logs)
        ? (payload.logs as ControlPlaneLogEntry[])
        : [];

      if (options?.level !== undefined) {
        entries = entries.filter((entry) => entry.level === options.level);
      }

      if (options?.limit !== undefined && options.limit >= 0) {
        entries = entries.slice(-options.limit);
      }

      return entries;
    },
    async dbTables() {
      const payload = await request("/_anvil/db/tables");
      const database = isObject(payload.database) ? payload.database : {};
      const tables = isObject(database.tables) ? database.tables : {};
      const result: Record<string, { rows: number }> = {};

      for (const [name, info] of Object.entries(tables)) {
        result[name] = {
          rows: isObject(info) && typeof info.rows === "number" ? info.rows : 0,
        };
      }

      return result;
    },
    async dbDump(table) {
      const payload = await request(`/_anvil/db/${encodeURIComponent(table)}`);

      return Array.isArray(payload.rows) ? payload.rows : [];
    },
    async authUsers() {
      const payload = await request("/_anvil/auth/users");

      return Array.isArray(payload.users) ? payload.users : [];
    },
    async traces() {
      const payload = await request("/_anvil/traces");

      return Array.isArray(payload.traces) ? payload.traces : [];
    },
    async trace(traceId) {
      try {
        const payload = await request(
          `/_anvil/traces/${encodeURIComponent(traceId)}`,
        );

        return payload.trace ?? null;
      } catch (error) {
        if (error instanceof ControlPlaneError && error.status === 404) {
          return null;
        }

        throw error;
      }
    },
    async workflows() {
      const payload = await request("/_anvil/workflows");

      return Array.isArray(payload.runs) ? payload.runs : [];
    },
    async workflowRun(runId) {
      try {
        const payload = await request(
          `/_anvil/workflows/${encodeURIComponent(runId)}`,
        );

        return payload.run ?? null;
      } catch (error) {
        if (error instanceof ControlPlaneError && error.status === 404) {
          return null;
        }

        throw error;
      }
    },
    async services() {
      const payload = await request("/_anvil/services");

      return Array.isArray(payload.services) ? payload.services : [];
    },
    async serviceAction(name, action) {
      const payload = await request(
        `/_anvil/services/${encodeURIComponent(name)}/${action}`,
        { method: "POST", body: {} },
      );

      return payload.service ?? null;
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
