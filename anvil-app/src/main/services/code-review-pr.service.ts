import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CodeReviewFinding,
  CodeReviewPullRequest,
  CodeReviewPullRequestComment,
  CodeReviewPullRequestRef,
} from '../../shared/types.js';
import {
  getPullRequestRefDiff,
  normalizeBranchName,
  splitDiffByFile,
  type GitDiffFile,
} from './code-review-git.service.js';
import { checkGhAuthStatus } from './remote-repo.service.js';
import { getSettings } from './settings.service.js';

const execFileAsync = promisify(execFile);

interface GitHubRepoSpec {
  provider: 'github';
  host: string;
  owner: string;
  repo: string;
}

interface AdoRepoSpec {
  provider: 'ado';
  baseUrl: string;
  project: string;
  repo: string;
}

type RemoteRepoSpec = GitHubRepoSpec | AdoRepoSpec;

interface GithubPullRequestResponse {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  updatedAt: string;
  url: string;
  author?: { login?: string | null } | null;
  headRefName: string;
  baseRefName: string;
}

interface AdoPullRequestResponse {
  pullRequestId: number;
  title: string;
  status: string;
  creationDate: string;
  closedDate?: string;
  isDraft?: boolean;
  createdBy?: { displayName?: string };
  sourceRefName: string;
  targetRefName: string;
}

interface GitHubIssueCommentResponse {
  id: number;
  html_url?: string;
}

interface AdoPullRequestThreadResponse {
  id: number;
  url?: string;
}

interface PullRequestReviewResolution {
  pullRequest: CodeReviewPullRequest;
  diffFiles: GitDiffFile[];
}

interface AdoPullRequestResolution {
  pullRequest: CodeReviewPullRequest;
  sourceRefName: string;
  targetRefName: string;
}

export async function listPullRequests(
  remoteUrl?: string | null,
): Promise<CodeReviewPullRequest[]> {
  const spec = getRemoteRepoSpec(remoteUrl);
  if (!spec) {
    throw new Error(
      'Pull request mode requires a repository with a GitHub or Azure DevOps remote.',
    );
  }

  if (spec.provider === 'github') {
    return listGithubPullRequests(spec);
  }

  return listAdoPullRequests(spec);
}

export async function resolvePullRequestForReview(
  repoPath: string,
  remoteUrl: string | null | undefined,
  pullRequestId: string,
): Promise<PullRequestReviewResolution> {
  const spec = getRemoteRepoSpec(remoteUrl);
  if (!spec) {
    throw new Error(
      'Pull request mode requires a repository with a GitHub or Azure DevOps remote.',
    );
  }

  const normalizedPullRequestId = normalizePullRequestId(pullRequestId);

  if (spec.provider === 'github') {
    const pullRequest = await getGithubPullRequest(spec, normalizedPullRequestId);
    const patch = await runGh([
      'pr',
      'diff',
      normalizedPullRequestId,
      '--repo',
      formatGhRepoIdentifier(spec),
      '--patch',
    ]);

    return {
      pullRequest,
      diffFiles: splitDiffByFile(patch),
    };
  }

  const resolution = await getAdoPullRequest(spec, normalizedPullRequestId);
  return {
    pullRequest: resolution.pullRequest,
    diffFiles: getPullRequestRefDiff(repoPath, resolution.targetRefName, resolution.sourceRefName),
  };
}

export async function postFindingCommentToPullRequest(
  remoteUrl: string | null | undefined,
  pullRequest: CodeReviewPullRequestRef,
  finding: CodeReviewFinding,
): Promise<CodeReviewPullRequestComment> {
  const spec = getRemoteRepoSpec(remoteUrl);
  if (!spec) {
    throw new Error('Posting feedback requires a repository with a GitHub or Azure DevOps remote.');
  }

  const pullRequestId = normalizePullRequestId(pullRequest.id);
  const body = buildPullRequestFindingCommentBody(finding);
  const postedAt = new Date().toISOString();

  if (spec.provider === 'github') {
    const response = await postGithubIssueComment(spec, pullRequestId, body);
    return {
      id: String(response.id),
      url: response.html_url,
      postedAt,
    };
  }

  const response = await postAdoPullRequestThread(spec, pullRequestId, body);
  return {
    id: String(response.id),
    url: response.url ?? buildAdoPullRequestWebUrl(spec, Number(pullRequestId)),
    postedAt,
  };
}

