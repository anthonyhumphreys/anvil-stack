import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../db/schema.js';

const inMemoryDb = new Database(':memory:');
inMemoryDb.pragma('foreign_keys = ON');
inMemoryDb.exec(SCHEMA_SQL);
inMemoryDb.exec('INSERT OR IGNORE INTO settings (id) VALUES (1)');

const { mockCancelIndexJobs } = vi.hoisted(() => ({
  mockCancelIndexJobs: vi.fn(),
}));

vi.mock('../../db/database.js', () => ({
  getDb: () => inMemoryDb,
}));

vi.mock('../repo-index-queue.service.js', () => ({
  cancelIndexJobs: mockCancelIndexJobs,
}));

vi.mock('../settings.service.js', () => ({
  getSettings: () => ({
    workItemConnections: [],
    activeWorkItemConnectionId: undefined,
  }),
}));

import { forgetRepo, removeReposFromWorkspace } from '../workspace.service.js';

function seedRepo(id: string): void {
  inMemoryDb
    .prepare(
      `INSERT INTO repos (id, name, path, status, index_tier, created_at, updated_at)
       VALUES (?, ?, ?, 'indexed', 'enriched', datetime('now'), datetime('now'))`,
    )
    .run(id, id, `/tmp/${id}`);
}

function seedWorkspace(id: string): void {
  inMemoryDb
    .prepare(
      `INSERT INTO workspaces (id, name, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))`,
    )
    .run(id, id);
}

function addRepoToWorkspace(workspaceId: string, repoId: string): void {
  inMemoryDb
    .prepare(
      `INSERT INTO workspace_repos (workspace_id, repo_id, added_at)
       VALUES (?, ?, datetime('now'))`,
    )
    .run(workspaceId, repoId);
}

function count(table: string, where: string, param: string): number {
  return (
    inMemoryDb.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where} = ?`).get(param) as {
      c: number;
    }
  ).c;
}

beforeEach(() => {
  for (const table of [
    'repo_index_jobs',
    'module_summaries',
    'repo_summaries',
    'repository_map_graphs',
    'workspace_repos',
    'workspace_repo_definitions',
    'code_reviews',
    'security_audits',
    'repos',
    'workspaces',
  ]) {
    inMemoryDb.exec(`DELETE FROM ${table}`);
  }
  vi.clearAllMocks();
});

describe('removeReposFromWorkspace', () => {
  it('cancels index jobs and keeps the repos row + index data', () => {
    seedWorkspace('ws-1');
    seedRepo('r-1');
    addRepoToWorkspace('ws-1', 'r-1');
    inMemoryDb.prepare(`INSERT INTO repo_summaries (repo_id, overview) VALUES (?, 'o')`).run('r-1');

    removeReposFromWorkspace('ws-1', ['r-1']);

    expect(mockCancelIndexJobs).toHaveBeenCalledWith('r-1');
    expect(count('workspace_repos', 'repo_id', 'r-1')).toBe(0);
    expect(count('repos', 'id', 'r-1')).toBe(1);
    expect(count('repo_summaries', 'repo_id', 'r-1')).toBe(1);
  });
});

describe('forgetRepo', () => {
  it('refuses while the repo is still in a workspace', () => {
    seedWorkspace('ws-1');
    seedRepo('r-1');
    addRepoToWorkspace('ws-1', 'r-1');

    expect(() => forgetRepo('r-1')).toThrow(/still used by a workspace/);
    expect(count('repos', 'id', 'r-1')).toBe(1);
  });

  it('refuses while a portable workspace definition maps to the repo', () => {
    seedWorkspace('ws-1');
    seedRepo('r-1');
    inMemoryDb
      .prepare(
        `INSERT INTO workspace_repo_definitions
          (workspace_id, portable_id, name, remote_url, default_branch, mapped_repo_id, created_at, updated_at)
         VALUES ('ws-1', 'p-1', 'r-1', NULL, 'main', 'r-1', datetime('now'), datetime('now'))`,
      )
      .run();

    expect(() => forgetRepo('r-1')).toThrow(/still used by a workspace/);
    expect(count('repos', 'id', 'r-1')).toBe(1);
  });

  it('deletes the repos row and index data while keeping history orphaned', () => {
    seedRepo('r-1');
    inMemoryDb.prepare(`INSERT INTO repo_summaries (repo_id, overview) VALUES (?, 'o')`).run('r-1');
    inMemoryDb
      .prepare(
        `INSERT INTO module_summaries (repo_id, path, purpose, content_hash)
         VALUES (?, 'src', 'p', 'hash')`,
      )
      .run('r-1');
    inMemoryDb
      .prepare(
        `INSERT INTO repository_map_graphs (repo_id, schema_version, graph_json, generated_at)
         VALUES (?, 1, '{}', datetime('now'))`,
      )
      .run('r-1');
    inMemoryDb
      .prepare(
        `INSERT INTO repo_index_jobs (id, repo_id, tier, state, queued_at)
         VALUES ('j-1', ?, 'mapped', 'completed', datetime('now'))`,
      )
      .run('r-1');
    // A review referencing the repo must survive the forget (decision: no cascade).
    inMemoryDb
      .prepare(
        `INSERT INTO code_reviews (id, repo_id, mode, scope_type, status)
         VALUES ('cr-1', 'r-1', 'quick', 'working_tree', 'completed')`,
      )
      .run();

    forgetRepo('r-1');

    expect(mockCancelIndexJobs).toHaveBeenCalledWith('r-1');
    expect(count('repos', 'id', 'r-1')).toBe(0);
    expect(count('repo_summaries', 'repo_id', 'r-1')).toBe(0);
    expect(count('module_summaries', 'repo_id', 'r-1')).toBe(0);
    expect(count('repository_map_graphs', 'repo_id', 'r-1')).toBe(0);
    expect(count('repo_index_jobs', 'repo_id', 'r-1')).toBe(0);
    // History stays orphaned.
    expect(count('code_reviews', 'repo_id', 'r-1')).toBe(1);
    expect(inMemoryDb.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('throws for an unknown repo', () => {
    expect(() => forgetRepo('nope')).toThrow(/Repo not found/);
  });
});
