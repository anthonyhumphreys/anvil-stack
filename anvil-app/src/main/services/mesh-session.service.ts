import type { PermissionMode } from '../../../cloud/contract/permissions.js';
// SESSION-02: remote `start-session` provider driver. Codex/Azure/OpenAI run
// an app-server turn; Cursor, Devin, and LLMGateway reuse the Desktop session
// adapter on a worker-managed or verified mapped checkout:
// journal-first spawn (the caller writes `provider-spawn` before this is
// invoked), an allowlisted spawn env (SESSION-01), target-capped running modes
// with Mesh approval routing when selected, bounded
// waits, and a SIGTERM→SIGKILL process-group stop that cannot leave an
// orphan behind on timeout or cancellation (spec §9 / audit items 1,2,5,7).

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse as parseToml } from 'smol-toml';

import {
  handleCodexServerLine,
  sendCodexJsonRpc,
  sendCodexJsonRpcWithId,
  sendCodexJsonRpcNotification,
  sendCodexJsonRpcResult,
  type CodexProtocolState,
} from './codex-protocol.service.js';
import { providerSpawnEnv } from './agent-spawn-env.js';
import { codexHostAuthIdentity } from './codex-host-auth.js';
import { getSettings } from './settings.service.js';
import type { CodexEvent, ReasoningEffort } from '../../shared/types.js';
import { normaliseReasoningEffort } from '../../shared/codex-models.js';
import type { AgentProvider } from '../../shared/types.js';
import {
  resolveApproval,
  sendMessage,
  startSession,
  providerProcessSpawnOptions,
  stopManagedProviderProcess,
  stopHeadlessSession,
  subscribeToCodexEvents,
  type RemoteSessionRuntimeOptions,
} from './codex-session.service.js';
import { resolveCodexRuntime } from './codex-runtime.service.js';

export type RemoteSessionProvider = AgentProvider;

export interface RemoteSessionSpec {
  provider: RemoteSessionProvider;
  authMode?:
    | 'target-local'
    | 'codex-account'
    | 'codex-host-auth'
    | 'openai-api-key'
    | 'cloud-provider';
  /** Encrypted source-host auth cache for the `codex-host-auth` grant. Never logged. */
  codexAuthJson?: string;
  /** Stable private Codex home owned by the worker, outside the checkout. */
  codexAuthHome?: string;
  model: string;
  /** Verified checkout path — mapped or managed; prepared upstream. */
  cwd: string;
  prompt: string;
  reasoningEffort?: ReasoningEffort;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  permissionMode?: PermissionMode;
  /** Same-home `thread/resume` handle from a prior attempt's journal. */
  resumeThreadId?: string;
  /**
   * ENV-06: per-attempt credential-grant env vars, unsealed by the worker
   * after claim. Merged last so granted bindings win over ambient ones.
   * Never journaled.
   */
  extraEnv?: Record<string, string>;
  /** Session-scoped Devin credentials material; written only below XDG_DATA_HOME. */
  devinCredentialsToml?: string;
  /** Bounds `turn/start` → `turn/completed`; the child dies on expiry. */
  turnTimeoutMs: number;
  /** Bounds spawn → thread/started; defaults to THREAD_READY_TIMEOUT_MS. */
  threadReadyTimeoutMs?: number;
}

export interface RemoteSessionResult {
  providerThreadId: string | null;
  turnId: string | null;
  turnStatus: 'completed' | 'interrupted' | 'failed' | 'cancelled';
  cliVersion: string | null;
  /** True when the attempt cancel flag stopped the turn early. */
  cancelled: boolean;
  /** Bounded assistant text from this attempt; never the full transcript. */
  assistantOutput: string;
  /** Same-device, same-provider native continuation handle. */
  resumeHandle: string | null;
}

export interface RemoteSessionHooks {
  /** Fired as soon as the provider thread id exists — journal it durably. */
  onThreadStarted(threadId: string): void;
  /** Coarse operator-facing progress lines for the activity stream. */
  emitActivity(text: string): void;
  /** Pollable cancellation flag (mesh attempt cancel_requested). */
  isCancelled(): boolean;
  approve?: (event: CodexEvent) => Promise<boolean>;
  /** Encrypted activity/progress event stream; transport remains the caller's job. */
  onEvent?: (event: CodexEvent) => void;
  /** Obtain consent to start target-side ChatGPT device-code sign-in. */
  authenticate?: (request: { verificationUrl: string; userCode: string }) => Promise<boolean>;
}

