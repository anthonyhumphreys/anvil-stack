import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeProcess extends EventEmitter {
  pid: number;
  stdin: {
    writable: boolean;
    destroyed: boolean;
    writableEnded: boolean;
    write: (c: string) => boolean;
    on: () => unknown;
  };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  written: string[];
}

function createFakeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.written = [];
  proc.pid = undefined as unknown as number;
  proc.stdin = {
    writable: true,
    destroyed: false,
    writableEnded: false,
    write: (chunk: string) => {
      proc.written.push(chunk);
      return true;
    },
    on: () => proc.stdin,
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

const emit = (proc: FakeProcess, payload: Record<string, unknown>) =>
  proc.stdout.emit('data', Buffer.from(`${JSON.stringify(payload)}\n`));

const requests = (proc: FakeProcess, method: string) =>
  proc.written
    .flatMap((chunk) => chunk.split('\n').filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((msg) => msg.method === method);

const mocks = vi.hoisted(() => ({
  settings: {
    llmProvider: 'codex',
    enabledLlmProviders: ['cursor', 'devin', 'codex', 'openai', 'azure', 'llmgateway'],
    codexMode: 'on-request',
    openaiModel: 'gpt-5.5',
    reasoningLevel: 'medium',
    userRole: 'ba-brm',
  } as Record<string, unknown>,
  spawnResults: [] as FakeProcess[],
  threads: new Map<string, { temporary?: boolean; purpose?: string }>(),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const proc = mocks.spawnResults.shift();
    if (!proc) throw new Error('No fake process queued');
    return proc;
  }),
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/mezair-test', getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../chat-continuation.service.js', () => ({
  captureThreadContinuation: () => ({
    context: 'Saved conversation checkpoint',
    messages: [],
    artifactRefs: [],
  }),
  prependThreadContinuation: (context: string | undefined, message: string) =>
    context ? `${context}\nNewest user request:\n${message}` : message,
}));
vi.mock('../settings.service.js', () => ({ getSettings: () => mocks.settings }));
vi.mock('../persona.service.js', () => ({
  getPersonaById: () => ({
    capabilities: { canWriteFiles: true, canRunCommands: true, canReadFiles: true },
  }),
  buildSystemPrompt: () => 'system prompt',
  buildDesignSystemPrompt: () => 'design prompt',
  buildScaffoldSystemPrompt: () => 'scaffold prompt',
  buildTemporaryChatSystemPrompt: () => 'temporary prompt',
}));
vi.mock('../mesh-ownership.service.js', () => ({ assertSessionTurnAllowed: () => undefined }));
vi.mock('../dojo-analytics.service.js', () => ({
  listDojoPrices: () => [],
  recordDojoExecutionEvent: () => undefined,
}));
vi.mock('../companion-events.service.js', () => ({ emitCompanionEvent: () => undefined }));
vi.mock('../chat-persistence.service.js', () => ({
  getChatThread: (id: string) => mocks.threads.get(id) ?? null,
  isTemporaryChatThread: (id: string) => mocks.threads.get(id)?.temporary === true,
  updateChatThreadAttention: () => undefined,
  setChatThreadProviderThreadId: vi.fn(),
}));
import { setChatThreadProviderThreadId } from '../chat-persistence.service.js';
vi.mock('../chat-evidence.service.js', () => ({ saveChatEvent: vi.fn() }));
vi.mock('../agent-ui-intent.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-ui-intent.service.js')>()),
  expireAgentUIIntentsForSession: () => [],
}));
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
  getAgentToolSessionContext,
  sendMessage,
  emitLocalAssistantTurnEnd,
  startSession,
  stopAllSessions,
  stopSession,
} from '../codex-session.service.js';
import {
  getAgentMcpTokenForSession,
  resetAgentMcpRegistryForTests,
  resolveAgentMcpToken,
  setAgentMcpEndpoint,
} from '../agent-mcp/registry.js';
import { ROLE_FEATURES } from '../../../shared/types.js';

const URL = 'http://127.0.0.1:45555/mcp';

function lastSpawn(): { command: string; args: string[]; env: Record<string, string> } {
  const call = vi.mocked(spawn).mock.calls.at(-1)!;
  return {
    command: call[0] as string,
    args: call[1] as string[],
    env: (call[2] as { env: Record<string, string> }).env,
  };
}

