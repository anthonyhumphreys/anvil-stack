import simpleGit, { type SimpleGit } from 'simple-git';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  RepoInfo,
  GitStatusResult,
  GitFileChange,
  GitFileStatus,
  GitLogEntry,
  GitBranchInfo,
  GitDiffResult,
  GitPullRequestCreateResult,
} from '../../shared/types.js';
import { parseAdoRemoteUrl, parseGitHubRemoteUrl } from './code-review-pr.service.js';
import { getSettings } from './settings.service.js';

const execFileAsync = promisify(execFile);

export function isGitRepo(dirPath: string): boolean {
  return fs.existsSync(path.join(dirPath, '.git'));
}

export function repoIdFromPath(dirPath: string): string {
  return crypto.createHash('sha256').update(dirPath).digest('hex').slice(0, 16);
}

function gitClient(repoPath: string): SimpleGit {
  return simpleGit(repoPath);
}

export async function getRepoMetadata(
  repoPath: string,
): Promise<Omit<RepoInfo, 'status' | 'lastIndexed'>> {
  const git = gitClient(repoPath);

  const [remotes, branches, log] = await Promise.all([
    git.getRemotes(true),
    git.branch(),
    git.log({ maxCount: 1 }),
  ]);

  const remoteUrl = remotes.find((r) => r.name === 'origin')?.refs?.fetch;
  const defaultBranch = branches.current;
  const branchCount = branches.all.length;
  const lastCommit = log.latest;

  // Count tracked files
  const lsFiles = await git.raw(['ls-files']);
  const fileCount = lsFiles.trim().split('\n').filter(Boolean).length;

  return {
    id: repoIdFromPath(repoPath),
    name: path.basename(repoPath),
    path: repoPath,
    remoteUrl,
    defaultBranch,
    languages: [], // populated by indexer
    fileCount,
    branchCount,
    lastCommitMessage: lastCommit?.message,
    lastCommitDate: lastCommit?.date,
  };
}

export async function getRecentCommits(
  repoPath: string,
  count = 10,
): Promise<{ hash: string; message: string; author: string; date: string }[]> {
  const git = gitClient(repoPath);
  const log = await git.log({ maxCount: count });
  return log.all.map((c) => ({
    hash: c.hash.slice(0, 8),
    message: c.message,
    author: c.author_name,
    date: c.date,
  }));
}

export async function getDiffStatSinceDate(
  repoPath: string,
  sinceDate: string,
): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
  const git = gitClient(repoPath);
  try {
    const diff = await git.raw(['diff', '--stat', `--since=${sinceDate}`, 'HEAD']);
    const match = diff.match(/(\d+) files? changed(?:, (\d+) insertions?)?(?:, (\d+) deletions?)?/);
    if (!match) return { filesChanged: 0, insertions: 0, deletions: 0 };
    return {
      filesChanged: parseInt(match[1], 10) || 0,
      insertions: parseInt(match[2], 10) || 0,
      deletions: parseInt(match[3], 10) || 0,
    };
  } catch {
    return { filesChanged: 0, insertions: 0, deletions: 0 };
  }
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  const git = gitClient(repoPath);
  const branches = await git.branch();
  return branches.current;
}

export async function branchExists(repoPath: string, branchName: string): Promise<boolean> {
  const git = gitClient(repoPath);
  const branches = await git.branch(['-a']);
  return branches.all.includes(branchName);
}

export async function checkoutBranch(
  repoPath: string,
  branchName: string,
  create = false,
): Promise<void> {
  const git = gitClient(repoPath);
  if (create) {
    await git.checkoutLocalBranch(branchName);
  } else {
    await git.checkout(branchName);
  }
}

export async function stashChanges(repoPath: string): Promise<string | null> {
  const git = gitClient(repoPath);
  const status = await git.status();
  if (status.files.length === 0) return null;
  await git.stash(['push', '-m', 'Anvil BA session auto-stash']);
  return 'stash@{0}';
}

export async function popStash(repoPath: string): Promise<void> {
  const git = gitClient(repoPath);
  try {
    await git.stash(['pop']);
  } catch {
    // stash may be empty — swallow the error
  }
}

export async function hasUncommittedChanges(repoPath: string): Promise<boolean> {
  const git = gitClient(repoPath);
  const status = await git.status();
  return status.files.length > 0;
}

