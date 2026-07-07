import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  AgentCredentialBroker,
  AgentNetworkCapability,
  AgentSandboxProvider,
  AgentSandboxSession,
  AgentSandboxStartInput,
  AgentSandboxStatus,
} from "@anvil-cloud/runtime";

const execFileAsync = promisify(execFile);

export type LocalSandboxBackend = "docker" | "process";
export type LocalSandboxBackendSelection = LocalSandboxBackend | "auto";

export type DockerCommandRunner = (
  args: string[],
) => Promise<{ stdout?: string; stderr?: string } | void>;

export type LocalSandboxProviderOptions = {
  rootDir?: string;
  stateDir?: string;
  backend?: LocalSandboxBackendSelection;
  dockerImage?: string;
  dockerCommand?: DockerCommandRunner;
  dockerAvailable?: () => Promise<boolean>;
  env?: Record<string, string | undefined>;
  idFactory?: () => string;
  now?: () => Date;
};

export type LocalSandboxSessionRecord = {
  schemaVersion: "0.1";
  backend: LocalSandboxBackend;
  session: AgentSandboxSession;
  workspaceRoot: string;
  container?: {
    name: string;
    id?: string;
    image: string;
    network: "bridge" | "none";
  };
  policy: {
    capabilities: AgentSandboxStartInput["manifest"]["capabilities"];
    approvals: string[];
    network: AgentNetworkCapability;
    credentialBroker: AgentCredentialBroker;
  };
};

export type LocalSandboxProvider = AgentSandboxProvider & {
  readonly backend: LocalSandboxBackend;
  readonly stateDir: string;
};

type LocalProviderConfig = Required<
  Pick<LocalSandboxProviderOptions, "idFactory" | "now">
> & {
  rootDir: string;
  stateDir: string;
};

export function readLocalSandboxBackendSelection(
  env: Record<string, string | undefined> = process.env,
): LocalSandboxBackendSelection | undefined {
  const value = env.ANVIL_LOCAL_SANDBOX_BACKEND;

  if (value === "auto" || value === "docker" || value === "process") {
    return value;
  }

  return undefined;
}

export async function createLocalSandboxProvider(
  options: LocalSandboxProviderOptions = {},
): Promise<LocalSandboxProvider> {
  const backend =
    options.backend ?? readLocalSandboxBackendSelection(options.env) ?? "auto";
  const selected =
    backend === "auto" ? await selectLocalSandboxBackend(options) : backend;

  if (selected === "docker") {
    return new LocalDockerSandboxProvider(options);
  }

  return new LocalProcessSandboxProvider(options);
}

export async function selectLocalSandboxBackend(
  options: LocalSandboxProviderOptions = {},
): Promise<LocalSandboxBackend> {
  const available = await (options.dockerAvailable?.() ??
    defaultDockerAvailable(options.dockerCommand));

  return available ? "docker" : "process";
}

export async function listLocalSandboxSessions(
  options: {
    rootDir?: string;
    stateDir?: string;
  } = {},
): Promise<LocalSandboxSessionRecord[]> {
  const stateDir = resolveStateDir(options);

  try {
    const entries = await readdir(stateDir, { withFileTypes: true });
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          readRecord(path.join(stateDir, entry.name)).catch(() => null),
        ),
    );

    return records
      .filter((record): record is LocalSandboxSessionRecord => record !== null)
      .sort((a, b) =>
        (b.session.startedAt ?? "").localeCompare(a.session.startedAt ?? ""),
      );
  } catch {
    return [];
  }
}

export class LocalProcessSandboxProvider implements LocalSandboxProvider {
  readonly id = "local-process";
  readonly backend = "process" as const;
  readonly stateDir: string;
  private readonly config: LocalProviderConfig;

  constructor(options: LocalSandboxProviderOptions = {}) {
    this.config = createConfig(options);
    this.stateDir = this.config.stateDir;
  }

  async start(input: AgentSandboxStartInput): Promise<AgentSandboxSession> {
    const record = createRecord(this.config, this.backend, input);

    await mkdir(record.workspaceRoot, { recursive: true });
    await writeRecord(record);

    return record.session;
  }

  async inspect(sessionId: string): Promise<AgentSandboxSession> {
    return (await readRecord(path.join(this.stateDir, sessionId))).session;
  }

