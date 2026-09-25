import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceExecutionContext,
} from '../../../../cloud/contract/browser-workspace.js';

const mocks = vi.hoisted(() => ({
  eventListener: undefined as
    | ((payload: {
        sessionId: string;
        appThreadId?: string;
        event: Record<string, unknown>;
      }) => void)
    | undefined,
  getWorkspace: vi.fn(),
  getChatThread: vi.fn(),
  listChatThreads: vi.fn(() => []),
  loadChatHistory: vi.fn(() => []),
  createChatThread: vi.fn(),
  createChatSession: vi.fn(),
  endChatSession: vi.fn(),
  getChatThreadProviderBinding: vi.fn(() => null),
  saveChatEntry: vi.fn(),
  saveChatThreadGoal: vi.fn(),
  saveChatThreadPlan: vi.fn(),
  saveChatEvent: vi.fn(),
  getCodexSession: vi.fn(),
  claimSessionForBrowser: vi.fn((sessionId: string) => mocks.getCodexSession(sessionId)),
  listActiveCodexSessions: vi.fn(() => []),
  listPendingApprovalRequests: vi.fn(() => []),
  startSession: vi.fn(),
  sendMessage: vi.fn(),
  interruptTurn: vi.fn(),
  stopSession: vi.fn(),
  resolveApproval: vi.fn(),
  resolveInputRequest: vi.fn(),
  subscribeToCodexEvents: vi.fn((listener) => {
    mocks.eventListener = listener;
    return () => undefined;
  }),
  getFullStatus: vi.fn(),
  getFileDiff: vi.fn(),
  getSettings: vi.fn(() => ({ codexMode: 'on-request' })),
  listWorkflowTemplates: vi.fn(() => []),
  listWorkflowRuns: vi.fn(() => []),
  getWorkflowRun: vi.fn(),
  startWorkflowRun: vi.fn(),
  cancelWorkflowRun: vi.fn(),
  toolsExecute: vi.fn(),
  disposeSharedTools: vi.fn(),
}));

vi.mock('../workspace.service.js', () => ({ getWorkspace: mocks.getWorkspace }));
vi.mock('../chat-persistence.service.js', () => ({
  createChatSession: mocks.createChatSession,
  createChatThread: mocks.createChatThread,
  endChatSession: mocks.endChatSession,
  getChatThread: mocks.getChatThread,
  getChatThreadProviderBinding: mocks.getChatThreadProviderBinding,
  listChatThreads: mocks.listChatThreads,
  loadChatHistory: mocks.loadChatHistory,
  saveChatEntry: mocks.saveChatEntry,
  saveChatThreadGoal: mocks.saveChatThreadGoal,
  saveChatThreadPlan: mocks.saveChatThreadPlan,
}));
vi.mock('../chat-evidence.service.js', () => ({ saveChatEvent: mocks.saveChatEvent }));
vi.mock('../codex-session.service.js', () => ({
  claimSessionForBrowser: mocks.claimSessionForBrowser,
  getCodexSession: mocks.getCodexSession,
  interruptTurn: mocks.interruptTurn,
  listActiveCodexSessions: mocks.listActiveCodexSessions,
  listPendingApprovalRequests: mocks.listPendingApprovalRequests,
  resolveApproval: mocks.resolveApproval,
  resolveInputRequest: mocks.resolveInputRequest,
  sendMessage: mocks.sendMessage,
  startSession: mocks.startSession,
  stopSession: mocks.stopSession,
  subscribeToCodexEvents: mocks.subscribeToCodexEvents,
}));
vi.mock('../git.service.js', () => ({
  getFullStatus: mocks.getFullStatus,
  getFileDiff: mocks.getFileDiff,
}));
vi.mock('../settings.service.js', () => ({ getSettings: mocks.getSettings }));
vi.mock('../workflow.service.js', () => ({
  cancelWorkflowRun: mocks.cancelWorkflowRun,
  getWorkflowRun: mocks.getWorkflowRun,
  listWorkflowRuns: mocks.listWorkflowRuns,
  listWorkflowTemplates: mocks.listWorkflowTemplates,
  startWorkflowRun: mocks.startWorkflowRun,
}));
vi.mock('../browser-workspace-tools.service.js', () => ({
  getSharedBrowserWorkspaceTools: () => ({ execute: mocks.toolsExecute }),
  disposeSharedBrowserWorkspaceTools: mocks.disposeSharedTools,
  revokeSharedBrowserWorkspaceGrant: vi.fn(),
}));

