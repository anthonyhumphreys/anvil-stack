import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface VerifiedFastForwardIntent {
  branch: string;
  baseCommit: string;
  targetCommit: string;
  startedAt: string;
}

export interface ApplyVerifiedFastForwardInput {
  repoPath: string;
  expectedBranch: string;
  baseCommit: string;
  targetCommit: string;
  onPrepared: (intent: VerifiedFastForwardIntent) => Promise<void>;
}

export interface VerifiedFastForwardReceipt {
  status: 'applied' | 'alreadyApplied';
  branch: string;
  baseCommit: string;
  targetCommit: string;
}

export type VerifiedFastForwardInspection =
  | {
      status: 'ready' | 'alreadyApplied';
      branch: string;
      baseCommit: string;
      targetCommit: string;
    }
  | {
      status: 'attention';
      branch: string;
      baseCommit: string;
      targetCommit: string;
      reason: string;
    };

export type MeshApplyOutcome = 'notApplied' | 'unknown';
export type MeshApplyRecovery = 'retry' | 'attention';

export class MeshApplyError extends Error {
  readonly outcome: MeshApplyOutcome;
  readonly recovery: MeshApplyRecovery;
  readonly branch: string;
  readonly baseCommit: string;
  readonly targetCommit: string;
  readonly cause?: unknown;

  constructor(
    message: string,
    details: {
      outcome: MeshApplyOutcome;
      recovery: MeshApplyRecovery;
      branch: string;
      baseCommit: string;
      targetCommit: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'MeshApplyError';
    this.outcome = details.outcome;
    this.recovery = details.recovery;
    this.branch = details.branch;
    this.baseCommit = details.baseCommit;
    this.targetCommit = details.targetCommit;
    this.cause = details.cause;
  }
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface GitLayout {
  root: string;
  headPath: string;
  indexPath: string;
}

interface OwnedLock {
  path: string;
  file: Awaited<ReturnType<typeof open>>;
  dev: number;
  ino: number;
  closed: boolean;
  renamed: boolean;
}

interface Assessment {
  status: 'ready' | 'alreadyApplied' | 'attention';
  reason?: string;
}

const HASH_PATTERN = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const OPERATION_STATE_PATHS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-apply',
  'rebase-merge',
  'sequencer/todo',
];
const REF_TRANSACTION_TIMEOUT_MS = 10_000;

function gitEnvironment(indexPath?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_PREFIX',
    'GIT_CEILING_DIRECTORIES',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_SHALLOW_FILE',
    'GIT_GRAFT_FILE',
    'GIT_NAMESPACE',
  ]) {
    delete env[key];
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  if (indexPath) env.GIT_INDEX_FILE = indexPath;
  return env;
}

function runGit(repoPath: string, args: string[], indexPath?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: repoPath,
        env: gitEnvironment(indexPath),
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const result: GitResult = {
          code: error && typeof error.code === 'number' ? error.code : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        };
        if (error && typeof error.code !== 'number') {
          reject(
            new Error(`Could not run git ${args[0] ?? ''}: ${error.message}`, { cause: error }),
          );
          return;
        }
        resolve(result);
      },
    );
  });
}

