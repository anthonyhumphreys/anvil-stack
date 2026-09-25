import type { CodexEvent } from '../../../shared/types';
import type { ComposedChatTurn, ChatTurnWorkItem } from './chat-turns';
import { summarizeTurnChanges, type TurnChangeSummary } from './chat-turn-changes';

export type ChatQuestionTargetKind = 'input' | 'approval' | 'intent';

export interface ChatQuestionTarget {
  id: string;
  kind: ChatQuestionTargetKind;
  label: string;
  turnKey: string;
  sourceIndex: number;
}

export interface ChatCommandEvidence {
  command: string;
  exitCode?: number;
  output?: string;
}

export type ChatRunSummaryState =
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'awaiting-user'
  | 'running'
  | 'response-ended';

export interface ChatRunSummary {
  state: ChatRunSummaryState;
  title: string;
  nextAction: string;
  pendingTarget?: ChatQuestionTarget;
  changes: TurnChangeSummary | null;
  commands: ChatCommandEvidence[];
}

const REQUEST_OUTPUT_LIMIT = 360;

/**
 * Build a stable, collision-safe target key for an actionable request surface.
 * JSON-RPC ids may be either strings or numbers, so preserve their type.
 */
export function getChatQuestionTargetId(event: CodexEvent): string | null {
  if (event.type === 'input_request' && event.inputRequestId !== undefined) {
    return `input:${eventScope(event)}:${typeof event.inputRequestId}:${String(event.inputRequestId)}`;
  }
  if (event.type === 'approval_request' && event.approvalRequestId !== undefined) {
    return `approval:${eventScope(event)}:${typeof event.approvalRequestId}:${String(event.approvalRequestId)}`;
  }
  if (event.type === 'agent_ui_intent' && event.agentUIIntent?.kind === 'question') {
    return `intent:${event.agentUIIntent.id}`;
  }
  return null;
}

/** Build an HTML-safe DOM id for `data-chat-request-target` and jump navigation. */
export function buildChatRequestTargetDomId(targetId: string): string {
  const encoded = Array.from(targetId, (character) => character.codePointAt(0)!.toString(16)).join(
    '-',
  );
  return `chat-question-target-${encoded || 'empty'}`;
}

/** Return the actionable request targets rendered inside one turn. */
export function getChatTurnRequestTargets(turn: ComposedChatTurn): ChatQuestionTarget[] {
  const targets: ChatQuestionTarget[] = [];
  for (const item of getTurnEventItems(turn)) {
    if (item.kind !== 'event') continue;
    const id = getChatQuestionTargetId(item.event);
    const kind = getTargetKind(id);
    if (!id || !kind) continue;
    targets.push({
      id,
      kind,
      label: getQuestionTargetLabel(item.event),
      turnKey: turn.key,
      sourceIndex: item.sourceIndex,
    });
  }
  return targets;
}

/** Find the oldest still-pending actionable question across the transcript. */
export function getPendingQuestionTarget(
  turns: readonly ComposedChatTurn[],
): ChatQuestionTarget | null {
  const pending = new Map<string, ChatQuestionTarget>();
  const turnKeyBySourceIndex = new Map<number, string>();
  for (const turn of turns) {
    for (const item of getTurnEventItems(turn)) {
      turnKeyBySourceIndex.set(item.sourceIndex, turn.key);
    }
  }
  const items = turns
    .flatMap((turn) => getTurnEventItems(turn))
    .filter((item): item is Extract<ChatTurnWorkItem, { kind: 'event' }> => item.kind === 'event')
    .sort((left, right) => left.sourceIndex - right.sourceIndex);

  for (const item of items) {
    const { event } = item;
    if (event.type === 'request_resolved' && event.resolvedRequestId !== undefined) {
      const value = String(event.resolvedRequestId);
      const idType = typeof event.resolvedRequestId;
      const scope = eventScope(event);
      pending.delete(`input:${scope}:${idType}:${value}`);
      pending.delete(`approval:${scope}:${idType}:${value}`);
      continue;
    }
    if (event.type === 'agent_ui_intent_resolved' && event.agentUIIntentId) {
      pending.delete(`intent:${event.agentUIIntentId}`);
      continue;
    }

    const id = getChatQuestionTargetId(event);
    const kind = getTargetKind(id);
    if (!id || !kind) continue;
    if (
      kind === 'intent' &&
      (event.agentUIIntent?.lifecycle === 'resolved' ||
        event.agentUIIntent?.lifecycle === 'dismissed' ||
        event.agentUIIntent?.lifecycle === 'expired')
    ) {
      pending.delete(id);
      continue;
    }
    pending.set(id, {
      id,
      kind,
      label: getQuestionTargetLabel(event),
      turnKey: turnKeyBySourceIndex.get(item.sourceIndex) ?? '',
      sourceIndex: item.sourceIndex,
    });
  }

  return pending.values().next().value ?? null;
}

/**
 * Build a compact run summary from provider lifecycle evidence and the actual
 * change/command events in this turn. Assistant prose is never treated as
 * execution evidence.
 */