export async function autoCommit(repoPath: string, message: string): Promise<void> {
  const git = gitClient(repoPath);
  await git.add('.');
  await git.commit(message);
}

// ---------------------------------------------------------------------------
// Git Client — full operations
// ---------------------------------------------------------------------------

function mapFileStatus(index: string, working: string): GitFileStatus {
  if (index === '?' || working === '?') return 'untracked';
  if (index === 'U' || working === 'U') return 'conflicted';
  if (index === 'A' || working === 'A') return 'added';
  if (index === 'D' || working === 'D') return 'deleted';
  if (index === 'R' || working === 'R') return 'renamed';
  if (index === 'C' || working === 'C') return 'copied';
  return 'modified';
}

export async function getFullStatus(repoPath: string): Promise<GitStatusResult> {
  const git = gitClient(repoPath);
  const status = await git.status();

  const files: GitFileChange[] = status.files.map((f) => ({
    path: f.path,
    status: mapFileStatus(f.index, f.working_dir),
    staged: f.index !== ' ' && f.index !== '?' && f.index !== '!',
    oldPath: (f as unknown as { from?: string }).from || undefined,
  }));

  return {
    branch: status.current ?? 'HEAD',
    ahead: status.ahead,
    behind: status.behind,
    tracking: status.tracking ?? undefined,
    files,
  };
}

export async function generateConventionalCommitMessage(repoPath: string): Promise<string> {
  const git = gitClient(repoPath);
  const status = await git.status();
  if (status.files.length === 0) {
    throw new Error('There are no repository changes to commit.');
  }

  const paths = status.files.map((file) => file.path);
  const type = inferCommitType(paths, status.files);
  const scope = inferCommitScope(paths);
  const action = inferCommitAction(status.files);
  const subject = `${action} ${scope ? scope.replace(/[-_]/g, ' ') : 'workspace changes'}`;

  return `${type}${scope ? `(${scope})` : ''}: ${subject}`.slice(0, 120);
}

export async function createPullRequestFromChanges(
  repoId: string,
  repoName: string,
  repoPath: string,
): Promise<GitPullRequestCreateResult> {
  const git = gitClient(repoPath);
  const status = await git.status();
  const remoteUrl = await getOriginRemoteUrl(git);
  if (!remoteUrl) {
    throw new Error('Creating a pull request requires an origin remote.');
  }
  if (!status.current) {
    throw new Error('Creating a pull request requires a named branch.');
  }
  if (status.files.length === 0) {
    throw new Error('There are no repository changes to turn into a pull request.');
  }

  const commitMessage = await generateConventionalCommitMessage(repoPath);
  await git.add('.');
  const commit = await git.commit(commitMessage);
  const branch = status.current;
  await pushBranch(repoPath, 'origin', branch, !status.tracking);
  const baseBranch = await resolveDefaultBaseBranch(git, branch);
  const pullRequestUrl = await createProviderPullRequest(
    remoteUrl,
    branch,
    baseBranch,
    commitMessage,
  );

  return {
    repoId,
    repoName,
    branch,
    baseBranch,
    commitHash: commit.commit,
    commitMessage,
    pullRequestUrl,
  };
}

export async function stageFiles(repoPath: string, paths: string[]): Promise<void> {
  const git = gitClient(repoPath);
  await git.add(paths);
}

export async function unstageFiles(repoPath: string, paths: string[]): Promise<void> {
  const git = gitClient(repoPath);
  await git.reset(['HEAD', '--', ...paths]);
}

export async function discardFiles(repoPath: string, paths: string[]): Promise<void> {
  const git = gitClient(repoPath);
  // Separate untracked from tracked
  const status = await git.status();
  const untracked = new Set(status.not_added);

  const tracked = paths.filter((p) => !untracked.has(p));
  const untrackedToRemove = paths.filter((p) => untracked.has(p));

  if (tracked.length > 0) {
    await git.checkout(['--', ...tracked]);
  }
  for (const f of untrackedToRemove) {
    const fullPath = path.join(repoPath, f);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  }
}

export async function commitChanges(repoPath: string, message: string): Promise<string> {
  const git = gitClient(repoPath);
  const result = await git.commit(message);
  return result.commit;
}

