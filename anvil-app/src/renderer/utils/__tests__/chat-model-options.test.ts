import { describe, expect, it } from 'vitest';
import type {
  CodexCliStatus,
  CursorCliStatus,
  DevinCliStatus,
  LlmGatewayStatus,
} from '../../../shared/types';
import { buildChatModelOptions } from '../chat-model-options';

describe('buildChatModelOptions', () => {
  it('does not invent gateway models or reasoning capabilities when its catalog is unavailable', () => {
    const options = buildChatModelOptions(
      ['llmgateway'],
      'llmgateway',
      'selected-gateway-model',
      null,
      null,
      null,
    );
    expect(options).toEqual([
      expect.objectContaining({
        provider: 'llmgateway',
        id: 'selected-gateway-model',
        supportedReasoningEfforts: [],
      }),
    ]);
    expect(buildChatModelOptions(['llmgateway'], 'llmgateway', '', null, null)).toEqual([]);
  });
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
      expect.objectContaining({
        provider: 'cursor',
        id: 'auto',
        label: 'Auto (Cursor default)',
      }),
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

  it('keeps Cursor selectable as a secondary provider when its catalog is unavailable', () => {
    const options = buildChatModelOptions(['codex', 'cursor'], 'codex', 'gpt-5.6-sol', null, {
      installed: true,
      models: [],
      error: 'Cursor models unavailable',
    });

    expect(options).toContainEqual(
      expect.objectContaining({
        provider: 'cursor',
        id: 'auto',
        label: 'Auto (Cursor default)',
      }),
    );
  });

  it('keeps a custom configured model visible when it is absent from the catalog', () => {
    const codexStatus: CodexCliStatus = {
      installed: true,
      configuredForFoundry: false,
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
      description:
        'Custom model or deployment selected under Settings → Providers & models.',
    });
    expect(options.some((option) => option.id === 'gpt-5.6-sol')).toBe(true);
  });

  it('carries provider-advertised service tiers into the chat model capability', () => {
    const codexStatus: CodexCliStatus = {
      installed: true,
      configuredForFoundry: false,
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

  it('uses the local Devin catalog with an auto option pinned to the detected default', () => {
    const devinStatus: DevinCliStatus = {
      installed: true,
      models: [
        { id: 'swe-2-max', label: 'SWE-2 Max' },
        { id: 'claude-opus-5-high', label: 'Claude Opus 5 High' },
      ],
      defaultModel: 'swe-2-max',
    };

    expect(
      buildChatModelOptions(['devin'], 'devin', 'swe-2-max', null, null, null, devinStatus),
    ).toEqual([
      expect.objectContaining({
        provider: 'devin',
        id: 'auto',
        label: 'Auto (swe-2-max default)',
      }),
      {
        provider: 'devin',
        id: 'swe-2-max',
        label: 'SWE-2 Max',
        description: 'Detected from the local Devin CLI model catalog.',
        supportedReasoningEfforts: [],
        defaultReasoningEffort: 'medium',
        serviceTiers: [],
      },
      {
        provider: 'devin',
        id: 'claude-opus-5-high',
        label: 'Claude Opus 5 High',
        description: 'Detected from the local Devin CLI model catalog.',
        supportedReasoningEfforts: [],
        defaultReasoningEffort: 'medium',
        serviceTiers: [],
      },
    ]);
  });

  it('keeps Devin selectable when its catalog is unavailable', () => {
    const options = buildChatModelOptions(
      ['codex', 'devin'],
      'codex',
      'gpt-5.6-sol',
      null,
      null,
      null,
      {
        installed: false,
        models: [],
      },
    );

    expect(options).toContainEqual(
      expect.objectContaining({
        provider: 'devin',
        id: 'auto',
        label: 'Auto (Devin default)',
      }),
    );
  });

  it('uses LLMGateway models only for the gateway provider', () => {
    const llmGatewayStatus: LlmGatewayStatus = {
      connected: true,
      credentialStatus: 'valid',
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
