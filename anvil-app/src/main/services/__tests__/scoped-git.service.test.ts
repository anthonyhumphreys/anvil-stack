import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitTurnDelivery,
  createTurnPullRequest,
  prepareTurnDelivery,
} from '../scoped-git.service.js';

const temporaryDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-scoped-git-test-'));
  temporaryDirs.push(repoPath);
  git(repoPath, ['init', '-b', 'main']);
  git(repoPath, ['config', 'user.name', 'Anvil Test']);
  git(repoPath, ['config', 'user.email', 'anvil-test@example.com']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'base\n');
  git(repoPath, ['add', 'README.md']);
  git(repoPath, ['commit', '-m', 'chore: initial commit']);
  return repoPath;
}

function prepare(repoPath: string, paths: string[], mode: 'commit' | 'pr' = 'commit') {
  return prepareTurnDelivery({
    repoId: 'repo-1',
    repoName: 'test-repo',
    repoPath,
    paths,
    mode,
  });
}

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('scoped turn delivery', () => {
  it('commits selected paths while preserving unrelated staged files and the worktree', async () => {
    const repoPath = makeRepo();
    fs.writeFileSync(path.join(repoPath, 'turn.txt'), 'reviewed turn change\n');
    fs.writeFileSync(path.join(repoPath, 'other-staged.txt'), 'keep staged\n');
    git(repoPath, ['add', 'other-staged.txt']);

    const review = await prepare(repoPath, ['turn.txt']);
    expect(review.diff).toContain('reviewed turn change');
    expect(review.diff).not.toContain('keep staged');

    const committed = await commitTurnDelivery(
      repoId(),
      review.reviewId,
      'feat: deliver turn change',
    );

    expect(git(repoPath, ['rev-parse', 'HEAD'])).toBe(committed.commitHash);
    expect(git(repoPath, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toBe(
      'turn.txt',
    );
    expect(git(repoPath, ['diff', '--cached', '--name-only'])).toBe('other-staged.txt');
    expect(fs.readFileSync(path.join(repoPath, 'turn.txt'), 'utf8')).toBe('reviewed turn change\n');
    expect(fs.readFileSync(path.join(repoPath, 'other-staged.txt'), 'utf8')).toBe('keep staged\n');
  });

  it('rejects a same-file edit made after the diff was reviewed', async () => {
    const repoPath = makeRepo();
    fs.writeFileSync(path.join(repoPath, 'turn.txt'), 'reviewed version\n');
    const review = await prepare(repoPath, ['turn.txt']);
    fs.writeFileSync(path.join(repoPath, 'turn.txt'), 'later edit\n');

    await expect(
      commitTurnDelivery('repo-1', review.reviewId, 'fix: update turn file'),
    ).rejects.toThrow(/changed after review/);

    expect(git(repoPath, ['rev-parse', 'HEAD'])).toBe(review.sourceHead);
    expect(fs.readFileSync(path.join(repoPath, 'turn.txt'), 'utf8')).toBe('later edit\n');
  });

  it('rejects a dialog after HEAD advances', async () => {
    const repoPath = makeRepo();
    fs.writeFileSync(path.join(repoPath, 'turn.txt'), 'reviewed version\n');
    const review = await prepare(repoPath, ['turn.txt']);
    fs.writeFileSync(path.join(repoPath, 'other.txt'), 'separate commit\n');
    git(repoPath, ['add', 'other.txt']);
    git(repoPath, ['commit', '-m', 'chore: advance head']);
    const advancedHead = git(repoPath, ['rev-parse', 'HEAD']);

    await expect(
      commitTurnDelivery('repo-1', review.reviewId, 'fix: update turn file'),
    ).rejects.toThrow(/branch or HEAD changed/);

    expect(git(repoPath, ['rev-parse', 'HEAD'])).toBe(advancedHead);
    expect(fs.readFileSync(path.join(repoPath, 'turn.txt'), 'utf8')).toBe('reviewed version\n');
  });

  it('allows only one delivery when the same review is submitted twice concurrently', async () => {
    const repoPath = makeRepo();
    fs.writeFileSync(path.join(repoPath, 'turn.txt'), 'reviewed version\n');
    const review = await prepare(repoPath, ['turn.txt']);

    const results = await Promise.allSettled([
      commitTurnDelivery('repo-1', review.reviewId, 'fix: update turn file'),
      commitTurnDelivery('repo-1', review.reviewId, 'fix: update turn file'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(git(repoPath, ['rev-list', '--count', 'HEAD'])).toBe('2');
  });

  it('runs commit hooks in isolation and rejects a hook that widens the reviewed tree', async () => {
    const repoPath = makeRepo();
    const hookLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-hook-test-'));
    temporaryDirs.push(hookLogDir);
    const hookRanPath = path.join(hookLogDir, 'hook-ran.txt');
    const preCommitHook = path.join(repoPath, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(path.join(repoPath, 'turn.txt'), 'reviewed version\n');
    fs.writeFileSync(
      preCommitHook,
      `#!/bin/sh\nprintf ran > "${hookRanPath}"\nprintf extra > hook-added.txt\ngit add hook-added.txt\n`,
    );
    fs.chmodSync(preCommitHook, 0o755);
    const review = await prepare(repoPath, ['turn.txt']);

    await expect(
      commitTurnDelivery('repo-1', review.reviewId, 'fix: update turn file'),
    ).rejects.toThrow(/commit hook changed the reviewed file tree/);

    expect(fs.readFileSync(hookRanPath, 'utf8')).toBe('ran');
    expect(fs.existsSync(path.join(repoPath, 'hook-added.txt'))).toBe(false);
    expect(git(repoPath, ['rev-parse', 'HEAD'])).toBe(review.sourceHead);
    expect(
      git(repoPath, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((line) => line.startsWith('worktree ')),
    ).toHaveLength(1);
  });

  it('honors commit signing configuration and leaves the current branch unchanged on signing failure', async () => {
    const repoPath = makeRepo();
    const signerPath = path.join(repoPath, '.git', 'fake-gpg');
    const signerLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-signer-test-'));
    temporaryDirs.push(signerLogDir);
    const signerLogPath = path.join(signerLogDir, 'signer-ran.txt');
    fs.writeFileSync(path.join(repoPath, 'turn.txt'), 'reviewed version\n');
    fs.writeFileSync(signerPath, `#!/bin/sh\nprintf ran > "${signerLogPath}"\nexit 1\n`);
    fs.chmodSync(signerPath, 0o755);
    git(repoPath, ['config', 'commit.gpgsign', 'true']);
    git(repoPath, ['config', 'user.signingkey', 'anvil-test-key']);
    git(repoPath, ['config', 'gpg.program', signerPath]);
    const review = await prepare(repoPath, ['turn.txt']);

    await expect(
      commitTurnDelivery('repo-1', review.reviewId, 'fix: update turn file'),
    ).rejects.toThrow(/commit failed in the isolated review worktree/);

    expect(fs.readFileSync(signerLogPath, 'utf8')).toBe('ran');
    expect(git(repoPath, ['rev-parse', 'HEAD'])).toBe(review.sourceHead);
    expect(fs.readFileSync(path.join(repoPath, 'turn.txt'), 'utf8')).toBe('reviewed version\n');
  });

  it('rejects a commit-message hook that changes the reviewed message', async () => {
    const repoPath = makeRepo();
    const commitMsgHook = path.join(repoPath, '.git', 'hooks', 'commit-msg');
    fs.writeFileSync(path.join(repoPath, 'turn.txt'), 'reviewed version\n');
    fs.writeFileSync(commitMsgHook, '#!/bin/sh\nprintf changed > "$1"\n');
    fs.chmodSync(commitMsgHook, 0o755);
    const review = await prepare(repoPath, ['turn.txt']);

    await expect(
      commitTurnDelivery('repo-1', review.reviewId, 'fix: update turn file'),
    ).rejects.toThrow(/commit hook changed the reviewed commit message/);

    expect(git(repoPath, ['rev-parse', 'HEAD'])).toBe(review.sourceHead);
    expect(fs.readFileSync(path.join(repoPath, 'turn.txt'), 'utf8')).toBe('reviewed version\n');
  });

  it('rejects a selected directory whose current changes include unselected files', async () => {
    const repoPath = makeRepo();
    fs.mkdirSync(path.join(repoPath, 'nested'));
    fs.writeFileSync(path.join(repoPath, 'nested', 'one.txt'), 'one\n');
    fs.writeFileSync(path.join(repoPath, 'nested', 'two.txt'), 'two\n');

    await expect(prepare(repoPath, ['nested'])).rejects.toThrow(/outside the selected file scope/);
    expect(git(repoPath, ['rev-parse', 'HEAD'])).toBe(git(repoPath, ['rev-parse', 'main']));
  });

  it('commits additions, deletions, and renames from the reviewed path set', async () => {
    const repoPath = makeRepo();
    fs.writeFileSync(path.join(repoPath, 'remove.txt'), 'remove me\n');
    fs.writeFileSync(path.join(repoPath, 'old-name.txt'), 'same content\n');
    git(repoPath, ['add', 'remove.txt', 'old-name.txt']);
    git(repoPath, ['commit', '-m', 'chore: add rename fixtures']);

    fs.unlinkSync(path.join(repoPath, 'remove.txt'));
    fs.renameSync(path.join(repoPath, 'old-name.txt'), path.join(repoPath, 'new-name.txt'));
    fs.writeFileSync(path.join(repoPath, 'added.txt'), 'new file\n');
    const review = await prepare(repoPath, [
      'remove.txt',
      'old-name.txt',
      'new-name.txt',
      'added.txt',
    ]);

    expect(review.files.map((file) => file.status).sort()).toEqual(['added', 'deleted', 'renamed']);
    await commitTurnDelivery('repo-1', review.reviewId, 'feat: add turn files');

    expect(
      git(repoPath, ['diff-tree', '--no-commit-id', '--name-status', '-r', '-M', 'HEAD']),
    ).toContain('R100\told-name.txt\tnew-name.txt');
    expect(fs.existsSync(path.join(repoPath, 'remove.txt'))).toBe(false);
    expect(fs.existsSync(path.join(repoPath, 'new-name.txt'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, 'added.txt'))).toBe(true);
  });

  it('keeps a failed PR commit on its dedicated branch and leaves the current branch and index alone', async () => {
    const repoPath = makeRepo();
    const textconvPath = path.join(repoPath, '.git', 'fake-textconv');
    fs.writeFileSync(textconvPath, '#!/bin/sh\nprintf "converted preview output\\n"\n');
    fs.chmodSync(textconvPath, 0o755);
    fs.writeFileSync(path.join(repoPath, '.gitattributes'), '*.txt diff=anvil-preview\n');
    git(repoPath, ['add', '.gitattributes']);
    git(repoPath, ['commit', '-m', 'chore: configure preview driver']);
    git(repoPath, ['config', 'diff.anvil-preview.textconv', textconvPath]);
    const remotePath = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-scoped-git-remote-'));
    temporaryDirs.push(remotePath);
    git(remotePath, ['init', '--bare', '-b', 'main']);
    git(repoPath, ['remote', 'add', 'origin', remotePath]);
    git(repoPath, ['push', '-u', 'origin', 'main']);
    git(repoPath, ['remote', 'set-head', 'origin', 'main']);
    const baseHead = git(repoPath, ['rev-parse', 'HEAD']);

    git(repoPath, ['checkout', '-b', 'feature']);
    fs.writeFileSync(path.join(repoPath, 'prior-branch-work.txt'), 'exclude from PR\n');
    git(repoPath, ['add', 'prior-branch-work.txt']);
    git(repoPath, ['commit', '-m', 'feat: prior branch work']);
    const sourceHead = git(repoPath, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repoPath, 'turn.txt'), 'selected PR change\n');
    fs.writeFileSync(path.join(repoPath, 'other-staged.txt'), 'leave staged\n');
    git(repoPath, ['add', 'other-staged.txt']);

    const review = await prepare(repoPath, ['turn.txt'], 'pr');
    expect(review.baseBranch).toBe('main');
    expect(review.baseHead).toBe(baseHead);
    expect(review.diff).toContain('selected PR change');
    expect(review.diff).not.toContain('converted preview output');
    expect(review.diff).not.toContain('prior branch work');

    const result = await createTurnPullRequest(
      'repo-1',
      review.reviewId,
      'feat: deliver selected turn',
      {
        createPullRequest: async () => {
          throw new Error('provider unavailable');
        },
      },
    );

    if (result.status !== 'branch-pushed') {
      throw new Error(`Expected a pushed branch after PR creation failed, got ${result.status}.`);
    }
    expect(result.status).toBe('branch-pushed');
    expect(result.detail).toContain('provider unavailable');
    expect(result.branch).toMatch(/^codex\/turn-/);
    expect(git(repoPath, ['branch', '--show-current'])).toBe('feature');
    expect(git(repoPath, ['rev-parse', 'HEAD'])).toBe(sourceHead);
    expect(git(repoPath, ['rev-parse', `${result.branch}^`])).toBe(baseHead);
    expect(git(repoPath, ['diff', '--name-only', 'origin/main', result.branch])).toBe('turn.txt');
    expect(git(repoPath, ['ls-remote', '--heads', 'origin', result.branch])).toContain(
      result.branch,
    );
    expect(git(repoPath, ['diff', '--cached', '--name-only'])).toBe('other-staged.txt');
    expect(fs.readFileSync(path.join(repoPath, 'turn.txt'), 'utf8')).toBe('selected PR change\n');
    expect(fs.readFileSync(path.join(repoPath, 'other-staged.txt'), 'utf8')).toBe('leave staged\n');
  });

  it('rejects a pull request review if origin changes before confirmation', async () => {
    const repoPath = makeRepo();
    const remotePath = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-scoped-git-remote-'));
    const replacementRemotePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'anvil-scoped-git-other-remote-'),
    );
    temporaryDirs.push(remotePath, replacementRemotePath);
    git(remotePath, ['init', '--bare', '-b', 'main']);
    git(repoPath, ['remote', 'add', 'origin', remotePath]);
    git(repoPath, ['push', '-u', 'origin', 'main']);
    git(repoPath, ['remote', 'set-head', 'origin', 'main']);
    fs.writeFileSync(path.join(repoPath, 'turn.txt'), 'selected change\n');
    const review = await prepare(repoPath, ['turn.txt'], 'pr');
    git(repoPath, ['remote', 'set-url', 'origin', replacementRemotePath]);

    await expect(
      createTurnPullRequest('repo-1', review.reviewId, 'feat: deliver selected turn'),
    ).rejects.toThrow(/origin remote changed after review/);

    expect(git(repoPath, ['branch', '--list', 'codex/turn-*'])).toBe('');
    expect(git(repoPath, ['branch', '--show-current'])).toBe('main');
  });
});

function repoId(): string {
  return 'repo-1';
}
