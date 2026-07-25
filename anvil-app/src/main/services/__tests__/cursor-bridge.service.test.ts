import { describe, expect, it } from 'vitest';
import { parseCursorModels } from '../cursor-bridge.service';

describe('parseCursorModels', () => {
  it('parses the Cursor CLI model catalog', () => {
    expect(
      parseCursorModels(`Available models

auto - Auto (current, default)
gpt-5.6-sol-high - GPT-5.6 Sol 1M High
claude-fable-5-thinking-high - Fable 5 1M Thinking (NO ZDR)
cursor-grok-4.5-medium - Cursor Grok 4.5 Medium
`),
    ).toEqual([
      { id: 'auto', label: 'Auto (current, default)' },
      { id: 'gpt-5.6-sol-high', label: 'GPT-5.6 Sol 1M High' },
      {
        id: 'claude-fable-5-thinking-high',
        label: 'Fable 5 1M Thinking (NO ZDR)',
      },
      { id: 'cursor-grok-4.5-medium', label: 'Cursor Grok 4.5 Medium' },
    ]);
  });

  it('ignores noise and duplicate model ids', () => {
    expect(parseCursorModels('warning\nmodel-a - Model A\nmodel-a - Again\n')).toEqual([
      { id: 'model-a', label: 'Model A' },
    ]);
  });
});
