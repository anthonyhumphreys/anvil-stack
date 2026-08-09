import { describe, expect, it } from 'vitest';
import type { WorkflowTemplate } from '../../../shared/types';
import { parseWorkflowChatIntent } from '../workflow-chat-intent';

const template: WorkflowTemplate = {
  id: 'review-fix-pr',
  name: 'Review, Fix and PR',
  description: '',
  nodes: [],
  edges: [],
  createdAt: '2026-07-15T00:00:00.000Z',
  updatedAt: '2026-07-15T00:00:00.000Z',
};

describe('parseWorkflowChatIntent', () => {
  it('routes a named saved workflow and keeps the requested job as kickoff', () => {
    expect(
      parseWorkflowChatIntent('Use the Review, Fix and PR workflow to inspect these failing logs', [
        template,
      ]),
    ).toMatchObject({
      kind: 'run',
      template: { id: 'review-fix-pr' },
      kickoff: 'inspect these failing logs',
    });
  });

  it('routes a workflow creation request to dynamic drafting', () => {
    expect(
      parseWorkflowChatIntent('Create a workflow to review logs, fix issues, and open a PR', []),
    ).toMatchObject({ kind: 'draft' });
  });

  it('does not hijack ordinary chat that merely discusses workflow code', () => {
    expect(parseWorkflowChatIntent('Why is this workflow YAML failing?', [template])).toBeNull();
  });
});
