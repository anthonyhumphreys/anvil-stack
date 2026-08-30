import { describe, expect, it } from 'vitest';
import { getSuggestionShortcutClassName } from '../ChatEmptyState';

describe('Chat empty-state suggestion styling', () => {
  it('shows suggestion affordances for both hover and keyboard focus', () => {
    expect(getSuggestionShortcutClassName()).toContain('focus-visible:ring-2');
    expect(getSuggestionShortcutClassName()).toContain('hover:bg-bg-tertiary');
  });
});
