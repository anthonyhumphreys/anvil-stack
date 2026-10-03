import type {
  ChatFollowUpIntent,
  ChatFollowUpResult,
  ChatAttachment,
  ChatMessage,
  CodexEvent,
} from '../../../../shared/types';

export const CHAT_REPLAY_PROVENANCE =
  'Synthetic local fixture data. No provider messages, workspace data, or IPC responses.';

export interface ReplayThreadDefinition {
  id: string;
  title: string;
}

export type ChatReplayStep =
  | { kind: 'message'; threadId: string; message: ChatMessage }
  | { kind: 'history'; threadId: string; messages: ChatMessage[] }
  | { kind: 'transport'; threadId: string; state: 'connected' | 'reconnecting'; detail?: string }
  | { kind: 'select-thread'; threadId: string };

export interface ChatReplayScenario {
  id: string;
  title: string;
  description: string;
  initialThreadId: string;
  threads: ReplayThreadDefinition[];
  steps: ChatReplayStep[];
}

const timestamp = '2026-09-25T09:00:00.000Z';

export function syntheticFollowUpResult(
  intent: ChatFollowUpIntent,
  requestId: string,
  attempt: number,
): ChatFollowUpResult {
  if (attempt === 3) {
    return {
      requestId,
      intent,
      status: 'failed',
      queueDepth: 0,
      error: 'Synthetic follow-up rejection. The draft stays local.',
    };
  }

  return {
    requestId,
    intent,
    status: intent === 'guide' ? 'delivered' : 'queued',
    queueDepth: intent === 'guide' ? 0 : 1,
  };
}

export function syntheticFollowUpMessage(
  threadId: string,
  content: string,
  attachments: ChatAttachment[] | undefined,
  result: ChatFollowUpResult,
): ChatMessage {
  return {
    id: result.requestId,
    role: 'user',
    content,
    timestamp,
    threadId,
    personaId: 'coder',
    attachments,
    event: {
      type: 'follow_up_delivery',
      followUpRequestId: result.requestId,
      followUpIntent: result.intent,
      followUpStatus: result.status,
      followUpQueueDepth: result.queueDepth,
      ...(result.error ? { followUpError: result.error } : {}),
    },
  };
}

function message(
  id: string,
  threadId: string,
  role: ChatMessage['role'],
  content: string,
  event?: CodexEvent,
): ChatMessage {
  return { id, threadId, personaId: 'coder', role, content, timestamp, event };
}

function textEvent(id: string, threadId: string, itemId: string, text: string): ChatMessage {
  return message(id, threadId, 'assistant', '', {
    type: 'text',
    itemId,
    assistantPhase: 'final',
    text,
  });
}

const streamingThread = 'fixture-streaming';
const streamingScenario: ChatReplayScenario = {
  id: 'streaming-rich-content',
  title: 'Streaming markdown, code, and Mermaid',
  description: 'Advance through incomplete and complete markdown, fenced code, and Mermaid blocks.',
  initialThreadId: streamingThread,
  threads: [{ id: streamingThread, title: 'Streaming rich content' }],
  steps: [
    {
      kind: 'message',
      threadId: streamingThread,
      message: message(
        'stream-user',
        streamingThread,
        'user',
        'Explain the change and sketch the flow as the response streams in.',
      ),
    },
    {
      kind: 'message',
      threadId: streamingThread,
      message: textEvent(
        'stream-markdown-1',
        streamingThread,
        'stream-answer',
        '## Change summary\n\nThe transcript should keep this partial sentence readable',
      ),
    },
    {
      kind: 'message',
      threadId: streamingThread,
      message: textEvent(
        'stream-markdown-2',
        streamingThread,
        'stream-answer',
        ' while the next fragment arrives.\n\nThe update is small and scoped.',
      ),
    },
    {
      kind: 'message',
      threadId: streamingThread,
      message: textEvent(
        'stream-code-1',
        streamingThread,
        'stream-code',
        '\n\n```ts\nexport function formatThreadTitle(title: string) {\n  return title.trim()',
      ),
    },
    {
      kind: 'message',
      threadId: streamingThread,
      message: textEvent(
        'stream-code-2',
        streamingThread,
        'stream-code',
        " || 'Untitled';\n}\n```\n\nThe closing fence has now arrived.",
      ),
    },
    {
      kind: 'message',
      threadId: streamingThread,
      message: textEvent(
        'stream-mermaid-1',
        streamingThread,
        'stream-diagram',
        '\n\n```mermaid\nflowchart LR\n  Input[User input] -->',
      ),
    },
    {
      kind: 'message',
      threadId: streamingThread,
      message: textEvent(
        'stream-mermaid-2',
        streamingThread,
        'stream-diagram',
        ' Render[Transcript renderer]\n  Render --> Output[Visible answer]\n```',
      ),
    },
  ],
};