/** codex app-server gives ~20s to produce thread/started. */
const THREAD_READY_TIMEOUT_MS = 20_000;
/** SIGTERM grace before SIGKILL to the process group. */
const STOP_GRACE_MS = 3_000;
/** Cancellation poll cadence while a turn is running. */
const CANCEL_POLL_MS = 500;
const AUTH_COMPLETION_TIMEOUT_MS = 10 * 60_000;

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

type SpawnImpl = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

let spawnImpl: SpawnImpl = spawn;
let cliProbeImpl: (provider?: AgentProvider) => Promise<string | null> = probeCodexCli;

/** Test seam: substitute the process launcher and CLI probe. */
export function configureMeshSessionForTests(overrides: {
  spawn?: SpawnImpl;
  probeCli?: (provider?: AgentProvider) => Promise<string | null>;
}): void {
  spawnImpl = overrides.spawn ?? spawn;
  cliProbeImpl = overrides.probeCli ?? probeCodexCli;
}

export function resetMeshSessionForTests(): void {
  spawnImpl = spawn;
  cliProbeImpl = probeCodexCli;
}

const execFileAsync = promisify(execFile);

/** Probe the selected provider runtime; the version is recorded in the journal. */
async function probeCodexCli(provider: AgentProvider = 'codex'): Promise<string | null> {
  try {
    const command =
      provider === 'cursor'
        ? 'cursor-agent'
        : provider === 'devin'
          ? 'devin'
          : provider === 'llmgateway'
            ? await resolveCodexRuntime()
            : 'codex';
    const { stdout } = await execFileAsync(command, ['--version'], {
      timeout: 10_000,
      env: providerSpawnEnv(),
    });
    const match = /(\d+\.\d+\.\d+)/.exec(String(stdout));
    return match?.[1] ?? (String(stdout).trim() || null);
  } catch {
    return null;
  }
}

export async function probeSessionCli(provider: AgentProvider = 'codex'): Promise<string | null> {
  return cliProbeImpl(provider);
}

/** Tuple compare: `observed` must be >= `min` (both `x.y.z`-ish). */
export function satisfiesCliMin(observed: string, min: string): boolean {
  const parse = (v: string): number[] => v.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(observed);
  const b = parse(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

interface ProvisionedCodexHostAuth {
  home: string;
  identity: string;
  accountId?: string;
}

/** Create an isolated durable auth/config home without replacing refreshed tokens. */
function provisionCodexHostAuth(
  authJson: string | undefined,
  authHome: string | undefined,
): ProvisionedCodexHostAuth {
  if (authJson === undefined || authHome === undefined || authHome.trim().length === 0) {
    throw new Error('codex-host-auth-grant-incomplete');
  }
  const grantIdentity = codexHostAuthIdentity(authJson);
  const home = path.resolve(authHome);
  if (home === path.parse(home).root) throw new Error('codex-host-auth-home-invalid');
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const homeStat = fs.lstatSync(home);
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) {
      throw new Error('codex-host-auth-home-invalid');
    }
    fs.chmodSync(home, 0o700);
  } catch (error) {
    if (error instanceof Error && error.message === 'codex-host-auth-home-invalid') throw error;
    throw new Error('codex-host-auth-home-unavailable');
  }

  const authPath = path.join(home, 'auth.json');
  try {
    fs.lstatSync(authPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('codex-host-auth-cache-unavailable');
    }
    const temporaryPath = path.join(home, `.auth-${randomUUID()}.tmp`);
    let fileDescriptor: number | undefined;
    try {
      fileDescriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(fileDescriptor, authJson, 'utf8');
      fs.fsyncSync(fileDescriptor);
      fs.closeSync(fileDescriptor);
      fileDescriptor = undefined;
      try {
        // link is atomic and exclusive, so a concurrent turn's refreshed cache wins.
        fs.linkSync(temporaryPath, authPath);
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== 'EEXIST') throw linkError;
      }
    } catch {
      throw new Error('codex-host-auth-cache-unavailable');
    } finally {
      if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        /* A failed temp cleanup does not reveal or log credential content. */
      }
    }
  }

  let existingJson: string;
  try {
    const authStat = fs.lstatSync(authPath);
    if (!authStat.isFile() || authStat.isSymbolicLink()) {
      throw new Error('codex-host-auth-cache-invalid');
    }
    fs.chmodSync(authPath, 0o600);
    existingJson = fs.readFileSync(authPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && error.message === 'codex-host-auth-cache-invalid') throw error;
    throw new Error('codex-host-auth-cache-unavailable');
  }
  let existingIdentity: ReturnType<typeof codexHostAuthIdentity>;
  try {
    existingIdentity = codexHostAuthIdentity(existingJson);
  } catch {
    throw new Error('codex-host-auth-cache-invalid');
  }
  if (existingIdentity.identity !== grantIdentity.identity) {
    throw new Error('codex-host-auth-account-mismatch');
  }
  return {
    home,
    identity: grantIdentity.identity,
    ...(grantIdentity.accountId === undefined ? {} : { accountId: grantIdentity.accountId }),
  };
}

