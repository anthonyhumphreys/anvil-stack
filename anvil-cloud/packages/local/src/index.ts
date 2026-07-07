import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";

import {
  AuthError,
  LocalIdentityProvider,
  type LocalUser,
} from "@anvil-cloud/auth";
import {
  createWorkflowRun,
  AgentProviderRegistry,
  AgentRuntime,
  LocalStubInferenceProvider,
  executeWorkflowRun,
  handleRuntimeRequest,
  RuntimeError,
  ServiceSupervisor,
  type ServiceStatus,
  type AppDefinition,
  type AuthAdapter,
  type AuthIdentity,
  type DatabaseAdapter,
  type DatabaseInspection,
  type DatabaseQueryClient,
  type DatabaseRecord,
  type DatabaseTableClient,
  type DatabaseWhereOperator,
  type EnvAdapter,
  type EventAdapter,
  type FileAdapter,
  type JobAdapter,
  type LogAdapter,
  type LogEntry,
  type RuntimeHost,
  type RuntimeRequest,
  type RuntimeResponse,
  redactTraceValue,
  type WorkflowAdapter,
  type WorkflowRun,
  type AgentApprovalProvider,
  type TraceAdapter,
  type TraceCompleteInput,
  type TraceEventInput,
  type TraceRecord,
  type TraceRedactor,
  type TraceStartInput,
  type AgentModelConfig,
  type AgentTokenUsage,
} from "@anvil-cloud/runtime";
import { createServer as createViteServer, type ViteDevServer } from "vite";

import { lensPageHtml } from "./lens.js";

export { lensPageHtml } from "./lens.js";

export type LocalRuntimeHost = RuntimeHost & {
  db: JsonDatabaseAdapter;
  files: LocalFileAdapter;
  env: LocalEnvAdapter;
  auth: LocalAuthAdapter;
  logs: LocalLogAdapter;
  events: LocalEventAdapter;
  jobs: LocalJobAdapter;
  workflows: LocalWorkflowAdapter;
  traces: LocalTraceAdapter;
  agentSessions: LocalAgentSessionAdapter;
  usage: LocalUsageMeter;
  idp: LocalIdentityProvider;
};

export type LocalRuntimeServerOptions = {
  app: AppDefinition;
  manifest: unknown;
  rootDir?: string;
  stateDir?: string;
  cellName: string;
  port?: number;
  clientPort?: number;
  clientDistDir?: string;
  clientMode?: "none" | "static" | "vite";
  env?: Record<string, string>;
  agentProviders?: AgentProviderRegistry;
  agentApprovalProvider?: AgentApprovalProvider;
  traceRedactor?: TraceRedactor;
};

export type LocalRuntimeServer = {
  host: LocalRuntimeHost;
  services: ServiceSupervisor;
  runtimeUrl: string;
  clientUrl: string;
  close: () => Promise<void>;
};

export async function createLocalRuntimeHost(options: {
  stateDir: string;
  cellName: string;
  env?: Record<string, string>;
  traceRedactor?: TraceRedactor;
}): Promise<LocalRuntimeHost> {
  await mkdir(options.stateDir, { recursive: true });
  await mkdir(path.join(options.stateDir, "files"), { recursive: true });

  const idp = new LocalIdentityProvider({
    stateDir: path.join(options.stateDir, "auth"),
  });

  return {
    db: new JsonDatabaseAdapter(path.join(options.stateDir, "dev.db")),
    files: new LocalFileAdapter(path.join(options.stateDir, "files")),
    env: new LocalEnvAdapter(options.env ?? process.env),
    auth: new LocalAuthAdapter(path.join(options.stateDir, "auth.json"), idp),
    logs: new LocalLogAdapter(
      path.join(options.stateDir, "logs.ndjson"),
      options.cellName,
    ),
    events: new LocalEventAdapter(path.join(options.stateDir, "events.json")),
    jobs: new LocalJobAdapter(path.join(options.stateDir, "jobs.json")),
    workflows: new LocalWorkflowAdapter(
      path.join(options.stateDir, "workflows.json"),
    ),
    traces: new LocalTraceAdapter(path.join(options.stateDir, "traces.json"), {
      redactor: options.traceRedactor ?? redactTraceValue,
    }),
    agentSessions: new LocalAgentSessionAdapter(
      path.join(options.stateDir, "agent-sessions.json"),
    ),
    usage: new LocalUsageMeter(
      path.join(options.stateDir, "usage.ndjson"),
      options.cellName,
    ),
    idp,
  };
}

export async function startLocalRuntimeServer(
  options: LocalRuntimeServerOptions,
): Promise<LocalRuntimeServer> {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const stateDir = path.resolve(rootDir, options.stateDir ?? ".anvil/local");
  const clientDistDir = path.resolve(
    rootDir,
    options.clientDistDir ?? ".anvil/dist/client",
  );
  const port = options.port ?? 8787;
  const clientPort = options.clientPort ?? 5173;
  const clientMode = options.clientMode ?? "static";
  let runtimeUrl = `http://localhost:${port}`;
  let clientUrl = `http://localhost:${clientPort}`;
  const hostOptions: {
    stateDir: string;
    cellName: string;
    env?: Record<string, string>;
    traceRedactor?: TraceRedactor;
  } = {
    stateDir,
    cellName: options.cellName,
  };

  if (options.env !== undefined) {
    hostOptions.env = options.env;
  }

  if (options.traceRedactor !== undefined) {
    hostOptions.traceRedactor = options.traceRedactor;
  }

  const host = await createLocalRuntimeHost(hostOptions);
  const agentProviders = options.agentProviders ?? new AgentProviderRegistry();

  if (!agentProviders.has("local")) {
    agentProviders.register(new LocalStubInferenceProvider());
  }

  host.workflows.bind(options.app, host);
  void host.workflows.resumeInterrupted().catch(() => {
    // Resume failures are recorded on the persisted run state.
  });

  const servicesSnapshotPath = path.join(stateDir, "services.json");
  const services = new ServiceSupervisor({
    app: options.app,
    host,
    onTransition: async () => {
      await writeServicesSnapshot(servicesSnapshotPath, services.status());
    },
  });

  await services.startAll();

  const server = http.createServer((request, response) => {
    void handleLocalRequest({
      app: options.app,
      manifest: options.manifest,
      host,
      agentRuntime: new AgentRuntime({
        providers: agentProviders,
        baseDir: rootDir,
        traces: host.traces,
        ...(options.agentApprovalProvider === undefined
          ? {}
          : { approvalProvider: options.agentApprovalProvider }),
      }),
      agentProviders,
      services,
      runtimeUrl,
      clientUrl,
      request,
      response,
    });
  });

  await listen(server, port);
  const address = server.address();

  if (typeof address === "object" && address !== null) {
    runtimeUrl = `http://localhost:${address.port}`;
  }

  let clientServer: Server | undefined;
  let viteServer: ViteDevServer | undefined;

  try {
    if (clientMode === "none") {
      clientUrl = runtimeUrl;
    } else if (clientMode === "vite") {
      viteServer = await startViteClientServer({
        rootDir,
        runtimeUrl,
        port: clientPort,
      });
      clientUrl =
        trimTrailingSlash(viteServer.resolvedUrls?.local[0]) ??
        urlFromServerAddress(viteServer.httpServer?.address(), clientUrl);
    } else {
      clientServer = http.createServer((request, response) => {
        void handleClientRequest({
          clientDistDir,
          runtimeUrl,
          request,
          response,
        });
      });
      await listen(clientServer, clientPort);
    }
  } catch (error) {
    await services.stopAll();
    await close(server);
    throw error;
  }

  const clientAddress = clientServer?.address();

  if (typeof clientAddress === "object" && clientAddress !== null) {
    clientUrl = `http://localhost:${clientAddress.port}`;
  }

  return {
    host,
    services,
    runtimeUrl,
    clientUrl,
    close: async () => {
      await services.stopAll();
      if (viteServer) {
        await viteServer.close();
      }
      if (clientServer) {
        await close(clientServer);
      }
      await close(server);
    },
  };
}

function urlFromServerAddress(
  address: ReturnType<Server["address"]> | null | undefined,
  fallback: string,
): string {
  if (typeof address === "object" && address !== null) {
    return `http://localhost:${address.port}`;
  }

  return fallback;
}

function trimTrailingSlash(value: string | undefined): string | undefined {
  return value?.endsWith("/") ? value.slice(0, -1) : value;
}

