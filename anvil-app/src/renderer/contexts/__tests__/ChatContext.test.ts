import { describe, expect, it } from 'vitest';
import type { ChatThread } from '../../../shared/types';
import {
  chatMessagesToEntries,
  planIntentToSnapshot,
  shouldSuppressPreparedChatBootstrap,
  threadBelongsToChatList,
  threadBelongsToWorkspace,
  upsertThreadForChatList,
} from '../ChatContext';

describe('chatMessagesToEntries', () => {
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
    ).toEqual([
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
    ).toEqual([]);
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
    ).toEqual([{ kind: 'assistant', content: 'Existing flattened output', id: 'legacy-1' }]);
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

    expect(entries).toEqual([]);
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
        event: { type: 'file_read', filePath: 'src/App.tsx' },
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
    expect(entries[2]).toMatchObject({ kind: 'event', event: { type: 'file_read' } });
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
          workspaceId: 'anvil',
          personaId: 'coder',
          layout: 'classic',
        },
      ),
    ).toBe(false);
  });

  it('keeps classic and work-item thread lists separate within a workspace', () => {
    const classicScope = {
      workspaceId: 'anvil',
      personaId: 'coder',
      layout: 'classic' as const,
    };
    const workItemScope = { ...classicScope, layout: 'workitems' as const };

    expect(
      threadBelongsToChatList({ workspaceId: 'anvil', personaId: 'coder' }, classicScope),
    ).toBe(true);
    expect(
      threadBelongsToChatList(
        {
          workspaceId: 'anvil',
          personaId: 'coder',
          workItemId: 'ANV-1',
        },
        classicScope,
      ),
    ).toBe(false);
    expect(
      threadBelongsToChatList(
        {
          workspaceId: 'anvil',
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
      id: 'anvil-thread',
      workspaceId: 'anvil',
      title: 'Anvil work',
    });
    const readingBridgeThread = buildThread({
      id: 'readingbridge-thread',
      workspaceId: 'readingbridge',
      title: 'ReadingBridge work',
    });
    const current = [visibleThread];

    const next = upsertThreadForChatList(current, readingBridgeThread, {
      workspaceId: 'anvil',
      personaId: 'coder',
      layout: 'classic',
    });

    expect(next).toBe(current);
    expect(next.map((thread) => thread.id)).toEqual(['anvil-thread']);
  });
});

describe('shouldSuppressPreparedChatBootstrap', () => {
  it('does not leave suppression armed when launching with the active persona', () => {
    expect(shouldSuppressPreparedChatBootstrap('coder', 'coder')).toBe(false);
  });

  it('suppresses the bootstrap triggered by an actual persona change', () => {
    expect(shouldSuppressPreparedChatBootstrap('coder', 'architect')).toBe(true);
    expect(shouldSuppressPreparedChatBootstrap(null, 'coder')).toBe(true);
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
