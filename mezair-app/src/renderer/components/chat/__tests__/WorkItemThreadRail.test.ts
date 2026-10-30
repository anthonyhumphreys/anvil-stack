import { describe, expect, it } from 'vitest';
import type { ChatThread, WorkItem } from '../../../../shared/types';
import {
  groupWorkItemThreads,
  mergeWorkItemsWithOwnedThreads,
  stripWorkItemHtml,
} from '../WorkItemThreadRail';

const makeThread = (overrides: Partial<ChatThread> = {}): ChatThread => ({
  id: 'thread-1',
  personaId: 'coder',
  title: 'Plan the change',
  workItemId: 'ANV-42',
  workItemProvider: 'linear',
  workItemTitle: 'Nest ticket threads',
  repoIds: [],
  createdAt: '2026-08-21T09:00:00.000Z',
  updatedAt: '2026-08-21T09:00:00.000Z',
  messageCount: 0,
  attentionState: 'idle',
  ...overrides,
});

describe('stripWorkItemHtml', () => {
  it('converts common provider HTML into readable plain text', () => {
    expect(
      stripWorkItemHtml(
        '<p>Build the thing<br/>Then test it</p><ul><li>Acceptance &amp; review</li></ul>',
      ),
    ).toBe('Build the thing\nThen test it\n- Acceptance & review');
  });
});

describe('ticket thread ownership', () => {
  it('keeps every live and archived thread under the owning work item', () => {
    const live = makeThread();
    const archived = makeThread({
      id: 'thread-2',
      title: 'Review the result',
      settledAt: '2026-08-21T10:00:00.000Z',
    });

    expect(groupWorkItemThreads([live, archived]).get('linear:ANV-42')).toEqual([live, archived]);
  });

  it('retains ticket groups that fall outside the current provider filters', () => {
    const currentItem: WorkItem = {
      id: 'ANV-1',
      title: 'Current item',
      type: 'Feature',
      state: 'In Progress',
      priority: 1,
      provider: 'linear',
    };

    expect(mergeWorkItemsWithOwnedThreads([currentItem], [makeThread()])).toEqual([
      currentItem,
      {
        id: 'ANV-42',
        title: 'Nest ticket threads',
        type: 'Task',
        state: 'Outside current view',
        priority: 0,
        provider: 'linear',
      },
    ]);
  });
});
