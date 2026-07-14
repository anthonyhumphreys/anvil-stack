import { describe, expect, it } from 'vitest';
import type { CodexEvent } from '../../../shared/types.js';
import { handleCodexServerLine, type CodexProtocolState } from '../codex-protocol.service.js';

function createState(): CodexProtocolState {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    initialized: true,
  };
}

function collectEvents(state: CodexProtocolState, messages: unknown[]): CodexEvent[] {
  const events: CodexEvent[] = [];

  for (const message of messages) {
    handleCodexServerLine(state, JSON.stringify(message), {
      onEvent: (event) => events.push(event),
    });
  }

  return events;
}

describe('codex protocol service', () => {
  it('preserves agent message item boundaries and normalises phases', () => {
    const events = collectEvents(createState(), [
      {
        method: 'item/started',
        params: {
          item: { id: 'message-1', type: 'agentMessage', phase: 'commentary' },
        },
      },
      {
        method: 'item/agentMessage/delta',
        params: { itemId: 'message-1', delta: 'Checking the tests.' },
      },
      {
        method: 'item/agentMessage/delta',
        params: { itemId: 'message-2', phase: 'final_answer', delta: 'All tests pass.' },
      },
    ]);

    expect(events).toEqual([
      {
        type: 'text',
        text: 'Checking the tests.',
        itemId: 'message-1',
        assistantPhase: 'progress',
      },
      {
        type: 'text',
        text: 'All tests pass.',
        itemId: 'message-2',
        assistantPhase: 'final',
      },
    ]);
  });

  it('keeps legacy agent message deltas compatible when metadata is absent', () => {
    const events = collectEvents(createState(), [
      {
        method: 'codex/event/agent_message_content_delta',
        params: { delta: 'Legacy output' },
      },
    ]);

    expect(events).toEqual([{ type: 'text', text: 'Legacy output' }]);
  });

  it('coalesces repeated file patch updates into one final file edit event', () => {
    const state = createState();
    const events = collectEvents(state, [
      {
        method: 'item/fileChange/patchUpdated',
        params: {
          itemId: 'edit-1',
          changes: [{ path: 'src/app.ts', diff: 'first patch' }],
        },
      },
      {
        method: 'item/fileChange/patchUpdated',
        params: {
          itemId: 'edit-1',
          changes: [{ path: 'src/app.ts', diff: 'second patch' }],
        },
      },
      {
        method: 'item/completed',
        params: {
          item: { id: 'edit-1', type: 'fileChange' },
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: 'file_edit',
        filePath: 'src/app.ts',
        diff: 'second patch',
      },
    ]);
  });

  it('flushes bounded pending file edits when a turn completes', () => {
    const state = createState();
    const longDiff = `diff --git a/big.ts b/big.ts\n${'+x\n'.repeat(80_000)}`;
    const events = collectEvents(state, [
      {
        method: 'item/fileChange/patchUpdated',
        params: {
          itemId: 'edit-1',
          changes: [{ path: 'big.ts', diff: longDiff }],
        },
      },
      {
        method: 'turn/completed',
        params: {},
      },
    ]);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'file_edit',
      filePath: 'big.ts',
    });
    expect(events[0].diff?.length).toBeLessThanOrEqual(120_000);
    expect(events[0].diff).toContain('truncated');
    expect(events[1]).toEqual({ type: 'status', status: 'complete' });
  });

  it('uses the buffered patch when a completed file change only contains paths', () => {
    const state = createState();
    const events = collectEvents(state, [
      {
        method: 'item/fileChange/patchUpdated',
        params: {
          itemId: 'edit-1',
          changes: [{ path: 'src/app.ts', diff: 'latest buffered patch' }],
        },
      },
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'edit-1',
            type: 'fileChange',
            changes: [{ path: 'src/app.ts' }],
          },
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: 'file_edit',
        filePath: 'src/app.ts',
        diff: 'latest buffered patch',
      },
    ]);
  });

  it('bounds large aggregated command output before it reaches the renderer', () => {
    const events = collectEvents(createState(), [
      {
        method: 'item/completed',
        params: {
          item: {
            type: 'commandExecution',
            command: 'npm test',
            aggregatedOutput: 'log\n'.repeat(80_000),
            exitCode: 0,
          },
        },
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'command_exec',
      command: 'npm test',
      exitCode: 0,
    });
    expect(events[0].output?.length).toBeLessThanOrEqual(120_000);
    expect(events[0].output).toContain('truncated');
  });

  it('preserves numeric approval request ids from app-server', () => {
    const events = collectEvents(createState(), [
      {
        id: 61,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'cmd-1',
          command: 'npm test',
          cwd: '/repo',
          reason: 'Needs approval',
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: 'approval_request',
        approvalRequestId: 61,
        approvalKind: 'command',
        approvalReason: 'Needs approval',
        approvalCommand: 'npm test',
        approvalCwd: '/repo',
      },
    ]);
  });

  it('maps plan and goal notifications into structured chat events', () => {
    const events = collectEvents(createState(), [
      {
        method: 'turn/plan/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          explanation: 'Keep the blast radius civilised.',
          plan: [
            { step: 'Trace the protocol event', status: 'completed' },
            { step: 'Render the saved plan', status: 'inProgress' },
          ],
        },
      },
      {
        method: 'thread/goal/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          goal: {
            threadId: 'thread-1',
            objective: 'Ship plan mode support',
            status: 'active',
            tokenBudget: 5000,
            tokensUsed: 1200,
            timeUsedSeconds: 45,
            createdAt: 100,
            updatedAt: 200,
          },
        },
      },
      {
        method: 'thread/goal/cleared',
        params: { threadId: 'thread-1' },
      },
    ]);

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      type: 'plan_update',
      plan: {
        explanation: 'Keep the blast radius civilised.',
        steps: [
          { step: 'Trace the protocol event', status: 'completed' },
          { step: 'Render the saved plan', status: 'in_progress' },
        ],
      },
    });
    expect(events[0].plan?.updatedAt).toEqual(expect.any(String));
    expect(events[1]).toEqual({
      type: 'goal_update',
      goal: {
        objective: 'Ship plan mode support',
        status: 'active',
        tokenBudget: 5000,
        tokensUsed: 1200,
        timeUsedSeconds: 45,
        createdAt: 100,
        updatedAt: 200,
      },
    });
    expect(events[2]).toEqual({ type: 'goal_cleared' });
  });
});
