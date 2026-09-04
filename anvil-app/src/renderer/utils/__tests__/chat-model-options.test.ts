import { describe, expect, it } from 'vitest';
import type { CodexCliStatus, CursorCliStatus, LlmGatewayStatus } from '../../../shared/types';
import { buildChatModelOptions } from '../chat-model-options';

describe('buildChatModelOptions', () => {
  it('uses docs-backed Codex models when the local catalog is unavailable', () => {
    const options = buildChatModelOptions(['codex'], 'codex', 'gpt-5.6-sol', null, null);

    expect(options[0]).toMatchObject({
      provider: 'codex',
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
      buildChatModelOptions(
        ['cursor'],
        'cursor',
        'claude-fable-5-thinking-high',
        null,
        cursorStatus,
      ),
    ).toEqual([
      {
        provider: 'cursor',
        id: 'claude-fable-5-thinking-high',
        label: 'Fable 5 1M Thinking High',
        description: 'Detected from the local Cursor CLI model catalog.',
        supportedReasoningEfforts: [],
        defaultReasoningEffort: 'medium',
        serviceTiers: [],
      },
    ]);
  });

  it('keeps a custom configured model visible when it is absent from the catalog', () => {
    const codexStatus: CodexCliStatus = {
      installed: true,
      models: [],
    };

    const options = buildChatModelOptions(
      ['azure'],
      'azure',
      'deployment-review',
      codexStatus,
      null,
    );

    expect(options[0]).toMatchObject({
      id: 'deployment-review',
      label: 'deployment-review',
      description: 'Custom model or deployment selected in Settings.',
    });
    expect(options.some((option) => option.id === 'gpt-5.6-sol')).toBe(true);
  });

  it('carries provider-advertised service tiers into the chat model capability', () => {
    const codexStatus: CodexCliStatus = {
      installed: true,
      models: [
        {
          id: 'gpt-5.6-sol',
          displayName: 'GPT-5.6 Sol',
          hidden: false,
          supportedReasoningEfforts: ['low', 'medium', 'high'],
          serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Faster provider service.' }],
        },
      ],
    };

    expect(
      buildChatModelOptions(['codex'], 'codex', 'gpt-5.6-sol', codexStatus, null)[0].serviceTiers,
    ).toEqual([{ id: 'priority', name: 'Fast', description: 'Faster provider service.' }]);
  });

  it('combines models from every enabled provider without assigning models to the wrong driver', () => {
    const cursorStatus: CursorCliStatus = {
      installed: true,
      models: [{ id: 'cursor-auto', label: 'Cursor Auto' }],
    };

    const options = buildChatModelOptions(
      ['codex', 'cursor'],
      'codex',
      'gpt-5.6-sol',
      null,
      cursorStatus,
    );

    expect(
      options.some((option) => option.provider === 'codex' && option.id === 'gpt-5.6-sol'),
    ).toBe(true);
    expect(
      options.some((option) => option.provider === 'cursor' && option.id === 'cursor-auto'),
    ).toBe(true);
    expect(
      options.some((option) => option.provider === 'cursor' && option.id === 'gpt-5.6-sol'),
    ).toBe(false);
  });

  it('uses LLMGateway models only for the gateway provider', () => {
    const llmGatewayStatus: LlmGatewayStatus = {
      connected: true,
      billingMode: 'devpass',
      models: [
        {
          id: 'claude-sonnet-4-6',
          displayName: 'Claude Sonnet 4.6',
          supportedReasoningEfforts: ['low', 'medium', 'high'],
          defaultReasoningEffort: 'medium',
          serviceTiers: [],
        },
      ],
    };

    const options = buildChatModelOptions(
      ['llmgateway'],
      'llmgateway',
      'claude-sonnet-4-6',
      null,
      null,
      llmGatewayStatus,
    );

    expect(options).toEqual([
      expect.objectContaining({
        provider: 'llmgateway',
        id: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
      }),
    ]);
  });
});