function sandboxModeToTurnPolicy(
  mode: RemoteSessionSpec['sandbox'],
  cwd: string,
): Record<string, unknown> {
  switch (mode) {
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
    case 'workspace-write':
    default:
      return {
        type: 'workspaceWrite',
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}

function argsForProvider(
  provider: RemoteSessionProvider,
  extraEnv?: Readonly<Record<string, string>>,
): string[] {
  switch (provider) {
    case 'azure': {
      const args = [
        'app-server',
        '-c',
        'model_provider="anvil_remote_azure"',
        '-c',
        'model_providers.anvil_remote_azure.name="Azure"',
      ];
      if (extraEnv?.AZURE_OPENAI_ENDPOINT) {
        const endpoint = extraEnv.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, '');
        const baseUrl = /\/openai$/i.test(endpoint) ? endpoint : `${endpoint}/openai`;
        args.push('-c', `model_providers.anvil_remote_azure.base_url=${JSON.stringify(baseUrl)}`);
      }
      if (extraEnv?.AZURE_OPENAI_API_VERSION) {
        args.push(
          '-c',
          `model_providers.anvil_remote_azure.query_params={ "api-version" = ${JSON.stringify(extraEnv.AZURE_OPENAI_API_VERSION)} }`,
        );
      }
      if (extraEnv?.AZURE_OPENAI_API_KEY) {
        args.push('-c', 'model_providers.anvil_remote_azure.env_key="AZURE_OPENAI_API_KEY"');
      }
      if (extraEnv?.AZURE_OPENAI_DEPLOYMENT) {
        args.push('-c', `model=${JSON.stringify(extraEnv.AZURE_OPENAI_DEPLOYMENT)}`);
      }
      args.push(
        '-c',
        'model_providers.anvil_remote_azure.wire_api="responses"',
        '-c',
        'model_providers.anvil_remote_azure.requires_openai_auth=false',
      );
      return args;
    }
    case 'openai': {
      const args = [
        'app-server',
        '-c',
        'model_provider="anvil_remote_openai"',
        '-c',
        'model_providers.anvil_remote_openai.name="OpenAI"',
      ];
      if (extraEnv?.OPENAI_BASE_URL) {
        args.push(
          '-c',
          `model_providers.anvil_remote_openai.base_url=${JSON.stringify(extraEnv.OPENAI_BASE_URL)}`,
        );
      }
      if (extraEnv?.OPENAI_API_KEY) {
        args.push('-c', 'model_providers.anvil_remote_openai.env_key="OPENAI_API_KEY"');
      }
      args.push('-c', 'model_providers.anvil_remote_openai.requires_openai_auth=false');
      return args;
    }
    case 'codex':
    default:
      return ['app-server'];
  }
}

/** Stop the same isolated process group used by Desktop-managed providers. */
export async function killProcessGroup(proc: ChildProcess): Promise<void> {
  await stopManagedProviderProcess(
    proc,
    process.platform === 'win32' ? undefined : proc.pid,
    STOP_GRACE_MS,
  );
}

const MAX_ASSISTANT_OUTPUT_CHARS = 32_000;
type TurnWaitResult = RemoteSessionResult['turnStatus'] | 'cancelled' | 'timeout';

function waitForTurnOrControl(
  turnDone: Promise<RemoteSessionResult['turnStatus']>,
  timeoutMs: number,
  isCancelled: () => boolean,
): Promise<TurnWaitResult> {
  return new Promise((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: TurnWaitResult): void => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(status);
    };
    void turnDone.then(finish);
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      if (isCancelled()) finish('cancelled');
      else if (Date.now() >= deadline) finish('timeout');
      else timer = setTimeout(poll, CANCEL_POLL_MS);
    };
    poll();
  });
}

function appendBounded(current: string, addition: string): string {
  if (current.length >= MAX_ASSISTANT_OUTPUT_CHARS) return current;
  return (current + addition).slice(0, MAX_ASSISTANT_OUTPUT_CHARS);
}

