// SESSION-02: remote `start-session` provider driver.
//
// Runs one codex-protocol app-server turn on a worker-managed or verified
// mapped checkout, isolated from the interactive chat session machinery:
// journal-first spawn (the caller writes `provider-spawn` before this is
// invoked), an allowlisted spawn env (SESSION-01), `never` approval policy
// with in-band auto-decline for any request the server still sends, bounded
// waits, and a SIGTERM→SIGKILL process-group stop that cannot leave an
// orphan behind on timeout or cancellation (spec §9 / audit items 1,2,5,7).

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  handleCodexServerLine,
  sendCodexJsonRpc,
  sendCodexJsonRpcNotification,
  sendCodexJsonRpcResult,
  type CodexProtocolState,
} from './codex-protocol.service.js';
import { providerSpawnEnv } from './agent-spawn-env.js';
import { getSettings } from './settings.service.js';
import type { CodexEvent, ReasoningEffort } from '../../shared/types.js';
import { normaliseReasoningEffort } from '../../shared/codex-models.js';

export type RemoteSessionProvider = 'codex' | 'azure' | 'openai';

export interface RemoteSessionSpec {
  provider: RemoteSessionProvider;
  model: string;
  /** Verified checkout path — mapped or managed; prepared upstream. */
  cwd: string;
  prompt: string;
  reasoningEffort?: ReasoningEffort;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Same-home `thread/resume` handle from a prior attempt's journal. */
  resumeThreadId?: string;
  /**
   * ENV-06: per-attempt credential-grant env vars, unsealed by the worker
   * after claim. Merged last so granted bindings win over ambient ones.
   * Never journaled.
   */
  extraEnv?: Record<string, string>;
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
}

export interface RemoteSessionHooks {
  /** Fired as soon as the provider thread id exists — journal it durably. */
  onThreadStarted(threadId: string): void;
  /** Coarse operator-facing progress lines for the activity stream. */
  emitActivity(text: string): void;
  /** Pollable cancellation flag (mesh attempt cancel_requested). */
  isCancelled(): boolean;
}

/** codex app-server gives ~20s to produce thread/started. */
const THREAD_READY_TIMEOUT_MS = 20_000;
/** SIGTERM grace before SIGKILL to the process group. */
const STOP_GRACE_MS = 3_000;
/** Cancellation poll cadence while a turn is running. */
const CANCEL_POLL_MS = 500;

type SpawnImpl = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

let spawnImpl: SpawnImpl = spawn;
let cliProbeImpl: () => Promise<string | null> = probeCodexCli;

/** Test seam: substitute the process launcher and CLI probe. */
export function configureMeshSessionForTests(overrides: {
  spawn?: SpawnImpl;
  probeCli?: () => Promise<string | null>;
}): void {
  spawnImpl = overrides.spawn ?? spawn;
  cliProbeImpl = overrides.probeCli ?? probeCodexCli;
}

export function resetMeshSessionForTests(): void {
  spawnImpl = spawn;
  cliProbeImpl = probeCodexCli;
}

const execFileAsync = promisify(execFile);

/** `codex --version` — the observed CLI version recorded in the journal. */
async function probeCodexCli(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('codex', ['--version'], {
      timeout: 10_000,
      env: providerSpawnEnv(),
    });
    const match = /(\d+\.\d+\.\d+)/.exec(String(stdout));
    return match?.[1] ?? (String(stdout).trim() || null);
  } catch {
    return null;
  }
}

export async function probeSessionCli(): Promise<string | null> {
  return cliProbeImpl();
}

