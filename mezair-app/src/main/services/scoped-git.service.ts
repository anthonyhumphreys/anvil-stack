import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import simpleGit from 'simple-git';
import { TURN_DELIVERY_MAX_FILES, TURN_DELIVERY_MAX_PATH_LENGTH } from '../../shared/scoped-git.js';
import type {
  PreparedTurnDelivery,
  TurnDeliveryFile,
  TurnDeliveryFileStatus,
  TurnDeliveryMode,
  TurnDeliveryCommitResult,
  TurnPullRequestResult,
} from '../../shared/scoped-git.js';
import {
  createProviderPullRequest,
  getOriginRemoteUrl,
  resolveDefaultBaseBranch,
} from './git.service.js';

const execFileAsync = promisify(execFile);
const REVIEW_TTL_MS = 15 * 60 * 1000;
const ZERO_OID = '0000000000000000000000000000000000000000';
const GIT_TIMEOUT_MS = 60_000;
const MAX_PENDING_REVIEWS = 40;
const MAX_PENDING_REVIEW_BYTES = 24 * 1024 * 1024;
const MAX_FILE_DIFF_BYTES = 1024 * 1024;
const MAX_TOTAL_DIFF_BYTES = 4 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = MAX_TOTAL_DIFF_BYTES + 1024 * 1024;

interface TurnDeliveryReview extends PreparedTurnDelivery {
  repoId: string;
  repoName: string;
  repoPath: string;
  sourceTree: string;
  sourceIndexEntries: string;
  selectedPaths: string[];
  outputTree: string;
  remoteUrl?: string;
  claimed?: boolean;
}

interface GitNameStatus {
  status: TurnDeliveryFileStatus;
  path: string;
  previousPath?: string;
}

export interface TurnDeliveryDependencies {
  createPullRequest?: typeof createProviderPullRequest;
}

const pendingReviews = new Map<string, TurnDeliveryReview>();

function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

async function runGit(repoPath: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoPath,
      encoding: 'utf8',
      env: gitEnv(env),
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: GIT_TIMEOUT_MS,
    });
    return String(stdout);
  } catch (error) {
    const detail =
      error !== null && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr ?? '').trim()
        : '';
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('maxBuffer')) {
      throw new Error('The selected Git change is too large to review in Mezair.');
    }
    throw new Error(detail || message);
  }
}

function normalizedPath(value: string): string {
  if (!value || value.includes('\0') || value !== value.trim()) {
    throw new Error('The selected file scope contains an invalid path.');
  }
  const normalized = path.posix.normalize(value);
  if (
    value.length > TURN_DELIVERY_MAX_PATH_LENGTH ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    normalized !== value
  ) {
    throw new Error(`The selected path is outside the repository: ${value}`);
  }
  return normalized;
}

function literalPathspecs(paths: readonly string[]): string[] {
  return paths.map((filePath) => `:(literal)${filePath}`);
}

function removeTempDir(directory: string | undefined): void {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
}

async function makeTempIndex(
  repoPath: string,
  base: string,
): Promise<{ dir: string; index: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezair-turn-git-'));
  const index = path.join(dir, 'index');
  try {
    await runGit(repoPath, ['read-tree', base], { GIT_INDEX_FILE: index });
    return { dir, index };
  } catch (error) {
    removeTempDir(dir);
    throw error;
  }
}

async function treeForWorktreePaths(
  repoPath: string,
  baseHead: string,
  paths: readonly string[],
): Promise<string> {
  const temp = await makeTempIndex(repoPath, baseHead);
  try {
    await runGit(repoPath, ['add', '-A', '--', ...literalPathspecs(paths)], {
      GIT_INDEX_FILE: temp.index,
    });
    return (await runGit(repoPath, ['write-tree'], { GIT_INDEX_FILE: temp.index })).trim();
  } finally {
    removeTempDir(temp.dir);
  }
}

