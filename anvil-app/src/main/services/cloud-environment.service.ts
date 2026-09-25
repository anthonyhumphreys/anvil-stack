/**
 * ENV-01/ENV-03: cloud environment provisioning, device side.
 *
 * A provisioner-capable device (desktop or daemon) claims
 * `provision-environment` jobs and drives a `CloudEnvironmentProvider`:
 * mint an ephemeral enrollment code → provider.create → report progress
 * via `environment.report` → terminate on reap intent or TTL. Provider
 * credentials live in OS credential storage (`encryptSecret`); the
 * connection row keeps only non-secret config — credentials never sync.
 *
 * Provider coverage: AWS Lambda MicroVMs (ENV-03), Cloudflare Sandbox via a
 * customer-deployed provisioner Worker (ENV-04), and Vercel Sandbox (ENV-05)
 * sit behind the same interface. `anvil-managed` (ENV-09) has no device-side
 * provider — the backend's internal claimer provisions it; see
 * `requestEnvironment`.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  GetMicrovmCommand,
  TerminateMicrovmCommand,
  type RunMicrovmCommandInput,
} from '@aws-sdk/client-lambda-microvms';
import { Sandbox } from '@vercel/sandbox';
import { getDb } from '../db/database.js';
import { encryptSecret, decryptSecret } from './auth.service.js';
import { rpc as backendRpc } from './sync-backend-client.service.js';
import {
  isEnvironmentProviderId,
  provisionCapability,
  type CloudEnvironmentCreateInput,
  type CloudEnvironmentHandle,
  type CloudEnvironmentProvider,
  type EnvironmentProviderId,
  type EnvironmentReportParams,
  type ProvisionEnvironmentInputs,
} from '../../../cloud/contract/environment.js';
import {
  type ExecutionManifest,
  type JobSummary,
  type RequestedTarget,
} from '../../../cloud/contract/jobs.js';
import { canonicalJson } from './sync-persistence.service.js';

// ---- persisted shapes --------------------------------------------------------

interface ProviderConnectionRow {
  id: string;
  backend_id: string;
  account_id: string;
  provider: string;
  display_name: string | null;
  config_json: string;
  secret_blob: Buffer | null;
  created_at: string;
  updated_at: string;
}

interface LocalEnvironmentRow {
  environment_id: string;
  backend_id: string;
  account_id: string;
  provider: string;
  state: string;
  handle_json: string | null;
  enrollment_id: string | null;
  job_id: string | null;
  connection_id: string | null;
  created_by: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderConnectionSummary {
  id: string;
  provider: EnvironmentProviderId;
  displayName: string | null;
  /** Non-secret config only — secret material never leaves storage. */
  config: Record<string, unknown>;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

const MAX_ENVIRONMENT_TTL_SECONDS = 7 * 24 * 60 * 60;
const SECRET_CONFIG_KEYS = new Set([
  'accessKeyId',
  'secretAccessKey',
  'sessionToken',
  'token',
  'password',
  'secret',
  'apiKey',
  'privateKey',
]);

const PROVIDER_CONFIG_KEYS: Record<EnvironmentProviderId, ReadonlySet<string>> = {
  'aws-lambda-microvm': new Set([
    'region',
    'imageIdentifier',
    'imageVersion',
    'executionRoleArn',
    'idlePolicy',
    'logGroup',
    'maximumDurationInSeconds',
    'maxIdleDurationSeconds',
    'suspendedDurationSeconds',
    'egressNetworkConnectors',
    'ingressNetworkConnectors',
    // Kept for forward-compatible connection files documented by ENV-03.
    'subnets',
    'securityGroups',
  ]),
  'cloudflare-sandbox': new Set(['url']),
  'vercel-sandbox': new Set(['image', 'region', 'teamId', 'projectId']),
  'anvil-managed': new Set(),
};

