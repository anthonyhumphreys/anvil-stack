import { describe, expect, it } from 'vitest';
import { buildThreadTitle, summarizePromptTitle } from '../thread-display-title';

describe('thread display titles', () => {
  it('uses the first non-empty prompt line and trims surrounding whitespace', () => {
    expect(summarizePromptTitle('\n  Fix the run button  \nDetails follow.')).toBe(
      'Fix the run button',
    );
  });

  it('truncates long titles even when the first line has no spaces', () => {
    const title = summarizePromptTitle('x'.repeat(80));
    expect(title).toHaveLength(56);
    expect(title?.endsWith('…')).toBe(true);
  });

  it('preserves the existing persona fallback for empty thread prompts', () => {
    expect(buildThreadTitle('  \n ', 'Coder')).toBe('New Coder Thread');
  });
});
