import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  RepositoryChangedFile,
  RepositoryChangeSummary,
  RepositoryChangeStatus,
} from '../../shared/types.js';

export interface GitCommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
}

export interface GitDiffFile {
  filePath: string;
  diff: string;
  previousPath?: string;
  status: RepositoryChangeStatus;
}

const execFileAsync = promisify(execFile);

async function runGit(
  repoPath: string,
  args: string[],
  options?: { timeout?: number; maxBuffer?: number },
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    timeout: options?.timeout ?? 10_000,
    maxBuffer: options?.maxBuffer ?? 10 * 1024 * 1024,
  });
  return stdout;
}

/**
 * List recent commits for a repo.
 */
export async function listRecentCommits(repoPath: string, count = 30): Promise<GitCommitInfo[]> {
  const output = await runGit(repoPath, ['log', '--format=%H|%h|%s|%an|%aI', '-n', String(count)]);
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, message, author, date] = line.split('|');
      return { sha, shortSha, message, author, date };
    });
}

/**
 * List branches for a repo.
 */
export async function listBranches(repoPath: string): Promise<string[]> {
  const output = await runGit(repoPath, ['branch', '-a', '--format=%(refname:short)']);
  return output.trim().split('\n').filter(Boolean);
}

/**
 * Get diff for latest commit.
 */
export async function getLatestCommitDiff(repoPath: string): Promise<GitDiffFile[]> {
  return getDiffBetween(repoPath, 'HEAD~1', 'HEAD');
}

/**
 * Get diff between two commits.
 */
export async function getCommitRangeDiff(
  repoPath: string,
  fromSha: string,
  toSha: string,
): Promise<GitDiffFile[]> {
  return getDiffBetween(repoPath, fromSha, toSha);
}

/**
 * Get diff between two branches.
 */
export async function getBranchDiff(
  repoPath: string,
  baseBranch: string,
  compareBranch: string,
): Promise<GitDiffFile[]> {
  return getDiffBetween(repoPath, baseBranch, compareBranch);
}

/**
 * Get a diff between pull request refs, resolving remote/local branch variants.
 */
export async function getPullRequestRefDiff(
  repoPath: string,
  targetRef: string,
  sourceRef: string,
): Promise<GitDiffFile[]> {
  const [resolvedTarget, resolvedSource] = await Promise.all([
    resolveGitRef(repoPath, targetRef),
    resolveGitRef(repoPath, sourceRef),
  ]);
  if (!resolvedTarget || !resolvedSource) return [];
  return getDiffBetween(repoPath, resolvedTarget, resolvedSource);
}