export async function pushBranch(
  repoPath: string,
  remote = 'origin',
  branch?: string,
  setUpstream = false,
): Promise<string> {
  const git = gitClient(repoPath);
  const args: string[] = [];
  if (setUpstream) args.push('-u');
  args.push(remote);
  if (branch) args.push(branch);
  const result = await git.push(args);
  return result?.pushed?.[0]?.local ?? branch ?? 'pushed';
}

export async function pullBranch(
  repoPath: string,
  remote = 'origin',
  branch?: string,
): Promise<string> {
  const git = gitClient(repoPath);
  const args: string[] = [remote];
  if (branch) args.push(branch);
  const result = await git.pull(args);
  return `${result.summary.changes} changes, ${result.summary.insertions} insertions, ${result.summary.deletions} deletions`;
}

export async function fetchRemote(repoPath: string, remote = 'origin'): Promise<void> {
  const git = gitClient(repoPath);
  await git.fetch(remote, ['--prune']);
}

export async function fetchRef(
  repoPath: string,
  remote: string,
  sourceRef: string,
  targetRef?: string,
): Promise<void> {
  const git = gitClient(repoPath);
  const refspec = targetRef ? `${sourceRef}:${targetRef}` : sourceRef;
  await git.fetch(remote, refspec, ['--force', '--prune']);
}

export async function getLog(repoPath: string, count = 50): Promise<GitLogEntry[]> {
  const git = gitClient(repoPath);
  const log = await git.log({ maxCount: count, '--decorate': null });
  return log.all.map((c) => ({
    hash: c.hash,
    shortHash: c.hash.slice(0, 7),
    message: c.message,
    author: c.author_name,
    date: c.date,
    refs: c.refs || undefined,
  }));
}

export async function listBranches(repoPath: string): Promise<GitBranchInfo[]> {
  const git = gitClient(repoPath);
  const branches = await git.branch(['-vv']);
  return branches.all.map((name) => {
    const info = branches.branches[name];
    return {
      name,
      current: info?.current ?? false,
      lastCommit: info?.commit?.slice(0, 7),
      tracking: info?.label?.match(/\[(.+?)\]/)?.[1],
    };
  });
}

export async function createBranch(
  repoPath: string,
  name: string,
  startPoint?: string,
): Promise<void> {
  const git = gitClient(repoPath);
  if (startPoint) {
    await git.checkoutBranch(name, startPoint);
  } else {
    await git.checkoutLocalBranch(name);
  }
}

export async function switchBranch(repoPath: string, name: string): Promise<void> {
  const git = gitClient(repoPath);
  await git.checkout(name);
}

export async function deleteBranch(repoPath: string, name: string, force = false): Promise<void> {
  const git = gitClient(repoPath);
  await git.branch([force ? '-D' : '-d', name]);
}

export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  startPoint = 'HEAD',
): Promise<void> {
  const git = gitClient(repoPath);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  await git.raw(['worktree', 'add', '-B', branchName, worktreePath, startPoint]);
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  const git = gitClient(repoPath);
  try {
    await git.raw(['worktree', 'remove', '--force', worktreePath]);
  } finally {
    await git.raw(['worktree', 'prune']).catch(() => undefined);
  }
}

export async function getFileDiff(
  repoPath: string,
  filePath: string,
  staged: boolean,
): Promise<GitDiffResult> {
  const git = gitClient(repoPath);

  const args = staged ? ['diff', '--cached', '--', filePath] : ['diff', '--', filePath];
  const hunks = await git.raw(args);

  // Get old/new content for the diff viewer
  let oldContent = '';
  let newContent = '';

  try {
    if (staged) {
      oldContent = await git.raw(['show', `HEAD:${filePath}`]).catch(() => '');
      newContent = await git.raw(['show', `:${filePath}`]).catch(() => '');
    } else {
      oldContent = await git.raw(['show', `HEAD:${filePath}`]).catch(() => '');
      const fullPath = path.join(repoPath, filePath);
      newContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : '';
    }
  } catch {
    // New/deleted files won't have both versions
  }

  return { filePath, oldContent, newContent, hunks };
}

export async function mergeBranch(repoPath: string, branch: string): Promise<string> {
  const git = gitClient(repoPath);
  const result = await git.merge([branch]);
  return result.result ?? 'merged';
}

