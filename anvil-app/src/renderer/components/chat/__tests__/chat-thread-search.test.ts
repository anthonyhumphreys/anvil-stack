import { describe, expect, it } from 'vitest';
import type { ChatThread } from '../../../../shared/types';
import {
  activeChatThreadStatusFilter,
  filterChatThreads,
  toggleChatThreadStatusFilter,
} from '../chat-thread-search';

const makeThread = (overrides: Partial<ChatThread> = {}): ChatThread => ({
  id: 'thread-1',
  personaId: 'coder',
  title: 'Ship the inbox',
  repoIds: ['repo-1'],
  activeRepoId: 'repo-1',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  messageCount: 1,
  attentionState: 'idle',
  ...overrides,
});

const context = {
  repoNames: new Map([['repo-1', 'Anvil App']]),
  personaNames: new Map([['coder', 'Code Agent']]),
};

describe('filterChatThreads', () => {
  it('combines text, repository, and persona filters case-insensitively', () => {
    const matching = makeThread({ summary: 'Navigation updates' });
    const wrongRepo = makeThread({ id: 'thread-2', repoIds: ['repo-2'], activeRepoId: 'repo-2' });
    const wrongPersona = makeThread({ id: 'thread-3', personaId: 'reviewer' });
    const searchContext = {
      ...context,
      repoNames: new Map([...context.repoNames, ['repo-2', 'Registry']]),
      personaNames: new Map([...context.personaNames, ['reviewer', 'Review Agent']]),
    };

    expect(
      filterChatThreads(
        [matching, wrongRepo, wrongPersona],
        'navigation repo:app persona:code',
        searchContext,
      ),
    ).toEqual([matching]);
  });

  it('filters by real attention, live, and archived states', () => {
    const waiting = makeThread({ id: 'waiting', attentionState: 'input' });
    const working = makeThread({ id: 'working', attentionState: 'idle' });
    const failed = makeThread({ id: 'failed', attentionState: 'failed' });
    const archived = makeThread({ id: 'archived', settledAt: '2026-09-02T10:00:00.000Z' });
    const searchContext = {
      ...context,
      liveThreadStatuses: { working: 'busy' as const },
    };

    expect(
      filterChatThreads([waiting, working, failed, archived], 'status:needs-you', searchContext),
    ).toEqual([waiting]);
    expect(
      filterChatThreads([waiting, working, failed, archived], 'status:working', searchContext),
    ).toEqual([working]);
    expect(
      filterChatThreads([waiting, working, failed, archived], 'status:failed', searchContext),
    ).toEqual([failed]);
    expect(
      filterChatThreads([waiting, working, failed, archived], 'status:archived', searchContext),
    ).toEqual([archived]);
    expect(
      filterChatThreads([waiting, working, failed, archived], 'status:unknown', searchContext),
    ).toEqual([]);
  });
});

describe('quick status filters', () => {
  it('preserves text and scope terms while replacing or clearing the active status', () => {
    const query = 'checkout repo:anvil status:failed';

    expect(activeChatThreadStatusFilter(query)).toBe('failed');
    expect(toggleChatThreadStatusFilter(query, 'working')).toBe(
      'checkout repo:anvil status:working',
    );
    expect(toggleChatThreadStatusFilter(query, 'failed')).toBe('checkout repo:anvil');
  });

  it('does not report a quick filter when multiple statuses are typed', () => {
    expect(activeChatThreadStatusFilter('status:working status:failed')).toBeNull();
  });
});
