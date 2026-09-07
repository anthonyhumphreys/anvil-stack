import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureReviewSnapshot, reviewGit } from '../review-snapshot.service.js';
const paths: string[] = [];
afterEach(() => paths.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
function repo(): string {
  const path = mkdtempSync(join(tmpdir(), 'anvil-snapshot-test-'));
  paths.push(path);
  reviewGit(path, ['init']);
  reviewGit(path, ['config', 'user.name', 'Test']);
  reviewGit(path, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(path, 'file.txt'), 'base');
  writeFileSync(join(path, '.gitignore'), 'ignored.txt\n');
  reviewGit(path, ['add', '.']);
  reviewGit(path, ['commit', '-m', 'test: seed']);
  return path;
}
describe('review source snapshots', () => {
  it('binds staged, unstaged and untracked content without changing the real index or HEAD', () => {
    const path = repo();
    const original = captureReviewSnapshot(path);
    const head = reviewGit(path, ['rev-parse', 'HEAD']);
    writeFileSync(join(path, 'file.txt'), 'staged');
    reviewGit(path, ['add', 'file.txt']);
    const index = readFileSync(join(path, '.git/index'));
    writeFileSync(join(path, 'file.txt'), 'unstaged');
    writeFileSync(join(path, 'new.txt'), 'untracked');
    const changed = captureReviewSnapshot(path);
    expect(changed.tree).not.toBe(original.tree);
    expect(captureReviewSnapshot(path).tree).toBe(changed.tree);
    expect(readFileSync(join(path, '.git/index'))).toEqual(index);
    expect(reviewGit(path, ['rev-parse', 'HEAD'])).toBe(head);
    expect(reviewGit(path, ['show', `${changed.tree}:file.txt`])).toBe('unstaged');
    expect(reviewGit(path, ['show', `${changed.tree}:new.txt`])).toBe('untracked');
  });
  it('records deletions and ignores ignored files', () => {
    const path = repo();
    const original = captureReviewSnapshot(path);
    writeFileSync(join(path, 'ignored.txt'), 'private');
    expect(captureReviewSnapshot(path).tree).toBe(original.tree);
    rmSync(join(path, 'file.txt'));
    expect(captureReviewSnapshot(path).tree).not.toBe(original.tree);
  });
});