async function selectedIndexEntries(repoPath: string, paths: readonly string[]): Promise<string> {
  return runGit(repoPath, ['ls-files', '--stage', '-z', '--', ...literalPathspecs(paths)]);
}

async function assertNoGitOperationInProgress(repoPath: string): Promise<void> {
  const markers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];
  for (const marker of markers) {
    const gitPath = (await runGit(repoPath, ['rev-parse', '--git-path', marker])).trim();
    if (fs.existsSync(path.resolve(repoPath, gitPath))) {
      throw new Error('Finish or abort the active Git operation before delivering turn changes.');
    }
  }
}

async function sourceIdentity(repoPath: string): Promise<{ branch: string; head: string }> {
  const branch = (await runGit(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
  if (!branch) throw new Error('Turn delivery requires a named branch.');
  const head = (await runGit(repoPath, ['rev-parse', '--verify', 'HEAD'])).trim();
  return { branch, head };
}

async function assertRepositoryRoot(repoPath: string): Promise<string> {
  let resolved: string;
  try {
    resolved = fs.realpathSync(repoPath);
  } catch {
    throw new Error('The selected repository is no longer available on disk.');
  }
  const gitRoot = path.resolve((await runGit(resolved, ['rev-parse', '--show-toplevel'])).trim());
  if (gitRoot !== resolved) {
    throw new Error(
      'Turn-level Git actions require the selected repository root, not a nested path.',
    );
  }
  return resolved;
}

function parseNameStatus(output: string): GitNameStatus[] {
  const fields = output.split('\0');
  const changes: GitNameStatus[] = [];
  for (let index = 0; index < fields.length;) {
    const rawStatus = fields[index++];
    if (!rawStatus) continue;
    const code = rawStatus[0];
    if (code === 'R' || code === 'C') {
      const previousPath = fields[index++];
      const filePath = fields[index++];
      if (!previousPath || !filePath) throw new Error('Git returned an incomplete rename record.');
      changes.push({
        status: code === 'R' ? 'renamed' : 'modified',
        previousPath,
        path: filePath,
      });
      continue;
    }
    const filePath = fields[index++];
    if (!filePath) throw new Error('Git returned an incomplete file change record.');
    const status: TurnDeliveryFileStatus =
      code === 'A'
        ? 'added'
        : code === 'D'
          ? 'deleted'
          : code === 'T'
            ? 'type-changed'
            : 'modified';
    changes.push({ status, path: filePath });
  }
  return changes;
}

async function changedFiles(
  repoPath: string,
  fromTree: string,
  toTree: string,
  selectedPaths: readonly string[],
): Promise<TurnDeliveryFile[]> {
  const allowed = new Set(selectedPaths);
  const names = await runGit(repoPath, [
    'diff',
    '--name-status',
    '-z',
    '--find-renames',
    fromTree,
    toTree,
  ]);
  const parsed = parseNameStatus(names);
  const unexpected = parsed.find(
    (entry) => !allowed.has(entry.path) || (entry.previousPath && !allowed.has(entry.previousPath)),
  );
  if (unexpected) {
    throw new Error(
      `The captured Git diff includes ${unexpected.path}, outside the selected file scope. Review the turn file list again.`,
    );
  }
  const files: TurnDeliveryFile[] = [];
  let totalDiffBytes = 0;
  for (const entry of parsed) {
    const paths = entry.previousPath ? [entry.previousPath, entry.path] : [entry.path];
    const diff = await runGit(repoPath, [
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv',
      '--find-renames',
      fromTree,
      toTree,
      '--',
      ...literalPathspecs(paths),
    ]);
    const diffBytes = Buffer.byteLength(diff, 'utf8');
    totalDiffBytes += diffBytes;
    if (diffBytes > MAX_FILE_DIFF_BYTES) {
      throw new Error(`The change in ${entry.path} is too large to review in Mezair.`);
    }
    if (totalDiffBytes > MAX_TOTAL_DIFF_BYTES) {
      throw new Error('The selected Git changes are too large to review in Mezair.');
    }
    if (/^(?:Binary files .* differ|GIT binary patch)/m.test(diff)) {
      throw new Error(
        `Mezair cannot preview the binary change in ${entry.path}. Use the repository Git view to review it.`,
      );
    }
    files.push({ ...entry, diff });
  }
  return files;
}

function assertScopeWasCaptured(
  paths: readonly string[],
  files: readonly TurnDeliveryFile[],
): void {
  const changed = new Set<string>();
  for (const file of files) {
    changed.add(file.path);
    if (file.previousPath) changed.add(file.previousPath);
  }
  const missing = paths.filter((filePath) => !changed.has(filePath));
  if (missing.length > 0) {
    const first = missing[0];
    throw new Error(
      `No current Git change was found for ${first}. Refresh the turn changes and review again.`,
    );
  }
  if (files.length === 0)
    throw new Error('There are no current Git changes in the selected files.');
}

function suggestedCommitMessage(files: readonly TurnDeliveryFile[]): string {
  const paths = files.map((file) => file.path);
  const allDocs = paths.every((filePath) => /\.(md|mdx|rst|txt)$/i.test(filePath));
  const allAdded = files.every((file) => file.status === 'added');
  const allDeleted = files.every((file) => file.status === 'deleted');
  const hasTests = paths.some((filePath) =>
    /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\./i.test(filePath),
  );
  const type = allDocs ? 'docs' : hasTests ? 'test' : allAdded ? 'feat' : 'fix';
  const firstSegments = paths.map((filePath) => filePath.split('/').filter(Boolean));
  const first = firstSegments[0]?.[0];
  const scope = first && firstSegments.every((segments) => segments[0] === first) ? first : '';
  const action = allAdded ? 'add' : allDeleted ? 'remove' : 'update';
  const subject = `${action} ${scope || 'reviewed changes'}`.slice(0, 70);
  return `${type}${scope ? `(${scope})` : ''}: ${subject}`;
}

async function remoteBaseBranch(repoPath: string, currentBranch: string): Promise<string> {
  const git = simpleGit(repoPath);
  const remoteHead = (
    await runGit(repoPath, ['ls-remote', '--symref', 'origin', 'HEAD']).catch(() => '')
  )
    .split(/\r?\n/)
    .find((line) => line.startsWith('ref: refs/heads/'));
  const remoteDefault = remoteHead?.slice('ref: refs/heads/'.length).split(/\s+/)[0];
  if (remoteDefault) return remoteDefault;
  return resolveDefaultBaseBranch(git, currentBranch);
}

async function fetchRemoteBase(repoPath: string, branch: string): Promise<string> {
  const remoteRef = `refs/remotes/origin/${branch}`;
  await runGit(repoPath, ['fetch', '--no-tags', 'origin', `refs/heads/${branch}:${remoteRef}`]);
  return (await runGit(repoPath, ['rev-parse', '--verify', remoteRef])).trim();
}

async function candidateTreeForPullRequest(
  repoPath: string,
  sourceHead: string,
  sourceTree: string,
  baseHead: string,
  selectedPaths: readonly string[],
): Promise<string> {
  const patch = await runGit(repoPath, [
    'diff',
    '--binary',
    '--full-index',
    '--no-renames',
    '--no-ext-diff',
    '--no-textconv',
    sourceHead,
    sourceTree,
    '--',
    ...literalPathspecs(selectedPaths),
  ]);
  const temp = await makeTempIndex(repoPath, baseHead);
  const patchPath = path.join(temp.dir, 'selected.patch');
  try {
    fs.writeFileSync(patchPath, patch, 'utf8');
    await runGit(repoPath, ['apply', '--cached', '--3way', '--binary', patchPath], {
      GIT_INDEX_FILE: temp.index,
    }).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `The selected changes do not apply cleanly to the remote base branch. No pull request branch was created. ${detail}`,
      );
    });
    return (await runGit(repoPath, ['write-tree'], { GIT_INDEX_FILE: temp.index })).trim();
  } finally {
    removeTempDir(temp.dir);
  }
}

