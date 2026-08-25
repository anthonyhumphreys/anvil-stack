import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AnvilCloudExecutionConnection,
  AnvilCloudExecutionConnectionInput,
  AnvilCloudExecutionConnectionTest,
  AnvilCloudExecutionEventBatch,
  AnvilCloudExecutionLease,
  AnvilCloudExecutionStartInput,
  AnvilCloudExecutionStartResult,
} from '../../shared/types.js';
import { getDb } from '../db/database.js';
import { decryptSecret, encryptSecret } from './auth.service.js';

const DEFAULT_EXECUTION_ENDPOINT = 'http://127.0.0.1:4764';
const MAX_ARCHIVE_BYTES = 192 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

type ConnectionRow = {
  endpoint: string;
  token: Buffer;
  updated_at: string;
};

type RepoRow = {
  id: string;
  name: string;
  path: string;
  remote_url: string | null;
};

export function getAnvilCloudExecutionConnection(): AnvilCloudExecutionConnection {
  const row = getConnectionRow();

  return {
    configured: Boolean(row),
    endpoint: row?.endpoint ?? DEFAULT_EXECUTION_ENDPOINT,
    tokenConfigured: Boolean(row?.token),
    ...(row?.updated_at === undefined ? {} : { updatedAt: row.updated_at }),
  };
}

export function saveAnvilCloudExecutionConnection(
  input: AnvilCloudExecutionConnectionInput,
): AnvilCloudExecutionConnection {
  const endpoint = normalizeExecutionEndpoint(input.endpoint);
  const existing = getConnectionRow();
  const token = input.token?.trim();
  if (existing && !token && normalizeExecutionEndpoint(existing.endpoint) !== endpoint) {
    throw new Error('Enter a new bearer token when changing the execution endpoint.');
  }
  const encryptedToken = token ? encryptSecret(token) : existing?.token;
  if (!encryptedToken) {
    throw new Error('An execution control-plane bearer token is required.');
  }
  if (token && (token.length < 16 || token.length > 4_096)) {
    throw new Error(
      'Execution control-plane bearer tokens must contain between 16 and 4,096 characters.',
    );
  }

  getDb()
    .prepare(
      `INSERT INTO cloud_execution_connection (id, endpoint, token, updated_at)
       VALUES (1, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         endpoint = excluded.endpoint,
         token = excluded.token,
         updated_at = excluded.updated_at`,
    )
    .run(endpoint, encryptedToken);

  return getAnvilCloudExecutionConnection();
}

export function clearAnvilCloudExecutionConnection(): AnvilCloudExecutionConnection {
  getDb().prepare('DELETE FROM cloud_execution_connection WHERE id = 1').run();
  return getAnvilCloudExecutionConnection();
}

