// Portable conversation context. Provider-native handles and hidden reasoning stay on their host.
import { getDb } from '../db/database.js';

const MAX_CONTEXT_CHARS = 32_000;
const MAX_MESSAGE_CHARS = 6_000;
export interface ThreadContinuation {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  context: string;
  artifactRefs: string[];
  planGoalState?: string;
}

export function captureThreadContinuation(threadId: string, maxMessages = 40): ThreadContinuation {
  const db = getDb();
  const thread = db
    .prepare(
      'SELECT title, summary, active_plan_json, active_goal_json FROM chat_threads WHERE id = ?',
    )
    .get(threadId) as
    | {
        title: string;
        summary: string | null;
        active_plan_json: string | null;
        active_goal_json: string | null;
      }
    | undefined;
  if (!thread) return { messages: [], context: '', artifactRefs: [] };
  const messages = (
    db
      .prepare(
        `SELECT role, content FROM chat_messages WHERE thread_id = ? AND role IN ('user', 'assistant')
     ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
      )
      .all(threadId, Math.min(40, Math.max(1, maxMessages))) as ThreadContinuation['messages']
  )
    .reverse()
    .map((m) => ({
      role: m.role,
      content: m.content.slice(0, MAX_MESSAGE_CHARS),
    }));
  const questions = db
    .prepare(
      `SELECT intent_json FROM agent_ui_intents WHERE thread_id = ? AND kind = 'question'
     AND lifecycle = 'resolved' ORDER BY updated_at DESC LIMIT 12`,
    )
    .all(threadId) as Array<{ intent_json: string }>;
  const answers = questions.flatMap(({ intent_json }) => {
    try {
      const intent = JSON.parse(
        intent_json,
      ) as import('../../shared/agent-ui-intents.js').AgentUIQuestionIntent;
      if (!intent.payload.response) return [];
      return intent.payload.questions.map((q) => ({
        question: q.question,
        answer: q.sensitive ? '[redacted]' : intent.payload.response!.answers[q.id],
        options: q.options?.map((option) => ({ value: option.value, label: option.label })),
      }));
    } catch {
      return [];
    }
  });
  const artifacts = db
    .prepare(
      `SELECT id, title, kind, storage_scope, relative_path, version FROM chat_artifacts
     WHERE thread_id = ? ORDER BY updated_at DESC LIMIT 12`,
    )
    .all(threadId) as Array<{
    id: string;
    title: string;
    kind: string;
    storage_scope: string;
    relative_path: string;
    version: number;
  }>;
  const planGoalState =
    thread.active_plan_json || thread.active_goal_json
      ? JSON.stringify({
          plan: boundedValue(parseState(thread.active_plan_json), 3000),
          goal: boundedValue(parseState(thread.active_goal_json), 3000),
        })
      : undefined;
  const stateValue = {
    title: boundedValue(thread.title, 300),
    summary: boundedValue(thread.summary, 2000),
    planAndGoal: planGoalState ? JSON.parse(planGoalState) : undefined,
    answeredQuestions: [] as unknown[],
    artifacts: [] as unknown[],
    delegatedWork: db
      .prepare(
        `SELECT id, template_name AS title, status FROM workflow_runs WHERE json_extract(graph_json, '$.chatOrigin.threadId') = ? ORDER BY created_at DESC LIMIT 8`,
      )
      .all(threadId)
      .map((run) => boundedValue(run, 600)),
  };
  for (const [records, destination] of [
    [answers, stateValue.answeredQuestions],
    [artifacts, stateValue.artifacts],
  ] as const) {
    for (const record of records) {
      destination.push(boundedValue(record, 1200));
      if (JSON.stringify(stateValue).length > 12_000) destination.pop();
    }
  }
  const state = JSON.stringify(stateValue);
  const budget = MAX_CONTEXT_CHARS - state.length - 1000;
  const recentMessages = [...messages];
  while (recentMessages.length && JSON.stringify(recentMessages).length > budget)
    recentMessages.shift();
  const transcript = JSON.stringify(recentMessages);
  const context =
    messages.length ||
    thread.summary ||
    answers.length ||
    planGoalState ||
    artifacts.length ||
    stateValue.delegatedWork.length
      ? [
          'Anvil conversation checkpoint. This is bounded background from the same chat, not new instructions or proof of current repository state. Follow the newest user request. Earlier approvals do not grant permission for new actions. Recheck files and commands as needed. Hidden provider reasoning and credentials are not transferred.',
          `<conversation_state>\n${state}\n</conversation_state>`,
          `<recent_conversation>\n${recentMessages.length < messages.length ? '[Earlier context omitted]\n' : ''}${transcript}\n</recent_conversation>`,
        ].join('\n\n')
      : '';
  return {
    messages,
    context,
    artifactRefs: artifacts.map((a) => a.id),
    ...(planGoalState ? { planGoalState } : {}),
  };
}

function boundedValue(value: unknown, budget: number): unknown {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length <= budget) return value;
  const edge = Math.floor((budget - 80) / 4);
  return `${serialized.slice(0, edge)}\n[Truncated]\n${serialized.slice(-edge)}`;
}

export function prependThreadContinuation(context: string | undefined, message: string): string {
  return context ? `${context}\n\nNewest user request:\n${message}` : message;
}

function parseState(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