async function startViteClientServer(options: {
  rootDir: string;
  runtimeUrl: string;
  port: number;
}): Promise<ViteDevServer> {
  const server = await createViteServer({
    root: options.rootDir,
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      port: options.port,
      strictPort: false,
      proxy: {
        "/_anvil": options.runtimeUrl,
        "/api": options.runtimeUrl,
      },
    },
    resolve: {
      alias: {
        "@anvil/generated/client": path.resolve(
          options.rootDir,
          ".anvil/generated/client.ts",
        ),
      },
    },
  });

  await server.listen();

  return server;
}

async function writeServicesSnapshot(
  filePath: string,
  services: ServiceStatus[],
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(
      { updatedAt: new Date().toISOString(), services },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export class JsonDatabaseAdapter implements DatabaseAdapter {
  constructor(private readonly filePath: string) {}

  table(name: string): DatabaseTableClient {
    return new JsonDatabaseTableClient(name, this);
  }

  async inspect(): Promise<DatabaseInspection> {
    const data = await this.read();
    const tables: DatabaseInspection["tables"] = {};

    for (const [name, rows] of Object.entries(data)) {
      tables[name] = {
        rows: rows.length,
      };
    }

    return { tables };
  }

  async dumpTable(name: string): Promise<DatabaseRecord[]> {
    const data = await this.read();

    return cloneRecords(data[name] ?? []);
  }

  async read(): Promise<Record<string, DatabaseRecord[]>> {
    return readJsonFile(this.filePath, {});
  }

  async write(data: Record<string, DatabaseRecord[]>): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify(data, null, 2)}\n`,
      "utf8",
    );
  }
}

export class JsonDatabaseTableClient implements DatabaseTableClient {
  constructor(
    private readonly name: string,
    private readonly adapter: JsonDatabaseAdapter,
  ) {}

  async all(): Promise<DatabaseRecord[]> {
    return this.adapter.dumpTable(this.name);
  }

  async get(id: string): Promise<DatabaseRecord | null> {
    const rows = await this.adapter.dumpTable(this.name);

    return rows.find((row) => String(row.id) === id) ?? null;
  }

  async insert(record: DatabaseRecord): Promise<DatabaseRecord> {
    const data = await this.adapter.read();
    const rows = data[this.name] ?? [];
    const stored = {
      ...cloneRecord(record),
      id: record.id === undefined ? nextId(this.name, rows) : String(record.id),
    };

    data[this.name] = [...rows, stored];
    await this.adapter.write(data);

    return cloneRecord(stored);
  }

  async update(id: string, patch: DatabaseRecord): Promise<DatabaseRecord> {
    const data = await this.adapter.read();
    const rows = data[this.name] ?? [];
    const index = rows.findIndex((row) => String(row.id) === id);

    if (index < 0) {
      throw new Error(`Record '${id}' does not exist in table '${this.name}'.`);
    }

    const updated = {
      ...rows[index],
      ...cloneRecord(patch),
      id,
    };

    rows[index] = updated;
    data[this.name] = rows;
    await this.adapter.write(data);

    return cloneRecord(updated);
  }

  async delete(id: string): Promise<boolean> {
    const data = await this.adapter.read();
    const rows = data[this.name] ?? [];
    const nextRows = rows.filter((row) => String(row.id) !== id);

    data[this.name] = nextRows;
    await this.adapter.write(data);

    return rows.length !== nextRows.length;
  }

  where(
    field: string,
    operator: DatabaseWhereOperator,
    value: unknown,
  ): DatabaseQueryClient {
    const all = async () => {
      const rows = await this.adapter.dumpTable(this.name);

      return rows.filter((row) => compare(row[field], operator, value));
    };

    return {
      all,
      first: async () => {
        const [first] = await all();

        return first ?? null;
      },
      count: async () => (await all()).length,
    };
  }
}

export class LocalFileAdapter implements FileAdapter {
  constructor(private readonly rootDir: string) {}

  async get(key: string): Promise<Uint8Array | null> {
    const filePath = this.resolveKey(key);

    try {
      const data = await readFile(filePath);

      return new Uint8Array(data);
    } catch {
      return null;
    }
  }

  async put(key: string, body: Uint8Array): Promise<{ key: string }> {
    const filePath = this.resolveKey(key);

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body);

    return { key };
  }

  async delete(key: string): Promise<boolean> {
    try {
      await rm(this.resolveKey(key));

      return true;
    } catch {
      return false;
    }
  }

  private resolveKey(key: string): string {
    const normalized = path.normalize(key);

    if (path.isAbsolute(normalized) || normalized.startsWith("..")) {
      throw new Error(`Invalid local file key '${key}'.`);
    }

    return path.join(this.rootDir, normalized);
  }
}

export class LocalEnvAdapter implements EnvAdapter {
  constructor(private readonly values: Record<string, string | undefined>) {}

  get(name: string): string | undefined {
    return this.values[name];
  }
}

export class LocalAuthAdapter implements AuthAdapter {
  constructor(
    private readonly filePath: string,
    private readonly idp?: LocalIdentityProvider,
  ) {}

  async current(): Promise<AuthIdentity | null> {
    const state = await readJsonFile<{ currentUser: AuthIdentity | null }>(
      this.filePath,
      { currentUser: null },
    );

    return state.currentUser;
  }

  async setCurrent(identity: AuthIdentity | null): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify({ currentUser: identity }, null, 2)}\n`,
      "utf8",
    );
  }

  async verifyToken(token: string): Promise<AuthIdentity | null> {
    if (!this.idp) {
      return null;
    }

    const verified = await this.idp.verifyToken(token);

    return verified.identity;
  }
}

export class LocalLogAdapter implements LogAdapter {
  constructor(
    private readonly filePath: string,
    private readonly cellName: string,
  ) {}

  async write(entry: LogEntry): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify({ ...entry, cell: this.cellName })}\n`,
      {
        encoding: "utf8",
        flag: "a",
      },
    );
  }

  async entries(): Promise<Array<LogEntry & { cell: string }>> {
    return readNdjsonFile<LogEntry & { cell: string }>(this.filePath);
  }
}

export type LocalUsageEvent = {
  timestamp: string;
  cell: string;
  scope: "agent" | "cell" | "sandbox";
  name: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  kind?: RuntimeRequest["kind"];
  durationMs?: number;
  invocations: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  sandboxRuntimeMs: number;
};

export type LocalUsageTotals = {
  invocations: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  sandboxRuntimeMs: number;
};

export type LocalUsageSummary = {
  events: LocalUsageEvent[];
  totals: LocalUsageTotals;
  byCell: Record<string, LocalUsageTotals>;
  byAgent: Record<string, LocalUsageTotals>;
  timeSeries: Array<{ bucket: string } & LocalUsageTotals>;
  topConsumers: Array<{
    scope: LocalUsageEvent["scope"];
    name: string;
    totals: LocalUsageTotals;
  }>;
  budgets: Array<{
    id: string;
    status: "ok" | "warning";
    limitUsd: number;
    actualUsd: number;
    message: string;
  }>;
};

export class LocalUsageMeter {
  constructor(
    private readonly filePath: string,
    private readonly cellName: string,
  ) {}

  async record(
    event: Omit<LocalUsageEvent, "cell" | "timestamp"> & {
      timestamp?: string;
      cell?: string;
    },
  ): Promise<void> {
    const stored: LocalUsageEvent = {
      timestamp: event.timestamp ?? new Date().toISOString(),
      cell: event.cell ?? this.cellName,
      scope: event.scope,
      name: event.name,
      invocations: event.invocations,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      totalTokens: event.totalTokens,
      estimatedCostUsd: event.estimatedCostUsd,
      sandboxRuntimeMs: event.sandboxRuntimeMs,
    };

    if (event.sessionId !== undefined) {
      stored.sessionId = event.sessionId;
    }
    if (event.provider !== undefined) {
      stored.provider = event.provider;
    }
    if (event.model !== undefined) {
      stored.model = event.model;
    }
    if (event.kind !== undefined) {
      stored.kind = event.kind;
    }
    if (event.durationMs !== undefined) {
      stored.durationMs = event.durationMs;
    }

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(stored)}\n`, "utf8");
  }

  async entries(): Promise<LocalUsageEvent[]> {
    return readNdjsonFile<LocalUsageEvent>(this.filePath);
  }

  async summarize(options: {
    sinceMs?: number;
    budgetUsd?: number;
    sessionBudgetUsd?: number;
  } = {}): Promise<LocalUsageSummary> {
    const events = (await this.entries()).filter((event) => {
      if (options.sinceMs === undefined) {
        return true;
      }

      return Date.parse(event.timestamp) >= options.sinceMs;
    });
    const totals = emptyUsageTotals();
    const byCell: Record<string, LocalUsageTotals> = {};
    const byAgent: Record<string, LocalUsageTotals> = {};
    const byConsumer = new Map<
      string,
      {
        scope: LocalUsageEvent["scope"];
        name: string;
        totals: LocalUsageTotals;
      }
    >();
    const buckets = new Map<string, LocalUsageTotals>();

    for (const event of events) {
      addUsage(totals, event);
      addUsage((byCell[event.cell] ??= emptyUsageTotals()), event);

      if (event.scope === "agent") {
        addUsage((byAgent[event.name] ??= emptyUsageTotals()), event);
      }

      const consumerKey = `${event.scope}:${event.name}`;
      let consumer = byConsumer.get(consumerKey);

      if (!consumer) {
        consumer = {
          scope: event.scope,
          name: event.name,
          totals: emptyUsageTotals(),
        };
        byConsumer.set(consumerKey, consumer);
      }
      addUsage(consumer.totals, event);

      const bucket = hourlyBucket(event.timestamp);
      addUsage((buckets.get(bucket) ?? setUsageBucket(buckets, bucket)), event);
    }

    return {
      events,
      totals,
      byCell,
      byAgent,
      timeSeries: [...buckets.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([bucket, bucketTotals]) => ({ bucket, ...bucketTotals })),
      topConsumers: [...byConsumer.values()]
        .sort(
          (left, right) =>
            right.totals.estimatedCostUsd - left.totals.estimatedCostUsd ||
            right.totals.totalTokens - left.totals.totalTokens ||
            right.totals.invocations - left.totals.invocations,
        )
        .slice(0, 10),
      budgets: usageBudgetSummaries({
        totals,
        events,
        ...(options.budgetUsd === undefined
          ? {}
          : { budgetUsd: options.budgetUsd }),
        ...(options.sessionBudgetUsd === undefined
          ? {}
          : { sessionBudgetUsd: options.sessionBudgetUsd }),
      }),
    };
  }
}

