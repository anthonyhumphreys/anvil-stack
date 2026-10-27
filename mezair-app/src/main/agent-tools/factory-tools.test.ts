import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactoryDefinition, FactoryRun } from '../../shared/factories.js';

const mocks = vi.hoisted(() => ({
  approve: vi.fn(async () => true),
  activateFactory: vi.fn(),
  controlFactory: vi.fn(),
  controlFactoryRun: vi.fn(),
  draftFactory: vi.fn(),
  getFactory: vi.fn(),
  getFactoryRun: vi.fn(),
  listFactories: vi.fn(),
  listFactoryRuns: vi.fn(),
  previewFactory: vi.fn(),
  saveFactory: vi.fn(),
  repositories: [] as Array<{ id: string; remote_url: string | null }>,
}));

vi.mock('../services/factory.service.js', () => ({
  activateFactory: mocks.activateFactory,
  controlFactory: mocks.controlFactory,
  controlFactoryRun: mocks.controlFactoryRun,
  draftFactory: mocks.draftFactory,
  getFactory: mocks.getFactory,
  getFactoryRun: mocks.getFactoryRun,
  listFactories: mocks.listFactories,
  listFactoryRuns: mocks.listFactoryRuns,
  previewFactory: mocks.previewFactory,
  saveFactory: mocks.saveFactory,
}));
vi.mock('../surfaces/core.js', () => ({ requestUserApproval: mocks.approve }));
vi.mock('../db/database.js', () => ({
  getDb: () => ({ prepare: () => ({ all: () => mocks.repositories }) }),
}));

import { factoryToolProvider } from './factory-tools.js';

function factory(remote = false): FactoryDefinition {
  return {
    id: 'factory-1',
    workspaceId: remote ? 'owner-workspace' : 'workspace-1',
    revision: 2,
    activeRevision: 1,
    status: 'active',
    ownerId: 'owner',
    accountScope: 'scope',
    definition: {
      name: 'Issue factory',
      workspaceId: remote ? 'owner-workspace' : 'workspace-1',
      repoId: remote ? 'owner-repo' : 'repo-1',
      github: {
        host: 'github.com',
        owner: 'acme',
        repo: 'widget',
        label: 'ready',
        baseBranch: 'main',
      },
      workflowTemplateId: 'workflow-1',
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
      access: remote
        ? { kind: 'organization', organizationId: 'org-1', visibility: 'organization', members: [] }
        : { kind: 'private' },
    },
    workflow: {} as FactoryDefinition['workflow'],
    confirmation: 'confirmation-2',
    createdAt: '',
    updatedAt: '',
    remote,
    sourceAccess: true,
    effectiveRole: remote ? 'operator' : 'owner',
  };
}
function run(remote = false): FactoryRun {
  const current = factory(remote);
  return {
    id: 'run-1',
    factoryId: current.id,
    revision: 2,
    workspaceId: current.workspaceId,
    snapshot: current,
    issue: {
      number: 9,
      title: 'Fix widget',
      body: '',
      url: 'https://github.com/acme/widget/issues/9',
      labels: ['ready'],
      state: 'open',
      createdAt: '',
      updatedAt: '',
    },
    stage: 'awaiting-merge-approval',
    version: 1,
    repairRounds: 0,
    commandsUsed: 0,
    createdAt: '',
    updatedAt: '',
    deadlineAt: '',
    receipts: [],
    observation: {
      headSha: 'a'.repeat(40),
      state: 'open',
      draft: false,
      checks: [],
      review: 'approved',
      feedback: [],
      observedAt: '',
    },
  };
}
const ctx = {
  sessionId: 's',
  appThreadId: 'thread-1',
  workspaceId: 'workspace-1',
  repoIds: ['repo-1'],
  provider: 'codex' as const,
  mode: 'on-request' as const,
  features: ['automations'] as const,
};
const preview = {
  definition: factory().definition,
  confirmation: 'confirmation-2',
  summary: ['Exact revision'],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.approve.mockResolvedValue(true);
  mocks.repositories = [{ id: 'repo-1', remote_url: 'git@github.com:acme/widget.git' }];
  mocks.previewFactory.mockResolvedValue(preview);
  mocks.getFactory.mockResolvedValue(factory());
  mocks.getFactoryRun.mockResolvedValue(run());
  mocks.getFactory.mockImplementation(async (id: string) =>
    id === 'factory-1' ? factory() : null,
  );
  mocks.activateFactory.mockImplementation(async (input) => ({
    ...factory(),
    activeRevision: input.revision,
  }));
  mocks.controlFactoryRun.mockResolvedValue(run());
});

