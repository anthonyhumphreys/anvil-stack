import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AgentExecutionSource,
  AgentExecutionSourceAccess,
} from "@anvil-cloud/runtime";

import type { AgentExecutionSourceBroker } from "./execution.js";

const SNAPSHOT_SCHEMA_VERSION = "0.1" as const;
const REQUIRED_EXCLUSIONS = [
  "git-metadata",
  "ignored-files",
  "secret-files",
  "unrelated-untracked-files",
] as const;
const DEFAULT_MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_PATCH_BYTES = 16 * 1024 * 1024;
const DEFAULT_GRANT_TTL_SECONDS = 300;

export type AgentExecutionSnapshotUpload = {
  workspace: string;
  baseCommit: string;
  archive: Uint8Array;
  repository?: string;
  branch?: string;
  workingTreePatch?: Uint8Array;
};

export type AgentExecutionSnapshotRecord = {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  workspace: string;
  source: Extract<AgentExecutionSource, { kind: "snapshot" }>;
  archiveObject: string;
  patchObject?: string;
  createdAt: string;
};

export type AgentExecutionSnapshotGrant = {
  id: string;
  snapshotId: string;
  executionId: string;
  workspace: string;
  token: string;
  expiresAt: string;
};

export type AgentExecutionSnapshotDownload = {
  record: AgentExecutionSnapshotRecord;
  archive: Uint8Array;
  workingTreePatch?: Uint8Array;
};

export interface AgentExecutionSnapshotStore {
  put(
    upload: AgentExecutionSnapshotUpload,
  ): Promise<AgentExecutionSnapshotRecord>;
  get(
    workspace: string,
    snapshotId: string,
  ): Promise<AgentExecutionSnapshotRecord | null>;
  issueGrant(input: {
    workspace: string;
    snapshotId: string;
    executionId: string;
    ttlSeconds?: number;
  }): Promise<AgentExecutionSnapshotGrant>;
  consumeGrant(input: {
    grantId: string;
    executionId: string;
    token: string;
  }): Promise<AgentExecutionSnapshotDownload>;
}

export type AgentExecutionSnapshotStoreOptions = {
  maxSnapshotBytes?: number;
  maxPatchBytes?: number;
  now?: () => Date;
  idFactory?: () => string;
  tokenFactory?: () => string;
};

type SnapshotGrantRecord = Omit<AgentExecutionSnapshotGrant, "token"> & {
  tokenSha256: string;
  usedAt?: string;
};

type SnapshotStoreState = {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  snapshots: Record<string, AgentExecutionSnapshotRecord>;
  grants: Record<string, SnapshotGrantRecord>;
};

export class AgentExecutionSnapshotStoreError extends Error {
  constructor(
    readonly code:
      | "EXECUTION_SNAPSHOT_INVALID"
      | "EXECUTION_SNAPSHOT_TOO_LARGE"
      | "EXECUTION_SNAPSHOT_NOT_FOUND"
      | "EXECUTION_SNAPSHOT_GRANT_INVALID"
      | "EXECUTION_SNAPSHOT_GRANT_EXPIRED"
      | "EXECUTION_SNAPSHOT_GRANT_USED",
    message: string,
  ) {
    super(message);
    this.name = "AgentExecutionSnapshotStoreError";
  }
}

export class InMemoryAgentExecutionSnapshotStore implements AgentExecutionSnapshotStore {
  private readonly state: SnapshotStoreState = emptyState();
  private readonly objects = new Map<string, Uint8Array>();
  private readonly options: Required<AgentExecutionSnapshotStoreOptions>;

  constructor(options: AgentExecutionSnapshotStoreOptions = {}) {
    this.options = normalizedOptions(options);
  }