async function startCodex(
  options: Parameters<typeof startSession>[3] = {},
  repoIds = ['r1', 'r2'],
) {
  const proc = createFakeProcess();
  mocks.spawnResults.push(proc);
  const started = startSession(['/repo'], repoIds, 'coder', { provider: 'codex', ...options });
  await vi.waitFor(() => expect(vi.mocked(spawn)).toHaveBeenCalled());
  emit(proc, { jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: 'th-1' } } });
  return { proc, session: await started };
}

async function startAcp(provider: 'cursor' | 'devin', mcpCapabilities?: Record<string, boolean>) {
  const proc = createFakeProcess();
  mocks.spawnResults.push(proc);
  const started = startSession(['/repo'], ['r1'], 'coder', { provider, threadId: 'thread-1' });
  await vi.waitFor(() => expect(vi.mocked(spawn)).toHaveBeenCalled());
  expect(requests(proc, 'session/new')).toHaveLength(0);
  emit(proc, {
    jsonrpc: '2.0',
    id: 'init',
    result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities } },
  });
  emit(proc, { jsonrpc: '2.0', id: 's1', result: { sessionId: 'acp-1' } });
  return { proc, session: await started };
}

describe('codex-session agent MCP wiring', () => {
  beforeEach(() => {
    resetAgentMcpRegistryForTests();
    setAgentMcpEndpoint({ url: URL, port: 45555, shimPath: '/app/scripts/mezair-mcp-shim.mjs' });
    mocks.settings.userRole = 'ba-brm';
    mocks.threads.clear();
  });

  afterEach(() => {
    stopAllSessions();
    vi.clearAllMocks();
  });

  it('injects the mezair server into Codex app-server args and the token into env only', async () => {
    const { session } = await startCodex({ threadId: 'thread-1' });
    const { command, args, env } = lastSpawn();
    const token = getAgentMcpTokenForSession(session.id)!;
    expect(command).toBe('codex');
    expect(args).toEqual([
      'app-server',
      '-c',
      `mcp_servers.mezair.url="${URL}"`,
      '-c',
      'mcp_servers.mezair.bearer_token_env_var="MEZAIR_MCP_TOKEN"',
      '-c',
      'mcp_servers.mezair.tool_timeout_sec=660',
    ]);
    expect(env.MEZAIR_MCP_TOKEN).toBe(token);
    expect(args.join(' ')).not.toContain(token);
  });

  it('resolves the live session context and revokes the token on stop', async () => {
    const { session } = await startCodex({
      threadId: 'thread-1',
      workspace: { workspaceId: 'ws-1' },
    });
    const token = getAgentMcpTokenForSession(session.id)!;
    expect(resolveAgentMcpToken(token)?.context).toEqual({
      sessionId: session.id,
      appThreadId: 'thread-1',
      workspaceId: 'ws-1',
      repoIds: ['r1', 'r2'],
      provider: 'codex',
      mode: 'on-request',
      features: ROLE_FEATURES['ba-brm'],
    });
    mocks.settings.userRole = undefined;
    expect(getAgentToolSessionContext(session.id)?.features).toEqual([]);

    stopSession(session.id);
    expect(getAgentMcpTokenForSession(session.id)).toBeUndefined();
    expect(resolveAgentMcpToken(token)).toBeUndefined();
    expect(getAgentToolSessionContext(session.id)).toBeUndefined();
  });

  it('revokes the token when the provider process exits', async () => {
    const { proc, session } = await startCodex();
    expect(getAgentMcpTokenForSession(session.id)).toBeDefined();
    proc.emit('exit', 1, null);
    expect(getAgentMcpTokenForSession(session.id)).toBeUndefined();
  });

  it('pins read-only sessions to read-only tool context', async () => {
    const { session } = await startCodex({ codexMode: 'read-only' });
    expect(getAgentToolSessionContext(session.id)?.mode).toBe('read-only');
  });

  it('gives temporary chats no token and keeps every MCP server disabled', async () => {
    mocks.threads.set('tmp', { temporary: true });
    const { session } = await startCodex({ threadId: 'tmp', temporaryChat: true }, []);
    const { args, env } = lastSpawn();
    expect(args).toEqual(['app-server', '-c', 'mcp_servers={}']);
    expect(env.MEZAIR_MCP_TOKEN).toBeUndefined();
    expect(getAgentMcpTokenForSession(session.id)).toBeUndefined();
    expect(getAgentToolSessionContext(session.id)).toBeUndefined();
  });

  it('starts sessions without MCP when the endpoint is not running', async () => {
    setAgentMcpEndpoint(undefined);
    const { session } = await startCodex();
    expect(lastSpawn().args).toEqual(['app-server']);
    expect(getAgentMcpTokenForSession(session.id)).toBeUndefined();
  });

  it('attaches the http server to ACP session/new when advertised', async () => {
    const { proc, session } = await startAcp('cursor', { http: true, sse: true });
    const token = getAgentMcpTokenForSession(session.id)!;
    expect(lastSpawn().args).toEqual(['acp']);
    expect(lastSpawn().env.MEZAIR_MCP_TOKEN).toBeUndefined();
    expect(requests(proc, 'session/new')[0].params).toMatchObject({
      mcpServers: [
        {
          type: 'http',
          name: 'mezair',
          url: URL,
          headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
        },
      ],
    });
  });

  it('falls back to the stdio shim when the ACP agent does not advertise http', async () => {
    const { proc, session } = await startAcp('devin');
    const token = getAgentMcpTokenForSession(session.id)!;
    expect(requests(proc, 'session/new')[0].params).toMatchObject({
      mcpServers: [
        {
          name: 'mezair',
          command: process.execPath,
          args: ['/app/scripts/mezair-mcp-shim.mjs'],
          env: [
            { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
            { name: 'MEZAIR_MCP_URL', value: URL },
            { name: 'MEZAIR_MCP_TOKEN', value: token },
          ],
        },
      ],
    });
  });

  it('attaches the server to ACP session/load on resume', async () => {
    const proc = createFakeProcess();
    mocks.spawnResults.push(proc);
    const started = startSession(['/repo'], ['r1'], 'coder', {
      provider: 'cursor',
      providerThreadId: 'acp-old',
    });
    await vi.waitFor(() => expect(vi.mocked(spawn)).toHaveBeenCalled());
    emit(proc, {
      jsonrpc: '2.0',
      id: 'init',
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
      },
    });
    emit(proc, { jsonrpc: '2.0', id: 's1', result: { sessionId: 'acp-old' } });
    const session = await started;
    expect(requests(proc, 'session/load')[0].params).toMatchObject({
      sessionId: 'acp-old',
      mcpServers: [{ type: 'http', name: 'mezair', url: URL }],
    });
    expect(getAgentMcpTokenForSession(session.id)).toBeDefined();
  });
});

