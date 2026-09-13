import { describe, expect, it } from 'vitest';
import { homeSummary } from '../../../mobile/lib/home-summary';
import type { MobileOverview } from '../types';

function overview(): MobileOverview {
  return {
    activeWorkspace: { id: 'a' },
    activeSessions: [
      { id: 'running', workspaceId: 'a', status: 'busy', appThreadId: 'running-thread' },
      { id: 'blocked', workspaceId: 'a', status: 'busy', appThreadId: 'blocked-thread' },
      { id: 'failed', workspaceId: 'a', status: 'error' },
      { id: 'idle', workspaceId: 'a', status: 'ready' },
      { id: 'other', workspaceId: 'b', status: 'busy' },
    ],
    pendingApprovals: [{ sessionId: 'blocked' }],
    workQueue: [
      {
        id: 'approval',
        kind: 'approval',
        sessionId: 'blocked',
        threadId: 'blocked-thread',
        workspaceId: 'a',
      },
      ...['running', 'blocked', 'failed', 'idle'].map((id) => ({
        id,
        sessionId: id,
        kind: 'session',
        workspaceId: 'a',
      })),
      { id: 'other-approval', kind: 'approval', workspaceId: 'b' },
    ],
    threads: [
      { id: 'old', workspaceId: 'a', updatedAt: '2026-09-01' },
      { id: 'new', workspaceId: 'a', updatedAt: '2026-09-05' },
      { id: 'running-thread', workspaceId: 'a', updatedAt: '2026-09-05' },
      { id: 'blocked-thread', workspaceId: 'a', updatedAt: '2026-09-05' },
      { id: 'other-thread', workspaceId: 'b', updatedAt: '2026-09-05' },
    ],
  } as MobileOverview;
}

describe('mobile home summary', () => {
  it('reserves attention for approvals and failed sessions', () => {
    expect(homeSummary(overview()).attention.map((item) => item.id)).toEqual([
      'approval',
      'failed',
    ]);
  });

  it('shows only unblocked running sessions in the active workspace', () => {
    expect(homeSummary(overview()).running.map((session) => session.id)).toEqual(['running']);
  });

  it('sorts recent conversations and excludes threads already shown', () => {
    const data = overview();
    const before = data.threads.map((thread) => thread.id);
    expect(homeSummary(data).recent.map((thread) => thread.id)).toEqual(['new', 'old']);
    expect(data.threads.map((thread) => thread.id)).toEqual(before);
  });

  it('deduplicates a running thread linked only through activeSessionId', () => {
    const data = overview();
    data.activeSessions[0].appThreadId = undefined;
    data.threads[2].activeSessionId = 'running';
    expect(homeSummary(data).recent.map((thread) => thread.id)).toEqual(['new', 'old']);
  });
});
