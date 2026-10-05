import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isMeshEndpointFlagEnabled } from './mesh-endpoint-flag.service.js';

export const MESH_MANAGED_ENDPOINTS_FLAG = 'ANVIL_MESH_MANAGED_ENDPOINTS';
export const MESH_CLOUDFLARED_PATH = 'ANVIL_CLOUDFLARED_PATH';

function isManagedEndpointsEnabled(env: NodeJS.ProcessEnv): boolean {
  return isMeshEndpointFlagEnabled(
    env[MESH_MANAGED_ENDPOINTS_FLAG],
    process.env.ANVIL_MESH_MANAGED_ENDPOINTS,
  );
}

export type ManagedConnectorState = 'stopped' | 'starting' | 'running' | 'unsupported' | 'error';

export interface ManagedConnectorAssignment {
  machineId: string;
  endpointGeneration: string;
  allocationGeneration: number;
  hostname: string;
  /** Host-specific Cloudflare Tunnel token, received from the authenticated broker route. */
  connectorToken: string;
  /** This is supplied by the companion server itself, never by a remote caller. */
  localOrigin: string;
}

export interface ManagedConnectorStatus {
  state: ManagedConnectorState;
  machineId?: string;
  endpointGeneration?: string;
  allocationGeneration?: number;
  hostname?: string;
  reason?:
    | 'disabled'
    | 'binary-unavailable'
    | 'stale-generation'
    | 'process-exited'
    | 'spawn-failed'
    | 'broker-unavailable';
}

export interface MeshManagedEndpointContext {
  apiUrl: string;
  accessToken: string;
}

export interface ManagedHostEndpointResult {
  status: ManagedConnectorStatus;
  managedOrigin: string | null;
  allocationGeneration: number | null;
}

export interface MeshManagedEndpointLifecycleOptions {
  context: () => MeshManagedEndpointContext | null;
  enabled?: () => boolean;
  fetch?: typeof fetch;
}

interface SpawnOptions {
  stdio: 'ignore';
  windowsHide: boolean;
  shell: false;
  env: NodeJS.ProcessEnv;
}

interface NormalizedOptions {
  enabled: () => boolean;
  env: NodeJS.ProcessEnv;
  resourcesPath: string | undefined;
  platform: NodeJS.Platform;
  arch: string;
  pathExists: (path: string, executable: boolean) => Promise<boolean>;
  spawn: ConnectorSpawn;
  makeTempDir: (prefix: string) => Promise<string>;
  writeSecretFile: (path: string, secret: string) => Promise<void>;
  removeTempDir: (path: string) => Promise<void>;
  startupTimeoutMs: number;
  stopTimeoutMs: number;
}

export type ConnectorSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface MeshManagedConnectorOptions {
  enabled?: () => boolean;
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  pathExists?: (path: string, executable: boolean) => Promise<boolean>;
  spawn?: ConnectorSpawn;
  makeTempDir?: (prefix: string) => Promise<string>;
  writeSecretFile?: (path: string, secret: string) => Promise<void>;
  removeTempDir?: (path: string) => Promise<void>;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
};

interface ActiveConnector {
  assignment: ManagedConnectorAssignment;
  child: ChildProcess;
  secretDir: string;
  status: ManagedConnectorStatus;
  cleanupPromise: Promise<void> | null;
}

const SAFE_MACHINE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;

/**
 * Owns one managed connector process for this Anvil execution host. The token is
 * written to a private short-lived file because cloudflared supports `--token-file`;
 * it never appears in argv, status, or logs. The broker credential is generation
 * fenced and is never persisted by this service.
 */
export class MeshManagedConnector {
  private readonly options: NormalizedOptions;
  private active: ActiveConnector | null = null;
  private requestedAssignment: ManagedConnectorAssignment | null = null;
  private lastStatus: ManagedConnectorStatus = { state: 'stopped' };
  private operation: Promise<ManagedConnectorStatus> = Promise.resolve(this.lastStatus);
  private requestedRevision = 0;

