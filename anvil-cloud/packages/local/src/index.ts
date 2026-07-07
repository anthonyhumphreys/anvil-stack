import { randomUUID } from "node:crypto";
import {
  copyFile,
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
  type WorkflowAdapter,
  type WorkflowRun,
  type AgentApprovalProvider,
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
  databaseBranch?: string;
  agentProviders?: AgentProviderRegistry;
  agentApprovalProvider?: AgentApprovalProvider;
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
  databaseBranch?: string;
}): Promise<LocalRuntimeHost> {
  await mkdir(options.stateDir, { recursive: true });
  await mkdir(path.join(options.stateDir, "files"), { recursive: true });

  const idp = new LocalIdentityProvider({
    stateDir: path.join(options.stateDir, "auth"),
  });

  const dbBranches = new JsonDatabaseBranchManager(options.stateDir);
  const databaseBranch =
    options.databaseBranch ??
    options.env?.ANVIL_DATABASE_BRANCH ??
    process.env.ANVIL_DATABASE_BRANCH ??
    (await dbBranches.getActiveBranch());

  return {
    db: await JsonDatabaseAdapter.open({
      stateDir: options.stateDir,
      branch: databaseBranch,
    }),
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
    databaseBranch?: string;
  } = {
    stateDir,
    cellName: options.cellName,
  };

  if (options.env !== undefined) {
    hostOptions.env = options.env;
  }
  if (options.databaseBranch !== undefined) {
    hostOptions.databaseBranch = options.databaseBranch;
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

export type JsonDatabaseBranchMetadata = {
  name: string;
  source: string;
  file: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  promotedAt?: string;
};

export type JsonDatabaseBranchSummary = JsonDatabaseBranchMetadata & {
  active: boolean;
  expired: boolean;
  tables: DatabaseInspection["tables"];
};

export type JsonDatabaseBranchDiff = {
  branch: string;
  against: string;
  tables: Record<
    string,
    {
      branchRows: number;
      againstRows: number;
      rowDelta: number;
      addedFields: string[];
      removedFields: string[];
    }
  >;
};

type JsonDatabaseBranchState = {
  active: string;
  branches: JsonDatabaseBranchMetadata[];
};

const primaryDatabaseBranch = "main";
const databaseBranchNamePattern = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function normalizeDatabaseBranchName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return normalized || primaryDatabaseBranch;
}

export class JsonDatabaseBranchManager {
  private readonly primaryPath: string;
  private readonly branchDir: string;
  private readonly metadataPath: string;

  constructor(private readonly stateDir: string) {
    this.primaryPath = path.join(stateDir, "dev.db");
    this.branchDir = path.join(stateDir, "db-branches");
    this.metadataPath = path.join(stateDir, "db-branches.json");
  }

  async getActiveBranch(): Promise<string> {
    return (await this.readState()).active;
  }

  async setActiveBranch(name: string): Promise<JsonDatabaseBranchSummary> {
    const branch = this.normalizeExistingBranch(name);
    const state = await this.readState();
    const summary = await this.getBranch(branch, state);

    state.active = branch;
    await this.writeState(state);

    return { ...summary, active: true };
  }

  async createBranch(options: {
    name: string;
    from?: string;
    ttlSeconds?: number;
    now?: Date;
  }): Promise<JsonDatabaseBranchSummary> {
    const name = normalizeDatabaseBranchName(options.name);

    if (name === primaryDatabaseBranch) {
      throw new Error("The primary database branch already exists.");
    }
    if (!databaseBranchNamePattern.test(name)) {
      throw new Error(`Invalid database branch name '${options.name}'.`);
    }

    const source = normalizeDatabaseBranchName(
      options.from ?? primaryDatabaseBranch,
    );
    const state = await this.readState();
    await this.assertBranchExists(source, state);

    if (state.branches.some((branch) => branch.name === name)) {
      throw new Error(`Database branch '${name}' already exists.`);
    }

    const now = options.now ?? new Date();
    const metadata: JsonDatabaseBranchMetadata = {
      name,
      source,
      file: `${name}.db.json`,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    if (options.ttlSeconds !== undefined) {
      metadata.expiresAt = new Date(
        now.getTime() + options.ttlSeconds * 1_000,
      ).toISOString();
    }

    await mkdir(this.branchDir, { recursive: true });
    await this.copyDatabaseFile(
      this.resolveBranchPath(source, state),
      this.resolveBranchFile(metadata.file),
    );

    state.branches.push(metadata);
    await this.writeState(state);

    return this.summarize(metadata, state.active, now);
  }

  async listBranches(now: Date = new Date()): Promise<JsonDatabaseBranchSummary[]> {
    const state = await this.readState();
    const primary = await this.primarySummary(state.active, now);
    const branches = await Promise.all(
      state.branches.map((branch) => this.summarize(branch, state.active, now)),
    );

    return [primary, ...branches].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  async diffBranch(
    name: string,
    against: string = primaryDatabaseBranch,
  ): Promise<JsonDatabaseBranchDiff> {
    const state = await this.readState();
    const branchName = this.normalizeExistingBranch(name);
    const againstName = this.normalizeExistingBranch(against);
    await this.assertBranchExists(branchName, state);
    await this.assertBranchExists(againstName, state);

    const branchData = await readJsonFile<Record<string, DatabaseRecord[]>>(
      this.resolveBranchPath(branchName, state),
      {},
    );
    const againstData = await readJsonFile<Record<string, DatabaseRecord[]>>(
      this.resolveBranchPath(againstName, state),
      {},
    );
    const tableNames = new Set([
      ...Object.keys(branchData),
      ...Object.keys(againstData),
    ]);
    const tables: JsonDatabaseBranchDiff["tables"] = {};

    for (const tableName of [...tableNames].sort()) {
      const branchRows = branchData[tableName] ?? [];
      const againstRows = againstData[tableName] ?? [];
      const branchFields = recordFields(branchRows);
      const againstFields = recordFields(againstRows);

      tables[tableName] = {
        branchRows: branchRows.length,
        againstRows: againstRows.length,
        rowDelta: branchRows.length - againstRows.length,
        addedFields: [...branchFields]
          .filter((field) => !againstFields.has(field))
          .sort(),
        removedFields: [...againstFields]
          .filter((field) => !branchFields.has(field))
          .sort(),
      };
    }

    return { branch: branchName, against: againstName, tables };
  }

  async promoteBranch(name: string, now: Date = new Date()): Promise<JsonDatabaseBranchSummary> {
    const state = await this.readState();
    const branchName = this.normalizeExistingBranch(name);

    if (branchName === primaryDatabaseBranch) {
      return this.primarySummary(state.active, now);
    }

    const metadata = state.branches.find((branch) => branch.name === branchName);

    if (!metadata) {
      throw new Error(`Database branch '${name}' does not exist.`);
    }

    await this.copyDatabaseFile(
      this.resolveBranchFile(metadata.file),
      this.primaryPath,
    );
    metadata.promotedAt = now.toISOString();
    metadata.updatedAt = now.toISOString();
    await this.writeState(state);

    return this.summarize(metadata, state.active, now);
  }

  async deleteBranch(name: string): Promise<{ name: string; deleted: boolean }> {
    const branchName = this.normalizeExistingBranch(name);

    if (branchName === primaryDatabaseBranch) {
      throw new Error("The primary database branch cannot be deleted.");
    }

    const state = await this.readState();
    const metadata = state.branches.find((branch) => branch.name === branchName);

    if (!metadata) {
      return { name: branchName, deleted: false };
    }

    state.branches = state.branches.filter((branch) => branch.name !== branchName);
    if (state.active === branchName) {
      state.active = primaryDatabaseBranch;
    }
    await rm(this.resolveBranchFile(metadata.file), { force: true });
    await this.writeState(state);

    return { name: branchName, deleted: true };
  }

  async deleteExpiredBranches(now: Date = new Date()): Promise<string[]> {
    const state = await this.readState();
    const expired = state.branches.filter(
      (branch) =>
        branch.expiresAt !== undefined &&
        Date.parse(branch.expiresAt) <= now.getTime(),
    );

    for (const branch of expired) {
      await rm(this.resolveBranchFile(branch.file), { force: true });
    }

    if (expired.length > 0) {
      const expiredNames = new Set(expired.map((branch) => branch.name));
      state.branches = state.branches.filter(
        (branch) => !expiredNames.has(branch.name),
      );
      if (expiredNames.has(state.active)) {
        state.active = primaryDatabaseBranch;
      }
      await this.writeState(state);
    }

    return expired.map((branch) => branch.name).sort();
  }

  resolveDatabasePath(name: string = primaryDatabaseBranch): string {
    return this.resolveBranchPath(normalizeDatabaseBranchName(name), {
      active: primaryDatabaseBranch,
      branches: [],
    });
  }

  private async getBranch(
    name: string,
    state: JsonDatabaseBranchState,
  ): Promise<JsonDatabaseBranchSummary> {
    if (name === primaryDatabaseBranch) {
      return this.primarySummary(state.active, new Date());
    }

    const metadata = state.branches.find((branch) => branch.name === name);

    if (!metadata) {
      throw new Error(`Database branch '${name}' does not exist.`);
    }

    return this.summarize(metadata, state.active, new Date());
  }

  private async assertBranchExists(
    name: string,
    state: JsonDatabaseBranchState,
  ): Promise<void> {
    if (name === primaryDatabaseBranch) {
      return;
    }

    if (!state.branches.some((branch) => branch.name === name)) {
      throw new Error(`Database branch '${name}' does not exist.`);
    }
  }

  private normalizeExistingBranch(name: string): string {
    const normalized = normalizeDatabaseBranchName(name);

    if (!databaseBranchNamePattern.test(normalized)) {
      throw new Error(`Invalid database branch name '${name}'.`);
    }

    return normalized;
  }

  private async primarySummary(
    active: string,
    _now: Date,
  ): Promise<JsonDatabaseBranchSummary> {
    return {
      name: primaryDatabaseBranch,
      source: primaryDatabaseBranch,
      file: "dev.db",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      active: active === primaryDatabaseBranch,
      expired: false,
      tables: await inspectDatabaseFile(this.primaryPath),
    };
  }

  private async summarize(
    metadata: JsonDatabaseBranchMetadata,
    active: string,
    now: Date,
  ): Promise<JsonDatabaseBranchSummary> {
    return {
      ...metadata,
      active: metadata.name === active,
      expired:
        metadata.expiresAt !== undefined &&
        Date.parse(metadata.expiresAt) <= now.getTime(),
      tables: await inspectDatabaseFile(this.resolveBranchFile(metadata.file)),
    };
  }

  private resolveBranchPath(
    name: string,
    state: JsonDatabaseBranchState,
  ): string {
    if (name === primaryDatabaseBranch) {
      return this.primaryPath;
    }

    const metadata = state.branches.find((branch) => branch.name === name);

    return this.resolveBranchFile(metadata?.file ?? `${name}.db.json`);
  }

  private resolveBranchFile(file: string): string {
    return path.join(this.branchDir, file);
  }

  private async copyDatabaseFile(from: string, to: string): Promise<void> {
    await mkdir(path.dirname(to), { recursive: true });

    try {
      await copyFile(from, to);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        await writeFile(to, "{}\n", "utf8");
        return;
      }

      throw error;
    }
  }

  private async readState(): Promise<JsonDatabaseBranchState> {
    const state = await readJsonFile<Partial<JsonDatabaseBranchState>>(
      this.metadataPath,
      {},
    );

    const branches = Array.isArray(state.branches)
      ? state.branches.filter(isDatabaseBranchMetadata)
      : [];

    let active =
      typeof state.active === "string"
        ? normalizeDatabaseBranchName(state.active)
        : primaryDatabaseBranch;

    const activeExists =
      active === primaryDatabaseBranch ||
      branches.some((branch) => branch.name === active);

    if (!activeExists) {
      active =
        branches.find((branch) => branch.name === primaryDatabaseBranch)?.name ??
        branches[0]?.name ??
        primaryDatabaseBranch;
    }

    return { active, branches };
  }

  private async writeState(state: JsonDatabaseBranchState): Promise<void> {
    await mkdir(path.dirname(this.metadataPath), { recursive: true });
    await writeFile(
      this.metadataPath,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
  }
}

export class JsonDatabaseAdapter implements DatabaseAdapter {
  static async open(options: {
    stateDir: string;
    branch?: string;
  }): Promise<JsonDatabaseAdapter> {
    const branches = new JsonDatabaseBranchManager(options.stateDir);
    const branch = normalizeDatabaseBranchName(
      options.branch ?? (await branches.getActiveBranch()),
    );

    return new JsonDatabaseAdapter(
      branches.resolveDatabasePath(branch),
      branch,
      branches,
    );
  }

  constructor(
    private readonly filePath: string,
    readonly branch: string = primaryDatabaseBranch,
    private readonly branches?: JsonDatabaseBranchManager,
  ) {}

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

  async inspectBranches(): Promise<JsonDatabaseBranchSummary[]> {
    return this.branches?.listBranches() ?? [];
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
      const result = await options.agentRuntime.invoke(agent, invocationInput);

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

    if (method === "GET" && url.pathname === "/_anvil/db/tables") {
      await sendJson(options.response, 200, {
        ok: true,
        database: await options.host.db.inspect(),
        branches: await options.host.db.inspectBranches(),
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
  const response = await handleRuntimeRequest(
    options.app,
    options.host,
    runtimeRequest,
  );

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

  return {
    ok: true,
    status: "running",
    runtimeUrl: options.runtimeUrl,
    clientUrl: options.clientUrl,
    manifest: options.manifest,
    auth: {
      currentUser: auth?.userId ?? null,
    },
    database: {
      ...(await options.host.db.inspect()),
      activeBranch: options.host.db.branch,
      branches: await options.host.db.inspectBranches(),
    },
    recentErrors: logs.filter((entry) => entry.level === "error").slice(-10),
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

async function inspectDatabaseFile(
  filePath: string,
): Promise<DatabaseInspection["tables"]> {
  const data = await readJsonFile<Record<string, DatabaseRecord[]>>(
    filePath,
    {},
  );
  const tables: DatabaseInspection["tables"] = {};

  for (const [name, rows] of Object.entries(data)) {
    tables[name] = { rows: Array.isArray(rows) ? rows.length : 0 };
  }

  return tables;
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

function recordFields(records: DatabaseRecord[]): Set<string> {
  const fields = new Set<string>();

  for (const record of records) {
    for (const field of Object.keys(record)) {
      fields.add(field);
    }
  }

  return fields;
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

function isDatabaseBranchMetadata(
  value: unknown,
): value is JsonDatabaseBranchMetadata {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.name === "string" &&
    typeof value.source === "string" &&
    typeof value.file === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.expiresAt === undefined || typeof value.expiresAt === "string") &&
    (value.promotedAt === undefined || typeof value.promotedAt === "string")
  );
}
