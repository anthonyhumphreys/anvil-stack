import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AutomationDefinition,
  WatchtowerEvent,
  WatchtowerEventType,
  WatchtowerState,
} from '../../shared/types.js';
import { getDb } from '../db/database.js';
import { parseAdoRemoteUrl, parseGitHubRemoteUrl } from './code-review-pr.service.js';
import { getSettings } from './settings.service.js';

const execFileAsync = promisify(execFile);
const EXTERNAL_WATCHTOWER_EVENTS = new Set<WatchtowerEventType>([
  'pull_request.merged',
  'pull_request.closed',
  'pipeline.completed',
  'pipeline.failed',
]);
const FAILED_PIPELINE_CONCLUSIONS = new Set([
  'failure',
  'failed',
  'timed_out',
  'startup_failure',
  'stale',
]);

interface WatchtowerRepoRow {
  id: string;
  name: string;
  remote_url: string | null;
}

export interface WatchtowerObservation {
  sourceId: string;
  sourceLabel: string;
  status: string;
  observedAt: string;
  occurredAt?: string;
  terminal: boolean;
  failed: boolean;
  metadata: Record<string, unknown>;
}

interface GitHubPullRequestResponse {
  number: number;
  title: string;
  state: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  url: string;
  headRefName?: string;
  baseRefName?: string;
  mergeCommit?: { oid?: string | null } | null;
}

interface GitHubRunResponse {
  databaseId: number;
  workflowName?: string;
  displayTitle?: string;
  status: string;
  conclusion?: string | null;
  url: string;
  headBranch?: string;
  headSha?: string;
  updatedAt?: string;
  createdAt?: string;
  event?: string;
}

interface AdoPullRequestResponse {
  pullRequestId: number;
  title: string;
  status: string;
  closedDate?: string;
  sourceRefName?: string;
  targetRefName?: string;
  lastMergeCommit?: { commitId?: string };
  _links?: { web?: { href?: string } };
}

interface AdoBuildDefinition {
  id: number;
  name: string;
}

interface AdoBuildResponse {
  id: number;
  buildNumber?: string;
  status: string;
  result?: string;
  queueTime?: string;
  startTime?: string;
  finishTime?: string;
  sourceBranch?: string;
  sourceVersion?: string;
  definition?: AdoBuildDefinition;
  reason?: string;
  _links?: { web?: { href?: string } };
}

export function isExternalWatchtowerEvent(eventType: WatchtowerEventType | undefined): boolean {
  return Boolean(eventType && EXTERNAL_WATCHTOWER_EVENTS.has(eventType));
}

export function shouldTriggerWatchtowerObservation(
  eventType: WatchtowerEventType,
  previous: WatchtowerState | undefined,
  observation: WatchtowerObservation,
): boolean {
  if (!previous?.sourceId || !previous.status) return false;
  if (previous.sourceId === observation.sourceId && previous.status === observation.status) {
    return false;
  }

  if (eventType === 'pull_request.merged') return observation.status === 'merged';
  if (eventType === 'pull_request.closed') return observation.status === 'closed';
  if (eventType === 'pipeline.completed') return observation.terminal;
  if (eventType === 'pipeline.failed') return observation.terminal && observation.failed;
  return false;
}

export function watchtowerStateFromObservation(
  observation: WatchtowerObservation,
): WatchtowerState {
  return {
    sourceId: observation.sourceId,
    sourceLabel: observation.sourceLabel,
    status: observation.status,
    observedAt: observation.observedAt,
    occurredAt: observation.occurredAt,
  };
}

export function buildExternalWatchtowerEvent(
  automation: AutomationDefinition,
  repo: { id: string; name: string },
  observation: WatchtowerObservation,
): WatchtowerEvent {
  const eventType = automation.watchEvent;
  if (!eventType || !isExternalWatchtowerEvent(eventType)) {
    throw new Error('External Watchtower source requires a PR or pipeline event.');
  }

  return {
    id: `${automation.id}:${eventType}:${observation.sourceId}`,
    type: eventType,
    workspaceId: automation.workspaceId,
    repoIds: [repo.id],
    sourceId: observation.sourceId,
    sourceLabel: observation.sourceLabel,
    occurredAt: observation.occurredAt ?? observation.observedAt,
    metadata: {
      repoId: repo.id,
      repoName: repo.name,
      status: observation.status,
      ...observation.metadata,
    },
  };
}

