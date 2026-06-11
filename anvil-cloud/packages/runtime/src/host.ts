import type { HandlerKind } from "./app.js";

export type AuthIdentity = {
  userId: string;
  email?: string;
  roles?: string[];
  claims?: Record<string, unknown>;
};

export type DatabaseWhereOperator = "=" | "!=" | ">" | ">=" | "<" | "<=";

export type DatabaseRecord = Record<string, unknown>;

export type DatabaseQueryClient = {
  all: () => Promise<DatabaseRecord[]>;
  first: () => Promise<DatabaseRecord | null>;
  count: () => Promise<number>;
};

export type DatabaseTableClient = {
  all: () => Promise<DatabaseRecord[]>;
  get: (id: string) => Promise<DatabaseRecord | null>;
  insert: (record: DatabaseRecord) => Promise<DatabaseRecord>;
  update: (id: string, patch: DatabaseRecord) => Promise<DatabaseRecord>;
  delete: (id: string) => Promise<boolean>;
  where: (
    field: string,
    operator: DatabaseWhereOperator,
    value: unknown,
  ) => DatabaseQueryClient;
};

export type DatabaseClient = Record<string, DatabaseTableClient>;

export type DatabaseInspection = {
  tables: Record<string, { rows: number }>;
};

export interface DatabaseAdapter {
  table(name: string): DatabaseTableClient;
  inspect?(): Promise<DatabaseInspection>;
}

export interface FileAdapter {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array): Promise<{ key: string }>;
  delete(key: string): Promise<boolean>;
}

export interface EnvAdapter {
  get(name: string): string | undefined;
}

export interface AuthAdapter {
  current(): Promise<AuthIdentity | null>;
}

export type LogEntry = {
  timestamp: string;
  level: "debug" | "error" | "info" | "warn";
  requestId: string;
  kind: HandlerKind;
  handler: string;
  message: string;
  meta: Record<string, unknown>;
};

export interface LogAdapter {
  write(entry: LogEntry): Promise<void>;
}

export interface EventAdapter {
  publish(name: string, payload: unknown): Promise<void>;
}

export interface JobAdapter {
  enqueue(name: string, payload: unknown): Promise<{ id: string }>;
}

export interface RuntimeHost {
  db: DatabaseAdapter;
  files: FileAdapter;
  env: EnvAdapter;
  auth: AuthAdapter;
  logs: LogAdapter;
  events: EventAdapter;
  jobs: JobAdapter;
}
