import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../shared/types.js';

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  callAppleFoundationModel: vi.fn(),
}));

vi.mock('../settings.service.js', () => ({ getSettings: mocks.getSettings }));
vi.mock('../apple-foundation-models.service.js', () => ({
  callAppleFoundationModel: mocks.callAppleFoundationModel,
}));

import {
  callPreferredLocalModel,
  getDefaultLocalLlmEndpoint,
  getLocalLlmCapabilities,
} from '../local-llm.service.js';

function localSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    localLlmProvider: 'ollama',
    localLlmEndpoint: '',
    localLlmModel: '',
    ...overrides,
  } as AppSettings;
}

describe('local LLM providers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('only offers Apple Intelligence on macOS', () => {
    const capabilities = getLocalLlmCapabilities();
    expect(capabilities.providers).toContain('ollama');
    expect(capabilities.providers).toContain('lm-studio');
    expect(capabilities.providers.includes('apple')).toBe(process.platform === 'darwin');
  });

  it('uses provider-specific loopback defaults', () => {
    expect(getDefaultLocalLlmEndpoint('ollama')).toBe('http://127.0.0.1:11434/v1');
    expect(getDefaultLocalLlmEndpoint('lm-studio')).toBe('http://127.0.0.1:1234/v1');
  });

  it('auto-detects a model and calls an OpenAI-compatible endpoint', async () => {
    mocks.getSettings.mockReturnValue(
      localSettings({ localLlmEndpoint: 'http://localhost:11434' }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'qwen2.5:7b' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'local response' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(callPreferredLocalModel('Hello', 128)).resolves.toEqual({
      ok: true,
      content: 'local response',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:11434/v1/models',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:11434/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model: 'qwen2.5:7b',
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 128,
          temperature: 0.2,
          stream: false,
        }),
      }),
    );
  });

  it('uses a configured model without listing models first', async () => {
    mocks.getSettings.mockReturnValue(
      localSettings({
        localLlmProvider: 'lm-studio',
        localLlmEndpoint: 'http://127.0.0.1:1234/v1/',
        localLlmModel: 'loaded-model',
      }),
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await callPreferredLocalModel('ping');

    expect(result).toEqual({ ok: true, content: 'pong' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:1234/v1/chat/completions',
      expect.any(Object),
    );
  });
});
