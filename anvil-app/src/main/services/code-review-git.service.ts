import { execFileSync } from 'node:child_process';

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
}

function runGit(
  repoPath: string,
  args: string[],
  options?: { timeout?: number; maxBuffer?: number },
): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    timeout: options?.timeout ?? 10_000,
    maxBuffer: options?.maxBuffer ?? 10 * 1024 * 1024,
  });
}

/**
 * List recent commits for a repo.
 */
export function listRecentCommits(repoPath: string, count = 30): GitCommitInfo[] {
  const output = runGit(repoPath, ['log', '--format=%H|%h|%s|%an|%aI', '-n', String(count)]);
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
export function listBranches(repoPath: string): string[] {
  const output = runGit(repoPath, ['branch', '-a', '--format=%(refname:short)']);
  return output.trim().split('\n').filter(Boolean);
}

/**
 * Get diff for latest commit.
 */
export function getLatestCommitDiff(repoPath: string): GitDiffFile[] {
  return getDiffBetween(repoPath, 'HEAD~1', 'HEAD');
}

/**
 * Get diff between two commits.
 */
export function getCommitRangeDiff(
  repoPath: string,
  fromSha: string,
  toSha: string,
): GitDiffFile[] {
  return getDiffBetween(repoPath, fromSha, toSha);
}

/**
 * Get diff between two branches.
 */
export function getBranchDiff(
  repoPath: string,
  baseBranch: string,
  compareBranch: string,
): GitDiffFile[] {
  return getDiffBetween(repoPath, baseBranch, compareBranch);
}

/**
 * Get a diff between pull request refs, resolving remote/local branch variants.
 */
export function getPullRequestRefDiff(
  repoPath: string,
  targetRef: string,
  sourceRef: string,
): GitDiffFile[] {
  const resolvedTarget = resolveGitRef(repoPath, targetRef);
  const resolvedSource = resolveGitRef(repoPath, sourceRef);
  if (!resolvedTarget || !resolvedSource) return [];
  return getDiffBetween(repoPath, resolvedTarget, resolvedSource);
}

/**
 * Get diff between two refs, split by file.
 */
function getDiffBetween(repoPath: string, fromRef: string, toRef: string): GitDiffFile[] {
  let output: string;
  try {
    output = runGit(repoPath, ['diff', `${fromRef}...${toRef}`], {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    // Fallback for cases where ... syntax doesn't work (e.g. HEAD~1 on first commit)
    try {
      output = runGit(repoPath, ['diff', fromRef, toRef], {
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

    // Extract file path from +++ line
    const match = fullDiff.match(/^\+\+\+ b\/(.+)$/m);
    if (!match) continue;

    files.push({ filePath: match[1], diff: fullDiff });
  }

  return files;
}

/**
 * Get full file contents for full codebase review. Returns file paths
 * relative to repo root for text files, skipping binaries and large files.
 */
export function getTrackedFiles(repoPath: string): string[] {
  const output = runGit(repoPath, ['ls-files']);
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

export function resolveGitRef(repoPath: string, ref: string): string | null {
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
      runGit(repoPath, ['rev-parse', '--verify', candidate], { timeout: 5_000 });
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  return null;
}