import { executeBrowserWorkspaceCommand } from '../browser-workspace-executor.service.js';

function resultData(result: Awaited<ReturnType<typeof executeBrowserWorkspaceCommand>>): unknown {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

const workspaceId = 'workspace-1';
const repoId = 'repo-1';
let tempRoot: string;
let repoPath: string;

const workspace = () => ({
  id: workspaceId,
  name: 'Browser workspace',
  definitionState: 'ready' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  repos: [
    {
      id: repoId,
      name: 'repo-one',
      path: repoPath,
      remoteUrl: 'https://token:secret@example.com/repo.git',
      defaultBranch: 'main',
      languages: [],
      status: 'connected' as const,
      fileCount: 2,
      branchCount: 1,
    },
  ],
});

function context(
  scopes: BrowserWorkspaceExecutionContext['scopes'] = ['workspace-read'],
  repoIds: readonly string[] = [repoId],
): BrowserWorkspaceExecutionContext {
  return {
    grantId: 'grant-1',
    workspaceId,
    repoIds,
    scopes,
    expiresAt: Date.now() + 60_000,
    commandId: `command-${Math.random().toString(36).slice(2)}`,
  };
}

function command(command: BrowserWorkspaceCommand): BrowserWorkspaceCommand {
  return command;
}

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'anvil-browser-workspace-'));
  repoPath = path.join(tempRoot, 'repo');
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(path.join(repoPath, 'README.md'), 'hello');
  writeFileSync(path.join(repoPath, '.env'), 'SECRET=do-not-return');
  mocks.getWorkspace.mockImplementation(() => workspace());
  mocks.getChatThread.mockReset();
  mocks.getCodexSession.mockReset();
  mocks.listActiveCodexSessions.mockReturnValue([]);
  mocks.getSettings.mockReturnValue({ codexMode: 'on-request' });
  vi.clearAllMocks();
  mocks.getWorkspace.mockImplementation(() => workspace());
  mocks.getSettings.mockReturnValue({ codexMode: 'on-request' });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('browser workspace repository boundaries', () => {
  it('reads bounded files and returns a content revision', async () => {
    const result = await executeBrowserWorkspaceCommand(
      command({ operation: 'file.read', repositoryId: repoId, relativePath: 'README.md' }),
      context(),
    );

    expect(result.ok).toBe(true);
    expect(resultData(result)).toMatchObject({ content: 'hello', relativePath: 'README.md' });
    expect((resultData(result) as { revision: string }).revision).toHaveLength(64);
  });

  it('rejects parent paths and secret paths, while omitting secrets from lists', async () => {
    const traversal = await executeBrowserWorkspaceCommand(
      command({ operation: 'file.read', repositoryId: repoId, relativePath: '../outside' }),
      context(),
    );
    const secret = await executeBrowserWorkspaceCommand(
      command({ operation: 'file.read', repositoryId: repoId, relativePath: '.env' }),
      context(),
    );
    const listed = await executeBrowserWorkspaceCommand(
      command({ operation: 'file.list', repositoryId: repoId }),
      context(),
    );

    expect(traversal).toMatchObject({ ok: false, error: { code: 'invalid-path' } });
    expect(secret).toMatchObject({ ok: false, error: { code: 'secret-path' } });
    expect((resultData(listed) as { entries: Array<{ path: string }> }).entries).not.toContainEqual(
      expect.objectContaining({ path: '.env' }),
    );
  });

  it('requires a matching content revision for atomic writes', async () => {
    const initial = await executeBrowserWorkspaceCommand(
      command({ operation: 'file.read', repositoryId: repoId, relativePath: 'README.md' }),
      context(),
    );
    const revision = (resultData(initial) as { revision: string }).revision;
    const written = await executeBrowserWorkspaceCommand(
      command({
        operation: 'file.write',
        repositoryId: repoId,
        relativePath: 'README.md',
        content: 'updated',
        expectedRevision: revision,
      }),
      context(['workspace-write']),
    );
    const stale = await executeBrowserWorkspaceCommand(
      command({
        operation: 'file.write',
        repositoryId: repoId,
        relativePath: 'README.md',
        content: 'stale',
        expectedRevision: revision,
      }),
      context(['workspace-write']),
    );

    expect(written.ok).toBe(true);
    expect(readFileSync(path.join(repoPath, 'README.md'), 'utf8')).toBe('updated');
    expect(stale).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
  });

  it('rejects symlinks in intermediate path components and preserves file mode bits', async () => {
    const outside = path.join(tempRoot, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'escaped.txt'), 'outside');
    symlinkSync(outside, path.join(repoPath, 'linked'));

    const escaped = await executeBrowserWorkspaceCommand(
      command({ operation: 'file.read', repositoryId: repoId, relativePath: 'linked/escaped.txt' }),
      context(),
    );
    expect(escaped).toMatchObject({ ok: false, error: { code: 'invalid-path' } });

    chmodSync(path.join(repoPath, 'README.md'), 0o755);
    const initial = await executeBrowserWorkspaceCommand(
      command({ operation: 'file.read', repositoryId: repoId, relativePath: 'README.md' }),
      context(),
    );
    await executeBrowserWorkspaceCommand(
      command({
        operation: 'file.write',
        repositoryId: repoId,
        relativePath: 'README.md',
        content: 'mode-preserved',
        expectedRevision: (resultData(initial) as { revision: string }).revision,
      }),
      context(['workspace-write']),
    );
    expect(lstatSync(path.join(repoPath, 'README.md')).mode & 0o777).toBe(0o755);
  });

  it('does not expose repositories outside the approved repository allowlist', async () => {
    const result = await executeBrowserWorkspaceCommand(
      command({
        operation: 'file.read',
        repositoryId: 'repo-unauthorized',
        relativePath: 'README.md',
      }),
      context(),
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('rejects oversized reads and compare-and-swap revisions before loading file bytes', async () => {
    const largePath = path.join(repoPath, 'large.bin');
    writeFileSync(largePath, '');
    truncateSync(largePath, 512 * 1024 + 1);

    const read = await executeBrowserWorkspaceCommand(
      command({ operation: 'file.read', repositoryId: repoId, relativePath: 'large.bin' }),
      context(),
    );
    const write = await executeBrowserWorkspaceCommand(
      command({
        operation: 'file.write',
        repositoryId: repoId,
        relativePath: 'large.bin',
        content: 'replacement',
        expectedRevision: null,
      }),
      context(['workspace-write']),
    );

    expect(read).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(write).toMatchObject({ ok: false, error: { code: 'conflict' } });

    const lineHeavyPath = path.join(repoPath, 'line-heavy.txt');
    writeFileSync(lineHeavyPath, '\n'.repeat(40_000));
    const lineHeavy = await executeBrowserWorkspaceCommand(
      command({ operation: 'file.read', repositoryId: repoId, relativePath: 'line-heavy.txt' }),
      context(),
    );
    expect(lineHeavy).toMatchObject({ ok: false, error: { code: 'conflict' } });

    const boundedLinePath = path.join(repoPath, 'bounded-lines.txt');
    writeFileSync(boundedLinePath, '\n'.repeat(30_000));
    const boundedLines = await executeBrowserWorkspaceCommand(
      command({ operation: 'file.read', repositoryId: repoId, relativePath: 'bounded-lines.txt' }),
      context(),
    );
    expect(boundedLines.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(boundedLines), 'utf8')).toBeLessThanOrEqual(256 * 1024);
  });

  it('skips dependency/build directories and reports list truncation accurately', async () => {
    mkdirSync(path.join(repoPath, 'node_modules', 'package'), { recursive: true });
    writeFileSync(path.join(repoPath, 'node_modules', 'package', 'generated.js'), 'generated');
    mkdirSync(path.join(repoPath, 'src'));
    writeFileSync(path.join(repoPath, 'src', 'main.ts'), 'export {}');

    const listed = await executeBrowserWorkspaceCommand(
      command({ operation: 'file.list', repositoryId: repoId, maxEntries: 20 }),
      context(),
    );
    const data = resultData(listed) as {
      entries: Array<{ path: string }>;
      truncated: boolean;
    };
    expect(data.entries.map((entry) => entry.path)).toContain('src');
    expect(
      data.entries.map((entry) => entry.path).some((entry) => entry.includes('node_modules')),
    ).toBe(false);
    expect(data.truncated).toBe(false);

    const limited = await executeBrowserWorkspaceCommand(
      command({ operation: 'file.list', repositoryId: repoId, maxEntries: 1 }),
      context(),
    );
    expect(resultData(limited)).toMatchObject({ truncated: true });
  });

  it('bounds git status and strips credentials and secret paths from results', async () => {
    mocks.getFullStatus.mockResolvedValue({
      branch: 'main',
      ahead: 0,
      behind: 0,
      files: [
        { path: '.env', status: 'modified', staged: false },
        ...Array.from({ length: 20_000 }, (_, index) => ({
          path: `src/generated-${index}.ts`,
          status: 'modified' as const,
          staged: false,
        })),
      ],
    });
    const status = await executeBrowserWorkspaceCommand(
      command({ operation: 'git.status', repositoryId: repoId }),
      context(),
    );
    const statusData = resultData(status) as {
      files: Array<{ path: string }>;
      truncated: boolean;
    };
    expect(statusData.truncated).toBe(true);
    expect(statusData.files.some((file) => file.path === '.env')).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(statusData), 'utf8')).toBeLessThanOrEqual(256 * 1024);

    mocks.getFileDiff.mockResolvedValue({
      filePath: 'README.md',
      oldContent: 'x'.repeat(600 * 1024),
      newContent: '',
      hunks: '',
    });
    const diff = await executeBrowserWorkspaceCommand(
      command({ operation: 'git.diff', repositoryId: repoId, relativePath: 'README.md' }),
      context(),
    );
    expect(resultData(diff)).toMatchObject({ truncated: true, oldContent: '', newContent: '' });
  });

  it('redacts credentials from repository metadata', async () => {
    const result = await executeBrowserWorkspaceCommand(
      command({ operation: 'repo.list' }),
      context(),
    );
    expect(resultData(result)).toMatchObject({
      0: { remoteUrl: 'https://example.com/repo.git' },
    });
  });
});

