import type { AgentUIQuestion } from '../../../../shared/agent-ui-intents';
import { describe, expect, it } from 'vitest';
import { hasQuestionAnswer, formatQuestionAnswer } from '../AgentUIIntentSurface';

describe('hasQuestionAnswer', () => {
  it('accepts semantic false values and rejects empty required answers', () => {
    expect(hasQuestionAnswer(false)).toBe(true);
    expect(hasQuestionAnswer(['test'])).toBe(true);
    expect(hasQuestionAnswer('  ')).toBe(false);
    expect(hasQuestionAnswer([])).toBe(false);
    expect(hasQuestionAnswer(undefined)).toBe(false);
  });
});

const question: AgentUIQuestion = {
  id: 'choice',
  kind: 'single_choice',
  question: 'Choose',
  required: true,
  allowCancel: true,
  options: [
    { id: 'a', value: 'compact', label: 'Compact layout' },
    { id: 'b', value: 'roomy', label: 'Roomy layout' },
  ],
};
describe('answer receipts', () => {
  it('shows option labels, custom answers, multiple choices and unanswered values', () => {
    expect(formatQuestionAnswer(question, 'compact')).toBe('Compact layout');
    expect(formatQuestionAnswer(question, 'Custom layout')).toBe('Custom layout');
    expect(formatQuestionAnswer(question, ['compact', 'roomy'])).toBe(
      'Compact layout, Roomy layout',
    );
    expect(formatQuestionAnswer(question, null)).toBe('Not answered');
  });
  it('keeps no as an answer and private answers redacted', () => {
    expect(formatQuestionAnswer({ ...question, kind: 'yes_no' }, false)).toBe('No');
    expect(formatQuestionAnswer({ ...question, kind: 'approval' }, false)).toBe('Rejected');
    expect(formatQuestionAnswer({ ...question, sensitive: true }, '[redacted]')).toBe(
      'Private answer',
    );
  });
});
