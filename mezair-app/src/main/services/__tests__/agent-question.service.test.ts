import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentUIQuestionIntent } from '../../../shared/agent-ui-intents.js';
import { AGENT_PROVIDERS } from '../../../shared/agent-providers.js';
import { SCHEMA_SQL } from '../../db/schema.js';
import { mintAgentMcpToken, resetAgentMcpRegistryForTests } from '../agent-mcp/registry.js';
import {
  callAgentTool,
  listAgentTools,
  registerAgentToolProvider,
  resetAgentToolProvidersForTests,
  type AgentToolSessionContext,
} from '../../agent-tools/dispatch.js';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
const session = vi.hoisted(() => ({
  broadcastAgentUIIntent: vi.fn(),
  getCodexSession: vi.fn<() => { id: string } | undefined>(() => ({ id: 'session-1' })),
}));
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../codex-session.service.js', () => session);
import { questionToolProvider } from '../../agent-tools/question-tools.js';
import {
  AGENT_QUESTION_TIMEOUT_MS,
  askAgentQuestion,
  cancelAgentQuestionsForSession,
  resolveMezairOwnedQuestion,
} from '../agent-question.service.js';
import { getAgentUIIntent, expirePendingAgentUIQuestions } from '../agent-ui-intent.service.js';

const ctx: AgentToolSessionContext = {
  sessionId: 'session-1',
  appThreadId: 'thread-1',
  provider: 'codex',
  mode: 'workspace-auto',
  repoIds: [],
  features: [],
};
const args = {
  title: 'Choose a layout',
  questions: [
    {
      id: 'layout',
      kind: 'single_choice',
      question: 'Which layout?',
      allowOther: true,
      options: [
        { id: 'compact', label: 'Compact', recommended: true },
        { id: 'roomy', label: 'Roomy' },
      ],
    },
  ],
};
function latest(): AgentUIQuestionIntent {
  return session.broadcastAgentUIIntent.mock.calls.at(-1)![0] as AgentUIQuestionIntent;
}
function answer(intent: AgentUIQuestionIntent, action: 'submit' | 'cancel' | 'skip' = 'submit') {
  return resolveMezairOwnedQuestion(intent.id, {
    intentId: intent.id,
    action,
    answers: { layout: 'compact' },
    answeredAt: new Date().toISOString(),
  });
}
beforeEach(() => {
  db.exec(
    'DELETE FROM agent_ui_intent_responses; DELETE FROM agent_ui_intent_events; DELETE FROM agent_ui_intents; DELETE FROM chat_threads;',
  );
  db.prepare('INSERT INTO chat_threads (id, persona_id, title) VALUES (?, ?, ?)').run(
    'thread-1',
    'coder',
    'Question test',
  );
  vi.clearAllMocks();
  session.getCodexSession.mockReturnValue({ id: 'session-1' });
  resetAgentMcpRegistryForTests();
  resetAgentToolProvidersForTests();
  registerAgentToolProvider(questionToolProvider);
});
afterEach(() => {
  cancelAgentQuestionsForSession(ctx.sessionId);
  vi.useRealTimers();
});
afterAll(() => db.close());

