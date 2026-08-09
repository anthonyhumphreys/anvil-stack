import { describe, expect, it } from 'vitest';
import { composeChatTurns, shouldJoinAssistantSegments } from '../chat-turns';

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
});
