import type { ChatDelegationInput } from '../../shared/chat-delegation.js';
import { AGENT_PROVIDERS } from '../../shared/agent-providers.js';
import {
  AgentToolError,
  textResult,
  type AgentToolDefinition,
  type AgentToolProvider,
} from './dispatch.js';
import { discoverDelegationCapabilities } from '../services/delegation-capabilities.service.js';
import {
  describeChatDelegation,
  listChatDelegations,
  proposeChatDelegation,
  requireChatDelegation,
  stopChatDelegation,
} from '../services/chat-delegation.service.js';
import { validateJsonSchema, formatSchemaErrors } from '../surfaces/validate.js';

const tools: AgentToolDefinition[] = [
  {
    name: 'delegation_discover',
    title: 'Find agents and destinations',
    feature: 'chat',
    description:
      'Discover enabled providers, model IDs and trusted local, fleet and cloud destinations for chat-native delegation. Check capabilities before proposing tasks. Availability is a snapshot; a destination may still require setup. No jobs or cloud environments start.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'delegation_propose',
    title: 'Propose delegated work',
    feature: 'chat',
    // Proposals are available in read-only chats. Only the user's inline
    // approval starts work, and every child is capped to the chat's access.
    description:
      'Propose 1–8 bounded tasks directly in this chat, without a saved workflow. Use when explicitly requested or when a discovered capability, isolation or independent review materially helps. Explain that benefit in reason. The user reviews task instructions, provider/model and destinations before anything starts. Returns promptly with awaiting-approval; end your turn and let the user answer in the chat. Mezair notifies you of the decision and results. Do not retry or poll a pending proposal. Reuse requestId for this exact proposal if a response is lost. Results and Stop controls stay in the chat. Dependencies transfer reports, not code changes. Do not propose delegation for trivial work, invent destinations or delegate recursively.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['requestId', 'title', 'reason', 'tasks'],
      properties: {
        requestId: { type: 'string', minLength: 1, maxLength: 100 },
        title: { type: 'string', minLength: 1, maxLength: 160 },
        reason: { type: 'string', minLength: 1, maxLength: 1000 },
        source: {
          type: 'string',
          enum: ['committed', 'current-tracked'],
          description:
            'Defaults to committed. Use current-tracked only when the user explicitly asks for a read-only review of tracked working-copy changes; untracked files are excluded.',
        },
        tasks: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'name', 'instruction', 'destinationId'],
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 80 },
              name: { type: 'string', minLength: 1, maxLength: 160 },
              instruction: { type: 'string', minLength: 1, maxLength: 6000 },
              destinationId: { type: 'string', minLength: 1, maxLength: 200 },
              provider: { type: 'string', enum: [...AGENT_PROVIDERS] },
              model: { type: 'string', minLength: 1, maxLength: 200 },
              reasoningEffort: {
                type: 'string',
                enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
              },
              access: {
                type: 'string',
                enum: ['read-only', 'inherit'],
                description:
                  'Default read-only. Inherit allows at most the coordinating chat’s current access; it never grants more.',
              },
              dependsOn: {
                type: 'array',
                maxItems: 8,
                items: { type: 'string', minLength: 1, maxLength: 80 },
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'delegation_read',
    title: 'Read delegated work',
    feature: 'chat',
    description:
      'Read durable delegated work belonging to this chat. Omit runId to list recent runs, or include it for bounded task reports. Use after reconnecting or switching providers. Completed agent reports are not independent verification or proof of integration. Do not poll in a tight loop.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', minLength: 1, maxLength: 120 } },
      additionalProperties: false,
    },
  },
  {
    name: 'delegation_stop',
    title: 'Stop delegated work',
    feature: 'chat',
    // Cancelling this chat's approved work must remain possible in read-only mode.
    description:
      'Request cancellation of delegated work in this chat when the user asks to stop it. Remote cancellation can take time; inspect the recorded state instead of claiming the worker already stopped.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: { runId: { type: 'string', minLength: 1, maxLength: 120 } },
      additionalProperties: false,
    },
  },
];

export const delegationToolProvider: AgentToolProvider = {
  id: 'chat-delegation',
  tools: () => tools,
  async call(ctx, name, args, signal) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) return undefined;
    if (!ctx.appThreadId || !ctx.workspaceId)
      throw new AgentToolError('Delegation needs a saved workspace chat.', 'unavailable');
    const errors = validateJsonSchema(tool.inputSchema, args, 'args');
    if (errors.length) throw new AgentToolError(formatSchemaErrors(errors), 'invalid-params');
    if (name === 'delegation_discover') {
      const result = await discoverDelegationCapabilities(ctx);
      return textResult(JSON.stringify(result), { ...result });
    }
    if (name === 'delegation_propose') {
      const result = await proposeChatDelegation(
        ctx,
        args as unknown as ChatDelegationInput,
        signal,
      );
      return textResult(
        'id' in result
          ? `Delegation ${result.id} is ${result.status}. This proposal was approved. Read its saved status and task reports with delegation_read; do not describe it as awaiting approval.\n${JSON.stringify(result)}`
          : result.status === 'awaiting-approval'
            ? `Proposal ${result.requestId} is awaiting the user's inline decision. No tasks have started. End this turn; Mezair will notify you of the decision and results. Do not retry or poll this pending proposal.`
            : 'Delegation was declined or cancelled. No tasks started.',
        { ...result },
      );
    }
    if (name === 'delegation_read' && !args.runId) {
      const runs = (await listChatDelegations(ctx.appThreadId)).filter((run) => {
        const full = requireChatDelegation(ctx.appThreadId!, run.id);
        return full.repoIds.every((id) => ctx.repoIds.includes(id));
      });
      return textResult(JSON.stringify({ runs }), { runs });
    }
    const run = requireChatDelegation(ctx.appThreadId, args.runId as string);
    if (!run.repoIds.every((id) => ctx.repoIds.includes(id)))
      throw new AgentToolError(
        'Delegated work is outside this chat’s selected repositories.',
        'forbidden',
      );
    const result =
      name === 'delegation_stop'
        ? await stopChatDelegation(ctx.appThreadId, run.id)
        : describeChatDelegation(run);
    return textResult(JSON.stringify(result), { ...result });
  },
};