const agentsThread = 'fixture-agents';
const agentScenario: ChatReplayScenario = {
  id: 'parallel-agents-status',
  title: 'Parallel agents and live status',
  description:
    'Replay two delegated agents starting, reporting, completing, and settling the turn.',
  initialThreadId: agentsThread,
  threads: [{ id: agentsThread, title: 'Parallel review' }],
  steps: [
    {
      kind: 'message',
      threadId: agentsThread,
      message: message(
        'agents-user',
        agentsThread,
        'user',
        'Review the workspace changes and check the focused tests in parallel.',
      ),
    },
    {
      kind: 'message',
      threadId: agentsThread,
      message: message('agents-status-thinking', agentsThread, 'system', '', {
        type: 'status',
        status: 'thinking',
        sessionId: 'fixture-main-session',
      }),
    },
    {
      kind: 'message',
      threadId: agentsThread,
      message: message('agents-spawn', agentsThread, 'system', '', {
        type: 'subagent_update',
        sessionId: 'fixture-main-session',
        subagent: {
          id: 'fixture-parallel-spawn',
          kind: 'tool_call',
          tool: 'spawnAgent',
          status: 'inProgress',
          senderThreadId: 'fixture-main-protocol',
          receiverThreadIds: ['fixture-review-agent', 'fixture-test-agent'],
          prompt: 'Review the synthetic workspace fixture.',
          model: 'synthetic-fixture-model',
          agents: [
            { threadId: 'fixture-review-agent', status: 'running', message: 'Reading the diff.' },
            { threadId: 'fixture-test-agent', status: 'running', message: 'Checking test scope.' },
          ],
        },
      }),
    },
    {
      kind: 'message',
      threadId: agentsThread,
      message: message('agents-status-executing', agentsThread, 'system', '', {
        type: 'thread_status',
        protocolThreadId: 'fixture-main-protocol',
        status: 'executing',
      }),
    },
    {
      kind: 'message',
      threadId: agentsThread,
      message: message('agents-review-update', agentsThread, 'system', '', {
        type: 'subagent_update',
        subagent: {
          id: 'fixture-review-progress',
          kind: 'activity',
          receiverThreadIds: ['fixture-review-agent'],
          agentThreadId: 'fixture-review-agent',
          activityKind: 'interacted',
          agents: [
            {
              threadId: 'fixture-review-agent',
              status: 'running',
              message: 'No authorization boundary change found.',
            },
          ],
        },
      }),
    },
    {
      kind: 'message',
      threadId: agentsThread,
      message: message('agents-review-done', agentsThread, 'system', '', {
        type: 'subagent_update',
        subagent: {
          id: 'fixture-review-completed',
          kind: 'activity',
          receiverThreadIds: ['fixture-review-agent'],
          agentThreadId: 'fixture-review-agent',
          activityKind: 'completed',
          agents: [
            {
              threadId: 'fixture-review-agent',
              status: 'completed',
              message: 'Review complete: no blocker in the synthetic diff.',
            },
          ],
        },
      }),
    },
    {
      kind: 'message',
      threadId: agentsThread,
      message: message('agents-test-done', agentsThread, 'system', '', {
        type: 'subagent_update',
        subagent: {
          id: 'fixture-test-completed',
          kind: 'activity',
          receiverThreadIds: ['fixture-test-agent'],
          agentThreadId: 'fixture-test-agent',
          activityKind: 'completed',
          agents: [
            {
              threadId: 'fixture-test-agent',
              status: 'completed',
              message: 'Focused fixture checks are represented.',
            },
          ],
        },
      }),
    },
    {
      kind: 'message',
      threadId: agentsThread,
      message: textEvent(
        'agents-answer',
        agentsThread,
        'agents-answer-item',
        'Both synthetic agents completed. Their statuses stay attached to the active turn.',
      ),
    },
    {
      kind: 'message',
      threadId: agentsThread,
      message: message('agents-status-complete', agentsThread, 'system', '', {
        type: 'status',
        status: 'complete',
        sessionId: 'fixture-main-session',
      }),
    },
  ],
};

const recoveryThread = 'fixture-recovery';
const switchedThread = 'fixture-switched';
const recoveryScenario: ChatReplayScenario = {
  id: 'errors-reconnect-thread-switch',
  title: 'Error recovery and thread switching',
  description:
    'Show a local disconnect, a second thread, reconnection, and return to the first thread.',
  initialThreadId: recoveryThread,
  threads: [
    { id: recoveryThread, title: 'Reconnect test' },
    { id: switchedThread, title: 'Unrelated thread' },
  ],
  steps: [
    {
      kind: 'message',
      threadId: recoveryThread,
      message: message(
        'recovery-user',
        recoveryThread,
        'user',
        'Summarise the current session state.',
      ),
    },
    {
      kind: 'message',
      threadId: recoveryThread,
      message: message('recovery-error', recoveryThread, 'system', '', {
        type: 'error',
        errorMessage: 'Synthetic transport interruption. No request was sent.',
      }),
    },
    {
      kind: 'transport',
      threadId: recoveryThread,
      state: 'reconnecting',
      detail: 'Synthetic connection interruption',
    },
    { kind: 'select-thread', threadId: switchedThread },
    {
      kind: 'message',
      threadId: switchedThread,
      message: message(
        'switched-user',
        switchedThread,
        'user',
        'Keep this conversation separate while the first thread reconnects.',
      ),
    },
    {
      kind: 'message',
      threadId: switchedThread,
      message: message(
        'switched-answer',
        switchedThread,
        'assistant',
        'This synthetic thread has its own transcript and scroll position.',
      ),
    },
    {
      kind: 'transport',
      threadId: recoveryThread,
      state: 'connected',
      detail: 'Synthetic connection restored',
    },
    { kind: 'select-thread', threadId: recoveryThread },
    {
      kind: 'message',
      threadId: recoveryThread,
      message: message(
        'recovery-answer',
        recoveryThread,
        'assistant',
        'The connection is marked restored. The earlier error remains visible in the transcript.',
      ),
    },
  ],
};

