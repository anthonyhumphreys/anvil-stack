import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema.js';

const context = vi.hoisted(() => ({ repo: '' }));
const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  shell: {},
}));
vi.mock('../workspace.service.js', () => ({
  getWorkspace: () => ({ repos: [{ id: 'repo', path: context.repo }] }),
}));
vi.mock('../workitem-provider.js', () => ({
  getActiveProvider: () => ({
    getItem: async (id: string) => ({
      id,
      provider: 'linear',
      title: 'Workflow intent',
      acceptanceCriteria: '- Saved workflow criterion',
    }),
  }),
}));
import {
  createChangeReview,
  getChangeReview,
  resolveReviewRepairPaths,
  assertReviewRepairForkAllowed,
} from '../change-review.service.js';
import { captureReviewSnapshot } from '../review-snapshot.service.js';
let root: string;
const git = (path: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd: path,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'anvil-handoff-'));
  context.repo = join(root, 'repo');
  mkdirSync(context.repo);
  git(context.repo, 'init', '-b', 'main');
  writeFileSync(join(context.repo, 'file.txt'), 'original');
  git(context.repo, 'add', '.');
  git(
    context.repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'initial',
  );
  db.exec(
    'DELETE FROM change_reviews; DELETE FROM workflow_runs; DELETE FROM chat_threads; DELETE FROM workspaces; DELETE FROM repos;',
  );
  db.prepare(
    "INSERT INTO workspaces(id,name,created_at,updated_at) VALUES ('ws','Test','now','now')",
  ).run();
  db.prepare("INSERT INTO repos(id,name,path) VALUES ('repo','Repo',?)").run(context.repo);
  db.prepare(
    "INSERT INTO chat_threads(id,workspace_id,persona_id,title) VALUES ('thread','ws','coder','Task')",
  ).run();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function workflow(path: string): void {
  db.prepare(
    "INSERT INTO workflow_runs(id,template_id,template_name,workspace_id,graph_json,kickoff,status,supervisor_thread_id,node_runs_json,created_at) VALUES ('workflow','template','Delivery','ws',?,'Task','completed','thread','[]','now')",
  ).run(JSON.stringify({ executionPaths: [{ id: 'repo', path }] }));
}
it('captures retained workflow worktree contents and detects cleanup without repository fallback', async () => {
  const retained = join(root, 'retained');
  git(context.repo, 'worktree', 'add', '-b', 'candidate', retained);
  writeFileSync(join(retained, 'file.txt'), 'candidate changes');
  workflow(retained);
  const review = await createChangeReview({
    workspaceId: 'ws',
    repoId: 'repo',
    baseRef: 'main',
    origin: { workflowRunId: 'workflow', executionPath: retained },
  });
  expect(review.candidate.tree).toBe(captureReviewSnapshot(retained).tree);
  expect(review.candidate.tree).not.toBe(captureReviewSnapshot(context.repo).tree);
  expect(review.origin?.executionPath).toBe(realpathSync(retained));
  expect(resolveReviewRepairPaths('thread', ['repo'], review.id)).toEqual([realpathSync(retained)]);
  expect(() => resolveReviewRepairPaths('thread', [], review.id)).toThrow(
    'exactly the reviewed repository',
  );
  rmSync(retained, { recursive: true, force: true });
  expect(() => resolveReviewRepairPaths('thread', ['repo'], review.id)).toThrow();
  expect(getChangeReview(review.id).freshness).toBe('unknown');
});
it('rejects a retained path in another Git repository', async () => {
  const unrelated = join(root, 'unrelated');
  mkdirSync(unrelated);
  git(unrelated, 'init', '-b', 'main');
  workflow(unrelated);
  await expect(
    createChangeReview({
      workspaceId: 'ws',
      repoId: 'repo',
      baseRef: 'main',
      origin: { workflowRunId: 'workflow' },
    }),
  ).rejects.toThrow('different Git repository');
});
it('rejects a renderer path that differs from the persisted candidate', async () => {
  const retained = join(root, 'retained');
  git(context.repo, 'worktree', 'add', '-b', 'candidate', retained);
  workflow(retained);
  await expect(
    createChangeReview({
      workspaceId: 'ws',
      repoId: 'repo',
      baseRef: 'main',
      origin: { workflowRunId: 'workflow', executionPath: context.repo },
    }),
  ).rejects.toThrow('does not match');
});

it('resumes a persisted repair in its exact worktree and rejects generic thread forks', async () => {
  const retained = join(root, 'retained');
  git(context.repo, 'worktree', 'add', '-b', 'candidate', retained);
  workflow(retained);
  const review = await createChangeReview({
    workspaceId: 'ws',
    repoId: 'repo',
    baseRef: 'main',
    origin: { workflowRunId: 'workflow' },
  });
  review.findings.push({
    id: 'finding',
    runId: 'run',
    captureId: 'capture',
    note: 'Repair control',
    history: [],
    repair: { threadId: 'thread', at: 'now' },
  });
  db.prepare('UPDATE change_reviews SET record_json = ? WHERE id = ?').run(
    JSON.stringify(review),
    review.id,
  );
  expect(resolveReviewRepairPaths('thread', ['repo'])).toEqual([realpathSync(retained)]);
  expect(() => assertReviewRepairForkAllowed('thread')).toThrow('Repair threads cannot be forked');
  expect(() => assertReviewRepairForkAllowed('unrelated-thread')).not.toThrow();
  rmSync(retained, { recursive: true, force: true });
  expect(() => resolveReviewRepairPaths('thread', ['repo'])).toThrow();
});

it('retains authoritative Work Item identity from the workflow graph', async () => {
  const retained = join(root, 'retained');
  git(context.repo, 'worktree', 'add', '-b', 'candidate', retained);
  workflow(retained);
  const workItemRef = {
    connectionId: 'linear-connection',
    provider: 'linear' as const,
    id: 'ANV-7',
  };
  db.prepare("UPDATE workflow_runs SET graph_json = ? WHERE id = 'workflow'").run(
    JSON.stringify({ executionPaths: [{ id: 'repo', path: retained }], workItemRef }),
  );
  const input = {
    workspaceId: 'ws',
    repoId: 'repo',
    baseRef: 'main',
    origin: { workflowRunId: 'workflow' },
  };
  const review = await createChangeReview(input);
  expect(review.workItemRef).toEqual(workItemRef);
  expect(review.workItem?.id).toBe('ANV-7');
  expect(review.criteria[0].sourceText).toContain('Saved workflow criterion');
  await expect(
    createChangeReview({ ...input, workItemRef: { ...workItemRef, connectionId: 'different' } }),
  ).rejects.toThrow('does not match the workflow');
});
