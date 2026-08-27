import { describe, expect, it } from 'vitest';
import { getSuggestionCardClassName } from '../ChatEmptyState';

describe('Chat empty-state suggestion styling', () => {
  it('shows suggestion affordances for both hover and keyboard focus', () => {
    expect(getSuggestionCardClassName()).toContain('focus-visible:ring-2');
    expect(getSuggestionCardClassName()).toContain('hover:bg-bg-tertiary');
  });
});
