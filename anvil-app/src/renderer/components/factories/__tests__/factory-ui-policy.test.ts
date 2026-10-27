import { describe, expect, it } from 'vitest';
import type { FactoryDefinition, FactoryRun } from '../../../../shared/factories';
import {
  canManageFactory,
  canOperateFactory,
  canReadFactorySource,
  canReadRunSource,
  effectiveFactoryRole,
} from '../factory-ui-policy';

function factory(overrides: Partial<FactoryDefinition> = {}): FactoryDefinition {
  return {
    id: 'factory-1',
    workspaceId: 'owner-workspace',
    revision: 1,
    status: 'active',
    ownerId: 'owner',
    accountScope: 'owner-account',
    definition: {
      name: 'Factory',
      workspaceId: 'owner-workspace',
      repoId: 'owner-local-repo',
      github: {
        host: 'github.com',
        owner: 'acme',
        repo: 'project',
        label: 'ready',
        baseBranch: 'main',
      },
      workflowTemplateId: 'workflow-1',
      criteria: ['test'],
      checks: ['pnpm test'],
      postMergeChecks: [],
      limits: { repairRounds: 1, maxRunMinutes: 30, maxCommands: 10, maxConcurrentRuns: 1 },
      publication: { enabled: true, draft: true },
      merge: {
        mode: 'human-approved',
        method: 'squash',
        requiredChecks: [],
        requireApproval: true,
      },
      access: {
        kind: 'organization',
        organizationId: 'org-1',
        visibility: 'organization',
        members: [],
      },
    },
    workflow: {} as FactoryDefinition['workflow'],
    confirmation: 'digest',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function run(overrides: Partial<FactoryRun> = {}): FactoryRun {
  return {
    id: 'run-1',
    factoryId: 'factory-1',
    revision: 1,
    workspaceId: 'owner-workspace',
    snapshot: factory(),
    issue: {
      number: 1,
      title: 'Issue title',
      body: 'Issue details',
      url: 'https://github.com/acme/project/issues/1',
      labels: [],
      state: 'open',
      createdAt: '',
      updatedAt: '',
    },
    stage: 'implementing',
    version: 1,
    repairRounds: 0,
    commandsUsed: 0,
    createdAt: '',
    updatedAt: '',
    deadlineAt: '',
    receipts: [],
    ...overrides,
  };
}

describe('factory UI access policy', () => {
  it('keeps pending organization access read-only and hides source details', () => {
    const pending = factory({ accessPending: true, sourceAccess: false });
    expect(effectiveFactoryRole(pending)).toBeUndefined();
    expect(canManageFactory(pending)).toBe(false);
    expect(canOperateFactory(pending)).toBe(false);
    expect(canReadFactorySource(pending)).toBe(false);
    expect(canReadRunSource(run({ accessPending: true, sourceAccess: false }))).toBe(false);
  });

  it('fails closed when an organization projection omits verified source access', () => {
    expect(canReadFactorySource(factory({ effectiveRole: 'owner' }))).toBe(false);
    expect(canReadRunSource(run())).toBe(false);
  });

  it('lets verified operator operate a shared run without editing factory policy', () => {
    const operator = factory({ effectiveRole: 'operator', sourceAccess: true });
    expect(canOperateFactory(operator)).toBe(true);
    expect(canManageFactory(operator)).toBe(false);
    expect(canReadFactorySource(operator)).toBe(true);
  });

  it('blocks writes while a remote command awaits the owner daemon', () => {
    const waiting = factory({ effectiveRole: 'owner', commandPending: true });
    expect(canManageFactory(waiting)).toBe(false);
    expect(canOperateFactory(waiting)).toBe(false);
  });

  it('keeps private local factory owner usable when role projection is omitted', () => {
    const local = factory({ definition: { ...factory().definition, access: { kind: 'private' } } });
    expect(effectiveFactoryRole(local)).toBe('owner');
    expect(canManageFactory(local)).toBe(true);
    expect(canOperateFactory(local)).toBe(true);
  });
});