export class LocalEventAdapter implements EventAdapter {
  constructor(private readonly filePath: string) {}

  async publish(name: string, payload: unknown): Promise<void> {
    const entries = await readJsonFile<
      Array<{ name: string; payload: unknown }>
    >(this.filePath, []);

    entries.push({ name, payload });
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify(entries, null, 2)}\n`,
      "utf8",
    );
  }
}

export class LocalJobAdapter implements JobAdapter {
  constructor(private readonly filePath: string) {}

  async enqueue(name: string, payload: unknown): Promise<{ id: string }> {
    const entries = await this.entries();
    const id = `job_${entries.length + 1}`;

    entries.push({
      id,
      name,
      payload,
      status: "queued",
      createdAt: new Date().toISOString(),
    });
    await this.write(entries);

    return { id };
  }

  async entries(): Promise<LocalJobEntry[]> {
    return readJsonFile<LocalJobEntry[]>(this.filePath, []);
  }

  async markRan(id: string): Promise<void> {
    const entries = await this.entries();
    const entry = entries.find((job) => job.id === id);

    if (entry) {
      entry.status = "ran";
      entry.ranAt = new Date().toISOString();
      await this.write(entries);
    }
  }

  private async write(entries: LocalJobEntry[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify(entries, null, 2)}\n`,
      "utf8",
    );
  }
}

export type LocalJobEntry = {
  id: string;
  name: string;
  payload: unknown;
  status: "queued" | "ran";
  createdAt: string;
  ranAt?: string;
};

export type LocalAgentSessionStatus = "idle" | "running" | "failed";

export type LocalAgentSessionChannel = {
  name: string;
  provider: string;
  key: string;
};

export type LocalAgentSessionEvent = {
  id: number;
  sessionId: string;
  type:
    | "session.created"
    | "channel.message"
    | "channel.reply"
    | "message.user"
    | "message.assistant"
    | "tool.calls"
    | "approval.required"
    | "session.failed";
  timestamp: string;
  data: unknown;
};

export type LocalAgentSessionRecord = {
  sessionId: string;
  agent: string;
  channel?: LocalAgentSessionChannel;
  status: LocalAgentSessionStatus;
  createdAt: string;
  updatedAt: string;
  continuationToken: string;
  events: LocalAgentSessionEvent[];
};

export class LocalAgentSessionAdapter {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async create(
    agent: string,
    channel?: LocalAgentSessionChannel,
  ): Promise<LocalAgentSessionRecord> {
    return this.exclusive(async () => {
      const sessions = await this.read();
      const now = new Date().toISOString();
      const session: LocalAgentSessionRecord = {
        sessionId: `session_${randomUUID()}`,
        agent,
        ...(channel === undefined ? {} : { channel }),
        status: "idle",
        createdAt: now,
        updatedAt: now,
        continuationToken: "0",
        events: [],
      };

      sessions.push(session);
      await this.write(sessions);
      await this.appendUnlocked(sessions, session.sessionId, {
        type: "session.created",
        data: { agent },
        timestamp: now,
      });

      return (await this.read()).find(
        (candidate) => candidate.sessionId === session.sessionId,
      ) ?? session;
    });
  }

  async get(sessionId: string): Promise<LocalAgentSessionRecord | null> {
    return (
      (await this.read()).find((session) => session.sessionId === sessionId) ??
      null
    );
  }

  async findForChannel(
    channel: LocalAgentSessionChannel,
  ): Promise<LocalAgentSessionRecord | null> {
    return (
      (await this.read()).find(
        (session) =>
          session.channel?.name === channel.name &&
          session.channel.provider === channel.provider &&
          session.channel.key === channel.key,
      ) ?? null
    );
  }

  async append(
    sessionId: string,
    input: Omit<LocalAgentSessionEvent, "id" | "sessionId" | "timestamp"> & {
      timestamp?: string;
    },
  ): Promise<LocalAgentSessionEvent> {
    return this.exclusive(async () => {
      const sessions = await this.read();
      return this.appendUnlocked(sessions, sessionId, input);
    });
  }

  private async appendUnlocked(
    sessions: LocalAgentSessionRecord[],
    sessionId: string,
    input: Omit<LocalAgentSessionEvent, "id" | "sessionId" | "timestamp"> & {
      timestamp?: string;
    },
  ): Promise<LocalAgentSessionEvent> {
    const session = sessions.find(
      (candidate) => candidate.sessionId === sessionId,
    );

    if (!session) {
      throw new RuntimeError(
        "HANDLER_NOT_FOUND",
        `No agent session '${sessionId}' was found.`,
        404,
        { sessionId },
      );
    }

    const event: LocalAgentSessionEvent = {
      id: session.events.length + 1,
      sessionId,
      timestamp: input.timestamp ?? new Date().toISOString(),
      type: input.type,
      data: input.data,
    };

    session.events.push(event);
    session.updatedAt = event.timestamp;
    session.continuationToken = String(event.id);
    await this.write(sessions);

    return event;
  }

  async complete(
    sessionId: string,
    status: LocalAgentSessionStatus,
  ): Promise<void> {
    await this.exclusive(async () => {
      const sessions = await this.read();
      const session = sessions.find(
        (candidate) => candidate.sessionId === sessionId,
      );

      if (!session) {
        return;
      }

      session.status = status;
      session.updatedAt = new Date().toISOString();
      await this.write(sessions);
    });
  }

  private async read(): Promise<LocalAgentSessionRecord[]> {
    return readJsonFile<LocalAgentSessionRecord[]>(this.filePath, []);
  }

