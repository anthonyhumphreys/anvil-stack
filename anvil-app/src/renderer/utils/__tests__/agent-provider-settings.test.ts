import { describe, expect, it } from 'vitest';
import { selectPrimaryAgentProvider } from '../agent-provider-settings';

describe('selectPrimaryAgentProvider', () => {
  it('makes Cursor primary, enables it, and selects its automatic model', () => {
    expect(
      selectPrimaryAgentProvider(
        {
          llmProvider: 'codex',
          enabledLlmProviders: ['codex'],
          openaiModel: 'gpt-5.6-sol',
        },
        'cursor',
      ),
    ).toMatchObject({
      llmProvider: 'cursor',
      enabledLlmProviders: ['cursor', 'codex'],
      openaiModel: 'auto',
    });
  });

  it('keeps a known Cursor model when Cursor becomes primary', () => {
    expect(
      selectPrimaryAgentProvider({ llmProvider: 'codex', openaiModel: 'cursor-pro' }, 'cursor', {
        cursor: ['cursor-pro'],
      }).openaiModel,
    ).toBe('cursor-pro');
  });

  it('selects Devin auto when the current model is not a Devin model', () => {
    expect(
      selectPrimaryAgentProvider({ llmProvider: 'codex', openaiModel: 'gpt-5.6-sol' }, 'devin', {
        devin: ['swe-2-max'],
      }),
    ).toMatchObject({ llmProvider: 'devin', openaiModel: 'auto' });
  });

  it('keeps a known Devin model when Devin becomes primary', () => {
    expect(
      selectPrimaryAgentProvider({ llmProvider: 'codex', openaiModel: 'swe-2-max' }, 'devin', {
        devin: ['swe-2-max'],
      }).openaiModel,
    ).toBe('swe-2-max');
  });

  it('restores the Codex default when leaving Cursor auto', () => {
    expect(
      selectPrimaryAgentProvider(
        { llmProvider: 'cursor', enabledLlmProviders: ['cursor', 'codex'], openaiModel: 'auto' },
        'codex',
      ).openaiModel,
    ).toBe('gpt-5.6-sol');
  });
});