export async function testAnvilCloudExecutionConnection(): Promise<AnvilCloudExecutionConnectionTest> {
  const connection = getRequiredConnection();

  try {
    const executions = await listAnvilCloudExecutions();
    return {
      ok: true,
      endpoint: connection.endpoint,
      executionCount: executions.length,
    };
  } catch (error) {
    return {
      ok: false,
      endpoint: connection.endpoint,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listAnvilCloudExecutions(): Promise<AnvilCloudExecutionLease[]> {
  const payload = await executionRequest('/v1/executions');
  return Array.isArray(payload.executions)
    ? (payload.executions as AnvilCloudExecutionLease[])
    : [];
}

export async function getAnvilCloudExecution(
  executionId: string,
): Promise<AnvilCloudExecutionLease> {
  return readExecution(await executionRequest(`/v1/executions/${encodeURIComponent(executionId)}`));
}

export async function startAnvilCloudExecution(
  input: AnvilCloudExecutionStartInput,
): Promise<AnvilCloudExecutionStartResult> {
  validateStartInput(input);
  const repo = getWorkspaceRepo(input.workspaceId, input.repoId);
  const [commit, branch, status, archive] = await Promise.all([
    gitText(repo.path, ['rev-parse', 'HEAD']),
    gitText(repo.path, ['branch', '--show-current']),
    gitText(repo.path, ['status', '--porcelain=v1']),
    gitArchive(repo.path),
  ]);
  const repository = credentialFreeHttpsUrl(repo.remote_url);
  const snapshotPayload = await executionRequest('/v1/source-snapshots', {
    method: 'POST',
    body: {
      workspace: input.workspaceId,
      baseCommit: commit,
      archiveBase64: archive.toString('base64'),
      ...(repository === undefined ? {} : { repository }),
      ...(branch.length === 0 ? {} : { branch }),
    },
  });
  const source = readSnapshotSource(snapshotPayload);
  const ttlSeconds = input.ttlSeconds ?? 3_600;
  const agentRuntime = input.agentRuntime ?? 'codex-subscription';
  const request = {
    schemaVersion: '0.1',
    clientToken: `desktop-${randomUUID()}`,
    workspace: input.workspaceId,
    cell: repo.name,
    environment: 'desktop-session',
    task: input.task.trim(),
    agent: createReadOnlyDesktopAgentManifest(agentRuntime),
    source,
    providerPreference:
      input.provider === 'auto' ? { kind: 'auto' } : { kind: 'provider', provider: input.provider },
    policy: {
      mode: 'read-only',
      ttlSeconds,
      network: 'none',
      maxEvents: 10_000,
      ...(input.maxCostUsd === undefined ? {} : { maxCostUsd: input.maxCostUsd }),
      requireApprovalForExternalActions: true,
    },
    modelAuth:
      agentRuntime === 'cloud-managed'
        ? { kind: 'control-plane', credential: 'MODEL_API_KEY' }
        : {
            kind: 'provider-subscription',
            provider: agentRuntime === 'codex-subscription' ? 'codex' : 'cursor',
            persistence: 'sandbox-session',
          },
  };
  const execution = readExecution(
    await executionRequest('/v1/executions', { method: 'POST', body: request }),
  );

  return {
    execution,
    source: {
      commit,
      ...(branch.length === 0 ? {} : { branch }),
      ...(repository === undefined ? {} : { repository }),
      archiveBytes: archive.byteLength,
      excludedWorkingTreeChanges: status.length > 0,
    },
  };
}

export async function readAnvilCloudExecutionEvents(
  executionId: string,
  cursor?: string,
): Promise<AnvilCloudExecutionEventBatch> {
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  query.set('limit', '500');
  const payload = await executionRequest(
    `/v1/executions/${encodeURIComponent(executionId)}/events?${query.toString()}`,
  );
  if (!payload.batch || typeof payload.batch !== 'object') {
    throw new Error('Execution control plane returned no event batch.');
  }

  return payload.batch as AnvilCloudExecutionEventBatch;
}

export async function resolveAnvilCloudExecutionApproval(input: {
  executionId: string;
  requestId: string;
  decision: 'approved' | 'rejected';
  reason?: string;
}): Promise<AnvilCloudExecutionLease> {
  return readExecution(
    await executionRequest(`/v1/executions/${encodeURIComponent(input.executionId)}/approval`, {
      method: 'POST',
      body: {
        requestId: input.requestId,
        decision: input.decision,
        actor: 'anvil-desktop',
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
    }),
  );
}

export async function steerAnvilCloudExecution(
  executionId: string,
  message: string,
): Promise<AnvilCloudExecutionLease> {
  if (message.trim().length === 0) throw new Error('Steering message must not be empty.');
  return readExecution(
    await executionRequest(`/v1/executions/${encodeURIComponent(executionId)}/steer`, {
      method: 'POST',
      body: { message: message.trim() },
    }),
  );
}

export async function collectAnvilCloudExecution(
  executionId: string,
): Promise<AnvilCloudExecutionLease> {
  return executionAction(executionId, 'collect');
}

export async function terminateAnvilCloudExecution(
  executionId: string,
): Promise<AnvilCloudExecutionLease> {
  return executionAction(executionId, 'terminate');
}

async function executionAction(
  executionId: string,
  action: 'collect' | 'terminate',
): Promise<AnvilCloudExecutionLease> {
  return readExecution(
    await executionRequest(`/v1/executions/${encodeURIComponent(executionId)}/${action}`, {
      method: 'POST',
    }),
  );
}

function getConnectionRow(): ConnectionRow | undefined {
  return getDb()
    .prepare('SELECT endpoint, token, updated_at FROM cloud_execution_connection WHERE id = 1')
    .get() as ConnectionRow | undefined;
}

function getRequiredConnection(): { endpoint: string; token: string } {
  const row = getConnectionRow();
  const token = decryptSecret(row?.token ?? null, 'Anvil Cloud execution token');
  if (!row || !token) {
    throw new Error('Configure the Anvil Cloud execution connection first.');
  }

  return { endpoint: normalizeExecutionEndpoint(row.endpoint), token };
}

async function executionRequest(
  route: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const connection = getRequiredConnection();
  let response: Response;

  try {
    response = await fetch(`${connection.endpoint}${route}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    throw new Error(
      `Could not reach Anvil Cloud at ${connection.endpoint}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const payload = (await response.json().catch(() => ({}))) as unknown;
  const record = isObject(payload) ? payload : {};
  if (!response.ok) {
    const error = isObject(record.error) ? record.error : {};
    throw new Error(
      typeof error.message === 'string'
        ? error.message
        : `Anvil Cloud request failed with status ${response.status}.`,
    );
  }

  return record;
}

function getWorkspaceRepo(workspaceId: string, repoId: string): RepoRow {
  const row = getDb()
    .prepare(
      `SELECT r.id, r.name, r.path, r.remote_url
       FROM repos r
       INNER JOIN workspace_repos wr ON wr.repo_id = r.id
       WHERE wr.workspace_id = ? AND r.id = ?`,
    )
    .get(workspaceId, repoId) as RepoRow | undefined;
  if (!row) throw new Error('Repository is not attached to the selected workspace.');

  return row;
}

async function gitText(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repoPath, ...args],
      { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr).trim() || error.message));
          return;
        }
        resolve(String(stdout).trim());
      },
    );
  });
}