async function gitOutput(repoPath: string, args: string[], indexPath?: string): Promise<string> {
  const result = await runGit(repoPath, args, indexPath);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0] ?? ''} exited with ${result.code}`);
  }
  return result.stdout.trim();
}

function validateInput(input: ApplyVerifiedFastForwardInput): void {
  if (!input.repoPath || typeof input.repoPath !== 'string') {
    throw new TypeError('A repository path is required.');
  }
  if (!input.expectedBranch || typeof input.expectedBranch !== 'string') {
    throw new TypeError('An expected branch is required.');
  }
  if (!HASH_PATTERN.test(input.baseCommit) || !HASH_PATTERN.test(input.targetCommit)) {
    throw new TypeError('Base and target must be full 40 or 64 character commit IDs.');
  }
  if (typeof input.onPrepared !== 'function') {
    throw new TypeError('A durable onPrepared callback is required.');
  }
}

function normaliseCommit(hash: string): string {
  return hash.toLowerCase();
}

function makeError(
  input: Pick<ApplyVerifiedFastForwardInput, 'expectedBranch' | 'baseCommit' | 'targetCommit'>,
  message: string,
  outcome: MeshApplyOutcome,
  recovery: MeshApplyRecovery,
  cause?: unknown,
): MeshApplyError {
  return new MeshApplyError(message, {
    outcome,
    recovery,
    branch: input.expectedBranch,
    baseCommit: normaliseCommit(input.baseCommit),
    targetCommit: normaliseCommit(input.targetCommit),
    cause,
  });
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getGitLayout(repoPath: string): Promise<GitLayout> {
  const root = await gitOutput(repoPath, ['rev-parse', '--show-toplevel']);
  const headResult = await gitOutput(root, ['rev-parse', '--git-path', 'HEAD']);
  const indexResult = await gitOutput(root, ['rev-parse', '--git-path', 'index']);
  return {
    root,
    headPath: path.isAbsolute(headResult) ? headResult : path.resolve(root, headResult),
    indexPath: path.isAbsolute(indexResult) ? indexResult : path.resolve(root, indexResult),
  };
}

function refName(branch: string): string {
  return `refs/heads/${branch}`;
}

async function resolveCommit(repoPath: string, hash: string): Promise<string | null> {
  const type = await runGit(repoPath, ['cat-file', '-t', hash]);
  if (type.code !== 0 || type.stdout.trim() !== 'commit') return null;
  const resolved = await runGit(repoPath, ['rev-parse', '--verify', `${hash}^{commit}`]);
  if (resolved.code !== 0) return null;
  return normaliseCommit(resolved.stdout.trim());
}

async function hasOperationState(root: string): Promise<boolean> {
  for (const name of OPERATION_STATE_PATHS) {
    const result = await runGit(root, ['rev-parse', '--git-path', name]);
    if (result.code !== 0) continue;
    const resolved = path.isAbsolute(result.stdout.trim())
      ? result.stdout.trim()
      : path.resolve(root, result.stdout.trim());
    try {
      await lstat(resolved);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return false;
}

async function assess(
  layout: GitLayout,
  expectedBranch: string,
  baseCommit: string,
  targetCommit: string,
): Promise<Assessment> {
  const branchFormat = await runGit(layout.root, ['check-ref-format', refName(expectedBranch)]);
  if (branchFormat.code !== 0)
    return { status: 'attention', reason: 'The branch name is invalid.' };

  const base = await resolveCommit(layout.root, baseCommit);
  const target = await resolveCommit(layout.root, targetCommit);
  if (
    !base ||
    !target ||
    base !== normaliseCommit(baseCommit) ||
    target !== normaliseCommit(targetCommit)
  ) {
    return { status: 'attention', reason: 'The base or target is not an available commit.' };
  }

  const ancestor = await runGit(layout.root, ['merge-base', '--is-ancestor', base, target]);
  if (ancestor.code !== 0) {
    return { status: 'attention', reason: 'The target commit is not a descendant of the base.' };
  }

  if (await hasOperationState(layout.root)) {
    return {
      status: 'attention',
      reason: 'The repository has an active merge, rebase, or sequencer.',
    };
  }

  const symbolicHead = await runGit(layout.root, ['symbolic-ref', '--quiet', 'HEAD']);
  if (symbolicHead.code !== 0 || symbolicHead.stdout.trim() !== refName(expectedBranch)) {
    return { status: 'attention', reason: `The checkout is not on branch ${expectedBranch}.` };
  }

  const branchHead = await runGit(layout.root, ['rev-parse', '--verify', refName(expectedBranch)]);
  const head = await runGit(layout.root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (branchHead.code !== 0 || head.code !== 0) {
    return { status: 'attention', reason: 'The expected branch or HEAD cannot be resolved.' };
  }

  const branchOid = normaliseCommit(branchHead.stdout.trim());
  const headOid = normaliseCommit(head.stdout.trim());
  if (branchOid !== headOid) {
    return { status: 'attention', reason: 'HEAD and the named branch point to different commits.' };
  }

  const status = await runGit(layout.root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.code !== 0) {
    return { status: 'attention', reason: 'Git could not inspect the checkout state.' };
  }
  if (status.stdout.length > 0) {
    return {
      status: 'attention',
      reason: 'The checkout has staged, unstaged, or untracked changes.',
    };
  }

  if (headOid === target) {
    return { status: 'alreadyApplied' };
  }
  if (headOid !== base) {
    return { status: 'attention', reason: 'HEAD no longer matches the recorded base commit.' };
  }
  return { status: 'ready' };
}

export async function inspectVerifiedFastForward(
  input: Pick<
    ApplyVerifiedFastForwardInput,
    'repoPath' | 'expectedBranch' | 'baseCommit' | 'targetCommit'
  >,
): Promise<VerifiedFastForwardInspection> {
  const { expectedBranch, baseCommit, targetCommit } = input;
  const normalizedBase = typeof baseCommit === 'string' ? normaliseCommit(baseCommit) : '';
  const normalizedTarget = typeof targetCommit === 'string' ? normaliseCommit(targetCommit) : '';
  const toInspection = (
    status: Assessment['status'],
    reason?: string,
  ): VerifiedFastForwardInspection =>
    status === 'attention'
      ? {
          status,
          branch: expectedBranch,
          baseCommit: normalizedBase,
          targetCommit: normalizedTarget,
          reason: reason ?? 'The checkout needs attention.',
        }
      : {
          status,
          branch: expectedBranch,
          baseCommit: normalizedBase,
          targetCommit: normalizedTarget,
        };

  if (!HASH_PATTERN.test(baseCommit) || !HASH_PATTERN.test(targetCommit)) {
    return toInspection('attention', 'Base and target must be full 40 or 64 character commit IDs.');
  }
  if (!expectedBranch || typeof expectedBranch !== 'string') {
    return toInspection('attention', 'An expected branch is required.');
  }
  try {
    const layout = await getGitLayout(input.repoPath);
    const assessment = await assess(layout, expectedBranch, normalizedBase, normalizedTarget);
    return toInspection(assessment.status, assessment.reason);
  } catch (error) {
    return toInspection('attention', `Git could not inspect the repository: ${detail(error)}`);
  }
}

async function acquireLock(lockPath: string): Promise<OwnedLock> {
  const file = await open(
    lockPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o666,
  );
  const identity = await file.stat();
  return {
    path: lockPath,
    file,
    dev: identity.dev,
    ino: identity.ino,
    closed: false,
    renamed: false,
  };
}

async function lockStillOwned(lock: OwnedLock): Promise<boolean> {
  try {
    const current = await lstat(lock.path);
    return current.dev === lock.dev && current.ino === lock.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function pathHasIdentity(
  targetPath: string,
  identity: { dev: number; ino: number },
): Promise<boolean> {
  try {
    const current = await lstat(targetPath);
    return current.dev === identity.dev && current.ino === identity.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function releaseLock(lock: OwnedLock): Promise<void> {
  if (!lock.closed) {
    await lock.file.close();
    lock.closed = true;
  }
  if (lock.renamed) return;
  if (await lockStillOwned(lock)) await rm(lock.path, { force: true });
}

interface RefTransaction {
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  finished: boolean;
}

function startRefTransaction(
  root: string,
  branch: string,
  baseCommit: string,
  targetCommit: string,
): Promise<RefTransaction> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['update-ref', '--stdin', '-m', 'Anvil mesh apply'], {
      cwd: root,
      env: gitEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const transaction: RefTransaction = {
      child,
      stdout: '',
      stderr: '',
      closed: new Promise((closeResolve) => {
        child.once('close', (code, signal) => closeResolve({ code, signal }));
      }),
      finished: false,
    };
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(transaction);
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      transaction.stdout += String(chunk);
      if (/^prepare: ok\s*$/m.test(transaction.stdout)) finish();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      transaction.stderr += String(chunk);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      transaction.finished = true;
      if (!settled) {
        finish(
          new Error(
            transaction.stderr.trim() ||
              `Git ref transaction ended before prepare (code ${String(code)}, signal ${String(signal)}).`,
          ),
        );
      }
    });
    timer = setTimeout(() => {
      const timeoutError = new Error('Git ref transaction did not prepare within the timeout.');
      child.kill('SIGTERM');
      void transaction.closed.then(() => finish(timeoutError));
    }, REF_TRANSACTION_TIMEOUT_MS);

    child.stdin.write(
      `start\nupdate ${refName(branch)} ${targetCommit} ${baseCommit}\nprepare\n`,
      (error) => {
        if (error) finish(error);
      },
    );
  });
}

async function closeRefTransaction(transaction: RefTransaction, commit: boolean): Promise<void> {
  if (transaction.finished) return;
  const command = commit ? 'commit\n' : 'abort\n';
  transaction.child.stdin.end(command);
  const result = await transaction.closed;
  transaction.finished = true;
  if (commit && (result.code !== 0 || !/^commit: ok\s*$/m.test(transaction.stdout))) {
    throw new Error(
      transaction.stderr.trim() ||
        `Git could not commit the ref transaction (code ${result.code}).`,
    );
  }
  if (!commit && result.code !== 0) {
    throw new Error(
      transaction.stderr.trim() || `Git could not abort the ref transaction (code ${result.code}).`,
    );
  }
}

async function assertPreparedIndexClean(
  root: string,
  tempIndex: string,
  targetCommit: string,
): Promise<void> {
  const staged = await runGit(root, ['diff', '--cached', '--quiet', targetCommit, '--'], tempIndex);
  const unstaged = await runGit(root, ['diff-files', '--quiet'], tempIndex);
  const unmerged = await gitOutput(root, ['ls-files', '--unmerged'], tempIndex);
  const untracked = await gitOutput(
    root,
    ['ls-files', '--others', '--exclude-standard'],
    tempIndex,
  );
  if (staged.code !== 0 || unstaged.code !== 0 || unmerged || untracked) {
    throw new Error('The checkout changed while Git prepared the verified result.');
  }
}

async function assertTargetIsCheckedOut(
  layout: GitLayout,
  branch: string,
  targetCommit: string,
): Promise<void> {
  const symbolicHead = await gitOutput(layout.root, ['symbolic-ref', '--quiet', 'HEAD']);
  const branchHead = normaliseCommit(
    await gitOutput(layout.root, ['rev-parse', '--verify', refName(branch)]),
  );
  const head = normaliseCommit(
    await gitOutput(layout.root, ['rev-parse', '--verify', 'HEAD^{commit}']),
  );
  if (symbolicHead !== refName(branch) || branchHead !== targetCommit || head !== targetCommit) {
    throw new Error('The expected branch or HEAD moved while installing the verified result.');
  }
  if (await hasOperationState(layout.root)) {
    throw new Error('A merge, rebase, or sequencer started while installing the verified result.');
  }
}

export async function applyVerifiedFastForward(
  input: ApplyVerifiedFastForwardInput,
): Promise<VerifiedFastForwardReceipt> {
  validateInput(input);
  const baseCommit = normaliseCommit(input.baseCommit);
  const targetCommit = normaliseCommit(input.targetCommit);
  const normalizedInput = { ...input, baseCommit, targetCommit };

  let layout: GitLayout;
  try {
    layout = await getGitLayout(input.repoPath);
  } catch (error) {
    throw makeError(
      normalizedInput,
      `Could not locate the Git checkout: ${detail(error)}`,
      'notApplied',
      'attention',
      error,
    );
  }

  let headLock: OwnedLock | undefined;
  let indexLock: OwnedLock | undefined;
  let refHeadLockIdentity: { dev: number; ino: number } | undefined;
  let refTransaction: RefTransaction | undefined;
  let tempDir: string | undefined;
  let mutationStarted = false;
  let indexInstalled = false;
  let result: VerifiedFastForwardReceipt | undefined;
  let failure: unknown;

  try {
    try {
      headLock = await acquireLock(`${layout.headPath}.lock`);
    } catch (error) {
      throw makeError(
        normalizedInput,
        `Could not lock HEAD. Another Git operation may be using this checkout: ${detail(error)}`,
        'notApplied',
        'attention',
        error,
      );
    }
    try {
      indexLock = await acquireLock(`${layout.indexPath}.lock`);
    } catch (error) {
      throw makeError(
        normalizedInput,
        `Could not lock the index. Another Git operation may be using this checkout: ${detail(error)}`,
        'notApplied',
        'attention',
        error,
      );
    }

    const initial = await assess(layout, input.expectedBranch, baseCommit, targetCommit);
    if (initial.status === 'attention') {
      throw makeError(
        normalizedInput,
        initial.reason ?? 'The checkout needs attention.',
        'notApplied',
        'attention',
      );
    }
    if (initial.status === 'alreadyApplied') {
      result = {
        status: 'alreadyApplied',
        branch: input.expectedBranch,
        baseCommit,
        targetCommit,
      };
    } else {
      const originalIndex = await readFile(layout.indexPath);
      const originalIndexMode = (await stat(layout.indexPath)).mode & 0o777;
      // update-ref takes HEAD.lock to maintain the checked-out branch reflog.
      await releaseLock(headLock);
      headLock = undefined;
      try {
        refTransaction = await startRefTransaction(
          layout.root,
          input.expectedBranch,
          baseCommit,
          targetCommit,
        );
      } catch (error) {
        throw makeError(
          normalizedInput,
          `Could not reserve the expected branch ref: ${detail(error)}`,
          'notApplied',
          'attention',
          error,
        );
      }
      const headLockPath = `${layout.headPath}.lock`;
      try {
        const headRefLock = await lstat(headLockPath);
        refHeadLockIdentity = { dev: headRefLock.dev, ino: headRefLock.ino };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw makeError(
            normalizedInput,
            `Could not inspect the branch transaction HEAD.lock: ${detail(error)}`,
            'notApplied',
            'attention',
            error,
          );
        }
        try {
          headLock = await acquireLock(headLockPath);
          refHeadLockIdentity = { dev: headLock.dev, ino: headLock.ino };
        } catch (lockError) {
          throw makeError(
            normalizedInput,
            `Could not lock HEAD after reserving the branch ref: ${detail(lockError)}`,
            'notApplied',
            'attention',
            lockError,
          );
        }
      }

      const preparedState = await assess(layout, input.expectedBranch, baseCommit, targetCommit);
      if (preparedState.status !== 'ready') {
        throw makeError(
          normalizedInput,
          preparedState.reason ?? 'The checkout changed while locking the branch ref.',
          'notApplied',
          'attention',
        );
      }

      try {
        await input.onPrepared({
          branch: input.expectedBranch,
          baseCommit,
          targetCommit,
          startedAt: new Date().toISOString(),
        });
      } catch (error) {
        throw makeError(
          normalizedInput,
          `Could not persist the apply intent: ${detail(error)}`,
          'notApplied',
          'retry',
          error,
        );
      }

      if (
        !refHeadLockIdentity ||
        !(await pathHasIdentity(`${layout.headPath}.lock`, refHeadLockIdentity)) ||
        !(await lockStillOwned(indexLock))
      ) {
        throw makeError(
          normalizedInput,
          'A Git lock changed while the apply intent was being saved.',
          'notApplied',
          'attention',
        );
      }
      if (!(await readFile(layout.indexPath)).equals(originalIndex)) {
        throw makeError(
          normalizedInput,
          'The index changed while the apply intent was being saved.',
          'notApplied',
          'attention',
        );
      }
      const afterCallback = await assess(layout, input.expectedBranch, baseCommit, targetCommit);
      if (afterCallback.status !== 'ready') {
        throw makeError(
          normalizedInput,
          afterCallback.reason ?? 'The checkout changed while the apply intent was being saved.',
          'notApplied',
          'attention',
        );
      }

      tempDir = await mkdtemp(path.join(os.tmpdir(), 'anvil-mesh-apply-'));
      const tempIndex = path.join(tempDir, 'index');
      await copyFile(layout.indexPath, tempIndex);
      await chmod(tempIndex, originalIndexMode);

      mutationStarted = true;
      const readTree = await runGit(
        layout.root,
        ['read-tree', '-m', '-u', baseCommit, targetCommit],
        tempIndex,
      );
      if (readTree.code !== 0) {
        throw new Error(readTree.stderr.trim() || 'Git refused to update the working tree.');
      }
      await assertPreparedIndexClean(layout.root, tempIndex, targetCommit);

      const preparedIndex = await readFile(tempIndex);
      await indexLock.file.chmod(originalIndexMode);
      await indexLock.file.writeFile(preparedIndex);
      await indexLock.file.sync();
      await indexLock.file.close();
      indexLock.closed = true;

      await closeRefTransaction(refTransaction, true);
      refTransaction = undefined;

      await assertTargetIsCheckedOut(layout, input.expectedBranch, targetCommit);
      await assertPreparedIndexClean(layout.root, tempIndex, targetCommit);
      if (!(await lockStillOwned(indexLock))) {
        throw new Error('The index lock changed while installing the verified result.');
      }

      await rename(indexLock.path, layout.indexPath);
      indexLock.renamed = true;
      indexInstalled = true;
      result = {
        status: 'applied',
        branch: input.expectedBranch,
        baseCommit,
        targetCommit,
      };
    }
  } catch (error) {
    failure = error;
  }

  const cleanupErrors: unknown[] = [];
  if (refTransaction) {
    try {
      await closeRefTransaction(refTransaction, false);
    } catch (error) {
      cleanupErrors.push(error);
      refTransaction.child.kill('SIGTERM');
      await refTransaction.closed.catch(() => undefined);
    }
  }
  for (const lock of [indexLock, headLock]) {
    if (!lock) continue;
    try {
      await releaseLock(lock);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (tempDir) {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (failure) {
    if (failure instanceof MeshApplyError) {
      if (cleanupErrors.length === 0) throw failure;
      throw makeError(
        normalizedInput,
        `${failure.message} Cleanup also failed: ${cleanupErrors.map(detail).join('; ')}`,
        mutationStarted ? 'unknown' : failure.outcome,
        'attention',
        failure,
      );
    }
    throw makeError(
      normalizedInput,
      mutationStarted
        ? `The apply may have changed the checkout and needs inspection: ${detail(failure)}`
        : `The verified result was not applied: ${detail(failure)}`,
      mutationStarted ? 'unknown' : 'notApplied',
      mutationStarted || cleanupErrors.length > 0 ? 'attention' : 'retry',
      failure,
    );
  }
  if (cleanupErrors.length > 0) {
    throw makeError(
      normalizedInput,
      `The apply finished, but cleanup needs attention: ${cleanupErrors.map(detail).join('; ')}`,
      mutationStarted ? 'unknown' : 'notApplied',
      'attention',
      cleanupErrors[0],
    );
  }
  if (!result) {
    throw makeError(normalizedInput, 'The apply ended without a receipt.', 'unknown', 'attention');
  }
  if (result.status === 'applied' && !indexInstalled) {
    throw makeError(
      normalizedInput,
      'The target ref moved without installing its index.',
      'unknown',
      'attention',
    );
  }
  return result;
}
