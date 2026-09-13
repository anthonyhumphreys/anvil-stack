// FLOW-01: per-attempt worktrees (spec §451-455).
//
// Every write-capable attempt gets its own branch + linked worktree per
// pinned repository, allocated FROM the pinned commit — never by resetting
// an existing ref. Worktrees preserve work across crashes: a dead attempt's
// tree stays on disk for inspection, and a retried attempt allocates a
// FRESH tree keyed to its own attempt id rather than inheriting residue.
//
// Invariants enforced here:
//   - `git worktree add -b` only — no `-B` resets, no forced removal in
//     the normal path (spec §451). A name collision fails the attempt.
//   - Operations that mutate shared repository refs serialize on the
//     source checkout path — concurrent `worktree add`s to one repo race
//     on .git lockfiles otherwise.
//   - Worktrees isolate file edits ONLY: they share the repo's object
//     store and refs namespace, and provide no credential/process/network
//     isolation. Provider sandbox policy is the executor's concern.
//   - Disposal is explicit (disposeAttemptWorktrees); nothing here runs
//     automatically — preserved branches/worktrees are the evidence.

import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { meshExecEnv } from './agent-spawn-env.js';

const execFileAsync = promisify(execFile);

export interface AttemptRepoWorktree {
  /** Manifest-pinned repository identity (workspace portable id). */
  repositoryId: string;
  /** The prepared checkout the worktree links from. */
  sourcePath: string;
  worktreePath: string;
  /** `mesh/attempt/<attemptId>` — unique per attempt, per-repo namespace. */
  branch: string;
  baseCommit: string;
}

export interface FinalizedRepoWorktree extends AttemptRepoWorktree {
  resultCommit: string;
  changed: boolean;
  /** The executor committed uncommitted residue so no work is lost. */
  residualCommitted: boolean;
}

export interface VerificationOutcome {
  repositoryId: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Bounded tail of combined output for the journal/result. */
  logTail: string;
}

const GIT_TIMEOUT_MS = 30_000;
const VERIFICATION_TIMEOUT_MS = 5 * 60_000;
const LOG_TAIL_BYTES = 4 * 1024;

/**
 * Serializes ref-mutating git operations per source checkout (spec §451:
 * "serialize operations that modify shared repository refs"). Attempt
 * worktree creation and residue commits both update the shared ref/object
 * store, so they chain on the same per-repo lane.
 */
const repoRefLocks = new Map<string, Promise<unknown>>();

export async function withRepoRefLock<T>(sourcePath: string, fn: () => Promise<T>): Promise<T> {
  const prior = repoRefLocks.get(sourcePath) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  repoRefLocks.set(
    sourcePath,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function gitEnv(): Record<string, string> {
  return { ...meshExecEnv(), GIT_TERMINAL_PROMPT: '0' };
}

export async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    env: gitEnv(),
  });
  return String(stdout);
}

const git = runGit;

/** Branch/path component safe for refs and filesystems. */
function sanitizeComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

/**
 * Allocates one linked worktree per repository, each on a fresh
 * `mesh/attempt/<attemptId>` branch created at the pinned commit. Any
 * failure leaves earlier allocations preserved (the caller journals them)
 * — cleanup of a failed allocation is explicit disposal, never force.
 */
export async function allocateAttemptWorktrees(input: {
  attemptId: string;
  /** Attempt-scoped parent dir, e.g. <userData>/mesh-worktrees/<attemptId>. */
  rootDir: string;
  repositories: Array<{ repositoryId: string; sourcePath: string; commit: string }>;
  /** Ref namespace — `mesh/attempt` for attempts, `mesh/integrate` for integration runs. */
  branchPrefix?: string;
  onAllocated?: (worktree: AttemptRepoWorktree) => void;
}): Promise<AttemptRepoWorktree[]> {
  mkdirSync(input.rootDir, { recursive: true });
  const branchPrefix = input.branchPrefix ?? 'mesh/attempt';
  const allocated: AttemptRepoWorktree[] = [];
  for (const [index, repo] of input.repositories.entries()) {
    const worktree = await withRepoRefLock(repo.sourcePath, async () => {
      const branch = `${branchPrefix}/${input.attemptId}`;
      const worktreePath = join(
        input.rootDir,
        `${index}-${sanitizeComponent(repo.repositoryId)}`,
      );
      // `add -b` fails if the branch already exists — the correct outcome:
      // a collision means the attempt id is not unique and retrying with
      // `-B` would silently destroy whatever that branch points at.
      await git(repo.sourcePath, ['worktree', 'add', '-b', branch, worktreePath, repo.commit]);
      return {
        repositoryId: repo.repositoryId,
        sourcePath: repo.sourcePath,
        worktreePath,
        branch,
        baseCommit: repo.commit,
      };
    });
    allocated.push(worktree);
    input.onAllocated?.(worktree);
  }
  return allocated;
}

