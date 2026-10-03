// Focused coverage for the remote `start-session` provider driver:
// journal-first spawn contract, thread ready/turn bounds, cancellation,
// in-band approval auto-decline, resume, and orphan kill.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const desktopSessionMocks = vi.hoisted(() => ({
  listener: null as
    | ((payload: { sessionId: string; event: Record<string, unknown> }) => void)
    | null,
  startSession: vi.fn(),
  sendMessage: vi.fn(),
  resolveApproval: vi.fn(),
  resolveInputRequest: vi.fn(),
  stopHeadlessSession: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf-8').slice('enc:'.length),
  },
}));
vi.mock('../../db/database.js', () => ({ getDb: () => null }));
vi.mock('../settings.service.js', () => ({
  getSettings: () => ({ openaiApiKey: undefined }),
}));
vi.mock('../codex-session.service.js', () => ({
  providerProcessSpawnOptions: () => (process.platform === 'win32' ? {} : { detached: true }),
  stopManagedProviderProcess: async (proc: ChildProcess) => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
  },
  startSession: desktopSessionMocks.startSession,
  sendMessage: desktopSessionMocks.sendMessage,
  resolveApproval: desktopSessionMocks.resolveApproval,
  resolveInputRequest: desktopSessionMocks.resolveInputRequest,
  stopHeadlessSession: desktopSessionMocks.stopHeadlessSession,
  subscribeToCodexEvents: (listener: typeof desktopSessionMocks.listener) => {
    desktopSessionMocks.listener = listener;
    return () => {
      desktopSessionMocks.listener = null;
    };
  },
}));
vi.mock('../codex-runtime.service.js', () => ({ resolveCodexRuntime: async () => 'codex' }));

import {
  configureMeshSessionForTests,
  killProcessGroup,
  resetMeshSessionForTests,
  runRemoteSessionTurn,
  satisfiesCliMin,
} from '../mesh-session.service.js';

type MutableProcess = { -readonly [K in keyof ChildProcess]: ChildProcess[K] };

interface FakeServer {
  proc: MutableProcess;
  /** JSON-RPC messages the driver wrote to the child's stdin. */
  received: Array<Record<string, unknown>>;
  /** Respond to the next server→client request id (asserts auto-decline). */
  killedWith: string[];
  notify(document: Record<string, unknown>): void;
}

interface FakeBehavior {
  /** Respond to thread/start (false → never respond: ready-timeout path). */
  threadReady?: boolean;
  /** Emit a command approval request mid-turn (tests auto-decline). */
  sendApprovalRequest?: boolean;
  /** Delay turn completion until interrupted (cancel path). */
  holdTurn?: boolean;
  turnStatus?: 'completed' | 'failed';
  initiallyAuthenticated?: boolean;
}

