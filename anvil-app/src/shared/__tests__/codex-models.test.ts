import { describe, expect, it } from 'vitest';
import { getCodexModelReasoningOptions, resolveCodexReasoningEffort } from '../codex-models';

describe('Codex model reasoning options', () => {
  it('uses the documented model catalog when CLI metadata is unavailable', () => {
    expect(getCodexModelReasoningOptions('gpt-5.3-codex-spark')).toEqual({
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    });
  });

  it('prefers detected CLI metadata for the selected model', () => {
    expect(
      getCodexModelReasoningOptions('custom-model', [
        {
          id: 'custom-model',
          displayName: 'Custom model',
          supportedReasoningEfforts: ['minimal', 'low'],
          defaultReasoningEffort: 'minimal',
          serviceTiers: [],
        },
      ]),
    ).toEqual({
      defaultReasoningEffort: 'minimal',
      supportedReasoningEfforts: ['minimal', 'low'],
    });
  });

  it('falls back to the model default when the saved effort is unsupported', () => {
    expect(resolveCodexReasoningEffort('gpt-5.3-codex-spark', 'ultra')).toBe('low');
  });
});
