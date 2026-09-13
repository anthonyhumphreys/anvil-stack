import { describe, expect, it } from 'vitest';
import type { CodexSession } from '../../../shared/types';
import type { ChatEntry } from '../../contexts/ChatContext';
import { applyExecutionLifecycle, buildExecutionTopology } from '../execution-topology';

describe('buildExecutionTopology', () => {
  it('overlays a terminal provider event over a stale active-session snapshot', () => {
    const states = applyExecutionLifecycle(
      {},
      { type: 'status', status: 'complete', sessionId: 'session-1' },
    );
    const result = buildExecutionTopology({
      entries: [
        {
          kind: 'event',
          event: {
            type: 'subagent_update',
            subagent: {
              id: 'spawn-1',
              kind: 'tool_call',
              tool: 'spawnAgent',
              status: 'inProgress',
              receiverThreadIds: ['agent-1'],
              agents: [{ threadId: 'agent-1', status: 'running', message: 'Inspecting files.' }],
            },
          },
        },
      ],
      sessions: [
        {
          id: 'session-1',
          appThreadId: 'thread-1',
          providerThreadId: 'provider-root',
          personaId: 'coder',
          status: 'busy',
          startedAt: '2026-08-10T10:00:00.000Z',
        },
      ],
      sessionStates: states,
      threadId: 'thread-1',
      rootLabel: 'Ship the feature',
    });

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'session:session-1', status: 'completed' }),
        expect.objectContaining({ id: 'subagent:agent-1', status: 'stopped' }),
      ]),
    );
    expect(result.runningCount).toBe(0);
  });

  const activeSession: CodexSession = {
    id: 'live',
    appThreadId: 'thread',
    providerThreadId: 'parent',
    personaId: 'coder',
    status: 'busy',
    startedAt: '2026-09-09T12:00:00Z',
  };
  const spawn: ChatEntry = {
    kind: 'event',
    event: {
      type: 'subagent_update',
      sessionId: 'live',
      subagent: {
        id: 'spawn',
        kind: 'tool_call',
        tool: 'spawnAgent',
        status: 'inProgress',
        senderThreadId: 'parent',
        receiverThreadIds: ['child'],
        prompt: 'Check cancellation races.',
        agents: [{ threadId: 'child', status: 'running', message: 'Inspecting deferred lookups.' }],
      },
    },
  };
  it.each(['completed', 'failed', 'stopped'] as const)(
    'clears unfinished children when parent is %s despite a stale busy poll',
    (status) => {
      const result = buildExecutionTopology({
        entries: [spawn],
        sessions: [activeSession],
        threadId: 'thread',
        rootLabel: 'Review',
        sessionStates: { live: status },
      });
      expect(result.runningCount).toBe(0);
      expect(result.nodes.find((node) => node.kind === 'subagent')).toMatchObject({
        status: 'stopped',
        prompt: 'Check cancellation races.',
        latestMessage: 'Inspecting deferred lookups.',
      });
      expect(result.nodes.find((node) => node.kind === 'subagent')?.detail).toContain(
        'no final agent update',
      );
    },
  );
  it('does not treat remembered running events as live when the parent is gone', () => {
    const result = buildExecutionTopology({
      entries: [spawn],
      sessions: [],
      threadId: 'thread',
      rootLabel: 'Review',
    });
    expect(result.runningCount).toBe(0);
    expect(result.nodes.find((node) => node.kind === 'subagent')?.status).toBe('idle');
  });
  it('updates an existing agent from activity identity even without receivers', () => {
    const update: ChatEntry = {
      kind: 'event',
      event: {
        type: 'subagent_update',
        subagent: {
          id: 'done',
          kind: 'activity',
          agentThreadId: 'child',
          receiverThreadIds: [],
          agents: [{ threadId: 'child', status: 'completed', message: 'Race checks passed.' }],
        },
      },
    };
    const result = buildExecutionTopology({
      entries: [spawn, update],
      sessions: [activeSession],
      threadId: 'thread',
      rootLabel: 'Review',
    });
    expect(result.delegatedCount).toBe(1);
    expect(result.nodes.find((node) => node.kind === 'subagent')).toMatchObject({
      status: 'completed',
      latestMessage: 'Race checks passed.',
      prompt: 'Check cancellation races.',
    });
    expect(result.runningCount).toBe(1);
  });
  it('does not revive an earlier turn agent when the next user task starts', () => {
    const result = buildExecutionTopology({
      entries: [spawn, { kind: 'user', content: 'Now check the UI.' }],
      sessions: [activeSession],
      threadId: 'thread',
      rootLabel: 'Review',
    });
    expect(result.runningCount).toBe(1);
    expect(result.nodes.find((node) => node.kind === 'subagent')?.status).toBe('idle');
    expect(result.nodes.find((node) => node.kind === 'thread')?.prompt).toBe('Now check the UI.');
  });
  it('keeps interruption terminal through a generic complete event and resets on the next turn', () => {
    const stopped = applyExecutionLifecycle(
      {},
      { type: 'turn_outcome', sessionId: 'live', turnOutcome: 'interrupted' },
    );
    const complete = applyExecutionLifecycle(stopped, {
      type: 'status',
      sessionId: 'live',
      status: 'complete',
    });
    expect(complete.live).toBe('stopped');
    expect(
      applyExecutionLifecycle(complete, { type: 'status', sessionId: 'live', status: 'thinking' })
        .live,
    ).toBe('running');
  });
  it('does not revive a completed agent from a coordinator wait update', () => {
    const complete: ChatEntry = {
      kind: 'event',
      event: {
        type: 'subagent_update',
        subagent: {
          id: 'complete',
          kind: 'activity',
          agentThreadId: 'child',
          receiverThreadIds: [],
          agents: [{ threadId: 'child', status: 'completed' }],
        },
      },
    };
    const wait: ChatEntry = {
      kind: 'event',
      event: {
        type: 'subagent_update',
        subagent: {
          id: 'wait',
          kind: 'tool_call',
          tool: 'wait',
          status: 'inProgress',
          receiverThreadIds: ['child'],
          agents: [],
        },
      },
    };
    const result = buildExecutionTopology({
      entries: [spawn, complete, wait],
      sessions: [activeSession],
      threadId: 'thread',
      rootLabel: 'Review',
    });
    expect(result.nodes.find((node) => node.kind === 'subagent')?.status).toBe('completed');
  });
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
    expect(result.startedAt).toBe('2026-08-10T10:00:00.000Z');
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

  it('uses terminal agent states when the enclosing tool still reports in progress', () => {
    const entries: ChatEntry[] = [
      {
        kind: 'event',
        event: {
          type: 'subagent_update',
          subagent: {
            id: 'wait-1',
            kind: 'tool_call',
            tool: 'wait',
            status: 'inProgress',
            senderThreadId: 'provider-root',
            receiverThreadIds: ['agent-complete', 'agent-interrupted', 'agent-shutdown'],
            agents: [
              { threadId: 'agent-complete', status: 'completed' },
              { threadId: 'agent-interrupted', status: 'interrupted' },
              { threadId: 'agent-shutdown', status: 'shutdown' },
            ],
          },
        },
      },
    ];

    const result = buildExecutionTopology({
      entries,
      sessions: [
        {
          id: 'session-1',
          appThreadId: 'thread-1',
          providerThreadId: 'provider-root',
          personaId: 'coder',
          status: 'ready',
          startedAt: '2026-08-10T10:00:00.000Z',
        },
      ],
      threadId: 'thread-1',
      rootLabel: 'Ship the feature',
    });

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'subagent:agent-complete', status: 'completed' }),
        expect.objectContaining({ id: 'subagent:agent-interrupted', status: 'stopped' }),
        expect.objectContaining({ id: 'subagent:agent-shutdown', status: 'stopped' }),
      ]),
    );
    expect(result.runningCount).toBe(0);
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
    expect(result.startedAt).toBeUndefined();
  });
});