  constructor(options: MeshManagedConnectorOptions = {}) {
    const env = options.env ?? process.env;
    this.options = {
      enabled: options.enabled ?? (() => isManagedEndpointsEnabled(env)),
      env,
      resourcesPath: options.resourcesPath ?? process.resourcesPath,
      platform: options.platform ?? process.platform,
      arch: options.arch ?? process.arch,
      pathExists: options.pathExists ?? executablePathExists,
      spawn: options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions)),
      makeTempDir: options.makeTempDir ?? ((prefix) => mkdtemp(join(tmpdir(), prefix))),
      writeSecretFile: options.writeSecretFile ?? writePrivateSecretFile,
      removeTempDir: options.removeTempDir ?? ((path) => rm(path, { recursive: true, force: true })),
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      stopTimeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
    };
  }

  status(): ManagedConnectorStatus {
    return { ...this.lastStatus };
  }

  start(assignment: ManagedConnectorAssignment): Promise<ManagedConnectorStatus> {
    const revision = ++this.requestedRevision;
    this.requestedAssignment = { ...assignment, connectorToken: '' };
    const run = this.operation.then(() => this.startSerial(assignment, revision));
    this.operation = run.catch(() => this.status());
    return run;
  }

  stop(reason: ManagedConnectorStatus['reason'] = undefined): Promise<ManagedConnectorStatus> {
    ++this.requestedRevision;
    this.requestedAssignment = null;
    const run = this.operation.then(async () => {
      await this.stopActive();
      this.lastStatus = reason ? { state: 'stopped', reason } : { state: 'stopped' };
      return this.status();
    });
    this.operation = run.catch(() => this.status());
    return run;
  }

  /** A stale release can never stop the currently active generation. */
  stopGeneration(input: {
    machineId: string;
    endpointGeneration: string;
    allocationGeneration: number;
  }): Promise<ManagedConnectorStatus> {
    const desired = this.requestedAssignment ?? this.active?.assignment;
    if (
      desired === undefined ||
      desired === null ||
      desired.machineId !== input.machineId ||
      desired.endpointGeneration !== input.endpointGeneration ||
      desired.allocationGeneration !== input.allocationGeneration
    ) {
      return Promise.resolve({ ...this.status(), reason: 'stale-generation' });
    }
    ++this.requestedRevision;
    this.requestedAssignment = null;
    const run = this.operation.then(async () => {
      const current = this.active?.assignment;
      if (
        current === undefined ||
        current.machineId !== input.machineId ||
        current.endpointGeneration !== input.endpointGeneration ||
        current.allocationGeneration !== input.allocationGeneration
      ) {
        return { ...this.status(), reason: 'stale-generation' as const };
      }
      await this.stopActive();
      this.lastStatus = { state: 'stopped' };
      return this.status();
    });
    this.operation = run.catch(() => this.status());
    return run;
  }

  private async startSerial(
    assignment: ManagedConnectorAssignment,
    revision: number,
  ): Promise<ManagedConnectorStatus> {
    if (revision !== this.requestedRevision) return this.status();
    const invalid = validateAssignment(assignment);
    if (invalid !== null) {
      this.lastStatus = { state: 'error', reason: 'spawn-failed' };
      return this.status();
    }
    if (!this.options.enabled()) {
      this.lastStatus = {
        state: 'unsupported',
        machineId: assignment.machineId,
        endpointGeneration: assignment.endpointGeneration,
        allocationGeneration: assignment.allocationGeneration,
        hostname: assignment.hostname,
        reason: 'disabled',
      };
      return this.status();
    }

    const previous = this.active?.assignment;
    if (
      previous &&
      previous.machineId === assignment.machineId &&
      previous.endpointGeneration === assignment.endpointGeneration &&
      assignment.allocationGeneration < previous.allocationGeneration
    ) {
      return { ...this.status(), reason: 'stale-generation' };
    }
    if (
      previous &&
      previous.machineId === assignment.machineId &&
      previous.endpointGeneration === assignment.endpointGeneration &&
      previous.allocationGeneration === assignment.allocationGeneration &&
      this.active?.status.state === 'running'
    ) {
      return this.status();
    }

    await this.stopActive();
    const binary = await resolveCloudflaredPath(this.options);
    if (binary === null) {
      this.lastStatus = {
        state: 'unsupported',
        machineId: assignment.machineId,
        endpointGeneration: assignment.endpointGeneration,
        allocationGeneration: assignment.allocationGeneration,
        hostname: assignment.hostname,
        reason: 'binary-unavailable',
      };
      return this.status();
    }

    let secretDir: string | null = null;
    let child: ChildProcess | null = null;
    try {
      secretDir = await this.options.makeTempDir('anvil-cloudflared-');
      const secretPath = join(secretDir, 'token');
      await this.options.writeSecretFile(secretPath, assignment.connectorToken);
      child = this.options.spawn(
        binary,
        ['tunnel', '--no-autoupdate', '--loglevel', 'error', 'run', '--token-file', secretPath],
        {
          stdio: 'ignore',
          windowsHide: true,
          shell: false,
          // Environment is intentionally inherited without embedding the credential.
          env: { ...this.options.env },
        },
      );
      const active: ActiveConnector = {
        assignment: { ...assignment, connectorToken: '' },
        child,
        secretDir,
        status: {
          state: 'starting',
          machineId: assignment.machineId,
          endpointGeneration: assignment.endpointGeneration,
          allocationGeneration: assignment.allocationGeneration,
          hostname: assignment.hostname,
        },
        cleanupPromise: null,
      };
      this.active = active;
      this.lastStatus = { ...active.status };
      child.once('error', () => {
        if (this.active !== active) return;
        active.status = { ...active.status, state: 'error', reason: 'spawn-failed' };
        this.lastStatus = { ...active.status };
        void this.cleanup(active);
      });
      child.once('exit', () => {
        if (this.active !== active) return;
        active.status = { ...active.status, state: 'error', reason: 'process-exited' };
        this.lastStatus = { ...active.status };
        void this.cleanup(active);
      });
      await waitForSpawn(child, this.options.startupTimeoutMs);
      if (this.active !== active || child.exitCode !== null || revision !== this.requestedRevision) {
        if (this.active === active && revision !== this.requestedRevision) await this.stopActive();
        return this.status();
      }
      active.status = { ...active.status, state: 'running' };
      this.lastStatus = { ...active.status };
      return this.status();
    } catch {
      if (child !== null && child.exitCode === null) child.kill('SIGTERM');
      if (secretDir !== null) await this.options.removeTempDir(secretDir).catch(() => undefined);
      this.active = null;
      this.lastStatus = {
        state: 'error',
        machineId: assignment.machineId,
        endpointGeneration: assignment.endpointGeneration,
        allocationGeneration: assignment.allocationGeneration,
        hostname: assignment.hostname,
        reason: 'spawn-failed',
      };
      return this.status();
    }
  }

  private async stopActive(): Promise<void> {
    const active = this.active;
    if (active === null) return;
    active.child.kill('SIGTERM');
    await waitForExit(active.child, this.options.stopTimeoutMs);
    if (active.child.exitCode === null && active.child.signalCode === null) {
      active.child.kill('SIGKILL');
      await waitForExit(active.child, this.options.stopTimeoutMs);
    }
    await this.cleanup(active);
    if (this.active === active) this.active = null;
  }

  private async cleanup(active: ActiveConnector): Promise<void> {
    if (active.cleanupPromise !== null) return active.cleanupPromise;
    active.cleanupPromise = this.options.removeTempDir(active.secretDir).catch(() => undefined);
    await active.cleanupPromise;
    if (this.active === active) this.active = null;
  }
}

