import { describe, expect, it } from 'vitest';
import { buildExecutionStrategyPrompt } from '../execution-strategy';

describe('buildExecutionStrategyPrompt', () => {
  it('does not override the normal Codex strategy in auto mode', () => {
    expect(buildExecutionStrategyPrompt('auto')).toBeNull();
  });

  it('keeps work with the primary agent in focused mode', () => {
    const prompt = buildExecutionStrategyPrompt('focused');
    expect(prompt).toContain('Keep work with the primary agent');
    expect(prompt).toContain('propose chat-native delegation');
    expect(prompt).toContain('waiting for user approval');
    expect(prompt).toContain('Do not start provider-native subagents');
  });

  it('asks for bounded subagent work in adaptive mode', () => {
    expect(buildExecutionStrategyPrompt('adaptive')).toContain(
      'Use subagents for concrete, bounded tasks',
    );
  });

  it('makes independent review part of review-team work', () => {
    expect(buildExecutionStrategyPrompt('review-team')).toContain('independent review');
  });
});
