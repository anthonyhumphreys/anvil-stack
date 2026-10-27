import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../../../../shared/types';
import { displayWorkItemId } from '../WorkItemCard';

const item = (overrides: Partial<WorkItem>): WorkItem => ({
  id: 'https://github.com/acme/widget/issues/42',
  title: 'Example issue',
  type: 'Task',
  state: 'open',
  priority: 0,
  provider: 'github',
  ...overrides,
});

describe('displayWorkItemId', () => {
  it('shows the concise issue number while retaining the canonical URL as its id', () => {
    const githubIssue = item({ extras: { issueNumber: 42 } });

    expect(displayWorkItemId(githubIssue)).toBe('#42');
    expect(githubIssue.id).toBe('https://github.com/acme/widget/issues/42');
  });

  it('preserves the provider id when there is no GitHub issue number', () => {
    expect(displayWorkItemId(item({ provider: 'linear', id: 'ANV-42' }))).toBe('ANV-42');
    expect(displayWorkItemId(item({ extras: { issueNumber: '42' } }))).toBe(
      'https://github.com/acme/widget/issues/42',
    );
  });
});