const PROVIDER_SECRET_KEYS: Record<EnvironmentProviderId, ReadonlySet<string>> = {
  'aws-lambda-microvm': new Set(['accessKeyId', 'secretAccessKey', 'sessionToken']),
  'cloudflare-sandbox': new Set(['token']),
  'vercel-sandbox': new Set(['token']),
  'anvil-managed': new Set(),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSecretConfigKey(key: string): boolean {
  return (
    SECRET_CONFIG_KEYS.has(key) ||
    /(?:secret|token|password|credential|private|api.?key)/i.test(key)
  );
}

function assertSecretFreeValue(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSecretFreeValue(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (isSecretConfigKey(key)) {
      throw new Error(
        `Provider config cannot contain secret field '${path}.${key}'. Save it as a secret.`,
      );
    }
    assertSecretFreeValue(nested, `${path}.${key}`);
  }
}

function validatePositiveIntegerConfig(value: unknown, key: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Provider config ${key} must be a positive whole number.`);
  }
}

function validateStringArrayConfig(value: unknown, key: string): void {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some(
      (entry) => typeof entry !== 'string' || entry.trim().length === 0 || entry.length > 253,
    )
  ) {
    throw new Error(`Provider config ${key} must be an array of at most 100 non-empty strings.`);
  }
}

function validateIdlePolicyConfig(value: unknown): void {
  if (!isRecord(value)) throw new Error('Provider config idlePolicy must be an object.');
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) =>
        !['maxIdleDurationSeconds', 'suspendedDurationSeconds', 'autoResumeEnabled'].includes(key),
    )
  ) {
    throw new Error('Provider config idlePolicy contains an unknown field.');
  }
  for (const key of ['maxIdleDurationSeconds', 'suspendedDurationSeconds']) {
    if (value[key] !== undefined) validatePositiveIntegerConfig(value[key], `idlePolicy.${key}`);
  }
  if (value['autoResumeEnabled'] !== undefined && typeof value['autoResumeEnabled'] !== 'boolean') {
    throw new Error('Provider config idlePolicy.autoResumeEnabled must be a boolean.');
  }
}

function validateProviderConfig(
  provider: EnvironmentProviderId,
  config: Record<string, unknown>,
): void {
  assertSecretFreeValue(config, 'config');
  const allowed = PROVIDER_CONFIG_KEYS[provider];
  for (const [key, value] of Object.entries(config)) {
    if (!allowed.has(key)) throw new Error(`Unknown ${provider} provider config field '${key}'.`);
    if (key === 'idlePolicy') {
      validateIdlePolicyConfig(value);
    } else if (
      key === 'maximumDurationInSeconds' ||
      key === 'maxIdleDurationSeconds' ||
      key === 'suspendedDurationSeconds'
    ) {
      validatePositiveIntegerConfig(value, key);
    } else if (
      key === 'egressNetworkConnectors' ||
      key === 'ingressNetworkConnectors' ||
      key === 'subnets' ||
      key === 'securityGroups'
    ) {
      validateStringArrayConfig(value, key);
    } else if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4096) {
      throw new Error(`Provider config ${key} must be a non-empty string.`);
    }
  }
  if (provider === 'cloudflare-sandbox' && typeof config['url'] !== 'string') {
    throw new Error('Cloudflare provider connection requires a provisioner `url`.');
  }
}

function parseProviderSecret(
  provider: EnvironmentProviderId,
  secretText: string,
): Record<string, unknown> {
  if (secretText.length > 64_000) throw new Error('Provider secret is too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretText) as unknown;
  } catch (error) {
    throw new Error(
      `Provider secret must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) throw new Error('Provider secret must be a JSON object.');
  const allowed = PROVIDER_SECRET_KEYS[provider];
  for (const [key, value] of Object.entries(parsed)) {
    if (!allowed.has(key)) throw new Error(`Unknown ${provider} provider secret field '${key}'.`);
    if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) {
      throw new Error(`Provider secret ${key} must be a non-empty string.`);
    }
  }
  if (provider === 'aws-lambda-microvm') {
    const hasAccessKey = parsed['accessKeyId'] !== undefined;
    const hasSecretKey = parsed['secretAccessKey'] !== undefined;
    if (hasAccessKey !== hasSecretKey) {
      throw new Error('AWS accessKeyId and secretAccessKey must be supplied together.');
    }
    if (parsed['sessionToken'] !== undefined && !hasAccessKey) {
      throw new Error('AWS sessionToken requires accessKeyId and secretAccessKey.');
    }
  }
  return parsed;
}

function validateEnvironmentTtl(ttlSeconds: number): void {
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 60 ||
    ttlSeconds > MAX_ENVIRONMENT_TTL_SECONDS
  ) {
    throw new Error(
      `Environment lifetime must be a whole number between 60 seconds and ${MAX_ENVIRONMENT_TTL_SECONDS} seconds.`,
    );
  }
}

function validateEnvironmentResources(
  resources: { vcpus?: number; memoryMb?: number } | undefined,
): void {
  if (resources === undefined) return;
  for (const [key, value] of Object.entries(resources)) {
    if (key !== 'vcpus' && key !== 'memoryMb') {
      throw new Error(`Unknown environment resource: ${key}`);
    }
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`Environment resource ${key} must be a positive whole number.`);
    }
  }
}

function validateEnvironmentRequest(input: RequestEnvironmentInput): void {
  if (!isEnvironmentProviderId(input.provider)) {
    throw new Error(`Unknown environment provider: ${String(input.provider)}`);
  }
  validateEnvironmentTtl(input.ttlSeconds);
  validateEnvironmentResources(input.resources);
  if (input.environmentId !== undefined && !/^[a-zA-Z0-9._:-]{1,200}$/.test(input.environmentId)) {
    throw new Error(
      'Environment id must contain only letters, numbers, dots, underscores, colons, or hyphens.',
    );
  }
  if (input.displayName !== undefined && input.displayName.length > 200) {
    throw new Error('Environment label is too long.');
  }
  if (
    input.networkPolicy !== undefined &&
    (input.networkPolicy.length > 100 ||
      input.networkPolicy.some((entry) => entry.trim().length === 0 || entry.length > 253))
  ) {
    throw new Error('Environment network policy must contain at most 100 non-empty hostnames.');
  }
}

function validateCloudflareProvisionerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Cloudflare provisioner URL must be a valid URL.');
  }
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback.has(url.hostname))) {
    throw new Error(
      'Cloudflare provisioner URL must use HTTPS (HTTP is only allowed on loopback).',
    );
  }
  if (url.username || url.password) {
    throw new Error('Cloudflare provisioner URL must not include credentials.');
  }
  return url.href;
}

function validateProviderConnectionInput(input: {
  provider: EnvironmentProviderId;
  config: Record<string, unknown>;
  secret?: string;
}): void {
  if (input.provider === 'anvil-managed') {
    throw new Error('anvil-managed environments do not use provider connections.');
  }
  validateProviderConfig(input.provider, input.config);
  if (input.secret !== undefined) parseProviderSecret(input.provider, input.secret);
  if (input.provider === 'cloudflare-sandbox') {
    const url = stringConfig(input.config, 'url');
    if (url !== undefined) validateCloudflareProvisionerUrl(url);
  }
}

