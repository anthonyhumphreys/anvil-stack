import type { AgentUIQuestionIntent } from '../../../shared/agent-ui-intents';
import { describe, expect, it } from 'vitest';
import type { ChatThread, Persona } from '../../../shared/types';
import {
  chatMessagesToEntries,
  resolveCompletedAssistantEntries,
  findPersonaForThread,
  planIntentToSnapshot,
  threadBelongsToChatList,
  threadBelongsToWorkspace,
  upsertThreadForChatList,
  updateFollowUpEntry,
} from '../ChatContext';

const personas: Persona[] = [
  {
    id: 'coder',
    name: 'Coder',
    icon: 'code',
    colour: 'blue',
    description: 'Writes code',
    systemPromptTemplate: 'Code',
    capabilities: { canWriteFiles: true, canRunCommands: true, canReadFiles: true },
  },
  {
    id: 'architect',
    name: 'Architect',
    icon: 'blocks',
    colour: 'purple',
    description: 'Shapes systems',
    systemPromptTemplate: 'Architect',
    capabilities: { canWriteFiles: false, canRunCommands: false, canReadFiles: true },
  },
];

describe('findPersonaForThread', () => {
  it('resolves the persona owned by the selected thread', () => {
    expect(findPersonaForThread({ personaId: 'architect' }, personas)?.name).toBe('Architect');
  });

  it('does not substitute another persona for an unavailable owner', () => {
    expect(findPersonaForThread({ personaId: 'reviewer' }, personas)).toBeUndefined();
  });
});

