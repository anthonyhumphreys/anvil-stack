import { describe, expect, it } from 'vitest';
import { buildChatFileReference } from '../ChatMessage';

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