export interface LocalEnvironment {
  environmentId: string;
  provider: EnvironmentProviderId;
  state: string;
  handle: CloudEnvironmentHandle | null;
  enrollmentId: string | null;
  jobId: string | null;
  connectionId: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---- scope -------------------------------------------------------------------
//
// Connection/environment rows are scoped to (backend, account) like every
// other sync-scoped table. The provisioner runs inside the sync session, so
// the scope arrives with the worker context — the service takes it as a
// parameter rather than importing the runtime (daemon-safe).

export interface ProvisionerScope {
  backendId: string;
  accountId: string;
  enrollmentId: string;
  apiUrl: string;
  /** Discovery/base URL for worker bootstrap; unlike apiUrl, this is not the RPC path. */
  backendUrl?: string;
  accessToken: string;
}

// ---- provider connections -----------------------------------------------------

export function addProviderConnection(
  scope: Pick<ProvisionerScope, 'backendId' | 'accountId'>,
  input: {
    provider: EnvironmentProviderId;
    displayName?: string;
    config: Record<string, unknown>;
    /** Provider credential material (e.g. AWS keys as JSON); encrypted at rest. */
    secret?: string;
  },
): ProviderConnectionSummary {
  if (!isEnvironmentProviderId(input.provider)) {
    throw new Error(`Unknown environment provider: ${String(input.provider)}`);
  }
  validateProviderConnectionInput(input);
  const id = `cpc_${randomUUID()}`;
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO cloud_provider_connections
         (id, backend_id, account_id, provider, display_name, config_json, secret_blob,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      scope.backendId,
      scope.accountId,
      input.provider,
      input.displayName ?? null,
      JSON.stringify(input.config),
      input.secret !== undefined ? encryptSecret(input.secret) : null,
      now,
      now,
    );
  const row = readConnection(id);
  if (row === null) throw new Error('provider connection insert failed');
  return connectionSummary(row);
}

export function listProviderConnections(
  scope: Pick<ProvisionerScope, 'backendId' | 'accountId'>,
): ProviderConnectionSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM cloud_provider_connections
       WHERE backend_id = ? AND account_id = ? ORDER BY created_at ASC`,
    )
    .all(scope.backendId, scope.accountId) as ProviderConnectionRow[];
  return rows.map(connectionSummary);
}

export function removeProviderConnection(
  scope: Pick<ProvisionerScope, 'backendId' | 'accountId'>,
  connectionId: string,
): boolean {
  const activeEnvironment = getDb()
    .prepare(
      `SELECT environment_id, state FROM cloud_environments
       WHERE connection_id = ? AND backend_id = ? AND account_id = ?
         AND state <> 'terminated'
         AND NOT (state = 'failed' AND handle_json IS NULL)
       LIMIT 1`,
    )
    .get(connectionId, scope.backendId, scope.accountId) as
    | { environment_id: string; state: string }
    | undefined;
  if (activeEnvironment !== undefined) {
    throw new Error(
      `Provider connection is still needed by environment ${activeEnvironment.environment_id} (${activeEnvironment.state}). Stop and verify cleanup before removing it.`,
    );
  }
  const result = getDb()
    .prepare(
      `DELETE FROM cloud_provider_connections
       WHERE id = ? AND backend_id = ? AND account_id = ?`,
    )
    .run(connectionId, scope.backendId, scope.accountId);
  return result.changes > 0;
}

function readConnection(connectionId: string): ProviderConnectionRow | null {
  const row = getDb()
    .prepare('SELECT * FROM cloud_provider_connections WHERE id = ?')
    .get(connectionId) as ProviderConnectionRow | undefined;
  return row ?? null;
}

function redactSecretConfig(value: unknown): Record<string, unknown> {
  const redact = (nested: unknown): unknown => {
    if (Array.isArray(nested)) return nested.map(redact);
    if (!isRecord(nested)) return nested;
    return Object.fromEntries(
      Object.entries(nested)
        .filter(([key]) => !isSecretConfigKey(key))
        .map(([key, child]) => [key, redact(child)]),
    );
  };
  const redacted = redact(value);
  return isRecord(redacted) ? redacted : {};
}

function connectionSummary(row: ProviderConnectionRow): ProviderConnectionSummary {
  const parsed = JSON.parse(row.config_json) as unknown;
  return {
    id: row.id,
    provider: row.provider as EnvironmentProviderId,
    displayName: row.display_name,
    // Older rows may predate the secret-free config guard. Never reflect a
    // credential-shaped field back across the renderer bridge.
    config: redactSecretConfig(parsed),
    hasSecret: row.secret_blob !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Providers this device can provision — feeds `provision:<id>` capability
 * advertisement so `kind:'auto'` placement routes provision jobs here.
 */
export function provisionCapabilities(
  scope: Pick<ProvisionerScope, 'backendId' | 'accountId'>,
): string[] {
  const providers = new Set(
    listProviderConnections(scope).map((connection) => connection.provider),
  );
  return [...providers].map((provider) => provisionCapability(provider));
}

// ---- provider implementations --------------------------------------------------

interface ResolvedConnection {
  row: ProviderConnectionRow;
  config: Record<string, unknown>;
  secret: Record<string, unknown> | null;
}

function resolveConnection(
  scope: Pick<ProvisionerScope, 'backendId' | 'accountId'>,
  provider: EnvironmentProviderId,
  connectionId?: string,
): ResolvedConnection {
  const rows = (
    connectionId === undefined
      ? (getDb()
          .prepare(
            `SELECT * FROM cloud_provider_connections
             WHERE backend_id = ? AND account_id = ? AND provider = ?
             ORDER BY created_at ASC`,
          )
          .all(scope.backendId, scope.accountId, provider) as ProviderConnectionRow[])
      : ([readConnection(connectionId)].filter(
          (row): row is ProviderConnectionRow => row !== null,
        ) as ProviderConnectionRow[])
  ).filter(
    (row) =>
      row.backend_id === scope.backendId &&
      row.account_id === scope.accountId &&
      row.provider === provider,
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      connectionId === undefined
        ? `No ${provider} provider connection on this device.`
        : `Provider connection ${connectionId} not found for ${provider}.`,
    );
  }
  const secretText = decryptSecret(row.secret_blob, `${provider} connection secret`);
  let secret: Record<string, unknown> | null = null;
  if (secretText !== undefined) {
    try {
      secret = parseProviderSecret(provider, secretText);
    } catch (error) {
      throw new Error(
        `Provider connection ${row.id} holds malformed secret material: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return {
    row,
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    secret,
  };
}

function stringConfig(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberConfig(config: Record<string, unknown>, key: string): number | undefined {
  const value = config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function providerResourceMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; message?: unknown };
  return (
    candidate.name === 'ResourceNotFoundException' ||
    (typeof candidate.message === 'string' &&
      /not.?found|404|does not exist/i.test(candidate.message))
  );
}