function validateAssignment(value: ManagedConnectorAssignment): string | null {
  if (
    !SAFE_MACHINE_ID.test(value.machineId) ||
    !SAFE_MACHINE_ID.test(value.endpointGeneration) ||
    !Number.isSafeInteger(value.allocationGeneration) ||
    value.allocationGeneration < 1 ||
    !SAFE_HOSTNAME.test(value.hostname) ||
    value.connectorToken.length < 40 ||
    value.connectorToken.length > 8_192
  ) {
    return 'invalid-assignment';
  }
  try {
    const origin = new URL(value.localOrigin);
    const loopback =
      origin.hostname === 'localhost' ||
      origin.hostname === '127.0.0.1' ||
      origin.hostname === '[::1]' ||
      origin.hostname === '::1';
    if (
      !loopback ||
      (origin.protocol !== 'http:' && origin.protocol !== 'https:') ||
      origin.username !== '' ||
      origin.password !== '' ||
      origin.pathname !== '/' ||
      origin.search !== '' ||
      origin.hash !== '' ||
      !Number.isInteger(Number(origin.port)) ||
      Number(origin.port) < 1 ||
      Number(origin.port) > 65_535
    ) {
      return 'invalid-local-origin';
    }
  } catch {
    return 'invalid-local-origin';
  }
  return null;
}

