import type {
  AuthAdapter,
  AuthIdentity,
  DatabaseAdapter,
  DatabaseInspection,
  DatabaseQueryClient,
  DatabaseRecord,
  DatabaseTableClient,
  DatabaseWhereOperator,
  EnvAdapter,
  EventAdapter,
  FileAdapter,
  JobAdapter,
  LogAdapter,
  LogEntry,
  RuntimeHost,
  WorkflowAdapter,
  WorkflowRun,
} from "./host.js";
import type {
  TraceAdapter,
  TraceCompleteInput,
  TraceEventInput,
  TraceRecord,
  TraceStartInput,
} from "./trace.js";

export type InMemoryRuntimeHost = RuntimeHost & {
  db: InMemoryDatabaseAdapter;
  files: InMemoryFileAdapter;
  env: InMemoryEnvAdapter;
  auth: InMemoryAuthAdapter;
  logs: InMemoryLogAdapter;
  events: InMemoryEventAdapter;
  jobs: InMemoryJobAdapter;
  workflows: InMemoryWorkflowAdapter;
  traces: InMemoryTraceAdapter;
};

export type InMemoryRuntimeHostOptions = {
  auth?: AuthIdentity | null;
  env?: Record<string, string>;
  database?: Record<string, DatabaseRecord[]>;
};

export function createInMemoryRuntimeHost(
  options: InMemoryRuntimeHostOptions = {},
): InMemoryRuntimeHost {
  return {
    db: new InMemoryDatabaseAdapter(options.database),
    files: new InMemoryFileAdapter(),
    env: new InMemoryEnvAdapter(options.env ?? {}),
    auth: new InMemoryAuthAdapter(options.auth ?? null),
    logs: new InMemoryLogAdapter(),
    events: new InMemoryEventAdapter(),
    jobs: new InMemoryJobAdapter(),
    workflows: new InMemoryWorkflowAdapter(),
    traces: new InMemoryTraceAdapter(),
  };
}

export class InMemoryDatabaseAdapter implements DatabaseAdapter {
  private readonly tables = new Map<string, InMemoryDatabaseTableClient>();

  constructor(seed: Record<string, DatabaseRecord[]> = {}) {
    for (const [name, records] of Object.entries(seed)) {
      this.tables.set(name, new InMemoryDatabaseTableClient(name, records));
    }
  }

  table(name: string): DatabaseTableClient {
    let table = this.tables.get(name);

    if (!table) {
      table = new InMemoryDatabaseTableClient(name);
      this.tables.set(name, table);
    }

    return table;
  }

  async inspect(): Promise<DatabaseInspection> {
    const tables: DatabaseInspection["tables"] = {};

    for (const [name, table] of this.tables.entries()) {
      tables[name] = {
        rows: await table.countRows(),
      };
    }

    return { tables };
  }
}

export class InMemoryDatabaseTableClient implements DatabaseTableClient {
  private readonly records = new Map<string, DatabaseRecord>();
  private nextId = 1;

  constructor(
    private readonly name: string,
    seed: DatabaseRecord[] = [],
  ) {
    for (const record of seed) {
      const stored = this.prepareRecord(record);
      this.records.set(String(stored.id), stored);
    }
  }

  async all(): Promise<DatabaseRecord[]> {
    return Array.from(this.records.values(), cloneRecord);
  }

  async get(id: string): Promise<DatabaseRecord | null> {
    const record = this.records.get(id);

    return record ? cloneRecord(record) : null;
  }

  async insert(record: DatabaseRecord): Promise<DatabaseRecord> {
    const stored = this.prepareRecord(record);
    this.records.set(String(stored.id), stored);

    return cloneRecord(stored);
  }

  async update(id: string, patch: DatabaseRecord): Promise<DatabaseRecord> {
    const existing = this.records.get(id);

    if (!existing) {
      throw new Error(`Record '${id}' does not exist in table '${this.name}'.`);
    }

    const updated = {
      ...existing,
      ...cloneRecord(patch),
      id,
    };

    this.records.set(id, updated);

    return cloneRecord(updated);
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  where(
    field: string,
    operator: DatabaseWhereOperator,
    value: unknown,
  ): DatabaseQueryClient {
    return {
      all: async () => this.matching(field, operator, value),
      first: async () => {
        const [first] = await this.matching(field, operator, value);

        return first ?? null;
      },
      count: async () => {
        return (await this.matching(field, operator, value)).length;
      },
    };
  }

  async countRows(): Promise<number> {
    return this.records.size;
  }

  private matching(
    field: string,
    operator: DatabaseWhereOperator,
    value: unknown,
  ): DatabaseRecord[] {
    return Array.from(this.records.values())
      .filter((record) => compare(record[field], operator, value))
      .map(cloneRecord);
  }

  private prepareRecord(
    record: DatabaseRecord,
  ): DatabaseRecord & { id: string } {
    const cloned = cloneRecord(record);
    const id =
      cloned.id === undefined
        ? `${this.name}_${this.nextId}`
        : String(cloned.id);
    this.nextId += 1;

    return {
      ...cloned,
      id,
    };
  }
}

export class InMemoryFileAdapter implements FileAdapter {
  private readonly files = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | null> {
    const file = this.files.get(key);

    return file ? new Uint8Array(file) : null;
  }

