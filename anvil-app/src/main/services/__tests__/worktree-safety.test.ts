import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addWorktree, removeWorktree } from '../git.service.js';
import { scanForRepos, scanForReposAsync } from '../repo-scan.service.js';

let root: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-worktrees-'));
  repo = path.join(root, 'source');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Worktree tests');
  git(repo, 'config', 'user.email', 'worktrees@example.test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'test: initial commit');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('worktree safety with real Git repositories', () => {
  it('isolates concurrent edits, indexes, and branches from the source checkout', async () => {
    const first = path.join(root, 'run', 'first');
    const second = path.join(root, 'run', 'second');
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'source changes\n');
    await Promise.all([
      addWorktree(repo, first, 'feature/first', 'main'),
      addWorktree(repo, second, 'feature/second', 'main'),
    ]);
    fs.writeFileSync(path.join(first, 'shared.txt'), 'first changes\n');
    git(first, 'add', 'shared.txt');
    expect(git(first, 'diff', '--cached')).toContain('first changes');
    expect(git(second, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'diff', '--cached')).toBe('');
    expect(fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8')).toBe('source changes\n');
    expect(git(repo, 'branch', '--show-current')).toBe('main');
    await removeWorktree(repo, second);
    expect(fs.existsSync(first)).toBe(true);
    expect(git(first, 'branch', '--show-current')).toBe('feature/first');
  });

  it('rejects a branch collision without resetting existing commits', async () => {
    git(repo, 'checkout', '-b', 'feature/existing');
    git(repo, 'commit', '--allow-empty', '-m', 'test: preserve branch tip');
    const tip = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', 'main');
    await expect(
      addWorktree(repo, path.join(root, 'collision'), 'feature/existing', 'main'),
    ).rejects.toThrow();
    expect(git(repo, 'rev-parse', 'feature/existing')).toBe(tip);
  });

  it('retains dirty and locked worktrees when removal is requested', async () => {
    const dirty = path.join(root, 'dirty');
    const locked = path.join(root, 'locked');
    await addWorktree(repo, dirty, 'feature/dirty');
    await addWorktree(repo, locked, 'feature/locked');
    fs.writeFileSync(path.join(dirty, 'untracked.txt'), 'keep this');
    git(repo, 'worktree', 'lock', locked);
    await expect(removeWorktree(repo, dirty)).rejects.toThrow();
    await expect(removeWorktree(repo, locked)).rejects.toThrow();
    expect(fs.readFileSync(path.join(dirty, 'untracked.txt'), 'utf8')).toBe('keep this');
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(locked);
  });
});

describe('linked worktree discovery', () => {
  it('finds a selected worktree and worktrees within a parent in both scanners', async () => {
    const worktree = path.join(root, 'linked');
    await addWorktree(repo, worktree, 'feature/linked');
    expect(fs.statSync(path.join(worktree, '.git')).isFile()).toBe(true);
    const expected = { path: worktree, name: 'linked' };
    expect(scanForRepos(worktree)).toEqual([expected]);
    const found: unknown[] = [];
    expect(await scanForReposAsync(worktree, 4, (entry) => found.push(entry))).toEqual([expected]);
    expect(found).toEqual([expected]);
    expect(scanForRepos(root)).toEqual(
      expect.arrayContaining([expected, { path: repo, name: 'source' }]),
    );
    expect(await scanForReposAsync(root)).toEqual(scanForRepos(root));
  });
});