async function resolveCloudflaredPath(options: NormalizedOptions): Promise<string | null> {
  const candidates: string[] = [];
  const configuredPath = options.env[MESH_CLOUDFLARED_PATH]?.trim();
  if (configuredPath) candidates.push(configuredPath);
  const executableName = options.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const bundledPlatform = `${options.platform}-${options.arch}`;
  if (options.resourcesPath) {
    candidates.push(join(options.resourcesPath, 'cloudflared', bundledPlatform, executableName));
  }
  if (options.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared');
  }
  for (const directory of (options.env.PATH ?? '').split(delimiter)) {
    if (directory.length > 0) candidates.push(join(directory, executableName));
  }
  for (const candidate of candidates) {
    if (await options.pathExists(candidate, true)) return candidate;
  }
  return null;
}

async function executablePathExists(path: string, executable: boolean): Promise<boolean> {
  try {
    await access(path, executable ? fsConstants.X_OK : fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writePrivateSecretFile(path: string, secret: string): Promise<void> {
  await writeFile(path, secret, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

function waitForSpawn(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('spawn timeout')), timeoutMs);
    const onSpawn = () => finish();
    const onError = (error: Error) => finish(error);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.off('spawn', onSpawn);
      child.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timeout);
      child.off('exit', finish);
      child.off('close', finish);
      resolve();
    };
    timeout = setTimeout(finish, timeoutMs);
    child.once('exit', finish);
    child.once('close', finish);
  });
}

let managedConnector = new MeshManagedConnector();
let managedEndpointLifecycle: MeshManagedEndpointLifecycleOptions | null = null;
let managedPresenceHeartbeat: ReturnType<typeof setInterval> | null = null;

/** Replace the process owner with a test or host-specific implementation. */
export function configureMeshManagedConnector(
  options: MeshManagedConnectorOptions | MeshManagedConnector,
): void {
  managedConnector = options instanceof MeshManagedConnector ? options : new MeshManagedConnector(options);
}

export function startMeshManagedConnector(
  assignment: ManagedConnectorAssignment,
): Promise<ManagedConnectorStatus> {
  return managedConnector.start(assignment);
}

export function stopMeshManagedConnector(
  reason?: ManagedConnectorStatus['reason'],
): Promise<ManagedConnectorStatus> {
  return managedConnector.stop(reason);
}

export function stopMeshManagedConnectorGeneration(input: {
  machineId: string;
  endpointGeneration: string;
  allocationGeneration: number;
}): Promise<ManagedConnectorStatus> {
  return managedConnector.stopGeneration(input);
}

export function getMeshManagedConnectorStatus(): ManagedConnectorStatus {
  return managedConnector.status();
}

