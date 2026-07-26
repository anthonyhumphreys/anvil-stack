import { describe, expect, it } from 'vitest';
import type { CodexCliStatus, CursorCliStatus } from '../../../shared/types';
import { buildChatModelOptions } from '../chat-model-options';

describe('buildChatModelOptions', () => {
  it('uses docs-backed Codex models when the local catalog is unavailable', () => {
    const options = buildChatModelOptions('codex', 'gpt-5.6-sol', null, null);

    expect(options[0]).toMatchObject({
      id: 'gpt-5.6-sol',
      label: '5.6 Sol',
      defaultReasoningEffort: 'medium',
    });
    expect(options[0].supportedReasoningEfforts).toContain('ultra');
  });

  it('uses the local Cursor catalog without pretending reasoning is independent', () => {
    const cursorStatus: CursorCliStatus = {
      installed: true,
      models: [
        {
          id: 'claude-fable-5-thinking-high',
          label: 'Fable 5 1M Thinking High',
        },
      ],
    };

    expect(
      buildChatModelOptions('cursor', 'claude-fable-5-thinking-high', null, cursorStatus),
    ).toEqual([
      {
        id: 'claude-fable-5-thinking-high',
        label: 'Fable 5 1M Thinking High',
        description: 'Detected from the local Cursor CLI model catalog.',
        supportedReasoningEfforts: [],
        defaultReasoningEffort: 'medium',
      },
    ]);
  });

  it('keeps a custom configured model visible when it is absent from the catalog', () => {
    const codexStatus: CodexCliStatus = {
      installed: true,
      models: [],
    };

    const options = buildChatModelOptions('azure', 'deployment-review', codexStatus, null);

    expect(options[0]).toMatchObject({
      id: 'deployment-review',
      label: 'deployment-review',
      description: 'Custom model or deployment selected in Settings.',
    });
    expect(options.some((option) => option.id === 'gpt-5.6-sol')).toBe(true);
  });
});