function fakeAppServer(behavior: FakeBehavior = {}): FakeServer {
  const {
    threadReady = true,
    sendApprovalRequest = false,
    holdTurn = false,
    turnStatus = 'completed',
    initiallyAuthenticated = true,
  } = behavior;
  const proc = new EventEmitter() as MutableProcess & {
    stdout: PassThrough;
    stdin: PassThrough;
    stderr: PassThrough;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.pid = 0xfffffff0; // never a real pid — group kill ESRCHs into fallback
  proc.exitCode = null;
  proc.signalCode = null;
  let isAuthenticated = initiallyAuthenticated;
  proc.kill = (signal?: NodeJS.Signals | number) => {
    fake.killedWith.push(String(signal ?? 'SIGTERM'));
    queueMicrotask(() => proc.emit('exit', 0, 'SIGTERM'));
    return true;
  };

  const write = (doc: Record<string, unknown>): void => {
    proc.stdout.write(`${JSON.stringify(doc)}\n`);
  };
  const fake: FakeServer = {
    proc,
    received: [],
    killedWith: [],
    notify: (document) => {
      const params = document.params as Record<string, unknown> | undefined;
      if (document.method === 'account/login/completed' && params?.success === true) {
        isAuthenticated = true;
      }
      write(document);
    },
  };
  let turnId: string | null = null;
  proc.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      fake.received.push(msg);
      const method = msg['method'] as string | undefined;
      const id = msg['id'];
      if (method === 'thread/start' || method === 'thread/resume') {
        if (!threadReady) continue;
        const threadId =
          method === 'thread/resume'
            ? ((msg['params'] as Record<string, unknown>)['threadId'] as string)
            : 'thr-fake-1';
        write({ jsonrpc: '2.0', id, result: { thread: { id: threadId } } });
      } else if (method === 'turn/start') {
        write({ jsonrpc: '2.0', id, result: {} });
        turnId = 'turn-1';
        write({ method: 'turn/started', params: { turn: { id: turnId } } });
        if (sendApprovalRequest) {
          write({
            jsonrpc: '2.0',
            id: 'req-approval-1',
            method: 'item/commandExecution/requestApproval',
            params: { command: 'rm -rf /', reason: 'wants power' },
          });
        }
        if (!holdTurn) {
          write({ method: 'turn/completed', params: { turn: { id: turnId, status: turnStatus } } });
        }
      } else if (method === 'turn/interrupt') {
        write({ jsonrpc: '2.0', id, result: {} });
        if (turnId !== null) {
          write({
            method: 'turn/completed',
            params: { turn: { id: turnId, status: 'interrupted' } },
          });
        }
      } else if (id !== undefined && method === undefined) {
        if (id === 'req-approval-1')
          write({ method: 'turn/completed', params: { turn: { id: turnId, status: turnStatus } } });
      } else if (method === 'account/read') {
        write({
          jsonrpc: '2.0',
          id,
          result: {
            account: isAuthenticated ? { type: 'chatgpt' } : null,
            requiresOpenaiAuth: true,
          },
        });
      } else if (method === 'account/login/start') {
        write({
          jsonrpc: '2.0',
          id,
          result: {
            type: 'chatgptDeviceCode',
            loginId: 'login-1',
            verificationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'ABCD-EFGH',
          },
        });
      } else if (id !== undefined) {
        write({ jsonrpc: '2.0', id, result: {} });
      }
    }
  });
  return fake;
}

const HOOKS_BASE = {
  onThreadStarted: vi.fn(),
  emitActivity: vi.fn(),
  isCancelled: () => false,
};

function spec(overrides: Partial<Parameters<typeof runRemoteSessionTurn>[0]> = {}) {
  return {
    provider: 'codex' as const,
    model: 'gpt-5.6-terra',
    cwd: '/tmp',
    prompt: 'do the thing',
    sandbox: 'workspace-write' as const,
    turnTimeoutMs: 5_000,
    threadReadyTimeoutMs: 300,
    ...overrides,
  };
}

afterEach(() => {
  resetMeshSessionForTests();
  desktopSessionMocks.listener = null;
  desktopSessionMocks.startSession.mockReset();
  desktopSessionMocks.sendMessage.mockReset();
  desktopSessionMocks.stopHeadlessSession.mockClear();
});