  async put(
    upload: AgentExecutionSnapshotUpload,
  ): Promise<AgentExecutionSnapshotRecord> {
    const prepared = prepareSnapshot(upload, this.options);
    this.objects.set(prepared.record.archiveObject, prepared.archive);
    if (prepared.patch && prepared.record.patchObject) {
      this.objects.set(prepared.record.patchObject, prepared.patch);
    }
    this.state.snapshots[
      recordKey(upload.workspace, prepared.record.source.snapshotId)
    ] = clone(prepared.record);

    return clone(prepared.record);
  }

  async get(
    workspace: string,
    snapshotId: string,
  ): Promise<AgentExecutionSnapshotRecord | null> {
    return clone(
      this.state.snapshots[recordKey(workspace, snapshotId)] ?? null,
    );
  }

  async issueGrant(input: {
    workspace: string;
    snapshotId: string;
    executionId: string;
    ttlSeconds?: number;
  }): Promise<AgentExecutionSnapshotGrant> {
    const record = await this.get(input.workspace, input.snapshotId);
    if (!record) {
      throw snapshotNotFound(input.workspace, input.snapshotId);
    }

    const issued = createGrant(input, this.options);
    this.state.grants[issued.record.id] = issued.record;

    return issued.grant;
  }

  async consumeGrant(input: {
    grantId: string;
    executionId: string;
    token: string;
  }): Promise<AgentExecutionSnapshotDownload> {
    const grant = validateGrant(
      this.state.grants[input.grantId],
      input,
      this.options.now,
    );
    grant.usedAt = this.options.now().toISOString();
    const record =
      this.state.snapshots[recordKey(grant.workspace, grant.snapshotId)];
    if (!record) {
      throw snapshotNotFound(grant.workspace, grant.snapshotId);
    }

    return {
      record: clone(record),
      archive: requiredObject(this.objects, record.archiveObject),
      ...(record.patchObject === undefined
        ? {}
        : {
            workingTreePatch: requiredObject(this.objects, record.patchObject),
          }),
    };
  }
}

export class FileAgentExecutionSnapshotStore implements AgentExecutionSnapshotStore {
  private readonly options: Required<AgentExecutionSnapshotStoreOptions>;
  private readonly statePath: string;
  private readonly objectsPath: string;
  private stateMutation = Promise.resolve();

  constructor(
    readonly rootPath: string,
    options: AgentExecutionSnapshotStoreOptions = {},
  ) {
    this.options = normalizedOptions(options);
    this.statePath = path.join(rootPath, "state.json");
    this.objectsPath = path.join(rootPath, "objects");
  }

  async put(
    upload: AgentExecutionSnapshotUpload,
  ): Promise<AgentExecutionSnapshotRecord> {
    const prepared = prepareSnapshot(upload, this.options);
    await this.writeObject(prepared.record.archiveObject, prepared.archive);
    if (prepared.patch && prepared.record.patchObject) {
      await this.writeObject(prepared.record.patchObject, prepared.patch);
    }
    await this.withStateMutation(async () => {
      const state = await this.readState();
      state.snapshots[
        recordKey(upload.workspace, prepared.record.source.snapshotId)
      ] = prepared.record;
      await this.writeState(state);
    });

    return clone(prepared.record);
  }

  async get(
    workspace: string,
    snapshotId: string,
  ): Promise<AgentExecutionSnapshotRecord | null> {
    const state = await this.readState();

    return clone(state.snapshots[recordKey(workspace, snapshotId)] ?? null);
  }

  async issueGrant(input: {
    workspace: string;
    snapshotId: string;
    executionId: string;
    ttlSeconds?: number;
  }): Promise<AgentExecutionSnapshotGrant> {
    return this.withStateMutation(async () => {
      const state = await this.readState();
      if (!state.snapshots[recordKey(input.workspace, input.snapshotId)]) {
        throw snapshotNotFound(input.workspace, input.snapshotId);
      }

      const issued = createGrant(input, this.options);
      state.grants[issued.record.id] = issued.record;
      await this.writeState(state);

      return issued.grant;
    });
  }