describe('browser workspace chat lifecycle', () => {
  const thread = {
    id: 'thread-1',
    workspaceId,
    personaId: 'coder',
    title: 'Browser thread',
    repoIds: [repoId],
    activeRepoId: repoId,
  };
  const session = {
    id: 'session-1',
    workspaceId,
    appThreadId: thread.id,
    repoId,
    personaId: 'coder',
    provider: 'codex' as const,
    status: 'ready' as const,
    startedAt: '2026-01-01T00:00:00.000Z',
    origin: 'browser' as const,
  };

  beforeEach(() => {
    mocks.getChatThread.mockReturnValue(thread);
    mocks.getCodexSession.mockReturnValue(session);
    mocks.createChatThread.mockReturnValue(thread);
    mocks.startSession.mockResolvedValue(session);
  });

  it('persists a browser user message before sending it to the existing session', async () => {
    const result = await executeBrowserWorkspaceCommand(
      command({
        operation: 'chat.send',
        threadId: thread.id,
        sessionId: session.id,
        message: 'Inspect the repo',
      }),
      context(['submit-task']),
    );

    expect(result.ok).toBe(true);
    expect(mocks.saveChatEntry).toHaveBeenCalledWith(
      thread.id,
      repoId,
      session.id,
      expect.objectContaining({ role: 'user', content: 'Inspect the repo' }),
    );
    expect(mocks.sendMessage).toHaveBeenCalledWith(session.id, 'Inspect the repo');
  });

  it('starts a browser-owned session and records it in durable chat sessions', async () => {
    mocks.getCodexSession.mockReturnValue(null);
    mocks.listActiveCodexSessions.mockReturnValue([]);
    const result = await executeBrowserWorkspaceCommand(
      command({ operation: 'chat.session.start', threadId: thread.id }),
      context(['submit-task']),
    );

    expect(result.ok).toBe(true);
    expect(mocks.startSession).toHaveBeenCalledWith(
      [repoPath],
      [repoId],
      'coder',
      expect.objectContaining({ origin: 'browser', threadId: thread.id }),
    );
    expect(mocks.createChatSession).toHaveBeenCalledWith(
      thread.id,
      repoId,
      'coder',
      session.id,
      null,
      'codex',
    );
  });

  it('claims an existing session for main-process browser persistence', async () => {
    mocks.getCodexSession.mockReturnValue(session);
    mocks.listActiveCodexSessions.mockReturnValue([session] as never);
    mocks.claimSessionForBrowser.mockReturnValue({ ...session, origin: 'browser' });

    const result = await executeBrowserWorkspaceCommand(
      command({ operation: 'chat.session.start', threadId: thread.id }),
      context(['submit-task']),
    );

    expect(result).toMatchObject({ ok: true, data: { origin: 'browser' } });
    expect(mocks.claimSessionForBrowser).toHaveBeenCalledWith(session.id);
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('rejects browser session startup when Desktop is configured for full access', async () => {
    mocks.getCodexSession.mockReturnValue(null);
    mocks.getSettings.mockReturnValue({ codexMode: 'full-access' });
    const result = await executeBrowserWorkspaceCommand(
      command({ operation: 'chat.session.start', threadId: thread.id }),
      context(['submit-task']),
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('rejects sending through a full-access browser session', async () => {
    mocks.getSettings.mockReturnValue({ codexMode: 'full-access' });
    const result = await executeBrowserWorkspaceCommand(
      command({
        operation: 'chat.send',
        threadId: thread.id,
        sessionId: session.id,
        message: 'Do not elevate this turn',
      }),
      context(['submit-task']),
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('returns the newest history window and marks omitted older messages', async () => {
    mocks.loadChatHistory.mockReturnValue(
      Array.from({ length: 205 }, (_, index) => ({
        id: `message-${index}`,
        role: 'user' as const,
        content: `message ${index}`,
        timestamp: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`,
      })) as never,
    );
    const result = await executeBrowserWorkspaceCommand(
      command({ operation: 'chat.history.read', threadId: thread.id }),
      context(),
    );

    expect(result.ok).toBe(true);
    expect(resultData(result)).toMatchObject({ truncated: true });
    const messages = (resultData(result) as { messages: Array<{ id: string }> }).messages;
    expect(messages.length).toBe(200);
    expect(messages[0].id).toBe('message-5');
    expect(messages.at(-1)?.id).toBe('message-204');
    expect(resultData(result)).toMatchObject({
      omittedCount: 5,
      beforeMessageId: 'message-5',
    });
  });
});

describe('browser-owned Codex persistence', () => {
  it('persists assistant output in main and receives only one durable row per segment', () => {
    const eventListener = mocks.eventListener;
    expect(eventListener).toBeTypeOf('function');
    mocks.getCodexSession.mockReturnValue({
      id: 'session-1',
      workspaceId,
      appThreadId: 'thread-1',
      repoId,
      personaId: 'coder',
      origin: 'browser',
      status: 'busy',
    });

    eventListener?.({
      sessionId: 'session-1',
      appThreadId: 'thread-1',
      event: { type: 'text', text: 'hello', itemId: 'item-1', persistedBy: 'main' },
    });
    eventListener?.({
      sessionId: 'session-1',
      appThreadId: 'thread-1',
      event: { type: 'text', text: ' world', itemId: 'item-1', persistedBy: 'main' },
    });
    eventListener?.({
      sessionId: 'session-1',
      appThreadId: 'thread-1',
      event: { type: 'status', status: 'complete', persistedBy: 'main' },
    });

    const assistantWrites = mocks.saveChatEntry.mock.calls.filter(
      ([, , , entry]) => entry.role === 'assistant',
    );
    expect(assistantWrites).toHaveLength(1);
    expect(assistantWrites[0][3]).toMatchObject({ content: 'hello world' });
    expect(
      new Set(
        mocks.saveChatEntry.mock.calls
          .filter(([, , , entry]) => entry.event?.type === 'text')
          .map(([, , , entry]) => entry.id),
      ),
    ).toEqual(new Set(['browser:item-1']));
  });
});

describe('browser workspace terminal and preview dispatch', () => {
  it('routes terminal commands to the shared grant-bound tools service', async () => {
    mocks.toolsExecute.mockResolvedValueOnce({
      type: 'terminal.created',
      terminal: { terminalId: 'term-1' },
    });
    const result = await executeBrowserWorkspaceCommand(
      command({ operation: 'terminal.create', repositoryId: repoId }),
      context(['terminal']),
    );

    expect(result.ok).toBe(true);
    expect(resultData(result)).toMatchObject({
      type: 'terminal.created',
      terminal: { terminalId: 'term-1' },
    });
    expect(mocks.toolsExecute).toHaveBeenCalledWith({
      type: 'terminal.create',
      repoId,
      context: {
        grantId: 'grant-1',
        workspaceId,
        repoIds: [repoId],
        scopes: ['terminal'],
        expiresAt: expect.any(Number),
      },
    });
  });

  it('forwards terminal.read/write/resize/close fields intact', async () => {
    mocks.toolsExecute.mockResolvedValue({ type: 'terminal.read', terminal: {} });
    await executeBrowserWorkspaceCommand(
      command({
        operation: 'terminal.read',
        repositoryId: repoId,
        terminalId: 'term-1',
        afterSequence: 12,
      }),
      context(['terminal']),
    );
    await executeBrowserWorkspaceCommand(
      command({
        operation: 'terminal.write',
        repositoryId: repoId,
        terminalId: 'term-1',
        data: 'ls\r',
      }),
      context(['terminal']),
    );
    await executeBrowserWorkspaceCommand(
      command({
        operation: 'terminal.resize',
        repositoryId: repoId,
        terminalId: 'term-1',
        cols: 80,
        rows: 24,
      }),
      context(['terminal']),
    );
    await executeBrowserWorkspaceCommand(
      command({ operation: 'terminal.close', repositoryId: repoId, terminalId: 'term-1' }),
      context(['terminal']),
    );

    expect(mocks.toolsExecute.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ type: 'terminal.read', terminalId: 'term-1', afterSequence: 12 }),
      expect.objectContaining({ type: 'terminal.write', terminalId: 'term-1', data: 'ls\r' }),
      expect.objectContaining({
        type: 'terminal.resize',
        terminalId: 'term-1',
        cols: 80,
        rows: 24,
      }),
      expect.objectContaining({ type: 'terminal.close', terminalId: 'term-1' }),
    ]);
  });

  it('routes preview.screenshot through the shared tools service', async () => {
    mocks.toolsExecute.mockResolvedValueOnce({
      type: 'preview.screenshot.result',
      status: 'unavailable',
      reason: 'repo-dev-server-not-found',
    });
    const result = await executeBrowserWorkspaceCommand(
      command({ operation: 'preview.screenshot', repositoryId: repoId, refresh: true }),
      context(['preview']),
    );

    expect(result.ok).toBe(true);
    expect(mocks.toolsExecute).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'preview.screenshot', repoId, refresh: true }),
    );
  });

  it('rejects terminal and preview commands without their dedicated scopes', async () => {
    const terminal = await executeBrowserWorkspaceCommand(
      command({ operation: 'terminal.create', repositoryId: repoId }),
      context(['workspace-read']),
    );
    const preview = await executeBrowserWorkspaceCommand(
      command({ operation: 'preview.screenshot', repositoryId: repoId }),
      context(['workspace-read', 'workspace-write']),
    );

    for (const result of [terminal, preview]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('forbidden');
    }
    expect(mocks.toolsExecute).not.toHaveBeenCalled();
  });

  it('maps tools failures into bounded command failures', async () => {
    mocks.toolsExecute.mockRejectedValueOnce(new Error('Terminal is not owned by this grant'));
    const result = await executeBrowserWorkspaceCommand(
      command({ operation: 'terminal.read', repositoryId: repoId, terminalId: 'term-1' }),
      context(['terminal']),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-command');
      expect(result.error.message).toContain('not owned');
    }
  });
});
