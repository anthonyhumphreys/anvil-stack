import type {
  AgentUIIntentRecord,
  AgentUIPlanIntent,
  AgentUIQuestion,
  AgentUIQuestionIntent,
  AgentUIQuestionOption,
  AgentUIQuestionResolution,
} from '../../shared/agent-ui-intents.js';
import { AGENT_UI_PROTOCOL_VERSION } from '../../shared/agent-ui-intents.js';
import type {
  ChatPlanSnapshot,
  CodexEvent,
  CodexInputRequest,
  CodexInputResponse,
} from '../../shared/types.js';

interface AgentProviderUIContext {
  appThreadId: string;
  workspaceId?: string;
  providerThreadId?: string;
  sessionId: string;
  provider: 'codex' | 'cursor';
}

export function adaptProviderEventToAgentUIIntent(
  event: CodexEvent,
  context: AgentProviderUIContext,
  current?: AgentUIPlanIntent | null,
): AgentUIIntentRecord | null {
  if (event.type === 'plan_update' && event.plan) {
    const intent = planIntentFromProvider(event.plan, context, current ?? undefined);
    return {
      intent,
      binding: { provider: context.provider, sessionId: context.sessionId },
    };
  }
  if (event.type === 'input_request' && event.inputRequest && event.inputRequestId !== undefined) {
    const intent = questionIntentFromProvider(event.inputRequest, event.inputRequestId, context);
    if (!intent) return null;
    return {
      intent,
      binding: {
        provider: context.provider,
        sessionId: context.sessionId,
        requestId: event.inputRequestId,
        responseKind: event.inputRequest.kind,
      },
    };
  }
  return null;
}

export function providerResponseFromAgentUIResolution(
  intent: AgentUIQuestionIntent,
  resolution: AgentUIQuestionResolution,
  responseKind: 'user_input' | 'mcp_elicitation',
): CodexInputResponse {
  if (responseKind === 'mcp_elicitation') {
    return {
      kind: 'mcp_elicitation',
      action:
        resolution.action === 'submit'
          ? 'accept'
          : resolution.action === 'skip'
            ? 'decline'
            : 'cancel',
      ...(resolution.action === 'submit' ? { content: resolution.answers } : {}),
    };
  }

  return {
    kind: 'user_input',
    answers: Object.fromEntries(
      intent.payload.questions.map((question) => [
        question.id,
        answerToStrings(resolution.answers[question.id]),
      ]),
    ),
  };
}