describe('mesh-session provider driver', () => {
  it('waits for explicit Codex device sign-in and verifies the account before starting a thread', async () => {
    const fake = fakeAppServer({ initiallyAuthenticated: false });
    configureMeshSessionForTests({ spawn: () => fake.proc, probeCli: async () => '0.44.0' });
    const authenticate = vi.fn(async (request: { verificationUrl: string; userCode: string }) => {
      expect(request).toEqual({
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
      });
      fake.notify({
        method: 'account/login/completed',
        params: { loginId: 'login-1', success: true },
      });
      return true;
    });
    const hooks = {
      ...HOOKS_BASE,
      authenticate,
    };
    const result = await runRemoteSessionTurn(spec({ authMode: 'codex-account' }), hooks);

    const methods = fake.received.map((message) => message['method']);
    expect(methods.indexOf('account/read')).toBeLessThan(methods.indexOf('account/login/start'));
    expect(methods.lastIndexOf('account/read')).toBeLessThan(methods.indexOf('thread/start'));
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(hooks.emitActivity.mock.calls.flat().join(' ')).not.toContain('ABCD-EFGH');
    expect(result.turnStatus).toBe('completed');
  });

  it('does not treat auth UI approval as successful sign-in without the app-server completion', async () => {
    const fake = fakeAppServer({ initiallyAuthenticated: false });
    configureMeshSessionForTests({ spawn: () => fake.proc, probeCli: async () => '0.44.0' });
    const authenticate = vi.fn(async () => {
      fake.notify({
        method: 'account/login/completed',
        params: { loginId: 'login-1', success: false },
      });
      return true;
    });

    await expect(
      runRemoteSessionTurn(spec({ authMode: 'codex-account' }), {
        ...HOOKS_BASE,
        authenticate,
      }),
    ).rejects.toThrow('codex-account-login-failed');
    expect(fake.received.some((message) => message['method'] === 'thread/start')).toBe(false);
  });

  it('uses an OpenAI API-key grant through process-only Codex config overrides', async () => {
    const fake = fakeAppServer();
    let spawned: { args: string[]; env: NodeJS.ProcessEnv } | undefined;
    configureMeshSessionForTests({
      spawn: (_command, args, options) => {
        spawned = { args, env: options.env as NodeJS.ProcessEnv };
        return fake.proc;
      },
      probeCli: async () => '0.44.0',
    });
    await runRemoteSessionTurn(
      spec({
        provider: 'codex',
        authMode: 'openai-api-key',
        extraEnv: { OPENAI_API_KEY: 'grant-key' },
      }),
      HOOKS_BASE,
    );

    expect(spawned?.env.OPENAI_API_KEY).toBe('grant-key');
    expect(spawned?.args).toEqual(
      expect.arrayContaining([
        'model_provider="anvil_api"',
        'model_providers.anvil_api.name="OpenAI API"',
        'model_providers.anvil_api.base_url="https://api.openai.com/v1"',
        'model_providers.anvil_api.wire_api="responses"',
        'model_providers.anvil_api.env_key="OPENAI_API_KEY"',
        'model_providers.anvil_api.requires_openai_auth=false',
      ]),
    );
  });

  it('runs ACP providers through the Desktop session adapter and returns bounded output and resume handle', async () => {
    let probedProvider: string | undefined;
    configureMeshSessionForTests({
      probeCli: async (provider) => {
        probedProvider = provider;
        return '1.2.3';
      },
    });
    desktopSessionMocks.startSession.mockResolvedValue({
      id: 'session-cursor',
      providerThreadId: 'cursor-session-1',
    });
    desktopSessionMocks.sendMessage.mockImplementation(async () => {
      desktopSessionMocks.listener?.({
        sessionId: 'session-cursor',
        event: { type: 'text', text: 'Remote answer.' },
      });
      desktopSessionMocks.listener?.({
        sessionId: 'session-cursor',
        event: { type: 'turn_outcome', turnOutcome: 'completed', protocolTurnId: 'turn-cursor' },
      });
    });
    const hooks = {
      onThreadStarted: vi.fn(),
      emitActivity: vi.fn(),
      isCancelled: () => false,
      onEvent: vi.fn(),
    };
    const result = await runRemoteSessionTurn(
      spec({
        provider: 'cursor',
        resumeThreadId: 'cursor-session-0',
        extraEnv: { CURSOR_API_KEY: 'attempt-secret' },
      }),
      hooks,
    );

    expect(probedProvider).toBe('cursor');
    expect(desktopSessionMocks.startSession).toHaveBeenCalledWith(
      ['/tmp'],
      [],
      'coder',
      expect.objectContaining({ provider: 'cursor', providerThreadId: 'cursor-session-0' }),
      expect.objectContaining({
        model: 'gpt-5.6-terra',
        codexMode: 'workspace-auto',
        headless: true,
        bypassEnabledProviderGate: true,
        extraEnv: { CURSOR_API_KEY: 'attempt-secret' },
      }),
    );
    expect(result).toMatchObject({
      providerThreadId: 'cursor-session-1',
      resumeHandle: 'cursor-session-1',
      turnId: 'turn-cursor',
      turnStatus: 'completed',
      assistantOutput: 'Remote answer.',
      cliVersion: '1.2.3',
    });
    expect(hooks.onThreadStarted).toHaveBeenCalledWith('cursor-session-1');
    expect(hooks.onEvent).toHaveBeenCalledTimes(2);
    expect(desktopSessionMocks.stopHeadlessSession).toHaveBeenCalledWith('session-cursor');
  });

  it('fails clearly when an unattended ACP provider asks the user a question', async () => {
    configureMeshSessionForTests({ probeCli: async () => '1.2.3' });
    desktopSessionMocks.startSession.mockResolvedValue({
      id: 'session-cursor',
      providerThreadId: 'cursor-session-1',
    });
    desktopSessionMocks.sendMessage.mockImplementation(async () => {
      desktopSessionMocks.listener?.({
        sessionId: 'session-cursor',
        event: { type: 'input_request', inputRequest: { kind: 'cursor_ask_question' } },
      });
    });
    const hooks = {
      onThreadStarted: vi.fn(),
      emitActivity: vi.fn(),
      isCancelled: () => false,
      onEvent: vi.fn(),
    };
    const result = await runRemoteSessionTurn(spec({ provider: 'cursor' }), hooks);

    expect(result.turnStatus).toBe('failed');
    expect(hooks.emitActivity).toHaveBeenCalledWith(
      expect.stringContaining('remote attempts cannot answer questions'),
    );
    expect(hooks.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'input_request' }));
  });

  it('starts a thread, runs one turn, and stops the process group', async () => {
    const fake = fakeAppServer();
    configureMeshSessionForTests({
      spawn: () => fake.proc,
      probeCli: async () => '0.44.0',
    });
    const hooks = { ...HOOKS_BASE, onThreadStarted: vi.fn(), emitActivity: vi.fn() };
    const result = await runRemoteSessionTurn(spec(), hooks);

    expect(result.turnStatus).toBe('completed');
    expect(result.providerThreadId).toBe('thr-fake-1');
    expect(result.turnId).toBeNull(); // cleared by turn/completed
    expect(result.cliVersion).toBe('0.44.0');
    expect(result.cancelled).toBe(false);
    expect(hooks.onThreadStarted).toHaveBeenCalledWith('thr-fake-1');
    // The driver spawned detached and killed the group on exit.
    expect(fake.killedWith).toContain('SIGTERM');
    const methods = fake.received.map((m) => m['method']);
    expect(methods).toEqual(
      expect.arrayContaining(['initialize', 'initialized', 'thread/start', 'turn/start']),
    );
    const turnStart = fake.received.find((m) => m['method'] === 'turn/start');
    expect((turnStart?.['params'] as Record<string, unknown>)['approvalPolicy']).toBe('never');
  });

  it('resumes a prior provider thread via thread/resume', async () => {
    const fake = fakeAppServer();
    configureMeshSessionForTests({ spawn: () => fake.proc, probeCli: async () => '0.44.0' });
    const result = await runRemoteSessionTurn(spec({ resumeThreadId: 'thr-prior-9' }), HOOKS_BASE);
    expect(result.providerThreadId).toBe('thr-prior-9');
    expect(fake.received.some((m) => m['method'] === 'thread/resume')).toBe(true);
    expect(fake.received.some((m) => m['method'] === 'thread/start')).toBe(false);
  });

  it('times out a thread that never starts and kills the child', async () => {
    const fake = fakeAppServer({ threadReady: false });
    configureMeshSessionForTests({ spawn: () => fake.proc, probeCli: async () => '0.44.0' });
    await expect(runRemoteSessionTurn(spec(), HOOKS_BASE)).rejects.toThrow('thread-ready-timeout');
    expect(fake.killedWith).toContain('SIGTERM');
  });

  it('interrupts the turn and reports cancelled when the attempt flag lands', async () => {
    const fake = fakeAppServer({ holdTurn: true });
    configureMeshSessionForTests({ spawn: () => fake.proc, probeCli: async () => '0.44.0' });
    let cancelled = false;
    const hooks = {
      onThreadStarted: vi.fn(),
      emitActivity: vi.fn(),
      isCancelled: () => cancelled,
    };
    const run = runRemoteSessionTurn(spec(), hooks);
    // Let the turn start, then flag cancellation.
    setTimeout(() => {
      cancelled = true;
    }, 100);
    const result = await run;
    expect(result.cancelled).toBe(true);
    expect(result.turnStatus).toBe('interrupted');
    expect(fake.received.some((m) => m['method'] === 'turn/interrupt')).toBe(true);
  });

  it('auto-declines provider approval requests instead of stalling', async () => {
    const fake = fakeAppServer({ sendApprovalRequest: true });
    configureMeshSessionForTests({ spawn: () => fake.proc, probeCli: async () => '0.44.0' });
    const result = await runRemoteSessionTurn(spec(), HOOKS_BASE);
    expect(result.turnStatus).toBe('completed');
    const decline = fake.received.find(
      (m) => m['id'] === 'req-approval-1' && m['result'] !== undefined,
    );
    expect((decline?.['result'] as Record<string, unknown>)['decision']).toBe('decline');
  });

  it('routes approval mode to the Mesh approver and accepts only a live decision', async () => {
    const fake = fakeAppServer({ sendApprovalRequest: true, holdTurn: true });
    configureMeshSessionForTests({ spawn: () => fake.proc, probeCli: async () => '0.44.0' });
    const approve = vi.fn().mockResolvedValue(true);
    await runRemoteSessionTurn(spec({ permissionMode: 'on-request' }), { ...HOOKS_BASE, approve });
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ approvalCommand: 'rm -rf /' }));
    expect(
      fake.received.find((m) => m['id'] === 'req-approval-1' && m['result'])?.['result'],
    ).toEqual({ decision: 'accept' });
    expect(fake.received.find((m) => m['method'] === 'turn/start')?.['params']).toMatchObject({
      approvalPolicy: 'on-request',
    });
  });
  it.each(['read-only', 'workspace-auto'] as const)(
    'does not authorize provider escalation in %s mode',
    async (permissionMode) => {
      const fake = fakeAppServer({ sendApprovalRequest: true, holdTurn: true });
      configureMeshSessionForTests({ spawn: () => fake.proc, probeCli: async () => '0.44.0' });
      const approve = vi.fn().mockResolvedValue(true);
      await runRemoteSessionTurn(spec({ permissionMode }), { ...HOOKS_BASE, approve });
      expect(approve).not.toHaveBeenCalled();
      expect(
        fake.received.find((m) => m['id'] === 'req-approval-1' && m['result'])?.['result'],
      ).toEqual({ decision: 'decline' });
    },
  );
  it('honors full-access provider requests without invoking the Mesh approver', async () => {
    const fake = fakeAppServer({ sendApprovalRequest: true, holdTurn: true });
    configureMeshSessionForTests({ spawn: () => fake.proc, probeCli: async () => '0.44.0' });
    const approve = vi.fn().mockResolvedValue(false);
    await runRemoteSessionTurn(spec({ permissionMode: 'full-access' }), {
      ...HOOKS_BASE,
      approve,
    });
    expect(approve).not.toHaveBeenCalled();
    expect(
      fake.received.find((m) => m['id'] === 'req-approval-1' && m['result'])?.['result'],
    ).toEqual({ decision: 'accept' });
  });
  it('fails the attempt when the turn reports failed', async () => {
    const fake = fakeAppServer({ turnStatus: 'failed' });
    configureMeshSessionForTests({ spawn: () => fake.proc, probeCli: async () => '0.44.0' });
    const result = await runRemoteSessionTurn(spec(), HOOKS_BASE);
    expect(result.turnStatus).toBe('failed');
    expect(fake.killedWith.length).toBeGreaterThan(0);
  });

  it('kills the process group when the turn exceeds its timeout', async () => {
    const fake = fakeAppServer({ holdTurn: true });
    configureMeshSessionForTests({ spawn: () => fake.proc, probeCli: async () => '0.44.0' });
    await expect(runRemoteSessionTurn(spec({ turnTimeoutMs: 200 }), HOOKS_BASE)).rejects.toThrow(
      'turn-timeout-exceeded',
    );
    expect(fake.killedWith).toContain('SIGTERM');
  });
});

describe('satisfiesCliMin', () => {
  it('compares version tuples', () => {
    expect(satisfiesCliMin('0.44.0', '0.40.0')).toBe(true);
    expect(satisfiesCliMin('0.44.0', '0.44.0')).toBe(true);
    expect(satisfiesCliMin('0.44.0', '0.44.1')).toBe(false);
    expect(satisfiesCliMin('1.0.0', '0.99.9')).toBe(true);
    expect(satisfiesCliMin('0.4', '0.4.0')).toBe(true);
  });
});

describe('killProcessGroup', () => {
  it('returns immediately for an already-exited process', async () => {
    const proc = new EventEmitter() as MutableProcess;
    proc.exitCode = 0;
    proc.signalCode = null;
    proc.kill = vi.fn(() => true);
    await killProcessGroup(proc);
    expect(proc.kill).not.toHaveBeenCalled();
  });
});
