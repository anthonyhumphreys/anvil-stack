import type { ChatMessage } from '../../../../shared/types';
import { chatMessagesToEntries } from '../../../contexts/ChatContext';
import type { ChatEntry } from '../../../contexts/ChatContext';
import type { ChatReplayScenario } from './chat-replay-fixtures';

export interface ChatReplayTransportState {
  state: 'connected' | 'reconnecting';
  detail?: string;
}

export interface ChatReplaySnapshot {
  activeThreadId: string;
  messagesByThread: Record<string, ChatMessage[]>;
  transportByThread: Record<string, ChatReplayTransportState>;
}

export function replayChatScenario(
  scenario: ChatReplayScenario,
  throughStep = scenario.steps.length - 1,
): ChatReplaySnapshot {
  const snapshot: ChatReplaySnapshot = {
    activeThreadId: scenario.initialThreadId,
    messagesByThread: Object.fromEntries(scenario.threads.map(({ id }) => [id, []])),
    transportByThread: Object.fromEntries(
      scenario.threads.map(({ id }) => [id, { state: 'connected' as const }]),
    ),
  };

  for (const step of scenario.steps.slice(0, Math.max(0, throughStep + 1))) {
    switch (step.kind) {
      case 'message':
        snapshot.messagesByThread[step.threadId] = [
          ...(snapshot.messagesByThread[step.threadId] ?? []),
          step.message,
        ];
        break;
      case 'history':
        snapshot.messagesByThread[step.threadId] = [
          ...(snapshot.messagesByThread[step.threadId] ?? []),
          ...step.messages,
        ];
        break;
      case 'transport':
        snapshot.transportByThread[step.threadId] = {
          state: step.state,
          detail: step.detail,
        };
        break;
      case 'select-thread':
        snapshot.activeThreadId = step.threadId;
        break;
    }
  }

  return snapshot;
}

/** Run a recorded synthetic history through the same conversion used after chat history loads. */
export function deriveReplayEntries(messages: ChatMessage[]): ChatEntry[] {
  return chatMessagesToEntries(messages);
}