export async function observeExternalWatchtowerSource(automation: AutomationDefinition): Promise<{
  repo: { id: string; name: string };
  observation: WatchtowerObservation;
}> {
  const target = automation.watchTarget;
  if (!target) throw new Error('Watchtower target is missing.');

  const repo = getDb()
    .prepare('SELECT id, name, remote_url FROM repos WHERE id = ?')
    .get(target.repoId) as WatchtowerRepoRow | undefined;
  if (!repo) throw new Error('The watched repository is no longer available.');
  if (!repo.remote_url) throw new Error(`${repo.name} does not have a remote URL.`);

  const github = parseGitHubRemoteUrl(repo.remote_url);
  if (github) {
    const observation = automation.watchEvent?.startsWith('pull_request.')
      ? await observeGitHubPullRequest(github, target.pullRequestNumber)
      : await observeGitHubPipeline(github, target.pipelineIdentifier, target.branch);
    return { repo, observation };
  }

  const ado = parseAdoRemoteUrl(repo.remote_url);
  if (ado) {
    const observation = automation.watchEvent?.startsWith('pull_request.')
      ? await observeAdoPullRequest(ado, target.pullRequestNumber)
      : await observeAdoPipeline(ado, target.pipelineIdentifier, target.branch);
    return { repo, observation };
  }

  throw new Error('Watchtower currently supports GitHub and Azure DevOps remotes.');
}

async function observeGitHubPullRequest(
  repo: { owner: string; repo: string },
  pullRequestNumber?: number,
): Promise<WatchtowerObservation> {
  if (!pullRequestNumber) throw new Error('Enter a pull request number.');
  const response = await runGhJson<GitHubPullRequestResponse>([
    'pr',
    'view',
    String(pullRequestNumber),
    '--repo',
    `${repo.owner}/${repo.repo}`,
    '--json',
    'number,title,state,mergedAt,closedAt,url,headRefName,baseRefName,mergeCommit',
  ]);
  return normaliseGitHubPullRequest(response);
}

async function observeGitHubPipeline(
  repo: { owner: string; repo: string },
  identifier?: string,
  branch?: string,
): Promise<WatchtowerObservation> {
  const trimmedIdentifier = identifier?.trim();
  if (!trimmedIdentifier) throw new Error('Enter a workflow name, file, or run ID.');

  let response: GitHubRunResponse;
  if (/^\d+$/.test(trimmedIdentifier)) {
    response = await runGhJson<GitHubRunResponse>([
      'run',
      'view',
      trimmedIdentifier,
      '--repo',
      `${repo.owner}/${repo.repo}`,
      '--json',
      'databaseId,workflowName,displayTitle,status,conclusion,url,headBranch,headSha,updatedAt,createdAt,event',
    ]);
  } else {
    const args = [
      'run',
      'list',
      '--repo',
      `${repo.owner}/${repo.repo}`,
      '--workflow',
      trimmedIdentifier,
      '--limit',
      '1',
      '--json',
      'databaseId,workflowName,displayTitle,status,conclusion,url,headBranch,headSha,updatedAt,createdAt,event',
    ];
    if (branch?.trim()) args.push('--branch', branch.trim());
    const responses = await runGhJson<GitHubRunResponse[]>(args);
    if (!responses[0]) throw new Error('No matching GitHub Actions run was found.');
    response = responses[0];
  }
  return normalisePipelineObservation('github', response);
}

async function observeAdoPullRequest(
  repo: { baseUrl: string; project: string; repo: string },
  pullRequestNumber?: number,
): Promise<WatchtowerObservation> {
  if (!pullRequestNumber) throw new Error('Enter a pull request number.');
  const url = `${repo.baseUrl}/${encodeURIComponent(repo.project)}/_apis/git/repositories/${encodeURIComponent(repo.repo)}/pullRequests/${pullRequestNumber}?api-version=7.1`;
  const response = await fetchAdoJson<AdoPullRequestResponse>(url);
  const merged = response.status.toLowerCase() === 'completed';
  const closed = response.status.toLowerCase() === 'abandoned';
  return {
    sourceId: `ado-pr:${response.pullRequestId}`,
    sourceLabel: `PR #${response.pullRequestId} · ${response.title}`,
    status: merged ? 'merged' : closed ? 'closed' : 'open',
    observedAt: new Date().toISOString(),
    occurredAt: response.closedDate,
    terminal: merged || closed,
    failed: false,
    metadata: {
      provider: 'azure-devops',
      pullRequestNumber: response.pullRequestId,
      url: response._links?.web?.href,
      headBranch: stripRefPrefix(response.sourceRefName),
      baseBranch: stripRefPrefix(response.targetRefName),
      mergeCommitSha: response.lastMergeCommit?.commitId,
    },
  };
}