/**
 * AWS Lambda MicroVMs — mirrors the lifecycle calls of anvil-cloud's
 * AwsLambdaMicroVmSandboxProvider (PATCH.md C2) against the same SDK. The
 * enrollment code rides `runHookPayload`; the anvil-worker image's /run
 * hook redeems it (`anvil-daemon enroll --code`).
 */
function awsLambdaMicrovmProvider(connection: ResolvedConnection): CloudEnvironmentProvider {
  const secret = connection.secret;
  const accessKeyId = secret?.['accessKeyId'];
  const secretAccessKey = secret?.['secretAccessKey'];
  const sessionToken = secret?.['sessionToken'];
  const client = new LambdaMicrovmsClient({
    region: stringConfig(connection.config, 'region') ?? 'us-east-1',
    ...(typeof accessKeyId === 'string' && typeof secretAccessKey === 'string'
      ? {
          credentials: {
            accessKeyId,
            secretAccessKey,
            ...(typeof sessionToken === 'string' ? { sessionToken } : {}),
          },
        }
      : {}),
  });
  const config = connection.config;
  const handleFrom = (environmentId: string, meta: Record<string, unknown>) => ({
    environmentId,
    providerRef: typeof meta['microvmId'] === 'string' ? meta['microvmId'] : environmentId,
    meta,
  });
  return {
    id: 'aws-lambda-microvm',
    async create(input) {
      const imageIdentifier = input.imageRef ?? stringConfig(config, 'imageIdentifier');
      if (imageIdentifier === undefined) {
        throw new Error(
          'AWS provider connection has no imageIdentifier and no imageRef was given.',
        );
      }
      const request: RunMicrovmCommandInput = {
        imageIdentifier,
        clientToken: `anvil-env-${input.environmentId}`,
        maximumDurationInSeconds:
          numberConfig(config, 'maximumDurationInSeconds') ?? Math.max(input.ttlSeconds, 60),
        idlePolicy: {
          maxIdleDurationSeconds: numberConfig(config, 'maxIdleDurationSeconds') ?? 900,
          suspendedDurationSeconds:
            numberConfig(config, 'suspendedDurationSeconds') ?? Math.max(input.ttlSeconds, 60),
          autoResumeEnabled: true,
        },
        // The worker image's /run hook reads this and redeems the
        // enrollment code — the only secret channel into the environment.
        runHookPayload: JSON.stringify(meshEnvironmentBootstrap(input, 'aws-lambda-microvm')),
      };
      const imageVersion = stringConfig(config, 'imageVersion');
      if (imageVersion !== undefined) request.imageVersion = imageVersion;
      const executionRoleArn = stringConfig(config, 'executionRoleArn');
      if (executionRoleArn !== undefined) request.executionRoleArn = executionRoleArn;
      const egress = config['egressNetworkConnectors'];
      if (Array.isArray(egress) && egress.every((entry) => typeof entry === 'string')) {
        request.egressNetworkConnectors = egress as string[];
      }
      const ingress = config['ingressNetworkConnectors'];
      if (Array.isArray(ingress) && ingress.every((entry) => typeof entry === 'string')) {
        request.ingressNetworkConnectors = ingress as string[];
      }
      const logGroup = stringConfig(config, 'logGroup');
      if (logGroup !== undefined) request.logging = { cloudWatch: { logGroup } };

      const response = await client.send(new RunMicrovmCommand(request));
      return handleFrom(input.environmentId, {
        microvmId: response.microvmId,
        state: response.state,
        endpoint: response.endpoint,
        imageArn: response.imageArn,
        startedAt: response.startedAt?.toISOString(),
        maximumDurationInSeconds: response.maximumDurationInSeconds,
      });
    },
    async inspect(handle) {
      const response = await client
        .send(new GetMicrovmCommand({ microvmIdentifier: handle.providerRef }))
        .catch((error: unknown) => {
          if (providerResourceMissing(error)) return null;
          throw error;
        });
      if (response === null) return 'terminated';
      switch (response.state) {
        case 'PENDING':
          return 'pending';
        case 'RUNNING':
          return 'running';
        case 'SUSPENDING':
        case 'SUSPENDED':
          return 'suspended';
        case 'TERMINATED':
          return 'terminated';
        case 'TERMINATING':
          // The provider accepted teardown, but the microVM is still present.
          // Keep the local/backend record in `terminating` until a later sweep
          // observes `TERMINATED`.
          return 'pending';
        default:
          return 'unknown';
      }
    },
    async terminate(handle) {
      await client
        .send(new TerminateMicrovmCommand({ microvmIdentifier: handle.providerRef }))
        .catch((error: unknown) => {
          if (providerResourceMissing(error)) return undefined;
          throw error;
        });
      return 'requested';
    },
  };
}

/**
 * The provider-neutral bootstrap document every adapter delivers into the
 * environment (image contract: docs/plans/sync-mesh/cloud-environments.md).
 * AWS carries it as `runHookPayload`, Vercel as `ANVIL_BOOTSTRAP_JSON`, and
 * Cloudflare inside the provisioner request body — the image's boot reads
 * whichever channel its provider used.
 */
export function meshEnvironmentBootstrap(
  input: CloudEnvironmentCreateInput,
  provider: EnvironmentProviderId,
): {
  kind: 'anvil.mesh-environment';
  schemaVersion: '0.2';
  environmentId: string;
  provider: EnvironmentProviderId;
  backendUrl: string;
  enrollmentCode: string;
  ttlSeconds: number;
  networkPolicy?: string[];
} {
  return {
    kind: 'anvil.mesh-environment',
    schemaVersion: '0.2',
    environmentId: input.environmentId,
    provider,
    backendUrl: input.backendUrl,
    enrollmentCode: input.bootstrapPayload,
    ttlSeconds: input.ttlSeconds,
    ...(input.networkPolicy === undefined ? {} : { networkPolicy: input.networkPolicy }),
  };
}

const PROVIDER_CALL_TIMEOUT_MS = 30_000;