function purgeExpiredReviews(): void {
  const now = Date.now();
  for (const [reviewId, review] of pendingReviews) {
    if (Date.parse(review.expiresAt) <= now) pendingReviews.delete(reviewId);
  }
}

function pendingReviewBytes(): number {
  let total = 0;
  for (const review of pendingReviews.values()) {
    total += Buffer.byteLength(review.diff, 'utf8');
    for (const file of review.files) total += Buffer.byteLength(file.diff, 'utf8');
  }
  return total;
}

export async function prepareTurnDelivery(input: {
  repoId: string;
  repoName: string;
  repoPath: string;
  paths: string[];
  mode: TurnDeliveryMode;
}): Promise<PreparedTurnDelivery> {
  purgeExpiredReviews();
  const repoPath = await assertRepositoryRoot(input.repoPath);
  if (input.mode !== 'commit' && input.mode !== 'pr') {
    throw new Error('Unknown turn delivery mode.');
  }
  if (!Array.isArray(input.paths) || input.paths.some((filePath) => typeof filePath !== 'string')) {
    throw new Error('Turn delivery requires a list of repository-relative file paths.');
  }
  const selectedPaths = [...new Set(input.paths.map(normalizedPath))].sort();
  if (selectedPaths.length === 0) throw new Error('This turn did not select any repository files.');
  if (
    input.paths.length > TURN_DELIVERY_MAX_FILES ||
    selectedPaths.length > TURN_DELIVERY_MAX_FILES
  ) {
    throw new Error(`Turn delivery is limited to ${TURN_DELIVERY_MAX_FILES} files per review.`);
  }

  await assertNoGitOperationInProgress(repoPath);
  const { branch: sourceBranch, head: sourceHead } = await sourceIdentity(repoPath);
  const sourceTree = await treeForWorktreePaths(repoPath, sourceHead, selectedPaths);
  const sourceFiles = await changedFiles(repoPath, sourceHead, sourceTree, selectedPaths);
  assertScopeWasCaptured(selectedPaths, sourceFiles);
  const sourceIndexEntries = await selectedIndexEntries(repoPath, selectedPaths);

  let baseBranch: string | undefined;
  let baseHead: string | undefined;
  let outputTree = sourceTree;
  let remoteUrl: string | undefined;
  if (input.mode === 'pr') {
    const git = simpleGit(repoPath);
    remoteUrl = await getOriginRemoteUrl(git);
    if (!remoteUrl) throw new Error('Opening a pull request requires an origin remote.');
    baseBranch = await remoteBaseBranch(repoPath, sourceBranch);
    baseHead = await fetchRemoteBase(repoPath, baseBranch);
    outputTree = await candidateTreeForPullRequest(
      repoPath,
      sourceHead,
      sourceTree,
      baseHead,
      selectedPaths,
    );
  }

  const diffBase = baseHead ?? sourceHead;
  const files = await changedFiles(repoPath, diffBase, outputTree, selectedPaths);
  assertScopeWasCaptured(selectedPaths, files);
  const reviewId = crypto.randomUUID();
  const review: TurnDeliveryReview = {
    reviewId,
    repoId: input.repoId,
    repoName: input.repoName,
    repoPath,
    mode: input.mode,
    sourceBranch,
    sourceHead,
    baseBranch,
    baseHead,
    files,
    diff: files.map((file) => file.diff).join('\n'),
    suggestedMessage: suggestedCommitMessage(files),
    expiresAt: new Date(Date.now() + REVIEW_TTL_MS).toISOString(),
    sourceTree,
    sourceIndexEntries,
    selectedPaths,
    outputTree,
    remoteUrl,
  };
  if (pendingReviews.size >= MAX_PENDING_REVIEWS) {
    throw new Error(
      'Too many Git reviews are waiting for confirmation. Close an older review and try again.',
    );
  }
  if (
    pendingReviewBytes() + Buffer.byteLength(review.diff, 'utf8') * 2 >
    MAX_PENDING_REVIEW_BYTES
  ) {
    throw new Error(
      'Too many Git changes are waiting for review. Close an older review and try again.',
    );
  }
  pendingReviews.set(reviewId, review);
  return publicReview(review);
}