  private async write(sessions: LocalAgentSessionRecord[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify(sessions, null, 2)}\n`,
      "utf8",
    );
  }
}

export class LocalWorkflowAdapter implements WorkflowAdapter {
  private app: AppDefinition | null = null;
  private host: RuntimeHost | null = null;
  private readonly active = new Map<string, Promise<WorkflowRun>>();

  constructor(private readonly filePath: string) {}

  bind(app: AppDefinition, host: RuntimeHost): void {
    this.app = app;
    this.host = host;
  }

  async start(name: string, input: unknown): Promise<{ runId: string }> {
    const run = await this.createRun(name, input);

    void this.execute(run).catch(() => {
      // Failures are recorded on the persisted run state.
    });

    return { runId: run.runId };
  }

  async startAndWait(name: string, input: unknown): Promise<WorkflowRun> {
    const run = await this.createRun(name, input);

    return this.execute(run);
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const runs = await this.listRuns();

    return runs.find((run) => run.runId === runId) ?? null;
  }

  async listRuns(): Promise<WorkflowRun[]> {
    return readJsonFile<WorkflowRun[]>(this.filePath, []);
  }

  async resumeInterrupted(): Promise<WorkflowRun[]> {
    const interrupted = (await this.listRuns()).filter(
      (run) => run.status === "running",
    );

    return Promise.all(interrupted.map((run) => this.execute(run)));
  }

  async waitForActiveRuns(): Promise<void> {
    await Promise.allSettled([...this.active.values()]);
  }

  private async createRun(name: string, input: unknown): Promise<WorkflowRun> {
    const definition = this.requireWorkflow(name);
    const runs = await this.listRuns();
    const run = createWorkflowRun({
      runId: `run_${randomUUID()}`,
      workflow: name,
      definition,
      input,
    });

    runs.push(run);
    await this.write(runs);

    return run;
  }

  private async execute(run: WorkflowRun): Promise<WorkflowRun> {
    const definition = this.requireWorkflow(run.workflow);
    const host = this.requireHost();
    const execution = executeWorkflowRun({
      workflow: definition,
      host,
      run,
      save: (next) => this.save(next),
    }).finally(() => {
      this.active.delete(run.runId);
    });

    this.active.set(run.runId, execution);

    return execution;
  }

  private async save(run: WorkflowRun): Promise<void> {
    const runs = await this.listRuns();
    const index = runs.findIndex((entry) => entry.runId === run.runId);

    if (index >= 0) {
      runs[index] = run;
    } else {
      runs.push(run);
    }

    await this.write(runs);
  }

  private async write(runs: WorkflowRun[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify(runs, null, 2)}\n`,
      "utf8",
    );
  }

  private requireWorkflow(name: string) {
    const definition = this.app?.workflows?.[name];

    if (!definition) {
      throw new RuntimeError(
        "HANDLER_NOT_FOUND",
        `No workflow handler named '${name}' is defined.`,
        404,
        { kind: "workflow", name },
      );
    }

    return definition;
  }

  private requireHost(): RuntimeHost {
    if (!this.host) {
      throw new RuntimeError(
        "ADAPTER_ERROR",
        "Local workflow adapter is not bound to an app definition yet.",
        500,
      );
    }

    return this.host;
  }
}

export class LocalTraceAdapter implements TraceAdapter {
  private readonly redactor: TraceRedactor;

  constructor(
    private readonly filePath: string,
    options: { redactor?: TraceRedactor } = {},
  ) {
    this.redactor = options.redactor ?? redactTraceValue;
  }

  async start(input: TraceStartInput): Promise<TraceRecord> {
    const traces = await this.read();
    const existing = traces.find((trace) => trace.traceId === input.traceId);

    if (existing) {
      return existing;
    }

    const now = input.startedAt ?? new Date().toISOString();
    const trace: TraceRecord = {
      traceId: input.traceId,
      kind: input.kind,
      name: input.name,
      subjectId: input.subjectId,
      status: "running",
      startedAt: now,
      updatedAt: now,
      events: [],
    };

    traces.push(trace);
    await this.write(traces);

    if (input.attributes !== undefined) {
      await this.event(input.traceId, {
        type:
          input.kind === "agent" ? "agent.invoke.started" : "workflow.started",
        name: input.name,
        status: "running",
        timestamp: now,
        attributes: input.attributes,
      });
    }

    return trace;
  }