const changesThread = 'fixture-artifact-review';
const artifactReviewScenario: ChatReplayScenario = {
  id: 'artifact-diff-feedback',
  title: 'Artifact feedback and diff selection',
  description:
    'Select a file change, review its exact diff, and hand selected artifact feedback to the local composer.',
  initialThreadId: changesThread,
  threads: [{ id: changesThread, title: 'Revision review' }],
  steps: [
    {
      kind: 'message',
      threadId: changesThread,
      message: message(
        'artifact-user',
        changesThread,
        'user',
        'Update retry handling and include the source revision so I can review both changes.',
      ),
    },
    {
      kind: 'message',
      threadId: changesThread,
      message: message('artifact-edit-retry', changesThread, 'system', '', {
        type: 'file_edit',
        agentLabel: 'Synthetic Coder',
        filePath: '/synthetic/anvil-demo/src/retry.ts',
        diff: [
          'diff --git a/src/retry.ts b/src/retry.ts',
          '--- a/src/retry.ts',
          '+++ b/src/retry.ts',
          '@@ -1,3 +1,4 @@',
          ' export function retryAllowed(attempt: number) {',
          '-  return attempt < 2;',
          '+  return Number.isInteger(attempt) && attempt >= 0 && attempt < 3;',
          ' }',
        ].join('\n'),
      }),
    },
    {
      kind: 'message',
      threadId: changesThread,
      message: message('artifact-edit-doc', changesThread, 'system', '', {
        type: 'file_edit',
        agentLabel: 'Synthetic Coder',
        filePath: '/synthetic/anvil-demo/docs/retry.md',
        diff: [
          'diff --git a/docs/retry.md b/docs/retry.md',
          '--- a/docs/retry.md',
          '+++ b/docs/retry.md',
          '@@ -1,2 +1,3 @@',
          ' # Retry policy',
          '+The current revision accepts up to three non-negative attempts.',
          ' Retry only after a transient failure.',
        ].join('\n'),
      }),
    },
    {
      kind: 'message',
      threadId: changesThread,
      message: textEvent(
        'artifact-answer',
        changesThread,
        'artifact-answer-item',
        'Retry handling now rejects negative and non-integer attempts. The docs describe revision 2.',
      ),
    },
  ],
};

function makeLargeTranscript(): ChatReplayScenario {
  const threadId = 'fixture-large-transcript';
  const messages: ChatMessage[] = [];
  const turnCount = 300;
  const codeFence = '```';

  for (let turn = 1; turn <= turnCount; turn += 1) {
    const userText = `Turn ${turn}: inspect the synthetic module and report the next useful action.`;
    const assistantText =
      turn % 25 === 0
        ? `Turn ${turn} is complete.\n\n${codeFence}mermaid\nflowchart LR\n  A[Input ${turn}] --> B[Review ${turn}]\n${codeFence}`
        : turn % 10 === 0
          ? `Turn ${turn} is complete.\n\n${codeFence}ts\nconst checkpoint = ${turn};\n${codeFence}`
          : `Turn ${turn} is complete. The transcript keeps prior context available for review.`;

    messages.push(message(`large-user-${turn}`, threadId, 'user', userText));
    messages.push(message(`large-assistant-${turn}`, threadId, 'assistant', assistantText));
  }

  return {
    id: 'large-transcript',
    title: 'Large transcript (300 turns)',
    description:
      'A deterministic 600-message synthetic transcript for render and input measurements.',
    initialThreadId: threadId,
    threads: [{ id: threadId, title: 'Long transcript' }],
    steps: [{ kind: 'history', threadId, messages }],
  };
}

export const CHAT_REPLAY_SCENARIOS: ChatReplayScenario[] = [
  streamingScenario,
  agentScenario,
  recoveryScenario,
  artifactReviewScenario,
  makeLargeTranscript(),
];

export function getChatReplayScenario(scenarioId: string): ChatReplayScenario {
  const scenario = CHAT_REPLAY_SCENARIOS.find(({ id }) => id === scenarioId);
  if (!scenario) throw new Error(`Unknown synthetic chat replay scenario: ${scenarioId}`);
  return scenario;
}
