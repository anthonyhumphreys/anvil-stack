import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIGRATIONS, SCHEMA_SQL } from '../../db/schema.js';

const state = vi.hoisted(() => ({ userData: '' }));
const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
db.pragma('foreign_keys = ON');
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));
vi.mock('../llm.service.js', () => ({ callLlm: vi.fn() }));
import {
  createChatThread,
  getChatThread,
  updateChatThread,
  deleteChatThread,
} from '../chat-persistence.service.js';
import {
  selectThreadCheckout,
  validateThreadCheckouts,
  listCheckoutOptions,
  copyThreadCheckouts,
} from '../thread-checkout.service.js';
import { upsertChatArtifact } from '../chat-artifact.service.js';

let root: string;
let repo: string;
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function thread() {
  return createChatThread({
    workspaceId: 'workspace',
    personaId: 'coder',
    repoIds: ['source'],
    activeRepoId: 'source',
  });
}
beforeEach(() => {
  db.pragma('foreign_keys = OFF');
  for (const table of [
    'thread_checkouts',
    'chat_artifacts',
    'chat_messages',
    'chat_sessions',
    'chat_threads',
    'workspace_repos',
    'workspaces',
    'repos',
  ])
    db.exec(`DELETE FROM ${table}`);
  db.pragma('foreign_keys = ON');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-thread-checkouts-'));
  state.userData = path.join(root, 'app-data');
  repo = path.join(root, 'source');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Checkout tests');
  git(repo, 'config', 'user.email', 'checkout@example.test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'base');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'test: initial commit');
  db.prepare("INSERT INTO repos(id, name, path) VALUES ('source', 'source', ?)").run(
    fs.realpathSync(repo),
  );
  db.prepare(
    "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('workspace', 'Workspace', 'now', 'now')",
  ).run();
  db.prepare(
    "INSERT INTO workspace_repos(workspace_id, repo_id, added_at) VALUES ('workspace', 'source', 'now')",
  ).run();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('optional thread checkouts', () => {
  it('preserves the existing shared checkout by default', () => {
    const original = thread();
    expect(original.repoIds).toEqual(['source']);
    expect(original.checkouts).toEqual([]);
    expect(git(repo, 'branch', '--show-current')).toBe('main');
  });

  it('creates concurrent isolated branches and persists checkout IDs for every repo-scoped operation', async () => {
    const first = thread();
    const second = thread();
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'uncommitted source');
    const [a, b] = await Promise.all(
      [first, second].map((item, index) =>
        selectThreadCheckout({
          threadId: item.id,
          repoId: 'source',
          mode: 'worktree',
          baseBranch: 'main',
          branchName: `feature/thread-${index}`,
        }),
      ),
    );
    expect(a.id).not.toBe(b.id);
    expect(getChatThread(first.id)?.repoIds).toEqual([a.id]);
    expect(getChatThread(first.id)?.activeRepoId).toBe(a.id);
    expect(getChatThread(first.id)?.checkouts?.[0]).toMatchObject({
      path: a.path,
      owned: true,
      branch: 'feature/thread-0',
    });
    expect(
      db.prepare('SELECT repo_id FROM workspace_repos WHERE repo_id = ?').get(a.id),
    ).toBeTruthy();
    expect(fs.readFileSync(path.join(a.path, 'shared.txt'), 'utf8')).toBe('base');
    expect(fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8')).toBe('uncommitted source');
    for (const [item, checkout] of [
      [first, a],
      [second, b],
    ] as const) {
      const artifact = upsertChatArtifact({
        threadId: item.id,
        repoId: checkout.id,
        relativePath: 'review.md',
        kind: 'markdown',
        title: 'Review',
        content: item.id,
      });
      expect(artifact.filePath).toBe(path.join(checkout.path, '.anvil/artifacts/review.md'));
      expect(fs.readFileSync(artifact.filePath!, 'utf8')).toBe(item.id);
    }
    expect(fs.existsSync(path.join(repo, '.anvil/artifacts/review.md'))).toBe(false);
    await validateThreadCheckouts(first.id, [a.id]);
  });

  it('joins an existing feature checkout without switching branches or copying dirty changes', async () => {
    const first = thread();
    const a = await selectThreadCheckout({
      threadId: first.id,
      repoId: 'source',
      mode: 'worktree',
      baseBranch: 'main',
      branchName: 'feature/shared',
    });
    fs.writeFileSync(path.join(a.path, 'shared.txt'), 'live edits');
    const reviewer = thread();
    const joined = await selectThreadCheckout({
      threadId: reviewer.id,
      repoId: 'source',
      mode: 'existing',
      path: a.path,
    });
    expect(joined.id).toBe(a.id);
    expect(getChatThread(reviewer.id)?.checkouts?.[0].owned).toBe(false);
    expect(fs.readFileSync(path.join(joined.path, 'shared.txt'), 'utf8')).toBe('live edits');
    expect(git(repo, 'branch', '--show-current')).toBe('main');
  });

  it('branches from the selected feature commit and rejects branch collisions', async () => {
    git(repo, 'checkout', '-b', 'feature/base');
    git(repo, 'commit', '--allow-empty', '-m', 'test: feature base commit');
    git(repo, 'checkout', 'main');
    const selected = thread();
    const result = await selectThreadCheckout({
      threadId: selected.id,
      repoId: 'source',
      mode: 'worktree',
      baseBranch: 'feature/base',
      branchName: 'feature/child',
    });
    expect(git(result.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'feature/base'));
    await expect(
      selectThreadCheckout({
        threadId: thread().id,
        repoId: 'source',
        mode: 'worktree',
        baseBranch: 'main',
        branchName: 'feature/child',
      }),
    ).rejects.toThrow();
  });

  it('rejects simultaneous setup for the same thread', async () => {
    const selected = thread();
    const input = {
      threadId: selected.id,
      repoId: 'source',
      mode: 'worktree' as const,
      baseBranch: 'main',
      branchName: 'feature/one',
    };
    const first = selectThreadCheckout(input);
    await expect(selectThreadCheckout(input)).rejects.toThrow('still running');
    await first;
  });

  it('rejects unrelated checkouts and unknown base branches', async () => {
    const selected = thread();
    await expect(
      selectThreadCheckout({
        threadId: selected.id,
        repoId: 'source',
        mode: 'existing',
        path: root,
      }),
    ).rejects.toThrow('existing checkout');
    await expect(
      selectThreadCheckout({
        threadId: selected.id,
        repoId: 'source',
        mode: 'worktree',
        baseBranch: 'missing',
        branchName: 'feature/no',
      }),
    ).rejects.toThrow('base branch');
  });

  it('fails resume on missing worktrees or branch drift without falling back', async () => {
    const selected = thread();
    const result = await selectThreadCheckout({
      threadId: selected.id,
      repoId: 'source',
      mode: 'worktree',
      baseBranch: 'main',
      branchName: 'feature/resume',
    });
    git(result.path, 'checkout', '-b', 'feature/drift');
    await expect(validateThreadCheckouts(selected.id)).rejects.toThrow('expected feature/resume');
    fs.rmSync(result.path, { recursive: true });
    await expect(validateThreadCheckouts(selected.id)).rejects.toThrow('missing');
    expect(getChatThread(selected.id)?.repoIds).toEqual([result.id]);
  });

  it('keeps forked threads on the same checkout and retains worktrees on deletion', async () => {
    const selected = thread();
    const result = await selectThreadCheckout({
      threadId: selected.id,
      repoId: 'source',
      mode: 'worktree',
      baseBranch: 'main',
      branchName: 'feature/fork',
    });
    const fork = createChatThread({ personaId: 'coder', repoIds: [result.id] });
    copyThreadCheckouts(selected.id, fork.id);
    expect(getChatThread(fork.id)?.checkouts?.[0]).toMatchObject({
      repoId: result.id,
      owned: false,
    });
    deleteChatThread(selected.id);
    expect(fs.existsSync(result.path)).toBe(true);
    await validateThreadCheckouts(fork.id);
  });

  it('refuses rebinding a thread after a provider session starts', async () => {
    const selected = thread();
    db.prepare(
      "INSERT INTO chat_sessions(id, thread_id, persona_id, started_at) VALUES ('session', ?, 'coder', 'now')",
    ).run(selected.id);
    await expect(
      selectThreadCheckout({
        threadId: selected.id,
        repoId: 'source',
        mode: 'existing',
        path: fs.realpathSync(repo),
      }),
    ).rejects.toThrow('already started');
    expect(() => updateChatThread(selected.id, { repoIds: [] })).toThrow('already started');
  });

  it('lists active threads sharing a checkout and supports paths with spaces', async () => {
    const selected = thread();
    db.prepare("UPDATE chat_threads SET attention_state = 'working' WHERE id = ?").run(selected.id);
    const linked = path.join(root, 'review with spaces');
    git(repo, 'worktree', 'add', '-b', 'feature/spaces', linked);
    const options = await listCheckoutOptions('source');
    expect(options.checkouts.find((item) => item.branch === 'main')?.activeThreads).toEqual([
      { id: selected.id, title: selected.title },
    ]);
    expect(options.checkouts.find((item) => item.branch === 'feature/spaces')?.path).toBe(
      fs.realpathSync(linked),
    );
  });

  it('captures shared checkouts on first start and rejects a stale repository selection', async () => {
    const selected = thread();
    await validateThreadCheckouts(selected.id, ['source']);
    expect(getChatThread(selected.id)?.checkouts?.[0]).toMatchObject({
      repoId: 'source',
      branch: 'main',
      owned: false,
    });
    await expect(validateThreadCheckouts(selected.id, [])).rejects.toThrow('repositories changed');
  });

  it('rejects shared canvas collisions and stale original-checkout writes', async () => {
    const first = thread();
    const second = thread();
    const input = {
      repoId: 'source',
      relativePath: 'shared-review.md',
      kind: 'markdown' as const,
      title: 'Review',
      content: 'original',
    };
    upsertChatArtifact({ ...input, threadId: first.id });
    expect(() =>
      upsertChatArtifact({ ...input, content: 'replacement', threadId: second.id }),
    ).toThrow('Another thread owns');
    expect(fs.readFileSync(path.join(repo, '.anvil/artifacts/shared-review.md'), 'utf8')).toBe(
      'original',
    );
    await selectThreadCheckout({
      threadId: second.id,
      repoId: 'source',
      mode: 'worktree',
      baseBranch: 'main',
      branchName: 'feature/artifacts',
    });
    expect(() =>
      upsertChatArtifact({ ...input, threadId: second.id, relativePath: 'other.md' }),
    ).toThrow('does not match');
  });

  it('reuses registered checkout identity through a symlink', async () => {
    const alias = path.join(root, 'alias');
    fs.symlinkSync(repo, alias);
    db.prepare('UPDATE repos SET path = ? WHERE id = ?').run(alias, 'source');
    const selected = thread();
    const result = await selectThreadCheckout({
      threadId: selected.id,
      repoId: 'source',
      mode: 'existing',
      path: fs.realpathSync(repo),
    });
    expect(result.id).toBe('source');
    await validateThreadCheckouts(selected.id);
  });

  it('adds checkout persistence to existing databases without altering old threads', () => {
    const old = new Database(':memory:');
    old.exec(
      'CREATE TABLE chat_threads(id TEXT PRIMARY KEY); CREATE TABLE repos(id TEXT PRIMARY KEY);',
    );
    old.exec("INSERT INTO chat_threads VALUES ('existing');");
    old.exec(MIGRATIONS[62]);
    expect(old.prepare('SELECT * FROM thread_checkouts').all()).toEqual([]);
    expect(old.prepare('SELECT id FROM chat_threads').get()).toEqual({ id: 'existing' });
    old.close();
  });
});