export async function postCommentToPullRequest(
  remoteUrl: string | null | undefined,
  pullRequest: CodeReviewPullRequestRef,
  body: string,
): Promise<CodeReviewPullRequestComment> {
  const spec = getRemoteRepoSpec(remoteUrl);
  if (!spec) {
    throw new Error('Posting feedback requires a repository with a GitHub or Azure DevOps remote.');
  }

  const pullRequestId = normalizePullRequestId(pullRequest.id);
  const postedAt = new Date().toISOString();

  if (spec.provider === 'github') {
    const response = await postGithubIssueComment(spec, pullRequestId, body);
    return {
      id: String(response.id),
      url: response.html_url,
      postedAt,
    };
  }

  const response = await postAdoPullRequestThread(spec, pullRequestId, body);
  return {
    id: String(response.id),
    url: response.url ?? buildAdoPullRequestWebUrl(spec, Number(pullRequestId)),
    postedAt,
  };
}

export function parseGitHubRemoteUrl(remoteUrl: string): GitHubRepoSpec | null {
  const sshMatch = remoteUrl.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (sshMatch) {
    const [, host, owner, repo] = sshMatch;
    if (isGitHubHost(host)) {
      return { provider: 'github', host, owner, repo };
    }
  }

  try {
    const url = new URL(remoteUrl);
    if (!isGitHubHost(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;

    return {
      provider: 'github',
      host: url.hostname,
      owner: decodeURIComponent(parts[0]),
      repo: decodeURIComponent(parts[1]).replace(/\.git$/i, ''),
    };
  } catch {
    return null;
  }
}

export function parseAdoRemoteUrl(remoteUrl: string): AdoRepoSpec | null {
  try {
    const url = new URL(remoteUrl);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const hostname = url.hostname.toLowerCase();

    if (hostname === 'dev.azure.com') {
      if (parts.length < 4 || parts[2] !== '_git') return null;
      return {
        provider: 'ado',
        baseUrl: `${url.protocol}//${url.host}/${parts[0]}`,
        project: parts[1],
        repo: parts[3],
      };
    }

    if (hostname.endsWith('.visualstudio.com')) {
      if (parts.length < 3 || parts[1] !== '_git') return null;
      return {
        provider: 'ado',
        baseUrl: `${url.protocol}//${url.host}`,
        project: parts[0],
        repo: parts[2],
      };
    }

    return null;
  } catch {
    return null;
  }
}

export function buildPullRequestFindingCommentBody(finding: CodeReviewFinding): string {
  const location = formatFindingLocation(finding);
  const lines = [
    'Anvil code review finding',
    '',
    `Severity: ${finding.severity}`,
    `Category: ${finding.category}`,
  ];

  if (location) {
    lines.push(`Location: ${location}`);
  }

  lines.push('', 'Issue:', finding.description.trim());

  if (finding.suggestion?.trim()) {
    lines.push('', 'Suggestion:', finding.suggestion.trim());
  }

  lines.push('', '_Generated by Anvil Code Review._');
  return lines.join('\n');
}

function getRemoteRepoSpec(remoteUrl?: string | null): RemoteRepoSpec | null {
  if (!remoteUrl) return null;
  return parseGitHubRemoteUrl(remoteUrl) ?? parseAdoRemoteUrl(remoteUrl);
}

async function listGithubPullRequests(spec: GitHubRepoSpec): Promise<CodeReviewPullRequest[]> {
  const stdout = await runGh([
    'pr',
    'list',
    '--repo',
    formatGhRepoIdentifier(spec),
    '--limit',
    '100',
    '--state',
    'all',
    '--json',
    'number,title,state,isDraft,author,headRefName,baseRefName,updatedAt,url',
  ]);

  const pullRequests = JSON.parse(stdout) as GithubPullRequestResponse[];
  return pullRequests
    .map((pullRequest) => mapGithubPullRequest(spec, pullRequest))
    .sort(comparePullRequests);
}

async function getGithubPullRequest(
  spec: GitHubRepoSpec,
  pullRequestId: string,
): Promise<CodeReviewPullRequest> {
  const stdout = await runGh([
    'pr',
    'view',
    pullRequestId,
    '--repo',
    formatGhRepoIdentifier(spec),
    '--json',
    'number,title,state,isDraft,author,headRefName,baseRefName,updatedAt,url',
  ]);

  return mapGithubPullRequest(spec, JSON.parse(stdout) as GithubPullRequestResponse);
}

async function listAdoPullRequests(spec: AdoRepoSpec): Promise<CodeReviewPullRequest[]> {
  const response = await fetch(buildAdoPullRequestListUrl(spec), {
    headers: getAdoHeaders(),
  });

  if (!response.ok) {
    throw new Error(
      `Azure DevOps pull request list failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as { value: AdoPullRequestResponse[] };
  return data.value
    .map((pullRequest) => mapAdoPullRequest(spec, pullRequest))
    .sort(comparePullRequests);
}

async function getAdoPullRequest(
  spec: AdoRepoSpec,
  pullRequestId: string,
): Promise<AdoPullRequestResolution> {
  const response = await fetch(buildAdoPullRequestUrl(spec, pullRequestId), {
    headers: getAdoHeaders(),
  });

  if (!response.ok) {
    throw new Error(
      `Azure DevOps pull request lookup failed: ${response.status} ${response.statusText}`,
    );
  }

  const pullRequest = (await response.json()) as AdoPullRequestResponse;
  return {
    pullRequest: mapAdoPullRequest(spec, pullRequest),
    sourceRefName: pullRequest.sourceRefName,
    targetRefName: pullRequest.targetRefName,
  };
}

async function postGithubIssueComment(
  spec: GitHubRepoSpec,
  pullRequestId: string,
  body: string,
): Promise<GitHubIssueCommentResponse> {
  const args = ['api', '--method', 'POST'];
  if (spec.host !== 'github.com') {
    args.push('--hostname', spec.host);
  }
  args.push(
    `repos/${spec.owner}/${spec.repo}/issues/${pullRequestId}/comments`,
    '--raw-field',
    `body=${body}`,
  );

  const stdout = await runGh(args);

  return JSON.parse(stdout) as GitHubIssueCommentResponse;
}

async function postAdoPullRequestThread(
  spec: AdoRepoSpec,
  pullRequestId: string,
  body: string,
): Promise<AdoPullRequestThreadResponse> {
  const response = await fetch(buildAdoPullRequestThreadsUrl(spec, pullRequestId), {
    method: 'POST',
    headers: getAdoHeaders({ withJsonBody: true }),
    body: JSON.stringify({
      comments: [
        {
          parentCommentId: 0,
          content: body,
          commentType: 1,
        },
      ],
      status: 1,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Azure DevOps pull request comment failed: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as AdoPullRequestThreadResponse;
}

function mapGithubPullRequest(
  spec: GitHubRepoSpec,
  pullRequest: GithubPullRequestResponse,
): CodeReviewPullRequest {
  return {
    id: String(pullRequest.number),
    title: pullRequest.title,
    provider: 'github',
    state: mapGithubState(pullRequest.state),
    isDraft: pullRequest.isDraft,
    author: pullRequest.author?.login ?? undefined,
    sourceBranch: normalizeBranchName(pullRequest.headRefName),
    targetBranch: normalizeBranchName(pullRequest.baseRefName),
    updatedAt: pullRequest.updatedAt,
    url: pullRequest.url ?? buildGithubPullRequestUrl(spec, pullRequest.number),
  };
}

function mapAdoPullRequest(
  spec: AdoRepoSpec,
  pullRequest: AdoPullRequestResponse,
): CodeReviewPullRequest {
  return {
    id: String(pullRequest.pullRequestId),
    title: pullRequest.title,
    provider: 'ado',
    state: mapAdoState(pullRequest.status),
    isDraft: pullRequest.isDraft ?? false,
    author: pullRequest.createdBy?.displayName ?? undefined,
    sourceBranch: normalizeBranchName(pullRequest.sourceRefName),
    targetBranch: normalizeBranchName(pullRequest.targetRefName),
    updatedAt: pullRequest.closedDate ?? pullRequest.creationDate,
    url: buildAdoPullRequestWebUrl(spec, pullRequest.pullRequestId),
  };
}

function comparePullRequests(a: CodeReviewPullRequest, b: CodeReviewPullRequest): number {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function normalizePullRequestId(pullRequestId: string): string {
  const normalized = pullRequestId.trim().replace(/^#/, '');
  if (!/^\d+$/.test(normalized)) {
    throw new Error('Pull request IDs must be numeric.');
  }
  return normalized;
}

function buildAdoPullRequestListUrl(spec: AdoRepoSpec): string {
  return `${spec.baseUrl}/${encodeURIComponent(spec.project)}/_apis/git/repositories/${encodeURIComponent(
    spec.repo,
  )}/pullrequests?searchCriteria.status=all&$top=100&api-version=7.1`;
}

function buildAdoPullRequestUrl(spec: AdoRepoSpec, pullRequestId: string): string {
  return `${spec.baseUrl}/${encodeURIComponent(spec.project)}/_apis/git/repositories/${encodeURIComponent(
    spec.repo,
  )}/pullRequests/${pullRequestId}?api-version=7.1`;
}

function buildAdoPullRequestThreadsUrl(spec: AdoRepoSpec, pullRequestId: string): string {
  return `${spec.baseUrl}/${encodeURIComponent(spec.project)}/_apis/git/repositories/${encodeURIComponent(
    spec.repo,
  )}/pullRequests/${pullRequestId}/threads?api-version=7.1`;
}

function buildAdoPullRequestWebUrl(spec: AdoRepoSpec, pullRequestId: number): string {
  return `${spec.baseUrl}/${encodeURIComponent(spec.project)}/_git/${encodeURIComponent(
    spec.repo,
  )}/pullrequest/${pullRequestId}`;
}

function buildGithubPullRequestUrl(spec: GitHubRepoSpec, pullRequestNumber: number): string {
  return `https://${spec.host}/${spec.owner}/${spec.repo}/pull/${pullRequestNumber}`;
}

function formatGhRepoIdentifier(spec: GitHubRepoSpec): string {
  if (spec.host === 'github.com') {
    return `${spec.owner}/${spec.repo}`;
  }
  return `${spec.host}/${spec.owner}/${spec.repo}`;
}

function mapGithubState(state: string): CodeReviewPullRequest['state'] {
  switch (state.toLowerCase()) {
    case 'open':
      return 'open';
    case 'merged':
      return 'merged';
    default:
      return 'closed';
  }
}

function mapAdoState(state: string): CodeReviewPullRequest['state'] {
  switch (state.toLowerCase()) {
    case 'active':
      return 'open';
    case 'completed':
      return 'merged';
    default:
      return 'closed';
  }
}

async function runGh(args: string[]): Promise<string> {
  const auth = await checkGhAuthStatus();
  if (!auth.authenticated) {
    throw new Error(auth.error ?? 'GitHub CLI not authenticated');
  }

  try {
    const { stdout } = await execFileAsync('gh', args, {
      encoding: 'utf-8',
      timeout: 60_000,
      maxBuffer: 25 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    throw new Error(getProcessErrorMessage('GitHub pull request request failed', error));
  }
}

function getAdoHeaders(options?: { withJsonBody?: boolean }): Record<string, string> {
  const settings = getSettings();
  if (!settings.adoPat) {
    throw new Error('Azure DevOps PAT must be configured in Settings to browse pull requests.');
  }

  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`:${settings.adoPat}`).toString('base64')}`,
    Accept: 'application/json',
  };

  if (options?.withJsonBody) {
    headers['Content-Type'] = 'application/json';
  }

  return headers;
}

function isGitHubHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === 'github.com' ||
    normalized.endsWith('.github.com') ||
    normalized.startsWith('github.') ||
    normalized.includes('.github.')
  );
}

function getProcessErrorMessage(context: string, error: unknown): string {
  if (error && typeof error === 'object') {
    const stderr = 'stderr' in error ? String(error.stderr ?? '').trim() : '';
    const stdout = 'stdout' in error ? String(error.stdout ?? '').trim() : '';
    if (stderr) return `${context}: ${stderr}`;
    if (stdout) return `${context}: ${stdout}`;
  }

  return `${context}: ${error instanceof Error ? error.message : String(error)}`;
}

function formatFindingLocation(
  finding: Pick<CodeReviewFinding, 'filePath' | 'lineStart' | 'lineEnd'>,
): string | null {
  if (!finding.filePath) return null;
  if (!finding.lineStart) return finding.filePath;
  if (finding.lineEnd && finding.lineEnd !== finding.lineStart) {
    return `${finding.filePath}:${finding.lineStart}-${finding.lineEnd}`;
  }
  return `${finding.filePath}:${finding.lineStart}`;
}
