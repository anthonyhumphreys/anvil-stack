import { describe, expect, it } from 'vitest';
import type { AgentUIPlanIntent, AgentUIQuestionIntent } from '../../../shared/agent-ui-intents.js';
import {
  adaptProviderEventToAgentUIIntent,
  providerResponseFromAgentUIResolution,
} from '../codex-agent-ui.adapter.js';

const context = {
  appThreadId: 'thread-1',
  workspaceId: 'workspace-1',
  providerThreadId: 'provider-thread-1',
  sessionId: 'session-1',
  provider: 'codex' as const,
};

describe('agent provider UI adapter', () => {
  it('creates a provider-neutral plan and preserves stable step ids across updates', () => {
    const created = adaptProviderEventToAgentUIIntent(
      {
        type: 'plan_update',
        plan: {
          explanation: 'Keep the change focused.',
          steps: [
            { step: 'Inspect the protocol', status: 'completed' },
            { step: 'Build the renderer', status: 'in_progress' },
          ],
          updatedAt: '2026-08-19T10:00:00.000Z',
        },
      },
      context,
    );
    expect(created?.intent.kind).toBe('plan');
    const first = created?.intent as AgentUIPlanIntent;
    expect(first.payload).toMatchObject({
      title: 'Implementation plan',
      lifecycle: 'active',
      steps: [
        { title: 'Inspect the protocol', status: 'done' },
        { title: 'Build the renderer', status: 'in_progress' },
      ],
    });

    const updated = adaptProviderEventToAgentUIIntent(
      {
        type: 'plan_update',
        plan: {
          steps: [
            { step: 'Inspect the protocol', status: 'completed' },
            { step: 'Build the renderer', status: 'completed' },
          ],
          updatedAt: '2026-08-19T10:01:00.000Z',
        },
      },
      context,
      first,
    )?.intent as AgentUIPlanIntent;

    expect(updated.revision).toBe(2);
    expect(updated.payload.lifecycle).toBe('completed');
    expect(updated.payload.steps.map((step) => step.id)).toEqual(
      first.payload.steps.map((step) => step.id),
    );
  });

  it('maps Codex choices and free text into explicit question kinds and values', () => {
    const record = adaptProviderEventToAgentUIIntent(
      {
        type: 'input_request',
        inputRequestId: 'question-1',
        inputRequest: {
          kind: 'user_input',
          questions: [
            {
              id: 'provider',
              header: 'Provider',
              question: 'Which provider?',
              isOther: true,
              isSecret: false,
              options: [
                { label: 'Vercel (Recommended)', description: 'Use the existing project.' },
                { label: 'AWS', description: 'Use the AWS account.' },
              ],
            },
            {
              id: 'notes',
              header: 'Notes',
              question: 'Anything else?',
              isOther: true,
              isSecret: false,
            },
          ],
        },
      },
      context,
    );
    const intent = record?.intent as AgentUIQuestionIntent;
    expect(intent.payload.questions).toMatchObject([
      {
        id: 'provider',
        kind: 'single_choice',
        allowOther: true,
        options: [
          { label: 'Vercel', value: 'Vercel', recommended: true },
          { label: 'AWS', value: 'AWS', recommended: false },
        ],
      },
      { id: 'notes', kind: 'free_text' },
    ]);
    expect(record?.binding).toMatchObject({
      provider: 'codex',
      sessionId: 'session-1',
      requestId: 'question-1',
      responseKind: 'user_input',
    });
  });

  it('turns JSON-schema MCP forms into native questions', () => {
    const intent = adaptProviderEventToAgentUIIntent(
      {
        type: 'input_request',
        inputRequestId: 'elicitation-1',
        inputRequest: {
          kind: 'mcp_elicitation',
          serverName: 'Deploy',
          message: 'Confirm the target.',
          mode: 'form',
          requestedSchema: {
            type: 'object',
            required: ['environment', 'approved'],
            properties: {
              environment: {
                title: 'Environment',
                type: 'string',
                enum: ['Preview', 'Production'],
              },
              approved: { title: 'Proceed?', type: 'boolean' },
              checks: {
                title: 'Checks',
                type: 'array',
                items: { type: 'string', enum: ['Test', 'Lint'] },
                default: ['Test'],
              },
              note: { title: 'Note', type: 'string' },
            },
          },
        },
      },
      context,
    )?.intent as AgentUIQuestionIntent;

    expect(intent.payload.title).toBe('Deploy needs input');
    expect(intent.payload.questions).toMatchObject([
      { id: 'environment', kind: 'single_choice', required: true },
      { id: 'approved', kind: 'yes_no', required: true },
      { id: 'checks', kind: 'multiple_choice', defaultValue: ['Test'] },
      { id: 'note', kind: 'free_text', required: false, allowCancel: true },
    ]);
  });

  it('binds Cursor ACP plans and form elicitations to the Cursor session', () => {
    const cursorContext = { ...context, provider: 'cursor' as const };
    const plan = adaptProviderEventToAgentUIIntent(
      {
        type: 'plan_update',
        plan: {
          steps: [{ step: 'Inspect ACP', status: 'in_progress' }],
          updatedAt: '2026-08-19T10:02:00.000Z',
        },
      },
      cursorContext,
    );
    const question = adaptProviderEventToAgentUIIntent(
      {
        type: 'input_request',
        inputRequestId: 7,
        inputRequest: {
          kind: 'mcp_elicitation',
          message: 'Choose a target.',
          mode: 'form',
          requestedSchema: {
            type: 'object',
            required: ['target'],
            properties: {
              target: { title: 'Target', type: 'string', enum: ['Preview', 'Production'] },
            },
          },
        },
      },
      cursorContext,
    );
    const cursorQuestion = adaptProviderEventToAgentUIIntent(
      {
        type: 'input_request',
        inputRequestId: 8,
        inputRequest: {
          kind: 'cursor_ask_question',
          title: 'Choose a target',
          questions: [
            {
              id: 'target',
              prompt: 'Where should this deploy?',
              options: [{ id: 'preview', label: 'Preview' }],
            },
          ],
        },
      },
      cursorContext,
    );
    const cursorPlan = adaptProviderEventToAgentUIIntent(
      {
        type: 'input_request',
        inputRequestId: 9,
        inputRequest: {
          kind: 'cursor_create_plan',
          title: 'Approve implementation plan',
          plan: '1. Inspect\n2. Implement',
        },
      },
      cursorContext,
    );

    expect(plan?.binding).toEqual({ provider: 'cursor', sessionId: 'session-1' });
    expect(question?.binding).toEqual({
      provider: 'cursor',
      sessionId: 'session-1',
      requestId: 7,
      responseKind: 'mcp_elicitation',
    });
    expect(question?.intent).toMatchObject({
      kind: 'question',
      payload: { questions: [{ id: 'target', kind: 'single_choice' }] },
    });
    expect(cursorQuestion?.intent).toMatchObject({
      kind: 'question',
      payload: {
        title: 'Choose a target',
        questions: [{ id: 'target', options: [{ id: 'preview', value: 'preview' }] }],
      },
    });
    expect(cursorQuestion?.binding).toMatchObject({
      requestId: 8,
      responseKind: 'cursor_ask_question',
    });
    expect(cursorPlan?.intent).toMatchObject({
      kind: 'question',
      payload: {
        title: 'Approve implementation plan',
        questions: [{ id: 'plan', kind: 'approval' }],
      },
    });
    expect(cursorPlan?.binding).toMatchObject({
      requestId: 9,
      responseKind: 'cursor_create_plan',
    });
  });

  it('returns structured single, multi, text, and approval answers to providers', () => {
    const intent: AgentUIQuestionIntent = {
      protocolVersion: 1,
      id: 'question-1',
      kind: 'question',
      revision: 1,
      scope: { threadId: 'thread-1' },
      lifecycle: 'pending',
      presentation: { collapsed: false, hidden: false },
      payload: {
        questions: [
          {
            id: 'single',
            kind: 'single_choice',
            question: 'One?',
            required: true,
            allowCancel: false,
            options: [],
          },
          {
            id: 'multi',
            kind: 'multiple_choice',
            question: 'Many?',
            required: true,
            allowCancel: false,
            options: [],
          },
          { id: 'text', kind: 'free_text', question: 'Why?', required: true, allowCancel: false },
          {
            id: 'approval',
            kind: 'approval',
            question: 'Proceed?',
            required: true,
            allowCancel: false,
          },
        ],
      },
      createdAt: '2026-08-19T10:00:00.000Z',
      updatedAt: '2026-08-19T10:00:00.000Z',
    };
    const resolution = {
      intentId: intent.id,
      action: 'submit' as const,
      answers: { single: 'one', multi: ['a', 'b'], text: 'Because', approval: true },
      answeredAt: '2026-08-19T10:01:00.000Z',
    };

    expect(providerResponseFromAgentUIResolution(intent, resolution, 'user_input')).toEqual({
      kind: 'user_input',
      answers: {
        single: ['one'],
        multi: ['a', 'b'],
        text: ['Because'],
        approval: ['yes'],
      },
    });
    expect(providerResponseFromAgentUIResolution(intent, resolution, 'mcp_elicitation')).toEqual({
      kind: 'mcp_elicitation',
      action: 'accept',
      content: resolution.answers,
    });

    const cursorQuestionIntent = {
      ...intent,
      payload: {
        questions: [
          {
            id: 'target',
            kind: 'single_choice' as const,
            question: 'Where?',
            required: true,
            allowCancel: true,
            options: [{ id: 'preview', label: 'Preview', value: 'preview' }],
          },
        ],
      },
    };
    expect(
      providerResponseFromAgentUIResolution(
        cursorQuestionIntent,
        {
          ...resolution,
          answers: { target: 'preview' },
        },
        'cursor_ask_question',
      ),
    ).toEqual({
      kind: 'cursor_ask_question',
      action: 'submit',
      answers: [{ questionId: 'target', selectedOptionIds: ['preview'] }],
    });
    expect(
      providerResponseFromAgentUIResolution(
        cursorQuestionIntent,
        { ...resolution, action: 'cancel', answers: {} },
        'cursor_ask_question',
      ),
    ).toEqual({
      kind: 'cursor_ask_question',
      action: 'cancel',
      answers: [{ questionId: 'target', selectedOptionIds: [] }],
    });

    const cursorPlanIntent = {
      ...intent,
      payload: {
        questions: [
          {
            id: 'plan',
            kind: 'approval' as const,
            question: 'Approve?',
            required: true,
            allowCancel: true,
          },
        ],
      },
    };
    expect(
      providerResponseFromAgentUIResolution(
        cursorPlanIntent,
        { ...resolution, action: 'skip', answers: {} },
        'cursor_create_plan',
      ),
    ).toEqual({ kind: 'cursor_create_plan', action: 'skip' });
    expect(
      providerResponseFromAgentUIResolution(
        cursorPlanIntent,
        { ...resolution, action: 'submit', answers: { plan: false } },
        'cursor_create_plan',
      ),
    ).toEqual({ kind: 'cursor_create_plan', action: 'skip' });
    expect(
      providerResponseFromAgentUIResolution(
        cursorPlanIntent,
        { ...resolution, action: 'submit', answers: { plan: true } },
        'cursor_create_plan',
      ),
    ).toEqual({ kind: 'cursor_create_plan', action: 'submit' });
  });
});