describe('chatMessagesToEntries', () => {
  it('publishes an automatic follow-up as the latest answer after an earlier final reply', () => {
    const entries = resolveCompletedAssistantEntries([
      { kind: 'user', content: 'Delegate a review' },
      { kind: 'assistant', content: 'Awaiting approval.', phase: 'final' },
      { kind: 'event', event: { type: 'turn_outcome', turnOutcome: 'completed' } },
      { kind: 'assistant', content: 'Review finished.' },
    ]);
    expect(entries.at(-1)).toMatchObject({ phase: 'final', content: 'Review finished.' });
    const restored = chatMessagesToEntries([
      { id: 'user', role: 'user', content: 'Delegate a review', timestamp: '1' },
      {
        id: 'first',
        role: 'assistant',
        content: 'Awaiting approval.',
        timestamp: '2',
        event: { type: 'text', text: 'Awaiting approval.', assistantPhase: 'final' },
      },
      {
        id: 'done1',
        role: 'system',
        content: 'Complete',
        timestamp: '3',
        event: { type: 'turn_outcome', turnOutcome: 'completed' },
      },
      {
        id: 'report',
        role: 'assistant',
        content: 'Review finished.',
        timestamp: '4',
        event: { type: 'text', text: 'Review finished.' },
      },
      {
        id: 'done2',
        role: 'system',
        content: 'Complete',
        timestamp: '5',
        event: { type: 'turn_outcome', turnOutcome: 'completed' },
      },
    ]);
    expect(
      restored.find((entry) => entry.kind === 'assistant' && entry.content === 'Review finished.'),
    ).toMatchObject({ phase: 'final' });
  });
  it('restores segmented assistant output and persisted activity', () => {
    expect(
      chatMessagesToEntries([
        {
          id: 'progress-1',
          role: 'system',
          content: 'Checking the tests.',
          timestamp: '2026-07-14T10:00:00.000Z',
          event: {
            type: 'text',
            text: 'Checking the tests.',
            itemId: 'provider-message-1',
            assistantPhase: 'progress',
          },
        },
        {
          id: 'command-1',
          role: 'system',
          content: 'Ran pnpm test',
          timestamp: '2026-07-14T10:00:01.000Z',
          event: { type: 'command_exec', command: 'pnpm test', exitCode: 0 },
        },
        {
          id: 'final-1',
          role: 'assistant',
          content: 'The tests pass.',
          timestamp: '2026-07-14T10:00:02.000Z',
          event: {
            type: 'text',
            text: 'The tests pass.',
            itemId: 'provider-message-2',
            assistantPhase: 'final',
          },
        },
      ]),
    ).toMatchObject([
      {
        kind: 'assistant',
        content: 'Checking the tests.',
        id: 'progress-1',
        itemId: 'provider-message-1',
        phase: 'progress',
      },
      { kind: 'event', event: { type: 'command_exec', command: 'pnpm test', exitCode: 0 } },
      {
        kind: 'assistant',
        content: 'The tests pass.',
        id: 'final-1',
        itemId: 'provider-message-2',
        phase: 'final',
      },
    ]);
  });

  it('does not restore approval and input cards after their requests were resolved', () => {
    expect(
      chatMessagesToEntries([
        {
          id: 'approval',
          role: 'system',
          content: 'Approval needed',
          timestamp: '2026-04-27T10:00:00.000Z',
          event: { type: 'approval_request', approvalRequestId: 7 },
        },
        {
          id: 'input',
          role: 'system',
          content: 'Input needed',
          timestamp: '2026-04-27T10:00:01.000Z',
          event: { type: 'input_request', inputRequestId: 'question-1' },
        },
        {
          id: 'approval-resolved',
          role: 'system',
          content: 'Request resolved',
          timestamp: '2026-04-27T10:00:02.000Z',
          event: { type: 'request_resolved', resolvedRequestId: 7 },
        },
        {
          id: 'input-resolved',
          role: 'system',
          content: 'Request resolved',
          timestamp: '2026-04-27T10:00:03.000Z',
          event: { type: 'request_resolved', resolvedRequestId: 'question-1' },
        },
      ]),
    ).toMatchObject([]);
  });

  it('resolves approval and input requests only within the originating session', () => {
    const entries = chatMessagesToEntries([
      {
        id: 'approval-a',
        role: 'system',
        content: 'Approval needed',
        timestamp: '2026-04-27T10:00:00.000Z',
        sessionId: 'session-a',
        event: { type: 'approval_request', approvalRequestId: 7 },
      },
      {
        id: 'approval-b',
        role: 'system',
        content: 'Approval needed in another session',
        timestamp: '2026-04-27T10:00:01.000Z',
        sessionId: 'session-b',
        event: { type: 'approval_request', approvalRequestId: 7 },
      },
      {
        id: 'resolved-a',
        role: 'system',
        content: 'Request resolved',
        timestamp: '2026-04-27T10:00:02.000Z',
        sessionId: 'session-a',
        event: { type: 'request_resolved', resolvedRequestId: 7 },
      },
    ]);

    expect(entries).toMatchObject([
      {
        kind: 'event',
        event: { type: 'approval_request', approvalRequestId: 7, sessionId: 'session-b' },
      },
    ]);
  });

  it('reconstructs follow-up delivery state by request ID across event ordering and transitions', () => {
    const entries = chatMessagesToEntries([
      {
        id: 'delivery-queued',
        role: 'system',
        content: 'Follow-up queued',
        timestamp: '2026-08-20T10:00:00.000Z',
        sessionId: 'session-1',
        event: {
          type: 'follow_up_delivery',
          followUpRequestId: 'request-1',
          followUpIntent: 'queue',
          followUpStatus: 'queued',
          followUpQueueDepth: 1,
        },
      },
      {
        id: 'request-1',
        role: 'user',
        content: 'Add a summary after the current task',
        timestamp: '2026-08-20T10:00:01.000Z',
        sessionId: 'session-1',
      },
      {
        id: 'delivery-failed',
        role: 'system',
        content: 'Follow-up rejected',
        timestamp: '2026-08-20T10:00:02.000Z',
        sessionId: 'session-1',
        event: {
          type: 'follow_up_delivery',
          followUpRequestId: 'request-1',
          followUpIntent: 'queue',
          followUpStatus: 'failed',
          followUpQueueDepth: 0,
          followUpError: 'The provider rejected the request.',
        },
      },
    ]);

    expect(entries).toMatchObject([
      {
        kind: 'user',
        id: 'request-1',
        requestId: 'request-1',
        content: 'Add a summary after the current task',
        delivery: 'failed',
        deliveryIntent: 'queue',
        deliveryError: 'The provider rejected the request.',
        attachments: undefined,
      },
    ]);
  });

  it('restores explicit failed follow-up results saved on the user row', () => {
    expect(
      chatMessagesToEntries([
        {
          id: 'request-local-failure',
          role: 'user',
          content: 'Explain the current output',
          timestamp: '2026-08-20T10:00:00.000Z',
          sessionId: 'session-1',
          event: {
            type: 'follow_up_delivery',
            followUpRequestId: 'request-local-failure',
            followUpIntent: 'guide',
            followUpStatus: 'failed',
            followUpQueueDepth: 0,
            followUpError: 'Session no longer exists.',
          },
        },
      ]),
    ).toMatchObject([
      {
        kind: 'user',
        id: 'request-local-failure',
        requestId: 'request-local-failure',
        content: 'Explain the current output',
        delivery: 'failed',
        deliveryIntent: 'guide',
        deliveryError: 'Session no longer exists.',
        attachments: undefined,
      },
    ]);
  });

  it('restores persisted thinking events as coalescing reasoning entries', () => {
    expect(
      chatMessagesToEntries([
        {
          id: 'think-1',
          role: 'system',
          content: 'thinking',
          timestamp: '2026-07-14T10:00:00.000Z',
          event: { type: 'thinking', text: 'First, check the config.' },
        },
        {
          id: 'think-2',
          role: 'system',
          content: 'thinking',
          timestamp: '2026-07-14T10:00:01.000Z',
          event: { type: 'thinking', text: ' It points at staging.' },
        },
        {
          id: 'command-1',
          role: 'system',
          content: 'Ran pnpm test',
          timestamp: '2026-07-14T10:00:02.000Z',
          event: { type: 'command_exec', command: 'pnpm test', exitCode: 0 },
        },
      ]),
    ).toMatchObject([
      { kind: 'thinking', content: 'First, check the config. It points at staging.' },
      { kind: 'event', event: { type: 'command_exec', command: 'pnpm test', exitCode: 0 } },
    ]);
  });

  it('keeps legacy flattened assistant history readable', () => {
    expect(
      chatMessagesToEntries([
        {
          id: 'legacy-1',
          role: 'assistant',
          content: 'Existing flattened output',
          timestamp: '2026-07-14T10:00:00.000Z',
        },
      ]),
    ).toMatchObject([{ kind: 'assistant', content: 'Existing flattened output', id: 'legacy-1' }]);
  });

  it('restores the latest intent revision and removes resolved questions', () => {
    const question = {
      protocolVersion: 1 as const,
      id: 'question-1',
      kind: 'question' as const,
      revision: 1,
      scope: { threadId: 'thread-1' },
      lifecycle: 'pending' as const,
      presentation: { collapsed: false, hidden: false },
      payload: {
        questions: [
          {
            id: 'target',
            kind: 'single_choice' as const,
            question: 'Where should this ship?',
            required: true,
            allowCancel: false,
            options: [{ id: 'preview', label: 'Preview', value: 'preview' }],
          },
        ],
      },
      createdAt: '2026-08-19T10:00:00.000Z',
      updatedAt: '2026-08-19T10:00:00.000Z',
    };
    const entries = chatMessagesToEntries([
      {
        id: 'question-created',
        role: 'system',
        content: 'Question',
        timestamp: question.createdAt,
        event: { type: 'agent_ui_intent', agentUIIntent: question },
      },
      {
        id: 'question-updated',
        role: 'system',
        content: 'Question updated',
        timestamp: question.createdAt,
        event: {
          type: 'agent_ui_intent',
          agentUIIntent: {
            ...question,
            revision: 2,
            presentation: { collapsed: true, hidden: false },
          },
        },
      },
      {
        id: 'question-resolved',
        role: 'system',
        content: 'Question resolved',
        timestamp: question.createdAt,
        event: { type: 'agent_ui_intent_resolved', agentUIIntentId: question.id },
      },
    ]);

    expect(entries).toMatchObject([]);
  });

  it('keeps subagent work at its original chronological position while updating its lifecycle', () => {
    const entries = chatMessagesToEntries([
      {
        id: 'user-1',
        role: 'user',
        content: 'Review the layout.',
        timestamp: '2026-08-07T10:00:00.000Z',
      },
      {
        id: 'agent-started',
        role: 'system',
        content: 'Subagent started',
        timestamp: '2026-08-07T10:00:01.000Z',
        event: {
          type: 'subagent_update',
          subagent: {
            id: 'subagent-1',
            kind: 'tool_call',
            tool: 'spawnAgent',
            status: 'inProgress',
            receiverThreadIds: ['thread-1'],
            agents: [{ threadId: 'thread-1', status: 'running' }],
          },
        },
      },
      {
        id: 'command-1',
        role: 'system',
        content: 'Read the file',
        timestamp: '2026-08-07T10:00:02.000Z',
        event: { type: 'command_exec', command: 'cat src/App.tsx', exitCode: 0 },
      },
      {
        id: 'agent-completed',
        role: 'system',
        content: 'Subagent completed',
        timestamp: '2026-08-07T10:00:03.000Z',
        event: {
          type: 'subagent_update',
          subagent: {
            id: 'subagent-1',
            kind: 'tool_call',
            tool: 'spawnAgent',
            status: 'completed',
            receiverThreadIds: ['thread-1'],
            agents: [
              { threadId: 'thread-1', status: 'completed', message: 'Layout audit complete.' },
            ],
          },
        },
      },
    ]);

    expect(entries).toHaveLength(3);
    expect(entries[1]).toMatchObject({
      kind: 'event',
      event: {
        type: 'subagent_update',
        subagent: { id: 'subagent-1', status: 'completed' },
      },
    });
    expect(entries[2]).toMatchObject({ kind: 'event', event: { type: 'command_exec' } });
  });

  it('drops persisted file_read rows — a dead renderer surface (H14)', () => {
    const entries = chatMessagesToEntries([
      {
        id: 'user-1',
        role: 'user',
        content: 'Check the config',
        timestamp: '2026-08-07T10:00:00.000Z',
      },
      {
        id: 'read-1',
        role: 'system',
        content: 'Read config',
        timestamp: '2026-08-07T10:00:01.000Z',
        event: { type: 'file_read', filePath: 'config.ts' },
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'user' });
  });

  it('reconstructs persisted thinking rows as coalescing thinking entries (H11)', () => {
    const entries = chatMessagesToEntries([
      {
        id: 'user-1',
        role: 'user',
        content: 'Think out loud',
        timestamp: '2026-08-07T10:00:00.000Z',
      },
      {
        id: 'think-1',
        role: 'system',
        content: 'First, check the config.',
        timestamp: '2026-08-07T10:00:01.000Z',
        event: { type: 'thinking', text: 'First, check the config.' },
      },
      {
        id: 'think-2',
        role: 'system',
        content: ' It points at staging.',
        timestamp: '2026-08-07T10:00:02.000Z',
        event: { type: 'thinking', text: ' It points at staging.' },
      },
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      kind: 'thinking',
      content: 'First, check the config. It points at staging.',
    });
  });
});

describe('planIntentToSnapshot', () => {
  it('keeps legacy prompt context compatible with richer plan statuses', () => {
    expect(
      planIntentToSnapshot({
        protocolVersion: 1,
        id: 'plan-1',
        kind: 'plan',
        revision: 1,
        scope: { threadId: 'thread-1' },
        lifecycle: 'presented',
        presentation: { collapsed: false, hidden: false },
        payload: {
          planId: 'plan-1',
          title: 'Plan',
          lifecycle: 'active',
          phases: [],
          steps: [
            { id: 'todo', title: 'Todo', status: 'todo' },
            { id: 'blocked', title: 'Blocked', status: 'blocked' },
            { id: 'done', title: 'Done', status: 'done' },
          ],
        },
        createdAt: '2026-08-19T10:00:00.000Z',
        updatedAt: '2026-08-19T10:01:00.000Z',
      }),
    ).toMatchObject({
      steps: [
        { step: 'Todo', status: 'pending' },
        { step: 'Blocked', status: 'in_progress' },
        { step: 'Done', status: 'completed' },
      ],
    });
  });
});

describe('threadBelongsToWorkspace', () => {
  it('matches only the active workspace', () => {
    expect(threadBelongsToWorkspace({ workspaceId: 'workspace-a' }, 'workspace-a')).toBe(true);
    expect(threadBelongsToWorkspace({ workspaceId: 'workspace-b' }, 'workspace-a')).toBe(false);
  });

  it('keeps global and workspace-owned threads separate', () => {
    expect(threadBelongsToWorkspace({}, null)).toBe(true);
    expect(threadBelongsToWorkspace({}, 'workspace-a')).toBe(false);
    expect(threadBelongsToWorkspace({ workspaceId: 'workspace-a' }, null)).toBe(false);
  });
});

describe('threadBelongsToChatList', () => {
  it('rejects threads from another workspace even when they are still receiving updates', () => {
    expect(
      threadBelongsToChatList(
        {
          workspaceId: 'readingbridge',
          personaId: 'coder',
        },
        {
          workspaceId: 'mezair',
          personaId: 'coder',
          layout: 'classic',
        },
      ),
    ).toBe(false);
  });

  it('keeps classic and work-item thread lists separate within a workspace', () => {
    const classicScope = {
      workspaceId: 'mezair',
      personaId: 'coder',
      layout: 'classic' as const,
    };
    const workItemScope = { ...classicScope, layout: 'workitems' as const };

    expect(
      threadBelongsToChatList({ workspaceId: 'mezair', personaId: 'coder' }, classicScope),
    ).toBe(true);
    expect(
      threadBelongsToChatList({ workspaceId: 'mezair', personaId: 'architect' }, classicScope),
    ).toBe(true);
    expect(
      threadBelongsToChatList(
        {
          workspaceId: 'mezair',
          personaId: 'coder',
          workItemId: 'ANV-1',
        },
        classicScope,
      ),
    ).toBe(false);
    expect(
      threadBelongsToChatList(
        {
          workspaceId: 'mezair',
          personaId: 'architect',
          workItemId: 'ANV-1',
        },
        workItemScope,
      ),
    ).toBe(true);
  });
});

describe('upsertThreadForChatList', () => {
  it('does not leak a background update into the visible workspace thread list', () => {
    const visibleThread = buildThread({
      id: 'mezair-thread',
      workspaceId: 'mezair',
      title: 'Mezair work',
    });
    const readingBridgeThread = buildThread({
      id: 'readingbridge-thread',
      workspaceId: 'readingbridge',
      title: 'ReadingBridge work',
    });
    const current = [visibleThread];

    const next = upsertThreadForChatList(current, readingBridgeThread, {
      workspaceId: 'mezair',
      personaId: 'coder',
      layout: 'classic',
    });

    expect(next).toBe(current);
    expect(next.map((thread) => thread.id)).toEqual(['mezair-thread']);
  });
});

function buildThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: 'thread-1',
    personaId: 'coder',
    title: 'Thread',
    repoIds: [],
    createdAt: '2026-07-25T08:00:00.000Z',
    updatedAt: '2026-07-25T08:00:00.000Z',
    messageCount: 0,
    attentionState: 'idle',
    ...overrides,
  };
}