  async put(key: string, body: Uint8Array): Promise<{ key: string }> {
    this.files.set(key, new Uint8Array(body));

    return { key };
  }

  async delete(key: string): Promise<boolean> {
    return this.files.delete(key);
  }
}

export class InMemoryEnvAdapter implements EnvAdapter {
  constructor(private readonly values: Record<string, string>) {}

  get(name: string): string | undefined {
    return this.values[name];
  }
}

export class InMemoryAuthAdapter implements AuthAdapter {
  private readonly tokens = new Map<string, AuthIdentity>();

  constructor(private identity: AuthIdentity | null) {}

  async current(): Promise<AuthIdentity | null> {
    return this.identity;
  }

  setCurrent(identity: AuthIdentity | null): void {
    this.identity = identity;
  }

  registerToken(token: string, identity: AuthIdentity): void {
    this.tokens.set(token, identity);
  }

  verifyToken: (token: string) => Promise<AuthIdentity | null> = async (
    token,
  ) => {
    const identity = this.tokens.get(token);

    if (identity === undefined) {
      throw new Error(`Unknown test token '${token}'.`);
    }

    return identity;
  };
}

export class InMemoryLogAdapter implements LogAdapter {
  readonly entries: LogEntry[] = [];

  async write(entry: LogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

export class InMemoryEventAdapter implements EventAdapter {
  readonly entries: Array<{ name: string; payload: unknown }> = [];

  async publish(name: string, payload: unknown): Promise<void> {
    this.entries.push({ name, payload });
  }
}

export class InMemoryJobAdapter implements JobAdapter {
  private nextId = 1;
  readonly entries: Array<{ id: string; name: string; payload: unknown }> = [];

  async enqueue(name: string, payload: unknown): Promise<{ id: string }> {
    const id = `job_${this.nextId}`;
    this.nextId += 1;
    this.entries.push({ id, name, payload });

    return { id };
  }
}

export class InMemoryWorkflowAdapter implements WorkflowAdapter {
  private nextId = 1;
  readonly runs: WorkflowRun[] = [];

  async start(name: string, input: unknown): Promise<{ runId: string }> {
    const runId = `run_${this.nextId}`;
    const now = new Date().toISOString();

    this.nextId += 1;
    this.runs.push({
      runId,
      workflow: name,
      status: "running",
      input,
      steps: [],
      createdAt: now,
      updatedAt: now,
    });

    return { runId };
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    return this.runs.find((run) => run.runId === runId) ?? null;
  }

  async listRuns(): Promise<WorkflowRun[]> {
    return [...this.runs];
  }
}

export class InMemoryTraceAdapter implements TraceAdapter {
  readonly traces: TraceRecord[] = [];

  async start(input: TraceStartInput): Promise<TraceRecord> {
    const now = input.startedAt ?? new Date().toISOString();
    const existing = this.traces.find(
      (trace) => trace.traceId === input.traceId,
    );

    if (existing) {
      return existing;
    }

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

    this.traces.push(trace);

    if (input.attributes !== undefined) {
      await this.event(input.traceId, {
        type:
          input.kind === "agent" ? "agent.invoke.started" : "workflow.started",
        name: input.name,
        status: "running",
        attributes: input.attributes,
        timestamp: now,
      });
    }

    return trace;
  }

  async event(traceId: string, input: TraceEventInput): Promise<void> {
    const trace = await this.get(traceId);

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
        : { attributes: input.attributes }),
    });
    trace.updatedAt = timestamp;
  }

  async complete(traceId: string, input: TraceCompleteInput): Promise<void> {
    const trace = await this.get(traceId);

    if (!trace) {
      return;
    }

    const completedAt = input.completedAt ?? new Date().toISOString();

    trace.status = input.status;
    trace.completedAt = completedAt;
    trace.updatedAt = completedAt;
  }

  async get(traceId: string): Promise<TraceRecord | null> {
    return this.traces.find((trace) => trace.traceId === traceId) ?? null;
  }

  async list(): Promise<TraceRecord[]> {
    return [...this.traces];
  }
}

function cloneRecord(record: DatabaseRecord): DatabaseRecord {
  return structuredClone(record) as DatabaseRecord;
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
