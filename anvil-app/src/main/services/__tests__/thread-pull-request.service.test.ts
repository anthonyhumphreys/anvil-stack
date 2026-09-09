import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, SCHEMA_SQL } from '../../db/schema.js';
import type { CodeReviewPullRequest } from '../../../shared/types.js';

const mocks = vi.hoisted(() => ({ metadata: vi.fn() }));
vi.mock('../code-review-pr.service.js', () => ({ getPullRequestMetadata: mocks.metadata }));
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
import {
  createChatThread,
  deleteChatThread,
  getChatThread,
  updateChatThread,
} from '../chat-persistence.service.js';
import {
  createThreadWithPullRequest,
  linkThreadPullRequest,
  listPullRequestThreads,
  listThreadPullRequestLinks,
  refreshThreadPullRequest,
  unlinkThreadPullRequest,
} from '../thread-pull-request.service.js';

const root = mkdtempSync(join(tmpdir(), 'anvil-thread-pr-'));
const path = join(root, 'links.sqlite');
let db = new Database(path);
db.exec(SCHEMA_SQL);
db.pragma('foreign_keys = ON');
afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const input = { repoId: 'repo', provider: 'github' as const, pullRequestId: '7' };
const pullRequest: CodeReviewPullRequest = {
  id: '7',
  provider: 'github',
  title: 'Authoritative PR title',
  url: 'https://github.com/acme/repo/pull/7',
  sourceCommitSha: 'head-a',
  sourceBranch: 'feature/seven',
  targetBranch: 'main',
  state: 'open',
  isDraft: false,
  updatedAt: '2026-09-09T00:00:00Z',
};
beforeEach(() => {
  db.exec('DELETE FROM chat_threads; DELETE FROM workspaces; DELETE FROM repos;');
  db.prepare(
    "INSERT INTO workspaces(id,name,created_at,updated_at) VALUES ('ws','Workspace','now','now'),('other','Other','now','now')",
  ).run();
  db.prepare(
    "INSERT INTO repos(id,name,path,remote_url) VALUES ('repo','Repo','/repo','https://github.com/acme/repo.git'),('other-repo','Other repo','/other-repo','https://github.com/acme/other.git')",
  ).run();
  db.prepare(
    "INSERT INTO workspace_repos(workspace_id,repo_id,added_at) VALUES ('ws','repo','now'),('other','other-repo','now')",
  ).run();
  mocks.metadata.mockReset().mockResolvedValue(pullRequest);
});
function thread() {
  return createChatThread({
    workspaceId: 'ws',
    personaId: 'coder',
    title: 'Exact thread',
    repoIds: ['repo'],
  });
}
describe('durable thread pull request associations', () => {
  it('keeps an authoritative association across reopen with reverse lookup and fresh thread title', async () => {
    const original = thread();
    const link = await linkThreadPullRequest(original.id, input);
    expect(mocks.metadata).toHaveBeenCalledWith('https://github.com/acme/repo.git', '7');
    expect(link.pullRequest).toEqual(pullRequest);
    db.close();
    db = new Database(path);
    db.pragma('foreign_keys = ON');
    expect(getChatThread(original.id)?.pullRequestLinks).toEqual([link]);
    expect(listPullRequestThreads('repo', 'github', '7')[0].threadId).toBe(original.id);
    updateChatThread(original.id, { title: 'Renamed thread' });
    expect(listThreadPullRequestLinks(original.id)[0].threadTitle).toBe('Renamed thread');
    expect(listPullRequestThreads('other-repo', 'github', '7')).toEqual([]);
    expect(listPullRequestThreads('repo', 'ado', '7')).toEqual([]);
  });
  it('refreshes an existing link without duplication and preserves it when the provider is offline', async () => {
    const original = thread();
    const first = await linkThreadPullRequest(original.id, input);
    mocks.metadata.mockResolvedValue({
      ...pullRequest,
      title: 'Updated title',
      state: 'merged',
      sourceCommitSha: 'head-b',
    });
    const updated = await refreshThreadPullRequest(original.id, first.id);
    expect(updated.id).toBe(first.id);
    expect(updated.linkedAt).toBe(first.linkedAt);
    expect(updated.pullRequest.state).toBe('merged');
    expect(updated.pullRequest.sourceCommitSha).toBe('head-b');
    expect(listThreadPullRequestLinks(original.id)).toHaveLength(1);
    mocks.metadata.mockRejectedValue(new Error('Provider offline'));
    await expect(refreshThreadPullRequest(original.id, first.id)).rejects.toThrow(
      'Provider offline',
    );
    expect(listThreadPullRequestLinks(original.id)).toEqual([updated]);
  });
  it('rejects wrong provider identity, thread membership and workspace membership', async () => {
    const original = thread();
    await expect(linkThreadPullRequest(original.id, { ...input, provider: 'ado' })).rejects.toThrow(
      'identity does not match',
    );
    await expect(
      linkThreadPullRequest(original.id, { ...input, repoId: 'other-repo' }),
    ).rejects.toThrow('belong');
    const mismatched = createChatThread({
      workspaceId: 'other',
      personaId: 'coder',
      repoIds: ['repo'],
    });
    await expect(linkThreadPullRequest(mismatched.id, input)).rejects.toThrow('linked workspace');
    await expect(
      linkThreadPullRequest(original.id, { ...input, pullRequestId: '7;bad' }),
    ).rejects.toThrow('numeric');
    expect(listThreadPullRequestLinks(original.id)).toEqual([]);
  });
  it('does not revive a link unlinked while provider refresh is pending', async () => {
    const original = thread();
    const link = await linkThreadPullRequest(original.id, input);
    mocks.metadata.mockImplementation(async () => {
      unlinkThreadPullRequest(original.id, link.id);
      return pullRequest;
    });
    await expect(refreshThreadPullRequest(original.id, link.id)).rejects.toThrow(
      'unlinked while refreshing',
    );
    expect(listThreadPullRequestLinks(original.id)).toEqual([]);
  });
  it('rechecks membership and remote after provider lookup', async () => {
    const original = thread();
    mocks.metadata.mockImplementation(async () => {
      updateChatThread(original.id, { repoIds: [] });
      return pullRequest;
    });
    await expect(linkThreadPullRequest(original.id, input)).rejects.toThrow('belong');
    updateChatThread(original.id, { repoIds: ['repo'] });
    mocks.metadata.mockImplementation(async () => {
      db.prepare(
        "UPDATE repos SET remote_url = 'https://github.com/acme/other.git' WHERE id = 'repo'",
      ).run();
      return pullRequest;
    });
    await expect(linkThreadPullRequest(original.id, input)).rejects.toThrow('remote changed');
    expect(listThreadPullRequestLinks(original.id)).toEqual([]);
  });
  it('marks a saved link unavailable and excludes reverse backlinks after the repository remote changes', async () => {
    const original = thread();
    const link = await linkThreadPullRequest(original.id, input);
    db.prepare(
      "UPDATE repos SET remote_url = 'https://github.com/acme/replacement.git' WHERE id = 'repo'",
    ).run();
    expect(listThreadPullRequestLinks(original.id)[0].availability).toBe('repository_changed');
    expect(listPullRequestThreads('repo', 'github', '7')).toEqual([]);
    await expect(refreshThreadPullRequest(original.id, link.id)).rejects.toThrow('remote changed');
    unlinkThreadPullRequest(original.id, link.id);
    expect(listThreadPullRequestLinks(original.id)).toEqual([]);
  });
  it('rechecks the exact thread workspace after refresh and does not reassign the saved link', async () => {
    const original = thread();
    const link = await linkThreadPullRequest(original.id, input);
    db.prepare(
      "INSERT INTO workspace_repos(workspace_id, repo_id, added_at) VALUES ('other', 'repo', 'now')",
    ).run();
    mocks.metadata.mockImplementation(async () => {
      db.prepare("UPDATE chat_threads SET workspace_id = 'other' WHERE id = ?").run(original.id);
      return { ...pullRequest, sourceCommitSha: 'unaccepted-refresh-head' };
    });
    await expect(refreshThreadPullRequest(original.id, link.id)).rejects.toThrow(
      'workspace changed',
    );
    const saved = listThreadPullRequestLinks(original.id)[0];
    expect(saved.workspaceId).toBe('other');
    expect(saved.availability).toBe('thread_changed');
    expect(saved.pullRequest.sourceCommitSha).toBe('head-a');
    expect(listPullRequestThreads('repo', 'github', '7')).toEqual([]);
  });
  it('creates thread and link atomically, leaving no partial thread when lookup or insertion fails', async () => {
    const create = {
      workspaceId: 'ws',
      personaId: 'coder',
      title: 'Linked draft',
      repoIds: ['repo'],
      pullRequest: input,
    };
    mocks.metadata.mockRejectedValueOnce(new Error('Lookup failed'));
    await expect(createThreadWithPullRequest(create)).rejects.toThrow('Lookup failed');
    expect(db.prepare('SELECT count(*) AS count FROM chat_threads').get()).toEqual({ count: 0 });
    db.exec(
      "CREATE TRIGGER reject_link BEFORE INSERT ON chat_thread_pull_requests BEGIN SELECT RAISE(ABORT, 'link rejected'); END;",
    );
    await expect(createThreadWithPullRequest(create)).rejects.toThrow('link rejected');
    expect(db.prepare('SELECT count(*) AS count FROM chat_threads').get()).toEqual({ count: 0 });
    db.exec('DROP TRIGGER reject_link');
    const linked = await createThreadWithPullRequest(create);
    expect(linked.pullRequestLinks?.[0].threadId).toBe(linked.id);
    expect(getChatThread(linked.id)?.pullRequestLinks).toHaveLength(1);
  });
  it('does not copy links to a fork-like new thread and only unlinks the requested thread', async () => {
    const original = thread();
    const link = await linkThreadPullRequest(original.id, input);
    const fork = createChatThread({
      workspaceId: 'ws',
      personaId: 'coder',
      title: 'Fork',
      repoIds: original.repoIds,
    });
    expect(fork.pullRequestLinks).toEqual([]);
    unlinkThreadPullRequest(fork.id, link.id);
    expect(listThreadPullRequestLinks(original.id)).toHaveLength(1);
    unlinkThreadPullRequest(original.id, link.id);
    expect(listThreadPullRequestLinks(original.id)).toEqual([]);
    await linkThreadPullRequest(original.id, input);
    deleteChatThread(original.id);
    expect(listPullRequestThreads('repo', 'github', '7')).toEqual([]);
  });
  it('adds the association table to an existing v64 database without changing threads', () => {
    const prior = new Database(':memory:');
    try {
      prior.exec(
        "CREATE TABLE chat_threads(id TEXT PRIMARY KEY); CREATE TABLE workspaces(id TEXT PRIMARY KEY); CREATE TABLE repos(id TEXT PRIMARY KEY); INSERT INTO chat_threads(id) VALUES ('old-thread');",
      );
      prior.exec(MIGRATIONS[65]);
      expect(prior.prepare('SELECT id FROM chat_threads').all()).toEqual([{ id: 'old-thread' }]);
      expect(
        prior.prepare('SELECT count(*) AS count FROM chat_thread_pull_requests').get(),
      ).toEqual({ count: 0 });
    } finally {
      prior.close();
    }
  });
});
