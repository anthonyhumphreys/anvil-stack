import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  requireRemoteReviewCandidateCapability,
  requireRemoteReviewCandidateReadOnly,
  supportsRemoteReviewCandidate,
  validateRemoteReviewCandidates,
  type RemoteReviewCandidate,
} from '../../../shared/remote-review-candidate.js';
import {
  captureRemoteReviewCandidate,
  materializeRemoteReviewCandidate,
  RemoteReviewCandidateError,
} from '../remote-review-candidate.service.js';

let root = '';
let repositoryPath = '';
let baseCommit = '';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function setupRepository(): void {
  root = mkdtempSync(join(tmpdir(), 'mezair-review-candidate-test-'));
  repositoryPath = join(root, 'repo');
  mkdirSync(join(repositoryPath, 'src'), { recursive: true });
  git(root, ['init', '-q', 'repo']);
  git(repositoryPath, ['config', 'user.name', 'Candidate Test']);
  git(repositoryPath, ['config', 'user.email', 'candidate-test@example.invalid']);
  writeFileSync(join(repositoryPath, 'src', 'review.ts'), 'export const value = "base";\n');
  writeFileSync(join(repositoryPath, 'src', 'other.ts'), 'export const other = "base";\n');
  writeFileSync(join(repositoryPath, 'config.txt'), 'API_TOKEN=placeholder\n');
  git(repositoryPath, ['add', '--all']);
  git(repositoryPath, ['commit', '-qm', 'base']);
  baseCommit = git(repositoryPath, ['rev-parse', 'HEAD']);
}

beforeEach(() => setupRepository());

afterEach(() => {
  if (root.length > 0) rmSync(root, { recursive: true, force: true });
});

function candidateError(promise: Promise<unknown>, code: string): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code });
}

