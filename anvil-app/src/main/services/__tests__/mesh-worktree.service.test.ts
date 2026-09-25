import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  getAllWindows: vi.fn(() => [{ isVisible: () => true, isMinimized: () => false }]),
  getFocusedWindow: vi.fn(() => null),
  showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
}));

vi.mock('electron', () => ({
  app: { isReady: () => true },
  BrowserWindow: {
    getAllWindows: electronMocks.getAllWindows,
    getFocusedWindow: electronMocks.getFocusedWindow,
  },
  dialog: { showMessageBox: electronMocks.showMessageBox },
}));
import {
  allocateAttemptWorktrees,
  disposeAttemptWorktrees,
  finalizeAttemptWorktrees,
  resetMeshWorktreesForTests,
  runVerificationCommand,
} from '../mesh-worktree.service';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString().trim();
}

function makeSourceRepo(suffix: string): { repoDir: string; head: string } {
  const repoDir = mkdtempSync(join(tmpdir(), `anvil-wt-src-${suffix}-`));
  git(repoDir, 'init');
  git(
    repoDir,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '--allow-empty',
    '-m',
    'init',
  );
  writeFileSync(join(repoDir, 'file.txt'), 'base');
  git(repoDir, 'add', 'file.txt');
  git(repoDir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'add file');
  return { repoDir, head: git(repoDir, 'rev-parse', 'HEAD') };
}

beforeEach(() => {
  resetMeshWorktreesForTests();
  electronMocks.getAllWindows.mockReturnValue([
    { isVisible: () => true, isMinimized: () => false },
  ]);
  electronMocks.getFocusedWindow.mockReturnValue(null);
  electronMocks.showMessageBox.mockReset().mockResolvedValue({ response: 0 });
});