describe('factory agent tools', () => {
  it('requires affirmative concrete approval before activating the exact revision', async () => {
    await factoryToolProvider.call(ctx, 'factory_activate', {
      factoryId: 'factory-1',
      revision: 2,
      confirmation: 'confirmation-2',
    });
    expect(mocks.previewFactory).toHaveBeenCalledWith(factory().definition, 'factory-1');
    expect(mocks.approve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: 'Activate this factory revision?' }),
      undefined,
    );
    expect(mocks.activateFactory).toHaveBeenCalledWith({
      factoryId: 'factory-1',
      revision: 2,
      confirmation: 'confirmation-2',
    });

    mocks.approve.mockResolvedValueOnce(false);
    await expect(
      factoryToolProvider.call(ctx, 'factory_activate', {
        factoryId: 'factory-1',
        revision: 2,
        confirmation: 'confirmation-2',
      }),
    ).rejects.toThrow(/cancelled/i);
    expect(mocks.activateFactory).toHaveBeenCalledTimes(1);
  });

  it('rejects foreign local workspaces and foreign remote repository identities', async () => {
    mocks.getFactory.mockResolvedValueOnce(factory());
    await expect(
      factoryToolProvider.call(ctx, 'factory_read', { factoryId: 'factory-1' }),
    ).resolves.toBeDefined();
    mocks.repositories = [{ id: 'repo-1', remote_url: 'git@github.com:acme/other.git' }];
    mocks.getFactory.mockResolvedValueOnce(factory(true));
    await expect(
      factoryToolProvider.call(ctx, 'factory_read', { factoryId: 'factory-1' }),
    ).rejects.toThrow(/repository scope/i);
    mocks.repositories = [{ id: 'repo-1', remote_url: 'git@github.com:acme/widget.git' }];
    mocks.getFactory.mockResolvedValueOnce(factory());
    await expect(
      factoryToolProvider.call({ ...ctx, workspaceId: 'foreign-workspace' }, 'factory_read', {
        factoryId: 'factory-1',
      }),
    ).rejects.toThrow(/repository scope/i);
  });

  it('pins a remote edit preview to the selected factory revision ID', async () => {
    mocks.getFactory.mockResolvedValue(factory(true));
    await factoryToolProvider.call(ctx, 'factory_preview', {
      factoryId: 'factory-1',
      definition: factory(true).definition,
    });
    expect(mocks.previewFactory).toHaveBeenCalledWith(factory(true).definition, 'factory-1');
  });

  it('only exposes current-head merge approval through run control, never a policy change', async () => {
    mocks.getFactoryRun.mockResolvedValue(run(true));
    await factoryToolProvider.call(ctx, 'factory_run_control', {
      runId: 'run-1',
      action: 'approve-merge',
      expectedHeadSha: 'a'.repeat(40),
    });
    expect(mocks.controlFactoryRun).toHaveBeenCalledWith({
      runId: 'run-1',
      action: 'approve-merge',
      expectedHeadSha: 'a'.repeat(40),
    });
    expect(mocks.controlFactoryRun.mock.calls[0]?.[0]).not.toHaveProperty('definition');
  });

  it('passes the selected recipient context for pickup and rejects missing context', async () => {
    mocks.getFactoryRun.mockResolvedValue(run(true));
    const takeoverContext = {
      workspaceId: 'recipient-workspace',
      repoId: 'recipient-repo',
      personaId: 'coder',
    };
    await factoryToolProvider.call(ctx, 'factory_run_control', {
      runId: 'run-1',
      action: 'takeover',
      takeoverContext,
    });
    expect(mocks.controlFactoryRun).toHaveBeenCalledWith({
      runId: 'run-1',
      action: 'takeover',
      takeoverContext,
    });
    await expect(
      factoryToolProvider.call(ctx, 'factory_run_control', { runId: 'run-1', action: 'takeover' }),
    ).rejects.toThrow(/choose a recipient workspace/i);
  });
});
