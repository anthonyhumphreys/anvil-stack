import type { WorkflowRun } from '../../shared/types.js';
import {
  captureThreadContinuation,
  prependThreadContinuation,
} from '../services/chat-continuation.service.js';
import {
  deliverStructuredAgentFeedback,
  getCodexSession,
} from '../services/codex-session.service.js';
import { requestUserApproval } from '../surfaces/core.js';
import { validateJsonSchema, formatSchemaErrors } from '../surfaces/validate.js';
import {
  getWorkflowRun,
  getWorkflowTemplate,
  listWorkflowTemplates,
  startWorkflowRun,
  waitForWorkflowRun,
} from '../services/workflow.service.js';
import {
  AgentToolError,
  textResult,
  type AgentToolDefinition,
  type AgentToolProvider,
  type AgentToolSessionContext,
} from './dispatch.js';

const tools: AgentToolDefinition[] = [
  {
    name: 'workflow_list',
    title: 'Find workflows',
    feature: 'workflows',
    description:
      'List saved Mezair workflows and their approved specialists, targets and limits. Use these for tracked delegation across local agents, trusted fleet devices and configured cloud environments. Provider-native subagents stay inside their own runtime.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'workflow_start',
    title: 'Delegate to a workflow',
    feature: 'workflows',
    mutation: true,
    description:
      'Start a saved workflow in this chat’s workspace and selected repositories. The user reviews the exact workflow and targets before launch. Work runs in the background with durable status and handoffs. Completion is reported to this session when still available; use workflow_read to recover results. This does not move the coordinating chat or automatically integrate remote changes.',
    inputSchema: {
      type: 'object',
      required: ['templateId', 'instruction'],
      additionalProperties: false,
      properties: {
        templateId: { type: 'string', minLength: 1 },
        instruction: { type: 'string', minLength: 1, maxLength: 24000 },
      },
    },
  },
  {
    name: 'workflow_read',
    title: 'Read delegated work',
    feature: 'workflows',
    description:
      'Inspect a workflow in this workspace, including target, node status, bounded agent handoffs, errors and convergence. Agent reports are not proof that tests passed or changes were integrated. Optional waitSeconds waits up to 30 seconds for the next completion; do not poll in a tight loop.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      additionalProperties: false,
      properties: {
        runId: { type: 'string', minLength: 1 },
        waitSeconds: { type: 'integer', minimum: 0, maximum: 30 },
      },
    },
  },
];

function describeRun(run: WorkflowRun): Record<string, unknown> {
  const outputBudget = Math.max(1, Math.floor(24000 / Math.max(1, run.nodeRuns.length)));
  return {
    runId: run.id,
    status: run.status,
    error: run.error,
    convergence: run.convergence,
    steps: run.nodeRuns.map((state) => {
      const node = run.nodes.find((n) => n.id === state.nodeId);
      return {
        nodeId: state.nodeId,
        name: node?.name,
        provider: node?.provider,
        model: node?.model,
        target: node?.target ?? { kind: 'local' },
        status: state.status,
        error: state.error,
        output: state.output?.slice(0, outputBudget),
        outputTruncated: (state.output?.length ?? 0) > outputBudget,
        threadId: state.threadId,
        remote: state.remote,
      };
    }),
  };
}
function inScope(ctx: AgentToolSessionContext, run: WorkflowRun | null): WorkflowRun {
  if (
    !run ||
    run.workspaceId !== ctx.workspaceId ||
    run.repoIds.some((id) => !ctx.repoIds.includes(id))
  )
    throw new AgentToolError(
      'Workflow is outside this chat’s workspace or repository scope.',
      'forbidden',
    );
  return run;
}
async function waitBriefly(runId: string, seconds: number, signal?: AbortSignal): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  try {
    await Promise.race([
      waitForWorkflowRun(runId),
      new Promise<void>((resolve) => {
        stop = resolve;
        timeout = setTimeout(resolve, seconds * 1000);
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted) resolve();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    if (stop) signal?.removeEventListener('abort', stop);
  }
}

export const workflowToolProvider: AgentToolProvider = {
  id: 'workflows',
  tools: () => tools,
  async call(ctx, name, args, signal) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) return undefined;
    if (!ctx.workspaceId || !ctx.appThreadId)
      throw new AgentToolError('Workflows need a saved workspace chat.', 'unavailable');
    const errors = validateJsonSchema(tool.inputSchema, args, 'args');
    if (errors.length) throw new AgentToolError(formatSchemaErrors(errors), 'invalid-params');
    if (name === 'workflow_list') {
      const templates = listWorkflowTemplates().map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description,
        nodes: template.nodes.map((node) => ({
          name: node.name,
          target: node.target ?? { kind: 'local' },
          provider: node.provider,
          model: node.model,
          teamStrategy: node.teamStrategy,
        })),
        orchestration: template.orchestration,
      }));
      return textResult(JSON.stringify(templates), { templates });
    }
    if (name === 'workflow_read') {
      const id = args.runId as string;
      inScope(ctx, getWorkflowRun(id));
      if (typeof args.waitSeconds === 'number' && args.waitSeconds > 0)
        await waitBriefly(id, args.waitSeconds, signal);
      const result = describeRun(inScope(ctx, getWorkflowRun(id)));
      return textResult(JSON.stringify(result), result);
    }
    if (!ctx.repoIds.length)
      throw new AgentToolError('Select a repository before delegating work.', 'unavailable');
    const template = getWorkflowTemplate(args.templateId as string);
    if (!template) throw new AgentToolError('Saved workflow not found.', 'not-found');
    const snapshot = JSON.stringify(template);
    const destinations = template.nodes.map(
      (node) => `${node.name}: ${JSON.stringify(node.target ?? { kind: 'local' })}`,
    );
    const pool =
      template.orchestration?.profiles.map(
        (profile) => `${profile.name}: ${JSON.stringify(profile.target ?? { kind: 'local' })}`,
      ) ?? [];
    const approved = await requestUserApproval(
      ctx,
      {
        title: `Run ${template.name}?`,
        detail: [args.instruction as string, ...destinations, ...pool].join('\n'),
        consequences:
          'Agents may edit the selected repositories and use configured fleet or cloud resources within this chat’s access level. Remote results require explicit integration.',
      },
      signal,
    );
    if (!approved || signal?.aborted || !getCodexSession(ctx.sessionId))
      return textResult('Workflow launch cancelled.', { status: 'cancelled' });
    if (JSON.stringify(getWorkflowTemplate(template.id)) !== snapshot)
      throw new AgentToolError(
        'The workflow changed while awaiting approval. Review it again.',
        'conflict',
      );
    const run = startWorkflowRun({
      templateId: template.id,
      workspaceId: ctx.workspaceId,
      repoIds: [...ctx.repoIds],
      permissionCeiling: ctx.mode,
      kickoff: prependThreadContinuation(
        captureThreadContinuation(ctx.appThreadId).context,
        args.instruction as string,
      ),
    });
    void waitForWorkflowRun(run.id)
      .then((finished) =>
        deliverStructuredAgentFeedback(
          ctx.sessionId,
          JSON.stringify({ type: 'mezair.workflow.result', ...describeRun(finished) }),
        ),
      )
      .catch((error) => {
        console.warn(
          '[Workflows] Completion notice unavailable:',
          error instanceof Error ? error.message : String(error),
        );
      });
    const result = describeRun(run);
    return textResult(JSON.stringify(result), result);
  },
};
