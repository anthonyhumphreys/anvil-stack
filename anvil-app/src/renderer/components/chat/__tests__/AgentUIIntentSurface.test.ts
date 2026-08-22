import { describe, expect, it } from 'vitest';
import { hasQuestionAnswer } from '../AgentUIIntentSurface';

describe('hasQuestionAnswer', () => {
  it('accepts semantic false values and rejects empty required answers', () => {
    expect(hasQuestionAnswer(false)).toBe(true);
    expect(hasQuestionAnswer(['test'])).toBe(true);
    expect(hasQuestionAnswer('  ')).toBe(false);
    expect(hasQuestionAnswer([])).toBe(false);
    expect(hasQuestionAnswer(undefined)).toBe(false);
  });
});
