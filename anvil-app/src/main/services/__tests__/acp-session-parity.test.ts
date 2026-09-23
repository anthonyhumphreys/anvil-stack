import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fake ACP agent process: stdin writes are captured, stdout lines are
// emitted by the test to drive the JSON-RPC stream.
interface FakeAcpProcess extends EventEmitter {
  stdin: {
    writable: boolean;
    destroyed: boolean;
    writableEnded: boolean;
    write: (chunk: string) => boolean;
    on: () => unknown;
  };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  written: string[];
}

function createFakeAcpProcess(): FakeAcpProcess {
  const proc = new EventEmitter() as FakeAcpProcess;
  const written: string[] = [];
  proc.stdin = {
    writable: true,
    destroyed: false,
    writableEnded: false,
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    on: () => proc.stdin,
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.written = written;
  return proc;
}

function emit(proc: FakeAcpProcess, payload: Record<string, unknown>): void {
  proc.stdout.emit('data', Buffer.from(`${JSON.stringify(payload)}\n`));
}

function writtenRequests(proc: FakeAcpProcess, method: string): Record<string, unknown>[] {
  return proc.written
    .flatMap((chunk) => chunk.split('\n').filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((msg) => msg.method === method);
}

const mocks = vi.hoisted(() => ({
  settings: {
    llmProvider: 'cursor',
    enabledLlmProviders: ['cursor', 'devin', 'codex', 'openai', 'azure', 'llmgateway'],
    codexMode: 'workspace-auto',
    openaiModel: 'auto',
    reasoningLevel: 'medium',
  } as Record<string, unknown>,
  personas: {} as Record<
    string,
    { capabilities: { canWriteFiles: boolean; canRunCommands: boolean; canReadFiles: boolean } }
  >,
  spawnResults: [] as FakeAcpProcess[],
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const proc = mocks.spawnResults.shift();
    if (!proc) throw new Error('No fake ACP process queued for spawn()');
    return proc;
  }),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/anvil-test', getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../settings.service.js', () => ({ getSettings: () => mocks.settings }));

vi.mock('../persona.service.js', () => ({
  getPersonaById: (id: string) => mocks.personas[id] ?? null,
  buildSystemPrompt: () => 'system prompt',
  buildDesignSystemPrompt: () => 'design prompt',
  buildScaffoldSystemPrompt: () => 'scaffold prompt',
}));

vi.mock('../mesh-ownership.service.js', () => ({ assertSessionTurnAllowed: () => undefined }));
vi.mock('../dojo-analytics.service.js', () => ({
  listDojoPrices: () => [],
  recordDojoExecutionEvent: () => undefined,
}));
vi.mock('../companion-events.service.js', () => ({ emitCompanionEvent: () => undefined }));
vi.mock('../chat-persistence.service.js', () => ({ updateChatThreadAttention: () => undefined }));
vi.mock('../thread-assist.service.js', () => ({ scheduleThreadMetadataRefresh: () => undefined }));
vi.mock('../notification.service.js', () => ({ notifyChatActivity: () => undefined }));
vi.mock('../llm-gateway.service.js', () => ({
  applyLlmGatewayEnvironment: () => undefined,
  resolveLlmGatewayModelConfig: vi.fn(),
}));
vi.mock('../llm-gateway-runtime.service.js', () => ({
  syncGatewayCodexIntegrations: vi.fn(),
  writeGatewayCodexCatalog: vi.fn(async () => []),
}));
vi.mock('../codex-runtime.service.js', () => ({ resolveCodexRuntime: async () => '/bin/codex' }));

import { spawn } from 'node:child_process';
import {
  listPendingApprovalRequests,
  startSession,
  steerTurn,
  sendMessage,
  stopAllSessions,
  subscribeToCodexEvents,
  type CodexEventSubscription,
} from '../codex-session.service.js';

const INIT_RESULT = (loadSession: boolean) => ({
  jsonrpc: '2.0',
  id: 'init-1',
  result: {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession,
      promptCapabilities: { image: true, embeddedContext: true },
    },
  },
});

async function waitForSpawn(): Promise<void> {
  await vi.waitFor(() => expect(vi.mocked(spawn)).toHaveBeenCalled(), { timeout: 2000 });
}

async function startAcpSession(
  proc: FakeAcpProcess,
  options?: Parameters<typeof startSession>[3],
  personaId = 'coder',
) {
  mocks.spawnResults.push(proc);
  const started = startSession(['/repo'], ['r1'], personaId, options);
  // startSession awaits the env build before spawning — emit only once the
  // fake process's stdout listeners are attached.
  await waitForSpawn();
  emit(proc, INIT_RESULT(true));
  emit(proc, { jsonrpc: '2.0', id: 's1', result: { sessionId: 'acp-1' } });
  return started;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ACP session parity (cursor/devin)', () => {
  let events: CodexEventSubscription[];
  let unsubscribe: () => void;

  beforeEach(() => {
    events = [];
    unsubscribe = subscribeToCodexEvents((payload) => events.push(payload));
    mocks.settings.llmProvider = 'cursor';
    mocks.settings.codexMode = 'workspace-auto';
    mocks.personas['coder'] = {
      capabilities: { canWriteFiles: true, canRunCommands: true, canReadFiles: true },
    };
    mocks.personas['reader'] = {
      capabilities: { canWriteFiles: false, canRunCommands: false, canReadFiles: true },
    };
  });

  afterEach(() => {
    unsubscribe();
    stopAllSessions();
    vi.clearAllMocks();
  });

  it('reports truthful capabilities: ACP mid-turn sends queue, goals are unsupported', async () => {
    const proc = createFakeAcpProcess();
    const session = await startAcpSession(proc);

    expect(session.capabilities).toMatchObject({
      resumable: true,
      midTurnSend: 'queue',
      goals: false,
      accessModes: ['ask', 'agent', 'plan'],
    });
    expect(session.continuity).toBe('new');
    expect(session.resumable).toBe(true);
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      'cursor-agent',
      ['acp'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('resumes via session/load when the agent advertises loadSession', async () => {
    const proc = createFakeAcpProcess();
    const session = await startAcpSession(proc, {
      provider: 'cursor',
      providerThreadId: 'acp-old',
    });

    const loads = writtenRequests(proc, 'session/load');
    expect(loads).toHaveLength(1);
    expect(loads[0].params).toMatchObject({ sessionId: 'acp-old' });
    expect(writtenRequests(proc, 'session/new')).toHaveLength(0);
    expect(session.continuity).toBe('resumed');
    expect(session.resumable).toBe(true);
  });

  it('falls back to session/new and reports transcript-seeded when loadSession is not advertised', async () => {
    const proc = createFakeAcpProcess();
    mocks.spawnResults.push(proc);
    const started = startSession(['/repo'], ['r1'], 'coder', {
      provider: 'cursor',
      providerThreadId: 'acp-gone',
    });
    await waitForSpawn();
    // session/new must be deferred until the initialize result arrives
    expect(writtenRequests(proc, 'session/new')).toHaveLength(0);
    emit(proc, INIT_RESULT(false));
    expect(writtenRequests(proc, 'session/new')).toHaveLength(1);
    emit(proc, { jsonrpc: '2.0', id: 's1', result: { sessionId: 'acp-2' } });
    const session = await started;

    expect(session.continuity).toBe('transcript-seeded');
    expect(session.resumable).toBe(false);
    expect(session.capabilities?.resumable).toBe(false);
  });

  it('reports an ACP fork as transcript-seeded, never protocol-forked', async () => {
    const proc = createFakeAcpProcess();
    const session = await startAcpSession(proc, {
      provider: 'cursor',
      forkFromProviderThreadId: 'acp-source',
    });

    expect(writtenRequests(proc, 'session/new')).toHaveLength(1);
    expect(writtenRequests(proc, 'session/load')).toHaveLength(0);
    expect(session.continuity).toBe('transcript-seeded');
  });

  it('clamps a canWriteFiles:false persona to ask even when settings allow auto (H1)', async () => {
    const proc = createFakeAcpProcess();
    const session = await startAcpSession(proc, { provider: 'cursor' }, 'reader');

    await sendMessage(session.id, 'look at this', [], {});
    const setMode = writtenRequests(proc, 'session/set_mode');
    expect(setMode[0].params).toMatchObject({ modeId: 'ask' });
  });

  it('queues a busy-send and flushes it via session/prompt when the turn completes (H2)', async () => {
    const proc = createFakeAcpProcess();
    const session = await startAcpSession(proc);

    await sendMessage(session.id, 'first message', [], {});
    // The public session snapshot above is stale — internally the session is
    // now 'busy', which is what routes the steer into the queue.

    const result = await steerTurn(session.id, 'also handle this', []);
    expect(result).toEqual({ disposition: 'queued', queueDepth: 1 });
    expect(
      events.some((e) => e.event.type === 'queue_update' && e.event.queuedSendCount === 1),
    ).toBe(true);

    // Turn completes → queued message is delivered as a new prompt.
    emit(proc, { jsonrpc: '2.0', id: 't1', result: { stopReason: 'end_turn' } });
    await tick();
    await tick();

    const prompts = writtenRequests(proc, 'session/prompt');
    const queuedPrompt = prompts.at(-1);
    expect(queuedPrompt?.params).toMatchObject({ sessionId: 'acp-1' });
    expect(JSON.stringify(queuedPrompt?.params)).toContain('also handle this');
    expect(
      events.some((e) => e.event.type === 'queue_update' && e.event.queuedSendCount === 0),
    ).toBe(true);
  });

  it('sends immediately when the ACP session is idle', async () => {
    const proc = createFakeAcpProcess();
    const session = await startAcpSession(proc);

    const result = await steerTurn(session.id, 'hello', []);
    expect(result).toEqual({ disposition: 'sent', queueDepth: 0 });
    expect(writtenRequests(proc, 'session/prompt')).toHaveLength(1);
  });

  it('registers ACP permission requests as pending approvals for companion/statusbar (H8)', async () => {
    const proc = createFakeAcpProcess();
    const session = await startAcpSession(proc);
    await sendMessage(session.id, 'run a thing', [], {});

    emit(proc, {
      jsonrpc: '2.0',
      id: 'perm-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'acp-1',
        toolCall: { title: 'Run tests', kind: 'execute', rawInput: { command: 'npm test' } },
        options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' }],
      },
    });

    const pending = listPendingApprovalRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      sessionId: session.id,
      kind: 'permissions',
    });
  });
});
