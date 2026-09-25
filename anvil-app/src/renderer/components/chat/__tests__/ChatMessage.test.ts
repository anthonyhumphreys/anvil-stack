import { describe, expect, it } from 'vitest';
import {
  buildChatFileReference,
  formatTurnWorkItemSummary,
  shouldCollapseUserMessage,
  shouldShowTurnWorkDetails,
} from '../ChatMessage';

describe('buildChatFileReference', () => {
  it('returns the file path when no line range is available', () => {
    expect(buildChatFileReference('src/main.ts')).toBe('src/main.ts');
  });

  it('appends a line range when available', () => {
    expect(buildChatFileReference('src/main.ts', [12, 24])).toBe('src/main.ts:12-24');
  });

  it('returns null for missing paths', () => {
    expect(buildChatFileReference('')).toBeNull();
  });
});

describe('shouldCollapseUserMessage', () => {
  it('keeps ordinary requests immediately readable', () => {
    expect(shouldCollapseUserMessage('Please review the current changes.')).toBe(false);
  });

  it('progressively discloses large payloads by length or line count', () => {
    expect(shouldCollapseUserMessage('x'.repeat(1_601))).toBe(true);
    expect(
      shouldCollapseUserMessage(Array.from({ length: 25 }, (_, index) => `${index}`).join('\n')),
    ).toBe(true);
  });
});

describe('shouldShowTurnWorkDetails', () => {
  it('keeps live operational detail folded until requested', () => {
    expect(shouldShowTurnWorkDetails(true, null)).toBe(false);
    expect(shouldShowTurnWorkDetails(true, false)).toBe(false);
    expect(shouldShowTurnWorkDetails(true, true)).toBe(true);
  });

  it('folds settled work unless the user has expanded it', () => {
    expect(shouldShowTurnWorkDetails(false, null)).toBe(false);
    expect(shouldShowTurnWorkDetails(false, false)).toBe(false);
    expect(shouldShowTurnWorkDetails(false, true)).toBe(true);
  });
});

describe('formatTurnWorkItemSummary', () => {
  it('keeps a useful progress excerpt visible in the compact work row', () => {
    expect(
      formatTurnWorkItemSummary({
        kind: 'progress',
        content: '**Updated parser** in `src/main/parser.ts`.',
        sourceIndex: 3,
      }),
    ).toBe('Updated parser in src/main/parser.ts.');
  });

  it('summarizes the command that is running', () => {
    expect(
      formatTurnWorkItemSummary({
        kind: 'event',
        event: { type: 'command_exec', command: 'pnpm test -- src/renderer/components/chat' },
        sourceIndex: 7,
      }),
    ).toBe('Running pnpm test -- src/renderer/components/chat');
  });

  it('labels a finished command as completed', () => {
    expect(
      formatTurnWorkItemSummary({
        kind: 'event',
        event: {
          type: 'command_exec',
          command: 'pnpm test',
          exitCode: 0,
        },
        sourceIndex: 8,
      }),
    ).toBe('Completed pnpm test');
  });

  it('shortens long status text without clipping the last word', () => {
    const summary = formatTurnWorkItemSummary({
      kind: 'progress',
      content: 'Updated ' + Array.from({ length: 24 }, (_, index) => `file-${index}`).join(' '),
      sourceIndex: 5,
    });

    expect(summary.length).toBeLessThanOrEqual(110);
    expect(summary.endsWith('…')).toBe(true);
  });
});