describe('provider continuation', () => {
  afterEach(() => {
    stopAllSessions();
    vi.clearAllMocks();
    mocks.threads.clear();
  });
  it('seeds a fresh provider from the conversation exactly once', async () => {
    mocks.threads.set('thread-1', {});
    const { proc, session } = await startCodex({ threadId: 'thread-1' });
    expect(session.continuity).toBe('transcript-seeded');
    await sendMessage(session.id, 'Continue');
    expect(JSON.stringify(requests(proc, 'turn/start').at(-1))).toContain(
      'Saved conversation checkpoint',
    );
    await sendMessage(session.id, 'Next');
    expect(JSON.stringify(requests(proc, 'turn/start').at(-1))).not.toContain(
      'Saved conversation checkpoint',
    );
  });
  it('keeps native resume without duplicating the transcript', async () => {
    mocks.threads.set('thread-1', {});
    const { proc, session } = await startCodex({
      threadId: 'thread-1',
      providerThreadId: 'native-thread',
    });
    expect(session.continuity).toBe('resumed');
    await sendMessage(session.id, 'Continue');
    expect(JSON.stringify(requests(proc, 'turn/start').at(-1))).not.toContain(
      'Saved conversation checkpoint',
    );
  });
  it('refreshes a native provider after an on-device reply exactly once', async () => {
    mocks.threads.set('thread-1', {});
    const { proc, session } = await startCodex({
      threadId: 'thread-1',
      providerThreadId: 'native-thread',
    });
    emitLocalAssistantTurnEnd(session.id);
    expect(setChatThreadProviderThreadId).toHaveBeenCalledWith('thread-1', null, 'codex');
    await sendMessage(session.id, 'Continue after the on-device answer');
    expect(JSON.stringify(requests(proc, 'turn/start').at(-1))).toContain(
      'Saved conversation checkpoint',
    );
    await sendMessage(session.id, 'Next');
    expect(JSON.stringify(requests(proc, 'turn/start').at(-1))).not.toContain(
      'Saved conversation checkpoint',
    );
  });
});
