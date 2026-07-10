import { describe, expect, it } from 'vitest';
import { buildExecutionStrategyPrompt } from '../execution-strategy';

describe('buildExecutionStrategyPrompt', () => {
  it('does not add orchestration instructions for focused work', () => {
    expect(buildExecutionStrategyPrompt('focused')).toBeNull();
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
