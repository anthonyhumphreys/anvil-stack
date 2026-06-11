import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../db/schema.js';

const inMemoryDb = new Database(':memory:');
inMemoryDb.pragma('foreign_keys = ON');
inMemoryDb.exec(SCHEMA_SQL);
inMemoryDb.exec('INSERT OR IGNORE INTO settings (id) VALUES (1)');

vi.mock('../../db/database.js', () => ({
  getDb: () => inMemoryDb,
}));

import { deleteWorkspace } from '../workspace.service.js';

function seedWorkspace(id: string): void {
  inMemoryDb
    .prepare(
      `INSERT INTO workspaces (id, name, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))`,
    )
    .run(id, id);
}

beforeEach(() => {
  inMemoryDb.exec('DELETE FROM chat_messages');
  inMemoryDb.exec('DELETE FROM chat_sessions');
  inMemoryDb.exec('DELETE FROM chat_threads');
  inMemoryDb.exec('DELETE FROM workspaces');
  inMemoryDb.exec('UPDATE settings SET active_workspace_id = NULL WHERE id = 1');
});

describe('workspace deletion', () => {
  it('deletes workspace chat threads with their sessions and messages', () => {
    seedWorkspace('ws-delete');
    seedWorkspace('ws-keep');

    inMemoryDb.prepare('UPDATE settings SET active_workspace_id = ? WHERE id = 1').run('ws-delete');
    inMemoryDb
      .prepare(
        `INSERT INTO chat_threads (id, workspace_id, persona_id, title)
         VALUES (?, ?, ?, ?)`,
      )
      .run('thread-delete', 'ws-delete', 'coder', 'Thread to delete');
    inMemoryDb
      .prepare(
        `INSERT INTO chat_threads (id, workspace_id, persona_id, title)
         VALUES (?, ?, ?, ?)`,
      )
      .run('thread-keep', 'ws-keep', 'coder', 'Thread to keep');
    inMemoryDb
      .prepare(
        `INSERT INTO chat_sessions (id, thread_id, persona_id)
         VALUES (?, ?, ?)`,
      )
      .run('session-delete', 'thread-delete', 'coder');
    inMemoryDb
      .prepare(
        `INSERT INTO chat_messages (id, thread_id, session_id, role, content)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('message-delete', 'thread-delete', 'session-delete', 'user', 'Delete me');
    inMemoryDb
      .prepare(
        `INSERT INTO chat_messages (id, thread_id, role, content)
         VALUES (?, ?, ?, ?)`,
      )
      .run('message-keep', 'thread-keep', 'user', 'Keep me');

    expect(() => deleteWorkspace('ws-delete')).not.toThrow();

    expect(
      inMemoryDb.prepare('SELECT COUNT(*) AS count FROM workspaces WHERE id = ?').get('ws-delete'),
    ).toEqual({
      count: 0,
    });
    expect(
      inMemoryDb
        .prepare('SELECT COUNT(*) AS count FROM chat_threads WHERE id = ?')
        .get('thread-delete'),
    ).toEqual({ count: 0 });
    expect(
      inMemoryDb
        .prepare('SELECT COUNT(*) AS count FROM chat_sessions WHERE id = ?')
        .get('session-delete'),
    ).toEqual({ count: 0 });
    expect(
      inMemoryDb
        .prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE id = ?')
        .get('message-delete'),
    ).toEqual({ count: 0 });
    expect(
      inMemoryDb.prepare('SELECT active_workspace_id FROM settings WHERE id = 1').get(),
    ).toEqual({
      active_workspace_id: null,
    });
    expect(
      inMemoryDb
        .prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE id = ?')
        .get('message-keep'),
    ).toEqual({
      count: 1,
    });
  });
});
