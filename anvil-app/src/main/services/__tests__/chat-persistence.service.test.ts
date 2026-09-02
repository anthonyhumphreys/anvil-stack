import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_SQL } from '../../db/schema.js';

const inMemoryDb = new Database(':memory:');
inMemoryDb.exec(SCHEMA_SQL);

vi.mock('../../db/database.js', () => ({
  getDb: () => inMemoryDb,
}));

import {
  clearChatHistory,
  createChatSession,
  createChatThread,
  deleteChatThread,
  ensureWorkItemChatThread,
  findChatAttachment,
  getChatThread,
  getChatThreadProviderBinding,
  listChatThreads,
  listWorkItemChatThreads,
  loadChatHistory,
  saveChatEntry,
  saveChatThreadGoal,
  saveChatThreadPlan,
  updateChatThread,
  updateChatThreadAttention,
} from '../chat-persistence.service.js';
import { listChatTurnSummaries, saveChatEvent } from '../chat-evidence.service.js';
import {
  listChatArtifacts,
  readChatArtifactFile,
  upsertChatArtifact,
} from '../chat-artifact.service.js';

beforeEach(() => {
  inMemoryDb.exec('DELETE FROM chat_artifacts');
  inMemoryDb.exec('DELETE FROM chat_messages');
  inMemoryDb.exec('DELETE FROM chat_sessions');
  inMemoryDb.exec('DELETE FROM chat_threads');
  inMemoryDb.exec('DELETE FROM workspace_preferences');
  inMemoryDb.exec('DELETE FROM workspace_repos');
  inMemoryDb.exec('DELETE FROM workspaces');
  inMemoryDb.exec('DELETE FROM repos');

  inMemoryDb
    .prepare(
      `INSERT INTO workspaces (id, name, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))`,
    )
    .run('ws-1', 'Workspace');

  inMemoryDb
    .prepare(
      `INSERT INTO repos (
         id,
         name,
         path,
         remote_url,
         default_branch,
         status,
         file_count,
         branch_count,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, NULL, 'main', 'indexed', 0, 1, datetime('now'), datetime('now'))`,
    )
    .run('repo-1', 'orders-service', mkdtempSync(join(tmpdir(), 'anvil-artifact-repo-')));
});