  async event(traceId: string, input: TraceEventInput): Promise<void> {
    const traces = await this.read();
    const trace = traces.find((candidate) => candidate.traceId === traceId);

    if (!trace) {
      return;
    }

    const timestamp = input.timestamp ?? new Date().toISOString();

    trace.events.push({
      eventId: input.eventId ?? `event_${trace.events.length + 1}`,
      traceId,
      timestamp,
      type: input.type,
      name: input.name,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.durationMs === undefined
        ? {}
        : { durationMs: input.durationMs }),
      ...(input.attributes === undefined
        ? {}
        : {
            attributes: this.redactor(input.attributes) as Record<
              string,
              unknown
            >,
          }),
    });
    trace.updatedAt = timestamp;
    await this.write(traces);
  }

  async complete(traceId: string, input: TraceCompleteInput): Promise<void> {
    const traces = await this.read();
    const trace = traces.find((candidate) => candidate.traceId === traceId);

    if (!trace) {
      return;
    }

    const completedAt = input.completedAt ?? new Date().toISOString();

    trace.status = input.status;
    trace.completedAt = completedAt;
    trace.updatedAt = completedAt;

    if (input.attributes !== undefined) {
      trace.events.push({
        eventId: `event_${trace.events.length + 1}`,
        traceId,
        timestamp: completedAt,
        type:
          trace.kind === "agent"
            ? input.status === "failed"
              ? "agent.invoke.failed"
              : "agent.invoke.completed"
            : input.status === "failed"
              ? "workflow.failed"
              : "workflow.completed",
        name: trace.name,
        status: input.status,
        attributes: this.redactor(input.attributes) as Record<string, unknown>,
      });
    }

    await this.write(traces);
  }

  async get(traceId: string): Promise<TraceRecord | null> {
    return (
      (await this.read()).find((trace) => trace.traceId === traceId) ?? null
    );
  }

  async list(): Promise<TraceRecord[]> {
    return this.read();
  }

  private async read(): Promise<TraceRecord[]> {
    return readJsonFile<TraceRecord[]>(this.filePath, []);
  }

  private async write(traces: TraceRecord[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify(traces, null, 2)}\n`,
      "utf8",
    );
  }
}

type LocalRequestOptions = {
  app: AppDefinition;
  manifest: unknown;
  host: LocalRuntimeHost;
  agentRuntime: AgentRuntime;
  agentProviders: AgentProviderRegistry;
  services: ServiceSupervisor;
  runtimeUrl: string;
  clientUrl: string;
  request: IncomingMessage;
  response: ServerResponse;
};

async function handleLocalRequest(options: LocalRequestOptions): Promise<void> {
  try {
    const url = new URL(options.request.url ?? "/", options.runtimeUrl);
    const method = options.request.method ?? "GET";

    if (method === "GET" && url.pathname === "/_anvil/health") {
      await sendJson(options.response, 200, {
        ok: true,
        status: "running",
      });
      return;
    }

    if (method === "GET" && url.pathname === "/_anvil/lens") {
      options.response.statusCode = 200;
      options.response.setHeader("content-type", "text/html; charset=utf-8");
      options.response.end(lensPageHtml);
      return;
    }

    if (method === "GET" && url.pathname === "/_anvil/manifest") {
      await sendJson(options.response, 200, {
        ok: true,
        manifest: options.manifest,
      });
      return;
    }

    if (method === "GET" && url.pathname === "/_anvil/agents") {
      await sendJson(options.response, 200, {
        ok: true,
        agents: Object.keys(options.app.agents ?? {}),
        providers: options.agentProviders.list(),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/_anvil/channels/simulate") {
      await simulateChannelMessageRoute(options);
      return;
    }

    if (
      method === "POST" &&
      url.pathname.startsWith("/_anvil/agents/") &&
      url.pathname.endsWith("/sessions")
    ) {
      await createAgentSessionRoute(options, url);
      return;
    }

    if (
      method === "POST" &&
      url.pathname.startsWith("/_anvil/agents/sessions/") &&
      url.pathname.endsWith("/messages")
    ) {
      await sendAgentSessionMessageRoute(options, url);
      return;
    }

    if (
      method === "GET" &&
      url.pathname.startsWith("/_anvil/agents/sessions/") &&
      url.pathname.endsWith("/stream")
    ) {
      await streamAgentSessionRoute(options, url);
      return;
    }

    if (method === "POST" && url.pathname.startsWith("/_anvil/agents/")) {
      const name = decodeURIComponent(
        url.pathname.slice("/_anvil/agents/".length),
      );
      const agent = options.app.agents?.[name];

      if (!agent) {
        await sendJson(options.response, 404, {
          ok: false,
          error: {
            code: "AGENT_NOT_FOUND",
            message: `No mounted agent '${name}' is defined.`,
          },
        });
        return;
      }

      const body = await readJsonRequest(options.request);

      if (!isObject(body) || typeof body.input !== "string") {
        await sendJson(options.response, 400, {
          ok: false,
          error: {
            code: "AGENT_INPUT_INVALID",
            message: "Agent invocation requires a string 'input'.",
          },
        });
        return;
      }

      const invocationInput = {
        input: body.input,
        ...(isObject(body.context) ? { context: body.context } : {}),
      };
      const startedAt = Date.now();
      const result = await options.agentRuntime.invoke(agent, invocationInput);
      await options.host.usage.record({
        scope: "agent",
        name: agent.name,
        provider: agent.model.provider,
        model: agent.model.model,
        durationMs: Date.now() - startedAt,
        invocations: 1,
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? 0,
        estimatedCostUsd: estimateInferenceCostUsd(agent.model, result.usage),
        sandboxRuntimeMs: 0,
        ...optionalSessionId(invocationInput.context),
      });

      await sendJson(options.response, 200, {
        ok: true,
        result,
      });
      return;
    }

    if (method === "GET" && url.pathname === "/_anvil/inspect") {
      await sendJson(options.response, 200, await inspectLocalRuntime(options));
      return;
    }

    if (method === "GET" && url.pathname === "/_anvil/logs") {
      await sendJson(options.response, 200, {
        ok: true,
        logs: await options.host.logs.entries(),
      });
      return;
    }

    if (method === "GET" && url.pathname === "/_anvil/traces") {
      await sendJson(options.response, 200, {
        ok: true,
        traces: await options.host.traces.list(),
      });
      return;
    }

    if (method === "GET" && url.pathname.startsWith("/_anvil/traces/")) {
      const traceId = decodeURIComponent(
        url.pathname.slice("/_anvil/traces/".length),
      );
      const trace = await options.host.traces.get(traceId);

      if (!trace) {
        await sendJson(options.response, 404, {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `No trace '${traceId}' was found.`,
          },
        });
        return;
      }

      await sendJson(options.response, 200, { ok: true, trace });
      return;
    }

    if (method === "GET" && url.pathname === "/_anvil/usage") {
      const since = parseLocalSince(url.searchParams.get("since"));
      const summary = await options.host.usage.summarize({
        ...(since === undefined ? {} : { sinceMs: since }),
        ...usageBudgetOptions(options.host.env),
      });

      await sendJson(options.response, 200, {
        ok: true,
        usage: summary,
      });
      return;
    }

    if (method === "GET" && url.pathname === "/_anvil/db/tables") {
      await sendJson(options.response, 200, {
        ok: true,
        database: await options.host.db.inspect(),
      });
      return;
    }

    if (method === "GET" && url.pathname.startsWith("/_anvil/db/")) {
      const table = decodeURIComponent(
        url.pathname.slice("/_anvil/db/".length),
      );

      await sendJson(options.response, 200, {
        ok: true,
        table,
        rows: await options.host.db.dumpTable(table),
      });
      return;
    }

    if (method === "POST" && url.pathname.startsWith("/_anvil/auth/as/")) {
      const userId = decodeURIComponent(
        url.pathname.slice("/_anvil/auth/as/".length),
      );
      const identity = await ensureLocalUserIdentity(options.host, userId);

      await options.host.auth.setCurrent(identity);
      await sendJson(options.response, 200, {
        ok: true,
        auth: {
          currentUser: identity,
        },
      });
      return;
    }

    if (method === "GET" && url.pathname === "/_anvil/auth/users") {
      await sendJson(options.response, 200, {
        ok: true,
        users: await options.host.idp.listUsers(),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/_anvil/auth/users") {
      const body = await readJsonRequest(options.request);

      if (!isObject(body) || typeof body.userId !== "string") {
        await sendJson(options.response, 400, {
          ok: false,
          error: {
            code: "AUTH_INVALID_USER",
            message: "A 'userId' string is required.",
          },
        });
        return;
      }

      try {
        const user = await options.host.idp.createUser(localUserFromBody(body));

        await sendJson(options.response, 201, { ok: true, user });
      } catch (error) {
        await sendAuthError(options.response, error);
      }
      return;
    }

    if (method === "DELETE" && url.pathname.startsWith("/_anvil/auth/users/")) {
      const userId = decodeURIComponent(
        url.pathname.slice("/_anvil/auth/users/".length),
      );
      const deleted = await options.host.idp.deleteUser(userId);

      await sendJson(options.response, deleted ? 200 : 404, {
        ok: deleted,
        deleted,
      });
      return;
    }

    if (method === "POST" && url.pathname === "/_anvil/auth/token") {
      const body = await readJsonRequest(options.request);

      if (!isObject(body) || typeof body.userId !== "string") {
        await sendJson(options.response, 400, {
          ok: false,
          error: {
            code: "AUTH_INVALID_USER",
            message: "A 'userId' string is required.",
          },
        });
        return;
      }

      try {
        await ensureLocalUserIdentity(options.host, body.userId);

        const issued = await options.host.idp.issueToken(
          body.userId,
          typeof body.ttlSeconds === "number"
            ? { ttlSeconds: body.ttlSeconds }
            : {},
        );

        await sendJson(options.response, 200, { ok: true, ...issued });
      } catch (error) {
        await sendAuthError(options.response, error);
      }
      return;
    }

    if (method === "GET" && url.pathname === "/_anvil/auth/jwks") {
      await sendJson(
        options.response,
        200,
        await options.host.idp.publicJwks(),
      );
      return;
    }

    if (method === "GET" && url.pathname === "/_anvil/auth/whoami") {
      const token = readBearerToken(options.request);

      if (!token) {
        await sendJson(options.response, 200, {
          ok: true,
          identity: await options.host.auth.current(),
          source: "ambient",
        });
        return;
      }

      try {
        const verified = await options.host.idp.verifyToken(token);

        await sendJson(options.response, 200, {
          ok: true,
          identity: verified.identity,
          source: "token",
          expiresAt: verified.expiresAt,
        });
      } catch (error) {
        await sendAuthError(options.response, error);
      }
      return;
    }

    if (method === "POST" && url.pathname.startsWith("/_anvil/query/")) {
      const body = await readJsonRequest(options.request);
      const auth = await resolveRequestAuth(options, body);

      if (auth.kind === "rejected") {
        return;
      }

      await runRuntimeRequest(options, {
        kind: "query",
        name: decodeURIComponent(url.pathname.slice("/_anvil/query/".length)),
        input: readInputFromBody(body),
        auth: auth.identity,
        requestId: randomUUID(),
      });
      return;
    }

    if (method === "POST" && url.pathname.startsWith("/_anvil/mutation/")) {
      const body = await readJsonRequest(options.request);
      const auth = await resolveRequestAuth(options, body);

      if (auth.kind === "rejected") {
        return;
      }

      await runRuntimeRequest(options, {
        kind: "mutation",
        name: decodeURIComponent(
          url.pathname.slice("/_anvil/mutation/".length),
        ),
        input: readInputFromBody(body),
        auth: auth.identity,
        requestId: randomUUID(),
      });
      return;
    }

    if (
      method === "POST" &&
      url.pathname.startsWith("/_anvil/workflows/run/")
    ) {
      const body = await readJsonRequest(options.request);
      const name = decodeURIComponent(
        url.pathname.slice("/_anvil/workflows/run/".length),
      );

      try {
        const started = await options.host.workflows.start(
          name,
          isObject(body) && "input" in body ? body.input : {},
        );

        await sendJson(options.response, 200, {
          ok: true,
          runId: started.runId,
        });
      } catch (error) {
        await sendWorkflowError(options.response, error);
      }
      return;
    }

    if (method === "GET" && url.pathname === "/_anvil/workflows") {
      await sendJson(options.response, 200, {
        ok: true,
        runs: await options.host.workflows.listRuns(),
      });
      return;
    }

    if (method === "GET" && url.pathname.startsWith("/_anvil/workflows/")) {
      const runId = decodeURIComponent(
        url.pathname.slice("/_anvil/workflows/".length),
      );
      const run = await options.host.workflows.getRun(runId);

      if (!run) {
        await sendJson(options.response, 404, {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `No workflow run '${runId}' was found.`,
          },
        });
        return;
      }

      await sendJson(options.response, 200, { ok: true, run });
      return;
    }

    if (method === "GET" && url.pathname === "/_anvil/services") {
      await sendJson(options.response, 200, {
        ok: true,
        services: options.services.status(),
      });
      return;
    }

    if (method === "POST" && url.pathname.startsWith("/_anvil/services/")) {
      const action = url.pathname.endsWith("/stop")
        ? "stop"
        : url.pathname.endsWith("/start")
          ? "start"
          : null;

      if (action) {
        const name = decodeURIComponent(
          url.pathname.slice(
            "/_anvil/services/".length,
            url.pathname.length - `/${action}`.length,
          ),
        );

        try {
          const service =
            action === "stop"
              ? await options.services.stop(name)
              : await options.services.start(name);

          await sendJson(options.response, 200, { ok: true, service });
        } catch (error) {
          await sendServiceError(options.response, error);
        }
        return;
      }
    }

    if (method === "POST" && url.pathname.startsWith("/_anvil/jobs/run/")) {
      const body = await readJsonRequest(options.request);
      const name = decodeURIComponent(
        url.pathname.slice("/_anvil/jobs/run/".length),
      );

      await runRuntimeRequest(options, {
        kind: "job",
        name,
        payload: isObject(body) && "payload" in body ? body.payload : {},
        requestId: randomUUID(),
      });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const body = await readRawBody(options.request);
      const auth = await resolveRequestAuth(options, undefined);

      if (auth.kind === "rejected") {
        return;
      }

      await runRuntimeRequest(options, {
        kind: "endpoint",
        method,
        path: url.pathname,
        headers: headersFrom(options.request),
        body: body.length > 0 ? new Uint8Array(body) : null,
        auth: auth.identity,
        requestId: randomUUID(),
      });
      return;
    }

    await sendJson(options.response, 404, {
      ok: false,
      error: {
        code: "LOCAL_ROUTE_NOT_FOUND",
        message: `No local runtime route matched ${method} ${url.pathname}.`,
      },
    });
  } catch (error) {
    await sendJson(options.response, 500, {
      ok: false,
      error: {
        code: "LOCAL_RUNTIME_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function createAgentSessionRoute(
  options: LocalRequestOptions,
  url: URL,
): Promise<void> {
  const name = decodeURIComponent(
    url.pathname.slice(
      "/_anvil/agents/".length,
      url.pathname.length - "/sessions".length,
    ),
  );
  const agent = options.app.agents?.[name];

  if (!agent) {
    await sendJson(options.response, 404, {
      ok: false,
      error: {
        code: "AGENT_NOT_FOUND",
        message: `No mounted agent '${name}' is defined.`,
      },
    });
    return;
  }

  const session = await options.host.agentSessions.create(name);

  await sendJson(options.response, 201, {
    ok: true,
    result: {
      session: sessionSummary(session),
    },
    session: sessionSummary(session),
  });
}

async function sendAgentSessionMessageRoute(
  options: LocalRequestOptions,
  url: URL,
): Promise<void> {
  const sessionId = decodeURIComponent(
    url.pathname.slice(
      "/_anvil/agents/sessions/".length,
      url.pathname.length - "/messages".length,
    ),
  );
  const session = await options.host.agentSessions.get(sessionId);

  if (!session) {
    await sendJson(options.response, 404, {
      ok: false,
      error: {
        code: "AGENT_SESSION_NOT_FOUND",
        message: `No agent session '${sessionId}' was found.`,
      },
    });
    return;
  }

  const agent = options.app.agents?.[session.agent];

  if (!agent) {
    await sendJson(options.response, 404, {
      ok: false,
      error: {
        code: "AGENT_NOT_FOUND",
        message: `No mounted agent '${session.agent}' is defined.`,
      },
    });
    return;
  }

  const body = await readJsonRequest(options.request);

  if (!isObject(body) || typeof body.input !== "string") {
    await sendJson(options.response, 400, {
      ok: false,
      error: {
        code: "AGENT_INPUT_INVALID",
        message: "Agent session messages require a string 'input'.",
      },
    });
    return;
  }

  try {
    const messagePayload = await sendAgentSessionMessage(options, {
      session,
      input: body.input,
      context: isObject(body.context) ? body.context : {},
    });

    await sendJson(options.response, 200, {
      ok: true,
      result: messagePayload,
      session: messagePayload.session,
      events: messagePayload.events,
      continuationToken: messagePayload.continuationToken,
    });
  } catch (error) {
    await sendServiceError(options.response, error);
  }
}

async function simulateChannelMessageRoute(
  options: LocalRequestOptions,
): Promise<void> {
  const body = await readJsonRequest(options.request);

  if (!isObject(body) || typeof body.channel !== "string") {
    await sendJson(options.response, 400, {
      ok: false,
      error: {
        code: "CHANNEL_INPUT_INVALID",
        message: "Channel simulation requires a string 'channel'.",
      },
    });
    return;
  }

  if (typeof body.input !== "string" || body.input.length === 0) {
    await sendJson(options.response, 400, {
      ok: false,
      error: {
        code: "CHANNEL_INPUT_INVALID",
        message: "Channel simulation requires a non-empty string 'input'.",
      },
    });
    return;
  }

  const channelName = body.channel;
  const channel = options.app.channels?.[channelName];

  if (!channel) {
    await sendJson(options.response, 404, {
      ok: false,
      error: {
        code: "CHANNEL_NOT_FOUND",
        message: `No channel '${channelName}' is defined.`,
      },
    });
    return;
  }

  const agent = options.app.agents?.[channel.agent];

  if (!agent) {
    await sendJson(options.response, 404, {
      ok: false,
      error: {
        code: "AGENT_NOT_FOUND",
        message: `No mounted agent '${channel.agent}' is defined.`,
      },
    });
    return;
  }

  const sender =
    typeof body.sender === "string" && body.sender.length > 0
      ? body.sender
      : "local-user";
  const thread =
    typeof body.thread === "string" && body.thread.length > 0
      ? body.thread
      : "local-thread";
  const channelSession = {
    name: channelName,
    provider: channel.provider,
    key: channelSessionKey(channel.sessionKey ?? "thread", {
      channel: channelName,
      sender,
      thread,
    }),
  };
  const existing =
    await options.host.agentSessions.findForChannel(channelSession);
  const session =
    existing ??
    (await options.host.agentSessions.create(channel.agent, channelSession));
  try {
    const messagePayload = await sendAgentSessionMessage(options, {
      session,
      input: body.input,
      eventType: "channel.message",
      context: {
        ...(isObject(body.context) ? body.context : {}),
        channel: {
          name: channelName,
          provider: channel.provider,
          sender,
          thread,
        },
      },
    });
    const reply = messagePayload.events
      .filter((event) => event.type === "channel.reply")
      .map((event) => event.data);

    await sendJson(options.response, 200, {
      ok: true,
      result: {
        channel: {
          name: channelName,
          provider: channel.provider,
          sessionKey: channel.sessionKey ?? "thread",
        },
        session: messagePayload.session,
        events: messagePayload.events,
        continuationToken: messagePayload.continuationToken,
        reply,
      },
    });
  } catch (error) {
    await sendServiceError(options.response, error);
  }
}

async function sendAgentSessionMessage(
  options: LocalRequestOptions,
  input: {
    session: LocalAgentSessionRecord;
    input: string;
    context: Record<string, unknown>;
    eventType?: "channel.message" | "message.user";
  },
): Promise<{
  session: Omit<LocalAgentSessionRecord, "events">;
  events: LocalAgentSessionEvent[];
  continuationToken: string;
  result: Awaited<ReturnType<AgentRuntime["invoke"]>>;
}> {
  const userEvent = await options.host.agentSessions.append(
    input.session.sessionId,
    {
      type: input.eventType ?? "message.user",
      data: { input: input.input, context: input.context },
    },
  );

  await options.host.agentSessions.complete(input.session.sessionId, "running");

  try {
    const agent = options.app.agents?.[input.session.agent];

    if (!agent) {
      throw new Error(`No mounted agent '${input.session.agent}' is defined.`);
    }

    const result = await options.agentRuntime.invoke(agent, {
      input: input.input,
      context: {
        ...input.context,
        sessionId: input.session.sessionId,
      },
    });
    const events: LocalAgentSessionEvent[] = [
      userEvent,
      await options.host.agentSessions.append(input.session.sessionId, {
        type:
          input.eventType === "channel.message"
            ? "channel.reply"
            : "message.assistant",
        data: {
          message: result.response,
          usage: result.usage,
        },
      }),
    ];

    if (result.approvalsRequired.length > 0) {
      events.push(
        await options.host.agentSessions.append(input.session.sessionId, {
          type: "approval.required",
          data: { approvals: result.approvalsRequired },
        }),
      );
    }

    if (result.toolCalls.length > 0) {
      events.push(
        await options.host.agentSessions.append(input.session.sessionId, {
          type: "tool.calls",
          data: { toolCalls: result.toolCalls },
        }),
      );
    }

    await options.host.agentSessions.complete(input.session.sessionId, "idle");
    const sessionPayload = sessionSummary(
      (await options.host.agentSessions.get(input.session.sessionId)) ??
        input.session,
    );

    return {
      session: sessionPayload,
      events,
      continuationToken: continuationTokenFor(events),
      result,
    };
  } catch (error) {
    const failed = await options.host.agentSessions.append(
      input.session.sessionId,
      {
        type: "session.failed",
        data: {
          message: error instanceof Error ? error.message : String(error),
        },
      },
    );

    await options.host.agentSessions.complete(
      input.session.sessionId,
      "failed",
    );

    throw new RuntimeError(
      "INTERNAL_ERROR",
      error instanceof Error ? error.message : String(error),
      500,
      {
        events: [userEvent, failed],
        continuationToken: String(failed.id),
      },
    );
  }
}

async function streamAgentSessionRoute(
  options: LocalRequestOptions,
  url: URL,
): Promise<void> {
  const sessionId = decodeURIComponent(
    url.pathname.slice(
      "/_anvil/agents/sessions/".length,
      url.pathname.length - "/stream".length,
    ),
  );
  const session = await options.host.agentSessions.get(sessionId);

  if (!session) {
    await sendJson(options.response, 404, {
      ok: false,
      error: {
        code: "AGENT_SESSION_NOT_FOUND",
        message: `No agent session '${sessionId}' was found.`,
      },
    });
    return;
  }

  await sendSessionEventStream(
    options.response,
    session.events.filter((event) => event.id > continuationFromUrl(url)),
  );
}

async function sendSessionEventStream(
  response: ServerResponse,
  events: LocalAgentSessionEvent[],
): Promise<void> {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache");

  for (const event of events) {
    await writeSseEvent(response, event);
  }

  response.end();
}

async function writeSseEvent(
  response: ServerResponse,
  event: LocalAgentSessionEvent,
): Promise<void> {
  const payload = [
    `id: ${event.id}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ].join("\n");

  if (response.write(payload)) {
    return;
  }

  await new Promise<void>((resolve) => {
    response.once("drain", resolve);
  });
}

