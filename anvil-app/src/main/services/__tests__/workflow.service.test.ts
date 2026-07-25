import { describe, expect, it } from 'vitest';
import type { WorkflowNode } from '../../../shared/types';
import {
  buildCodexWorkflowArgs,
  normaliseWorkflowNodes,
  validateWorkflowGraph,
} from '../workflow.service';

function node(id: string): WorkflowNode {
  return {
    id,
    name: id,
    prompt: `Run ${id}`,
    personaId: 'coder',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'medium',
    executionStrategy: 'adaptive',
    position: { x: 0, y: 0 },
  };
}

describe('validateWorkflowGraph', () => {
  it('accepts branching and merging DAGs', () => {
    expect(() =>
      validateWorkflowGraph(
        [node('start'), node('review'), node('test'), node('merge')],
        [
          { id: 'a', source: 'start', target: 'review' },
          { id: 'b', source: 'start', target: 'test' },
          { id: 'c', source: 'review', target: 'merge' },
          { id: 'd', source: 'test', target: 'merge' },
        ],
      ),
    ).not.toThrow();
  });

  it('rejects cycles before execution', () => {
    expect(() =>
      validateWorkflowGraph(
        [node('a'), node('b')],
        [
          { id: 'a-b', source: 'a', target: 'b' },
          { id: 'b-a', source: 'b', target: 'a' },
        ],
      ),
    ).toThrow('cycles');
  });
});

describe('normaliseWorkflowNodes', () => {
  it('keeps legacy workflows on Codex', () => {
    expect(normaliseWorkflowNodes([node('legacy')])[0].provider).toBe('codex');
  });

  it('preserves an explicit enabled provider identity', () => {
    expect(normaliseWorkflowNodes([{ ...node('review'), provider: 'cursor' }])[0].provider).toBe(
      'cursor',
    );
  });
});

describe('workflow provider routing', () => {
  it('selects the configured Codex model provider for Azure and OpenAI steps', () => {
    expect(buildCodexWorkflowArgs('codex')).toEqual(['app-server']);
    expect(buildCodexWorkflowArgs('azure')).toEqual(['app-server', '-c', 'model_provider="azure"']);
    expect(buildCodexWorkflowArgs('openai')).toEqual([
      'app-server',
      '-c',
      'model_provider="openai"',
    ]);
  });
});
