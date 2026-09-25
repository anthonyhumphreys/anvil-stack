import { describe, expect, it } from 'vitest';
import type { CodexSession } from '../../../../shared/types';
import { chatMessagesToEntries } from '../../../contexts/ChatContext';
import { buildExecutionTopology } from '../../../utils/execution-topology';
import { composeChatTurns } from '../chat-turns';
import {
  CHAT_REPLAY_PROVENANCE,
  CHAT_REPLAY_SCENARIOS,
  getChatReplayScenario,
  syntheticFollowUpMessage,
  syntheticFollowUpResult,
} from '../replay/chat-replay-fixtures';
import { replayChatScenario } from '../replay/chat-replay-state';

describe('synthetic chat replay scenarios', () => {
  it('labels the fixture data synthetic and contains the required interaction scenarios', () => {
    expect(CHAT_REPLAY_PROVENANCE).toContain('Synthetic');
    expect(CHAT_REPLAY_SCENARIOS.map(({ id }) => id)).toEqual([
      'streaming-rich-content',
      'parallel-agents-status',
      'errors-reconnect-thread-switch',
      'artifact-diff-feedback',
      'large-transcript',
    ]);
  });

  it('runs partial markdown, code, and Mermaid chunks through production history and turn derivation', () => {
    const scenario = getChatReplayScenario('streaming-rich-content');
    const partialMarkdown = replayChatScenario(scenario, 2);
    const markdownEntries = chatMessagesToEntries(
      partialMarkdown.messagesByThread[scenario.initialThreadId],
    );
    const markdownTurn = composeChatTurns(markdownEntries, { active: true })[0];

    expect(markdownTurn.answer?.content).toContain('while the next fragment arrives.');
    expect(markdownTurn.answer?.content).not.toContain('flowchart LR');

    const partialCode = replayChatScenario(scenario, 3);
    const codeEntries = chatMessagesToEntries(
      partialCode.messagesByThread[scenario.initialThreadId],
    );
    const code = composeChatTurns(codeEntries, { active: true })[0].answer?.content ?? '';
    expect(code).toContain('```ts');
    expect(code).not.toContain('The closing fence has now arrived.');

    const completeCode = replayChatScenario(scenario, 4);
    const completeCodeEntries = chatMessagesToEntries(
      completeCode.messagesByThread[scenario.initialThreadId],
    );
    expect(composeChatTurns(completeCodeEntries, { active: true })[0].answer?.content).toContain(
      'The closing fence has now arrived.',
    );

    const partialMermaid = replayChatScenario(scenario, 5);
    const mermaidEntries = chatMessagesToEntries(
      partialMermaid.messagesByThread[scenario.initialThreadId],
    );
    const mermaid = composeChatTurns(mermaidEntries, { active: true })[0].answer?.content ?? '';
    expect(mermaid).toContain('```mermaid\nflowchart LR');
    expect(mermaid).not.toContain('Visible answer');

    const completed = replayChatScenario(scenario);
    const completedEntries = chatMessagesToEntries(
      completed.messagesByThread[scenario.initialThreadId],
    );
    expect(composeChatTurns(completedEntries, { active: true })[0].answer?.content).toContain(
      'Visible answer',
    );
  });

  it('derives parallel agent state and completion through the production execution topology', () => {
    const scenario = getChatReplayScenario('parallel-agents-status');
    const session: CodexSession = {
      id: 'fixture-main-session',
      personaId: 'coder',
      status: 'busy',
      startedAt: '2026-09-25T08:59:00.000Z',
      appThreadId: scenario.initialThreadId,
      providerThreadId: 'fixture-main-protocol',
    };
    const runningSnapshot = replayChatScenario(scenario, 2);
    const runningEntries = chatMessagesToEntries(
      runningSnapshot.messagesByThread[scenario.initialThreadId],
    );
    const runningTopology = buildExecutionTopology({
      entries: runningEntries,
      sessions: [session],
      threadId: scenario.initialThreadId,
      rootLabel: 'Synthetic main agent',
    });

    expect(runningTopology.runningCount).toBe(3);
    expect(runningTopology.nodes.filter(({ kind }) => kind === 'subagent')).toHaveLength(2);
    expect(
      runningTopology.nodes
        .filter(({ kind }) => kind === 'subagent')
        .every(({ status }) => status === 'running'),
    ).toBe(true);

    const completedSnapshot = replayChatScenario(scenario);
    const completedEntries = chatMessagesToEntries(
      completedSnapshot.messagesByThread[scenario.initialThreadId],
    );
    const completedTopology = buildExecutionTopology({
      entries: completedEntries,
      sessions: [{ ...session, status: 'ready' }],
      threadId: scenario.initialThreadId,
      rootLabel: 'Synthetic main agent',
    });
    expect(completedTopology.runningCount).toBe(0);
    expect(
      completedTopology.nodes
        .filter(({ kind }) => kind === 'subagent')
        .every(({ status }) => status === 'completed'),
    ).toBe(true);
  });

  it('keeps errors and reconnect state thread-scoped through replay and transcript derivation', () => {
    const scenario = getChatReplayScenario('errors-reconnect-thread-switch');
    const interrupted = replayChatScenario(scenario, 2);
    const interruptedEntries = chatMessagesToEntries(
      interrupted.messagesByThread[scenario.initialThreadId],
    );

    expect(interrupted.transportByThread[scenario.initialThreadId]).toMatchObject({
      state: 'reconnecting',
    });
    expect(
      composeChatTurns(interruptedEntries)[0].work.some(
        (item) => item.kind === 'event' && item.event.type === 'error',
      ),
    ).toBe(true);

    const switched = replayChatScenario(scenario, 5);
    expect(switched.activeThreadId).toBe('fixture-switched');
    expect(switched.messagesByThread['fixture-switched']).toHaveLength(2);
    expect(switched.messagesByThread[scenario.initialThreadId]).toHaveLength(2);

    const reconnected = replayChatScenario(scenario);
    expect(reconnected.activeThreadId).toBe(scenario.initialThreadId);
    expect(reconnected.transportByThread[scenario.initialThreadId]).toMatchObject({
      state: 'connected',
      detail: 'Synthetic connection restored',
    });
    expect(reconnected.messagesByThread[scenario.initialThreadId]).toHaveLength(3);
    expect(reconnected.messagesByThread['fixture-switched']).toHaveLength(2);
  });

  it('derives the two synthetic revision diffs through production turn composition', () => {
    const scenario = getChatReplayScenario('artifact-diff-feedback');
    const snapshot = replayChatScenario(scenario);
    const entries = chatMessagesToEntries(snapshot.messagesByThread[scenario.initialThreadId]);
    const turn = composeChatTurns(entries)[0];
    const edits = turn.work.filter(
      (item) => item.kind === 'event' && item.event.type === 'file_edit',
    );

    expect(edits).toHaveLength(2);
    expect(edits.map((item) => (item.kind === 'event' ? item.event.filePath : '')).sort()).toEqual([
      '/synthetic/anvil-demo/docs/retry.md',
      '/synthetic/anvil-demo/src/retry.ts',
    ]);
    expect(
      edits.every(
        (item) =>
          item.kind === 'event' &&
          item.event.type === 'file_edit' &&
          typeof item.event.diff === 'string' &&
          item.event.diff.includes('diff --git'),
      ),
    ).toBe(true);
  });

  it('provides a deterministic 600-message transcript for long-history derivation', () => {
    const scenario = getChatReplayScenario('large-transcript');
    const snapshot = replayChatScenario(scenario);
    const messages = snapshot.messagesByThread[scenario.initialThreadId];
    const entries = chatMessagesToEntries(messages);
    const turns = composeChatTurns(entries);

    expect(messages).toHaveLength(600);
    expect(turns).toHaveLength(300);
    expect(turns[0].user?.content).toContain('Turn 1');
    expect(turns[299].answer?.content).toContain('Turn 300');
    expect(turns[249].answer?.content).toContain('```mermaid');
    expect(turns[289].answer?.content).toContain('```ts');
  });

  it('returns local guide, queue, and rejection fixtures without provider calls', () => {
    const guide = syntheticFollowUpResult('guide', 'synthetic-guide-1', 1);
    const queued = syntheticFollowUpResult('queue', 'synthetic-queue-1', 2);
    const rejected = syntheticFollowUpResult('queue', 'synthetic-queue-3', 3);

    expect(guide).toEqual({
      requestId: 'synthetic-guide-1',
      intent: 'guide',
      status: 'delivered',
      queueDepth: 0,
    });
    expect(queued).toEqual({
      requestId: 'synthetic-queue-1',
      intent: 'queue',
      status: 'queued',
      queueDepth: 1,
    });
    expect(rejected).toMatchObject({
      requestId: 'synthetic-queue-3',
      status: 'failed',
      queueDepth: 0,
      error: 'Synthetic follow-up rejection. The draft stays local.',
    });

    const queuedMessage = syntheticFollowUpMessage(
      'fixture-agents',
      'Keep the task moving after the current review.',
      undefined,
      queued,
    );
    expect(chatMessagesToEntries([queuedMessage])[0]).toMatchObject({
      kind: 'user',
      requestId: 'synthetic-queue-1',
      delivery: 'queued',
      deliveryIntent: 'queue',
    });
  });
});