async function observeAdoPipeline(
  repo: { baseUrl: string; project: string },
  identifier?: string,
  branch?: string,
): Promise<WatchtowerObservation> {
  const trimmedIdentifier = identifier?.trim();
  if (!trimmedIdentifier) throw new Error('Enter a pipeline name or run ID.');
  const projectBase = `${repo.baseUrl}/${encodeURIComponent(repo.project)}`;
  let build: AdoBuildResponse;

  if (/^\d+$/.test(trimmedIdentifier)) {
    build = await fetchAdoJson<AdoBuildResponse>(
      `${projectBase}/_apis/build/builds/${trimmedIdentifier}?api-version=7.1`,
    );
  } else {
    const definitionsUrl = new URL(`${projectBase}/_apis/build/definitions`);
    definitionsUrl.searchParams.set('name', trimmedIdentifier);
    definitionsUrl.searchParams.set('api-version', '7.1');
    const definitions = await fetchAdoJson<{ value: AdoBuildDefinition[] }>(
      definitionsUrl.toString(),
    );
    const definition = definitions.value.find(
      (candidate) => candidate.name.toLowerCase() === trimmedIdentifier.toLowerCase(),
    );
    if (!definition) throw new Error('No matching Azure DevOps pipeline definition was found.');

    const buildsUrl = new URL(`${projectBase}/_apis/build/builds`);
    buildsUrl.searchParams.set('definitions', String(definition.id));
    buildsUrl.searchParams.set('$top', '1');
    buildsUrl.searchParams.set('queryOrder', 'queueTimeDescending');
    buildsUrl.searchParams.set('api-version', '7.1');
    if (branch?.trim()) {
      buildsUrl.searchParams.set('branchName', `refs/heads/${stripRefPrefix(branch.trim())}`);
    }
    const builds = await fetchAdoJson<{ value: AdoBuildResponse[] }>(buildsUrl.toString());
    if (!builds.value[0]) throw new Error('No matching Azure DevOps pipeline run was found.');
    build = builds.value[0];
  }

  return normaliseAdoPipeline(build);
}

export function normaliseGitHubPullRequest(
  response: GitHubPullRequestResponse,
): WatchtowerObservation {
  const merged = Boolean(response.mergedAt);
  const closed = response.state.toLowerCase() === 'closed';
  return {
    sourceId: `github-pr:${response.number}`,
    sourceLabel: `PR #${response.number} · ${response.title}`,
    status: merged ? 'merged' : closed ? 'closed' : 'open',
    observedAt: new Date().toISOString(),
    occurredAt: response.mergedAt ?? response.closedAt ?? undefined,
    terminal: merged || closed,
    failed: false,
    metadata: {
      provider: 'github',
      pullRequestNumber: response.number,
      url: response.url,
      headBranch: response.headRefName,
      baseBranch: response.baseRefName,
      mergeCommitSha: response.mergeCommit?.oid,
    },
  };
}

export function normalisePipelineObservation(
  provider: 'github',
  response: GitHubRunResponse,
): WatchtowerObservation {
  const terminal = response.status.toLowerCase() === 'completed';
  const conclusion = response.conclusion?.toLowerCase() ?? '';
  const failed = terminal && FAILED_PIPELINE_CONCLUSIONS.has(conclusion);
  const status = terminal ? (failed ? 'failed' : conclusion || 'completed') : response.status;
  return {
    sourceId: `${provider}-run:${response.databaseId}`,
    sourceLabel:
      response.workflowName ?? response.displayTitle ?? `Pipeline run ${response.databaseId}`,
    status,
    observedAt: new Date().toISOString(),
    occurredAt: response.updatedAt ?? response.createdAt,
    terminal,
    failed,
    metadata: {
      provider,
      runId: response.databaseId,
      workflowName: response.workflowName,
      title: response.displayTitle,
      conclusion: response.conclusion,
      url: response.url,
      branch: response.headBranch,
      commitSha: response.headSha,
      event: response.event,
    },
  };
}

function normaliseAdoPipeline(response: AdoBuildResponse): WatchtowerObservation {
  const terminal = response.status.toLowerCase() === 'completed';
  const conclusion = response.result?.toLowerCase() ?? '';
  const failed = terminal && FAILED_PIPELINE_CONCLUSIONS.has(conclusion);
  const status = terminal ? (failed ? 'failed' : conclusion || 'completed') : response.status;
  return {
    sourceId: `ado-build:${response.id}`,
    sourceLabel:
      response.definition?.name ??
      (response.buildNumber ? `Pipeline ${response.buildNumber}` : `Pipeline run ${response.id}`),
    status,
    observedAt: new Date().toISOString(),
    occurredAt: response.finishTime ?? response.startTime ?? response.queueTime,
    terminal,
    failed,
    metadata: {
      provider: 'azure-devops',
      runId: response.id,
      buildNumber: response.buildNumber,
      pipelineName: response.definition?.name,
      conclusion: response.result,
      url: response._links?.web?.href,
      branch: stripRefPrefix(response.sourceBranch),
      commitSha: response.sourceVersion,
      reason: response.reason,
    },
  };
}

async function runGhJson<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileAsync('gh', args, {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

async function fetchAdoJson<T>(url: string): Promise<T> {
  const settings = getSettings();
  if (!settings.adoPat) throw new Error('Azure DevOps credentials are not configured.');
  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`:${settings.adoPat}`).toString('base64')}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Azure DevOps returned HTTP ${response.status}: ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function stripRefPrefix(value?: string): string | undefined {
  return value?.replace(/^refs\/heads\//, '');
}