  async consumeGrant(input: {
    grantId: string;
    executionId: string;
    token: string;
  }): Promise<AgentExecutionSnapshotDownload> {
    const record = await this.withStateMutation(async () => {
      const state = await this.readState();
      const grant = validateGrant(
        state.grants[input.grantId],
        input,
        this.options.now,
      );
      grant.usedAt = this.options.now().toISOString();
      await this.writeState(state);
      const snapshot =
        state.snapshots[recordKey(grant.workspace, grant.snapshotId)];
      if (!snapshot) {
        throw snapshotNotFound(grant.workspace, grant.snapshotId);
      }

      return clone(snapshot);
    });

    return {
      record: clone(record),
      archive: await readFile(
        path.join(this.objectsPath, record.archiveObject),
      ),
      ...(record.patchObject === undefined
        ? {}
        : {
            workingTreePatch: await readFile(
              path.join(this.objectsPath, record.patchObject),
            ),
          }),
    };
  }

  private async writeObject(name: string, content: Uint8Array): Promise<void> {
    await mkdir(this.objectsPath, { recursive: true });
    try {
      await writeFile(path.join(this.objectsPath, name), content, {
        flag: "wx",
      });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
    }
  }

  private async withStateMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.stateMutation;
    let release: () => void = () => undefined;
    this.stateMutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readState(): Promise<SnapshotStoreState> {
    try {
      const value = JSON.parse(
        await readFile(this.statePath, "utf8"),
      ) as unknown;
      if (!isState(value)) {
        throw new Error(
          `Invalid execution snapshot store at ${this.statePath}.`,
        );
      }

      return value;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return emptyState();
      }

      throw error;
    }
  }

  private async writeState(state: SnapshotStoreState): Promise<void> {
    await mkdir(this.rootPath, { recursive: true });
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.statePath);
  }
}

export class SnapshotStoreAgentExecutionSourceBroker implements AgentExecutionSourceBroker {
  private readonly baseUrl: string;

  constructor(
    private readonly store: AgentExecutionSnapshotStore,
    baseUrl: string,
    private readonly grantTtlSeconds = DEFAULT_GRANT_TTL_SECONDS,
  ) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new AgentExecutionSnapshotStoreError(
        "EXECUTION_SNAPSHOT_INVALID",
        "Snapshot grant base URL must use HTTP or HTTPS.",
      );
    }
    this.baseUrl = trimTrailingCharacter(parsed.toString(), "/");
  }

  async prepareAccess(input: {
    executionId: string;
    workspace: string;
    source: AgentExecutionSource;
    ttlSeconds: number;
  }): Promise<AgentExecutionSourceAccess | undefined> {
    if (input.source.kind !== "snapshot") {
      return undefined;
    }

    const grant = await this.store.issueGrant({
      executionId: input.executionId,
      workspace: input.workspace,
      snapshotId: input.source.snapshotId,
      ttlSeconds: Math.min(input.ttlSeconds, this.grantTtlSeconds),
    });

    return {
      kind: "control-plane-grant",
      endpoint: `${this.baseUrl}/v1/source-grants/${encodeURIComponent(grant.id)}`,
      grantId: grant.id,
      token: grant.token,
      expiresAt: grant.expiresAt,
    };
  }
}

