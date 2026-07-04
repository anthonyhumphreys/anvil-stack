import { describe, expect, it, vi } from 'vitest';
import type { MobileOverview } from '../../../shared/types.js';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../db/database.js', () => ({
  getDb: () => {
    throw new Error('Database should not be used by workflow digest tests');
  },
}));

vi.mock('../settings.service.js', () => ({
  getSettings: () => ({}),
}));

vi.mock('../workspace.service.js', () => ({
  getWorkspace: vi.fn(),
  listWorkspaces: vi.fn(() => []),
}));

vi.mock('../companion-events.service.js', () => ({
  emitCompanionEvent: vi.fn(),
  onCompanionEvent: vi.fn(() => () => undefined),
}));

vi.mock('../codex-session.service.js', () => ({
  getCodexSession: vi.fn(),
  interruptTurn: vi.fn(),
  listActiveCodexSessions: vi.fn(() => []),
  listPendingApprovalRequests: vi.fn(() => []),
  resolveApproval: vi.fn(),
  sendMessage: vi.fn(),
  startSession: vi.fn(),
}));

vi.mock('../chat-persistence.service.js', () => ({
  createChatSession: vi.fn(),
  createChatThread: vi.fn(),
  deleteChatThread: vi.fn(),
  getChatThread: vi.fn(),
  loadChatHistory: vi.fn(() => []),
  saveChatEntry: vi.fn(),
}));

import { buildMobileWorkQueue, buildWorkflowDigest } from '../mobile-companion.service.js';

const workspace = {
  id: 'ws-1',
  name: 'Launch Control',
  createdAt: '2026-05-26T10:00:00.000Z',
  updatedAt: '2026-05-26T10:00:00.000Z',
  repos: [
    {
      id: 'repo-1',
      name: 'anvil',
      path: '/tmp/anvil',
      defaultBranch: 'main',
      languages: [],
      status: 'indexed',
      fileCount: 42,
      branchCount: 3,
    },
  ],
} as MobileOverview['activeWorkspace'];

describe('mobile companion workflow digest', () => {
  it('marks an unselected workspace as unconfigured', () => {
    const digest = buildWorkflowDigest(undefined, [], [], []);

    expect(digest.health).toBe('unconfigured');
    expect(digest.headline).toBe('No active workspace');
    expect(digest.counts.workspaceRepos).toBe(0);
  });

  it('prioritises pending approvals over busy sessions', () => {
    const digest = buildWorkflowDigest(
      workspace,
      [
        {
          id: 'session-1',
          personaId: 'coder',
          status: 'busy',
          startedAt: '2026-05-26T10:00:00.000Z',
        },
      ],
      [
        {
          sessionId: 'session-1',
          requestKey: 'approval-1',
          requestId: 'approval-1',
          kind: 'command',
          createdAt: '2026-05-26T10:01:00.000Z',
        },
      ],
      [],
    );

    expect(digest.health).toBe('needs-approval');
    expect(digest.counts.pendingApprovals).toBe(1);
    expect(digest.counts.busySessions).toBe(1);
  });

  it('reports busy and idle workspace states for remote launch surfaces', () => {
    const busyDigest = buildWorkflowDigest(
      workspace,
      [
        {
          id: 'session-1',
          personaId: 'coder',
          status: 'busy',
          startedAt: '2026-05-26T10:00:00.000Z',
        },
      ],
      [],
      [],
    );
    const idleDigest = buildWorkflowDigest(workspace, [], [], []);

    expect(busyDigest.health).toBe('busy');
    expect(idleDigest.health).toBe('idle');
    expect(idleDigest.headline).toBe('Ready to launch');
  });
});

describe('mobile companion work queue', () => {
  it('puts policy-aware approvals ahead of running sessions', () => {
    const queue = buildMobileWorkQueue(
      workspace,
      [
        {
          id: 'session-1',
          repoId: 'repo-1',
          workspaceId: 'ws-1',
          personaId: 'coder',
          status: 'busy',
          startedAt: '2026-05-26T10:00:00.000Z',
          appThreadId: 'thread-1',
        },
      ],
      [
        {
          sessionId: 'session-1',
          requestKey: 'approval-1',
          requestId: 'approval-1',
          kind: 'command',
          command: 'rm -rf dist',
          createdAt: '2026-05-26T10:01:00.000Z',
          workspaceId: 'ws-1',
          workspaceName: 'Launch Control',
          repoId: 'repo-1',
          repoName: 'anvil',
        },
      ],
      [
        {
          id: 'thread-1',
          personaId: 'coder',
          title: 'Release check',
          workspaceId: 'ws-1',
          preview: 'Checking the release.',
          messageCount: 2,
          updatedAt: '2026-05-26T10:02:00.000Z',
          activeSessionId: 'session-1',
          activeSessionStatus: 'busy',
          pendingApprovalCount: 1,
        },
      ],
    );

    expect(queue[0]).toMatchObject({
      kind: 'approval',
      priority: 'critical',
      statusLabel: 'Desktop review',
      repoName: 'anvil',
      requiresDesktopReview: true,
    });
    expect(queue[1]).toMatchObject({
      kind: 'session',
      title: 'Release check',
      statusLabel: 'Blocked',
    });
  });

  it('keeps recent inactive threads behind active work', () => {
    const queue = buildMobileWorkQueue(
      workspace,
      [
        {
          id: 'session-1',
          repoId: 'repo-1',
          workspaceId: 'ws-1',
          personaId: 'coder',
          status: 'ready',
          startedAt: '2026-05-26T10:00:00.000Z',
          appThreadId: 'thread-1',
        },
      ],
      [],
      [
        {
          id: 'thread-1',
          personaId: 'coder',
          title: 'Ready session',
          workspaceId: 'ws-1',
          messageCount: 3,
          updatedAt: '2026-05-26T10:03:00.000Z',
          activeSessionId: 'session-1',
          activeSessionStatus: 'ready',
          pendingApprovalCount: 0,
        },
        {
          id: 'thread-2',
          personaId: 'reviewer',
          title: 'Yesterday review',
          workspaceId: 'ws-1',
          preview: 'No findings.',
          messageCount: 4,
          updatedAt: '2026-05-26T09:00:00.000Z',
          pendingApprovalCount: 0,
        },
      ],
    );

    expect(queue.map((item) => item.kind)).toEqual(['session', 'thread']);
    expect(queue[1]).toMatchObject({
      title: 'Yesterday review',
      statusLabel: 'Recent',
      actionLabel: 'Continue',
    });
  });
});