function publicReview(review: TurnDeliveryReview): PreparedTurnDelivery {
  return {
    reviewId: review.reviewId,
    mode: review.mode,
    sourceBranch: review.sourceBranch,
    sourceHead: review.sourceHead,
    baseBranch: review.baseBranch,
    baseHead: review.baseHead,
    files: review.files,
    diff: review.diff,
    suggestedMessage: review.suggestedMessage,
    expiresAt: review.expiresAt,
  };
}

function getReview(repoId: string, reviewId: string, mode: TurnDeliveryMode): TurnDeliveryReview {
  purgeExpiredReviews();
  const review = pendingReviews.get(reviewId);
  if (!review || review.repoId !== repoId || review.mode !== mode || review.claimed) {
    throw new Error('This reviewed change has expired. Review the current Git diff again.');
  }
  return review;
}

function claimReview(repoId: string, reviewId: string, mode: TurnDeliveryMode): TurnDeliveryReview {
  const review = getReview(repoId, reviewId, mode);
  // Claim before the first await so a double click cannot create two commits or PR branches.
  review.claimed = true;
  pendingReviews.delete(reviewId);
  return review;
}

async function assertReviewIsCurrent(review: TurnDeliveryReview): Promise<void> {
  await assertNoGitOperationInProgress(review.repoPath);
  const identity = await sourceIdentity(review.repoPath);
  if (identity.branch !== review.sourceBranch || identity.head !== review.sourceHead) {
    throw new Error('The branch or HEAD changed after review. Review the current Git diff again.');
  }
  const [tree, indexEntries, unmerged] = await Promise.all([
    treeForWorktreePaths(review.repoPath, review.sourceHead, review.selectedPaths),
    selectedIndexEntries(review.repoPath, review.selectedPaths),
    runGit(review.repoPath, [
      'ls-files',
      '--unmerged',
      '-z',
      '--',
      ...literalPathspecs(review.selectedPaths),
    ]),
  ]);
  if (unmerged)
    throw new Error('A selected file has unresolved conflicts. Review it in Git first.');
  if (tree !== review.sourceTree || indexEntries !== review.sourceIndexEntries) {
    throw new Error('A selected file changed after review. Review the current Git diff again.');
  }
  if (review.mode === 'pr' && review.baseBranch && review.baseHead) {
    const currentRemoteUrl = await getOriginRemoteUrl(simpleGit(review.repoPath));
    if (currentRemoteUrl !== review.remoteUrl) {
      throw new Error(
        'The origin remote changed after review. Review the pull request diff again.',
      );
    }
    const currentBase = await fetchRemoteBase(review.repoPath, review.baseBranch);
    if (currentBase !== review.baseHead) {
      throw new Error(
        `origin/${review.baseBranch} moved after review. Review the current pull request diff again.`,
      );
    }
  }
}