describe('allocateAttemptWorktrees', () => {
  it('creates a linked worktree on a fresh attempt branch at the pinned commit', async () => {
    const { repoDir, head } = makeSourceRepo('alloc');
    const root = mkdtempSync(join(tmpdir(), 'anvil-wt-root-'));
    try {
      const [wt] = await allocateAttemptWorktrees({
        attemptId: 'att-1',
        rootDir: root,
        repositories: [{ repositoryId: 'p-1', sourcePath: repoDir, commit: head }],
      });
      expect(wt!.branch).toBe('mesh/attempt/att-1');
      expect(existsSync(join(wt!.worktreePath, 'file.txt'))).toBe(true);
      expect(git(wt!.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
      // The source checkout is untouched: still on its own branch at HEAD.
      expect(git(repoDir, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(repoDir, 'status', '--porcelain')).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('isolates concurrent attempts — each attempt id names its own tree', async () => {
    const { repoDir, head } = makeSourceRepo('two');
    const root = mkdtempSync(join(tmpdir(), 'anvil-wt-root-'));
    try {
      const [a] = await allocateAttemptWorktrees({
        attemptId: 'att-A',
        rootDir: join(root, 'att-A'),
        repositories: [{ repositoryId: 'p-1', sourcePath: repoDir, commit: head }],
      });
      const [b] = await allocateAttemptWorktrees({
        attemptId: 'att-B',
        rootDir: join(root, 'att-B'),
        repositories: [{ repositoryId: 'p-1', sourcePath: repoDir, commit: head }],
      });
      // Writes in attempt A never appear in attempt B or the source.
      writeFileSync(join(a!.worktreePath, 'a-only.txt'), 'A');
      expect(existsSync(join(b!.worktreePath, 'a-only.txt'))).toBe(false);
      expect(existsSync(join(repoDir, 'a-only.txt'))).toBe(false);
      expect(git(repoDir, 'branch', '--list', 'mesh/attempt/*')).toContain('mesh/attempt/att-A');
      expect(git(repoDir, 'branch', '--list', 'mesh/attempt/*')).toContain('mesh/attempt/att-B');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('serializes ref mutations — concurrent allocations on one repo both land', async () => {
    const { repoDir, head } = makeSourceRepo('race');
    const root = mkdtempSync(join(tmpdir(), 'anvil-wt-root-'));
    try {
      const [r1, r2, r3] = await Promise.all(
        ['att-1', 'att-2', 'att-3'].map((attemptId) =>
          allocateAttemptWorktrees({
            attemptId,
            rootDir: join(root, attemptId),
            repositories: [{ repositoryId: 'p-1', sourcePath: repoDir, commit: head }],
          }),
        ),
      );
      expect([r1, r2, r3].every((r) => r !== undefined && existsSync(r[0]!.worktreePath))).toBe(
        true,
      );
      const branches = git(repoDir, 'branch', '--list', 'mesh/attempt/*');
      for (const id of ['att-1', 'att-2', 'att-3']) {
        expect(branches).toContain(`mesh/attempt/${id}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('fails on a branch-name collision instead of resetting the existing ref', async () => {
    const { repoDir, head } = makeSourceRepo('collide');
    const root = mkdtempSync(join(tmpdir(), 'anvil-wt-root-'));
    try {
      // A prior (dead) attempt's preserved branch occupies the name.
      git(repoDir, 'branch', 'mesh/attempt/att-1', head);
      await expect(
        allocateAttemptWorktrees({
          attemptId: 'att-1',
          rootDir: root,
          repositories: [{ repositoryId: 'p-1', sourcePath: repoDir, commit: head }],
        }),
      ).rejects.toThrow();
      // The pre-existing ref is untouched.
      expect(git(repoDir, 'rev-parse', 'mesh/attempt/att-1')).toBe(head);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('finalizeAttemptWorktrees', () => {
  it('reports an unchanged result when the turn left nothing behind', async () => {
    const { repoDir, head } = makeSourceRepo('clean-fin');
    const root = mkdtempSync(join(tmpdir(), 'anvil-wt-root-'));
    try {
      const worktrees = await allocateAttemptWorktrees({
        attemptId: 'att-1',
        rootDir: root,
        repositories: [{ repositoryId: 'p-1', sourcePath: repoDir, commit: head }],
      });
      const [fin] = await finalizeAttemptWorktrees(worktrees, 'att-1');
      expect(fin!.resultCommit).toBe(head);
      expect(fin!.changed).toBe(false);
      expect(fin!.residualCommitted).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('commits residual changes so no work is lost, and records the new tip', async () => {
    const { repoDir, head } = makeSourceRepo('residual');
    const root = mkdtempSync(join(tmpdir(), 'anvil-wt-root-'));
    try {
      const worktrees = await allocateAttemptWorktrees({
        attemptId: 'att-1',
        rootDir: root,
        repositories: [{ repositoryId: 'p-1', sourcePath: repoDir, commit: head }],
      });
      writeFileSync(join(worktrees[0]!.worktreePath, 'feature.ts'), 'export const x = 1;');
      writeFileSync(join(worktrees[0]!.worktreePath, 'file.txt'), 'modified');
      const [fin] = await finalizeAttemptWorktrees(worktrees, 'att-1');
      expect(fin!.changed).toBe(true);
      expect(fin!.residualCommitted).toBe(true);
      expect(fin!.resultCommit).not.toBe(head);
      // The residue commit is on the attempt branch in the SOURCE repo's
      // ref namespace — inspectable without the worktree.
      expect(git(repoDir, 'rev-parse', 'mesh/attempt/att-1')).toBe(fin!.resultCommit);
      expect(git(repoDir, 'show', `${fin!.resultCommit}:feature.ts`)).toContain('export const x');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('disposeAttemptWorktrees', () => {
  it('removes the worktree and deletes the attempt branch (explicit disposal)', async () => {
    const { repoDir, head } = makeSourceRepo('dispose');
    const root = mkdtempSync(join(tmpdir(), 'anvil-wt-root-'));
    try {
      const worktrees = await allocateAttemptWorktrees({
        attemptId: 'att-1',
        rootDir: root,
        repositories: [{ repositoryId: 'p-1', sourcePath: repoDir, commit: head }],
      });
      await finalizeAttemptWorktrees(worktrees, 'att-1');
      await disposeAttemptWorktrees(worktrees);
      expect(existsSync(worktrees[0]!.worktreePath)).toBe(false);
      expect(git(repoDir, 'branch', '--list', 'mesh/attempt/*')).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('runVerificationCommand', () => {
  it('records exit code and output tail honestly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-verify-'));
    try {
      const ok = await runVerificationCommand({
        repositoryId: 'p-1',
        command: 'echo hello-verify',
        cwd: dir,
        target: { kind: 'remote-job', jobId: 'job-1', attemptId: 'attempt-1' },
      });
      expect(ok.exitCode).toBe(0);
      expect(ok.approvalGranted).toBe(true);
      expect(ok.timedOut).toBe(false);
      expect(ok.logTail).toContain('hello-verify');
      expect(electronMocks.showMessageBox).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          detail: expect.stringContaining('Mesh job: job-1\nAttempt: attempt-1\n\nRepository: p-1'),
        }),
      );
      expect(electronMocks.showMessageBox.mock.calls[0]?.[1]?.detail).toContain(
        'Command:\necho hello-verify',
      );

      const bad = await runVerificationCommand({
        repositoryId: 'p-1',
        command: 'echo fail-out >&2 && exit 3',
        cwd: dir,
        target: { kind: 'remote-job', jobId: 'job-1', attemptId: 'attempt-1' },
      });
      expect(bad.exitCode).toBe(3);
      expect(bad.logTail).toContain('fail-out');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks a timed-out command instead of inventing success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-verify-'));
    try {
      const outcome = await runVerificationCommand({
        repositoryId: 'p-1',
        command: 'sleep 5',
        cwd: dir,
        target: { kind: 'remote-job', jobId: 'job-timeout', attemptId: 'attempt-timeout' },
        timeoutMs: 300,
      });
      expect(outcome.timedOut).toBe(true);
      expect(outcome.exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not execute a command after local approval is declined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-verify-'));
    const marker = join(dir, 'should-not-exist');
    const command = `touch ${marker}`;
    electronMocks.showMessageBox.mockResolvedValueOnce({ response: 1 });
    try {
      const outcome = await runVerificationCommand({
        repositoryId: 'repo-target',
        command,
        cwd: dir,
        target: { kind: 'remote-job', jobId: 'job-declined', attemptId: 'attempt-declined' },
      });

      expect(outcome).toMatchObject({ approvalGranted: false, exitCode: null, timedOut: false });
      expect(existsSync(marker)).toBe(false);
      const detail = electronMocks.showMessageBox.mock.calls[0]?.[1]?.detail as string;
      expect(detail).toContain('Mesh job: job-declined\nAttempt: attempt-declined');
      expect(detail).toContain('Repository: repo-target');
      expect(detail).toContain(`Command:\n${command}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never runs a remote command without an interactive local approval surface', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-verify-'));
    const marker = join(dir, 'should-not-exist');
    electronMocks.getAllWindows.mockReturnValue([]);
    try {
      const outcome = await runVerificationCommand({
        repositoryId: 'p-1',
        command: `touch ${marker}`,
        cwd: dir,
        target: { kind: 'remote-job', jobId: 'job-unattended', attemptId: 'attempt-unattended' },
      });

      expect(outcome).toMatchObject({
        approvalGranted: false,
        exitCode: null,
        timedOut: false,
      });
      expect(existsSync(marker)).toBe(false);
      expect(electronMocks.showMessageBox).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