/**
 * Configure the authenticated broker client used only by the execution host.
 * Account access tokens remain in the main-process closure and are sent only
 * in the Authorization header to the configured HTTPS backend.
 */
export function configureMeshManagedEndpointLifecycle(
  options: MeshManagedEndpointLifecycleOptions | null,
): void {
  managedEndpointLifecycle = options;
}

export async function startManagedEndpointForHost(input: {
  machineId: string;
  endpointGeneration: string;
  localOrigin: string;
}): Promise<ManagedHostEndpointResult> {
  const lifecycle = managedEndpointLifecycle;
  if (
    lifecycle === null ||
    !(lifecycle.enabled ?? (() => isManagedEndpointsEnabled(process.env)))()
  ) {
    clearManagedPresenceHeartbeat();
    const current = managedConnector.status();
    const status = await stopManagedEndpointForHost({
      machineId: input.machineId,
      endpointGeneration: input.endpointGeneration,
      ...(current.machineId === input.machineId &&
      current.endpointGeneration === input.endpointGeneration &&
      current.allocationGeneration !== undefined
        ? { allocationGeneration: current.allocationGeneration }
        : {}),
    });
    return { status: { ...status, state: 'unsupported', reason: 'disabled' }, managedOrigin: null, allocationGeneration: null };
  }
  const invalidOrigin = validateLocalOrigin(input.localOrigin);
  if (invalidOrigin !== null || !SAFE_MACHINE_ID.test(input.machineId) || !SAFE_MACHINE_ID.test(input.endpointGeneration)) {
    return { status: { state: 'error', reason: 'spawn-failed' }, managedOrigin: null, allocationGeneration: null };
  }
  const env = process.env;
  const path = await resolveCloudflaredPath({
    enabled: lifecycle.enabled ?? (() => isManagedEndpointsEnabled(env)),
    env,
    resourcesPath: process.resourcesPath,
    platform: process.platform,
    arch: process.arch,
    pathExists: executablePathExists,
    spawn: (command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions),
    makeTempDir: (prefix) => mkdtemp(join(tmpdir(), prefix)),
    writeSecretFile: writePrivateSecretFile,
    removeTempDir: (directory) => rm(directory, { recursive: true, force: true }),
    startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    stopTimeoutMs: DEFAULT_STOP_TIMEOUT_MS,
  });
  if (path === null) {
    const stoppedStatus = await stopManagedEndpointForHost(input);
    const status: ManagedConnectorStatus = {
      state: 'unsupported',
      machineId: input.machineId,
      endpointGeneration: input.endpointGeneration,
      ...(stoppedStatus.allocationGeneration === undefined ? {} : { allocationGeneration: stoppedStatus.allocationGeneration }),
      reason: 'binary-unavailable',
    };
    return { status, managedOrigin: null, allocationGeneration: status.allocationGeneration ?? null };
  }

  const fetchImpl = lifecycle.fetch ?? fetch;
  let context: MeshManagedEndpointContext | null = null;
  let baseUrl = '';
  let acquiredAllocationGeneration: number | null = null;
  let allocationAttempted = false;
  try {
    context = lifecycle.context();
    if (context === null) throw new Error('broker unavailable');
    baseUrl = normalizeBrokerUrl(context.apiUrl);
    const current = managedConnector.status();
    if (
      current.state === 'running' &&
      current.machineId === input.machineId &&
      current.endpointGeneration === input.endpointGeneration &&
      current.allocationGeneration !== undefined &&
      current.hostname !== undefined
    ) {
      await postManagedEndpointPresence(fetchImpl, baseUrl, context, input, current.allocationGeneration);
      armManagedPresenceHeartbeat(fetchImpl, baseUrl, input, current.allocationGeneration);
      return {
        status: current,
        managedOrigin: `https://${current.hostname}`,
        allocationGeneration: current.allocationGeneration,
      };
    }
    const requestId = randomUUID();
    const endpointUrl = `${baseUrl}/v1/mesh/hosts/${encodeURIComponent(input.machineId)}/endpoint`;
    type AllocationPayload = {
      allocation?: {
        state?: unknown;
        allocationGeneration?: unknown;
        hostname?: unknown;
        url?: unknown;
      };
    } | null;
    let allocationResult: { response: Response; payload: AllocationPayload } | null = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      allocationAttempted = true;
      const response = await fetchImpl(endpointUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${context.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'allocate',
          endpointGeneration: input.endpointGeneration,
          requestId,
          localOrigin: input.localOrigin,
        }),
      });
      const payload = await response.json().catch(() => null) as AllocationPayload;
      allocationResult = { response, payload };
      if (payload?.allocation?.state === 'ready' || response.status !== 202) break;
      if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, Math.min(1_500, 250 + attempt * 250)));
    }
    const allocationResponse = allocationResult?.response;
    const allocationPayload = allocationResult?.payload;
    const allocation = allocationPayload?.allocation;
    if (allocationResponse === undefined || !allocationResponse.ok || allocation?.state !== 'ready') {
      await postManagedEndpointRelease(fetchImpl, baseUrl, context, input).catch(() => undefined);
      return { status: { state: 'error', machineId: input.machineId, endpointGeneration: input.endpointGeneration, reason: 'broker-unavailable' }, managedOrigin: null, allocationGeneration: null };
    }
    if (
      !Number.isSafeInteger(allocation.allocationGeneration) ||
      typeof allocation.hostname !== 'string' ||
      !SAFE_HOSTNAME.test(allocation.hostname)
    ) {
      throw new Error('invalid allocation response');
    }
    const allocationGeneration = allocation.allocationGeneration as number;
    acquiredAllocationGeneration = allocationGeneration;
    const credentialResponse = await fetchImpl(`${baseUrl}/v1/mesh/hosts/${encodeURIComponent(input.machineId)}/connector-token`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${context.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ endpointGeneration: input.endpointGeneration, allocationGeneration }),
    });
    const credentialPayload = await credentialResponse.json().catch(() => null) as {
      connectorToken?: unknown;
    } | null;
    if (
      !credentialResponse.ok ||
      typeof credentialPayload?.connectorToken !== 'string' ||
      credentialPayload.connectorToken.length < 40
    ) {
      throw new Error('connector credential unavailable');
    }
    clearManagedPresenceHeartbeat();
    const status = await managedConnector.start({
      machineId: input.machineId,
      endpointGeneration: input.endpointGeneration,
      allocationGeneration,
      hostname: allocation.hostname,
      connectorToken: credentialPayload.connectorToken,
      localOrigin: input.localOrigin,
    });
    if (status.state !== 'running') {
      await postManagedEndpointRelease(fetchImpl, baseUrl, context, input, allocationGeneration);
      return { status, managedOrigin: null, allocationGeneration };
    }
    armManagedPresenceHeartbeat(fetchImpl, baseUrl, input, allocationGeneration);
    return { status, managedOrigin: `https://${allocation.hostname}`, allocationGeneration };
  } catch {
    if (context !== null && baseUrl !== '' && (allocationAttempted || acquiredAllocationGeneration !== null)) {
      await postManagedEndpointRelease(fetchImpl, baseUrl, context, input, acquiredAllocationGeneration ?? undefined).catch(() => undefined);
    }
    return {
      status: {
        state: 'error',
        machineId: input.machineId,
        endpointGeneration: input.endpointGeneration,
        reason: 'broker-unavailable',
      },
      managedOrigin: null,
      allocationGeneration: null,
    };
  }
}

