import { beforeEach, describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../db/schema.js';
import type {
  FactoryDefinition,
  FactoryDefinitionInput,
  FactoryRun,
} from '../../../shared/factories.js';
import type { WorkflowTemplate } from '../../../shared/types.js';
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database.Database,
  actor: null as { id: string; accountScope: string } | null,
  remote: new Map<string, FactoryDefinition>(),
  remoteRuns: new Map<string, FactoryRun>(),
  role: 'owner',
  executor: false,
  daemon: true,
}));
state.db = new Database(':memory:');
state.db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => state.db }));
vi.mock('node:fs', () => ({ default: { existsSync: () => true } }));
vi.mock('../factory-provider.service.js', () => ({ factoryProvider: {} }));
vi.mock('../factory-access.service.js', () => ({
  getFactoryActor: () => state.actor,
  authorizeFactoryAccess: vi.fn(async () => ({
    role: state.role,
    organizationAdmin: false,
    executionOwner: state.executor,
  })),
  listRemoteFactories: vi.fn(async () => [...state.remote.values()]),
  getRemoteFactory: vi.fn(async (id: string) => state.remote.get(id) ?? null),
  listRemoteFactoryRuns: vi.fn(async (id: string) =>
    [...state.remoteRuns.values()].filter((run) => run.factoryId === id),
  ),
  getRemoteFactoryRun: vi.fn(async (_f: string, id: string) => state.remoteRuns.get(id) ?? null),
  publishFactorySnapshot: vi.fn(async (factory: FactoryDefinition) => {
    state.remote.set(factory.id, structuredClone(factory));
  }),
  sendOrganizationFactoryCommand: vi.fn(async () => ({ id: 'remote-command' })),
  listRemoteOrganizations: vi.fn(async () => []),
  listRemoteFactoryMembers: vi.fn(async () => []),
  validateRemoteFactoryTeam: vi.fn(async () => true),
  registerRemoteFactoryKey: vi.fn(async () => 'member'),
  listRemoteFactoryDirectory: vi.fn(async () => []),
  republishFactorySnapshots: vi.fn(),
  takeOrganizationFactoryCommands: vi.fn(async () => []),
}));
vi.mock('../workflow.service.js', () => ({
  getWorkflowTemplate: vi.fn(),
  listWorkflowTemplates: vi.fn(() => []),
  validateWorkflowGraph: vi.fn(),
  cancelWorkflowRun: vi.fn(),
  getWorkflowRun: vi.fn(),
  getChatWorkflowRunByRequest: vi.fn(),
  startChatWorkflowRun: vi.fn(),
}));
vi.mock('../settings.service.js', () => ({
  getSettings: () => ({
    llmProvider: 'codex',
    enabledLlmProviders: ['codex'],
    codexMode: 'workspace-auto',
  }),
}));
vi.mock('../code-review-pr.service.js', () => ({
  parseGitHubRemoteUrl: (url: string) =>
    url.includes('acme/repo') ? { host: 'github.com', owner: 'acme', repo: 'repo' } : null,
}));
vi.mock('../persona.service.js', () => ({ getPersonaById: () => ({ id: 'coder' }) }));
vi.mock('../automation-daemon.service.js', () => ({
  isAutomationDaemonMode: () => false,
  installAutomationDaemon: vi.fn(() => ({
    supported: state.daemon,
    installed: state.daemon,
    loaded: state.daemon,
  })),
}));
vi.mock('../llm.service.js', () => ({ callLlm: vi.fn() }));
vi.mock('../chat-persistence.service.js', () => ({
  createChatThread: vi.fn(),
  getChatThread: vi.fn(),
  saveChatEntry: vi.fn(),
}));
import { getWorkflowTemplate } from '../workflow.service.js';
import { createChatThread } from '../chat-persistence.service.js';
import {
  activateFactory,
  controlFactoryRun,
  getFactoryRun,
  listFactories,
  previewFactory,
  saveFactory,
} from '../factory.service.js';
import { FactoryStore } from '../factory-persistence.service.js';
const workflow = {
  id: 'workflow',
  name: 'Pinned',
  description: '',
  nodes: [
    {
      id: 'code',
      name: 'Implement',
      kind: 'agent',
      provider: 'codex',
      personaId: 'coder',
      model: 'gpt-6.1-sol',
      prompt: 'Implement',
      reasoningEffort: 'medium',
      executionStrategy: 'focused',
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
  createdAt: '',
  updatedAt: '',
} as WorkflowTemplate;
const definition: FactoryDefinitionInput = {
  name: 'Factory',
  workspaceId: 'ws',
  repoId: 'repo',
  github: { host: 'github.com', owner: 'acme', repo: 'repo', label: 'ready', baseBranch: 'main' },
  workflowTemplateId: 'workflow',
  criteria: ['Requirement'],
  checks: ['npm test'],
  postMergeChecks: ['npm test'],
  limits: { repairRounds: 2, maxRunMinutes: 90, maxCommands: 40, maxConcurrentRuns: 1 },
  publication: { enabled: true, draft: true },
  merge: {
    mode: 'human-approved',
    method: 'squash',
    requiredChecks: ['CI'],
    requireApproval: true,
  },
  access: { kind: 'private' },
};
beforeEach(() => {
  vi.clearAllMocks();
  state.actor = null;
  state.remote.clear();
  state.remoteRuns.clear();
  state.role = 'owner';
  state.executor = false;
  state.daemon = true;
  state.db.exec(
    'DELETE FROM factory_takeovers;DELETE FROM factory_receipts;DELETE FROM factory_runs;DELETE FROM factory_revisions;DELETE FROM factory_definitions;DELETE FROM workspace_repos;DELETE FROM workspaces;DELETE FROM repos;',
  );
  state.db
    .prepare("INSERT INTO workspaces(id,name,created_at,updated_at)VALUES('ws','Workspace','','')")
    .run();
  state.db
    .prepare(
      "INSERT INTO repos(id,name,path,remote_url,status,created_at,updated_at)VALUES('repo','Repo','/repo','https://github.com/acme/repo.git','indexed','','')",
    )
    .run();
  state.db
    .prepare("INSERT INTO workspace_repos(workspace_id,repo_id,added_at)VALUES('ws','repo','')")
    .run();
  vi.mocked(getWorkflowTemplate).mockReturnValue(structuredClone(workflow));
});
async function saved() {
  const preview = await previewFactory(definition);
  return saveFactory({ definition, confirmation: preview.confirmation });
}
function remoteFactory(): FactoryDefinition {
  return {
    id: 'remote',
    workspaceId: 'owner-workspace',
    revision: 1,
    status: 'active',
    activeRevision: 1,
    ownerId: 'owner-account',
    accountScope: 'owner-scope',
    confirmation: 'reviewed',
    definition: {
      ...structuredClone(definition),
      workspaceId: 'owner-workspace',
      repoId: 'owner-repo',
      access: {
        kind: 'organization',
        organizationId: 'org',
        visibility: 'organization',
        members: [],
      },
    },
    workflow: structuredClone(workflow),
    createdAt: '',
    updatedAt: '',
    executionOwner: false,
    remote: true,
  };
}
describe('factory service reviewed activation and remote projections', () => {
  it('saves reviewed immutable revisions and explicitly activates the pinned graph', async () => {
    const factory = await saved();
    expect(factory.status).toBe('draft');
    const activated = await activateFactory({
      factoryId: factory.id,
      revision: factory.revision,
      confirmation: factory.confirmation,
    });
    expect(activated.status).toBe('active');
    expect(activated.activeRevision).toBe(1);
    const changed = { ...definition, name: 'Next revision' };
    const preview = await previewFactory(changed, factory.id);
    const next = await saveFactory({
      id: factory.id,
      expectedRevision: 1,
      definition: changed,
      confirmation: preview.confirmation,
    });
    expect(next.revision).toBe(2);
    expect(next.activeRevision).toBe(1);
    expect(new FactoryStore(state.db).getRevision(factory.id, 1)?.definition.name).toBe('Factory');
  });
  it('rejects stale review, widened source, and failed daemon preparation', async () => {
    const factory = await saved();
    await expect(
      saveFactory({
        definition: { ...definition, name: 'Changed' },
        confirmation: factory.confirmation,
      }),
    ).rejects.toThrow('changed since review');
    const changed = { ...definition, repoId: 'other' };
    await expect(
      saveFactory({ id: factory.id, expectedRevision: 1, definition: changed, confirmation: 'x' }),
    ).rejects.toThrow('immutable');
    state.daemon = false;
    await expect(
      activateFactory({ factoryId: factory.id, revision: 1, confirmation: factory.confirmation }),
    ).rejects.toThrow('trusted automation daemon');
    expect(new FactoryStore(state.db).getFactory(factory.id)?.status).toBe('draft');
  });
  it('previews a specific authorised remote revision without owner-local ID authority', async () => {
    const remote = remoteFactory();
    state.remote.set(remote.id, remote);
    state.actor = { id: 'recipient-account', accountScope: 'recipient-scope' };
    const preview = await previewFactory({ ...remote.definition, name: 'Team policy' }, remote.id);
    expect(preview.definition.repoId).toBe('owner-repo');
    const next = await saveFactory({
      id: remote.id,
      expectedRevision: 1,
      definition: preview.definition,
      confirmation: preview.confirmation,
    });
    expect(next.remote).toBe(true);
    expect(next.ownerId).toBe('owner-account');
    expect(new FactoryStore(state.db).getFactory(remote.id)).toBeNull();
    const list = await listFactories('ws');
    expect(list.map((item) => item.id)).toContain(remote.id);
  });
  it('treats same-account another-device org factories as remote unless a local execution record exists', async () => {
    const remote = remoteFactory();
    state.actor = { id: remote.ownerId, accountScope: remote.accountScope };
    state.remote.set(remote.id, remote);
    const rows = await listFactories('ws');
    expect(rows[0].remote).toBe(true);
    expect(rows[0].executionOwner).toBe(false);
  });
  it('creates a recipient-private takeover only after the matching remote claim is confirmed', async () => {
    const remote = remoteFactory();
    state.remote.set(remote.id, remote);
    state.actor = { id: 'recipient-account', accountScope: 'recipient-scope' };
    const run = {
      id: 'remote-run',
      factoryId: remote.id,
      revision: 1,
      workspaceId: 'owner-workspace',
      snapshot: remote,
      issue: {
        number: 7,
        title: 'Fix',
        body: 'Context',
        url: '',
        labels: [],
        state: 'open',
        createdAt: '',
        updatedAt: '',
      },
      stage: 'waiting-checks',
      version: 1,
      repairRounds: 0,
      commandsUsed: 0,
      createdAt: '',
      updatedAt: '',
      deadlineAt: '',
      receipts: [],
      takeoverThreadId: 'owner-private-thread',
    } as FactoryRun;
    state.remoteRuns.set(run.id, run);
    const pending = await controlFactoryRun({
      runId: run.id,
      action: 'takeover',
      takeoverContext: { workspaceId: 'ws', repoId: 'repo', personaId: 'coder' },
    });
    expect(pending.commandPending).toBe(true);
    expect(createChatThread).not.toHaveBeenCalled();
    state.remoteRuns.set(run.id, {
      ...run,
      stage: 'taken-over',
      takeoverRequestId: 'someone-else',
    });
    expect((await getFactoryRun(run.id))?.takeoverThreadId).toBeUndefined();
    expect(createChatThread).not.toHaveBeenCalled();
    state.remoteRuns.set(run.id, {
      ...run,
      stage: 'taken-over',
      takeoverRequestId: 'remote-command',
    });
    const picked = await getFactoryRun(run.id);
    expect(picked?.takeoverThreadId).toMatch(/^factory-takeover-/);
    expect(picked?.takeoverThreadId).not.toBe('owner-private-thread');
    expect(createChatThread).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws', repoIds: ['repo'] }),
      expect.any(String),
    );
  });
});
