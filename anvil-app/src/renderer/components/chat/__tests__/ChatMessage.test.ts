import { describe, expect, it } from 'vitest';
import {
  buildChatFileReference,
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
  it('keeps live operational detail folded until the user asks for it', () => {
    expect(shouldShowTurnWorkDetails(true, false)).toBe(false);
    expect(shouldShowTurnWorkDetails(true, true)).toBe(true);
  });

  it('folds settled work unless the user has expanded it', () => {
    expect(shouldShowTurnWorkDetails(false, false)).toBe(false);
    expect(shouldShowTurnWorkDetails(false, true)).toBe(true);
  });
});