describe('remote review candidate capture', () => {
  it('freezes only selected tracked worktree bytes without touching the real index', async () => {
    const selected = join(repositoryPath, 'src', 'review.ts');
    writeFileSync(selected, 'export const value = "captured";\n');
    writeFileSync(
      join(repositoryPath, 'src', 'other.ts'),
      'export const other = "staged-secret-never-sent";\n',
    );
    git(repositoryPath, ['add', 'src/other.ts']);
    writeFileSync(
      join(repositoryPath, 'src', 'untracked.ts'),
      'export const value = "untracked-secret-never-sent";\n',
    );
    const stagedBefore = git(repositoryPath, ['diff', '--cached', '--full-index']);
    const statusBefore = git(repositoryPath, ['status', '--porcelain', '--untracked-files=all']);

    const candidate = await captureRemoteReviewCandidate({
      repositoryId: 'repo-1',
      repositoryPath,
      selectedPaths: ['src/review.ts'],
      baseCommit,
    });
    expect(candidate.includedPaths).toEqual(['src/review.ts']);
    expect(candidate.patch).toContain('captured');
    expect(candidate.patch).not.toContain('staged-secret-never-sent');
    expect(candidate.patch).not.toContain('untracked-secret-never-sent');
    expect(candidate.baseCommit).toBe(baseCommit);
    expect(git(repositoryPath, ['diff', '--cached', '--full-index'])).toBe(stagedBefore);
    expect(git(repositoryPath, ['status', '--porcelain', '--untracked-files=all'])).toBe(
      statusBefore,
    );

    // A later edit cannot alter the already captured approval source.
    writeFileSync(selected, 'export const value = "edited-after-capture";\n');
    const workerRepo = join(root, 'worker-repo');
    execFileSync('git', ['clone', '-q', '--no-hardlinks', repositoryPath, workerRepo]);
    git(workerRepo, ['checkout', '-q', baseCommit]);
    const materialized = await materializeRemoteReviewCandidate({
      candidate,
      repositoryPath: workerRepo,
    });

    expect(readFileSync(join(workerRepo, 'src', 'review.ts'), 'utf8')).toContain('captured');
    expect(readFileSync(join(workerRepo, 'src', 'review.ts'), 'utf8')).not.toContain(
      'edited-after-capture',
    );
    expect(git(workerRepo, ['rev-parse', 'HEAD'])).toBe(candidate.candidateCommit);
    expect(git(workerRepo, ['rev-parse', 'HEAD^{tree}'])).toBe(candidate.candidateTree);
    expect(git(workerRepo, ['status', '--porcelain'])).toBe('');
    expect(materialized).toEqual({
      repositoryId: 'repo-1',
      baseCommit,
      candidateCommit: candidate.candidateCommit,
    });
  });

  it('includes explicitly staged new files while excluding untracked files', async () => {
    const addedPath = join(repositoryPath, 'src', 'added.ts');
    writeFileSync(addedPath, 'export const added = "staged addition";\n');
    git(repositoryPath, ['add', 'src/added.ts']);
    writeFileSync(
      join(repositoryPath, 'src', 'untracked.ts'),
      'export const ignored = "untracked secret text";\n',
    );
    const statusBefore = git(repositoryPath, ['status', '--porcelain', '--untracked-files=all']);
    const candidate = await captureRemoteReviewCandidate({
      repositoryId: 'repo-1',
      repositoryPath,
      selectedPaths: ['src/added.ts'],
      baseCommit,
    });

    expect(candidate.includedPaths).toEqual(['src/added.ts']);
    expect(candidate.patch).toContain('staged addition');
    expect(candidate.patch).not.toContain('untracked secret text');
    expect(git(repositoryPath, ['status', '--porcelain', '--untracked-files=all'])).toBe(
      statusBefore,
    );

    const workerRepo = join(root, 'worker-added-repo');
    execFileSync('git', ['clone', '-q', '--no-hardlinks', repositoryPath, workerRepo]);
    git(workerRepo, ['checkout', '-q', baseCommit]);
    await materializeRemoteReviewCandidate({ candidate, repositoryPath: workerRepo });
    expect(readFileSync(join(workerRepo, 'src', 'added.ts'), 'utf8')).toContain('staged addition');
    expect(git(workerRepo, ['rev-parse', 'HEAD^{tree}'])).toBe(candidate.candidateTree);
  });

  it('captures and materializes a selected tracked deletion', async () => {
    const deletedPath = join(repositoryPath, 'src', 'other.ts');
    rmSync(deletedPath);
    const statusBefore = git(repositoryPath, ['status', '--porcelain', '--untracked-files=all']);
    const candidate = await captureRemoteReviewCandidate({
      repositoryId: 'repo-1',
      repositoryPath,
      selectedPaths: ['src/other.ts'],
      baseCommit,
    });

    expect(candidate.includedPaths).toEqual(['src/other.ts']);
    expect(candidate.patch).toContain('deleted file mode');
    expect(git(repositoryPath, ['status', '--porcelain', '--untracked-files=all'])).toBe(
      statusBefore,
    );

    const workerRepo = join(root, 'worker-deleted-repo');
    execFileSync('git', ['clone', '-q', '--no-hardlinks', repositoryPath, workerRepo]);
    git(workerRepo, ['checkout', '-q', baseCommit]);
    await materializeRemoteReviewCandidate({ candidate, repositoryPath: workerRepo });
    expect(() => readFileSync(join(workerRepo, 'src', 'other.ts'))).toThrow();
    expect(git(workerRepo, ['rev-parse', 'HEAD^{tree}'])).toBe(candidate.candidateTree);
  });

  it('rejects secrets on removed and added patch lines without returning the value', async () => {
    const secret = 'abc123secretvalue987';
    writeFileSync(join(repositoryPath, 'config.txt'), `API_TOKEN=${secret}\n`);
    git(repositoryPath, ['add', 'config.txt']);
    git(repositoryPath, ['commit', '-qm', 'secret base']);
    const secretBase = git(repositoryPath, ['rev-parse', 'HEAD']);
    writeFileSync(join(repositoryPath, 'config.txt'), 'API_TOKEN=placeholder\n');

    const removed = captureRemoteReviewCandidate({
      repositoryId: 'repo-1',
      repositoryPath,
      selectedPaths: ['config.txt'],
      baseCommit: secretBase,
    });
    const removedError = await removed.catch((error: unknown) => error);
    expect(removedError).toBeInstanceOf(RemoteReviewCandidateError);
    expect(removedError).toMatchObject({ code: 'remote-review-candidate-secret-content' });
    expect((removedError as Error).message).not.toContain(secret);

    writeFileSync(join(repositoryPath, 'config.txt'), 'API_TOKEN=placeholder\n');
    git(repositoryPath, ['add', 'config.txt']);
    git(repositoryPath, ['commit', '-qm', 'safe base']);
    const safeBase = git(repositoryPath, ['rev-parse', 'HEAD']);
    writeFileSync(join(repositoryPath, 'config.txt'), `API_TOKEN=${secret}\n`);
    await candidateError(
      captureRemoteReviewCandidate({
        repositoryId: 'repo-1',
        repositoryPath,
        selectedPaths: ['config.txt'],
        baseCommit: safeBase,
      }),
      'remote-review-candidate-secret-content',
    );
  });

  it('rejects secret paths, untracked paths, binary patches, and empty selections', async () => {
    writeFileSync(join(repositoryPath, '.env.local'), 'TOKEN=private\n');
    await candidateError(
      captureRemoteReviewCandidate({
        repositoryId: 'repo-1',
        repositoryPath,
        selectedPaths: ['.env.local'],
        baseCommit,
      }),
      'remote-review-candidate-invalid-selection',
    );
    await candidateError(
      captureRemoteReviewCandidate({
        repositoryId: 'repo-1',
        repositoryPath,
        selectedPaths: ['src/missing.ts'],
        baseCommit,
      }),
      'remote-review-candidate-untracked-or-unsupported-file',
    );
    await candidateError(
      captureRemoteReviewCandidate({
        repositoryId: 'repo-1',
        repositoryPath,
        selectedPaths: [],
        baseCommit,
      }),
      'remote-review-candidate-invalid-selection',
    );
    writeFileSync(join(repositoryPath, 'src', 'other.ts'), Buffer.from([0, 1, 2, 3]));
    await candidateError(
      captureRemoteReviewCandidate({
        repositoryId: 'repo-1',
        repositoryPath,
        selectedPaths: ['src/other.ts'],
        baseCommit,
      }),
      'remote-review-candidate-binary-file',
    );
  });

  it('rejects tampered patches and aggregate payloads above the bounded budget', async () => {
    writeFileSync(join(repositoryPath, 'src', 'review.ts'), 'export const value = "candidate";\n');
    const candidate = await captureRemoteReviewCandidate({
      repositoryId: 'repo-1',
      repositoryPath,
      selectedPaths: ['src/review.ts'],
      baseCommit,
    });
    const workerRepo = join(root, 'worker-repo');
    execFileSync('git', ['clone', '-q', '--no-hardlinks', repositoryPath, workerRepo]);
    git(workerRepo, ['checkout', '-q', baseCommit]);
    await candidateError(
      materializeRemoteReviewCandidate({
        candidate: { ...candidate, patch: `${candidate.patch}tampered` },
        repositoryPath: workerRepo,
      }),
      'remote-review-candidate-patch-digest-mismatch',
    );

    const largeCandidate = (repositoryId: string): RemoteReviewCandidate => ({
      ...candidate,
      repositoryId,
      patch: 'x'.repeat(70 * 1024),
    });
    expect(() =>
      validateRemoteReviewCandidates([largeCandidate('repo-1'), largeCandidate('repo-2')], {
        readOnly: true,
      }),
    ).toThrow('remote-review-candidate-too-large');
  });

  it('requires exact read-only mode and the advertised candidate capability', () => {
    expect(() => requireRemoteReviewCandidateReadOnly('on-request')).toThrow(
      'remote-review-candidate-read-only-required',
    );
    expect(() => requireRemoteReviewCandidateCapability(['workflow-node'])).toThrow(
      'remote-review-candidate-capability-unsupported',
    );
    expect(supportsRemoteReviewCandidate(['remote-review-candidate/v1'])).toBe(true);
  });
});