/**
 * ENV-04: Cloudflare Sandbox environments are created by a provisioner
 * Worker in the customer's own Cloudflare account — sandboxes are bound
 * to Workers, not a public REST API. The connection's `url` points at the
 * deployed `anvil-mesh-provisioner` worker (cloud/provisioner/) and its
 * `token` is the worker's shared bearer. The wire contract is deliberately
 * tiny: create/inspect/delete around a providerRef that is the sandbox id.
 */
function cloudflareSandboxProvider(connection: ResolvedConnection): CloudEnvironmentProvider {
  const baseUrl = stringConfig(connection.config, 'url');
  if (baseUrl === undefined) {
    throw new Error('Cloudflare provider connection has no provisioner `url` configured.');
  }
  const base = validateCloudflareProvisionerUrl(baseUrl).replace(/\/+$/, '');
  const token = connection.secret?.['token'];
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (typeof token === 'string' && token.length > 0) {
    headers['authorization'] = `Bearer ${token}`;
  }
  const call = async <T>(path: string, init: RequestInit): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      redirect: 'error',
      signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as
      | (Record<string, unknown> & { error?: string })
      | null;
    if (!response.ok) {
      const detail = body?.['error'];
      throw new Error(
        `Cloudflare provisioner ${init.method ?? 'GET'} ${path} failed (${response.status})` +
          (typeof detail === 'string' ? `: ${detail}` : ''),
      );
    }
    return body as T;
  };
  return {
    id: 'cloudflare-sandbox',
    async create(input) {
      const created = await call<{ providerRef?: string; environmentId?: string }>(
        '/v1/environments',
        {
          method: 'POST',
          body: JSON.stringify({
            environmentId: input.environmentId,
            ttlSeconds: input.ttlSeconds,
            ...(input.imageRef === undefined ? {} : { imageRef: input.imageRef }),
            bootstrap: meshEnvironmentBootstrap(input, 'cloudflare-sandbox'),
          }),
        },
      );
      if (typeof created.providerRef !== 'string' || created.providerRef.length === 0) {
        throw new Error('Cloudflare provisioner returned no providerRef.');
      }
      return {
        environmentId: input.environmentId,
        providerRef: created.providerRef,
        meta: { provisioner: new URL(base).host },
      };
    },
    async inspect(handle) {
      const got = await call<{ status?: string }>(
        `/v1/environments/${encodeURIComponent(handle.providerRef)}`,
        { method: 'GET' },
      ).catch((error: unknown) => {
        if (providerResourceMissing(error)) return { status: 'terminated' };
        throw error;
      });
      if (got === null) return 'unknown';
      switch (got.status) {
        case 'pending':
        case 'running':
        case 'suspended':
        case 'terminated':
          return got.status;
        default:
          return 'unknown';
      }
    },
    async terminate(handle) {
      await call(`/v1/environments/${encodeURIComponent(handle.providerRef)}`, {
        method: 'DELETE',
      }).catch((error: unknown) => {
        if (providerResourceMissing(error)) return null;
        throw error;
      });
      return 'requested';
    },
  };
}

/**
 * ENV-05: Vercel Sandbox via the `@vercel/sandbox` SDK. The sandbox boots
 * the anvil-worker image (a VCR image reference on the connection or the
 * job's `imageRef`); since Vercel sandboxes have no auto-run entrypoint,
 * create launches the boot script detached with the bootstrap payload in
 * `ANVIL_BOOTSTRAP_JSON`. `persistent: false` — environments are ephemeral
 * and must never restore a prior filesystem snapshot.
 */
function vercelSandboxProvider(connection: ResolvedConnection): CloudEnvironmentProvider {
  const config = connection.config;
  const secret = connection.secret ?? {};
  const credentials = {
    ...(typeof secret['token'] === 'string' ? { token: secret['token'] } : {}),
    ...(typeof config['teamId'] === 'string' ? { teamId: config['teamId'] } : {}),
    ...(typeof config['projectId'] === 'string' ? { projectId: config['projectId'] } : {}),
  };
  const sandboxName = (environmentId: string): string =>
    `anvil-${environmentId.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`.slice(0, 63);
  return {
    id: 'vercel-sandbox',
    async create(input) {
      const image = input.imageRef ?? stringConfig(config, 'image');
      if (image === undefined) {
        throw new Error(
          'Vercel provider connection has no `image` configured and no imageRef was given.',
        );
      }
      const region = stringConfig(config, 'region');
      const sandbox = await Sandbox.create({
        name: sandboxName(input.environmentId),
        image,
        timeout: Math.max(input.ttlSeconds, 60) * 1000,
        persistent: false,
        env: {
          ANVIL_BOOTSTRAP_JSON: JSON.stringify(meshEnvironmentBootstrap(input, 'vercel-sandbox')),
        },
        ...(input.networkPolicy === undefined
          ? {}
          : { networkPolicy: { allow: input.networkPolicy } }),
        ...(input.resources?.vcpus === undefined
          ? {}
          : { resources: { vcpus: input.resources.vcpus } }),
        ...(region === undefined ? {} : { region }),
        ...credentials,
      });
      // No auto-run entrypoint on Vercel: launch the image's boot script
      // detached. It redeems the enrollment code and `exec`s the daemon.
      await sandbox.runCommand({
        cmd: '/opt/anvil/bin/anvil-worker-boot',
        detached: true,
      });
      return {
        environmentId: input.environmentId,
        providerRef: sandbox.name,
        meta: { image },
      };
    },
    async inspect(handle) {
      const sandbox = await Sandbox.get({
        name: handle.providerRef,
        ...credentials,
      }).catch((error: unknown) => {
        if (error instanceof Error && /not.?found/i.test(error.message)) return null;
        throw error;
      });
      if (sandbox === null) return 'terminated';
      switch (sandbox.status) {
        case 'pending':
          return 'pending';
        case 'running':
          return 'running';
        case 'snapshotting':
          return 'suspended';
        case 'stopping':
          return 'pending';
        case 'stopped':
        case 'failed':
        case 'aborted':
          return 'terminated';
        default:
          return 'unknown';
      }
    },
    async terminate(handle) {
      // Not-found is idempotent — the sandbox may already be gone after TTL.
      const sandbox = await Sandbox.get({
        name: handle.providerRef,
        ...credentials,
      }).catch((error: unknown) => {
        if (error instanceof Error && /not.?found/i.test(error.message)) return null;
        throw error;
      });
      if (sandbox === null) return 'verified';
      await sandbox.stop();
      // Vercel acknowledges stop before the sandbox disappears. Let the
      // service inspect immediately and keep `terminating` until it reports
      // `stopped` (or a later sweep verifies it is gone).
      return 'requested';
    },
  };
}

