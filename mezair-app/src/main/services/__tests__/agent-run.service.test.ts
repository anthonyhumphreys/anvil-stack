import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../db/schema.js';

const inMemoryDb = new Database(':memory:');
inMemoryDb.exec(SCHEMA_SQL);

vi.mock('../../db/database.js', () => ({
  getDb: () => inMemoryDb,
}));

import { listAgentRuns } from '../agent-run.service.js';
import { saveChatEvent } from '../chat-evidence.service.js';
import { createChatSession, createChatThread, saveChatEntry } from '../chat-persistence.service.js';

beforeEach(() => {
  inMemoryDb.exec('DELETE FROM chat_messages');
  inMemoryDb.exec('DELETE FROM chat_sessions');
  inMemoryDb.exec('DELETE FROM chat_threads');
  inMemoryDb.exec('DELETE FROM workspace_repos');
  inMemoryDb.exec('DELETE FROM workspaces');
  inMemoryDb.exec('DELETE FROM automation_runs');
  inMemoryDb.exec('DELETE FROM automation_definitions');

  inMemoryDb
    .prepare(
      `INSERT INTO workspaces (id, name, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))`,
    )
    .run('ws-1', 'Workspace');
});

describe('listAgentRuns chat run evidence', () => {
  it('counts ACP-style file_edit events toward changedFileCount', () => {
    const thread = createChatThread({
      workspaceId: 'ws-1',
      personaId: 'coder',
      title: 'Cursor edit run',
    });
    const sessionId = createChatSession(thread.id, null, 'coder', 'session-acp', 'acp-1', 'cursor');

    saveChatEntry(thread.id, null, sessionId, {
      id: 'm-1',
      role: 'user',
      content: 'Rename the helper',
      timestamp: '2026-09-23T10:00:00.000Z',
      personaId: 'coder',
      threadId: thread.id,
    });
    // ACP diff blocks arrive without a pre-rendered unified diff.
    saveChatEvent(
      thread.id,
      null,
      sessionId,
      { type: 'file_edit', itemId: 'tool-1', filePath: 'src/a.ts', diff: '' },
      '2026-09-23T10:00:05.000Z',
    );
    saveChatEvent(
      thread.id,
      null,
      sessionId,
      {
        type: 'file_edit',
        itemId: 'tool-1',
        filePath: 'src/b.ts',
        diff: '--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1,1 +1,1 @@\n-old\n+new',
      },
      '2026-09-23T10:00:06.000Z',
    );
    // A repeated snapshot of the same file must not inflate the count.
    saveChatEvent(
      thread.id,
      null,
      sessionId,
      { type: 'file_edit', itemId: 'tool-1', filePath: 'src/b.ts', diff: 'same path again' },
      '2026-09-23T10:00:07.000Z',
    );
    saveChatEntry(thread.id, null, sessionId, {
      id: 'm-2',
      role: 'assistant',
      content: 'Done.',
      timestamp: '2026-09-23T10:00:10.000Z',
      personaId: 'coder',
      threadId: thread.id,
    });

    const runs = listAgentRuns('ws-1');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      source: 'chat',
      threadId: thread.id,
      changedFileCount: 2,
      evidenceCount: 3,
    });
  });
});