describe('saved answer receipt', () => {
  it('restores one answered question at its original position with the saved answer', () => {
    const timestamp = '2026-10-18T16:00:00.000Z';
    const question: AgentUIQuestionIntent = {
      protocolVersion: 1,
      id: 'saved-question',
      kind: 'question',
      revision: 1,
      scope: { threadId: 'thread-1' },
      lifecycle: 'pending',
      presentation: { collapsed: false, hidden: false },
      createdAt: timestamp,
      updatedAt: timestamp,
      payload: {
        questions: [
          { id: 'layout', kind: 'yes_no', question: 'Compact?', required: true, allowCancel: true },
        ],
      },
    };
    const entries = chatMessagesToEntries([
      {
        id: 'q1',
        role: 'system',
        content: 'Question',
        timestamp,
        event: { type: 'agent_ui_intent', agentUIIntent: question },
      },
      {
        id: 'q2',
        role: 'system',
        content: 'Answered',
        timestamp,
        event: {
          type: 'agent_ui_intent',
          agentUIIntent: {
            ...question,
            revision: 2,
            lifecycle: 'resolved',
            payload: {
              ...question.payload,
              response: { action: 'submit', answers: { layout: false } },
            },
          },
        },
      },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'event',
      event: {
        agentUIIntent: {
          lifecycle: 'resolved',
          payload: { response: { answers: { layout: false } } },
        },
      },
    });
  });
});