function providerFor(
  provider: EnvironmentProviderId,
  connection: ResolvedConnection,
): CloudEnvironmentProvider {
  switch (provider) {
    case 'aws-lambda-microvm':
      return awsLambdaMicrovmProvider(connection);
    case 'cloudflare-sandbox':
      return cloudflareSandboxProvider(connection);
    case 'vercel-sandbox':
      return vercelSandboxProvider(connection);
    // ENV-09: `anvil-managed` environments are provisioned by the hosted
    // backend itself — no device-side provider exists. Environments are
    // requested via `requestEnvironment` (bootstrap payload + job.create).
    case 'anvil-managed':
      throw new Error(
        'anvil-managed environments are provisioned by the hosted backend; ' +
          'request them via requestEnvironment, not a provider connection.',
      );
  }
}

// ---- environment registry -------------------------------------------------------

function writeLocalEnvironment(
  scope: Pick<ProvisionerScope, 'backendId' | 'accountId'>,
  env: {
    environmentId: string;
    provider: EnvironmentProviderId;
    state: string;
    handle?: CloudEnvironmentHandle | null;
    enrollmentId?: string | null;
    jobId?: string | null;
    connectionId?: string | null;
    expiresAt?: string | null;
  },
): void {
  const now = nowIso();
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT backend_id, account_id, provider FROM cloud_environments
       WHERE environment_id = ?`,
    )
    .get(env.environmentId) as
    | { backend_id: string; account_id: string; provider: string }
    | undefined;
  if (
    existing !== undefined &&
    (existing.backend_id !== scope.backendId ||
      existing.account_id !== scope.accountId ||
      existing.provider !== env.provider)
  ) {
    throw new Error(`Environment ${env.environmentId} already belongs to another sync scope.`);
  }
  db.prepare(
    `INSERT INTO cloud_environments (
         environment_id, backend_id, account_id, provider, state, handle_json,
         enrollment_id, job_id, connection_id, created_by, expires_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(environment_id) DO UPDATE SET
         state = excluded.state,
         handle_json = COALESCE(excluded.handle_json, handle_json),
         enrollment_id = COALESCE(excluded.enrollment_id, enrollment_id),
         job_id = COALESCE(excluded.job_id, job_id),
         expires_at = COALESCE(excluded.expires_at, expires_at),
         updated_at = excluded.updated_at`,
  ).run(
    env.environmentId,
    scope.backendId,
    scope.accountId,
    env.provider,
    env.state,
    env.handle === undefined || env.handle === null ? null : JSON.stringify(env.handle),
    env.enrollmentId ?? null,
    env.jobId ?? null,
    env.connectionId ?? null,
    scope.accountId,
    env.expiresAt ?? null,
    now,
    now,
  );
}

function toLocalEnvironment(row: LocalEnvironmentRow): LocalEnvironment {
  return {
    environmentId: row.environment_id,
    provider: row.provider as EnvironmentProviderId,
    state: row.state,
    handle:
      row.handle_json === null ? null : (JSON.parse(row.handle_json) as CloudEnvironmentHandle),
    enrollmentId: row.enrollment_id,
    jobId: row.job_id,
    connectionId: row.connection_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listLocalEnvironments(
  scope: Pick<ProvisionerScope, 'backendId' | 'accountId'>,
): LocalEnvironment[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM cloud_environments
       WHERE backend_id = ? AND account_id = ? ORDER BY created_at DESC`,
    )
    .all(scope.backendId, scope.accountId) as LocalEnvironmentRow[];
  return rows.map(toLocalEnvironment);
}

// ---- provisioning ---------------------------------------------------------------

export interface RequestEnvironmentInput {
  provider: EnvironmentProviderId;
  ttlSeconds: number;
  /** Pre-allocated environment id; minted when omitted. */
  environmentId?: string;
  imageRef?: string;
  networkPolicy?: string[];
  resources?: { vcpus?: number; memoryMb?: number };
  displayName?: string;
  /** BYO providers: which stored connection the claimer should use. */
  connectionId?: string;
}

export interface RequestEnvironmentResult {
  environmentId: string;
  job: JobSummary;
}

/**
 * Same-device retries share one managed request while the bootstrap code is
 * being issued and staged. The backend remains the idempotency authority;
 * this closes the only local window where two callers could mint two codes
 * before either reached `job.create`.
 */
const managedEnvironmentRequestFlights = new Map<string, Promise<RequestEnvironmentResult>>();

async function findManagedRequestJob(
  scope: ProvisionerScope,
  requestId: string,
): Promise<JobSummary | null> {
  // `requestId` is an additive filter on the existing job.list operation.
  // Current backends enforce the exact source-scoped lookup. Older compatible
  // backends may ignore the optional field, so search a bounded recent page
  // locally before deciding that this is a new request.
  const listed = await backendRpc<{ jobs: JobSummary[] }>(
    { apiUrl: scope.apiUrl },
    'job.list',
    { requestId, limit: 100 },
    scope.accessToken,
  );
  return (
    listed.result.jobs.find(
      (job) => job.requestId === requestId && job.sourceEnrollmentId === scope.enrollmentId,
    ) ?? null
  );
}

/**
 * ENV-01/ENV-09 source path: create a `provision-environment` job.
 * `kind:'auto'` placement + the `provision:<provider>` capability
 * requirement route BYO jobs to whichever device holds the provider
 * connection; `anvil-managed` jobs are claimed by the backend's own
 * managed provisioner instead, so the source must first stage an
 * ephemeral-class enrollment code via `environment.bootstrap` — the code
 * authenticates the worker; it carries no account key material.
 */
