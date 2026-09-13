import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getBranchDiff,
  getCommitRangeDiff,
  getCurrentCommitSha,
  getLatestCommitDiff,
  getPullRequestRefDiff,
  getScopeChangeSummary,
  getTrackedFiles,
  listBranches,
  listRecentCommits,
  resolveGitRef,
} from '../code-review-git.service.js';

const repoPath = mkdtempSync(join(tmpdir(), 'anvil-review-git-'));
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
}

beforeAll(() => {
  git('init', '-b', 'main');
  git('config', 'user.name', 'Review Test');
  git('config', 'user.email', 'review@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repoPath, 'example.ts'), 'export const value = 1;\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  git('checkout', '-b', 'feature');
  writeFileSync(join(repoPath, 'example.ts'), 'export const value = 2;\n');
  git('commit', '-am', 'change');
});
afterAll(() => rmSync(repoPath, { recursive: true, force: true }));

describe('asynchronous review Git helpers', () => {
  it('returns the same diffs and metadata through every scope', async () => {
    const expected = await getLatestCommitDiff(repoPath);
    expect(expected).toHaveLength(1);
    expect(expected[0]).toMatchObject({ filePath: 'example.ts', status: 'modified' });
    expect(await getCommitRangeDiff(repoPath, 'HEAD~1', 'HEAD')).toEqual(expected);
    expect(await getBranchDiff(repoPath, 'main', 'feature')).toEqual(expected);
    expect(await getPullRequestRefDiff(repoPath, 'refs/heads/main', 'feature')).toEqual(expected);
    expect(
      await getScopeChangeSummary(repoPath, 'branch_diff', {
        baseBranch: 'main',
        compareBranch: 'feature',
      }),
    ).toMatchObject({ modifications: 1 });
    expect(await listBranches(repoPath)).toEqual(['feature', 'main']);
    expect(await getTrackedFiles(repoPath)).toEqual(['example.ts']);
    expect(await getCurrentCommitSha(repoPath)).toBe(git('rev-parse', 'HEAD'));
    expect((await listRecentCommits(repoPath, 1))[0]).toMatchObject({
      message: 'change',
      author: 'Review Test',
    });
  });

  it('preserves missing-ref fallbacks', async () => {
    expect(await resolveGitRef(repoPath, 'missing')).toBeNull();
    expect(await getPullRequestRefDiff(repoPath, 'missing', 'feature')).toEqual([]);
    expect(await getCommitRangeDiff(repoPath, 'missing', 'HEAD')).toEqual([]);
    expect(await getCurrentCommitSha(join(repoPath, 'missing'))).toBeUndefined();
  });

  it('falls back to a two-ref diff when branches have no merge base', async () => {
    git('checkout', '--orphan', 'unrelated');
    git('commit', '-m', 'unrelated root');
    try {
      expect(await getBranchDiff(repoPath, 'main', 'unrelated')).toHaveLength(1);
    } finally {
      git('checkout', 'feature');
    }
  });

  it('lets the event loop run while Git waits on an external diff', async () => {
    const driverPath = join(repoPath, 'slow-diff.cjs');
    writeFileSync(
      driverPath,
      'setTimeout(() => process.stdout.write("diff --git a/example.ts b/example.ts\\n"), 150);',
    );
    git('config', 'diff.external', `"${process.execPath}" "${driverPath}"`);
    let completed = false;
    try {
      const pending = getLatestCommitDiff(repoPath).then((files) => {
        completed = true;
        return files;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const completedBeforeTimer = completed;
      await pending;
      expect(completedBeforeTimer).toBe(false);
    } finally {
      git('config', '--unset', 'diff.external');
    }
  });
});
