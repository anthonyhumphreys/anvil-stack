import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CarPlayApprovalRequest } from '../../../shared/types.js';

const mocks = vi.hoisted(() => ({
  dbRun: vi.fn(),
  dbAll: vi.fn(() => []),
  resolveApproval: vi.fn(),
  interruptTurn: vi.fn(),
}));

const pendingApproval: CarPlayApprovalRequest = {
  id: 'session-1:request-1',
  sessionId: 'session-1',
  requestKey: 'request-1',
  requestId: 'request-1',
  kind: 'command',
  command: 'pnpm test',
  createdAt: '2026-05-27T10:00:00.000Z',
  title: 'Command approval',
  summary: 'Low-risk check requested by an active agent.',
  requestedAction: 'pnpm test',
  risk: 'low',
  requiresFullReview: false,
  allowedSurfaces: ['desktop', 'mobile', 'carplay'],
  carPlayApprovable: true,
  markedForLater: false,
};

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../db/database.js', () => ({
  getDb: () => ({
    prepare: () => ({
      run: mocks.dbRun,
      all: mocks.dbAll,
    }),
  }),
}));

vi.mock('../settings.service.js', () => ({
  getSettings: () => ({ activeWorkspaceId: 'ws-1' }),
}));

vi.mock('../workspace.service.js', () => ({
  getWorkspace: vi.fn(() => ({
    id: 'ws-1',
    name: 'Launch Control',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
    repos: [],
  })),
  listWorkspaces: vi.fn(() => []),
}));

vi.mock('../companion-events.service.js', () => ({
  emitCompanionEvent: vi.fn(),
  onCompanionEvent: vi.fn(() => () => undefined),
}));

vi.mock('../codex-session.service.js', () => ({
  getCodexSession: vi.fn(),
  interruptTurn: mocks.interruptTurn,
  listActiveCodexSessions: vi.fn(() => []),
  listPendingApprovalRequests: vi.fn(() => [pendingApproval]),
  resolveApproval: mocks.resolveApproval,
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

import {
  approveCarPlayApproval,
  markCarPlayApprovalForLater,
} from '../mobile-companion.service.js';
import { createWorkspaceNote } from '../workspace-notes.service.js';

describe('mobile companion CarPlay actions', () => {
  beforeEach(() => {
    mocks.dbRun.mockClear();
    mocks.dbAll.mockClear();
    mocks.resolveApproval.mockClear();
    mocks.interruptTurn.mockClear();
  });

  it('approves only after the CarPlay policy gate passes', () => {
    approveCarPlayApproval(pendingApproval);

    expect(mocks.resolveApproval).toHaveBeenCalledWith('session-1', 'request-1', 'accept');
  });

  it('does not call approve for unsafe approvals', () => {
    expect(() =>
      approveCarPlayApproval({
        ...pendingApproval,
        command: 'npm install left-pad',
        risk: 'high',
        requiresFullReview: true,
        carPlayApprovable: false,
      }),
    ).toThrow('Requires desktop review');

    expect(mocks.resolveApproval).not.toHaveBeenCalled();
  });

  it('marks approvals for later through the review queue', () => {
    markCarPlayApprovalForLater({
      ...pendingApproval,
      command: 'npm install left-pad',
      risk: 'high',
      requiresFullReview: true,
      carPlayApprovable: false,
    });

    expect(mocks.dbRun).toHaveBeenCalled();
  });

  it('creates parking-lot notes with a CarPlay source', () => {
    const note = createWorkspaceNote({
      workspaceId: 'ws-1',
      body: 'Remember to review the test failure.',
      source: 'carplay',
    });

    expect(note.source).toBe('carplay');
    expect(mocks.dbRun).toHaveBeenCalled();
  });
});