export async function requestEnvironment(
  scope: ProvisionerScope,
  input: RequestEnvironmentInput,
  deps: {
    /** Required for `anvil-managed`; supplied by the sync runtime. */
    mintEnvironmentCode?: (options: {
      provider: string;
      ttlSeconds: number;
      environmentId: string;
      displayName?: string;
    }) => Promise<string | null>;
  } = {},
): Promise<RequestEnvironmentResult> {
  validateEnvironmentRequest(input);
  const environmentId = input.environmentId ?? `env_${randomUUID()}`;
  const normalizedInput = { ...input, environmentId };
  if (input.provider !== 'anvil-managed') {
    return requestEnvironmentOnce(scope, normalizedInput, deps);
  }
  const flightKey = `${scope.backendId}:${scope.accountId}:${environmentId}:${canonicalJson(normalizedInput)}`;
  const inFlight = managedEnvironmentRequestFlights.get(flightKey);
  if (inFlight !== undefined) return inFlight;
  const request = requestEnvironmentOnce(scope, normalizedInput, deps);
  managedEnvironmentRequestFlights.set(flightKey, request);
  try {
    return await request;
  } finally {
    if (managedEnvironmentRequestFlights.get(flightKey) === request) {
      managedEnvironmentRequestFlights.delete(flightKey);
    }
  }
}

async function requestEnvironmentOnce(
  scope: ProvisionerScope,
  input: RequestEnvironmentInput & { environmentId: string },
  deps: {
    mintEnvironmentCode?: (options: {
      provider: string;
      ttlSeconds: number;
      environmentId: string;
      displayName?: string;
    }) => Promise<string | null>;
  },
): Promise<RequestEnvironmentResult> {
  const environmentId = input.environmentId;
  const manifestInputs: ProvisionEnvironmentInputs = {
    environmentId,
    provider: input.provider,
    ttlSeconds: input.ttlSeconds,
    ...(input.imageRef === undefined ? {} : { imageRef: input.imageRef }),
    ...(input.networkPolicy === undefined ? {} : { networkPolicy: input.networkPolicy }),
    ...(input.resources === undefined ? {} : { resources: input.resources }),
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
  };
  const manifest: ExecutionManifest = {
    workspaceDefinitionRevision: 'environment',
    repositories: [],
    bootstrapDigest: 'environment',
    provider: 'anvil',
    model: 'none',
    configVersions: {},
    inputs: manifestInputs as unknown as Record<string, unknown>,
  };
  const requestedTarget: RequestedTarget = {
    kind: 'auto',
    requirements: { capabilities: [provisionCapability(input.provider)] },
  };
  const requestId = `env-${environmentId}`;
  const payloadHash = createHash('sha256')
    .update(
      canonicalJson({
        kind: 'provision-environment',
        requestedTarget,
        inputManifest: manifest,
      }),
      'utf8',
    )
    .digest('hex');

  if (input.provider === 'anvil-managed') {
    // Recover the existing idempotent job before issuing another ephemeral
    // code. Current backends apply the requestId filter source-scoped; older
    // compatible backends may ignore it, so the helper searches a bounded
    // recent page before minting.
    const existingJob = await findManagedRequestJob(scope, requestId);
    if (existingJob !== null) {
      if (existingJob.payloadHash !== payloadHash) {
        throw new Error('An environment request with this id already uses different settings.');
      }
      writeLocalEnvironment(scope, {
        environmentId,
        provider: input.provider,
        state: 'provisioning',
        jobId: existingJob.id,
        connectionId: input.connectionId ?? null,
      });
      return { environmentId, job: existingJob };
    }
    const mint = deps.mintEnvironmentCode;
    if (mint === undefined) {
      throw new Error(
        'anvil-managed requests need an enrollment code issuer (mintEnvironmentCode).',
      );
    }
    const payload = await mint({
      provider: input.provider,
      ttlSeconds: input.ttlSeconds,
      environmentId,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    });
    if (payload === null) {
      throw new Error('Failed to mint an ephemeral enrollment code for the managed environment.');
    }
    // Stage before job.create: the managed claimer consumes the code
    // when it accepts the provision job. Unconsumed rows expire.
    await backendRpc(
      { apiUrl: scope.apiUrl },
      'environment.bootstrap',
      { environmentId, payload },
      scope.accessToken,
    );
  }
  const { result } = await backendRpc<{ job: JobSummary }>(
    { apiUrl: scope.apiUrl },
    'job.create',
    {
      requestId,
      payloadHash,
      kind: 'provision-environment',
      requestedTarget,
      inputManifest: manifest,
      // Cold start is honest: give provisioning room inside the deadline.
      queueDeadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      retryPolicy: 'never',
    },
    scope.accessToken,
  );
  writeLocalEnvironment(scope, {
    environmentId,
    provider: input.provider,
    state: 'provisioning',
    jobId: result.job.id,
    connectionId: input.connectionId ?? null,
  });
  return { environmentId, job: result.job };
}

async function reportEnvironment(
  scope: ProvisionerScope,
  report: Omit<EnvironmentReportParams, 'provider' | 'environmentId'> & {
    environmentId: string;
    provider: EnvironmentProviderId;
  },
): Promise<void> {
  await backendRpc({ apiUrl: scope.apiUrl }, 'environment.report', report, scope.accessToken);
}

/**
 * ENV-03 provision-environment executor path: create the provider
 * environment with the ephemeral enrollment code as its only secret channel, record
 * the handle locally, and report lifecycle progress. Enrollment completes
 * asynchronously inside the env — it self-reports `enrolled` once its
 * worker is up.
 */
