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

import { buildWorkflowDigest } from '../mobile-companion.service.js';

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
