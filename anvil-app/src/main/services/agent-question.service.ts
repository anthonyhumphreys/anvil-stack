// Anvil-owned questions wait for the same UI response regardless of provider or mode.
import { randomUUID } from 'node:crypto';
import {
  AGENT_UI_PROTOCOL_VERSION,
  type AgentUIAnswerValue,
  type AgentUIQuestionIntent,
  type AgentUIQuestionPayload,
  type AgentUIQuestionResolution,
} from '../../shared/agent-ui-intents.js';
import { AgentToolError, type AgentToolSessionContext } from '../agent-tools/dispatch.js';
import {
  getAgentUIIntentRecord,
  recordAgentUIQuestionResolution,
  upsertAgentUIIntent,
} from './agent-ui-intent.service.js';
import { broadcastAgentUIIntent, getCodexSession } from './codex-session.service.js';

export const AGENT_QUESTION_TIMEOUT_MS = 10 * 60_000;
export interface AgentQuestionResult {
  questionId: string;
  status: 'answered' | 'skipped' | 'cancelled' | 'expired';
  answers: Record<string, AgentUIAnswerValue>;
}
interface PendingQuestion {
  sessionId: string;
  finish: (result: AgentQuestionResult) => void;
  expire: () => void;
}
const pendingQuestions = new Map<string, PendingQuestion>();

export function hasPendingAgentQuestion(sessionId: string): boolean {
  return [...pendingQuestions.values()].some((pending) => pending.sessionId === sessionId);
}

export function askAgentQuestion(
  ctx: AgentToolSessionContext,
  payload: AgentUIQuestionPayload,
  signal?: AbortSignal,
): Promise<AgentQuestionResult> {
  if (!ctx.appThreadId) throw new AgentToolError('Questions need a saved chat.', 'unavailable');
  if (signal?.aborted) throw new AgentToolError('Question request was cancelled.', 'unavailable');
  if (hasPendingAgentQuestion(ctx.sessionId)) {
    throw new AgentToolError('Wait for the current question to be answered.', 'conflict');
  }
  const now = new Date().toISOString();
  const intent: AgentUIQuestionIntent = {
    protocolVersion: AGENT_UI_PROTOCOL_VERSION,
    id: `question:${randomUUID()}`,
    kind: 'question',
    revision: 1,
    scope: {
      threadId: ctx.appThreadId,
      ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
    },
    lifecycle: 'pending',
    presentation: { collapsed: false, hidden: false },
    payload,
    createdAt: now,
    updatedAt: now,
  };
  const saved = upsertAgentUIIntent({
    intent,
    binding: { provider: 'anvil', sessionId: ctx.sessionId },
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: AgentQuestionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      signal?.removeEventListener('abort', expire);
      pendingQuestions.delete(saved.id);
      resolve(result);
    };
    const expire = () => {
      if (settled) return;
      const record = getAgentUIIntentRecord(saved.id);
      if (
        record?.intent.kind === 'question' &&
        (record.intent.lifecycle === 'pending' || record.intent.lifecycle === 'presented')
      ) {
        const expiredAt = new Date().toISOString();
        const expired = upsertAgentUIIntent({
          intent: {
            ...record.intent,
            revision: record.intent.revision + 1,
            lifecycle: 'expired',
            updatedAt: expiredAt,
            resolvedAt: expiredAt,
          },
          binding: record.binding,
        });
        finish({ questionId: saved.id, status: 'expired', answers: {} });
        broadcastAgentUIIntent(expired, ctx.sessionId);
        return;
      }
      finish({ questionId: saved.id, status: 'expired', answers: {} });
    };
    const timeout = setTimeout(expire, AGENT_QUESTION_TIMEOUT_MS);
    const poll = setInterval(() => {
      if (!getCodexSession(ctx.sessionId)) expire();
      else {
        const current = getAgentUIIntentRecord(saved.id)?.intent;
        if (current?.lifecycle === 'expired' || current?.lifecycle === 'dismissed') expire();
      }
    }, 2_000);
    timeout.unref?.();
    poll.unref?.();
    pendingQuestions.set(saved.id, { sessionId: ctx.sessionId, finish, expire });
    signal?.addEventListener('abort', expire, { once: true });
    broadcastAgentUIIntent(saved, ctx.sessionId);
  });
}

export function cancelAgentQuestionsForSession(sessionId: string): void {
  for (const pending of [...pendingQuestions.values()]) {
    if (pending.sessionId === sessionId) pending.expire();
  }
}

/** Returns null for provider-owned questions, which retain their native response bridge. */
export function resolveAnvilOwnedQuestion(
  intentId: string,
  resolution: AgentUIQuestionResolution,
): AgentUIQuestionIntent | null {
  const record = getAgentUIIntentRecord(intentId);
  if (!record || record.intent.kind !== 'question' || record.binding?.provider !== 'anvil') {
    return null;
  }
  const resolved = recordAgentUIQuestionResolution(record.intent, resolution);
  const pending = pendingQuestions.get(intentId);
  if (pending) {
    const answers =
      resolution.action === 'submit'
        ? Object.fromEntries(
            record.intent.payload.questions.map((q) => [q.id, resolution.answers[q.id] ?? null]),
          )
        : {};
    pending.finish({
      questionId: intentId,
      status:
        resolution.action === 'submit'
          ? 'answered'
          : resolution.action === 'skip'
            ? 'skipped'
            : 'cancelled',
      answers,
    });
    broadcastAgentUIIntent(resolved, record.binding.sessionId);
  }
  return resolved;
}