/** ACP and LLMGateway runs use the same managed provider lifecycle as Desktop chat. */
async function runDesktopAdapterTurn(
  spec: RemoteSessionSpec,
  hooks: RemoteSessionHooks,
  cliVersion: string | null,
): Promise<RemoteSessionResult> {
  if (spec.authMode === 'cloud-provider' && spec.provider === 'devin') {
    const dataHome = spec.extraEnv?.XDG_DATA_HOME;
    const credentialsToml = spec.devinCredentialsToml;
    if (!dataHome || !credentialsToml || Buffer.byteLength(credentialsToml, 'utf8') > 64 * 1024) {
      throw new Error('devin-provider-auth-invalid');
    }
    const devinDir = path.join(dataHome, 'devin');
    const credentialsPath = path.join(devinDir, 'credentials.toml');
    const tokenFromToml = (toml: string): string | null => {
      try {
        const parsed = parseToml(toml) as Record<string, unknown>;
        const token = parsed.api_token;
        return typeof token === 'string' && token.trim().length >= 16 && token.length <= 16_384
          ? token
          : null;
      } catch {
        return null;
      }
    };
    const grantedToken = tokenFromToml(credentialsToml);
    if (grantedToken === null) throw new Error('devin-provider-auth-invalid');
    fs.mkdirSync(dataHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(devinDir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(dataHome).isSymbolicLink() || fs.lstatSync(devinDir).isSymbolicLink()) {
      throw new Error('devin-provider-auth-home-invalid');
    }
    fs.chmodSync(dataHome, 0o700);
    fs.chmodSync(devinDir, 0o700);
    try {
      fs.writeFileSync(credentialsPath, credentialsToml, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw new Error('devin-provider-auth-unavailable');
      }
      const existingStat = fs.lstatSync(credentialsPath);
      if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
        throw new Error('devin-provider-auth-home-invalid');
      }
      const existing = fs.readFileSync(credentialsPath, 'utf8');
      if (tokenFromToml(existing) !== grantedToken) throw new Error('devin-provider-auth-conflict');
      fs.chmodSync(credentialsPath, 0o600);
    }
  }
  const codexMode =
    spec.sandbox === 'read-only' || spec.permissionMode === 'read-only'
      ? 'read-only'
      : spec.sandbox === 'danger-full-access' && spec.permissionMode === 'full-access'
        ? 'full-access'
        : spec.permissionMode === 'on-request'
          ? 'on-request'
          : 'workspace-auto';
  let sessionId: string | null = null;
  const runtime: RemoteSessionRuntimeOptions = {
    provider: spec.provider,
    model: spec.model,
    ...(spec.extraEnv ? { extraEnv: spec.extraEnv } : {}),
    codexMode,
    headless: true,
    bypassEnabledProviderGate: true,
    onSessionCreated: (id) => {
      sessionId = id;
    },
  };
  let assistantOutput = '';
  let turnId: string | null = null;
  let settleTurn!: (status: RemoteSessionResult['turnStatus']) => void;
  const turnDone = new Promise<RemoteSessionResult['turnStatus']>((resolve) => {
    settleTurn = resolve;
  });
  let settled = false;
  const complete = (status: RemoteSessionResult['turnStatus']): void => {
    if (settled) return;
    settled = true;
    settleTurn(status);
  };
  const unsubscribe = subscribeToCodexEvents(({ sessionId: eventSessionId, event }) => {
    if (!sessionId || eventSessionId !== sessionId) return;
    if (event.type === 'text' && event.text)
      assistantOutput = appendBounded(assistantOutput, event.text);
    if (event.type === 'turn_outcome') {
      turnId = event.protocolTurnId ?? turnId;
      if (event.turnOutcome && event.turnOutcome !== 'inProgress') complete(event.turnOutcome);
    } else if (event.type === 'status') {
      if (event.status === 'complete') complete('completed');
      else if (event.status === 'error') complete('failed');
    } else if (event.type === 'error') {
      complete('failed');
    }
    if (event.type === 'approval_request' && event.approvalRequestId !== undefined) {
      void (async () => {
        let approved = false;
        try {
          approved =
            (spec.permissionMode === 'full-access' ||
              (spec.permissionMode === 'on-request' && (await hooks.approve?.(event)) === true)) &&
            !hooks.isCancelled() &&
            !settled;
        } catch {
          /* Refuse approvals that are unavailable or expire during the turn. */
        }
        if (!sessionId) return;
        try {
          resolveApproval(sessionId, event.approvalRequestId!, approved ? 'accept' : 'decline');
        } catch {
          /* The request can expire while a Mesh approval is being decided. */
        }
        hooks.emitActivity(`session: provider approval ${approved ? 'approved' : 'declined'}`);
      })();
    }
    if (event.type === 'input_request') {
      hooks.emitActivity(
        'session: provider requested user input; remote attempts cannot answer questions',
      );
      complete('failed');
    }
    hooks.onEvent?.(event);
  });

  let session: Awaited<ReturnType<typeof startSession>> | null = null;
  try {
    session = await startSession(
      [spec.cwd],
      [],
      'coder',
      {
        provider: spec.provider,
        codexMode,
        ...(spec.resumeThreadId ? { providerThreadId: spec.resumeThreadId } : {}),
      },
      runtime,
    );
    sessionId = session.id;
    const resumeHandle = session.providerThreadId ?? null;
    if (!resumeHandle) throw new Error('provider-session-missing-resume-handle');
    hooks.onThreadStarted(resumeHandle);
    hooks.emitActivity(`session: thread ${resumeHandle.slice(0, 12)}… started`);
    await sendMessage(session.id, spec.prompt, [], {
      model: spec.model,
      reasoningEffort: spec.reasoningEffort,
    });
    const turnStatus = await waitForTurnOrControl(turnDone, spec.turnTimeoutMs, hooks.isCancelled);
    if (turnStatus === 'timeout') throw new Error(`turn-timeout-exceeded: ${spec.turnTimeoutMs}ms`);
    if (turnStatus === 'cancelled') {
      hooks.emitActivity('session: cancellation requested — stopping provider process group');
      return {
        providerThreadId: resumeHandle,
        resumeHandle,
        turnId,
        turnStatus: 'interrupted',
        cliVersion,
        cancelled: true,
        assistantOutput,
      };
    }
    return {
      providerThreadId: resumeHandle,
      resumeHandle,
      turnId,
      turnStatus,
      cliVersion,
      cancelled: false,
      assistantOutput,
    };
  } finally {
    unsubscribe();
    if (session) await stopHeadlessSession(session.id);
  }
}

