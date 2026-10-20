import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertWorkflowSourceSnapshot } from '../workflow-source-snapshot';

describe('remote workflow source snapshot', () => {
  let path: string;
  let commit: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: path, encoding: 'utf8' }).trim();
  beforeEach(() => {
    path = mkdtempSync(join(tmpdir(), 'anvil-workflow-source-'));
    git('init', '--quiet');
    git('config', 'user.name', 'Anvil test');
    git('config', 'user.email', 'test@localhost');
    writeFileSync(join(path, 'input.txt'), 'Original input');
    git('add', '.');
    git('commit', '--quiet', '-m', 'Initial');
    commit = git('rev-parse', 'HEAD');
  });
  afterEach(() => rmSync(path, { recursive: true, force: true }));
  const check = () => assertWorkflowSourceSnapshot([{ repositoryId: 'app', commit, path }]);

  it('accepts the exact clean commit', () => expect(check).not.toThrow());
  it('rejects tracked edits and staging without changing them', () => {
    writeFileSync(join(path, 'input.txt'), 'Local edit');
    expect(check).toThrow('has changed locally');
    git('add', '.');
    expect(check).toThrow('has changed locally');
    expect(git('diff', '--cached')).toContain('Local edit');
  });
  it('rejects untracked inputs', () => {
    writeFileSync(join(path, 'new-input.txt'), 'Not in the commit');
    expect(check).toThrow('has changed locally');
  });
  it('rejects a different committed revision', () => {
    git('commit', '--quiet', '--allow-empty', '-m', 'Next');
    expect(check).toThrow('start a new run');
  });
  it('fails closed when the source checkout is unavailable', () => {
    expect(() =>
      assertWorkflowSourceSnapshot([{ repositoryId: 'app', commit, path: undefined }]),
    ).toThrow('no source checkout');
    expect(() =>
      assertWorkflowSourceSnapshot([{ repositoryId: 'app', commit, path: join(path, 'missing') }]),
    ).toThrow('Could not verify');
  });
});
