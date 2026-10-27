import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  FactoryAction,
  FactoryActivateInput,
  FactoryActor,
  FactoryControlInput,
  FactoryDefinition,
  FactoryDefinitionInput,
  FactoryPreview,
  FactoryRun,
  FactoryRunControlInput,
  FactorySaveInput,
} from '../../shared/factories.js';
import { getDb } from '../db/database.js';
import { FactoryStore } from './factory-persistence.service.js';
import { FactoryRuntime, type FactoryWorker } from './factory-runtime.service.js';
import { factoryProvider } from './factory-provider.service.js';
import * as access from './factory-access.service.js';
import {
  factoryPreview,
  validateFactoryDefinition,
  validateFactoryWorkflow,
} from './factory-definition.service.js';
import { createChatThread, getChatThread, saveChatEntry } from './chat-persistence.service.js';
import { getPersonaById } from './persona.service.js';
import { getSettings } from './settings.service.js';
import { parseGitHubRemoteUrl } from './code-review-pr.service.js';
import {
  cancelWorkflowRun,
  getChatWorkflowRunByRequest,
  getWorkflowRun,
  getWorkflowTemplate,
  listWorkflowTemplates,
  startChatWorkflowRun,
  validateWorkflowGraph,
} from './workflow.service.js';
import { callLlm } from './llm.service.js';
import { installAutomationDaemon, isAutomationDaemonMode } from './automation-daemon.service.js';
import { previewBuild } from '../../shared/preview-build.js';

