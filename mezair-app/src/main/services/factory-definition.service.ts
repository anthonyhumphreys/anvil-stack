import { createHash } from 'node:crypto';
import type { FactoryDefinitionInput, FactoryPreview } from '../../shared/factories.js';
import { factoryWorkflowIssues } from '../../shared/factories.js';
import type { WorkflowTemplate } from '../../shared/types.js';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Factory definition must be an object.');
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 500): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    [...value].some(
      (character) => character.charCodeAt(0) < 32 && ![9, 10, 13].includes(character.charCodeAt(0)),
    )
  )
    throw new Error(`Invalid ${label}.`);
  return value.trim();
}
function list(value: unknown, label: string, empty = false): string[] {
  if (!Array.isArray(value) || (!empty && !value.length) || value.length > 32)
    throw new Error(`Invalid ${label}.`);
  return value.map((v) => text(v, label, 4000));
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new Error(`Invalid ${label}.`);
  return Number(value);
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${label}.`);
  return value;
}
export function validateFactoryDefinition(value: unknown): FactoryDefinitionInput {
  const input = record(value),
    github = record(input.github),
    limits = record(input.limits),
    publication = record(input.publication),
    merge = record(input.merge),
    access = record(input.access);
  if (JSON.stringify(value).length > 256000) throw new Error('Factory definition is too large.');
  const host = text(github.host, 'GitHub host', 253).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..'))
    throw new Error('Invalid GitHub host.');
  const owner = text(github.owner, 'GitHub owner', 100),
    repo = text(github.repo, 'GitHub repository', 100);
  if (
    !/^[a-zA-Z0-9_.-]+$/.test(owner) ||
    !/^[a-zA-Z0-9_.-]+$/.test(repo) ||
    ['.', '..'].includes(owner) ||
    ['.', '..'].includes(repo)
  )
    throw new Error('Invalid GitHub source identity.');
  const criteria = list(input.criteria, 'acceptance criteria'),
    checks = list(input.checks, 'acceptance checks');
  if (criteria.length !== checks.length || new Set(criteria).size !== criteria.length)
    throw new Error(
      'Each unique acceptance criterion needs one reviewed verification command in the same order.',
    );
  const baseBranch = text(github.baseBranch, 'base branch', 200);
  if (
    baseBranch.startsWith('-') ||
    /[\s~^:?*[\\]/.test(baseBranch) ||
    baseBranch.includes('..') ||
    baseBranch.includes('@{') ||
    baseBranch.endsWith('/') ||
    baseBranch.endsWith('.')
  )
    throw new Error('Invalid base branch.');
  if (
    !['human-approved', 'auto-merge'].includes(String(merge.mode)) ||
    !['squash', 'merge', 'rebase'].includes(String(merge.method))
  )
    throw new Error('Invalid merge policy.');
  let audience: FactoryDefinitionInput['access'];
  if (access.kind === 'private') audience = { kind: 'private' };
  else if (access.kind === 'organization') {
    if (
      !['organization', 'team', 'restricted'].includes(String(access.visibility)) ||
      !Array.isArray(access.members) ||
      access.members.length > 100
    )
      throw new Error('Invalid organisation visibility or members.');
    const members = access.members.map((value) => {
      const member = record(value);
      if (!['viewer', 'operator', 'owner'].includes(String(member.role)))
        throw new Error('Invalid factory role.');
      return {
        userId: text(member.userId, 'member id', 200),
        role: member.role as 'viewer' | 'operator' | 'owner',
      };
    });
    if (new Set(members.map((m) => m.userId)).size !== members.length)
      throw new Error('Duplicate factory member.');
    audience = {
      kind: 'organization',
      organizationId: text(access.organizationId, 'organisation id', 200),
      visibility: access.visibility as 'organization' | 'team' | 'restricted',
      members,
      ...(access.visibility === 'team' ? { teamId: text(access.teamId, 'team id', 200) } : {}),
    };
  } else throw new Error('Choose a private or organisation audience.');
  const result: FactoryDefinitionInput = {
    name: text(input.name, 'factory name', 200),
    workspaceId: text(input.workspaceId, 'workspace id', 200),
    repoId: text(input.repoId, 'repository id', 200),
    github: { host, owner, repo, label: text(github.label, 'issue label', 100), baseBranch },
    workflowTemplateId: text(input.workflowTemplateId, 'workflow template', 200),
    criteria,
    checks,
    postMergeChecks: list(input.postMergeChecks, 'post-merge checks'),
    limits: {
      repairRounds: integer(limits.repairRounds, 'repair rounds', 0, 8),
      maxRunMinutes: integer(limits.maxRunMinutes, 'run minutes', 1, 1440),
      maxCommands: integer(limits.maxCommands, 'command budget', 1, 1000),
      maxConcurrentRuns: integer(limits.maxConcurrentRuns, 'concurrent runs', 1, 8),
    },
    publication: {
      enabled: bool(publication.enabled, 'publication permission'),
      draft: bool(publication.draft, 'draft pull request'),
    },
    merge: {
      mode: merge.mode as 'human-approved' | 'auto-merge',
      method: merge.method as 'squash' | 'merge' | 'rebase',
      requiredChecks: list(merge.requiredChecks, 'required GitHub checks', true),
      requireApproval: bool(merge.requireApproval, 'required human review'),
    },
    access: audience,
  };
  if (result.limits.maxCommands < checks.length + result.postMergeChecks.length + 1)
    throw new Error(
      'Command budget must leave room for implementation, acceptance and post-merge checks.',
    );
  if (result.merge.mode === 'auto-merge' && !result.publication.enabled)
    throw new Error('Auto-merge requires explicit publication permission.');
  return result;
}
export function validateFactoryWorkflow(workflow: WorkflowTemplate): void {
  const [issue] = factoryWorkflowIssues(workflow);
  if (issue) throw new Error(issue);
}
export function factoryPreview(
  definition: FactoryDefinitionInput,
  workflow: WorkflowTemplate,
  actorScope: string,
): FactoryPreview {
  validateFactoryWorkflow(workflow);
  const confirmation = createHash('sha256')
    .update(JSON.stringify({ definition, workflow, actorScope }))
    .digest('hex');
  return {
    definition,
    confirmation,
    summary: [
      `${definition.github.host}/${definition.github.owner}/${definition.github.repo}: new issues labelled ${definition.github.label}; base ${definition.github.baseBranch}`,
      `Pinned graph ${workflow.name}; ${workflow.nodes.length} steps; models ${[...new Set(workflow.nodes.map((n) => n.model))].join(', ')}`,
      `Each ordered criterion is bound to the verification command at the same index; subjective acceptance requires human review.`,
      `${definition.criteria.length} acceptance checks; ${definition.postMergeChecks.length} post-merge checks; ${definition.limits.maxCommands} observed shell commands; ${definition.limits.maxRunMinutes} wall-clock minutes; ${definition.limits.repairRounds} repair rounds.`,
      definition.publication.enabled
        ? 'Standing authority to publish verified task branches and pull requests.'
        : 'Publication disabled; runs cannot publish.',
      definition.merge.mode === 'auto-merge'
        ? 'Standing automatic merge authority when exact-head acceptance, required checks and human review conditions pass.'
        : 'An authorised person must approve the current verified head before each merge.',
      `Visibility: ${definition.access.kind === 'private' ? 'private' : definition.access.visibility}. Existing run history follows current visibility and source permissions.`,
      'Activation applies to future issues. Existing runs retain their graph and original grants; pauses, revoked access and reductions in merge authority apply immediately.',
    ],
  };
}
