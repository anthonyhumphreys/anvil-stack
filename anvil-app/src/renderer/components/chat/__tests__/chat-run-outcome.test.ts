import { describe, expect, it } from 'vitest';
import type { CodexEvent } from '../../../../shared/types';
import { composeChatTurns } from '../chat-turns';
import {
  buildChatRequestTargetDomId,
  getChatQuestionTargetId,
  getPendingQuestionTarget,
  summarizeChatTurnRun,
} from '../chat-run-outcome';

function event(event: CodexEvent) {
  return { kind: 'event' as const, event };
}

describe('chat run outcome', () => {
  it('shows a completed provider run and keeps command evidence separate from its answer', () => {
    const [turn] = composeChatTurns([
      { kind: 'user', content: 'Run the checks' },
      event({ type: 'command_exec', command: 'pnpm test', exitCode: 0, output: '42 passed' }),
      event({ type: 'turn_outcome', turnOutcome: 'completed' }),
      { kind: 'assistant', content: 'The checks passed.', phase: 'final' },
    ]);

    expect(turn.runOutcome).toBe('completed');
    expect(turn.work.map((item) => item.kind)).toEqual(['event']);
    expect(summarizeChatTurnRun(turn)).toMatchObject({
      state: 'completed',
      title: 'Run finished',
      commands: [{ command: 'pnpm test', exitCode: 0, output: '42 passed' }],
      nextAction: 'Read the response and follow up if needed.',
    });
  });

  it('marks a failed turn and does not hide a non-zero command result', () => {
    const [turn] = composeChatTurns([
      { kind: 'user', content: 'Build' },
      event({ type: 'command_exec', command: 'pnpm build', exitCode: 2 }),
      event({ type: 'turn_outcome', turnOutcome: 'failed' }),
      event({ type: 'status', status: 'error', errorMessage: 'Build failed' }),
    ]);

    expect(summarizeChatTurnRun(turn)).toMatchObject({
      state: 'failed',
      title: 'Run failed',
      commands: [{ command: 'pnpm build', exitCode: 2 }],
      nextAction: 'Inspect the error or failed command, then retry if appropriate.',
    });
  });

  it('labels interruption as stopped and incomplete', () => {
    const [turn] = composeChatTurns([
      { kind: 'user', content: 'Make the change' },
      event({ type: 'turn_outcome', turnOutcome: 'interrupted' }),
    ]);

    expect(summarizeChatTurnRun(turn)).toMatchObject({
      state: 'stopped',
      title: 'Run stopped',
      nextAction: 'Review partial changes, then continue or retry the request.',
    });
  });

  it('labels a response without provider outcome as ended with unknown task status', () => {
    const [turn] = composeChatTurns([
      { kind: 'user', content: 'Review this' },
      event({ type: 'status', status: 'complete' }),
      { kind: 'assistant', content: 'Looks good.', phase: 'final' },
    ]);

    expect(summarizeChatTurnRun(turn)).toMatchObject({
      state: 'response-ended',
      title: 'Response ended',
      nextAction: 'The run outcome was not reported; review the response and observed activity.',
    });
  });

  it('does not treat persisted in-progress evidence as a completed or live run when idle', () => {
    const [turn] = composeChatTurns([
      { kind: 'user', content: 'Review this' },
      event({ type: 'turn_outcome', turnOutcome: 'inProgress' }),
    ]);

    expect(summarizeChatTurnRun(turn)).toMatchObject({
      state: 'response-ended',
      title: 'Response ended',
      nextAction: 'The run outcome was not reported; review the response and observed activity.',
    });
    expect(summarizeChatTurnRun(turn, { busy: true })).toBeNull();
  });

  it('surfaces an unresolved user request and resolves it across turns', () => {
    const turns = composeChatTurns([
      { kind: 'user', content: 'Pick an option' },
      event({
        type: 'input_request',
        inputRequestId: 12,
        sessionId: 'session-a',
        inputRequest: {
          kind: 'user_input',
          questions: [
            {
              id: 'choice',
              header: 'Choice',
              question: 'Which option should I use?',
              isOther: false,
              isSecret: false,
            },
          ],
        },
      }),
      event({ type: 'turn_outcome', turnOutcome: 'inProgress' }),
    ]);

    const pending = getPendingQuestionTarget(turns);
    expect(pending).toMatchObject({
      id: 'input:session-a:number:12',
      kind: 'input',
      label: 'Which option should I use?',
    });
    expect(summarizeChatTurnRun(turns[0], { pendingTarget: pending })).toMatchObject({
      state: 'awaiting-user',
      title: 'Your input is needed',
    });

    const resolvedTurns = composeChatTurns([
      { kind: 'user', content: 'Pick an option' },
      event({
        type: 'input_request',
        inputRequestId: 12,
        sessionId: 'session-a',
        inputRequest: { kind: 'user_input' },
      }),
      { kind: 'user', content: 'Use option A' },
      event({ type: 'request_resolved', resolvedRequestId: 12, sessionId: 'session-a' }),
    ]);
    expect(getPendingQuestionTarget(resolvedTurns)).toBeNull();
  });

  it('gives request target ids stable, HTML-safe DOM ids without conflating JSON-RPC id types', () => {
    const numericId = getChatQuestionTargetId({
      type: 'approval_request',
      approvalRequestId: 4,
      sessionId: 'session-a',
    });
    const stringId = getChatQuestionTargetId({
      type: 'approval_request',
      approvalRequestId: '4',
      sessionId: 'session-a',
    });

    expect(numericId).toBe('approval:session-a:number:4');
    expect(stringId).toBe('approval:session-a:string:4');
    expect(buildChatRequestTargetDomId(numericId!)).toBe(buildChatRequestTargetDomId(numericId!));
    expect(buildChatRequestTargetDomId(numericId!)).not.toBe(
      buildChatRequestTargetDomId(stringId!),
    );
  });
});
