import { describe, expect, it } from 'vitest';
import {
  factoryPreview,
  validateFactoryDefinition,
  validateFactoryWorkflow,
} from '../factory-definition.service.js';
import type { FactoryDefinitionInput } from '../../../shared/factories.js';
import type { WorkflowTemplate } from '../../../shared/types.js';
const definition: FactoryDefinitionInput = {
  name: 'Factory',
  workspaceId: 'ws',
  repoId: 'repo',
  github: { host: 'github.com', owner: 'acme', repo: 'repo', label: 'ready', baseBranch: 'main' },
  workflowTemplateId: 'graph',
  criteria: ['Requirement'],
  checks: ['npm test'],
  postMergeChecks: ['npm test'],
  limits: { repairRounds: 2, maxRunMinutes: 90, maxCommands: 40, maxConcurrentRuns: 1 },
  publication: { enabled: true, draft: true },
  merge: {
    mode: 'human-approved',
    method: 'squash',
    requiredChecks: ['CI'],
    requireApproval: true,
  },
  access: { kind: 'private' },
};
const workflow = {
  id: 'graph',
  name: 'Graph',
  description: '',
  nodes: [
    {
      id: 'code',
      name: 'Implement',
      kind: 'agent',
      provider: 'codex',
      personaId: 'coder',
      model: 'gpt-6.1-sol',
      prompt: 'Implement',
      reasoningEffort: 'medium',
      executionStrategy: 'focused',
      position: { x: 0, y: 0 },
      target: { kind: 'local' },
    },
  ],
  edges: [],
  createdAt: '',
  updatedAt: '',
} as WorkflowTemplate;
describe('factory definition review contract', () => {
  it('binds every criterion to one reviewed check and requires post-merge verification', () => {
    expect(validateFactoryDefinition(definition)).toEqual(definition);
    expect(() => validateFactoryDefinition({ ...definition, checks: [] })).toThrow();
    expect(() => validateFactoryDefinition({ ...definition, postMergeChecks: [] })).toThrow();
    expect(() => validateFactoryDefinition({ ...definition, criteria: ['One', 'Two'] })).toThrow(
      'same order',
    );
  });
  it('rejects invalid roles, sources and unbounded limits', () => {
    for (const change of [
      { github: { ...definition.github, host: 'file:///local' } },
      { github: { ...definition.github, repo: '../outside' } },
      { limits: { ...definition.limits, repairRounds: 99 } },
      {
        access: {
          kind: 'organization',
          organizationId: 'org',
          visibility: 'restricted',
          members: [{ userId: 'user', role: 'admin' }],
        },
      },
    ])
      expect(() => validateFactoryDefinition({ ...definition, ...change })).toThrow();
  });
  it('invalidates reviewed confirmation when policy, graph or account changes', () => {
    const preview = factoryPreview(definition, workflow, 'scope');
    expect(
      factoryPreview(
        { ...definition, merge: { ...definition.merge, mode: 'auto-merge' } },
        workflow,
        'scope',
      ).confirmation,
    ).not.toBe(preview.confirmation);
    expect(
      factoryPreview(
        definition,
        { ...workflow, nodes: workflow.nodes.map((node) => ({ ...node, model: 'other-model' })) },
        'scope',
      ).confirmation,
    ).not.toBe(preview.confirmation);
    expect(factoryPreview(definition, workflow, 'other-account').confirmation).not.toBe(
      preview.confirmation,
    );
  });
  it.each(['cursor', 'devin', 'azure', 'openai', 'llmgateway'])(
    'fails closed for unsupported isolated provider %s',
    (provider) => {
      expect(() =>
        validateFactoryWorkflow({
          ...workflow,
          nodes: workflow.nodes.map((node) => ({ ...node, provider })),
        } as WorkflowTemplate),
      ).toThrow('sandbox isolation');
    },
  );
  it('rejects remote and privileged inline validation worker nodes', () => {
    expect(() =>
      validateFactoryWorkflow({
        ...workflow,
        nodes: workflow.nodes.map((node) => ({
          ...node,
          target: { kind: 'fleet-device', deviceId: 'other' },
        })),
      } as unknown as WorkflowTemplate),
    ).toThrow('isolated local');
    expect(() =>
      validateFactoryWorkflow({
        ...workflow,
        nodes: workflow.nodes.map((node) => ({ ...node, requiresValidation: true })),
      }),
    ).toThrow('independently');
  });
});