function inferCommitType(
  paths: string[],
  files: Array<{ index: string; working_dir: string }>,
): string {
  if (paths.every((filePath) => /\.(md|mdx|rst|txt)$/i.test(filePath))) return 'docs';
  if (
    paths.some((filePath) =>
      /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\./i.test(filePath),
    )
  ) {
    return 'test';
  }
  if (
    paths.some((filePath) =>
      /package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json/i.test(filePath),
    )
  ) {
    return 'chore';
  }
  if (files.some((file) => file.index === 'A' || file.working_dir === 'A' || file.index === '?')) {
    return 'feat';
  }
  return 'fix';
}

function inferCommitScope(paths: string[]): string {
  const meaningful = paths
    .map((filePath) => filePath.split('/').filter(Boolean))
    .filter((parts) => parts.length > 0);
  if (meaningful.length === 0) return '';

  const firstSegments = new Set(meaningful.map((parts) => parts[0]));
  if (firstSegments.size === 1) return sanitiseCommitScope(meaningful[0][0]);

  const srcChildren = meaningful
    .filter((parts) => parts[0] === 'src' && parts[1])
    .map((parts) => parts[1]);
  if (srcChildren.length === meaningful.length) {
    const unique = new Set(srcChildren);
    if (unique.size === 1) return sanitiseCommitScope(srcChildren[0]);
  }

  return '';
}

function inferCommitAction(files: Array<{ index: string; working_dir: string }>): string {
  if (files.every((file) => file.index === 'A' || file.working_dir === 'A' || file.index === '?')) {
    return 'add';
  }
  if (files.every((file) => file.index === 'D' || file.working_dir === 'D')) return 'remove';
  return 'update';
}

function sanitiseCommitScope(scope: string): string {
  return scope
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

async function getOriginRemoteUrl(git: SimpleGit): Promise<string | undefined> {
  const remotes = await git.getRemotes(true);
  return remotes.find((remote) => remote.name === 'origin')?.refs.fetch;
}

async function resolveDefaultBaseBranch(git: SimpleGit, currentBranch: string): Promise<string> {
  const originHead = await git
    .raw(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    .catch(() => '');
  const defaultBranch = originHead.trim().replace(/^origin\//, '');
  if (defaultBranch && defaultBranch !== currentBranch) return defaultBranch;

  const branches = await git.branch(['-a']);
  for (const candidate of ['main', 'master', 'develop']) {
    if (candidate !== currentBranch && branches.all.some((branch) => branch.endsWith(candidate))) {
      return candidate;
    }
  }

  throw new Error('Could not determine a target branch for the pull request.');
}

async function createProviderPullRequest(
  remoteUrl: string,
  branch: string,
  baseBranch: string,
  title: string,
): Promise<string | undefined> {
  const github = parseGitHubRemoteUrl(remoteUrl);
  if (github) {
    const args = [
      'pr',
      'create',
      '--repo',
      github.host === 'github.com'
        ? `${github.owner}/${github.repo}`
        : `${github.host}/${github.owner}/${github.repo}`,
      '--base',
      baseBranch,
      '--head',
      branch,
      '--title',
      title,
      '--body',
      'Created from workspace changes in Anvil.',
    ];
    const { stdout } = await execFileAsync('gh', args, { encoding: 'utf-8', timeout: 60_000 });
    return stdout.trim() || undefined;
  }

  const ado = parseAdoRemoteUrl(remoteUrl);
  if (ado) {
    const settings = getSettings();
    if (!settings.adoPat) {
      throw new Error('Azure DevOps PAT must be configured in Settings to create pull requests.');
    }

    const response = await fetch(
      `${ado.baseUrl}/${encodeURIComponent(ado.project)}/_apis/git/repositories/${encodeURIComponent(
        ado.repo,
      )}/pullrequests?api-version=7.1`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`:${settings.adoPat}`).toString('base64')}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sourceRefName: `refs/heads/${branch}`,
          targetRefName: `refs/heads/${baseBranch}`,
          title,
          description: 'Created from workspace changes in Anvil.',
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Azure DevOps pull request creation failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { pullRequestId: number };
    return `${ado.baseUrl}/${encodeURIComponent(ado.project)}/_git/${encodeURIComponent(
      ado.repo,
    )}/pullrequest/${data.pullRequestId}`;
  }

  throw new Error('Creating a pull request requires a GitHub or Azure DevOps origin remote.');
}