/** Tuple compare: `observed` must be >= `min` (both `x.y.z`-ish). */
export function satisfiesCliMin(observed: string, min: string): boolean {
  const parse = (v: string): number[] =>
    v.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(observed);
  const b = parse(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
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

function argsForProvider(provider: RemoteSessionProvider): string[] {
  switch (provider) {
    case 'azure':
      return ['app-server', '-c', 'model_provider="azure"'];
    case 'openai':
      return ['app-server', '-c', 'model_provider="openai"'];
    case 'codex':
    default:
      return ['app-server'];
  }
}

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

/**
 * SIGTERM the process group (the child is spawned `detached`), then
 * SIGKILL after the grace window — the audit requires waiting for actual
 * child exit rather than assuming the signal landed.
 */
export async function killProcessGroup(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const pid = proc.pid;
  try {
    if (pid !== undefined) process.kill(-pid, 'SIGTERM');
    else proc.kill('SIGTERM');
  } catch {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already dead */
    }
  }
  if (await waitForExit(proc, STOP_GRACE_MS)) return;
  try {
    if (pid !== undefined) process.kill(-pid, 'SIGKILL');
    else proc.kill('SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }
  await waitForExit(proc, STOP_GRACE_MS);
}

/**
 * Spawns `codex app-server`, performs initialize → thread start/resume →
 * one `turn/start`, and waits out the turn. The caller has already
 * journaled the spawn intent — a crash between spawn and the
 * `onThreadStarted` journal entry is exactly the `unknown-outcome` case
 * spec §9 describes, so `onThreadStarted` fires before any turn work.
 *
 * Provider approval/input requests are auto-declined: a remote attempt
 * has no operator at the provider prompt (mesh approvals gate the job,
 * not codex internals), and leaving a request unanswered would stall the
 * turn until timeout.
 */
export async function runRemoteSessionTurn(
  spec: RemoteSessionSpec,
  hooks: RemoteSessionHooks,
): Promise<RemoteSessionResult> {
  const cliVersion = await cliProbeImpl();
  const settings = getSettings();
  const env = providerSpawnEnv({
    ...(spec.provider === 'openai' ? { OPENAI_API_KEY: settings.openaiApiKey } : {}),
    // ENV-06: grant bindings merge last — a granted credential supersedes
    // the ambient provider key for this attempt only.
    ...(spec.extraEnv ?? {}),
  });
  const proc = spawnImpl('codex', argsForProvider(spec.provider), {
    cwd: spec.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });

  const state: CodexProtocolState = { threadId: null, turnId: null, initialized: false };
  let buffer = '';
  let spawnError: Error | null = null;

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
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
    if (event.type === 'approval_request' && event.approvalRequestId !== undefined) {
      sendCodexJsonRpcResult(proc, event.approvalRequestId, { decision: 'decline' });
      hooks.emitActivity('session: provider approval request declined (unattended)');
      return;
    }
    if (event.type === 'input_request' && event.inputRequestId !== undefined) {
      sendCodexJsonRpcResult(proc, event.inputRequestId, {
        outcome: { outcome: 'cancelled' },
      });
      hooks.emitActivity('session: provider input request cancelled (unattended)');
      return;
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
      handleCodexServerLine(state, line.trim(), {
        onThreadReady: resolveReady,
        onThreadError: (message) => rejectReady(new Error(message)),
        onTurnStarted: () => hooks.emitActivity('session: turn started'),
        onTurnCompleted: (status) => settleTurn(status === 'inProgress' ? 'failed' : status),
        onTurnIdChanged: (turnId) => {
          state.turnId = turnId;
        },
        onEvent,
      });
    }
  });
  proc.on('error', (error) => {
    spawnError = error;
    rejectReady(error);
    settleTurn('failed');
  });
  proc.on('exit', (code, signal) => {
    rejectReady(
      new Error(`codex app-server exited before the thread was ready (${code}/${signal})`),
    );
    settleTurn('failed');
  });

  try {
    sendCodexJsonRpc(proc, 'initialize', {
      clientInfo: { name: 'anvil-mesh-worker', version: '0' },
      capabilities: { experimentalApi: true },
    });
    sendCodexJsonRpcNotification(proc, 'initialized', {});
    const threadParams = {
      model: spec.model,
      cwd: spec.cwd,
      approvalPolicy: 'never',
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
      approvalPolicy: 'never',
      sandboxPolicy: sandboxModeToTurnPolicy(spec.sandbox, spec.cwd),
      model: spec.model,
      effort: normaliseReasoningEffort(spec.reasoningEffort),
    });

    const turnStatus = await Promise.race([
      turnDone,
      (async () => {
        const deadline = Date.now() + spec.turnTimeoutMs;
        while (Date.now() < deadline) {
          if (hooks.isCancelled()) return 'cancelled' as const;
          await new Promise((resolve) => setTimeout(resolve, CANCEL_POLL_MS));
        }
        return 'timeout' as const;
      })(),
    ]);
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
        turnId: state.turnId,
        turnStatus: 'interrupted',
        cliVersion,
        cancelled: true,
      };
    }
    return {
      providerThreadId: state.threadId,
      turnId: state.turnId,
      turnStatus,
      cliVersion,
      cancelled: false,
    };
  } catch (error) {
    const spawnFailure = spawnError as Error | null;
    if (error instanceof Error && error === spawnFailure) {
      throw new Error(`provider-spawn-failed: ${error.message}`);
    }
    throw error;
  } finally {
    // Attempt-scoped process: always stop the group. The durable handle is
    // the provider thread id — a later attempt resumes it same-home.
    await killProcessGroup(proc);
  }
}
