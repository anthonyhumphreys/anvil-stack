// Focused coverage for the remote `start-session` provider driver:
// journal-first spawn contract, thread ready/turn bounds, cancellation,
// in-band approval auto-decline, resume, and orphan kill.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
}

interface FakeBehavior {
  /** Respond to thread/start (false → never respond: ready-timeout path). */
  threadReady?: boolean;
  /** Emit a command approval request mid-turn (tests auto-decline). */
  sendApprovalRequest?: boolean;
  /** Delay turn completion until interrupted (cancel path). */
  holdTurn?: boolean;
  turnStatus?: 'completed' | 'failed';
}

function fakeAppServer(behavior: FakeBehavior = {}): FakeServer {
  const {
    threadReady = true,
    sendApprovalRequest = false,
    holdTurn = false,
    turnStatus = 'completed',
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
  const fake: FakeServer = { proc, received: [], killedWith: [] };
  proc.kill = (signal?: NodeJS.Signals | number) => {
    fake.killedWith.push(String(signal ?? 'SIGTERM'));
    queueMicrotask(() => proc.emit('exit', 0, 'SIGTERM'));
    return true;
  };

  const write = (doc: Record<string, unknown>): void => {
    proc.stdout.write(`${JSON.stringify(doc)}\n`);
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
        // driver results (approval decline) — recorded via `received` only.
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
});

describe('mesh-session provider driver', () => {
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
