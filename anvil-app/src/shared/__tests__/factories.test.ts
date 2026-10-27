import { describe, expect, it } from 'vitest';
import {
  factoryRunIdFromWorkerThread,
  factoryWorkerThreadId,
  factoryWorkflowDrift,
  factoryWorkflowIssues,
} from '../factories';
import type { WorkflowTemplate } from '../types';

const template: WorkflowTemplate = {
  id: 'tpl',
  name: 'Plan and build',
  description: '',
  nodes: [
    {
      id: 'plan',
      name: 'Plan',
      prompt: 'Plan it',
      personaId: 'architect',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      executionStrategy: 'focused',
      position: { x: 0, y: 0 },
    },
    {
      id: 'build',
      name: 'Build',
      prompt: 'Build it',
      personaId: 'coder',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
      executionStrategy: 'focused',
      position: { x: 330, y: 0 },
    },
  ],
  edges: [{ id: 'e1', source: 'plan', target: 'build' }],
  createdAt: '',
  updatedAt: '',
};

describe('factory workflow compatibility', () => {
  it('accepts a bounded local Codex graph', () => {
    expect(factoryWorkflowIssues(template)).toEqual([]);
  });

  it('reports each distinct isolation problem once, in enforcement order', () => {
    const issues = factoryWorkflowIssues({
      ...template,
      nodes: [
        { ...template.nodes[0], provider: 'cursor' },
        { ...template.nodes[1], provider: 'cursor', requiresValidation: true },
      ],
    });
    expect(issues).toEqual([
      'Factory workers require a Codex app-server provider with enforced sandbox isolation.',
      'Factory acceptance checks run independently in the controller; remove inline privileged validation from the worker graph.',
    ]);
    expect(factoryWorkflowIssues({ ...template, nodes: [] })[0]).toMatch('bounded');
  });

  it('allows human steps on any provider and rejects remote targets', () => {
    expect(
      factoryWorkflowIssues({
        ...template,
        nodes: [{ ...template.nodes[0], kind: 'human', provider: 'cursor' }],
      }),
    ).toEqual([]);
    expect(
      factoryWorkflowIssues({
        ...template,
        nodes: [{ ...template.nodes[0], target: { kind: 'fleet-device', deviceId: 'x' } }],
      } as unknown as WorkflowTemplate)[0],
    ).toMatch('isolated local');
  });
});

describe('factory workflow drift', () => {
  it('ignores canvas positions, labels and edge ids', () => {
    const moved: WorkflowTemplate = {
      ...structuredClone(template),
      name: 'Renamed',
      updatedAt: 'later',
      nodes: template.nodes.map((node) => ({ ...node, position: { x: 9, y: 9 } })).reverse(),
      edges: [{ id: 'other-id', source: 'plan', target: 'build' }],
    };
    expect(factoryWorkflowDrift(template, moved)).toBe('current');
  });

  it('detects behavioural changes and deleted templates', () => {
    const edited = structuredClone(template);
    edited.nodes[1].model = 'gpt-5.6-sol-mini';
    expect(factoryWorkflowDrift(template, edited)).toBe('changed');
    expect(factoryWorkflowDrift(template, { ...structuredClone(template), edges: [] })).toBe(
      'changed',
    );
    expect(factoryWorkflowDrift(template, null)).toBe('missing');
  });
});

describe('factory worker provenance', () => {
  it('round-trips a run id through its worker thread id', () => {
    expect(factoryRunIdFromWorkerThread(factoryWorkerThreadId('run-42'))).toBe('run-42');
    expect(factoryRunIdFromWorkerThread('chat-thread')).toBeNull();
    expect(factoryRunIdFromWorkerThread(undefined)).toBeNull();
    expect(factoryRunIdFromWorkerThread('factory-worker-')).toBeNull();
  });
});
