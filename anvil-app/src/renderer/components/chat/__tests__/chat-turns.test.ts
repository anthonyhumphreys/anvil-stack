import { describe, expect, it } from 'vitest';
import {
  buildApprovalAwareWorkSegments,
  composeChatTurns,
  shouldJoinAssistantSegments,
} from '../chat-turns';

describe('composeChatTurns', () => {
  it('keeps progress and activity subordinate to the final answer', () => {
    const turns = composeChatTurns([
      { kind: 'user', content: 'Ship it' },
      {
        kind: 'assistant',
        content: 'I am checking the release state.',
        itemId: 'progress-1',
        phase: 'progress',
      },
      { kind: 'event', event: { type: 'command_exec', command: 'pnpm test', exitCode: 0 } },
      {
        kind: 'assistant',
        content: 'The release is published.',
        itemId: 'final-1',
        phase: 'final',
      },
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0].user?.content).toBe('Ship it');
    expect(turns[0].work.map((item) => item.kind)).toEqual(['progress', 'event']);
    expect(turns[0].answer?.content).toBe('The release is published.');
    expect(turns[0].trailingWork).toEqual([]);
  });

  it('keeps activity that arrives after the answer below the answer', () => {
    const turns = composeChatTurns([
      { kind: 'user', content: 'Ship it' },
      {
        kind: 'assistant',
        content: 'The release is published.',
        itemId: 'final-1',
        phase: 'final',
      },
      { kind: 'event', event: { type: 'command_exec', command: 'gh pr view', exitCode: 0 } },
      { kind: 'assistant', content: 'Checking the pull request details.', phase: 'progress' },
    ]);

    expect(turns[0].work).toEqual([]);
    expect(turns[0].answer?.content).toBe('The release is published.');
    expect(turns[0].trailingWork).toEqual([
      expect.objectContaining({ kind: 'event', sourceIndex: 2 }),
      expect.objectContaining({
        kind: 'progress',
        content: 'Checking the pull request details.',
        sourceIndex: 3,
      }),
    ]);
  });

  it('does not promote an unknown live segment until the turn completes', () => {
    const entries = [
      { kind: 'user' as const, content: 'Investigate' },
      { kind: 'assistant' as const, content: 'Reading the code.' },
    ];

    expect(composeChatTurns(entries, { active: true })[0]).toMatchObject({ answer: null });
    expect(composeChatTurns(entries)[0].answer?.content).toBe('Reading the code.');
  });

  it('keeps steering messages as visible sub-turns', () => {
    const turns = composeChatTurns([
      { kind: 'user', content: 'Start' },
      { kind: 'assistant', content: 'Working.', phase: 'progress' },
      { kind: 'user', content: 'Use the smaller scope' },
      { kind: 'assistant', content: 'Done.', phase: 'final' },
    ]);

    expect(turns.map((turn) => turn.user?.content)).toEqual(['Start', 'Use the smaller scope']);
    expect(turns[0].work[0]).toMatchObject({ kind: 'progress', content: 'Working.' });
    expect(turns[1].answer?.content).toBe('Done.');
  });

  it('uses persisted message identity for stateful turn keys', () => {
    const [turn] = composeChatTurns([
      { kind: 'user', id: 'message-from-thread-a', content: 'Keep this state in this thread' },
      { kind: 'assistant', id: 'answer-from-thread-a', content: 'Done.', phase: 'final' },
    ]);

    expect(turn.key).toBe('message-from-thread-a');
  });

  it('repairs legacy sentence fragments without flattening complete progress updates', () => {
    const turns = composeChatTurns([
      { kind: 'user', content: 'Deploy it' },
      { kind: 'assistant', content: 'The deployment' },
      { kind: 'event', event: { type: 'tool_call', toolName: 'shell' } },
      { kind: 'assistant', content: ' is progressing normally.' },
      { kind: 'assistant', content: 'The release is now complete.' },
    ]);

    expect(turns[0].work).toEqual([
      { kind: 'progress', content: 'The deployment is progressing normally.', sourceIndex: 3 },
      expect.objectContaining({ kind: 'event' }),
    ]);
    expect(turns[0].answer?.content).toBe('The release is now complete.');
  });

  it('coalesces consecutive reasoning fragments into one trace', () => {
    const turns = composeChatTurns([
      { kind: 'user', content: 'Think out loud' },
      { kind: 'thinking', content: 'First, check the config.' },
      { kind: 'thinking', content: ' It points at staging.' },
      { kind: 'event', event: { type: 'command_exec', command: 'cat config.ts' } },
      { kind: 'thinking', content: 'Now read the file.' },
      { kind: 'assistant', content: 'Found it.', phase: 'final' },
    ]);

    expect(turns[0].work).toEqual([
      {
        kind: 'thinking',
        content: 'First, check the config. It points at staging.',
        sourceIndex: 2,
      },
      expect.objectContaining({ kind: 'event' }),
      { kind: 'thinking', content: 'Now read the file.', sourceIndex: 4 },
    ]);
    expect(turns[0].answer?.content).toBe('Found it.');
  });

  it('drops file_read events — a dead renderer surface (H14)', () => {
    const turns = composeChatTurns([
      { kind: 'user', content: 'Check it' },
      { kind: 'event', event: { type: 'file_read', filePath: 'config.ts' } },
      { kind: 'event', event: { type: 'command_exec', command: 'ls' } },
      { kind: 'assistant', content: 'Done.', phase: 'final' },
    ]);

    expect(turns[0].work).toEqual([
      expect.objectContaining({
        kind: 'event',
        event: expect.objectContaining({ type: 'command_exec' }),
      }),
    ]);
  });

  it('aggregates usage deltas and context snapshots into a per-turn rollup (H5)', () => {
    const turns = composeChatTurns([
      { kind: 'user', content: 'Do work' },
      {
        kind: 'event',
        event: {
          type: 'usage',
          usage: { input: 1000, cachedInput: 200, output: 100 },
          usageId: 'u-1',
          model: 'gpt-5.6-sol',
          usagePrice: {
            provider: 'codex',
            model: 'gpt-5.6-sol',
            input: 2,
            cachedInput: 1,
            output: 8,
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      },
      // Duplicate usageId must not double-count.
      {
        kind: 'event',
        event: {
          type: 'usage',
          usage: { input: 1000, cachedInput: 200, output: 100 },
          usageId: 'u-1',
        },
      },
      {
        kind: 'event',
        event: {
          type: 'usage_context',
          contextUsage: { used: 50_000, size: 200_000 },
          observedCostUsd: 0.0125,
        },
      },
      { kind: 'assistant', content: 'Done.', phase: 'final' },
    ]);

    expect(turns[0].work).toEqual([]);
    expect(turns[0].usage).toEqual({
      inputTokens: 1000,
      cachedInputTokens: 200,
      outputTokens: 100,
      contextUsed: 50_000,
      contextSize: 200_000,
      // (800*2 + 200*1 + 100*8) / 1e6 = 0.0026 priced + 0.0125 observed
      costUsd: expect.closeTo(0.0151, 4),
      model: 'gpt-5.6-sol',
    });
  });

  it('takes the latest context snapshot rather than summing it', () => {
    const turns = composeChatTurns([
      { kind: 'user', content: 'Do work' },
      { kind: 'event', event: { type: 'usage_context', contextUsage: { used: 10, size: 100 } } },
      { kind: 'event', event: { type: 'usage_context', contextUsage: { used: 40, size: 100 } } },
      { kind: 'assistant', content: 'Done.', phase: 'final' },
    ]);

    expect(turns[0].usage?.contextUsed).toBe(40);
    expect(turns[0].usage?.contextSize).toBe(100);
  });

  it('carries the queued delivery marker on the user entry (H2)', () => {
    const turns = composeChatTurns([
      { kind: 'user', content: 'First' },
      { kind: 'assistant', content: 'Working.', phase: 'progress' },
      { kind: 'user', content: 'Follow-up', delivery: 'queued' },
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[1].user?.delivery).toBe('queued');
    expect(turns[1].work).toEqual([]);
    expect(turns[1].answer).toBeNull();
  });

  it('keeps a final answer separate from an untagged trailing progress update', () => {
    const turns = composeChatTurns([
      { kind: 'user', content: 'Deploy it' },
      { kind: 'assistant', content: 'Checking the pipeline', phase: 'progress' },
      { kind: 'assistant', content: 'The release is live.', phase: 'final' },
    ]);

    expect(turns[0].work).toEqual([
      { kind: 'progress', content: 'Checking the pipeline', sourceIndex: 1 },
    ]);
    expect(turns[0].answer?.content).toBe('The release is live.');
  });

  it('falls back to the last assistant segment as the answer for untagged providers', () => {
    const turns = composeChatTurns([
      { kind: 'user', content: 'Summarise' },
      { kind: 'assistant', content: 'Here is the summary.' },
    ]);

    expect(turns[0].answer?.content).toBe('Here is the summary.');
    expect(turns[0].work).toEqual([]);
  });
});

describe('buildApprovalAwareWorkSegments', () => {
  it('keeps routine work and approvals in source order with full details retained', () => {
    const [turn] = composeChatTurns([
      { kind: 'user', content: 'Update the release config' },
      {
        kind: 'assistant',
        content: 'I need to change the version field first.',
        phase: 'progress',
      },
      {
        kind: 'event',
        event: { type: 'file_edit', filePath: 'package.json', diff: '-1.0.0\\n+1.0.1' },
      },
      {
        kind: 'event',
        event: { type: 'approval_request', approvalRequestId: 1, sessionId: 'session-a' },
      },
      { kind: 'assistant', content: 'The package script also needs a change.', phase: 'progress' },
      {
        kind: 'event',
        event: {
          type: 'command_exec',
          command: 'pnpm version patch',
          output: 'Updated package.json',
        },
      },
      {
        kind: 'event',
        event: { type: 'approval_request', approvalRequestId: 2, sessionId: 'session-a' },
      },
      { kind: 'event', event: { type: 'tool_call', toolName: 'verify' } },
    ]);

    const segments = buildApprovalAwareWorkSegments(turn.work);
    expect(segments.map((segment) => segment.kind)).toEqual([
      'routine',
      'approval',
      'routine',
      'approval',
      'routine',
    ]);
    expect(segments.map((segment) => segment.key)).toEqual([
      'work-1',
      'approval-session-a:number:1',
      'work-4',
      'approval-session-a:number:2',
      'work-7',
    ]);
    expect(
      segments.flatMap((segment) =>
        segment.kind === 'routine'
          ? segment.items.map((item) => item.sourceIndex)
          : [segment.item.sourceIndex],
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(segments[0]).toMatchObject({
      kind: 'routine',
      expandedByDefault: true,
      items: [
        { kind: 'progress', content: 'I need to change the version field first.' },
        { kind: 'event', event: { type: 'file_edit', diff: '-1.0.0\\n+1.0.1' } },
      ],
    });
    expect(segments[2]).toMatchObject({
      kind: 'routine',
      expandedByDefault: true,
      items: [
        { kind: 'progress', content: 'The package script also needs a change.' },
        { kind: 'event', event: { type: 'command_exec', output: 'Updated package.json' } },
      ],
    });
    expect(segments[4]).toMatchObject({ kind: 'routine', expandedByDefault: false });
    expect(buildApprovalAwareWorkSegments(turn.work)).toEqual(segments);
  });

  it('keeps unanchored approvals standalone and omits resolved requests without losing work', () => {
    const [turn] = composeChatTurns([
      { kind: 'user', content: 'Make the change' },
      { kind: 'event', event: { type: 'command_exec', command: 'pnpm test', output: 'passed' } },
      {
        kind: 'event',
        event: { type: 'approval_request', approvalRequestId: 'pending', sessionId: 'session-a' },
      },
      {
        kind: 'event',
        event: { type: 'request_resolved', resolvedRequestId: 'pending', sessionId: 'session-a' },
      },
      {
        kind: 'event',
        event: { type: 'approval_request', approvalRequestId: 9, sessionId: 'session-a' },
      },
    ]);

    const segments = buildApprovalAwareWorkSegments(turn.work);
    expect(segments.map((segment) => segment.kind)).toEqual(['routine', 'approval']);
    expect(segments[0]).toMatchObject({
      kind: 'routine',
      expandedByDefault: true,
      items: [{ kind: 'event', event: { type: 'command_exec', output: 'passed' } }],
    });
    expect(segments[1]).toMatchObject({
      kind: 'approval',
      item: { event: { approvalRequestId: 9 } },
    });
  });

  it('keeps approval keys stable when earlier requests are removed', () => {
    const original = composeChatTurns([
      { kind: 'user', content: 'Make two changes' },
      {
        kind: 'event',
        event: { type: 'approval_request', approvalRequestId: 1, sessionId: 'session-a' },
      },
      { kind: 'event', event: { type: 'command_exec', command: 'pnpm test' } },
      {
        kind: 'event',
        event: { type: 'approval_request', approvalRequestId: 2, sessionId: 'session-a' },
      },
      {
        kind: 'event',
        event: { type: 'approval_request', sessionId: 'session-a' },
      },
    ])[0];
    const afterEarlierResolution = composeChatTurns([
      { kind: 'user', content: 'Make two changes' },
      { kind: 'event', event: { type: 'command_exec', command: 'pnpm test' } },
      {
        kind: 'event',
        event: { type: 'approval_request', approvalRequestId: 2, sessionId: 'session-a' },
      },
      {
        kind: 'event',
        event: { type: 'approval_request', sessionId: 'session-a' },
      },
    ])[0];

    const originalKeys = buildApprovalAwareWorkSegments(original.work)
      .filter(
        (segment): segment is Extract<typeof segment, { kind: 'approval' }> =>
          segment.kind === 'approval',
      )
      .map((segment) => segment.key);
    const shiftedKeys = buildApprovalAwareWorkSegments(afterEarlierResolution.work)
      .filter(
        (segment): segment is Extract<typeof segment, { kind: 'approval' }> =>
          segment.kind === 'approval',
      )
      .map((segment) => segment.key);

    expect(originalKeys[1]).toBe(shiftedKeys[0]);
    expect(originalKeys[2]).toBe('approval-session-a-index-4');
    expect(shiftedKeys[1]).toBe('approval-session-a-index-3');
  });
});

describe('shouldJoinAssistantSegments', () => {
  it('uses stable item identity before whitespace heuristics', () => {
    expect(
      shouldJoinAssistantSegments(
        { content: 'First', itemId: 'message-1' },
        { content: ' second', itemId: 'message-1' },
      ),
    ).toBe(true);
    expect(
      shouldJoinAssistantSegments(
        { content: 'First', itemId: 'message-1' },
        { content: ' second', itemId: 'message-2' },
      ),
    ).toBe(false);
  });

  it('does not join segments across phases', () => {
    expect(
      shouldJoinAssistantSegments(
        { content: 'Checking the pipeline', phase: 'progress' },
        { content: 'The release is live.', phase: 'final' },
      ),
    ).toBe(false);
    expect(
      shouldJoinAssistantSegments(
        { content: 'The deployment', phase: 'progress' },
        { content: ' is progressing normally.', phase: 'progress' },
      ),
    ).toBe(true);
  });
});