function prepareSnapshot(
  upload: AgentExecutionSnapshotUpload,
  options: Required<AgentExecutionSnapshotStoreOptions>,
): {
  record: AgentExecutionSnapshotRecord;
  archive: Uint8Array;
  patch?: Uint8Array;
} {
  validateUpload(upload, options);
  const archive = Uint8Array.from(upload.archive);
  const archiveSha256 = sha256(archive);
  const patch = upload.workingTreePatch
    ? Uint8Array.from(upload.workingTreePatch)
    : undefined;
  const patchSha256 = patch ? sha256(patch) : undefined;
  const snapshotId = `snap_${
    patchSha256 === undefined
      ? archiveSha256
      : sha256(`${archiveSha256}\0${patchSha256}`)
  }`;
  const source: Extract<AgentExecutionSource, { kind: "snapshot" }> = {
    kind: "snapshot",
    snapshotId,
    sha256: archiveSha256,
    sizeBytes: archive.byteLength,
    baseCommit: upload.baseCommit,
    ...(upload.repository === undefined
      ? {}
      : { repository: upload.repository }),
    ...(upload.branch === undefined ? {} : { branch: upload.branch }),
    ...(patch === undefined || patchSha256 === undefined
      ? {}
      : {
          patch: {
            artifactId: `patch_${patchSha256}`,
            sha256: patchSha256,
            sizeBytes: patch.byteLength,
          },
        }),
    selection: {
      includesWorkingTreePatch: patch !== undefined,
      excluded: [...REQUIRED_EXCLUSIONS],
    },
  };

  return {
    record: {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      workspace: upload.workspace,
      source,
      archiveObject: archiveSha256,
      ...(patchSha256 === undefined ? {} : { patchObject: patchSha256 }),
      createdAt: options.now().toISOString(),
    },
    archive,
    ...(patch === undefined ? {} : { patch }),
  };
}

function validateUpload(
  upload: AgentExecutionSnapshotUpload,
  options: Required<AgentExecutionSnapshotStoreOptions>,
): void {
  if (upload.workspace.trim().length === 0 || upload.workspace.length > 200) {
    throw invalidSnapshot(
      "Snapshot workspace must contain 1 to 200 characters.",
    );
  }
  if (!/^[a-f0-9]{7,64}$/i.test(upload.baseCommit)) {
    throw invalidSnapshot("Snapshot base commit must be hexadecimal.");
  }
  if (upload.archive.byteLength === 0) {
    throw invalidSnapshot("Snapshot archive must not be empty.");
  }
  if (upload.archive.byteLength > options.maxSnapshotBytes) {
    throw new AgentExecutionSnapshotStoreError(
      "EXECUTION_SNAPSHOT_TOO_LARGE",
      `Snapshot archive exceeds ${options.maxSnapshotBytes} bytes.`,
    );
  }
  if (upload.workingTreePatch && upload.workingTreePatch.byteLength === 0) {
    throw invalidSnapshot("Working-tree patch must not be empty.");
  }
  if (
    upload.workingTreePatch &&
    upload.workingTreePatch.byteLength > options.maxPatchBytes
  ) {
    throw new AgentExecutionSnapshotStoreError(
      "EXECUTION_SNAPSHOT_TOO_LARGE",
      `Working-tree patch exceeds ${options.maxPatchBytes} bytes.`,
    );
  }
  if (
    upload.repository !== undefined &&
    !isCredentialFreeHttpsUrl(upload.repository)
  ) {
    throw invalidSnapshot(
      "Snapshot repository must be a credential-free HTTPS URL.",
    );
  }
}

function createGrant(
  input: {
    workspace: string;
    snapshotId: string;
    executionId: string;
    ttlSeconds?: number;
  },
  options: Required<AgentExecutionSnapshotStoreOptions>,
): { grant: AgentExecutionSnapshotGrant; record: SnapshotGrantRecord } {
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_GRANT_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) {
    throw new AgentExecutionSnapshotStoreError(
      "EXECUTION_SNAPSHOT_GRANT_INVALID",
      "Snapshot grants must live between 1 and 900 seconds.",
    );
  }

  const id = `grant_${sanitizeId(options.idFactory())}`;
  const token = options.tokenFactory();
  const expiresAt = new Date(
    options.now().getTime() + ttlSeconds * 1_000,
  ).toISOString();
  const grant: AgentExecutionSnapshotGrant = {
    id,
    snapshotId: input.snapshotId,
    executionId: input.executionId,
    workspace: input.workspace,
    token,
    expiresAt,
  };

  return {
    grant,
    record: {
      id,
      snapshotId: input.snapshotId,
      executionId: input.executionId,
      workspace: input.workspace,
      expiresAt,
      tokenSha256: sha256(token),
    },
  };
}

