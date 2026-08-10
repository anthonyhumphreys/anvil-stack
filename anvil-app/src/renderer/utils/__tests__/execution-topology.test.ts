import { describe, expect, it } from 'vitest';
import type { CodexSession } from '../../../shared/types';
import type { ChatEntry } from '../../contexts/ChatContext';
import { buildExecutionTopology } from '../execution-topology';

describe('buildExecutionTopology', () => {
  it('keeps the outcome and current session visible without inventing delegation', () => {
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
      rootLabel: 'Ship the outcome',
    });

    expect(result.delegatedCount).toBe(0);
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'outcome', label: 'Ship the outcome' }),
        expect.objectContaining({ kind: 'session', label: 'coder', status: 'running' }),
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
            agents: [{ threadId: 'agent-security', status: 'running' }],
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
      rootLabel: 'Ship the outcome',
    });
    const subagent = result.nodes.find((node) => node.kind === 'subagent');

    expect(result.delegatedCount).toBe(1);
    expect(subagent).toMatchObject({
      label: 'security review',
      status: 'running',
      prompt: 'Review the auth boundary.',
      parentId: 'session:session-1',
    });
  });
});