function validateCommitMessage(message: string): string {
  const value = message.trim();
  if (!value) throw new Error('Enter a commit message before continuing.');
  if (value.length > 200) throw new Error('Commit messages are limited to 200 characters.');
  if (value.includes('\0')) throw new Error('The commit message contains an invalid character.');
  return value;
}

function acquireIndexLock(indexPath: string): number {
  try {
    return fs.openSync(`${indexPath}.lock`, 'wx', 0o600);
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      throw new Error('Another Git operation is updating the index. Try again when it finishes.');
    }
    throw error;
  }
}

async function advanceCurrentBranch(
  review: TurnDeliveryReview,
  commitHash: string,
): Promise<string | undefined> {
  const gitPath = (
    await runGit(review.repoPath, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
  ).trim();
  const indexPath = path.resolve(review.repoPath, gitPath);
  const lockPath = `${indexPath}.lock`;
  const lockFd = acquireIndexLock(indexPath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezair-turn-index-'));
  const tempIndex = path.join(tempDir, 'index');
  let refUpdated = false;

  try {
    const currentIndexEntries = await selectedIndexEntries(review.repoPath, review.selectedPaths);
    if (currentIndexEntries !== review.sourceIndexEntries) {
      throw new Error('A selected file was staged or unstaged after review. Review it again.');
    }
    if (fs.existsSync(indexPath)) fs.copyFileSync(indexPath, tempIndex);
    else
      await runGit(review.repoPath, ['read-tree', review.sourceHead], {
        GIT_INDEX_FILE: tempIndex,
      });

    await runGit(
      review.repoPath,
      ['reset', '--quiet', commitHash, '--', ...literalPathspecs(review.selectedPaths)],
      { GIT_INDEX_FILE: tempIndex },
    );

    await assertReviewIsCurrent(review);
    const currentBranch = (
      await runGit(review.repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    ).trim();
    if (currentBranch !== review.sourceBranch) {
      throw new Error(
        'The checked out branch changed after review. Review the current Git diff again.',
      );
    }
    await runGit(review.repoPath, [
      'update-ref',
      '-m',
      `commit: ${commitHash.slice(0, 12)}`,
      `refs/heads/${review.sourceBranch}`,
      commitHash,
      review.sourceHead,
    ]);
    refUpdated = true;

    const indexContent = fs.readFileSync(tempIndex);
    fs.writeFileSync(lockFd, indexContent);
    fs.fsyncSync(lockFd);
    fs.closeSync(lockFd);
    fs.renameSync(lockPath, indexPath);
    return undefined;
  } catch (error) {
    try {
      fs.closeSync(lockFd);
    } catch {
      // The descriptor may already be closed after replacing the index.
    }
    fs.rmSync(lockPath, { force: true });
    if (refUpdated) {
      const detail = error instanceof Error ? error.message : String(error);
      return `The commit was created, but Git could not refresh the index. The commit is ${commitHash.slice(0, 12)}. ${detail}`;
    }
    throw error;
  } finally {
    removeTempDir(tempDir);
  }
}

async function createReviewedCommit(
  review: TurnDeliveryReview,
  commitMessage: string,
  parentHead: string,
): Promise<string> {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mezair-turn-commit-'));
  let worktreeMayExist = false;
  try {
    worktreeMayExist = true;
    await runGit(review.repoPath, ['worktree', 'add', '--detach', worktreePath, parentHead]);
    await runGit(worktreePath, ['read-tree', '--reset', '-u', review.outputTree]);

    const stagedTree = (await runGit(worktreePath, ['write-tree'])).trim();
    if (stagedTree !== review.outputTree) {
      throw new Error(
        'Mezair could not stage the exact reviewed candidate in its temporary worktree.',
      );
    }

    await runGit(worktreePath, ['commit', '-m', commitMessage]).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Git commit failed in the isolated review worktree. Check configured hooks or signing, then review again. ${detail}`,
      );
    });

    const commitHash = (await runGit(worktreePath, ['rev-parse', '--verify', 'HEAD'])).trim();
    const commitObject = await runGit(worktreePath, ['cat-file', 'commit', commitHash]);
    const headerEnd = commitObject.indexOf('\n\n');
    if (headerEnd < 0) throw new Error('Git returned an invalid commit object.');
    const headers = commitObject.slice(0, headerEnd).split('\n');
    const committedTree = headers.find((header) => header.startsWith('tree '))?.slice(5);
    const parents = headers
      .filter((header) => header.startsWith('parent '))
      .map((header) => header.slice(7));
    const body = commitObject.slice(headerEnd + 2);
    const committedMessage = body.endsWith('\n') ? body.slice(0, -1) : body;

    if (committedTree !== review.outputTree) {
      throw new Error(
        'A Git commit hook changed the reviewed file tree. No source branch was changed; inspect the hook and review again.',
      );
    }
    if (parents.length !== 1 || parents[0] !== parentHead) {
      throw new Error(
        'A Git commit hook changed the reviewed commit parent. No source branch was changed; inspect the hook and review again.',
      );
    }
    if (committedMessage !== commitMessage) {
      throw new Error(
        'A Git commit hook changed the reviewed commit message. No source branch was changed; review the updated message and try again.',
      );
    }
    return commitHash;
  } finally {
    if (worktreeMayExist) {
      await runGit(review.repoPath, ['worktree', 'remove', '--force', worktreePath]).catch(
        () => undefined,
      );
      await runGit(review.repoPath, ['worktree', 'prune', '--expire', 'now']).catch(
        () => undefined,
      );
    }
    removeTempDir(worktreePath);
  }
}

export async function commitTurnDelivery(
  repoId: string,
  reviewId: string,
  message: string,
): Promise<TurnDeliveryCommitResult> {
  const commitMessage = validateCommitMessage(message);
  const review = claimReview(repoId, reviewId, 'commit');
  await assertReviewIsCurrent(review);
  const commitHash = await createReviewedCommit(review, commitMessage, review.sourceHead);
  const indexWarning = await advanceCurrentBranch(review, commitHash);
  return {
    commitHash,
    branch: review.sourceBranch,
    files: review.files.map((file) => file.path),
    indexWarning,
  };
}

async function createLocalTurnBranch(
  review: TurnDeliveryReview,
  commitMessage: string,
): Promise<{ branch: string; commitHash: string }> {
  const branch = `codex/turn-${review.reviewId.slice(0, 12)}`;
  await runGit(review.repoPath, ['check-ref-format', '--branch', branch]);
  const commitHash = await createReviewedCommit(review, commitMessage, review.baseHead!);
  await assertReviewIsCurrent(review);
  await runGit(review.repoPath, [
    'update-ref',
    '-m',
    `commit: ${commitHash.slice(0, 12)}`,
    `refs/heads/${branch}`,
    commitHash,
    ZERO_OID,
  ]);
  return { branch, commitHash };
}

export async function createTurnPullRequest(
  repoId: string,
  reviewId: string,
  message: string,
  dependencies: TurnDeliveryDependencies = {},
): Promise<TurnPullRequestResult> {
  const commitMessage = validateCommitMessage(message);
  const review = claimReview(repoId, reviewId, 'pr');
  if (!review.baseBranch || !review.baseHead || !review.remoteUrl) {
    throw new Error('This pull request review is missing its pinned remote base. Review it again.');
  }

  await assertReviewIsCurrent(review);
  const { branch, commitHash } = await createLocalTurnBranch(review, commitMessage);
  const resultBase = {
    repoId: review.repoId,
    repoName: review.repoName,
    branch,
    baseBranch: review.baseBranch,
    commitHash,
    commitMessage,
  };

  try {
    await runGit(review.repoPath, ['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ...resultBase,
      status: 'branch-local',
      detail: `The commit is saved on local branch ${branch}, but push failed. ${detail}`,
    };
  }

  try {
    const pullRequestUrl = await (dependencies.createPullRequest ?? createProviderPullRequest)(
      review.remoteUrl,
      branch,
      review.baseBranch,
      commitMessage,
      'Created from reviewed current changes in Mezair.',
    );
    if (pullRequestUrl) return { ...resultBase, status: 'opened', pullRequestUrl };
    return {
      ...resultBase,
      status: 'branch-pushed',
      detail: `The branch was pushed, but Mezair has no pull request provider for this remote.`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ...resultBase,
      status: 'branch-pushed',
      detail: `The branch was pushed, but pull request creation failed. ${detail}`,
    };
  }
}
