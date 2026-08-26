import { describe, expect, it } from 'vitest';
import type { CodexSession } from '../../../shared/types';
import type { ChatEntry } from '../../contexts/ChatContext';
import { buildExecutionTopology } from '../execution-topology';

describe('buildExecutionTopology', () => {
  it('keeps the thread and current session visible without inventing delegation', () => {
    const sessions: CodexSession[] = [
      {
        id: 'session-1',
        appThreadId: 'thread-1',
        providerThreadId: 'provider-root',
        personaId: 'coder',
        status: 'busy',
        startedAt: '2026-08-10T10:00:00.000Z',
      },
    ];

    const result = buildExecutionTopology({
      entries: [],
      sessions,
      threadId: 'thread-1',
      rootLabel: 'Ship the feature',
    });

    expect(result.delegatedCount).toBe(0);
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'thread', label: 'Ship the feature' }),
        expect.objectContaining({ kind: 'session', label: 'Main agent', status: 'running' }),
      ]),
    );
  });

  it('builds parent-child topology from subagent lifecycle events', () => {
    const entries: ChatEntry[] = [
      {
        kind: 'event',
        event: {
          type: 'subagent_update',
          subagent: {
            id: 'spawn-1',
            kind: 'tool_call',
            tool: 'spawnAgent',
            status: 'inProgress',
            senderThreadId: 'provider-root',
            receiverThreadIds: ['agent-security'],
            prompt: 'Review the auth boundary.',
            model: 'gpt-5.6-sol',
            reasoningEffort: 'high',
            agents: [
              {
                threadId: 'agent-security',
                status: 'running',
                message: 'Checking route authorization.',
              },
            ],
            agentPath: '/root/security_review',
          },
        },
      },
    ];
    const sessions: CodexSession[] = [
      {
        id: 'session-1',
        appThreadId: 'thread-1',
        providerThreadId: 'provider-root',
        personaId: 'coder',
        status: 'busy',
        startedAt: '2026-08-10T10:00:00.000Z',
      },
    ];

    const result = buildExecutionTopology({
      entries,
      sessions,
      threadId: 'thread-1',
      rootLabel: 'Ship the feature',
    });
    const subagent = result.nodes.find((node) => node.kind === 'subagent');

    expect(result.delegatedCount).toBe(1);
    expect(subagent).toMatchObject({
      label: 'security review',
      status: 'running',
      prompt: 'Review the auth boundary.',
      latestMessage: 'Checking route authorization.',
      parentId: 'session:session-1',
    });
    expect(result.runningCount).toBe(2);
  });

  it('does not mark the selected thread as running because another thread is active', () => {
    const result = buildExecutionTopology({
      entries: [],
      sessions: [
        {
          id: 'other-session',
          appThreadId: 'thread-2',
          personaId: 'coder',
          status: 'busy',
          startedAt: '2026-08-10T10:00:00.000Z',
        },
      ],
      threadId: 'thread-1',
      rootLabel: 'Selected thread',
    });

    expect(result.nodes).toEqual([
      expect.objectContaining({ kind: 'thread', status: 'idle', label: 'Selected thread' }),
    ]);
    expect(result.runningCount).toBe(0);
  });
});