export function summarizeChatTurnRun(
  turn: ComposedChatTurn,
  options: { busy?: boolean; pendingTarget?: ChatQuestionTarget | null } = {},
): ChatRunSummary | null {
  const workItems = [...turn.work, ...turn.trailingWork];
  const hasTranscriptPendingTarget = Object.prototype.hasOwnProperty.call(options, 'pendingTarget');
  const pendingTarget = hasTranscriptPendingTarget
    ? options.pendingTarget?.turnKey === turn.key
      ? options.pendingTarget
      : null
    : getPendingQuestionTarget([turn]);
  const lastThreadStatus = [...workItems]
    .reverse()
    .find(
      (item): item is Extract<ChatTurnWorkItem, { kind: 'event' }> =>
        item.kind === 'event' && item.event.type === 'thread_status',
    )?.event.threadActiveFlags;
  const waitingOnThreadStatus =
    lastThreadStatus?.includes('waitingOnApproval') === true ||
    lastThreadStatus?.includes('waitingOnUserInput') === true;
  const waitingOnApproval =
    pendingTarget?.kind === 'approval' || lastThreadStatus?.includes('waitingOnApproval') === true;
  const waitingOnUser = pendingTarget !== null || waitingOnThreadStatus;
  const lastStatus = [...workItems]
    .reverse()
    .find(
      (item): item is Extract<ChatTurnWorkItem, { kind: 'event' }> =>
        item.kind === 'event' && item.event.type === 'status',
    )?.event.status;

  let state: ChatRunSummaryState | null = null;
  if (waitingOnUser) state = 'awaiting-user';
  else if (turn.runOutcome === 'completed') state = 'completed';
  else if (turn.runOutcome === 'failed') state = 'failed';
  else if (turn.runOutcome === 'interrupted') state = 'stopped';
  else if (lastStatus === 'error') state = 'failed';
  else if (options.busy) state = 'running';
  else if (turn.runOutcome === 'inProgress' || lastStatus === 'complete') state = 'response-ended';

  if (!state || (state === 'running' && options.busy)) return null;

  const changes = summarizeTurnChanges(workItems);
  const commands = collectChatCommandEvidence(workItems);
  const hasFailedCommand = commands.some(
    (command) => typeof command.exitCode === 'number' && command.exitCode !== 0,
  );
  const titleByState: Record<ChatRunSummaryState, string> = {
    completed: 'Run finished',
    failed: 'Run failed',
    stopped: 'Run stopped',
    'awaiting-user': waitingOnApproval ? 'Approval needed' : 'Your input is needed',
    running: 'Run in progress',
    'response-ended': 'Response ended',
  };
  const nextActionByState: Record<ChatRunSummaryState, string> = {
    completed: hasFailedCommand
      ? 'Review the failed command before relying on the result.'
      : changes
        ? 'Review the changed files before committing.'
        : 'Read the response and follow up if needed.',
    failed: 'Inspect the error or failed command, then retry if appropriate.',
    stopped: 'Review partial changes, then continue or retry the request.',
    'awaiting-user': waitingOnApproval
      ? 'Approve or decline the request above to continue.'
      : 'Answer the request above to continue.',
    running: 'Continue from the latest activity.',
    'response-ended':
      'The run outcome was not reported; review the response and observed activity.',
  };

  return {
    state,
    title: titleByState[state],
    nextAction: nextActionByState[state],
    pendingTarget: pendingTarget ?? undefined,
    changes,
    commands,
  };
}

export function collectChatCommandEvidence(workItems: ChatTurnWorkItem[]): ChatCommandEvidence[] {
  return workItems.flatMap((item) => {
    if (
      item.kind !== 'event' ||
      item.event.type !== 'command_exec' ||
      !item.event.command?.trim()
    ) {
      return [];
    }
    return [
      {
        command: item.event.command.trim(),
        exitCode:
          typeof item.event.exitCode === 'number' && Number.isFinite(item.event.exitCode)
            ? item.event.exitCode
            : undefined,
        output: compactOutput(item.event.output),
      },
    ];
  });
}

function getTurnEventItems(turn: ComposedChatTurn): ChatTurnWorkItem[] {
  return [...turn.work, ...turn.trailingWork];
}

function getTargetKind(id: string | null): ChatQuestionTargetKind | null {
  if (id?.startsWith('input:')) return 'input';
  if (id?.startsWith('approval:')) return 'approval';
  if (id?.startsWith('intent:')) return 'intent';
  return null;
}

function getQuestionTargetLabel(event: CodexEvent): string {
  if (event.type === 'approval_request') {
    return event.approvalCommand ?? event.toolName ?? 'Agent approval request';
  }
  if (event.type === 'input_request') {
    const request = event.inputRequest;
    if (request?.kind === 'user_input') return request.questions?.[0]?.question ?? 'Agent question';
    if (request?.kind === 'cursor_ask_question') {
      return request.questions[0]?.prompt ?? 'Agent question';
    }
    if (request?.kind === 'cursor_create_plan') return request.title ?? 'Plan review request';
    if (request?.kind === 'mcp_elicitation') {
      return request.message ?? request.serverName ?? 'Connected tool request';
    }
    return 'Agent question';
  }
  if (event.type === 'agent_ui_intent') {
    const intent = event.agentUIIntent;
    return intent?.kind === 'question'
      ? (intent.payload.title ?? intent.payload.questions[0]?.question ?? 'Agent question')
      : 'Agent question';
  }
  return 'Agent request';
}

function compactOutput(output?: string): string | undefined {
  const trimmed = output?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= REQUEST_OUTPUT_LIMIT) return trimmed;
  return `…${trimmed.slice(-REQUEST_OUTPUT_LIMIT)}`;
}

function eventScope(event: CodexEvent): string {
  return event.sessionId ?? event.appThreadId ?? 'thread';
}