export async function stopManagedEndpointForHost(input: {
  machineId: string;
  endpointGeneration: string;
  allocationGeneration?: number;
}): Promise<ManagedConnectorStatus> {
  const current = managedConnector.status();
  const ownsCurrentConnector =
    current.machineId === input.machineId && current.endpointGeneration === input.endpointGeneration;
  const allocationGeneration =
    input.allocationGeneration ?? (ownsCurrentConnector ? current.allocationGeneration : undefined);
  const status =
    allocationGeneration !== undefined && ownsCurrentConnector
      ? await managedConnector.stopGeneration({ ...input, allocationGeneration })
      : current;
  if (ownsCurrentConnector) clearManagedPresenceHeartbeat();
  const lifecycle = managedEndpointLifecycle;
  const context = lifecycle?.context() ?? null;
  if (context !== null) {
    try {
      const fetchImpl = lifecycle?.fetch ?? fetch;
      const baseUrl = normalizeBrokerUrl(context.apiUrl);
      await postManagedEndpointRelease(fetchImpl, baseUrl, context, input, allocationGeneration);
    } catch {
      // The durable broker reconciles releases; local process shutdown is authoritative here.
    }
  }
  return status;
}

async function postManagedEndpointRelease(
  fetchImpl: typeof fetch,
  baseUrl: string,
  context: MeshManagedEndpointContext,
  input: { machineId: string; endpointGeneration: string },
  allocationGeneration?: number,
): Promise<void> {
  await fetchImpl(`${baseUrl}/v1/mesh/hosts/${encodeURIComponent(input.machineId)}/endpoint`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${context.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      action: 'release',
      endpointGeneration: input.endpointGeneration,
      ...(allocationGeneration === undefined ? {} : { allocationGeneration }),
    }),
  });
}