export async function getCurrentCommitSha(repoPath: string): Promise<string | undefined> {
  try {
    return (await runGit(repoPath, ['rev-parse', 'HEAD'], { timeout: 5_000 })).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function getScopeChangeSummary(
  repoPath: string,
  scopeType: 'latest_commit' | 'commit_range' | 'branch_diff' | 'full_codebase',
  scopeRef?: {
    fromSha?: string;
    toSha?: string;
    baseBranch?: string;
    compareBranch?: string;
  },
): Promise<RepositoryChangeSummary> {
  switch (scopeType) {
    case 'commit_range':
      return summarizeDiffFiles(
        await getCommitRangeDiff(
          repoPath,
          scopeRef?.fromSha ?? 'HEAD~5',
          scopeRef?.toSha ?? 'HEAD',
        ),
      );
    case 'branch_diff':
      return summarizeDiffFiles(
        await getBranchDiff(
          repoPath,
          scopeRef?.baseBranch ?? 'main',
          scopeRef?.compareBranch ?? 'HEAD',
        ),
      );
    case 'latest_commit':
    case 'full_codebase':
      return summarizeDiffFiles(await getLatestCommitDiff(repoPath));
  }
}

/**
 * Get diff between two refs, split by file.
 */
async function getDiffBetween(
  repoPath: string,
  fromRef: string,
  toRef: string,
): Promise<GitDiffFile[]> {
  let output: string;
  try {
    output = await runGit(repoPath, ['diff', `${fromRef}...${toRef}`], {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    // Fallback for cases where ... syntax doesn't work (e.g. HEAD~1 on first commit)
    try {
      output = await runGit(repoPath, ['diff', fromRef, toRef], {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      return [];
    }
  }

  return splitDiffByFile(output);
}

/**
 * Split a unified diff into per-file diffs.
 */
export function splitDiffByFile(diff: string): GitDiffFile[] {
  const files: GitDiffFile[] = [];
  const parts = diff.split(/^diff --git /m);

  for (const part of parts) {
    if (!part.trim()) continue;
    const fullDiff = 'diff --git ' + part;

    const headerMatch = fullDiff.match(/^diff --git a\/(.+) b\/(.+)$/m);
    if (!headerMatch) continue;

    const previousPath = headerMatch[1];
    const nextPath = headerMatch[2];
    const status: RepositoryChangeStatus = fullDiff.includes('\nnew file mode ')
      ? 'added'
      : fullDiff.includes('\ndeleted file mode ')
        ? 'deleted'
        : fullDiff.includes('\nrename from ')
          ? 'renamed'
          : 'modified';

    files.push({
      filePath: status === 'deleted' ? previousPath : nextPath,
      previousPath: status === 'renamed' ? previousPath : undefined,
      status,
      diff: fullDiff,
    });
  }

  return files;
}

export function summarizeDiffFiles(
  diffFiles: Array<Pick<GitDiffFile, 'filePath' | 'previousPath' | 'status'> & { diff?: string }>,
): RepositoryChangeSummary {
  const files: RepositoryChangedFile[] = diffFiles.map(
    ({ filePath, previousPath, status, diff }) => ({
      filePath,
      previousPath,
      status,
      ranges: diff ? parseChangedRanges(diff) : undefined,
    }),
  );

  return {
    files,
    additions: files.filter((file) => file.status === 'added').length,
    modifications: files.filter((file) => file.status === 'modified').length,
    deletions: files.filter((file) => file.status === 'deleted').length,
    renames: files.filter((file) => file.status === 'renamed').length,
  };
}

export function parseChangedRanges(diff: string): NonNullable<RepositoryChangedFile['ranges']> {
  const ranges: NonNullable<RepositoryChangedFile['ranges']> = [];
  const lines = diff.split('\n');
  let oldLine = 0;
  let newLine = 0;
  let currentStart: number | null = null;
  let baseStart: number | null = null;

  const flushChanges = () => {
    if (baseStart !== null) {
      ranges.push({ side: 'base', startLine: baseStart, endLine: oldLine - 1 });
    }
    if (currentStart !== null) {
      ranges.push({ side: 'current', startLine: currentStart, endLine: newLine - 1 });
    } else if (baseStart !== null && newLine > 0) {
      // A deletion has no current-side lines. Anchor it at the point where the
      // removed lines used to be so symbol overlays remain precise.
      ranges.push({ side: 'current', startLine: newLine, endLine: newLine });
    }
    currentStart = null;
    baseStart = null;
  };

  for (const line of lines) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      flushChanges();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (oldLine === 0 && newLine === 0) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (currentStart === null) currentStart = newLine;
      newLine += 1;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      if (baseStart === null) baseStart = oldLine;
      oldLine += 1;
      continue;
    }

    flushChanges();
    if (line.startsWith(' ')) {
      oldLine += 1;
      newLine += 1;
    }
  }

  flushChanges();
  return ranges;
}

/**
 * Get full file contents for full codebase review. Returns file paths
 * relative to repo root for text files, skipping binaries and large files.
 */
export async function getTrackedFiles(repoPath: string): Promise<string[]> {
  const output = await runGit(repoPath, ['ls-files']);
  return output.trim().split('\n').filter(Boolean);
}

export function normalizeBranchName(ref: string): string {
  return ref
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/origin\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^origin\//, '');
}

export async function resolveGitRef(repoPath: string, ref: string): Promise<string | null> {
  const normalized = normalizeBranchName(ref);
  const candidates = new Set<string>([
    ref,
    normalized,
    `refs/heads/${normalized}`,
    `origin/${normalized}`,
    `refs/remotes/origin/${normalized}`,
  ]);

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await runGit(repoPath, ['rev-parse', '--verify', candidate], { timeout: 5_000 });
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  return null;
}