describe('shared question tool', () => {
  it('keeps workflow questions live while their scoped tool session is active', async () => {
    vi.useFakeTimers();
    session.getCodexSession.mockReturnValue(undefined);
    mintAgentMcpToken(ctx.sessionId, () => ctx);
    const waiting = callAgentTool(ctx, 'question_ask', args);
    const intent = latest();
    await vi.advanceTimersByTimeAsync(2100);
    expect(getAgentUIIntent(intent.id)?.lifecycle).toBe('pending');
    answer(intent);
    expect((await waiting).structuredContent).toMatchObject({ status: 'answered' });
  });
  it('keeps a deferred approval across completed turns and transport aborts, until the session stops', async () => {
    vi.useFakeTimers();
    const waiting = askAgentQuestion(
      ctx,
      {
        title: 'Delegate?',
        questions: [
          {
            id: 'approval',
            kind: 'approval',
            question: 'Delegate?',
            required: true,
            allowCancel: true,
          },
        ],
      },
      undefined,
      { keepAcrossTurns: true },
    );
    const question = latest();
    cancelAgentQuestionsForSession(ctx.sessionId, true);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(getAgentUIIntent(question.id)?.lifecycle).toBe('pending');
    resolveMezairOwnedQuestion(question.id, {
      intentId: question.id,
      action: 'submit',
      answers: { approval: true },
      answeredAt: new Date().toISOString(),
    });
    await expect(waiting).resolves.toMatchObject({
      status: 'answered',
      answers: { approval: true },
    });
    const stopped = askAgentQuestion(
      ctx,
      {
        title: 'Another?',
        questions: [
          {
            id: 'approval',
            kind: 'approval',
            question: 'Another?',
            required: true,
            allowCancel: true,
          },
        ],
      },
      undefined,
      { keepAcrossTurns: true },
    );
    cancelAgentQuestionsForSession(ctx.sessionId);
    await expect(stopped).resolves.toMatchObject({ status: 'expired' });
  });
  for (const provider of AGENT_PROVIDERS) {
    for (const mode of ['read-only', 'on-request', 'workspace-auto'] as const) {
      it(`waits for an answer in ${provider} ${mode}`, async () => {
        const context = { ...ctx, provider, mode };
        expect(listAgentTools(context).map((t) => t.name)).toContain('question_ask');
        const pending = callAgentTool(context, 'question_ask', args);
        const question = latest();
        expect(question.payload.questions[0]).toMatchObject({ required: true, allowCancel: true });
        expect(question.scope.threadId).toBe('thread-1');
        answer(question);
        const result = await pending;
        expect(result.structuredContent).toEqual({
          questionId: question.id,
          status: 'answered',
          answers: { layout: 'compact' },
        });
        expect(getAgentUIIntent(question.id)).toMatchObject({
          lifecycle: 'resolved',
          payload: { response: { answers: { layout: 'compact' } } },
        });
        const calls = session.broadcastAgentUIIntent.mock.calls.length;
        expect(answer(question)?.revision).toBe(2);
        expect(session.broadcastAgentUIIntent).toHaveBeenCalledTimes(calls);
      });
    }
  }
  it('returns multiple selections, a false answer and optional text together', async () => {
    const pending = callAgentTool(ctx, 'question_ask', {
      questions: [
        { ...args.questions[0], kind: 'multiple_choice', allowOther: false },
        { id: 'preview', kind: 'yes_no', question: 'Show a preview?' },
        { id: 'notes', kind: 'free_text', question: 'Any notes?', required: false },
      ],
    });
    const q = latest();
    resolveMezairOwnedQuestion(q.id, {
      intentId: q.id,
      action: 'submit',
      answers: { layout: ['compact', 'roomy'], preview: false },
      answeredAt: new Date().toISOString(),
    });
    expect((await pending).structuredContent).toMatchObject({
      status: 'answered',
      answers: { layout: ['compact', 'roomy'], preview: false, notes: null },
    });
  });
  it('can skip an optional group without returning draft answers', async () => {
    const pending = callAgentTool(ctx, 'question_ask', {
      questions: [{ ...args.questions[0], required: false }],
    });
    answer(latest(), 'skip');
    expect((await pending).structuredContent).toMatchObject({ status: 'skipped', answers: {} });
  });
  it('returns cancellation without draft answers', async () => {
    const pending = callAgentTool(ctx, 'question_ask', args);
    answer(latest(), 'cancel');
    expect((await pending).structuredContent).toMatchObject({ status: 'cancelled', answers: {} });
  });
  it('rejects invalid answers without settling, then accepts a custom answer', async () => {
    const pending = callAgentTool(ctx, 'question_ask', args);
    const q = latest();
    expect(() =>
      resolveMezairOwnedQuestion(q.id, {
        intentId: q.id,
        action: 'submit',
        answers: {},
        answeredAt: new Date().toISOString(),
      }),
    ).toThrow('requires an answer');
    resolveMezairOwnedQuestion(q.id, {
      intentId: q.id,
      action: 'submit',
      answers: { layout: 'My own layout' },
      answeredAt: new Date().toISOString(),
    });
    expect((await pending).structuredContent).toMatchObject({
      answers: { layout: 'My own layout' },
    });
  });
  it('expires on timeout and refuses late answers', async () => {
    vi.useFakeTimers();
    const pending = callAgentTool(ctx, 'question_ask', args);
    const q = latest();
    await vi.advanceTimersByTimeAsync(AGENT_QUESTION_TIMEOUT_MS);
    expect((await pending).structuredContent).toMatchObject({ status: 'expired', answers: {} });
    expect(() => answer(q)).toThrow('no longer awaiting');
  });
  it.each(['session', 'transport'] as const)('expires on %s cancellation', async (kind) => {
    const controller = new AbortController();
    const pending = callAgentTool(ctx, 'question_ask', args, controller.signal);
    const q = latest();
    if (kind === 'session') cancelAgentQuestionsForSession(ctx.sessionId);
    else controller.abort();
    expect((await pending).structuredContent).toMatchObject({ status: 'expired' });
    expect(getAgentUIIntent(q.id)?.lifecycle).toBe('expired');
    expect(() => answer(q)).toThrow('no longer awaiting');
  });
  it('does not publish an already cancelled request or duplicate pending question', async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(callAgentTool(ctx, 'question_ask', args, aborted.signal)).rejects.toThrow(
      'cancelled',
    );
    expect(session.broadcastAgentUIIntent).not.toHaveBeenCalled();
    const pending = callAgentTool(ctx, 'question_ask', args);
    await expect(callAgentTool(ctx, 'question_ask', args)).rejects.toMatchObject({
      code: 'conflict',
    });
    answer(latest());
    await pending;
  });
  it('expires questions from a previous app process', async () => {
    const pending = callAgentTool(ctx, 'question_ask', args);
    const q = latest();
    expect(expirePendingAgentUIQuestions()).toBe(1);
    expect(getAgentUIIntent(q.id)?.lifecycle).toBe('expired');
    cancelAgentQuestionsForSession(ctx.sessionId);
    await pending;
  });
  it.each([
    { questions: [] },
    { questions: [args.questions[0], args.questions[0]] },
    { questions: [{ ...args.questions[0], options: [{ id: 'a', label: 'A' }] }] },
    { questions: [{ ...args.questions[0], kind: 'yes_no' }] },
    { questions: [{ ...args.questions[0], kind: 'approval' }] },
  ])('rejects malformed question definitions', async (input) => {
    await expect(callAgentTool(ctx, 'question_ask', input)).rejects.toMatchObject({
      code: 'invalid-params',
    });
    expect(session.broadcastAgentUIIntent).not.toHaveBeenCalled();
  });
  it('is unavailable without a saved chat', () => {
    expect(listAgentTools({ ...ctx, appThreadId: undefined })).toEqual([]);
  });
});