/**
 * Commits any uncommitted residue onto the attempt branch (preserving
 * work the provider left in the tree) and captures the result commit.
 * Returns base→result pins per repo; unchanged trees report
 * `resultCommit === baseCommit`.
 */
export async function finalizeAttemptWorktrees(
  worktrees: AttemptRepoWorktree[],
  attemptId: string,
): Promise<FinalizedRepoWorktree[]> {
  const finalized: FinalizedRepoWorktree[] = [];
  for (const worktree of worktrees) {
    const result = await withRepoRefLock(worktree.sourcePath, async () => {
      const status = await git(worktree.worktreePath, ['status', '--porcelain']);
      let residualCommitted = false;
      if (status.trim().length > 0) {
        await git(worktree.worktreePath, ['add', '-A']);
        await git(worktree.worktreePath, [
          '-c',
          'user.name=Anvil Mesh',
          '-c',
          'user.email=mesh@anvil.local',
          'commit',
          '-m',
          `wip(mesh): attempt ${attemptId} residual changes`,
        ]);
        residualCommitted = true;
      }
      const head = (await git(worktree.worktreePath, ['rev-parse', 'HEAD'])).trim();
      return {
        ...worktree,
        resultCommit: head,
        changed: head !== worktree.baseCommit,
        residualCommitted,
      };
    });
    finalized.push(result);
  }
  return finalized;
}

/**
 * Packs the attempt branch as a thin git bundle rooted on the pinned
 * base commit — the fetchable form of the result (spec §455: code moves
 * through Git refs; the bundle is the ref transport over artifacts).
 * The receiver provably holds the base objects: it pinned them.
 */
export async function createAttemptBundle(
  worktree: AttemptRepoWorktree,
  bundlePath: string,
): Promise<{ bundlePath: string; ref: string }> {
  await withRepoRefLock(worktree.sourcePath, async () => {
    await git(worktree.worktreePath, [
      'bundle',
      'create',
      bundlePath,
      `${worktree.baseCommit}..${worktree.branch}`,
    ]);
  });
  return { bundlePath, ref: worktree.branch };
}

/**
 * Explicit disposal of an attempt's worktrees (spec §457: preserve until
 * explicit disposal or an approved retention policy). Non-forced
 * `worktree remove` refuses on a dirty tree — the caller must finalize
 * first or keep the evidence. The attempt branch is deleted with `-d`
 * (safe: refuses when unmerged).
 */
export async function disposeAttemptWorktrees(worktrees: AttemptRepoWorktree[]): Promise<void> {
  for (const worktree of worktrees) {
    await withRepoRefLock(worktree.sourcePath, async () => {
      await git(worktree.sourcePath, ['worktree', 'remove', worktree.worktreePath]);
      await git(worktree.sourcePath, ['branch', '-d', worktree.branch]);
    });
  }
}

/**
 * Runs one declared verification command in a worktree under the
 * restricted mesh exec env (no provider/git credentials — the command
 * text is remote-authored). Honest outcomes: exit code, timeout, and a
 * bounded output tail are recorded, never summarized away.
 */
export async function runVerificationCommand(input: {
  repositoryId: string;
  command: string;
  cwd: string;
  timeoutMs?: number;
}): Promise<VerificationOutcome> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? VERIFICATION_TIMEOUT_MS;
  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-c', input.command], {
      cwd: input.cwd,
      timeout: timeoutMs,
      env: meshExecEnv(),
      maxBuffer: 16 * 1024 * 1024,
    });
    const tail = (String(stdout) + String(stderr)).slice(-LOG_TAIL_BYTES);
    return {
      repositoryId: input.repositoryId,
      command: input.command,
      exitCode: 0,
      timedOut: false,
      durationMs: Date.now() - started,
      logTail: tail,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      code?: number | string;
      killed?: boolean;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    const timedOut = err.killed === true || err.code === 'ETIMEDOUT';
    const tail = (String(err.stdout ?? '') + String(err.stderr ?? '')).slice(-LOG_TAIL_BYTES);
    return {
      repositoryId: input.repositoryId,
      command: input.command,
      exitCode: typeof err.code === 'number' ? err.code : null,
      timedOut,
      durationMs: Date.now() - started,
      logTail: tail,
    };
  }
}

/** Test seam: clears the per-repo ref lanes. */
export function resetMeshWorktreesForTests(): void {
  repoRefLocks.clear();
}