function planIntentFromProvider(
  plan: ChatPlanSnapshot,
  context: AgentProviderUIContext,
  current?: AgentUIPlanIntent,
): AgentUIPlanIntent {
  const now = plan.updatedAt || new Date().toISOString();
  const planId = current?.payload.planId ?? `plan:${context.appThreadId}`;
  const usedIds = new Set<string>();
  const steps = plan.steps.map((step, index) => {
    const titleMatch = current?.payload.steps.find(
      (candidate) =>
        !usedIds.has(candidate.id) && normaliseText(candidate.title) === normaliseText(step.step),
    );
    const indexMatch = current?.payload.steps[index];
    const previous =
      titleMatch ?? (indexMatch && !usedIds.has(indexMatch.id) ? indexMatch : undefined);
    const id = previous?.id ?? `step:${stableToken(step.step, index)}`;
    usedIds.add(id);
    return {
      ...previous,
      id,
      title: step.step,
      status:
        step.status === 'completed'
          ? ('done' as const)
          : step.status === 'in_progress'
            ? ('in_progress' as const)
            : ('todo' as const),
    };
  });
  const completed = steps.length > 0 && steps.every((step) => step.status === 'done');
  return {
    protocolVersion: AGENT_UI_PROTOCOL_VERSION,
    id: current?.id ?? planId,
    kind: 'plan',
    revision: (current?.revision ?? 0) + 1,
    scope: {
      threadId: context.appThreadId,
      workspaceId: context.workspaceId,
      providerThreadId: context.providerThreadId,
    },
    lifecycle: 'presented',
    presentation: current?.presentation ?? { collapsed: completed, hidden: false },
    payload: {
      planId,
      title: current?.payload.title ?? 'Implementation plan',
      description: plan.explanation ?? current?.payload.description,
      lifecycle: completed ? 'completed' : 'active',
      phases: current?.payload.phases ?? [],
      steps,
    },
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
}

function questionIntentFromProvider(
  request: CodexInputRequest,
  requestId: string | number,
  context: AgentProviderUIContext,
): AgentUIQuestionIntent | null {
  const questions =
    request.kind === 'user_input'
      ? (request.questions ?? []).map(questionFromCodexUserInput)
      : questionsFromJsonSchema(request.requestedSchema);
  if (questions.length === 0) return null;
  const now = new Date().toISOString();
  const id = `question:${context.sessionId}:${typeof requestId}:${String(requestId)}`;
  return {
    protocolVersion: AGENT_UI_PROTOCOL_VERSION,
    id,
    kind: 'question',
    revision: 1,
    scope: {
      threadId: context.appThreadId,
      workspaceId: context.workspaceId,
      providerThreadId: context.providerThreadId,
    },
    lifecycle: 'pending',
    presentation: { collapsed: false, hidden: false },
    payload: {
      title:
        request.kind === 'mcp_elicitation'
          ? request.serverName
            ? `${request.serverName} needs input`
            : 'Connected tool needs input'
          : 'Agent needs your input',
      questions: questions.map((question, index) =>
        index === 0 && request.kind === 'mcp_elicitation' && request.message
          ? { ...question, context: question.context ?? request.message }
          : question,
      ),
    },
    createdAt: now,
    updatedAt: now,
  };
}

function questionFromCodexUserInput(
  question: NonNullable<CodexInputRequest['questions']>[number],
): AgentUIQuestion {
  const options = question.options?.map((option, index): AgentUIQuestionOption => {
    const recommended = /\(recommended\)/i.test(option.label);
    const label = option.label.replace(/\s*\(recommended\)/i, '').trim();
    return {
      id: `${question.id}:option:${index + 1}`,
      label,
      value: label,
      description: option.description || undefined,
      recommended,
    };
  });
  return {
    id: question.id,
    kind: options?.length ? 'single_choice' : 'free_text',
    question: question.question,
    context: question.header,
    required: true,
    allowCancel: false,
    sensitive: question.isSecret,
    options,
  };
}

function questionsFromJsonSchema(schema: unknown): AgentUIQuestion[] {
  if (!isRecord(schema) || schema.type !== 'object' || !isRecord(schema.properties)) return [];
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === 'string')
      : [],
  );
  return Object.entries(schema.properties).flatMap(([id, value]) => {
    if (!isRecord(value)) return [];
    const itemSchema = value.type === 'array' && isRecord(value.items) ? value.items : undefined;
    const enumValues = Array.isArray(value.enum)
      ? value.enum
      : Array.isArray(itemSchema?.enum)
        ? itemSchema.enum
        : undefined;
    const options = enumValues
      ? enumValues.flatMap((option, index): AgentUIQuestionOption[] => {
          if (typeof option !== 'string') return [];
          return [
            {
              id: `${id}:option:${index + 1}`,
              label: option,
              value: option,
            },
          ];
        })
      : undefined;
    const kind: AgentUIQuestion['kind'] = options?.length
      ? value.type === 'array'
        ? 'multiple_choice'
        : 'single_choice'
      : value.type === 'boolean'
        ? 'yes_no'
        : 'free_text';
    return [
      {
        id,
        kind,
        question:
          typeof value.title === 'string'
            ? value.title
            : id.replaceAll('_', ' ').replace(/^./, (character) => character.toUpperCase()),
        context: typeof value.description === 'string' ? value.description : undefined,
        required: required.has(id),
        allowCancel: !required.has(id),
        sensitive: value.writeOnly === true || value.format === 'password',
        defaultValue:
          typeof value.default === 'string' ||
          typeof value.default === 'boolean' ||
          (Array.isArray(value.default) && value.default.every((item) => typeof item === 'string'))
            ? (value.default as string | string[] | boolean)
            : undefined,
        options,
      },
    ];
  });
}

function answerToStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'boolean') return [value ? 'yes' : 'no'];
  if (typeof value === 'string') return [value];
  return [];
}

function stableToken(value: string, index: number): string {
  let hash = 2166136261;
  const input = `${index}:${normaliseText(value)}`;
  for (let position = 0; position < input.length; position += 1) {
    hash ^= input.charCodeAt(position);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normaliseText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