function continuationFromUrl(url: URL): number {
  const raw = url.searchParams.get("after");
  const parsed = raw === null ? 0 : Number.parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function continuationTokenFor(events: LocalAgentSessionEvent[]): string {
  return String(events.at(-1)?.id ?? 0);
}

function channelSessionKey(
  strategy: "channel" | "sender" | "sender-thread" | "thread",
  input: { channel: string; sender: string; thread: string },
): string {
  switch (strategy) {
    case "channel":
      return input.channel;
    case "sender":
      return `${input.channel}:${input.sender}`;
    case "sender-thread":
      return `${input.channel}:${input.sender}:${input.thread}`;
    case "thread":
      return `${input.channel}:${input.thread}`;
  }
}

function sessionSummary(
  session: LocalAgentSessionRecord,
): Omit<LocalAgentSessionRecord, "events"> {
  return {
    sessionId: session.sessionId,
    agent: session.agent,
    ...(session.channel === undefined ? {} : { channel: session.channel }),
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    continuationToken: session.continuationToken,
  };
}

type ClientRequestOptions = {
  clientDistDir: string;
  runtimeUrl: string;
  request: IncomingMessage;
  response: ServerResponse;
};

async function handleClientRequest(
  options: ClientRequestOptions,
): Promise<void> {
  try {
    const url = new URL(options.request.url ?? "/", "http://localhost");

    if (
      url.pathname.startsWith("/_anvil/") ||
      url.pathname.startsWith("/api/")
    ) {
      await proxyToRuntime(options, url);
      return;
    }

    await serveClientFile(options, url);
  } catch (error) {
    await sendJson(options.response, 500, {
      ok: false,
      error: {
        code: "LOCAL_CLIENT_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function proxyToRuntime(
  options: ClientRequestOptions,
  url: URL,
): Promise<void> {
  const body = await readRawBody(options.request);
  const target = new URL(`${url.pathname}${url.search}`, options.runtimeUrl);
  const init: RequestInit = {
    method: options.request.method ?? "GET",
    headers: headersFrom(options.request),
  };

  if (body.length > 0) {
    init.body = body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer;
  }

  const response = await fetch(target, init);

  options.response.statusCode = response.status;
  response.headers.forEach((value, key) => {
    options.response.setHeader(key, value);
  });
  options.response.end(Buffer.from(await response.arrayBuffer()));
}

async function serveClientFile(
  options: ClientRequestOptions,
  url: URL,
): Promise<void> {
  const filePath = resolveClientFile(options.clientDistDir, url.pathname);
  const served = await tryServeFile(options.response, filePath);

  if (served) {
    return;
  }

  const fallback = await tryServeFile(
    options.response,
    path.join(options.clientDistDir, "index.html"),
  );

  if (!fallback) {
    await sendJson(options.response, 404, {
      ok: false,
      error: {
        code: "LOCAL_CLIENT_NOT_FOUND",
        message: "Client build output was not found.",
      },
    });
  }
}

async function tryServeFile(
  response: ServerResponse,
  filePath: string,
): Promise<boolean> {
  try {
    const info = await stat(filePath);

    if (!info.isFile()) {
      return false;
    }

    response.statusCode = 200;
    response.setHeader("content-type", contentTypeFor(filePath));
    response.end(await readFile(filePath));

    return true;
  } catch {
    return false;
  }
}

function resolveClientFile(rootDir: string, pathname: string): string {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = path.resolve(rootDir, decodeURIComponent(relativePath));
  const root = path.resolve(rootDir);

  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return path.join(root, "index.html");
  }

  return resolved;
}

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".css":
      return "text/css";
    case ".html":
      return "text/html";
    case ".js":
      return "text/javascript";
    case ".json":
      return "application/json";
    case ".map":
      return "application/json";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

async function runRuntimeRequest(
  options: LocalRequestOptions,
  runtimeRequest: RuntimeRequest,
): Promise<void> {
  const startedAt = Date.now();
  const response = await handleRuntimeRequest(
    options.app,
    options.host,
    runtimeRequest,
  );
  await options.host.usage.record({
    scope: "cell",
    name: runtimeRequestName(runtimeRequest),
    kind: runtimeRequest.kind,
    durationMs: Date.now() - startedAt,
    invocations: 1,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    sandboxRuntimeMs: 0,
  });

  await sendRuntimeResponse(options.response, response);
}

async function sendRuntimeResponse(
  response: ServerResponse,
  runtimeResponse: RuntimeResponse,
): Promise<void> {
  if (runtimeResponse.body instanceof Response) {
    await sendWebResponse(response, runtimeResponse.body);
    return;
  }

  await sendJson(response, runtimeResponse.status, {
    ok: runtimeResponse.ok,
    result: runtimeResponse.ok ? runtimeResponse.body : undefined,
    error: runtimeResponse.error,
    diagnostics: runtimeResponse.diagnostics,
  });
}

async function sendWebResponse(
  response: ServerResponse,
  webResponse: Response,
): Promise<void> {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });
  response.end(Buffer.from(await webResponse.arrayBuffer()));
}

async function inspectLocalRuntime(
  options: LocalRequestOptions,
): Promise<Record<string, unknown>> {
  const auth = await options.host.auth.current();
  const logs = await options.host.logs.entries();
  const usage = await options.host.usage.summarize({
    ...usageBudgetOptions(options.host.env),
  });

  return {
    ok: true,
    status: "running",
    runtimeUrl: options.runtimeUrl,
    clientUrl: options.clientUrl,
    manifest: options.manifest,
    auth: {
      currentUser: auth?.userId ?? null,
    },
    database: await options.host.db.inspect(),
    usage: {
      totals: usage.totals,
      topConsumers: usage.topConsumers,
      budgets: usage.budgets,
    },
    recentErrors: logs.filter((entry) => entry.level === "error").slice(-10),
    traces: (await options.host.traces.list()).slice(-20),
  };
}

type ResolvedRequestAuth =
  | { kind: "resolved"; identity: AuthIdentity | null }
  | { kind: "rejected" };

async function resolveRequestAuth(
  options: LocalRequestOptions,
  body: unknown,
): Promise<ResolvedRequestAuth> {
  const token = readBearerToken(options.request);

  if (token) {
    try {
      const verified = await options.host.idp.verifyToken(token);

      return { kind: "resolved", identity: verified.identity };
    } catch (error) {
      await sendAuthError(options.response, error);

      return { kind: "rejected" };
    }
  }

  if (isObject(body) && "auth" in body) {
    return {
      kind: "resolved",
      identity: body.auth === null ? null : (body.auth as AuthIdentity),
    };
  }

  return { kind: "resolved", identity: await options.host.auth.current() };
}

function readBearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;

  if (typeof header !== "string") {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());

  return match?.[1] ?? null;
}

async function ensureLocalUserIdentity(
  host: LocalRuntimeHost,
  userId: string,
): Promise<AuthIdentity> {
  const existing = await host.idp.getUser(userId);
  const user =
    existing ??
    (await host.idp.createUser({
      userId,
      email: `${userId}@local.anvil`,
      roles: ["admin"],
    }));

  const identity: AuthIdentity = { userId: user.userId };

  if (user.email !== undefined) {
    identity.email = user.email;
  }

  if (user.roles !== undefined) {
    identity.roles = user.roles;
  }

  identity.claims = user.claims ?? {};

  return identity;
}

function localUserFromBody(body: Record<string, unknown>): LocalUser {
  const user: LocalUser = { userId: String(body.userId) };

  if (typeof body.email === "string") {
    user.email = body.email;
  }

  if (Array.isArray(body.roles)) {
    user.roles = body.roles.filter(
      (role): role is string => typeof role === "string",
    );
  }

  if (isObject(body.claims)) {
    user.claims = body.claims;
  }

  return user;
}

async function sendAuthError(
  response: ServerResponse,
  error: unknown,
): Promise<void> {
  if (error instanceof AuthError) {
    const status =
      error.code === "USER_NOT_FOUND"
        ? 404
        : error.code === "USER_EXISTS"
          ? 409
          : 401;

    await sendJson(response, status, {
      ok: false,
      error: { code: error.code, message: error.message },
    });
    return;
  }

  await sendJson(response, 500, {
    ok: false,
    error: {
      code: "AUTH_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

async function sendServiceError(
  response: ServerResponse,
  error: unknown,
): Promise<void> {
  if (error instanceof RuntimeError) {
    await sendJson(response, error.status, {
      ok: false,
      error: error.toPayload(),
    });
    return;
  }

  await sendJson(response, 500, {
    ok: false,
    error: {
      code: "LOCAL_RUNTIME_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

async function sendWorkflowError(
  response: ServerResponse,
  error: unknown,
): Promise<void> {
  if (error instanceof RuntimeError) {
    await sendJson(response, error.status, {
      ok: false,
      error: error.toPayload(),
    });
    return;
  }

  await sendJson(response, 500, {
    ok: false,
    error: {
      code: "LOCAL_RUNTIME_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

function readInputFromBody(body: unknown): unknown {
  return isObject(body) && "input" in body ? body.input : body;
}

function runtimeRequestName(request: RuntimeRequest): string {
  return request.kind === "endpoint"
    ? `${request.method} ${request.path}`
    : request.name;
}

function optionalSessionId(
  context: Record<string, unknown> | undefined,
): { sessionId?: string } {
  const sessionId = context?.sessionId;

  return typeof sessionId === "string" ? { sessionId } : {};
}

function estimateInferenceCostUsd(
  model: AgentModelConfig,
  usage: AgentTokenUsage,
): number {
  const inputRate = numberFromModelOption(model, "inputTokenUsdPerMillion");
  const outputRate = numberFromModelOption(model, "outputTokenUsdPerMillion");

  return (
    ((usage.inputTokens ?? 0) / 1_000_000) * inputRate +
    ((usage.outputTokens ?? 0) / 1_000_000) * outputRate
  );
}

function numberFromModelOption(
  model: AgentModelConfig,
  key: string,
): number {
  const value = model.options?.[key];

  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function numberFromEnv(env: LocalEnvAdapter, name: string): number | undefined {
  const value = env.get(name);

  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function usageBudgetOptions(env: LocalEnvAdapter): {
  budgetUsd?: number;
  sessionBudgetUsd?: number;
} {
  const budgetUsd = numberFromEnv(env, "ANVIL_USAGE_DAILY_BUDGET_USD");
  const sessionBudgetUsd = numberFromEnv(
    env,
    "ANVIL_USAGE_SESSION_BUDGET_USD",
  );

  return {
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
    ...(sessionBudgetUsd === undefined ? {} : { sessionBudgetUsd }),
  };
}

function parseLocalSince(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const match = /^(\d+)(s|m|h|d)$/.exec(value);

  if (!match) {
    return undefined;
  }

  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === undefined) {
    return undefined;
  }
  const multipliers: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 60 * 60_000,
    d: 24 * 60 * 60_000,
  };

  return Date.now() - amount * (multipliers[unit] ?? 0);
}

async function readJsonRequest(request: IncomingMessage): Promise<unknown> {
  const body = await readRawBody(request);

  if (body.length === 0) {
    return {};
  }

  return JSON.parse(body.toString("utf8")) as unknown;
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function headersFrom(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers[key] = value;
    } else if (Array.isArray(value)) {
      headers[key] = value.join(", ");
    }
  }

  return headers;
}

async function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): Promise<void> {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(`${JSON.stringify(payload)}\n`);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const data = await readFile(filePath, "utf8");

    return JSON.parse(data) as T;
  } catch {
    return fallback;
  }
}

async function readNdjsonFile<T>(filePath: string): Promise<T[]> {
  try {
    const info = await stat(filePath);

    if (info.size === 0) {
      return [];
    }
  } catch {
    return [];
  }

  const data = await readFile(filePath, "utf8");

  return data
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function cloneRecords(records: DatabaseRecord[]): DatabaseRecord[] {
  return records.map(cloneRecord);
}

function cloneRecord(record: DatabaseRecord): DatabaseRecord {
  return structuredClone(record) as DatabaseRecord;
}

function emptyUsageTotals(): LocalUsageTotals {
  return {
    invocations: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    sandboxRuntimeMs: 0,
  };
}

function addUsage(totals: LocalUsageTotals, event: LocalUsageEvent): void {
  totals.invocations += event.invocations;
  totals.inputTokens += event.inputTokens;
  totals.outputTokens += event.outputTokens;
  totals.totalTokens += event.totalTokens;
  totals.estimatedCostUsd += event.estimatedCostUsd;
  totals.sandboxRuntimeMs += event.sandboxRuntimeMs;
}

function setUsageBucket(
  buckets: Map<string, LocalUsageTotals>,
  bucket: string,
): LocalUsageTotals {
  const totals = emptyUsageTotals();
  buckets.set(bucket, totals);

  return totals;
}

function hourlyBucket(timestamp: string): string {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return "invalid";
  }

  date.setUTCMinutes(0, 0, 0);

  return date.toISOString();
}

function usageBudgetSummaries(options: {
  totals: LocalUsageTotals;
  events: LocalUsageEvent[];
  budgetUsd?: number;
  sessionBudgetUsd?: number;
}): LocalUsageSummary["budgets"] {
  const budgets: LocalUsageSummary["budgets"] = [];

  if (options.budgetUsd !== undefined) {
    budgets.push({
      id: "daily",
      status:
        options.totals.estimatedCostUsd > options.budgetUsd ? "warning" : "ok",
      limitUsd: options.budgetUsd,
      actualUsd: options.totals.estimatedCostUsd,
      message:
        options.totals.estimatedCostUsd > options.budgetUsd
          ? "Daily usage budget exceeded; require approval before resuming costly agent work."
          : "Daily usage is within budget.",
    });
  }

  if (options.sessionBudgetUsd !== undefined) {
    const bySession = new Map<string, number>();

    for (const event of options.events) {
      if (event.sessionId) {
        bySession.set(
          event.sessionId,
          (bySession.get(event.sessionId) ?? 0) + event.estimatedCostUsd,
        );
      }
    }

    const highest = Math.max(0, ...bySession.values());

    budgets.push({
      id: "session",
      status: highest > options.sessionBudgetUsd ? "warning" : "ok",
      limitUsd: options.sessionBudgetUsd,
      actualUsd: highest,
      message:
        highest > options.sessionBudgetUsd
          ? "A session usage budget was exceeded; resume should be approval-gated."
          : "Session usage is within budget.",
    });
  }

  return budgets;
}

function nextId(table: string, rows: DatabaseRecord[]): string {
  let next = rows.length + 1;

  while (rows.some((row) => String(row.id) === `${table}_${next}`)) {
    next += 1;
  }

  return `${table}_${next}`;
}

function compare(
  left: unknown,
  operator: DatabaseWhereOperator,
  right: unknown,
): boolean {
  switch (operator) {
    case "=":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
      return (
        typeof left === "number" && typeof right === "number" && left > right
      );
    case ">=":
      return (
        typeof left === "number" && typeof right === "number" && left >= right
      );
    case "<":
      return (
        typeof left === "number" && typeof right === "number" && left < right
      );
    case "<=":
      return (
        typeof left === "number" && typeof right === "number" && left <= right
      );
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