describe('queued follow-up ordering', () => {
  it('promotes an accepted queued prompt after the preceding response only once', () => {
    const entries = [
      { kind: 'user' as const, id: 'original', content: 'Build it' },
      {
        kind: 'user' as const,
        id: 'queued',
        requestId: 'queued',
        content: 'Review it',
        delivery: 'queued' as const,
        deliveryIntent: 'queue' as const,
      },
      { kind: 'assistant' as const, content: 'Built.', phase: 'final' as const },
    ];
    const delivered = updateFollowUpEntry(entries, 'queued', { delivery: 'delivered' });
    expect(
      delivered.map((entry) =>
        entry.kind === 'user' ? entry.id : entry.kind === 'assistant' ? entry.content : entry.kind,
      ),
    ).toEqual(['original', 'Built.', 'queued']);
    const responding = [...delivered, { kind: 'assistant' as const, content: 'Reviewing.' }];
    expect(updateFollowUpEntry(responding, 'queued', { delivery: 'delivered' })).toEqual(
      responding,
    );
  });

  it('resolves the executing answer across an unaccepted prompt', () => {
    const entries = resolveCompletedAssistantEntries([
      { kind: 'user', content: 'Build it' },
      { kind: 'assistant', content: 'Built.' },
      { kind: 'user', content: 'Review later', delivery: 'queued', deliveryIntent: 'queue' },
    ]);
    expect(entries[1]).toMatchObject({ phase: 'final' });
  });

  it('reconstructs the same delivery boundary from saved receipts', () => {
    const entries = chatMessagesToEntries([
      { id: 'original', role: 'user', content: 'Build it', timestamp: '2026-10-21T10:00:00Z' },
      { id: 'next', role: 'user', content: 'Review it', timestamp: '2026-10-21T10:00:01Z' },
      {
        id: 'queued',
        role: 'system',
        content: '',
        timestamp: '2026-10-21T10:00:02Z',
        event: {
          type: 'follow_up_delivery',
          followUpRequestId: 'next',
          followUpIntent: 'queue',
          followUpStatus: 'queued',
        },
      },
      { id: 'answer', role: 'assistant', content: 'Built.', timestamp: '2026-10-21T10:00:03Z' },
      {
        id: 'outcome',
        role: 'system',
        content: '',
        timestamp: '2026-10-21T10:00:04Z',
        event: { type: 'turn_outcome', turnOutcome: 'completed' },
      },
      {
        id: 'delivered',
        role: 'system',
        content: '',
        timestamp: '2026-10-21T10:00:05Z',
        event: {
          type: 'follow_up_delivery',
          followUpRequestId: 'next',
          followUpIntent: 'queue',
          followUpStatus: 'delivered',
        },
      },
    ]);
    expect(entries.map((entry) => (entry.kind === 'user' ? entry.id : entry.kind))).toEqual([
      'original',
      'assistant',
      'event',
      'next',
    ]);
    expect(entries[1]).toMatchObject({ content: 'Built.', phase: 'final' });
  });
});
