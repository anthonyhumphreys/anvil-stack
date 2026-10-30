import { describe, expect, it } from 'vitest';
import type { WorkflowTemplate } from '../../../shared/types';
import { hasExplicitWorkflowCommand, parseWorkflowChatIntent } from '../workflow-chat-intent';

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

  it('routes a direct request to choose and run a workflow', () => {
    expect(parseWorkflowChatIntent('Please run the workflow to inspect these logs', [])).toEqual({
      kind: 'choose',
      kickoff: 'inspect these logs',
    });
  });

  it.each([
    'Why is this workflow YAML failing?',
    'Use the word workflow in the summary',
    'Can you review the workflow UI and use the existing design?',
    'Build a better PR workflow visualiser',
  ])('does not hijack ordinary chat: %s', (message) => {
    expect(hasExplicitWorkflowCommand(message)).toBe(false);
    expect(parseWorkflowChatIntent(message, [template])).toBeNull();
  });
});