  async suspend(sessionId: string): Promise<void> {
    await updateRecord(this.stateDir, sessionId, (record) => ({
      ...record,
      session: {
        ...record.session,
        status: "suspended",
      },
    }));
  }

  async resume(sessionId: string): Promise<AgentSandboxSession> {
    const record = await updateRecord(this.stateDir, sessionId, (current) => ({
      ...current,
      session: {
        ...current.session,
        status: "active",
      },
    }));

    return record.session;
  }

  async terminate(sessionId: string): Promise<void> {
    await terminateLocalRecord(this.stateDir, sessionId, this.config.now());
  }

  async createAuthToken(sessionId: string): Promise<{
    sessionId: string;
    tokenParts: Record<string, string>;
  }> {
    return {
      sessionId,
      tokenParts: {
        Authorization: `Bearer local-sandbox-${sessionId}`,
      },
    };
  }
}

export class LocalDockerSandboxProvider implements LocalSandboxProvider {
  readonly id = "local-docker";
  readonly backend = "docker" as const;
  readonly stateDir: string;
  private readonly config: LocalProviderConfig;
  private readonly image: string;
  private readonly runDocker: DockerCommandRunner;

  constructor(private readonly options: LocalSandboxProviderOptions = {}) {
    this.config = createConfig(options);
    this.stateDir = this.config.stateDir;
    this.image =
      options.dockerImage ?? "public.ecr.aws/docker/library/node:20-alpine";
    this.runDocker = options.dockerCommand ?? defaultDockerCommand;
  }

  async start(input: AgentSandboxStartInput): Promise<AgentSandboxSession> {
    const record = createRecord(this.config, this.backend, input);
    const containerName = dockerContainerName(record.session);
    const network = dockerNetworkMode(record.policy.network);

    record.container = {
      name: containerName,
      image: this.image,
      network,
    };

    await mkdir(record.workspaceRoot, { recursive: true });

    const createResult = await this.runDocker([
      "create",
      "--name",
      containerName,
      "--label",
      `anvil.cloud.sandbox=${record.session.id}`,
      "--workdir",
      "/workspace",
      "--mount",
      `type=bind,src=${record.workspaceRoot},dst=/workspace`,
      "--network",
      network,
      this.image,
      "sh",
      "-lc",
      "sleep infinity",
    ]);

    if (createResult?.stdout) {
      record.container.id = createResult.stdout.trim();
    }

    await this.runDocker(["start", containerName]);
    await writeRecord(record);

    return record.session;
  }

  async inspect(sessionId: string): Promise<AgentSandboxSession> {
    return (await readRecord(path.join(this.stateDir, sessionId))).session;
  }

  async suspend(sessionId: string): Promise<void> {
    const record = await readRecord(path.join(this.stateDir, sessionId));

    if (record.container?.name) {
      await this.runDocker(["stop", record.container.name]);
    }

    await updateRecord(this.stateDir, sessionId, (current) => ({
      ...current,
      session: {
        ...current.session,
        status: "suspended",
      },
    }));
  }

  async resume(sessionId: string): Promise<AgentSandboxSession> {
    const record = await readRecord(path.join(this.stateDir, sessionId));

    if (record.container?.name) {
      await this.runDocker(["start", record.container.name]);
    }

    const updated = await updateRecord(this.stateDir, sessionId, (current) => ({
      ...current,
      session: {
        ...current.session,
        status: "active",
      },
    }));

    return updated.session;
  }

  async terminate(sessionId: string): Promise<void> {
    const record = await readRecord(path.join(this.stateDir, sessionId));

    if (record.container?.name) {
      await this.runDocker(["rm", "-f", record.container.name]);
    }

    await terminateLocalRecord(this.stateDir, sessionId, this.config.now());
  }

  async createAuthToken(sessionId: string): Promise<{
    sessionId: string;
    tokenParts: Record<string, string>;
  }> {
    return {
      sessionId,
      tokenParts: {
        Authorization: `Bearer local-docker-${sessionId}`,
      },
    };
  }
}

function createConfig(
  options: LocalSandboxProviderOptions,
): LocalProviderConfig {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const stateOptions =
    options.stateDir === undefined
      ? { rootDir }
      : { rootDir, stateDir: options.stateDir };

  return {
    rootDir,
    stateDir: resolveStateDir(stateOptions),
    idFactory: options.idFactory ?? randomUUID,
    now: options.now ?? (() => new Date()),
  };
}

