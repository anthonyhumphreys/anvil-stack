import { describe, expect, it } from 'vitest';
import { normaliseEnabledLlmProviders } from '../settings.service';

describe('normaliseEnabledLlmProviders', () => {
  it('always keeps the primary provider enabled', () => {
    expect(normaliseEnabledLlmProviders(['cursor'], 'codex')).toEqual(['codex', 'cursor']);
  });

  it('parses persisted providers and removes invalid or duplicate entries', () => {
    expect(
      normaliseEnabledLlmProviders(
        JSON.stringify(['cursor', 'cursor', 'unknown', 'azure']),
        'cursor',
      ),
    ).toEqual(['cursor', 'azure']);
  });

  it('falls back to the primary provider for invalid persisted data', () => {
    expect(normaliseEnabledLlmProviders('{not-json', 'openai')).toEqual(['openai']);
  });

  it('preserves LLMGateway in the provider set', () => {
    expect(normaliseEnabledLlmProviders(['codex', 'llmgateway'], 'llmgateway')).toEqual([
      'llmgateway',
      'codex',
    ]);
  });
});