let runtime: FactoryRuntime | undefined;
let timer: NodeJS.Timeout | undefined;
let ticking = false;
const store = () => new FactoryStore(getDb());
function actor(): FactoryActor {
  const current = access.getFactoryActor();
  if (current) return current;
  // Private offline definitions remain tied to this app database, never a renderer identity.
  return {
    id: `local:${createHash('sha256').update(getDb().name).digest('hex')}`,
    accountScope: `local:${getDb().name}`,
  };
}
function localOwner(factory: FactoryDefinition): boolean {
  const who = actor();
  return (
    Boolean(store().getFactory(factory.id)) &&
    who.id === factory.ownerId &&
    who.accountScope === factory.accountScope &&
    factory.executionOwner !== false
  );
}
async function authorize(factory: FactoryDefinition, action: FactoryAction): Promise<void> {
  if (factory.definition.access.kind === 'private') {
    if (!localOwner(factory)) throw new Error('This factory belongs to another account.');
  } else await access.authorizeFactoryAccess(factory, action);
}
async function view(factory: FactoryDefinition): Promise<FactoryDefinition> {
  await authorize(factory, 'read-source');
  if (factory.definition.access.kind === 'private')
    return {
      ...factory,
      effectiveRole: 'owner',
      sourceAccess: true,
      executionOwner: true,
      remote: false,
    };
  const grant = await access.authorizeFactoryAccess(factory, 'read');
  return {
    ...factory,
    effectiveRole: (grant?.role ?? 'viewer') as 'viewer' | 'operator' | 'owner',
    organizationAdmin: grant?.organizationAdmin ?? false,
    executionOwner: grant?.executionOwner ?? false,
    sourceAccess: true,
    remote: !localOwner(factory),
  };
}
function sourceMatches(a: FactoryDefinitionInput, b: FactoryDefinitionInput): boolean {
  return (
    a.repoId === b.repoId &&
    a.workspaceId === b.workspaceId &&
    a.github.host.toLowerCase() === b.github.host.toLowerCase() &&
    a.github.owner.toLowerCase() === b.github.owner.toLowerCase() &&
    a.github.repo.toLowerCase() === b.github.repo.toLowerCase()
  );
}
function validateLocalSource(definition: FactoryDefinitionInput): void {
  const repo = getDb().prepare('SELECT remote_url FROM repos WHERE id=?').get(definition.repoId) as
    { remote_url: string } | undefined;
  const member = getDb()
    .prepare('SELECT 1 FROM workspace_repos WHERE workspace_id=? AND repo_id=?')
    .get(definition.workspaceId, definition.repoId);
  const parsed = repo && parseGitHubRemoteUrl(repo.remote_url ?? '');
  if (
    !member ||
    !parsed ||
    parsed.host.toLowerCase() !== definition.github.host ||
    parsed.owner.toLowerCase() !== definition.github.owner.toLowerCase() ||
    parsed.repo.toLowerCase() !== definition.github.repo.toLowerCase()
  )
    throw new Error('Choose a repository in this workspace matching the exact GitHub source.');
}
function validateWorkerAvailability(workflow: FactoryDefinition['workflow']): void {
  validateFactoryWorkflow(workflow);
  validateWorkflowGraph(workflow.nodes, workflow.edges);
  const settings = getSettings(),
    enabled = settings.enabledLlmProviders?.length
      ? settings.enabledLlmProviders
      : [settings.llmProvider];
  if ((settings.codexMode ?? 'on-request') === 'read-only')
    throw new Error('A writable current access mode is required before factory activation.');
  if (
    workflow.nodes.some(
      (node) => node.kind !== 'human' && !enabled.includes(node.provider ?? 'codex'),
    )
  )
    throw new Error('Enable each pinned workflow model provider before activation.');
  const codexHome = process.env.CODEX_HOME ?? path.join(process.env.HOME ?? '', '.codex');
  if (!process.env.OPENAI_API_KEY && !fs.existsSync(path.join(codexHome, 'auth.json')))
    throw new Error('Sign in to Codex before activating an isolated factory worker.');
}
export async function previewFactory(
  value: FactoryDefinitionInput,
  factoryId?: string,
): Promise<FactoryPreview> {
  const definition = validateFactoryDefinition(value);
  const existing = factoryId ? await findFactory(factoryId) : null;
  if (factoryId && !existing) throw new Error('Factory not found.');
  if (existing) await authorize(existing, 'edit');
  const remote = existing && !localOwner(existing) ? existing : undefined;
  if (remote && definition.workflowTemplateId !== remote.definition.workflowTemplateId)
    throw new Error(
      'Remote revisions preserve the pinned workflow; change it on the designated executor.',
    );
  const workflow =
    existing && definition.workflowTemplateId === existing.definition.workflowTemplateId
      ? existing.workflow
      : getWorkflowTemplate(definition.workflowTemplateId);
  if (!workflow) throw new Error('Choose an existing saved workflow.');
  if (!remote) validateLocalSource(definition);
  return factoryPreview(definition, workflow, remote?.accountScope ?? actor().accountScope);
}
export async function draftFactory(
  request: string,
  workspaceId: string,
): Promise<FactoryDefinitionInput> {
  if (!request.trim() || request.length > 24000) throw new Error('Describe a bounded factory.');
  const repos = getDb()
    .prepare(
      'SELECT r.id,r.name,r.remote_url FROM repos r JOIN workspace_repos w ON w.repo_id=r.id WHERE w.workspace_id=?',
    )
    .all(workspaceId);
  const templates = listWorkflowTemplates();
  const organizations = await access.listRemoteOrganizations().catch(() => []);
  const response = await callLlm(
    [
      'Return only strict JSON for an Anvil GitHub software factory. Never activate or execute it. Use exactly these fields: name,workspaceId,repoId,github:{host,owner,repo,label,baseBranch},workflowTemplateId,criteria:string[],checks:string[],postMergeChecks:string[],limits:{repairRounds,maxRunMinutes,maxCommands,maxConcurrentRuns},publication:{enabled,draft},merge:{mode:human-approved|auto-merge,method:squash|merge|rebase,requiredChecks:string[],requireApproval:boolean},access:{kind:private} or {kind:organization,organizationId,visibility:organization|team|restricted,teamId?,members:[{userId,role:viewer|operator|owner}]}. Use only supplied organisation IDs; never invent administrators. Each criterion has one exact reviewed command at same index. At least one postMergeChecks command. Defaults: label ready-for-agent, repairRounds2,maxRunMinutes90,maxCommands40,maxConcurrentRuns1,publication enabled drafttrue,human-approved squash requireApprovaltrue. Only local Codex app-server workflow templates supported. Do not invent repo/template IDs; if missing, explain error in JSON {error:string}.',
      JSON.stringify({
        request,
        workspaceId,
        repositories: repos,
        workflows: templates,
        organizations,
      }),
    ].join('\n\n'),
    6000,
    0.2,
  );
  const text = response.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  const value = JSON.parse(text) as unknown;
  return validateFactoryDefinition(value);
}
async function findFactory(id: string): Promise<FactoryDefinition | null> {
  const local = store().getFactory(id);
  if (local) return local;
  return access.getRemoteFactory(id);
}
export async function saveFactory(input: FactorySaveInput): Promise<FactoryDefinition> {
  const definition = validateFactoryDefinition(input.definition),
    current = input.id ? await findFactory(input.id) : null;
  if (input.id && !current) throw new Error('Factory not found.');
  if (current) {
    await authorize(current, 'edit');
    if (current.revision !== input.expectedRevision)
      throw new Error('Factory changed. Review the latest revision.');
    if (!sourceMatches(current.definition, definition))
      throw new Error('Source repository and workspace are immutable; create a new factory.');
    if (
      current.definition.access.kind === 'organization' &&
      definition.access.kind !== 'organization'
    )
      throw new Error('An organisation factory cannot be silently made private.');
  }
  const remote = current && !localOwner(current);
  if (remote && definition.workflowTemplateId !== current.definition.workflowTemplateId)
    throw new Error(
      'Change the pinned workflow on its designated executor; remote edits preserve the existing graph.',
    );
  const workflow =
    current && definition.workflowTemplateId === current.definition.workflowTemplateId
      ? current.workflow
      : getWorkflowTemplate(definition.workflowTemplateId);
  if (!workflow) throw new Error('Choose an existing saved workflow.');
  if (!remote) validateLocalSource(definition);
  const who = actor(),
    preview = factoryPreview(definition, workflow, current?.accountScope ?? who.accountScope);
  if (input.confirmation !== preview.confirmation)
    throw new Error('Factory configuration changed since review. Preview it again.');
  const now = new Date().toISOString();
  let factory: FactoryDefinition = {
    id: current?.id ?? randomUUID(),
    executionOwner: current?.executionOwner ?? true,
    workspaceId: definition.workspaceId,
    revision: (current?.revision ?? 0) + 1,
    status: current?.status ?? 'draft',
    activeRevision: current?.activeRevision,
    ownerId: current?.ownerId ?? who.id,
    accountScope: current?.accountScope ?? who.accountScope,
    definition,
    workflow: structuredClone(workflow),
    confirmation: preview.confirmation,
    activatedAt: current?.activatedAt,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  if (factory.definition.access.kind === 'organization')
    await access.publishFactorySnapshot(factory, undefined, {
      expectedRevision: current?.revision ?? 0,
      expectedRegistryVersion: current?.registryVersion,
    });
  if (factory.definition.access.kind === 'organization') {
    const authoritative = await access.getRemoteFactory(factory.id);
    if (!authoritative) throw new Error('The saved organisation revision is not available.');
    factory = authoritative;
  }
  if (!remote) store().saveRevision(factory, current?.revision);
  store().audit(factory.id, who.id, 'save-revision', {
    revision: factory.revision,
    visibility: definition.access,
  });
  return view(factory);
}
export async function activateFactory(input: FactoryActivateInput): Promise<FactoryDefinition> {
  const factory = await findFactory(input.factoryId);
  if (!factory) throw new Error('Factory not found.');
  await authorize(factory, 'activate');
  if (factory.revision !== input.revision || factory.confirmation !== input.confirmation)
    throw new Error('Review the exact current revision before activation.');
  if (localOwner(factory)) {
    validateLocalSource(factory.definition);
    validateWorkerAvailability(factory.workflow);
  }
  if (!factory.definition.publication.enabled)
    throw new Error('Activation requires explicit branch and pull request publication authority.');
  const conflict = store()
    .listFactories()
    .find(
      (other) =>
        other.id !== factory.id &&
        other.status === 'active' &&
        JSON.stringify(other.definition.github) === JSON.stringify(factory.definition.github),
    );
  if (conflict) throw new Error('Another active factory already watches this exact trigger.');
  const next = {
    ...factory,
    status: 'active' as const,
    activeRevision: factory.revision,
    activatedAt: factory.activatedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (localOwner(factory)) {
    const daemon = installAutomationDaemon();
    if (!daemon.supported || !daemon.installed || !daemon.loaded)
      throw new Error(
        daemon.lastError ?? 'A running trusted automation daemon is required before activation.',
      );
  }
  if (next.definition.access.kind === 'organization') {
    await access.publishFactorySnapshot(next, undefined, {
      expectedRevision: factory.revision,
      expectedRegistryVersion: factory.registryVersion,
    });
    const authoritative = await access.getRemoteFactory(factory.id);
    if (!authoritative)
      throw new Error('The activated organisation revision could not be observed.');
    Object.assign(next, authoritative);
  }
  if (localOwner(factory)) store().updateFactory(next);
  store().audit(next.id, actor().id, 'activate', {
    revision: next.revision,
    merge: next.definition.merge,
  });
  return view(next);
}
export async function listFactories(workspaceId?: string): Promise<FactoryDefinition[]> {
  const rows = store().listFactories(workspaceId),
    remote = await access.listRemoteFactories().catch(() => []);
  const map = new Map(rows.map((f) => [f.id, f]));
  for (const factory of remote) map.set(factory.id, factory);
  const visible: FactoryDefinition[] = [];
  for (const factory of map.values())
    try {
      visible.push(await view(factory));
    } catch {
      /* membership/source revocations remove discovery too */
    }
  return visible;
}
export const listFactoryOrganizations = access.listRemoteOrganizations;
export const listFactoryOrganizationMembers = access.listRemoteFactoryMembers;
export const validateFactoryOrganizationTeam = access.validateRemoteFactoryTeam;
export const registerFactoryOrganizationKey = access.registerRemoteFactoryKey;
export const listFactoryDirectory = access.listRemoteFactoryDirectory;
export async function getFactory(id: string): Promise<FactoryDefinition | null> {
  const factory = await findFactory(id);
  return factory ? view(factory) : null;
}
async function runView(run: FactoryRun, factory: FactoryDefinition): Promise<FactoryRun> {
  const allowed = await view(factory);
  let result = {
    ...run,
    effectiveRole: allowed.effectiveRole,
    organizationAdmin: allowed.organizationAdmin,
    executionOwner: allowed.executionOwner,
    sourceAccess: true,
    remote: allowed.remote,
  };
  if (allowed.remote) {
    result = {
      ...result,
      checkout: undefined,
      workerThreadId: undefined,
      takeoverThreadId: undefined,
    };
    const pending = getDb()
      .prepare(
        'SELECT request_id,context_json,thread_id FROM factory_takeovers WHERE run_id=? AND account_scope=?',
      )
      .get(run.id, actor().accountScope) as
      { request_id: string; context_json: string; thread_id?: string } | undefined;
    if (pending && run.stage === 'taken-over' && run.takeoverRequestId === pending.request_id) {
      const threadId =
        pending.thread_id ?? createTakeoverThread(run, JSON.parse(pending.context_json));
      getDb()
        .prepare('UPDATE factory_takeovers SET thread_id=? WHERE run_id=? AND account_scope=?')
        .run(threadId, run.id, actor().accountScope);
      result = { ...result, takeoverThreadId: threadId };
    }
  }
  return result;
}
export async function listFactoryRuns(factoryId: string): Promise<FactoryRun[]> {
  const factory = await findFactory(factoryId);
  if (!factory) throw new Error('Factory not found.');
  await authorize(factory, 'read-source');
  const runs = localOwner(factory)
    ? store().listRuns(factoryId)
    : await access.listRemoteFactoryRuns(factoryId);
  return Promise.all(runs.map((run) => runView(run, factory)));
}
export async function getFactoryRun(id: string): Promise<FactoryRun | null> {
  const local = store().getRun(id);
  if (local) {
    const factory = store().getFactory(local.factoryId);
    if (!factory) return null;
    return runView(local, factory);
  }
  for (const factory of await access.listRemoteFactories()) {
    const run = await access.getRemoteFactoryRun(factory.id, id);
    if (run) return runView(run, factory);
  }
  return null;
}
function createTakeoverThread(
  run: FactoryRun,
  context?: { workspaceId: string; repoId?: string; personaId: string },
): string {
  const selected = context ?? {
    workspaceId: run.workspaceId,
    repoId: run.snapshot.definition.repoId,
    personaId: run.snapshot.workflow.nodes[0].personaId,
  };
  if (
    !getPersonaById(selected.personaId) ||
    !getDb().prepare('SELECT 1 FROM workspaces WHERE id=?').get(selected.workspaceId)
  )
    throw new Error('Choose an available recipient workspace and agent.');
  if (selected.repoId) {
    const definition = {
      ...run.snapshot.definition,
      workspaceId: selected.workspaceId,
      repoId: selected.repoId,
    };
    validateLocalSource(definition);
  }
  const threadId = `factory-takeover-${createHash('sha256').update(`${actor().accountScope}:${run.id}`).digest('hex').slice(0, 32)}`;
  if (getChatThread(threadId)) return threadId;
  createChatThread(
    {
      workspaceId: selected.workspaceId,
      personaId: selected.personaId,
      repoIds: selected.repoId ? [selected.repoId] : [],
      title: `Pick up: ${run.issue.title}`,
    },
    threadId,
  );
  saveChatEntry(threadId, selected.repoId ?? null, null, {
    id: randomUUID(),
    role: 'user',
    content: [
      'Factory takeover checkpoint. This is a private continuation. The factory run has been claimed and paused. No provider has been started and no sender approvals or active goals are inherited.',
      JSON.stringify({
        issue: run.issue,
        criteria: run.snapshot.definition.criteria,
        workflow: run.snapshot.workflow,
        branch: run.pullRequest?.branch ?? run.checkout?.branch,
        pullRequest: run.pullRequest,
        evidence: run.evidence,
        observation: run.observation,
        error: run.error,
      }),
      selected.repoId
        ? 'Use the selected recipient repository. Verify its branch and permissions before continuing.'
        : 'Original source checkout is not available in this chat. Choose an authorised local source repository before editing.',
    ].join('\n\n'),
    timestamp: new Date().toISOString(),
    personaId: selected.personaId,
    threadId,
  });
  return threadId;
}
const worker: FactoryWorker = {
  async start(run, key, prompt) {
    const threadId = `factory-worker-${run.id}`;
    if (!getChatThread(threadId))
      createChatThread(
        {
          workspaceId: run.workspaceId,
          personaId: run.snapshot.workflow.nodes[0].personaId,
          repoIds: [run.snapshot.definition.repoId],
          title: `Factory: ${run.issue.title}`,
        },
        threadId,
      );
    const existing = getChatWorkflowRunByRequest(threadId, key);
    if (existing) return { id: existing.id, threadId };
    const template = structuredClone(run.snapshot.workflow);
    validateWorkerAvailability(template);
    template.nodes = template.nodes.map((node) => ({
      ...node,
      permissionMode: node.permissionMode === 'read-only' ? 'read-only' : 'workspace-auto',
      target: { kind: 'local' },
      requiresValidation: false,
    }));
    if (template.orchestration)
      template.orchestration = {
        ...template.orchestration,
        profiles: template.orchestration.profiles.map((profile) => ({
          ...profile,
          permissionMode: 'workspace-auto',
          target: { kind: 'local' },
        })),
      };
    const started = startChatWorkflowRun({
      definition: template,
      workspaceId: run.workspaceId,
      repoIds: [run.snapshot.definition.repoId],
      kickoff: prompt,
      executionPaths: [{ id: run.snapshot.definition.repoId, path: run.checkout!.path }],
      permissionCeiling: 'workspace-auto',
      origin: {
        threadId,
        requestId: key,
        fingerprint: run.snapshot.confirmation,
        reason: 'Pinned software factory execution',
        destinations: Object.fromEntries(template.nodes.map((n) => [n.id, 'local'])),
      },
    });
    return { id: started.id, threadId };
  },
  async read(id) {
    const workflow = getWorkflowRun(id);
    if (!workflow) throw new Error('Pinned workflow is unavailable.');
    const usage = getDb()
      .prepare(
        'SELECT COALESCE(SUM(commands),0) AS n FROM factory_worker_usage WHERE worker_key LIKE ?',
      )
      .get(`${id}:%`) as { n: number };
    return {
      status: workflow.status === 'queued' ? 'running' : workflow.status,
      commandsUsed: usage.n,
      error: workflow.error,
    };
  },
  async cancel(id) {
    cancelWorkflowRun(id);
  },
  async takeover(run) {
    return createTakeoverThread(run);
  },
};
function engine(): FactoryRuntime {
  runtime ??= new FactoryRuntime({
    store: store(),
    provider: factoryProvider,
    worker,
    async authorize(factory, action) {
      if (!localOwner(factory))
        throw new Error('Only the designated execution identity can run this factory.');
      await authorize(
        factory,
        action === 'merge' ? 'merge' : action === 'cancel' ? 'cancel' : 'execute',
      );
    },
    async claimIssue(factory, run) {
      return factory.definition.access.kind === 'organization'
        ? access.claimOrganizationFactoryIssue(factory, run.issue.number, run.id)
        : true;
    },
    async snapshot(factory, run) {
      if (factory.definition.access.kind === 'organization')
        await access.publishFactorySnapshot(factory, run);
    },
  });
  return runtime;
}
export async function controlFactory(input: FactoryControlInput): Promise<FactoryDefinition> {
  const factory = await findFactory(input.factoryId);
  if (!factory) throw new Error('Factory not found.');
  await authorize(factory, 'operate');
  if (!localOwner(factory)) {
    await access.sendOrganizationFactoryCommand(factory, { action: input.action });
    return { ...(await view(factory)), commandPending: true };
  }
  if (input.requestId && factory.lastControlRequestId === input.requestId) return view(factory);
  let next: FactoryDefinition = {
    ...factory,
    lastControlRequestId: input.requestId,
    status:
      input.action === 'resume'
        ? ('active' as const)
        : input.action === 'pause'
          ? ('paused' as const)
          : ('inactive' as const),
    updatedAt: new Date().toISOString(),
  };
  store().audit(factory.id, actor().id, input.action, {});
  if (factory.definition.access.kind === 'organization')
    await access.publishFactorySnapshot(next, undefined, {
      expectedRevision: factory.revision,
      expectedRegistryVersion: factory.registryVersion,
    });
  if (factory.definition.access.kind === 'organization') {
    const authoritative = await access.getRemoteFactory(factory.id);
    if (!authoritative) throw new Error('The updated organisation state could not be observed.');
    next = authoritative;
  }
  store().updateFactory(next);
  if (input.action !== 'resume')
    for (const run of store().listRuns(factory.id))
      if (!['completed', 'cancelled', 'taken-over'].includes(run.stage))
        await engine().control({ runId: run.id, action: 'pause' }, actor().id);
  return view(next);
}
export async function controlFactoryRun(input: FactoryRunControlInput): Promise<FactoryRun> {
  const run = await getFactoryRun(input.runId);
  if (!run) throw new Error('Factory run not found.');
  const factory = await findFactory(run.factoryId);
  if (!factory) throw new Error('Factory not found.');
  await authorize(factory, input.action === 'approve-merge' ? 'merge' : 'operate');
  if (!localOwner(factory)) {
    if (input.action === 'takeover' && !input.takeoverContext)
      throw new Error('Choose the recipient workspace and agent before claiming this run.');
    const accepted = await access.sendOrganizationFactoryCommand(factory, {
      runId: run.id,
      action: input.action,
      expectedHeadSha: input.expectedHeadSha,
    });
    if (input.action === 'takeover') {
      const requestId = (accepted as { id?: string } | undefined)?.id;
      if (!requestId) throw new Error('The server did not return the takeover claim identity.');
      getDb()
        .prepare(
          'INSERT INTO factory_takeovers(run_id,account_scope,request_id,context_json) VALUES(?,?,?,?) ON CONFLICT(run_id,account_scope) DO UPDATE SET request_id=excluded.request_id,context_json=excluded.context_json,thread_id=NULL',
        )
        .run(run.id, actor().accountScope, requestId, JSON.stringify(input.takeoverContext));
    }
    return { ...run, commandPending: true };
  }
  return runView(await engine().control({ ...input, requestId: undefined }, actor().id), factory);
}
async function reconcileOrganizationState(): Promise<void> {
  for (const local of store().listFactories()) {
    if (local.definition.access.kind !== 'organization' || !localOwner(local)) continue;
    try {
      const remote = await access.getRemoteFactory(local.id);
      if (!remote || remote.revision < local.revision)
        throw new Error('The authoritative organisation factory snapshot is missing or stale.');
      if (remote && remote.revision >= local.revision) {
        if (
          !sourceMatches(local.definition, remote.definition) ||
          remote.ownerId !== local.ownerId ||
          remote.accountScope !== local.accountScope
        )
          throw new Error('Organisation factory source/executor binding changed.');
        validateFactoryDefinition(remote.definition);
        validateFactoryWorkflow(remote.workflow);
        if (remote.revision > local.revision) store().saveRevision(remote, local.revision);
        else if (
          remote.registryVersion !== local.registryVersion ||
          remote.updatedAt !== local.updatedAt
        )
          store().updateFactory(remote);
      }
      const factory = store().getFactory(local.id)!;
      await access.republishFactorySnapshots(factory, store().listRuns(factory.id));
      for (const unknown of await access.takeOrganizationFactoryCommands(factory)) {
        const command = unknown as {
          id: string;
          runId?: string;
          action: FactoryRunControlInput['action'] | FactoryControlInput['action'];
          expectedHeadSha?: string;
          actorId: string;
          leaseToken?: string;
        };
        const prior = getDb()
          .prepare('SELECT status,result_json FROM factory_commands WHERE command_id=?')
          .get(command.id) as { status: string; result_json?: string } | undefined;
        if (prior?.status === 'done') {
          await access.completeOrganizationFactoryCommand(factory, command.id, {
            leaseToken: command.leaseToken,
          });
          continue;
        }
        getDb()
          .prepare(
            'INSERT OR IGNORE INTO factory_commands(command_id,factory_id,status,updated_at) VALUES(?,?,?,?)',
          )
          .run(command.id, factory.id, 'intent', new Date().toISOString());
        try {
          let result: unknown;
          if (command.runId) {
            const run = store().getRun(command.runId);
            if (!run || run.factoryId !== factory.id)
              throw new Error('Command run is outside this factory.');
            result = await engine().control(
              {
                runId: run.id,
                action: command.action as FactoryRunControlInput['action'],
                expectedHeadSha: command.expectedHeadSha,
                requestId: command.id,
              },
              command.actorId,
            );
          } else
            result = await controlFactory({
              factoryId: factory.id,
              action: command.action as FactoryControlInput['action'],
              requestId: command.id,
            });
          getDb()
            .prepare(
              'UPDATE factory_commands SET status=?,result_json=?,updated_at=? WHERE command_id=?',
            )
            .run('done', JSON.stringify(result), new Date().toISOString(), command.id);
          await access.completeOrganizationFactoryCommand(factory, command.id, {
            leaseToken: command.leaseToken,
          });
        } catch (error) {
          await access.completeOrganizationFactoryCommand(
            factory,
            command.id,
            { leaseToken: command.leaseToken },
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    } catch (error) {
      const latest = store().getFactory(local.id);
      if (latest) {
        store().updateFactory({ ...latest, status: 'paused', updatedAt: new Date().toISOString() });
        store().audit(local.id, actor().id, 'authority-unavailable', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
export async function tickFactories(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await reconcileOrganizationState();
    await engine().tick();
  } finally {
    ticking = false;
  }
}
export function initializeFactoryRuntime(): void {
  if (timer || previewBuild || !isAutomationDaemonMode()) return;
  void tickFactories().catch(console.error);
  timer = setInterval(() => {
    void tickFactories().catch(console.error);
  }, 30_000);
  timer.unref?.();
}
export function shutdownFactoryRuntime(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
