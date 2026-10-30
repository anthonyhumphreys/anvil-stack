import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewSnapshot } from '../../shared/change-review-types.js';

export function reviewGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}
/** A temporary index captures dirty and non-ignored untracked content without touching the user's index. */
export function captureReviewSnapshot(cwd: string): ReviewSnapshot {
  const dir = mkdtempSync(join(tmpdir(), 'mezair-review-index-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    const head = reviewGit(cwd, ['rev-parse', 'HEAD']);
    if (
      reviewGit(cwd, ['ls-files', '--stage'])
        .split('\n')
        .some((line) => line.startsWith('160000 '))
    ) {
      throw new Error('Review snapshots do not yet support submodules.');
    }
    reviewGit(cwd, ['read-tree', head], env);
    reviewGit(cwd, ['add', '-A', '--', '.', ':(exclude).mezair', ':(exclude)**/.mezair'], env);
    const tree = reviewGit(cwd, ['write-tree'], env);
    return { head, tree, capturedAt: new Date().toISOString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
export function snapshotCommit(cwd: string, snapshot: ReviewSnapshot): string {
  return reviewGit(cwd, [
    '-c',
    'user.name=Mezair Review',
    '-c',
    'user.email=review@localhost',
    'commit-tree',
    snapshot.tree,
    '-p',
    snapshot.head,
    '-m',
    'Mezair review snapshot',
  ]);
}