/**
 * Runs one provider attempt and waits out its turn. Codex-protocol providers
 * use initialize → thread start/resume → `turn/start`; the caller has already
 * journaled the spawn intent — a crash between spawn and the
 * `onThreadStarted` journal entry is exactly the `unknown-outcome` case
 * spec §9 describes, so `onThreadStarted` fires before any turn work.
 *
 * The legacy Codex-protocol path can route approval requests through Mesh.
 * Interactive provider input is unsupported for unattended turns and fails
 * the attempt explicitly instead of silently supplying an empty answer.
 */
export async function runRemoteSessionTurn(
  spec: RemoteSessionSpec,
  hooks: RemoteSessionHooks,
): Promise<RemoteSessionResult> {
  const cliVersion = await cliProbeImpl(spec.provider);
  if (spec.authMode === 'codex-account' && spec.provider !== 'codex') {
    throw new Error('codex-account-auth-requires-codex-provider');
  }
  if (spec.authMode === 'codex-host-auth' && spec.provider !== 'codex') {
    throw new Error('codex-host-auth-requires-codex-provider');
  }
  if (
    spec.authMode === 'openai-api-key' &&
    spec.provider !== 'openai' &&
    spec.provider !== 'codex'
  ) {
    throw new Error('openai-api-key-auth-requires-openai-or-codex-provider');
  }
  if (spec.authMode === 'cloud-provider' && spec.provider === 'codex') {
    throw new Error('cloud-provider-auth-provider-invalid');
  }
  if (spec.provider === 'cursor' || spec.provider === 'devin' || spec.provider === 'llmgateway') {
    return runDesktopAdapterTurn(spec, hooks, cliVersion);
  }
  const hostAuth =
    spec.authMode === 'codex-host-auth'
      ? provisionCodexHostAuth(spec.codexAuthJson, spec.codexAuthHome)
      : undefined;
  const settings = getSettings();
  const env = providerSpawnEnv({
    ...(spec.provider === 'openai' || spec.authMode === 'openai-api-key'
      ? { OPENAI_API_KEY: settings.openaiApiKey }
      : {}),
    // ENV-06: grant bindings merge last — a granted credential supersedes
    // the ambient provider key for this attempt only.
    ...(spec.extraEnv ?? {}),
  });
  if (hostAuth !== undefined) {
    env.CODEX_HOME = hostAuth.home;
  }
  if (hostAuth !== undefined || spec.authMode === 'codex-account') {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
  }
  const args = argsForProvider(
    spec.provider,
    spec.authMode === 'cloud-provider' ? spec.extraEnv : undefined,
  );
  if (hostAuth !== undefined || spec.authMode === 'codex-account') {
    args.push('-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"');
  }
  if (spec.authMode === 'openai-api-key') {
    args.push('-c', 'model_provider="anvil_api"');
    args.push(
      '-c',
      'model_providers.anvil_api.name="OpenAI API"',
      '-c',
      'model_providers.anvil_api.base_url="https://api.openai.com/v1"',
      '-c',
      'model_providers.anvil_api.wire_api="responses"',
      '-c',
      'model_providers.anvil_api.env_key="OPENAI_API_KEY"',
      '-c',
      'model_providers.anvil_api.requires_openai_auth=false',
    );
  }
  if (spec.authMode === 'openai-api-key' && !env.OPENAI_API_KEY) {
    throw new Error('openai-api-key-missing');
  }
  const proc = spawnImpl('codex', args, {
    cwd: spec.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...providerProcessSpawnOptions(),
  });

  const state: CodexProtocolState = { threadId: null, turnId: null, initialized: false };
  let assistantOutput = '';
  let buffer = '';
  let spawnError: Error | null = null;
  const pendingResponses = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let pendingLogin:
    | {
        loginId: string;
        resolve: (result: { success: boolean; error?: string }) => void;
        timeout: ReturnType<typeof setTimeout>;
        poll: ReturnType<typeof setTimeout>;
      }
    | undefined;

  const request = (
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 20_000,
  ): Promise<unknown> => {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingResponses.delete(id);
        reject(new Error(`provider-request-timeout: ${method}`));
      }, timeoutMs);
      pendingResponses.set(id, { resolve, reject, timer });
      if (!sendCodexJsonRpcWithId(proc, method, params, id)) {
        clearTimeout(timer);
        pendingResponses.delete(id);
        reject(new Error(`provider-request-failed: ${method}`));
      }
    });
  };

  const waitForLoginCompletion = (loginId: string): Promise<{ success: boolean; error?: string }> =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (pendingLogin?.loginId === loginId) {
          clearTimeout(pendingLogin.poll);
          pendingLogin = undefined;
        }
        reject(new Error('codex-account-login-timeout'));
      }, AUTH_COMPLETION_TIMEOUT_MS);
      const poll = (): void => {
        if (hooks.isCancelled()) {
          if (pendingLogin) {
            clearTimeout(pendingLogin.timeout);
            pendingLogin = undefined;
          }
          sendCodexJsonRpc(proc, 'account/login/cancel', { loginId });
          reject(new Error('codex-account-login-cancelled'));
        } else if (pendingLogin) {
          pendingLogin.poll = setTimeout(poll, CANCEL_POLL_MS);
        }
      };
      pendingLogin = { loginId, resolve, timeout, poll: setTimeout(poll, CANCEL_POLL_MS) };
    });

  const awaitAuthenticationConsent = (request: {
    verificationUrl: string;
    userCode: string;
  }): Promise<boolean> =>
    new Promise((resolve) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (approved: boolean): void => {
        if (finished) return;
        finished = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(approved);
      };
      void Promise.resolve(hooks.authenticate?.(request)).then(
        (approved) => finish(approved === true),
        () => finish(false),
      );
      const deadline = Date.now() + AUTH_COMPLETION_TIMEOUT_MS;
      const poll = (): void => {
        if (
          hooks.isCancelled() ||
          proc.exitCode !== null ||
          proc.signalCode !== null ||
          Date.now() >= deadline
        ) {
          finish(false);
        } else timer = setTimeout(poll, CANCEL_POLL_MS);
      };
      poll();
    });

  const handleAuthNotification = (line: string): void => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.method !== 'account/login/completed') return;
    const params = message.params as Record<string, unknown> | undefined;
    if (!pendingLogin || params?.loginId !== pendingLogin.loginId) return;
    const waiter = pendingLogin;
    pendingLogin = undefined;
    clearTimeout(waiter.timeout);
    clearTimeout(waiter.poll);
    waiter.resolve({
      success: params.success === true,
      ...(typeof params.error === 'string' ? { error: params.error } : {}),
    });
  };
  const failPendingRequests = (error: Error): void => {
    for (const [id, pending] of pendingResponses) {
      clearTimeout(pending.timer);
      pendingResponses.delete(id);
      pending.reject(error);
    }
    if (pendingLogin) {
      const waiter = pendingLogin;
      pendingLogin = undefined;
      clearTimeout(waiter.timeout);
      clearTimeout(waiter.poll);
      waiter.resolve({ success: false, error: 'provider-exited' });
    }
  };

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);
  let resolveTurn!: (status: RemoteSessionResult['turnStatus']) => void;
  const turnDone = new Promise<RemoteSessionResult['turnStatus']>((resolve) => {
    resolveTurn = resolve;
  });
  let turnSettled = false;
  const settleTurn = (status: RemoteSessionResult['turnStatus']): void => {
    if (turnSettled) return;
    turnSettled = true;
    resolveTurn(status);
  };

  const onEvent = (event: CodexEvent): void => {
    hooks.onEvent?.(event);
    if (event.type === 'approval_request' && event.approvalRequestId !== undefined) {
      const id = event.approvalRequestId;
      const decide = async (): Promise<void> => {
        let approved = false;
        try {
          approved =
            (spec.permissionMode === 'full-access' ||
              (spec.permissionMode === 'on-request' && (await hooks.approve?.(event)) === true)) &&
            !hooks.isCancelled() &&
            !turnSettled;
        } catch {
          /* Refuse an unreachable/expired approval. */
        }
        sendCodexJsonRpcResult(
          proc,
          id,
          event.approvalKind === 'permissions'
            ? { permissions: approved ? (event.approvalPermissions ?? {}) : {}, scope: 'turn' }
            : { decision: approved ? 'accept' : 'decline' },
        );
        hooks.emitActivity(`session: provider approval ${approved ? 'approved' : 'declined'}`);
      };
      void decide();
      return;
    }
    if (event.type === 'input_request' && event.inputRequestId !== undefined) {
      sendCodexJsonRpcResult(proc, event.inputRequestId, {
        outcome: { outcome: 'cancelled' },
      });
      hooks.emitActivity(
        'session: provider requested user input; remote attempts cannot answer questions',
      );
      settleTurn('failed');
      return;
    }
    if (event.type === 'text' && event.text) {
      assistantOutput = appendBounded(assistantOutput, event.text);
    }
    if (event.type === 'error') {
      hooks.emitActivity(`session: provider error — ${event.errorMessage}`);
    }
  };

  proc.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      handleAuthNotification(line.trim());
      handleCodexServerLine(state, line.trim(), {
        onThreadReady: resolveReady,
        onThreadError: (message) => rejectReady(new Error(message)),
        onTurnStarted: () => hooks.emitActivity('session: turn started'),
        onTurnCompleted: (status) => settleTurn(status === 'inProgress' ? 'failed' : status),
        onTurnIdChanged: (turnId) => {
          state.turnId = turnId;
        },
        onResponse: ({ requestId, result }) => {
          const pending = pendingResponses.get(String(requestId));
          if (!pending) return;
          pendingResponses.delete(String(requestId));
          clearTimeout(pending.timer);
          pending.resolve(result);
        },
        onRequestError: ({ requestId, message }) => {
          const pending = pendingResponses.get(String(requestId));
          if (!pending) return;
          pendingResponses.delete(String(requestId));
          clearTimeout(pending.timer);
          pending.reject(new Error(message));
          return true;
        },
        onEvent,
      });
    }
  });
  proc.on('error', (error) => {
    spawnError = error;
    failPendingRequests(error);
    rejectReady(error);
    settleTurn('failed');
  });
  proc.on('exit', (code, signal) => {
    failPendingRequests(new Error(`provider-exited-before-turn (${code}/${signal})`));
    rejectReady(
      new Error(`codex app-server exited before the thread was ready (${code}/${signal})`),
    );
    settleTurn('failed');
  });

  try {
    await request('initialize', {
      clientInfo: { name: 'anvil-mesh-worker', version: '0' },
      capabilities: { experimentalApi: true },
    });
    sendCodexJsonRpcNotification(proc, 'initialized', {});
    if (hostAuth !== undefined) {
      const result = (await request('account/read', {})) as Record<string, unknown>;
      const account = result.account;
      if (typeof account !== 'object' || account === null) {
        throw new Error('codex-host-auth-account-unavailable');
      }
      const accountDetails = account as Record<string, unknown>;
      if (accountDetails.type !== 'chatgpt') {
        throw new Error('codex-host-auth-account-unavailable');
      }
      const reportedAccountId = accountDetails.accountId ?? accountDetails.account_id;
      if (
        hostAuth.accountId !== undefined &&
        typeof reportedAccountId === 'string' &&
        reportedAccountId !== hostAuth.accountId
      ) {
        throw new Error('codex-host-auth-account-mismatch');
      }
    } else if (spec.authMode === 'codex-account') {
      if (spec.provider !== 'codex') {
        throw new Error('codex-account-auth-requires-codex-provider');
      }
      const readAccount = async (): Promise<Record<string, unknown>> => {
        const result = (await request('account/read', {})) as Record<string, unknown>;
        const account = result.account;
        return typeof account === 'object' && account !== null
          ? (account as Record<string, unknown>)
          : {};
      };
      let account = await readAccount();
      if (account.type !== 'chatgpt') {
        const login = (await request('account/login/start', {
          type: 'chatgptDeviceCode',
        })) as Record<string, unknown>;
        if (
          login.type !== 'chatgptDeviceCode' ||
          typeof login.loginId !== 'string' ||
          typeof login.verificationUrl !== 'string' ||
          typeof login.userCode !== 'string'
        ) {
          throw new Error('codex-device-auth-unavailable');
        }
        const loginId = login.loginId;
        const verificationUrl = login.verificationUrl;
        const userCode = login.userCode;
        const completionPromise = waitForLoginCompletion(loginId);
        void completionPromise.catch(() => undefined);
        const approved = await awaitAuthenticationConsent({ verificationUrl, userCode });
        if (!approved) {
          if (pendingLogin?.loginId === loginId) {
            const waiter = pendingLogin;
            pendingLogin = undefined;
            clearTimeout(waiter.timeout);
            clearTimeout(waiter.poll);
            waiter.resolve({ success: false, error: 'cancelled' });
          }
          sendCodexJsonRpc(proc, 'account/login/cancel', { loginId });
          throw new Error('codex-account-login-not-approved');
        }
        const completion = await completionPromise;
        if (!completion.success) throw new Error('codex-account-login-failed');
        account = await readAccount();
        if (account.type !== 'chatgpt') throw new Error('codex-account-login-unverified');
      }
    }
    const threadParams = {
      model: spec.model,
      cwd: spec.cwd,
      approvalPolicy: spec.permissionMode === 'on-request' ? 'on-request' : 'never',
      sandbox: spec.sandbox,
    };
    if (spec.resumeThreadId !== undefined) {
      sendCodexJsonRpc(proc, 'thread/resume', {
        threadId: spec.resumeThreadId,
        ...threadParams,
      });
    } else {
      sendCodexJsonRpc(proc, 'thread/start', threadParams);
    }

    await Promise.race([
      ready,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('thread-ready-timeout: provider produced no thread')),
          spec.threadReadyTimeoutMs ?? THREAD_READY_TIMEOUT_MS,
        ),
      ),
    ]);
    if (state.threadId === null) throw new Error('thread-ready-timeout: no thread id');
    hooks.onThreadStarted(state.threadId);
    hooks.emitActivity(`session: thread ${state.threadId.slice(0, 12)}… started`);

    sendCodexJsonRpc(proc, 'turn/start', {
      threadId: state.threadId,
      input: [{ type: 'text', text: spec.prompt, text_elements: [] }],
      approvalPolicy: spec.permissionMode === 'on-request' ? 'on-request' : 'never',
      sandboxPolicy: sandboxModeToTurnPolicy(spec.sandbox, spec.cwd),
      model: spec.model,
      effort: normaliseReasoningEffort(spec.reasoningEffort),
    });

    const turnStatus = await waitForTurnOrControl(turnDone, spec.turnTimeoutMs, hooks.isCancelled);
    if (turnStatus === 'timeout') {
      throw new Error(`turn-timeout-exceeded: ${spec.turnTimeoutMs}ms`);
    }
    if (turnStatus === 'cancelled') {
      hooks.emitActivity('session: cancellation requested — interrupting turn');
      if (state.threadId !== null && state.turnId !== null) {
        sendCodexJsonRpc(proc, 'turn/interrupt', {
          threadId: state.threadId,
          turnId: state.turnId,
        });
      }
      await Promise.race([turnDone, waitForExit(proc, STOP_GRACE_MS)]);
      return {
        providerThreadId: state.threadId,
        resumeHandle: state.threadId,
        turnId: state.turnId,
        turnStatus: 'interrupted',
        cliVersion,
        cancelled: true,
        assistantOutput,
      };
    }
    return {
      providerThreadId: state.threadId,
      resumeHandle: state.threadId,
      turnId: state.turnId,
      turnStatus,
      cliVersion,
      cancelled: false,
      assistantOutput,
    };
  } catch (error) {
    const spawnFailure = spawnError as Error | null;
    if (error instanceof Error && error === spawnFailure) {
      throw new Error(`provider-spawn-failed: ${error.message}`);
    }
    throw error;
  } finally {
    failPendingRequests(new Error('remote-session-stopped'));
    // Attempt-scoped process: always stop the group. The durable handle is
    // the provider thread id — a later attempt resumes it same-home.
    await killProcessGroup(proc);
  }
}
