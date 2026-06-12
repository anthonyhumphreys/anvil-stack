import { describe, expect, it } from 'vitest';
import { getSuggestionArrowClassName, getSuggestionCardClassName } from '../ChatEmptyState';

describe('Chat empty-state suggestion styling', () => {
  it('shows suggestion affordances for both hover and keyboard focus', () => {
    expect(getSuggestionCardClassName()).toContain('focus-visible:ring-2');
    expect(getSuggestionCardClassName()).toContain('hover:shadow-md');
    expect(getSuggestionArrowClassName()).toContain('group-hover:opacity-100');
    expect(getSuggestionArrowClassName()).toContain('group-focus-visible:opacity-100');
  });
});