async function gitArchive(repoPath: string): Promise<Buffer> {
  const exclusions = [
    ':(exclude).env',
    ':(exclude)**/.env',
    ':(exclude)**/.env.*',
    ':(exclude)**/*.pem',
    ':(exclude)**/*.key',
    ':(exclude)**/credentials.json',
    ':(exclude)**/service-account*.json',
  ];

  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repoPath, 'archive', '--format=tar', 'HEAD', '--', '.', ...exclusions],
      {
        encoding: 'buffer',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_ARCHIVE_BYTES,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(Buffer.from(stderr).toString().trim() || error.message));
          return;
        }
        const archive = Buffer.from(stdout);
        if (archive.byteLength === 0) {
          reject(new Error('Git produced an empty repository snapshot.'));
          return;
        }
        resolve(archive);
      },
    );
  });
}

function createReadOnlyDesktopAgentManifest(
  runtime: NonNullable<AnvilCloudExecutionStartInput['agentRuntime']>,
): Record<string, unknown> {
  const modelProvider =
    runtime === 'codex-subscription'
      ? 'codex'
      : runtime === 'cursor-subscription'
        ? 'cursor'
        : 'control-plane';
  return {
    kind: 'anvil.agent',
    name: 'desktop-remote-inspector',
    description: 'Read-only repository inspection started from Anvil Desktop.',
    exposure: 'project',
    model: { provider: modelProvider, model: 'configured' },
    requires: {
      inference: true,
      toolCalling: false,
      memory: false,
      durableExecution: true,
      sandbox: true,
      humanApproval: [],
    },
    capabilities: {
      cells: [],
      database: [],
      network: 'none',
      filesystem: 'read',
      secrets: 'brokered',
      git: ['read'],
      deployments: [],
    },
    runtime: { durability: 'required', sandbox: 'required', approval: 'optional' },
    tools: [],
    skills: [],
    credentialBroker: { credentials: [] },
    subagents: {},
    metadata: { source: 'anvil-desktop', mode: 'read-only', agentRuntime: runtime },
  };
}

function validateStartInput(input: AnvilCloudExecutionStartInput): void {
  if (
    !input ||
    typeof input.workspaceId !== 'string' ||
    input.workspaceId.length === 0 ||
    input.workspaceId.length > 200 ||
    typeof input.repoId !== 'string' ||
    input.repoId.length === 0 ||
    input.repoId.length > 200
  ) {
    throw new Error('Remote execution requires a valid workspace and repository.');
  }
  if (input.provider !== 'auto' && input.provider !== 'aws-lambda-microvm') {
    throw new Error('Remote execution provider is invalid.');
  }
  if (
    input.agentRuntime !== undefined &&
    input.agentRuntime !== 'codex-subscription' &&
    input.agentRuntime !== 'cursor-subscription' &&
    input.agentRuntime !== 'cloud-managed'
  ) {
    throw new Error('Remote execution agent runtime is invalid.');
  }
  if (
    typeof input.task !== 'string' ||
    input.task.trim().length < 3 ||
    input.task.length > 20_000
  ) {
    throw new Error('Remote execution task must contain between 3 and 20,000 characters.');
  }
  if (
    input.ttlSeconds !== undefined &&
    (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 28_800)
  ) {
    throw new Error('Remote execution TTL must be between 60 and 28,800 seconds.');
  }
  if (
    input.maxCostUsd !== undefined &&
    (!Number.isFinite(input.maxCostUsd) || input.maxCostUsd <= 0)
  ) {
    throw new Error('Remote execution cost ceiling must be positive.');
  }
}

function normalizeExecutionEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Anvil Cloud execution endpoint must be a valid URL.');
  }
  const isLoopback =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('Remote execution endpoints must use HTTPS; HTTP is allowed only on loopback.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'Execution endpoints cannot contain credentials, query parameters, or fragments.',
    );
  }

  let endpoint = url.toString();
  while (endpoint.endsWith('/')) endpoint = endpoint.slice(0, -1);
  return endpoint;
}

function credentialFreeHttpsUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function readExecution(payload: Record<string, unknown>): AnvilCloudExecutionLease {
  if (!isObject(payload.execution) || typeof payload.execution.id !== 'string') {
    throw new Error('Execution control plane returned no execution lease.');
  }
  return payload.execution as unknown as AnvilCloudExecutionLease;
}

function readSnapshotSource(payload: Record<string, unknown>): Record<string, unknown> {
  if (!isObject(payload.snapshot) || payload.snapshot.kind !== 'snapshot') {
    throw new Error('Execution control plane returned no immutable source snapshot.');
  }
  return payload.snapshot;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