describe('chat thread persistence', () => {
  it('keeps the provider with its resumable thread id', () => {
    const thread = createChatThread({
      workspaceId: 'ws-1',
      personaId: 'coder',
      repoIds: ['repo-1'],
    });

    createChatSession(thread.id, 'repo-1', 'coder', 'session-1', 'cursor-thread-1', 'cursor');

    expect(getChatThreadProviderBinding(thread.id)).toEqual({
      providerThreadId: 'cursor-thread-1',
      provider: 'cursor',
    });
  });

  it('creates, lists, and updates chat threads for a persona within a workspace', () => {
    const thread = createChatThread({
      workspaceId: 'ws-1',
      personaId: 'ba',
      title: 'Impact review',
      repoIds: ['repo-1'],
      activeRepoId: 'repo-1',
    });

    expect(thread.title).toBe('Impact review');
    expect(thread.personaId).toBe('ba');
    expect(thread.repoIds).toEqual(['repo-1']);

    const listed = listChatThreads('ws-1', 'ba');
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(thread.id);

    const updated = updateChatThread(thread.id, {
      title: 'Renamed impact review',
      repoIds: [],
      activeRepoId: null,
    });

    expect(updated?.title).toBe('Renamed impact review');
    expect(updated?.repoIds).toEqual([]);
    expect(updated?.activeRepoId).toBeUndefined();
  });

  it('lists every classic thread when no persona filter is supplied', () => {
    const coderThread = createChatThread({ workspaceId: 'ws-1', personaId: 'coder' });
    const architectThread = createChatThread({ workspaceId: 'ws-1', personaId: 'architect' });
    createChatThread({ workspaceId: null, personaId: 'ba' });

    expect(new Set(listChatThreads('ws-1').map((thread) => thread.id))).toEqual(
      new Set([coderThread.id, architectThread.id]),
    );
  });

  it('tracks inbox attention and prevents active work from being settled', () => {
    const thread = createChatThread({ workspaceId: 'ws-1', personaId: 'coder' });

    expect(thread.attentionState).toBe('idle');
    const settled = updateChatThread(thread.id, { settled: true });
    expect(settled?.settledAt).toBeTruthy();

    const working = updateChatThreadAttention(thread.id, 'working');
    expect(working).toMatchObject({
      attentionState: 'working',
      settledAt: undefined,
    });
    expect(working?.activeTurnStartedAt).toBeTruthy();
    expect(() => updateChatThread(thread.id, { settled: true })).toThrow('cannot be settled yet');

    const complete = updateChatThreadAttention(thread.id, 'complete');
    expect(complete?.attentionState).toBe('complete');
    expect(complete?.activeTurnStartedAt).toBeUndefined();
    expect(updateChatThread(thread.id, { settled: true })?.settledAt).toBeTruthy();
    expect(updateChatThread(thread.id, { settled: false, viewed: true })).toMatchObject({
      settledAt: undefined,
    });
    expect(getChatThread(thread.id)?.lastViewedAt).toBeTruthy();
  });

  it('never returns threads owned by another workspace or the global scope', () => {
    inMemoryDb
      .prepare(
        `INSERT INTO workspaces (id, name, created_at, updated_at)
         VALUES (?, ?, datetime('now'), datetime('now'))`,
      )
      .run('ws-2', 'Other workspace');

    const workspaceThread = createChatThread({ workspaceId: 'ws-1', personaId: 'coder' });
    const otherWorkspaceThread = createChatThread({ workspaceId: 'ws-2', personaId: 'coder' });
    const globalThread = createChatThread({ workspaceId: null, personaId: 'coder' });

    expect(listChatThreads('ws-1', 'coder').map((thread) => thread.id)).toEqual([
      workspaceThread.id,
    ]);
    expect(listChatThreads('ws-2', 'coder').map((thread) => thread.id)).toEqual([
      otherWorkspaceThread.id,
    ]);
    expect(listChatThreads(null, 'coder').map((thread) => thread.id)).toEqual([globalThread.id]);
  });

  it('keeps work-item threads out of classic persona lists and reuses the ticket thread', () => {
    const first = ensureWorkItemChatThread({
      workspaceId: 'ws-1',
      personaId: 'coder',
      workItemId: 'ADO-123',
      workItemProvider: 'ado',
      workItemTitle: 'Add chat layout switch',
      repoIds: ['repo-1'],
      activeRepoId: 'repo-1',
    });

    expect(first.workItemId).toBe('ADO-123');
    expect(first.workItemProvider).toBe('ado');
    expect(first.title).toBe('ADO-123: Add chat layout switch');
    expect(listChatThreads('ws-1', 'coder')).toEqual([]);
    expect(listWorkItemChatThreads('ws-1').map((thread) => thread.id)).toEqual([first.id]);

    const second = ensureWorkItemChatThread({
      workspaceId: 'ws-1',
      personaId: 'ba',
      workItemId: 'ADO-123',
      workItemProvider: 'ado',
      workItemTitle: 'Add chat layout toggle',
      repoIds: [],
      activeRepoId: null,
    });

    expect(second.id).toBe(first.id);
    expect(second.personaId).toBe('coder');
    expect(second.title).toBe('ADO-123: Add chat layout toggle');
    expect(second.workItemTitle).toBe('Add chat layout toggle');
    expect(second.repoIds).toEqual([]);
  });

  it('persists multiple threads for the same work item', () => {
    const first = createChatThread({
      workspaceId: 'ws-1',
      personaId: 'coder',
      title: 'Plan the ticket',
      workItemId: 'ADO-456',
      workItemProvider: 'ado',
      workItemTitle: 'Own several threads',
    });
    const second = createChatThread({
      workspaceId: 'ws-1',
      personaId: 'coder',
      title: 'Implement the ticket',
      workItemId: 'ADO-456',
      workItemProvider: 'ado',
      workItemTitle: 'Own several threads',
    });

    expect(new Set(listWorkItemChatThreads('ws-1').map((thread) => thread.id))).toEqual(
      new Set([first.id, second.id]),
    );
  });

  it('saves thread-scoped history and updates preview metadata', () => {
    const thread = createChatThread({
      workspaceId: 'ws-1',
      personaId: 'coder',
      title: 'Checkout flow',
      repoIds: ['repo-1'],
      activeRepoId: 'repo-1',
    });
    const sessionId = createChatSession(thread.id, 'repo-1', 'coder');

    saveChatEntry(thread.id, 'repo-1', sessionId, {
      id: 'm-1',
      role: 'user',
      content: 'Add promo code support',
      timestamp: '2026-04-27T10:00:00.000Z',
      personaId: 'coder',
      threadId: thread.id,
      attachments: [
        {
          id: 'att-1',
          name: 'checkout-flow.png',
          mimeType: 'image/png',
          size: 2048,
          kind: 'image',
          path: '/tmp/checkout-flow.png',
          createdAt: '2026-04-27T09:59:59.000Z',
        },
      ],
    });
    saveChatEntry(thread.id, 'repo-1', sessionId, {
      id: 'm-2',
      role: 'assistant',
      content: 'We need to update checkout validation and totals.',
      timestamp: '2026-04-27T10:01:00.000Z',
      personaId: 'coder',
      threadId: thread.id,
    });

    const history = loadChatHistory(thread.id);
    expect(history.map((message) => message.id)).toEqual(['m-1', 'm-2']);
    expect(history[0].attachments).toEqual([
      {
        id: 'att-1',
        name: 'checkout-flow.png',
        mimeType: 'image/png',
        size: 2048,
        kind: 'image',
        path: '/tmp/checkout-flow.png',
        createdAt: '2026-04-27T09:59:59.000Z',
      },
    ]);
    expect(history[1].sessionId).toBe(sessionId);
    expect(findChatAttachment('att-1')).toEqual(history[0].attachments?.[0]);
    expect(findChatAttachment('missing')).toBeNull();

    const refreshed = getChatThread(thread.id);
    expect(refreshed?.messageCount).toBe(2);
    expect(refreshed?.preview).toBe('We need to update checkout validation and totals.');
    expect(refreshed?.lastMessageAt).toBe('2026-04-27T10:01:00.000Z');
  });

  it('does not move conversation recency backwards when an older segment is persisted late', () => {
    const thread = createChatThread({
      workspaceId: 'ws-1',
      personaId: 'coder',
      title: 'Stable recency',
    });

    saveChatEntry(thread.id, null, null, {
      id: 'new-user-message',
      role: 'user',
      content: 'This is the newest activity.',
      timestamp: '2026-04-27T12:00:00.000Z',
    });
    saveChatEntry(thread.id, null, null, {
      id: 'late-progress-segment',
      role: 'system',
      content: 'This progress segment was flushed late.',
      timestamp: '2026-04-27T11:00:00.000Z',
      event: {
        type: 'text',
        text: 'This progress segment was flushed late.',
        assistantPhase: 'progress',
      },
    });
    saveChatEntry(thread.id, null, null, {
      id: 'late-final-segment',
      role: 'assistant',
      content: 'This final segment was also flushed late.',
      timestamp: '2026-04-27T11:30:00.000Z',
      event: {
        type: 'text',
        text: 'This final segment was also flushed late.',
        assistantPhase: 'final',
      },
    });

    expect(getChatThread(thread.id)?.lastMessageAt).toBe('2026-04-27T12:00:00.000Z');
  });

  it('uses deterministic ordering when thread activity timestamps match', () => {
    const first = createChatThread({ workspaceId: 'ws-1', personaId: 'coder' });
    const second = createChatThread({ workspaceId: 'ws-1', personaId: 'coder' });
    const timestamp = '2026-04-27T12:00:00.000Z';

    inMemoryDb
      .prepare(
        `UPDATE chat_threads
         SET created_at = ?, updated_at = ?, last_message_at = ?
         WHERE id IN (?, ?)`,
      )
      .run(timestamp, timestamp, timestamp, first.id, second.id);

    expect(listChatThreads('ws-1', 'coder').map((thread) => thread.id)).toEqual(
      [first.id, second.id].sort((left, right) => right.localeCompare(left)),
    );
  });

  it('builds turn evidence from persisted Codex events without inflating message count', () => {
    const thread = createChatThread({
      workspaceId: 'ws-1',
      personaId: 'coder',
      title: 'Evidence pass',
      repoIds: ['repo-1'],
      activeRepoId: 'repo-1',
    });
    const sessionId = createChatSession(thread.id, 'repo-1', 'coder');

    saveChatEntry(thread.id, 'repo-1', sessionId, {
      id: 'm-1',
      role: 'user',
      content: 'Fix the failing test',
      timestamp: '2026-04-27T10:00:00.000Z',
      personaId: 'coder',
      threadId: thread.id,
    });
    saveChatEvent(
      thread.id,
      'repo-1',
      sessionId,
      { type: 'file_edit', filePath: 'src/app.ts', diff: '--- a\n+++ b' },
      '2026-04-27T10:00:10.000Z',
    );
    saveChatEvent(
      thread.id,
      'repo-1',
      sessionId,
      { type: 'command_exec', command: 'pnpm test', output: 'failed', exitCode: 1 },
      '2026-04-27T10:00:20.000Z',
    );
    saveChatEntry(thread.id, 'repo-1', sessionId, {
      id: 'm-2',
      role: 'assistant',
      content: 'The test still fails.',
      timestamp: '2026-04-27T10:01:00.000Z',
      personaId: 'coder',
      threadId: thread.id,
    });

    const history = loadChatHistory(thread.id);
    expect(
      history.filter((message) => message.role === 'system').map((message) => message.event),
    ).toEqual([
      { type: 'file_edit', filePath: 'src/app.ts', diff: '--- a\n+++ b' },
      { type: 'command_exec', command: 'pnpm test', output: 'failed', exitCode: 1 },
    ]);

    const summaries = listChatTurnSummaries(thread.id);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].changedFiles).toEqual(['src/app.ts']);
    expect(summaries[0].tests[0]).toMatchObject({
      command: 'pnpm test',
      failed: true,
      exitCode: 1,
    });

    const refreshed = getChatThread(thread.id);
    expect(refreshed?.messageCount).toBe(2);
  });

  it('coalesces command progress into one persisted activity card', () => {
    const thread = createChatThread({ workspaceId: 'ws-1', personaId: 'coder' });
    const sessionId = createChatSession(thread.id, 'repo-1', 'coder');

    saveChatEvent(
      thread.id,
      'repo-1',
      sessionId,
      { type: 'command_exec', command: 'pnpm test', output: '' },
      '2026-04-27T10:00:00.000Z',
    );
    saveChatEvent(
      thread.id,
      'repo-1',
      sessionId,
      { type: 'command_exec', output: 'running\n' },
      '2026-04-27T10:00:01.000Z',
    );
    saveChatEvent(
      thread.id,
      'repo-1',
      sessionId,
      { type: 'command_exec', command: 'pnpm test', output: 'passed\n', exitCode: 0 },
      '2026-04-27T10:00:02.000Z',
    );

    expect(loadChatHistory(thread.id).map((message) => message.event)).toEqual([
      { type: 'command_exec', command: 'pnpm test', output: 'passed\n', exitCode: 0 },
    ]);
  });

  it('round-trips segmented assistant metadata alongside activity in chronological order', () => {
    const thread = createChatThread({
      workspaceId: 'ws-1',
      personaId: 'coder',
      title: 'Segmented output',
      repoIds: ['repo-1'],
      activeRepoId: 'repo-1',
    });
    const sessionId = createChatSession(thread.id, 'repo-1', 'coder');

    saveChatEntry(thread.id, 'repo-1', sessionId, {
      id: 'assistant-progress',
      role: 'system',
      content: 'I am checking the failing test.',
      timestamp: '2026-04-27T10:00:00.000Z',
      event: {
        type: 'text',
        text: 'I am checking the failing test.',
        itemId: 'provider-message-1',
        assistantPhase: 'progress',
      },
    });
    saveChatEvent(
      thread.id,
      'repo-1',
      sessionId,
      { type: 'command_exec', command: 'pnpm test', output: 'passed', exitCode: 0 },
      '2026-04-27T10:00:00.000Z',
    );
    saveChatEntry(thread.id, 'repo-1', sessionId, {
      id: 'assistant-progress',
      role: 'system',
      content: 'I checked the failing test.',
      timestamp: '2026-04-27T10:00:00.000Z',
      event: {
        type: 'text',
        text: 'I checked the failing test.',
        itemId: 'provider-message-1',
        assistantPhase: 'progress',
      },
    });
    saveChatEntry(thread.id, 'repo-1', sessionId, {
      id: 'assistant-final',
      role: 'assistant',
      content: 'The test now passes.',
      timestamp: '2026-04-27T10:00:00.000Z',
      event: {
        type: 'text',
        text: 'The test now passes.',
        itemId: 'provider-message-2',
        assistantPhase: 'final',
      },
    });

    const history = loadChatHistory(thread.id);
    expect(history.map((message) => message.id)).toEqual([
      'assistant-progress',
      expect.any(String),
      'assistant-final',
    ]);
    expect(history.map((message) => message.event)).toEqual([
      {
        type: 'text',
        text: 'I checked the failing test.',
        itemId: 'provider-message-1',
        assistantPhase: 'progress',
      },
      { type: 'command_exec', command: 'pnpm test', output: 'passed', exitCode: 0 },
      {
        type: 'text',
        text: 'The test now passes.',
        itemId: 'provider-message-2',
        assistantPhase: 'final',
      },
    ]);
  });

  it('clears history without deleting the thread and can delete the thread completely', () => {
    const thread = createChatThread({
      workspaceId: 'ws-1',
      personaId: 'reviewer',
      title: 'Accessibility checks',
    });

    saveChatEntry(thread.id, null, null, {
      id: 'm-1',
      role: 'user',
      content: 'Review the form flow',
      timestamp: '2026-04-27T10:02:00.000Z',
      personaId: 'reviewer',
      threadId: thread.id,
    });

    clearChatHistory(thread.id);

    expect(loadChatHistory(thread.id)).toEqual([]);
    expect(getChatThread(thread.id)?.messageCount).toBe(0);

    deleteChatThread(thread.id);

    expect(getChatThread(thread.id)).toBeNull();
    expect(listChatThreads('ws-1', 'reviewer')).toEqual([]);
  });

  it('persists the latest plan and goal on the thread', () => {
    const thread = createChatThread({
      workspaceId: 'ws-1',
      personaId: 'coder',
      title: 'Plan mode',
    });

    const withPlan = saveChatThreadPlan(thread.id, {
      explanation: 'Do the boring correct thing first.',
      updatedAt: '2026-05-11T10:00:00.000Z',
      steps: [
        { step: 'Parse plan events', status: 'completed' },
        { step: 'Render the drawer', status: 'in_progress' },
      ],
    });

    expect(withPlan?.activePlan).toEqual({
      explanation: 'Do the boring correct thing first.',
      updatedAt: '2026-05-11T10:00:00.000Z',
      steps: [
        { step: 'Parse plan events', status: 'completed' },
        { step: 'Render the drawer', status: 'in_progress' },
      ],
    });

    const withGoal = saveChatThreadGoal(thread.id, {
      objective: 'Support Codex goals',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 42,
      timeUsedSeconds: 3,
      createdAt: 100,
      updatedAt: 200,
    });

    expect(withGoal?.activeGoal).toEqual({
      objective: 'Support Codex goals',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 42,
      timeUsedSeconds: 3,
      createdAt: 100,
      updatedAt: 200,
    });

    expect(listChatThreads('ws-1', 'coder')[0].activePlan?.steps).toHaveLength(2);

    const clearedGoal = saveChatThreadGoal(thread.id, null);
    expect(clearedGoal?.activeGoal).toBeUndefined();
  });

  it('persists versioned thread artifacts and writes repo-backed files', () => {
    const thread = createChatThread({
      workspaceId: 'ws-1',
      personaId: 'coder',
      title: 'Canvas work',
      repoIds: ['repo-1'],
      activeRepoId: 'repo-1',
    });
    const repo = inMemoryDb.prepare('SELECT path FROM repos WHERE id = ?').get('repo-1') as {
      path: string;
    };

    const first = upsertChatArtifact({
      threadId: thread.id,
      repoId: 'repo-1',
      sourceMessageId: 'm-1',
      title: 'Review Pack',
      kind: 'markdown',
      relativePath: 'reviews/review-pack.md',
      content: '# Review\n\nShip it carefully.',
    });

    expect(first.version).toBe(1);
    expect(first.status).toBe('draft');
    expect(first.visibility).toBe('local');
    expect(first.source).toBe('assistant');
    expect(first.filePath).toBe(join(repo.path, '.anvil/artifacts/reviews/review-pack.md'));
    expect(readFileSync(first.filePath!, 'utf8')).toContain('Ship it carefully.');

    const second = upsertChatArtifact({
      threadId: thread.id,
      repoId: 'repo-1',
      sourceMessageId: 'm-2',
      title: 'Review Pack',
      kind: 'markdown',
      relativePath: 'reviews/review-pack.md',
      content: '# Review\n\nNow with fewer footguns.',
      status: 'reviewed',
      visibility: 'shareable',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
    });

    expect(second.id).toBe(first.id);
    expect(second.version).toBe(2);
    expect(second.status).toBe('reviewed');
    expect(second.visibility).toBe('shareable');
    expect(second.model).toBe('gpt-5.6-sol');
    expect(second.reasoningEffort).toBe('max');
    expect(readFileSync(second.filePath!, 'utf8')).toContain('fewer footguns');
    expect(listChatArtifacts(thread.id).map((artifact) => artifact.id)).toEqual([first.id]);

    const revisionCount = inMemoryDb
      .prepare('SELECT COUNT(*) AS count FROM chat_artifact_revisions WHERE artifact_id = ?')
      .get(first.id) as { count: number };
    expect(revisionCount.count).toBe(2);

    rmSync(repo.path, { recursive: true, force: true });
  });

  it('references and safely reads binary files already created in the artifact directory', () => {
    const thread = createChatThread({
      workspaceId: 'ws-1',
      personaId: 'coder',
      title: 'Presentation',
      repoIds: ['repo-1'],
      activeRepoId: 'repo-1',
    });
    const repo = inMemoryDb.prepare('SELECT path FROM repos WHERE id = ?').get('repo-1') as {
      path: string;
    };
    const target = join(repo.path, '.anvil/artifacts/decks/demo.pptx');
    mkdirSync(join(repo.path, '.anvil/artifacts/decks'), { recursive: true });
    writeFileSync(target, Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const artifact = upsertChatArtifact({
      threadId: thread.id,
      repoId: 'repo-1',
      title: 'Demo deck',
      kind: 'pptx',
      relativePath: 'decks/demo.pptx',
      content: 'Generated PowerPoint deck.',
      contentEncoding: 'file',
    });

    expect(readFileSync(target)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(readChatArtifactFile(artifact.id)).toMatchObject({
      name: 'demo.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      size: 4,
      dataBase64: 'UEsDBA==',
    });

    rmSync(repo.path, { recursive: true, force: true });
  });
});
