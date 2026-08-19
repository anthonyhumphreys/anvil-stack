import { describe, expect, it } from 'vitest';
import type { ChatModelOption } from '../chat-model-options';
import { resolveChatFastModeTarget } from '../chat-fast-mode';

function option(id: string, serviceTierIds: string[] = []): ChatModelOption {
  return {
    id,
    label: id,
    description: id,
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    serviceTiers: serviceTierIds.map((tierId) => ({ id: tierId, name: tierId })),
  };
}

describe('resolveChatFastModeTarget', () => {
  it('uses the Codex priority tier without changing model', () => {
    expect(
      resolveChatFastModeTarget('codex', 'gpt-5.6-sol', [option('gpt-5.6-sol', ['priority'])]),
    ).toEqual({ available: true, model: 'gpt-5.6-sol', serviceTier: 'priority' });
  });

  it('uses an advertised priority tier for Codex-backed OpenAI connections', () => {
    expect(
      resolveChatFastModeTarget('openai', 'gpt-5.6-sol', [option('gpt-5.6-sol', ['priority'])]),
    ).toEqual({ available: true, model: 'gpt-5.6-sol', serviceTier: 'priority' });
  });

  it('uses the matching Cursor fast variant without changing the selected UI model', () => {
    expect(
      resolveChatFastModeTarget('cursor', 'claude-opus-5-high', [
        option('claude-opus-5-high'),
        option('claude-opus-5-high-fast'),
      ]),
    ).toEqual({
      available: true,
      model: 'claude-opus-5-high-fast',
      serviceTier: null,
    });
  });

  it('reports unavailable when the selected provider model has no fast capability', () => {
    expect(resolveChatFastModeTarget('codex', 'custom', [option('custom')])).toEqual({
      available: false,
      model: 'custom',
      serviceTier: null,
    });
  });
});
