import type { FactoryAccess, FactoryDefinitionInput } from '../../../shared/factories';
import type { RepoInfo } from '../../../shared/types';

export const DEFAULT_LIMITS: FactoryDefinitionInput['limits'] = {
  repairRounds: 2,
  maxRunMinutes: 90,
  maxCommands: 40,
  maxConcurrentRuns: 2,
};

export function githubIdentity(repo: RepoInfo): FactoryDefinitionInput['github'] {
  const remote = repo.remoteUrl ?? '';
  const match =
    remote.match(/^(?:https?:\/\/|ssh:\/\/git@)([^/:]+)[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/i) ??
    remote.match(/^git@([^:]+):([^/]+)\/([^/#]+?)(?:\.git)?$/i);
  return {
    host: match?.[1] ?? 'github.com',
    owner: match?.[2] ?? '',
    repo: match?.[3] ?? repo.name,
    label: 'ready-for-agent',
    baseBranch: repo.defaultBranch || 'main',
  };
}

export function isGithubRepo(repo: RepoInfo): boolean {
  return /github\.com|github/i.test(repo.remoteUrl ?? '');
}

export function newDefinition(
  workspaceId: string,
  repo?: RepoInfo,
  workflowTemplateId = '',
): FactoryDefinitionInput {
  const github = repo
    ? githubIdentity(repo)
    : { host: 'github.com', owner: '', repo: '', label: 'ready-for-agent', baseBranch: 'main' };
  return {
    name: 'Issue to reviewed PR',
    workspaceId,
    repoId: repo?.id ?? '',
    github,
    workflowTemplateId,
    criteria: ['The configured pre-PR check command exits successfully.'],
    checks: ['pnpm test'],
    postMergeChecks: ['pnpm test'],
    limits: { ...DEFAULT_LIMITS },
    publication: { enabled: true, draft: true },
    merge: { mode: 'human-approved', method: 'squash', requiredChecks: [], requireApproval: true },
    access: { kind: 'private' },
  };
}

export function withAccess(
  current: FactoryAccess,
  kind: 'private' | 'organization',
): FactoryAccess {
  if (kind === 'private') return { kind: 'private' };
  if (current.kind === 'organization') return current;
  return { kind: 'organization', organizationId: '', visibility: 'team', teamId: '', members: [] };
}

/** Starting points for the conversational draft; each is a complete, reviewable request. */
export const DRAFT_EXAMPLES: Array<{ label: string; request: string }> = [
  {
    label: 'Human-approved merge',
    request:
      'For new ready-for-agent issues, implement the change, run the tests and type checks, and open a draft PR. Repair CI and review feedback at most twice, then ask me to approve the merge.',
  },
  {
    label: 'Auto-merge when green',
    request:
      'For issues labelled ready-for-agent, implement and verify the change, open a PR, and automatically squash-merge once required checks and human review pass. Stop on unclear scope.',
  },
  {
    label: 'Small fixes, tight budget',
    request:
      'Handle issues labelled good-first-fix with a single implementer. Keep each run under 30 minutes and 20 commands, one repair round, human-approved merge.',
  },
];
