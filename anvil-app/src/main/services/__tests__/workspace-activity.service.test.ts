import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../db/schema.js';

const inMemoryDb = new Database(':memory:');
inMemoryDb.exec(SCHEMA_SQL);

vi.mock('../../db/database.js', () => ({ getDb: () => inMemoryDb }));
vi.mock('../automation-persistence.service.js', () => ({
  listAutomationTriageItems: vi.fn(() => []),
}));

import { getWorkspaceActivityFeed } from '../workspace-activity.service.js';
import { createChatThread, updateChatThreadAttention } from '../chat-persistence.service.js';

function seedWorkspace(id: string, name: string): void {
  inMemoryDb
    .prepare(
      `INSERT INTO workspaces (id, name, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))`,
    )
    .run(id, name);
}

beforeEach(() => {
  inMemoryDb.exec('DELETE FROM chat_threads');
  inMemoryDb.exec('DELETE FROM workspace_scaffold_sessions');
  inMemoryDb.exec('DELETE FROM workspace_repos');
  inMemoryDb.exec('DELETE FROM workspaces');
});

describe('workspace activity feed', () => {
  it('returns nothing when no workspace has activity', () => {
    seedWorkspace('ws-1', 'Quiet');
    expect(getWorkspaceActivityFeed()).toEqual([]);
  });

  it('flags threads waiting on approval or input in other workspaces', () => {
    seedWorkspace('ws-1', 'Backend');
    seedWorkspace('ws-2', 'Frontend');
    const waiting = createChatThread({ workspaceId: 'ws-1', personaId: 'coder' });
    updateChatThreadAttention(waiting.id, 'approval');
    const idle = createChatThread({ workspaceId: 'ws-2', personaId: 'coder' });

    const feed = getWorkspaceActivityFeed();
    expect(feed).toHaveLength(1);
    expect(feed[0].workspaceId).toBe('ws-1');
    expect(feed[0].workspaceName).toBe('Backend');
    expect(feed[0].status).toBe('warning');
    expect(feed[0].items[0].id).toBe(`thread-${waiting.id}`);
    expect(feed[0].items[0].detail).toContain('Approval needed');
    expect(idle.id).toBeTruthy();
  });

  it('marks working threads as running and failed turns as errors', () => {
    seedWorkspace('ws-1', 'Mixed');
    const working = createChatThread({ workspaceId: 'ws-1', personaId: 'coder' });
    const failed = createChatThread({ workspaceId: 'ws-1', personaId: 'coder' });
    updateChatThreadAttention(working.id, 'working');
    updateChatThreadAttention(failed.id, 'failed');

    const feed = getWorkspaceActivityFeed();
    expect(feed).toHaveLength(1);
    expect(feed[0].status).toBe('error');
    expect(feed[0].count).toBe(2);
    const statuses = new Map(feed[0].items.map((item) => [item.id, item.status]));
    expect(statuses.get(`thread-${failed.id}`)).toBe('error');
    expect(statuses.get(`thread-${working.id}`)).toBe('running');
  });

  it('hides seen completions and settled threads', () => {
    seedWorkspace('ws-1', 'Done');
    const settled = createChatThread({ workspaceId: 'ws-1', personaId: 'coder' });
    updateChatThreadAttention(settled.id, 'complete');
    inMemoryDb
      .prepare("UPDATE chat_threads SET settled_at = datetime('now') WHERE id = ?")
      .run(settled.id);

    const seen = createChatThread({ workspaceId: 'ws-1', personaId: 'coder' });
    updateChatThreadAttention(seen.id, 'complete');
    inMemoryDb
      .prepare('UPDATE chat_threads SET last_viewed_at = ? WHERE id = ?')
      .run(new Date(Date.now() + 60 * 60 * 1000).toISOString(), seen.id);

    expect(getWorkspaceActivityFeed()).toEqual([]);
  });

  it('surfaces unseen completions as ready to review', () => {
    seedWorkspace('ws-1', 'Ready');
    const thread = createChatThread({ workspaceId: 'ws-1', personaId: 'coder' });
    updateChatThreadAttention(thread.id, 'complete');

    const feed = getWorkspaceActivityFeed();
    expect(feed[0].status).toBe('ready');
    expect(feed[0].items[0].detail).toContain('ready to review');
  });

  it('aggregates errored repositories per workspace', () => {
    seedWorkspace('ws-1', 'Repos');
    inMemoryDb
      .prepare(
        `INSERT INTO repos (id, name, path, remote_url, default_branch, status, file_count, branch_count, created_at, updated_at)
         VALUES ('repo-err', 'broken-repo', '/tmp/broken', NULL, 'main', 'error', 0, 0, datetime('now'), datetime('now'))`,
      )
      .run();
    inMemoryDb
      .prepare(
        `INSERT INTO workspace_repos (workspace_id, repo_id, added_at) VALUES ('ws-1', 'repo-err', datetime('now'))`,
      )
      .run();

    const feed = getWorkspaceActivityFeed();
    expect(feed[0].status).toBe('error');
    expect(feed[0].items[0].title).toBe('1 repo needs attention');
  });
});