export async function provisionEnvironment(
  scope: ProvisionerScope,
  inputs: ProvisionEnvironmentInputs,
  bootstrapPayload: string,
  jobId?: string,
): Promise<Record<string, unknown>> {
  validateEnvironmentRequest(inputs);
  const connection = resolveConnection(scope, inputs.provider, inputs.connectionId);
  const provider = providerFor(inputs.provider, connection);
  const expiresAt = new Date(Date.now() + inputs.ttlSeconds * 1000).toISOString();

  writeLocalEnvironment(scope, {
    environmentId: inputs.environmentId,
    provider: inputs.provider,
    state: 'provisioning',
    jobId: jobId ?? null,
    connectionId: connection.row.id,
    expiresAt,
  });
  await reportEnvironment(scope, {
    environmentId: inputs.environmentId,
    provider: inputs.provider,
    state: 'provisioning',
    ...(jobId === undefined ? {} : { jobId }),
    expiresAt,
  });

  const createInput: CloudEnvironmentCreateInput = {
    environmentId: inputs.environmentId,
    bootstrapPayload,
    backendUrl: scope.backendUrl ?? scope.apiUrl,
    ttlSeconds: inputs.ttlSeconds,
    ...(inputs.imageRef === undefined ? {} : { imageRef: inputs.imageRef }),
    ...(inputs.networkPolicy === undefined ? {} : { networkPolicy: inputs.networkPolicy }),
    ...(inputs.resources === undefined ? {} : { resources: inputs.resources }),
  };
  let handle: CloudEnvironmentHandle;
  try {
    handle = await provider.create(createInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLocalEnvironment(scope, {
      environmentId: inputs.environmentId,
      provider: inputs.provider,
      state: 'failed',
    });
    await reportEnvironment(scope, {
      environmentId: inputs.environmentId,
      provider: inputs.provider,
      state: 'failed',
      ...(jobId === undefined ? {} : { jobId }),
      error: message,
    }).catch(() => undefined);
    throw error;
  }
  writeLocalEnvironment(scope, {
    environmentId: inputs.environmentId,
    provider: inputs.provider,
    state: 'provisioning',
    handle,
    jobId: jobId ?? null,
    connectionId: connection.row.id,
    expiresAt,
  });
  await reportEnvironment(scope, {
    environmentId: inputs.environmentId,
    provider: inputs.provider,
    state: 'provisioning',
    handle: handle.meta ?? {},
    ...(jobId === undefined ? {} : { jobId }),
    expiresAt,
  });
  return {
    environmentId: inputs.environmentId,
    provider: inputs.provider,
    providerRef: handle.providerRef,
    expiresAt,
  };
}

/**
 * Terminate an environment this device provisioned (or can reach through a
 * matching provider connection), then report the verified/requested
 * terminal state. Idempotent — a gone env reports terminated again.
 */
export async function terminateEnvironment(
  scope: ProvisionerScope,
  environmentId: string,
): Promise<'requested' | 'verified' | 'untracked'> {
  const rows = getDb()
    .prepare('SELECT * FROM cloud_environments WHERE environment_id = ?')
    .all(environmentId) as LocalEnvironmentRow[];
  const row = rows.find(
    (candidate) =>
      candidate.backend_id === scope.backendId && candidate.account_id === scope.accountId,
  );
  if (row === undefined || row.handle_json === null) {
    return 'untracked';
  }
  const provider = providerFor(
    row.provider as EnvironmentProviderId,
    resolveConnection(scope, row.provider as EnvironmentProviderId, row.connection_id ?? undefined),
  );
  const handle = JSON.parse(row.handle_json) as CloudEnvironmentHandle;
  const outcome = await provider.terminate(handle);
  let verified = outcome === 'verified';
  if (!verified) {
    // A provider may acknowledge a termination request before the resource is
    // actually gone. Inspect immediately when possible, then leave the row in
    // `terminating` so the next worker sweep can retry and verify it. This is
    // deliberately conservative: a request receipt is not a deletion receipt.
    try {
      verified = (await provider.inspect(handle)) === 'terminated';
    } catch {
      verified = false;
    }
  }
  writeLocalEnvironment(scope, {
    environmentId,
    provider: row.provider as EnvironmentProviderId,
    state: verified ? 'terminated' : 'terminating',
  });
  await reportEnvironment(scope, {
    environmentId,
    provider: row.provider as EnvironmentProviderId,
    state: verified ? 'terminated' : 'terminating',
    reaped: verified,
  }).catch(() => undefined);
  return verified ? 'verified' : 'requested';
}

/**
 * Orphan sweep: environments this device provisioned whose TTL elapsed, or
 * whose backend record shows reap intent (`reap-requested`/`expired`), get
 * terminated. Called on worker connect — the durable reap intent survives
 * the creator going offline, so any provisioner-capable device holding the
 * handle can finish cleanup.
 */
export async function reapExpiredEnvironments(scope: ProvisionerScope): Promise<number> {
  const now = nowIso();
  const local = listLocalEnvironments(scope);
  const stale = new Set(
    local
      .filter(
        (env) =>
          env.state !== 'terminated' &&
          (env.state === 'terminating' ||
            (env.state === 'failed' && env.handle !== null) ||
            (env.expiresAt !== null && env.expiresAt <= now)),
      )
      .map((env) => env.environmentId),
  );
  // Backend reap intent: any environment in a cleanup state that this
  // device tracks locally (it holds the provider handle) gets terminated.
  try {
    const { result } = await backendRpc<{
      environments: { environmentId: string; state: string }[];
    }>({ apiUrl: scope.apiUrl }, 'environment.list', { includeTerminal: false }, scope.accessToken);
    const tracked = new Map(local.map((env) => [env.environmentId, env] as const));
    for (const remote of result.environments) {
      if (remote.state !== 'reap-requested' && remote.state !== 'expired') continue;
      const env = tracked.get(remote.environmentId);
      if (env !== undefined && env.handle !== null) {
        stale.add(env.environmentId);
      }
    }
  } catch {
    // Backend unreachable — the local TTL pass still runs.
  }
  let reaped = 0;
  for (const environmentId of stale) {
    try {
      const outcome = await terminateEnvironment(scope, environmentId);
      if (outcome === 'verified') reaped += 1;
    } catch {
      // Provider errors leave the row — the next sweep retries.
    }
  }
  return reaped;
}