async function postManagedEndpointPresence(
  fetchImpl: typeof fetch,
  baseUrl: string,
  context: MeshManagedEndpointContext,
  input: { machineId: string; endpointGeneration: string },
  allocationGeneration: number,
): Promise<void> {
  await fetchImpl(`${baseUrl}/v1/mesh/hosts/${encodeURIComponent(input.machineId)}/presence`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${context.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ endpointGeneration: input.endpointGeneration, allocationGeneration }),
  });
}

function armManagedPresenceHeartbeat(
  fetchImpl: typeof fetch,
  baseUrl: string,
  input: { machineId: string; endpointGeneration: string },
  allocationGeneration: number,
): void {
  clearManagedPresenceHeartbeat();
  managedPresenceHeartbeat = setInterval(() => {
    const current = managedConnector.status();
    if (
      current.state !== 'running' ||
      current.machineId !== input.machineId ||
      current.endpointGeneration !== input.endpointGeneration ||
      current.allocationGeneration !== allocationGeneration
    ) return;
    const context = managedEndpointLifecycle?.context() ?? null;
    if (context === null) return;
    try {
      const normalizedBase = normalizeBrokerUrl(context.apiUrl);
      void postManagedEndpointPresence(fetchImpl, normalizedBase, context, input, allocationGeneration).catch(() => undefined);
    } catch {
      // The broker's offline grace handles transient local network failures.
    }
  }, 2 * 60_000);
  managedPresenceHeartbeat.unref?.();
}

function clearManagedPresenceHeartbeat(): void {
  if (managedPresenceHeartbeat !== null) clearInterval(managedPresenceHeartbeat);
  managedPresenceHeartbeat = null;
}

function normalizeBrokerUrl(value: string | undefined): string {
  if (!value) throw new Error('broker unavailable');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('broker unavailable');
  }
  return url.href.replace(/\/$/, '');
}

function validateLocalOrigin(value: string): string | null {
  try {
    const origin = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(origin.hostname);
    if (
      !loopback ||
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash ||
      !Number.isInteger(Number(origin.port)) ||
      Number(origin.port) < 1 ||
      Number(origin.port) > 65_535
    ) return 'invalid';
    return null;
  } catch {
    return 'invalid';
  }
}

export function resetMeshManagedConnectorForTests(): void {
  clearManagedPresenceHeartbeat();
  managedConnector = new MeshManagedConnector({ enabled: () => false });
  managedEndpointLifecycle = null;
}
