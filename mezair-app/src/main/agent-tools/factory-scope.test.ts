import { describe, expect, it } from 'vitest';
import type { FactoryDefinition } from '../../shared/factories.js';
import { factoryWithinSessionScope } from './factory-scope.js';

function factory(overrides: Partial<FactoryDefinition> = {}): FactoryDefinition {
  return {
    id: 'f1',
    workspaceId: 'owner-workspace',
    revision: 1,
    status: 'active',
    ownerId: 'owner',
    accountScope: 'account',
    definition: {
      name: 'Factory',
      workspaceId: 'owner-workspace',
      repoId: 'owner-repo',
      github: {
        host: 'github.com',
        owner: 'Acme',
        repo: 'Widget',
        label: 'ready',
        baseBranch: 'main',
      },
      workflowTemplateId: 'wf',
      criteria: ['check'],
      checks: ['pnpm test'],
      postMergeChecks: ['pnpm verify'],
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
        organizationId: 'org1',
        visibility: 'organization',
        members: [],
      },
    },
    workflow: {} as FactoryDefinition['workflow'],
    confirmation: 'reviewed',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('factory session repository scope', () => {
  it('does not authorize a remote factory using the owner local repo/workspace IDs', () => {
    expect(
      factoryWithinSessionScope(
        factory({ remote: true, sourceAccess: true }),
        'recipient-workspace',
        [{ id: 'repo-1', remoteUrl: 'git@github.com:acme/another.git' }],
      ),
    ).toBe(false);
  });

  it('allows a remote organization factory only when its canonical GitHub source is in this chat scope', () => {
    expect(
      factoryWithinSessionScope(
        factory({ remote: true, sourceAccess: true }),
        'recipient-workspace',
        [{ id: 'recipient-repo', remoteUrl: 'https://github.com/acme/widget.git' }],
      ),
    ).toBe(true);
  });

  it('fails closed if remote source permission is absent or the shared record is private', () => {
    expect(
      factoryWithinSessionScope(
        factory({ remote: true, sourceAccess: false }),
        'recipient-workspace',
        [{ id: 'repo-1', remoteUrl: 'git@github.com:acme/widget.git' }],
      ),
    ).toBe(false);
    const privateDefinition = factory({ remote: true, sourceAccess: true });
    privateDefinition.definition.access = { kind: 'private' };
    expect(
      factoryWithinSessionScope(privateDefinition, 'recipient-workspace', [
        { id: 'repo-1', remoteUrl: 'git@github.com:acme/widget.git' },
      ]),
    ).toBe(false);
  });

  it('keeps private factories constrained to local IDs and workspace', () => {
    const local = factory({
      remote: false,
      definition: { ...factory().definition, access: { kind: 'private' } },
    });
    expect(
      factoryWithinSessionScope(local, 'owner-workspace', [{ id: 'owner-repo', remoteUrl: '' }]),
    ).toBe(true);
    expect(
      factoryWithinSessionScope(local, 'recipient-workspace', [
        { id: 'owner-repo', remoteUrl: '' },
      ]),
    ).toBe(false);
    expect(
      factoryWithinSessionScope(local, 'owner-workspace', [{ id: 'other-repo', remoteUrl: '' }]),
    ).toBe(false);
  });
});