function resolveStateDir(
  options: {
    rootDir?: string;
    stateDir?: string;
  } = {},
): string {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());

  return path.resolve(rootDir, options.stateDir ?? ".anvil/local/sandboxes");
}

function createRecord(
  config: LocalProviderConfig,
  backend: LocalSandboxBackend,
  input: AgentSandboxStartInput,
): LocalSandboxSessionRecord {
  const id = localSessionId(input.clientToken, config.idFactory);
  const startedAt = config.now().toISOString();
  const workspaceRoot = path.join(config.stateDir, id, "workspace");
  const session: AgentSandboxSession = {
    id,
    agent: input.manifest.name,
    status: "active",
    provider: `local-${backend}`,
    startedAt,
    metadata: {
      backend,
      cell: input.cell,
      environment: input.environment,
      workspaceRoot,
      workspace: input.workspace ?? null,
    },
  };

  return {
    schemaVersion: "0.1",
    backend,
    session,
    workspaceRoot,
    policy: {
      capabilities: input.manifest.capabilities,
      approvals: input.manifest.requires.humanApproval,
      network: input.manifest.capabilities.network,
      credentialBroker: sanitizeCredentialBroker(
        input.credentialBroker ?? input.manifest.credentialBroker,
      ),
    },
  };
}

function localSessionId(
  clientToken: string | undefined,
  idFactory: () => string,
): string {
  const raw = clientToken ?? `local-${idFactory()}`;
  const sanitized = raw
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^[.-]+/, "")
    .slice(0, 120);

  return sanitized.length > 0 ? sanitized : `local-${idFactory()}`;
}

async function terminateLocalRecord(
  stateDir: string,
  sessionId: string,
  terminatedAt: Date,
): Promise<void> {
  const record = await updateRecord(stateDir, sessionId, (current) => ({
    ...current,
    session: {
      ...current.session,
      status: "terminated",
      terminatedAt: terminatedAt.toISOString(),
    },
  }));

  await rm(record.workspaceRoot, { recursive: true, force: true });
}

async function updateRecord(
  stateDir: string,
  sessionId: string,
  update: (
    record: LocalSandboxSessionRecord,
  ) => LocalSandboxSessionRecord | Promise<LocalSandboxSessionRecord>,
): Promise<LocalSandboxSessionRecord> {
  const record = await readRecord(path.join(stateDir, sessionId));
  const updated = await update(record);

  await writeRecord(updated);

  return updated;
}

async function writeRecord(record: LocalSandboxSessionRecord): Promise<void> {
  const sessionDirectory = path.dirname(recordPath(record));

  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(recordPath(record), `${JSON.stringify(record, null, 2)}\n`);
}

async function readRecord(
  sessionDirectory: string,
): Promise<LocalSandboxSessionRecord> {
  const raw = await readFile(
    path.join(sessionDirectory, "session.json"),
    "utf8",
  );

  return JSON.parse(raw) as LocalSandboxSessionRecord;
}

async function defaultDockerAvailable(
  runDocker: DockerCommandRunner = defaultDockerCommand,
): Promise<boolean> {
  try {
    await runDocker(["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}

async function defaultDockerCommand(
  args: string[],
): Promise<{ stdout?: string; stderr?: string }> {
  return execFileAsync("docker", args);
}

function dockerNetworkMode(network: AgentNetworkCapability): "bridge" | "none" {
  if (network === "none" || network === "restricted") {
    return "none";
  }

  return "bridge";
}

function dockerContainerName(session: AgentSandboxSession): string {
  return ["anvil", "sandbox", session.agent, session.id]
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .slice(0, 120);
}

function recordPath(record: LocalSandboxSessionRecord): string {
  return path.join(path.dirname(record.workspaceRoot), "session.json");
}

function sanitizeCredentialBroker(
  broker: AgentCredentialBroker | undefined,
): AgentCredentialBroker {
  return {
    credentials: (broker?.credentials ?? []).map((entry) => ({
      credential: entry.credential,
      domains: [...entry.domains],
      inject: { ...entry.inject },
    })),
  };
}
