import type {
  FactoryActivateInput,
  FactoryControlInput,
  FactoryDefinitionInput,
  FactoryRunControlInput,
  FactorySaveInput,
} from '../../shared/factories.js';
import {
  activateFactory,
  controlFactory,
  controlFactoryRun,
  draftFactory,
  getFactory,
  getFactoryRun,
  listFactories,
  listFactoryRuns,
  previewFactory,
  saveFactory,
} from '../services/factory.service.js';
import { getDb } from '../db/database.js';
import { factoryWithinSessionScope } from './factory-scope.js';
import { requestUserApproval } from '../surfaces/core.js';
import {
  AgentToolError,
  assertRepoInScope,
  textResult,
  type AgentToolDefinition,
  type AgentToolProvider,
} from './dispatch.js';

const tools: AgentToolDefinition[] = [
  {
    name: 'factory_list',
    title: 'List software factories',
    feature: 'automations',
    description: 'List factories the current user is allowed to see in this workspace.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'factory_draft',
    title: 'Draft a software factory',
    feature: 'automations',
    description:
      'Translate the request into a typed issue-to-PR factory proposal. This only drafts and previews; it does not save or activate the factory.',
    inputSchema: {
      type: 'object',
      required: ['request'],
      additionalProperties: false,
      properties: { request: { type: 'string', minLength: 1, maxLength: 16000 } },
    },
  },
  {
    name: 'factory_preview',
    title: 'Preview a factory definition',
    feature: 'automations',
    description:
      'Validate and summarize the exact typed factory definition before saving it. A revision keeps its pinned workflow graph unless repinWorkflow is true.',
    inputSchema: {
      type: 'object',
      required: ['definition'],
      additionalProperties: false,
      properties: {
        definition: { type: 'object', additionalProperties: true },
        factoryId: { type: 'string' },
        repinWorkflow: { type: 'boolean' },
      },
    },
  },
  {
    name: 'factory_save',
    title: 'Save a factory draft',
    feature: 'automations',
    mutation: true,
    description:
      'Save a reviewed factory definition as an inactive draft. This never activates issue processing. Set repinWorkflow to pin the current saved workflow template in the new revision.',
    inputSchema: {
      type: 'object',
      required: ['definition'],
      additionalProperties: false,
      properties: {
        definition: { type: 'object', additionalProperties: true },
        factoryId: { type: 'string' },
        expectedRevision: { type: 'integer', minimum: 1 },
        repinWorkflow: { type: 'boolean' },
      },
    },
  },
  {
    name: 'factory_activate',
    title: 'Activate a software factory',
    feature: 'automations',
    mutation: true,
    description:
      'Activate one exact saved revision after the user reviews and confirms its trigger, scope, access, publication and merge policy.',
    inputSchema: {
      type: 'object',
      required: ['factoryId', 'revision', 'confirmation'],
      additionalProperties: false,
      properties: {
        factoryId: { type: 'string', minLength: 1 },
        revision: { type: 'integer', minimum: 1 },
        confirmation: { type: 'string', minLength: 1 },
      },
    },
  },
  {
    name: 'factory_read',
    title: 'Read a software factory',
    feature: 'automations',
    description: 'Read a factory definition and current policy visible to this user.',
    inputSchema: {
      type: 'object',
      required: ['factoryId'],
      additionalProperties: false,
      properties: { factoryId: { type: 'string', minLength: 1 } },
    },
  },
  {
    name: 'factory_runs',
    title: 'List factory runs',
    feature: 'automations',
    description: 'List issue runs and lifecycle stages visible to this user.',
    inputSchema: {
      type: 'object',
      required: ['factoryId'],
      additionalProperties: false,
      properties: { factoryId: { type: 'string', minLength: 1 } },
    },
  },
  {
    name: 'factory_run_read',
    title: 'Read a factory run',
    feature: 'automations',
    description:
      'Read permitted issue progress, evidence and publication/merge receipts for a factory run.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      additionalProperties: false,
      properties: { runId: { type: 'string', minLength: 1 } },
    },
  },
  {
    name: 'factory_control',
    title: 'Control a software factory',
    feature: 'automations',
    mutation: true,
    description: 'Pause, resume or deactivate a factory the user is allowed to operate.',
    inputSchema: {
      type: 'object',
      required: ['factoryId', 'action'],
      additionalProperties: false,
      properties: {
        factoryId: { type: 'string', minLength: 1 },
        action: { type: 'string', enum: ['pause', 'resume', 'deactivate'] },
      },
    },
  },
  {
    name: 'factory_run_control',
    title: 'Control a factory issue run',
    feature: 'automations',
    mutation: true,
    description:
      'Pause, resume, cancel, retry after reconciliation, approve the current PR head for human merge, or pick up a run as a new private chat. Auto-merge policy is never changed here.',
    inputSchema: {
      type: 'object',
      required: ['runId', 'action'],
      additionalProperties: false,
      properties: {
        runId: { type: 'string', minLength: 1 },
        action: {
          type: 'string',
          enum: ['pause', 'resume', 'cancel', 'retry', 'approve-merge', 'takeover'],
        },
        expectedHeadSha: { type: 'string' },
        takeoverContext: {
          type: 'object',
          additionalProperties: false,
          required: ['workspaceId', 'personaId'],
          properties: {
            workspaceId: { type: 'string', minLength: 1 },
            repoId: { type: 'string' },
            personaId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  },
];

function requireWorkspace(workspaceId?: string): string {
  if (!workspaceId)
    throw new AgentToolError('Software factories need a saved workspace chat.', 'unavailable');
  return workspaceId;
}

function inScope(
  ctx: Parameters<AgentToolProvider['call']>[0],
  workspaceId: string,
  factory: Awaited<ReturnType<typeof getFactory>>,
): boolean {
  if (!factory) return false;
  const ids = ctx.repoIds;
  if (ids.length === 0) return false;
  const placeholders = ids.map(() => '?').join(',');
  const repositories = getDb()
    .prepare(`SELECT id,remote_url FROM repos WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string; remote_url: string | null }>;
  return factoryWithinSessionScope(
    factory,
    workspaceId,
    repositories.map((repo) => ({ id: repo.id, remoteUrl: repo.remote_url ?? '' })),
  );
}

async function approve(
  ctx: Parameters<AgentToolProvider['call']>[0],
  title: string,
  detail: string,
  consequences: string,
  signal?: AbortSignal,
): Promise<void> {
  const approved = await requestUserApproval(ctx, { title, detail, consequences }, signal);
  if (!approved || signal?.aborted)
    throw new AgentToolError('Factory action cancelled.', 'conflict');
}

export const factoryToolProvider: AgentToolProvider = {
  id: 'factories',
  tools: () => tools,
  async call(ctx, name, args, signal) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) return undefined;
    const workspaceId = requireWorkspace(ctx.workspaceId);

    if (name === 'factory_list') {
      const factories = await listFactories(workspaceId);
      const scoped = factories.filter((factory) => inScope(ctx, workspaceId, factory));
      return textResult(JSON.stringify(scoped), { factories: scoped });
    }
    if (name === 'factory_draft') {
      const definition = await draftFactory(args.request as string, workspaceId);
      if (definition.workspaceId !== workspaceId)
        throw new AgentToolError('Factory draft is outside this chat’s workspace.', 'forbidden');
      assertRepoInScope(ctx, definition.repoId);
      const preview = await previewFactory(definition);
      return textResult(JSON.stringify(preview), { preview });
    }
    if (name === 'factory_preview') {
      const definition = args.definition as FactoryDefinitionInput;
      const factoryId = typeof args.factoryId === 'string' ? args.factoryId : undefined;
      if (factoryId) {
        const existing = await getFactory(factoryId);
        if (!inScope(ctx, workspaceId, existing))
          throw new AgentToolError('Factory is outside this chat’s repository scope.', 'forbidden');
      } else {
        if (definition.workspaceId !== workspaceId)
          throw new AgentToolError(
            'Factory definition is outside this chat’s workspace.',
            'forbidden',
          );
        assertRepoInScope(ctx, definition.repoId);
      }
      const preview = await previewFactory(definition, factoryId, {
        repinWorkflow: args.repinWorkflow === true,
      });
      return textResult(JSON.stringify(preview), { preview });
    }
    if (name === 'factory_save') {
      const definition = args.definition as FactoryDefinitionInput;
      if (definition.workspaceId !== workspaceId)
        throw new AgentToolError(
          'Factory definition is outside this chat’s workspace.',
          'forbidden',
        );
      assertRepoInScope(ctx, definition.repoId);
      if (typeof args.factoryId === 'string') {
        const existing = await getFactory(args.factoryId);
        if (!inScope(ctx, workspaceId, existing))
          throw new AgentToolError('Factory is outside this chat’s repository scope.', 'forbidden');
      } else {
        if (definition.workspaceId !== workspaceId)
          throw new AgentToolError(
            'Factory definition is outside this chat’s workspace.',
            'forbidden',
          );
        assertRepoInScope(ctx, definition.repoId);
      }
      const repinWorkflow = args.repinWorkflow === true;
      const preview = await previewFactory(
        definition,
        typeof args.factoryId === 'string' ? args.factoryId : undefined,
        { repinWorkflow },
      );
      const detail = [
        ...(repinWorkflow
          ? [
              'This revision re-pins the current saved workflow template. Existing runs keep their graph.',
            ]
          : []),
        preview.summary.join('\n'),
        JSON.stringify(preview.definition, null, 2),
      ].join('\n\n');
      await approve(
        ctx,
        args.factoryId ? 'Save this factory revision?' : 'Save this factory draft?',
        detail,
        'The factory is saved inactive. No issue polling or merges start until it is separately activated.',
        signal,
      );
      const input: FactorySaveInput = {
        definition: preview.definition,
        confirmation: preview.confirmation,
        ...(repinWorkflow ? { repinWorkflow } : {}),
        ...(typeof args.factoryId === 'string' ? { id: args.factoryId } : {}),
        ...(typeof args.expectedRevision === 'number'
          ? { expectedRevision: args.expectedRevision }
          : {}),
      };
      const factory = await saveFactory(input);
      return textResult(JSON.stringify(factory), { factory });
    }
    if (name === 'factory_activate') {
      const input = args as unknown as FactoryActivateInput;
      const current = await getFactory(input.factoryId);
      if (!current) throw new AgentToolError('Factory not found.', 'not-found');
      if (!inScope(ctx, workspaceId, current))
        throw new AgentToolError('Factory is outside this chat’s repository scope.', 'forbidden');
      if (current.revision !== input.revision || current.confirmation !== input.confirmation)
        throw new AgentToolError(
          'Factory changed. Read and review the latest revision.',
          'conflict',
        );
      const preview = await previewFactory(current.definition, current.id);
      await approve(
        ctx,
        'Activate this factory revision?',
        [preview.summary.join('\n'), JSON.stringify(current.definition, null, 2)].join('\n\n'),
        'This is standing authority to process matching issues under the displayed publication and merge policies. Ticket text cannot widen those permissions.',
        signal,
      );
      const factory = await activateFactory(input);
      return textResult(JSON.stringify(factory), { factory });
    }
    if (name === 'factory_read') {
      const factory = await getFactory(args.factoryId as string);
      if (factory && !inScope(ctx, workspaceId, factory))
        throw new AgentToolError('Factory is outside this chat’s repository scope.', 'forbidden');
      return textResult(JSON.stringify(factory), factory ? { factory } : undefined);
    }
    if (name === 'factory_runs') {
      const factory = await getFactory(args.factoryId as string);
      if (!factory) throw new AgentToolError('Factory not found.', 'not-found');
      if (!inScope(ctx, workspaceId, factory))
        throw new AgentToolError('Factory is outside this chat’s repository scope.', 'forbidden');
      const runs = await listFactoryRuns(factory.id);
      const scoped = runs.filter(() => inScope(ctx, workspaceId, factory));
      return textResult(JSON.stringify(scoped), { runs: scoped });
    }
    if (name === 'factory_run_read') {
      const run = await getFactoryRun(args.runId as string);
      if (run) {
        const factory = await getFactory(run.factoryId);
        if (!inScope(ctx, workspaceId, factory))
          throw new AgentToolError(
            'Factory run is outside this chat’s repository scope.',
            'forbidden',
          );
      }
      return textResult(JSON.stringify(run), run ? { run } : undefined);
    }
    if (name === 'factory_control') {
      const input = args as unknown as FactoryControlInput;
      const factory = await getFactory(input.factoryId);
      if (!factory) throw new AgentToolError('Factory not found.', 'not-found');
      if (!inScope(ctx, workspaceId, factory))
        throw new AgentToolError('Factory is outside this chat’s repository scope.', 'forbidden');
      await approve(
        ctx,
        `${input.action === 'deactivate' ? 'Deactivate' : `${input.action[0].toUpperCase()}${input.action.slice(1)}`} factory?`,
        `${factory.definition.name} (revision ${factory.revision})`,
        input.action === 'deactivate'
          ? 'No new issues will be claimed. Existing issue runs keep their recorded policy and remain controllable.'
          : 'This changes the factory’s live processing state.',
        signal,
      );
      const updated = await controlFactory(input);
      return textResult(JSON.stringify(updated), { factory: updated });
    }
    if (name === 'factory_run_control') {
      const input = args as unknown as FactoryRunControlInput;
      if (input.action === 'takeover' && !input.takeoverContext)
        throw new AgentToolError(
          'Choose a recipient workspace and persona before picking up this run.',
          'invalid-params',
        );
      const run = await getFactoryRun(input.runId);
      if (!run) throw new AgentToolError('Factory run not found.', 'not-found');
      const factory = await getFactory(run.factoryId);
      if (!inScope(ctx, workspaceId, factory))
        throw new AgentToolError(
          'Factory run is outside this chat’s repository scope.',
          'forbidden',
        );
      await approve(
        ctx,
        `${input.action === 'approve-merge' ? 'Approve merge' : input.action === 'takeover' ? 'Pick up' : `${input.action[0].toUpperCase()}${input.action.slice(1)}`} this issue run?`,
        `${run.issue.title}\nStage: ${run.stage}${run.pullRequest ? `\nPR: ${run.pullRequest.url}\nHead: ${run.pullRequest.headSha}` : ''}`,
        input.action === 'approve-merge'
          ? 'This approves the currently observed PR head for human-approved merge. It does not change the factory merge policy.'
          : input.action === 'takeover'
            ? `This pauses and claims the run before opening a new private chat in ${input.takeoverContext?.workspaceId ?? 'the selected workspace'}${input.takeoverContext?.repoId ? ` with repository ${input.takeoverContext.repoId}` : ' without a live repository checkout'} and persona ${input.takeoverContext?.personaId ?? 'not selected'}. No provider message is sent automatically.`
            : 'This changes the selected issue run; publication and merge policy remain unchanged.',
        signal,
      );
      const updated = await controlFactoryRun(input);
      return textResult(JSON.stringify(updated), { run: updated });
    }
    return undefined;
  },
};
