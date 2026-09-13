import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock('electron', () => ({ shell: electron }));
const settings = vi.hoisted(() => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
vi.mock('../settings.service.js', () => ({
  getSettings: settings.getSettings,
  updateSettings: settings.updateSettings,
}));

import {
  buildLlmGatewayLoginUrl,
  getLlmGatewayStatus,
  parseLlmGatewayModels,
  resolveLlmGatewayModelConfig,
  startLlmGatewayLogin,
} from '../llm-gateway.service.js';
import { getLlmGatewayCodexConfigArgs } from '../../../shared/llm-gateway.js';

describe('LLMGateway service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

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

  it('configures Codex for gateway auth without OpenAI login or native web search', () => {
    expect(getLlmGatewayCodexConfigArgs()).toEqual(
      expect.arrayContaining([
        'model_providers.llmgateway.requires_openai_auth=false',
        'web_search="disabled"',
      ]),
    );
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

  it('validates stored credentials before reporting a connection', async () => {
    settings.getSettings.mockReturnValue({
      llmGatewayBillingMode: 'devpass',
      llmGatewayApiKey: 'bad',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 401 })));

    await expect(getLlmGatewayStatus()).resolves.toMatchObject({
      connected: false,
      credentialStatus: 'invalid',
      models: [],
    });
  });

  it('keeps a stored credential usable but reports gateway outages separately', async () => {
    settings.getSettings.mockReturnValue({
      llmGatewayBillingMode: 'devpass',
      llmGatewayApiKey: 'stored',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(getLlmGatewayStatus()).resolves.toMatchObject({
      connected: false,
      credentialStatus: 'unavailable',
      error: 'LLMGateway could not be reached.',
    });
    expect(settings.updateSettings).not.toHaveBeenCalled();
  });

  it('requires an active key status in a successful validation response', async () => {
    settings.getSettings.mockReturnValue({
      llmGatewayBillingMode: 'devpass',
      llmGatewayApiKey: 'key',
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: { status: 'inactive' } }), { status: 200 }),
        ),
    );

    await expect(getLlmGatewayStatus()).resolves.toMatchObject({
      connected: false,
      credentialStatus: 'unavailable',
    });
  });

  it('rejects a malformed successful key status response', async () => {
    settings.getSettings.mockReturnValue({
      llmGatewayBillingMode: 'devpass',
      llmGatewayApiKey: 'key',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{not-json', { status: 200 })));

    await expect(getLlmGatewayStatus()).resolves.toMatchObject({
      connected: false,
      credentialStatus: 'unavailable',
      error: 'LLMGateway returned an invalid key status.',
    });
  });

  it('accepts an active key status and loads the model catalog', async () => {
    settings.getSettings.mockReturnValue({
      llmGatewayBillingMode: 'devpass',
      llmGatewayApiKey: 'key',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { label: 'Anvil test key', usage: '0', limit: null, devPlan: 'none' },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ llmgateway: { models: { model: { tool_call: true } } } }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getLlmGatewayStatus(true)).resolves.toMatchObject({
      connected: true,
      credentialStatus: 'valid',
      models: [expect.objectContaining({ id: 'model' })],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/v1/key'),
      expect.any(Object),
    );
  });

  it('keeps the login pending after an invalid callback state', async () => {
    electron.openExternal.mockResolvedValue(undefined);
    settings.getSettings.mockImplementation(() => ({
      llmGatewayBillingMode: 'devpass',
      llmGatewayApiKey: 'new-key',
    }));
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('http://127.0.0.1:')) return realFetch(input, init);
      if (String(input).endsWith('/v1/key')) {
        return new Response(
          JSON.stringify({
            data: { label: 'Anvil test key', usage: '0', limit: null, devPlan: 'none' },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ llmgateway: { models: { model: { tool_call: true } } } }),
        {
          status: 200,
        },
      );
    });

    const login = startLlmGatewayLogin('devpass');
    await vi.waitFor(() => expect(electron.openExternal).toHaveBeenCalledTimes(1));
    const loginUrl = new URL(electron.openExternal.mock.calls[0][0] as string);
    const invalidResponse = await realFetch(loginUrl.searchParams.get('callback')!, {
      headers: { 'x-test-state': 'invalid' },
    });
    expect(invalidResponse.status).toBe(400);
    expect(
      await Promise.race([
        login.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 20)),
      ]),
    ).toBe('pending');

    const callback = loginUrl.searchParams.get('callback')!;
    const validResponse = await realFetch(
      `${callback}?state=${loginUrl.searchParams.get('state')}&key=new-key`,
    );
    expect(validResponse.status).toBe(200);
    expect(await validResponse.text()).toContain('Authorization received');
    await expect(login).resolves.toMatchObject({ connected: true });
  });

  it('resolves only supported reasoning effort for an available catalog model', async () => {
    settings.getSettings.mockReturnValue({ llmGatewayBillingMode: 'payg' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            'llmgateway-providers': {
              models: {
                model: {
                  id: 'model',
                  tool_call: true,
                  reasoning: true,
                  reasoning_options: [{ type: 'effort', values: ['low'] }],
                },
              },
            },
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(resolveLlmGatewayModelConfig('model', 'low')).resolves.toMatchObject({
      model: 'model',
      metadata: { id: 'model' },
      effort: 'low',
    });
    await expect(resolveLlmGatewayModelConfig('model', 'high')).resolves.toMatchObject({
      model: 'model',
      effort: 'low',
    });
  });
});
