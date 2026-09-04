import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));
vi.mock('../settings.service.js', () => ({
  getSettings: vi.fn(() => ({ llmGatewayBillingMode: 'devpass' })),
  updateSettings: vi.fn(),
}));

import { buildLlmGatewayLoginUrl, parseLlmGatewayModels } from '../llm-gateway.service.js';

describe('LLMGateway service', () => {
  it('builds a state-bound DevPass browser login URL', () => {
    const url = new URL(
      buildLlmGatewayLoginUrl('http://127.0.0.1:43123/callback', 'state-123', 'devpass'),
    );
    expect(url.origin + url.pathname).toBe('https://llmgateway.io/connect/cli');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      callback: 'http://127.0.0.1:43123/callback',
      state: 'state-123',
      source: 'anvil',
      org: 'devpass',
      name: 'Anvil',
    });
  });

  it('uses the provider-pinned catalog for pay-as-you-go and keeps tool models', () => {
    const models = parseLlmGatewayModels(
      {
        llmgateway: { models: { canonical: { id: 'canonical', tool_call: true } } },
        'llmgateway-providers': {
          models: {
            pinned: {
              id: 'anthropic/claude-sonnet',
              name: 'Claude Sonnet',
              tool_call: true,
              reasoning: true,
              reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
              limit: { context: 200_000, output: 16_000 },
              cost: { input: 3, output: 15 },
            },
            textOnly: { id: 'text-only', tool_call: false },
          },
        },
      },
      'payg',
    );

    expect(models).toEqual([
      expect.objectContaining({
        id: 'anthropic/claude-sonnet',
        supportedReasoningEfforts: ['low', 'high'],
        contextWindow: 200_000,
        inputPrice: 3,
      }),
    ]);
  });
});
