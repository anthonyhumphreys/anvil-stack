import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyVerifiedFastForward,
  inspectVerifiedFastForward,
  MeshApplyError,
} from '../mesh-apply.service';

const temporaryRepos: string[] = [];

function git(repoDir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

function gitExitCode(repoDir: string, ...args: string[]): number {
  return spawnSync('git', args, { cwd: repoDir, stdio: 'ignore' }).status ?? -1;
}

function makeRepo(): { repoDir: string; baseCommit: string; targetCommit: string } {
  const repoDir = mkdtempSync(join(tmpdir(), 'mezair-mesh-apply-test-'));
  temporaryRepos.push(repoDir);
  git(repoDir, 'init', '-b', 'main');
  git(repoDir, 'config', 'user.name', 'Mezair test');
  git(repoDir, 'config', 'user.email', 'mezair-test@example.com');
  writeFileSync(join(repoDir, 'tracked.txt'), 'base\n');
  git(repoDir, 'add', 'tracked.txt');
  git(repoDir, 'commit', '-m', 'base');
  const baseCommit = git(repoDir, 'rev-parse', 'HEAD');
  writeFileSync(join(repoDir, 'tracked.txt'), 'target\n');
  writeFileSync(join(repoDir, 'target-only.txt'), 'from target\n');
  git(repoDir, 'add', 'tracked.txt', 'target-only.txt');
  git(repoDir, 'commit', '-m', 'target');
  const targetCommit = git(repoDir, 'rev-parse', 'HEAD');
  git(repoDir, 'reset', '--hard', baseCommit);
  return { repoDir, baseCommit, targetCommit };
}

function inputFor(
  repoDir: string,
  baseCommit: string,
  targetCommit: string,
  onPrepared: (intent: {
    branch: string;
    baseCommit: string;
    targetCommit: string;
    startedAt: string;
  }) => Promise<void> = async () => undefined,
) {
  return { repoPath: repoDir, expectedBranch: 'main', baseCommit, targetCommit, onPrepared };
}

afterEach(() => {
  for (const repoDir of temporaryRepos.splice(0)) {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

describe('applyVerifiedFastForward', () => {
  it('applies the verified target on the expected branch and reconciles repeats', async () => {
    const { repoDir, baseCommit, targetCommit } = makeRepo();
    let preparedCount = 0;
    const input = inputFor(repoDir, baseCommit, targetCommit, async (intent) => {
      preparedCount += 1;
      expect(intent).toMatchObject({ branch: 'main', baseCommit, targetCommit });
      expect(existsSync(join(repoDir, '.git', 'HEAD.lock'))).toBe(true);
      expect(existsSync(join(repoDir, '.git', 'index.lock'))).toBe(true);
      expect(existsSync(join(repoDir, '.git', 'refs', 'heads', 'main.lock'))).toBe(true);
      expect(git(repoDir, 'rev-parse', 'HEAD')).toBe(baseCommit);
      expect(readFileSync(join(repoDir, 'tracked.txt'), 'utf8')).toBe('base\n');
      expect(gitExitCode(repoDir, 'checkout', '--detach')).not.toBe(0);
      expect(gitExitCode(repoDir, 'commit', '--allow-empty', '-m', 'racing commit')).not.toBe(0);
    });

    await expect(applyVerifiedFastForward(input)).resolves.toEqual({
      status: 'applied',
      branch: 'main',
      baseCommit,
      targetCommit,
    });
    expect(git(repoDir, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(repoDir, 'rev-parse', 'HEAD')).toBe(targetCommit);
    expect(readFileSync(join(repoDir, 'tracked.txt'), 'utf8')).toBe('target\n');
    expect(readFileSync(join(repoDir, 'target-only.txt'), 'utf8')).toBe('from target\n');
    expect(git(repoDir, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(git(repoDir, 'reflog', '-1', '--format=%gs', 'main')).toBe('Mezair mesh apply');

    await expect(inspectVerifiedFastForward(input)).resolves.toEqual({
      status: 'alreadyApplied',
      branch: 'main',
      baseCommit,
      targetCommit,
    });
    await expect(applyVerifiedFastForward(input)).resolves.toMatchObject({
      status: 'alreadyApplied',
    });
    expect(preparedCount).toBe(1);
  });

  it.each([
    [
      'unstaged changes',
      (repoDir: string) => writeFileSync(join(repoDir, 'tracked.txt'), 'local\n'),
    ],
    [
      'staged changes',
      (repoDir: string) => {
        writeFileSync(join(repoDir, 'tracked.txt'), 'local\n');
        git(repoDir, 'add', 'tracked.txt');
      },
    ],
    ['untracked files', (repoDir: string) => writeFileSync(join(repoDir, 'local.txt'), 'local\n')],
    [
      'a different checked out branch',
      (repoDir: string) => git(repoDir, 'checkout', '-b', 'other'),
    ],
    ['a detached HEAD', (repoDir: string) => git(repoDir, 'checkout', '--detach')],
    [
      'a moved HEAD',
      (repoDir: string) => {
        writeFileSync(join(repoDir, 'tracked.txt'), 'another commit\n');
        git(repoDir, 'commit', '--all', '-m', 'moved elsewhere');
      },
    ],
  ])('refuses to apply over %s', async (_name, changeRepo) => {
    const { repoDir, baseCommit, targetCommit } = makeRepo();
    changeRepo(repoDir);
    const beforeHead = git(repoDir, 'rev-parse', 'HEAD');

    await expect(
      applyVerifiedFastForward(inputFor(repoDir, baseCommit, targetCommit)),
    ).rejects.toMatchObject({
      name: 'MeshApplyError',
      outcome: 'notApplied',
      recovery: 'attention',
    });
    expect(git(repoDir, 'rev-parse', 'HEAD')).toBe(beforeHead);
  });

  it.each(['HEAD.lock', 'index.lock'])('leaves an existing %s untouched', async (lockName) => {
    const { repoDir, baseCommit, targetCommit } = makeRepo();
    const lockPath = join(repoDir, '.git', lockName);
    writeFileSync(lockPath, 'owned by another Git process');

    await expect(
      applyVerifiedFastForward(inputFor(repoDir, baseCommit, targetCommit)),
    ).rejects.toMatchObject({
      name: 'MeshApplyError',
      outcome: 'notApplied',
      recovery: 'attention',
    });
    expect(readFileSync(lockPath, 'utf8')).toBe('owned by another Git process');
    expect(git(repoDir, 'rev-parse', 'HEAD')).toBe(baseCommit);
    expect(readFileSync(join(repoDir, 'tracked.txt'), 'utf8')).toBe('base\n');
  });

  it('rejects a ref transaction held by another Git operation', async () => {
    const { repoDir, baseCommit, targetCommit } = makeRepo();
    const refLock = join(repoDir, '.git', 'refs', 'heads', 'main.lock');
    writeFileSync(refLock, 'external ref lock');
    let callbackCalled = false;

    await expect(
      applyVerifiedFastForward(
        inputFor(repoDir, baseCommit, targetCommit, async () => {
          callbackCalled = true;
        }),
      ),
    ).rejects.toMatchObject({ name: 'MeshApplyError', outcome: 'notApplied' });
    expect(callbackCalled).toBe(false);
    expect(readFileSync(refLock, 'utf8')).toBe('external ref lock');
    expect(git(repoDir, 'rev-parse', 'HEAD')).toBe(baseCommit);
  });

  it('rejects a merge or rebase in progress', async () => {
    const { repoDir, baseCommit, targetCommit } = makeRepo();
    writeFileSync(join(repoDir, '.git', 'MERGE_HEAD'), targetCommit);

    await expect(
      applyVerifiedFastForward(inputFor(repoDir, baseCommit, targetCommit)),
    ).rejects.toMatchObject({
      name: 'MeshApplyError',
      outcome: 'notApplied',
      recovery: 'attention',
    });
    expect(git(repoDir, 'rev-parse', 'HEAD')).toBe(baseCommit);
  });

  it('leaves the checkout unchanged when durable intent cannot be saved', async () => {
    const { repoDir, baseCommit, targetCommit } = makeRepo();
    const indexBefore = readFileSync(join(repoDir, '.git', 'index'));
    let callbackSawLocks = false;

    await expect(
      applyVerifiedFastForward(
        inputFor(repoDir, baseCommit, targetCommit, async () => {
          callbackSawLocks =
            existsSync(join(repoDir, '.git', 'HEAD.lock')) &&
            existsSync(join(repoDir, '.git', 'index.lock')) &&
            existsSync(join(repoDir, '.git', 'refs', 'heads', 'main.lock'));
          throw new Error('database unavailable');
        }),
      ),
    ).rejects.toMatchObject({
      name: 'MeshApplyError',
      outcome: 'notApplied',
      recovery: 'retry',
    });

    expect(callbackSawLocks).toBe(true);
    expect(git(repoDir, 'rev-parse', 'HEAD')).toBe(baseCommit);
    expect(readFileSync(join(repoDir, '.git', 'index')).equals(indexBefore)).toBe(true);
    expect(readFileSync(join(repoDir, 'tracked.txt'), 'utf8')).toBe('base\n');
    expect(existsSync(join(repoDir, '.git', 'HEAD.lock'))).toBe(false);
    expect(existsSync(join(repoDir, '.git', 'index.lock'))).toBe(false);
    expect(existsSync(join(repoDir, '.git', 'refs', 'heads', 'main.lock'))).toBe(false);
  });

  it('catches a checkout change made by the durable-intent callback', async () => {
    const { repoDir, baseCommit, targetCommit } = makeRepo();

    const error = await applyVerifiedFastForward(
      inputFor(repoDir, baseCommit, targetCommit, async () => {
        writeFileSync(join(repoDir, 'tracked.txt'), 'changed by callback\n');
      }),
    ).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(MeshApplyError);
    expect(error).toMatchObject({ outcome: 'notApplied', recovery: 'attention' });
    expect(git(repoDir, 'rev-parse', 'HEAD')).toBe(baseCommit);
    expect(readFileSync(join(repoDir, 'tracked.txt'), 'utf8')).toBe('changed by callback\n');
  });
});