function validateGrant(
  grant: SnapshotGrantRecord | undefined,
  input: { grantId: string; executionId: string; token: string },
  now: () => Date,
): SnapshotGrantRecord {
  if (
    !grant ||
    input.token.length > 512 ||
    grant.executionId !== input.executionId ||
    !constantTimeEqual(grant.tokenSha256, sha256(input.token))
  ) {
    throw new AgentExecutionSnapshotStoreError(
      "EXECUTION_SNAPSHOT_GRANT_INVALID",
      "Snapshot grant is invalid.",
    );
  }
  if (grant.usedAt) {
    throw new AgentExecutionSnapshotStoreError(
      "EXECUTION_SNAPSHOT_GRANT_USED",
      "Snapshot grant has already been used.",
    );
  }
  const expiresAt = new Date(grant.expiresAt).getTime();
  if (!Number.isFinite(expiresAt)) {
    throw new AgentExecutionSnapshotStoreError(
      "EXECUTION_SNAPSHOT_GRANT_INVALID",
      "Snapshot grant is invalid.",
    );
  }
  if (expiresAt <= now().getTime()) {
    throw new AgentExecutionSnapshotStoreError(
      "EXECUTION_SNAPSHOT_GRANT_EXPIRED",
      "Snapshot grant has expired.",
    );
  }

  return grant;
}

function normalizedOptions(
  options: AgentExecutionSnapshotStoreOptions,
): Required<AgentExecutionSnapshotStoreOptions> {
  return {
    maxSnapshotBytes: options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES,
    maxPatchBytes: options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES,
    now: options.now ?? (() => new Date()),
    idFactory: options.idFactory ?? randomUUID,
    tokenFactory:
      options.tokenFactory ?? (() => randomBytes(32).toString("base64url")),
  };
}

function emptyState(): SnapshotStoreState {
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, snapshots: {}, grants: {} };
}

function isState(value: unknown): value is SnapshotStoreState {
  return (
    isObject(value) &&
    value.schemaVersion === SNAPSHOT_SCHEMA_VERSION &&
    isObject(value.snapshots) &&
    isObject(value.grants)
  );
}

function recordKey(workspace: string, snapshotId: string): string {
  return sha256(`${workspace}\0${snapshotId}`);
}

function requiredObject(
  objects: Map<string, Uint8Array>,
  name: string,
): Uint8Array {
  const content = objects.get(name);
  if (!content) {
    throw new AgentExecutionSnapshotStoreError(
      "EXECUTION_SNAPSHOT_NOT_FOUND",
      "Snapshot content is missing.",
    );
  }

  return Uint8Array.from(content);
}

function snapshotNotFound(
  workspace: string,
  snapshotId: string,
): AgentExecutionSnapshotStoreError {
  return new AgentExecutionSnapshotStoreError(
    "EXECUTION_SNAPSHOT_NOT_FOUND",
    `Snapshot '${snapshotId}' was not found in workspace '${workspace}'.`,
  );
}

function invalidSnapshot(message: string): AgentExecutionSnapshotStoreError {
  return new AgentExecutionSnapshotStoreError(
    "EXECUTION_SNAPSHOT_INVALID",
    message,
  );
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");

  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function sanitizeId(value: string): string {
  return trimBoundaryCharacter(
    value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
    "-",
  );
}

function isCredentialFreeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function trimBoundaryCharacter(value: string, character: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && value[start] === character) start += 1;
  while (end > start && value[end - 1] === character) end -= 1;

  return value.slice(start, end);
}

function trimTrailingCharacter(value: string, character: string): string {
  let end = value.length;

  while (end > 0 && value[end - 1] === character) end -= 1;

  return value.slice(0, end);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
