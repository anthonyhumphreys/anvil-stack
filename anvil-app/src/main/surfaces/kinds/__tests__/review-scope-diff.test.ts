import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentToolSessionContext } from '../../../agent-tools/dispatch.js';

const db = vi.hoisted(() => ({
  repoPath: '',
  messages: [] as Array<{ role: string; event_json: string | null }>,
}));

vi.mock('../../../db/database.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: () =>
        sql.includes('FROM repos')
          ? { id: 'repo-1', name: 'app', path: db.repoPath, remote_url: null }
          : undefined,
      all: () => (sql.includes('FROM chat_messages') ? db.messages : []),
    }),
  }),
}));
vi.mock('../../../services/pull-request-visualisation.service.js', () => ({
  getPullRequestDiff: vi.fn(),
}));

const { clearReviewDiffCache, loadReviewDiff, loadWorkingTreeDiff } =
  await import('../review/scope-diff.js');

const ctx = {
  sessionId: 's',
  appThreadId: 'thread-1',
  repoIds: ['repo-1'],
  provider: 'codex',
  mode: 'workspace-auto',
  features: ['codereview'],
} as unknown as AgentToolSessionContext;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: db.repoPath, encoding: 'utf-8' });
}

beforeEach(() => {
  clearReviewDiffCache();
  db.repoPath = mkdtempSync(join(tmpdir(), 'anvil-review-scope-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(db.repoPath, 'a.ts'), 'one\ntwo\n');
  writeFileSync(join(db.repoPath, 'b.ts'), 'keep\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  writeFileSync(join(db.repoPath, 'a.ts'), 'one\nTWO\n');
  writeFileSync(join(db.repoPath, 'b.ts'), 'keep\nmore\n');
  writeFileSync(join(db.repoPath, 'new.ts'), 'fresh\n');
  db.messages = [];
});

afterEach(() => {
  rmSync(db.repoPath, { recursive: true, force: true });
});

describe('review scope diffs', () => {
  it('diffs the working tree including untracked files without touching the index', async () => {
    const diff = await loadWorkingTreeDiff(db.repoPath);
    expect(diff).toContain('diff --git a/a.ts b/a.ts');
    expect(diff).toContain('diff --git a/new.ts b/new.ts');
    expect(git('status', '--porcelain')).toContain('?? new.ts');
  });

  it('turn scope narrows the working tree to the files edited in the latest turn', async () => {
    db.messages = [
      { role: 'user', event_json: null },
      {
        role: 'system',
        event_json: JSON.stringify({ type: 'file_edit', filePath: join(db.repoPath, 'a.ts') }),
      },
      { role: 'system', event_json: JSON.stringify({ type: 'file_edit', filePath: 'gone.ts' }) },
      { role: 'user', event_json: null },
      { role: 'system', event_json: JSON.stringify({ type: 'file_edit', filePath: 'b.ts' }) },
    ];
    // Rows arrive newest first: the current "review" prompt, then the previous turn's edits.
    const loaded = await loadReviewDiff(ctx, { type: 'turn', repoId: 'repo-1' });
    expect(loaded.files.map((file) => file.path)).toEqual(['a.ts']);
    expect(loaded.notes[0]).toContain('gone.ts');
    expect(loaded.key).toBe('review:repo-1:turn');
  });

  it('turn scope falls back to the working tree with a note when no edits are recorded', async () => {
    const loaded = await loadReviewDiff(ctx, { type: 'turn', repoId: 'repo-1' });
    expect(loaded.files.map((file) => file.path).sort()).toEqual(['a.ts', 'b.ts', 'new.ts']);
    expect(loaded.notes[0]).toContain('whole working tree');
  });

  it('commit-range resolves refs, records base..head and rejects unsafe refs', async () => {
    git('add', '.');
    git('commit', '-q', '-m', 'second');
    const loaded = await loadReviewDiff(ctx, {
      type: 'commit-range',
      repoId: 'repo-1',
      baseRef: 'HEAD~1',
    });
    expect(loaded.scope.ref).toBe('HEAD~1..HEAD');
    expect(loaded.files.map((file) => file.path).sort()).toEqual(['a.ts', 'b.ts', 'new.ts']);
    await expect(
      loadReviewDiff(ctx, { type: 'commit-range', repoId: 'repo-1', baseRef: '--output=/tmp/x' }),
    ).rejects.toMatchObject({ code: 'invalid-params' });
    await expect(
      loadReviewDiff(ctx, { type: 'commit-range', repoId: 'repo-1' }),
    ).rejects.toMatchObject({
      code: 'invalid-params',
    });
  });
});
