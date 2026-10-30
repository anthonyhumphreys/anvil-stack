import type { WorkItemReference } from '../../../shared/change-review-types.js';
import { isAcpAgentProvider } from '../../../shared/agent-providers.js';
import type { AgentToolDefinition, AgentToolProvider } from '../../agent-tools/dispatch.js';
import {
  validationCriterionSchema,
  validationSurfaceKind,
  validationWorkflowPrompt,
  workItemReferenceSchema,
  type ValidationCriterion,
  type ValidationSurfaceData,
} from '../../../shared/surfaces/kinds/validation.js';
import type { JsonSchema } from '../../../shared/surfaces/types.js';
import {
  cancelValidation,
  createValidationContext,
  publishValidation,
  recordValidation,
  refreshValidation,
  startValidation,
} from '../../services/validation.service.js';
import { deliverSurfaceFeedback } from '../core.js';
import type { MainSurfaceHandler } from '../types.js';
import { parseToolArgs, surfaceToolResult } from './data/tool-kit.js';

const id: JsonSchema = { type: 'string', minLength: 1, maxLength: 200 };
const tools: AgentToolDefinition[] = [
  {
    name: 'validation_context',
    title: 'Define validation',
    feature: 'codereview',
    description:
      'Only when the user asks to validate or a workflow explicitly requests it. Read the original request and fresh work-item acceptance criteria, plus a pinned source snapshot. Interpret measurable expectations from that context; ask question_ask only for material ambiguity. Return a plan with validation_publish. Reading saved reviewId imports historical evidence without running anything.',
    inputSchema: {
      type: 'object',
      required: ['repoId'],
      properties: { repoId: id, workItemRef: workItemReferenceSchema, reviewId: id },
      additionalProperties: false,
    },
  },
  {
    name: 'validation_publish',
    title: 'Publish validation plan',
    feature: 'codereview',
    description:
      'Publish an inline validation plan from validation_context. Criteria describe observable outcomes, instruction explains how each will be checked, and command is present only for command checks. All checks start unchecked. Refine through conversation; to revise an existing plan, include surfaceId and baseRevision. Revision invalidates prior evidence. Nothing executes here.',
    inputSchema: {
      type: 'object',
      required: ['contextId', 'title', 'criteria'],
      properties: {
        contextId: id,
        title: { type: 'string', minLength: 1, maxLength: 200 },
        criteria: { type: 'array', maxItems: 30, items: validationCriterionSchema },
        surfaceId: id,
        baseRevision: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'validation_run',
    title: 'Run validation commands',
    feature: 'codereview',
    mutation: true,
    description:
      'Run the saved command checks against the captured source under the current session access. Existing workspace-auto/full-access permission needs no extra approval; on-request asks once for these exact commands. Returns promptly; the inline surface updates with runner-observed results. Do not poll or claim pending checks passed. Optional criterionIds reruns a subset. Browser/manual checks use the provider tools and validation_record.',
    inputSchema: {
      type: 'object',
      required: ['surfaceId', 'criteriaVersion'],
      properties: {
        surfaceId: id,
        criteriaVersion: id,
        criterionIds: { type: 'array', maxItems: 30, items: id },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'validation_record',
    title: 'Record validation evidence',
    feature: 'codereview',
    description:
      'Record browser, manual or inspection evidence after actually checking it. Quote the observed result and relevant tool output or user observation. This is explicitly agent-reported evidence, never a runner receipt or human sign-off. Unsupported or unobserved criteria stay blocked/unchecked. Command outcomes can only be recorded by validation_run.',
    inputSchema: {
      type: 'object',
      required: ['surfaceId', 'baseRevision', 'criterionId', 'status', 'summary', 'evidence'],
      properties: {
        surfaceId: id,
        baseRevision: { type: 'integer', minimum: 1 },
        criterionId: id,
        status: { type: 'string', enum: ['passed', 'failed', 'blocked', 'unchecked'] },
        summary: { type: 'string', minLength: 1, maxLength: 4000 },
        evidence: { type: 'string', maxLength: 16000 },
      },
      additionalProperties: false,
    },
  },
];
const toolProvider: AgentToolProvider = {
  id: 'surface:validation',
  tools: () => tools,
  async call(ctx, name, args) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) return undefined;
    parseToolArgs(tool.inputSchema, args);
    if (name === 'validation_context') {
      const result = await createValidationContext(
        ctx,
        args as unknown as { repoId: string; workItemRef?: WorkItemReference; reviewId?: string },
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }
    if (name === 'validation_publish') {
      const intent = publishValidation(
        ctx,
        args as unknown as {
          contextId: string;
          title: string;
          criteria: ValidationCriterion[];
          surfaceId?: string;
          baseRevision?: number;
        },
      );
      return surfaceToolResult(
        intent,
        { criteriaVersion: (intent.payload.data as ValidationSurfaceData).criteriaVersion },
        `criteriaVersion: ${(intent.payload.data as ValidationSurfaceData).criteriaVersion}`,
      );
    }
    if (name === 'validation_run')
      return surfaceToolResult(
        await startValidation(
          ctx,
          String(args.surfaceId),
          args.criterionIds as string[] | undefined,
          String(args.criteriaVersion),
        ),
      );
    return surfaceToolResult(
      await recordValidation(ctx, args as unknown as Parameters<typeof recordValidation>[1]),
    );
  },
};

export const validationSurfaceHandler: MainSurfaceHandler = {
  kind: 'validation',
  toolProvider,
  async executeAction(ctx, request) {
    if (request.action === 'refresh') {
      await refreshValidation(ctx.intent.id);
      return { ok: true, message: 'Evidence freshness updated.' };
    }
    if (request.action === 'cancel') {
      cancelValidation(ctx.intent.id);
      return { ok: true, message: 'Stopping validation.' };
    }
    const data = ctx.intent.payload.data as ValidationSurfaceData;
    if (request.action === 'save_workflow') {
      const { saveWorkflowTemplate } = await import('../../services/workflow.service.js');
      const { getSettings } = await import('../../services/settings.service.js');
      const settings = getSettings();
      if (isAcpAgentProvider(settings.llmProvider))
        return {
          ok: false,
          error:
            'Validation workflows need a provider with inline tools. Choose Codex or an API-backed provider in Settings, then save again.',
        };
      const template = saveWorkflowTemplate({
        name: ctx.intent.payload.title,
        description: 'Explicit validation using acceptance criteria and a conversational plan.',
        nodes: [
          {
            id: 'validate',
            name: 'Validate implementation',
            prompt: validationWorkflowPrompt(data),
            personaId: 'coder',
            provider: settings.llmProvider,
            model: settings.openaiModel,
            reasoningEffort: 'medium',
            executionStrategy: 'focused',
            requiresValidation: true,
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
      });
      return {
        ok: true,
        message: `Saved workflow "${template.name}". Open Workflows to edit or run it.`,
      };
    }
    const spec = validationSurfaceKind.actions[request.action];
    if (!spec || spec.semantics.type !== 'agent-message')
      return { ok: false, error: 'Unknown validation action.' };
    const delivered = await deliverSurfaceFeedback(
      ctx.intent.id,
      `${spec.semantics.template}\nValidation ${ctx.intent.id}; repository ${data.repoId}; criteria version ${data.criteriaVersion}.${request.note ? `\nUser note: ${request.note}` : ''}`,
    );
    return delivered
      ? { ok: true, message: 'Sent to the agent.' }
      : { ok: false, error: 'Open this thread and send your validation request to continue.' };
  },
};
