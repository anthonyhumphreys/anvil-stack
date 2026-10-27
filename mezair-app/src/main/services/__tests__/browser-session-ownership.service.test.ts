import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  interruptTurn: vi.fn(),
  stopSession: vi.fn(),
}));

vi.mock('../codex-session.service.js', () => ({
  interruptTurn: mocks.interruptTurn,
  stopSession: mocks.stopSession,
}));

import {
  beginBrowserWorkspaceTurn,
  finishBrowserWorkspaceTurn,
  interruptBrowserWorkspaceTurnsAbove,
  listBrowserWorkspaceOwnedSessionsForTests,
  refreshBrowserWorkspaceGrantReferences,
  registerBrowserWorkspaceSession,
  resetBrowserSessionOwnershipForTests,
  revokeBrowserWorkspaceGrant,
  revokeBrowserWorkspaceTrust,
} from '../browser-session-ownership.service.js';

describe('browser session grant ownership', () => {
  beforeEach(() => {
    resetBrowserSessionOwnershipForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetBrowserSessionOwnershipForTests();
    vi.useRealTimers();
  });

  it('keeps a browser session and active turn alive across a renewed sibling grant', () => {
    registerBrowserWorkspaceSession({
      sessionId: 'session-a',
      workspaceId: 'workspace-a',
      grantId: 'grant-old',
      trustId: 'trust-a',
      expiresAt: Date.now() + 60_000,
      startedByBrowser: true,
    });
    beginBrowserWorkspaceTurn({
      sessionId: 'session-a',
      grantId: 'grant-old',
      trustId: 'trust-a',
      expiresAt: Date.now() + 60_000,
      permissionMode: 'workspace-auto',
    });

    refreshBrowserWorkspaceGrantReferences([
      { grantId: 'grant-renewed', trustId: 'trust-a', expiresAt: Date.now() + 120_000 },
    ]);
    revokeBrowserWorkspaceGrant('grant-old');

    expect(mocks.interruptTurn).not.toHaveBeenCalled();
    expect(mocks.stopSession).not.toHaveBeenCalled();
    expect(listBrowserWorkspaceOwnedSessionsForTests()).toEqual(['session-a']);

    revokeBrowserWorkspaceTrust('trust-a');
    expect(mocks.interruptTurn).toHaveBeenCalledWith('session-a');
    expect(mocks.stopSession).toHaveBeenCalledWith('session-a');
    expect(listBrowserWorkspaceOwnedSessionsForTests()).toEqual([]);
  });

  it('interrupts a revoked browser turn and stops its unreferenced browser-created process', () => {
    registerBrowserWorkspaceSession({
      sessionId: 'session-b',
      workspaceId: 'workspace-a',
      grantId: 'grant-b',
      expiresAt: Date.now() + 60_000,
      startedByBrowser: true,
    });
    beginBrowserWorkspaceTurn({
      sessionId: 'session-b',
      grantId: 'grant-b',
      expiresAt: Date.now() + 60_000,
      permissionMode: 'full-access',
    });

    revokeBrowserWorkspaceGrant('grant-b');

    expect(mocks.interruptTurn).toHaveBeenCalledWith('session-b');
    expect(mocks.stopSession).toHaveBeenCalledWith('session-b');
    expect(listBrowserWorkspaceOwnedSessionsForTests()).toEqual([]);
  });

  it('never stops an adopted Desktop process when its browser grant is revoked', () => {
    registerBrowserWorkspaceSession({
      sessionId: 'desktop-session',
      workspaceId: 'workspace-a',
      grantId: 'grant-c',
      expiresAt: Date.now() + 60_000,
      startedByBrowser: false,
    });
    beginBrowserWorkspaceTurn({
      sessionId: 'desktop-session',
      grantId: 'grant-c',
      expiresAt: Date.now() + 60_000,
      permissionMode: 'workspace-auto',
    });

    revokeBrowserWorkspaceGrant('grant-c');

    expect(mocks.interruptTurn).toHaveBeenCalledWith('desktop-session');
    expect(mocks.stopSession).not.toHaveBeenCalled();
  });

  it('interrupts browser turns that exceed a newly lowered node ceiling', () => {
    registerBrowserWorkspaceSession({
      sessionId: 'session-d',
      workspaceId: 'workspace-a',
      grantId: 'grant-d',
      expiresAt: Date.now() + 60_000,
      startedByBrowser: true,
    });
    beginBrowserWorkspaceTurn({
      sessionId: 'session-d',
      grantId: 'grant-d',
      expiresAt: Date.now() + 60_000,
      permissionMode: 'full-access',
    });

    interruptBrowserWorkspaceTurnsAbove('read-only');

    expect(mocks.interruptTurn).toHaveBeenCalledWith('session-d');
    expect(mocks.stopSession).not.toHaveBeenCalled();
  });

  it('expires a browser-owned turn locally without waiting for another sync cycle', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const expiresAt = Date.now() + 1_000;
    registerBrowserWorkspaceSession({
      sessionId: 'session-expiring',
      workspaceId: 'workspace-a',
      grantId: 'grant-expiring',
      expiresAt,
      startedByBrowser: true,
    });
    beginBrowserWorkspaceTurn({
      sessionId: 'session-expiring',
      grantId: 'grant-expiring',
      expiresAt,
      permissionMode: 'workspace-auto',
    });

    vi.advanceTimersByTime(1_000);

    expect(mocks.interruptTurn).toHaveBeenCalledWith('session-expiring');
    expect(mocks.stopSession).toHaveBeenCalledWith('session-expiring');
    expect(listBrowserWorkspaceOwnedSessionsForTests()).toEqual([]);
  });

  it('keeps the turn only while its same-trust sibling grant remains live', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const now = Date.now();
    registerBrowserWorkspaceSession({
      sessionId: 'session-expired-sibling',
      workspaceId: 'workspace-a',
      grantId: 'grant-turn',
      trustId: 'trust-a',
      expiresAt: now + 1_000,
      startedByBrowser: true,
    });
    registerBrowserWorkspaceSession({
      sessionId: 'session-expired-sibling',
      workspaceId: 'workspace-a',
      grantId: 'grant-already-expired-sibling',
      trustId: 'trust-a',
      expiresAt: now + 500,
      startedByBrowser: true,
    });
    beginBrowserWorkspaceTurn({
      sessionId: 'session-expired-sibling',
      grantId: 'grant-turn',
      trustId: 'trust-a',
      expiresAt: now + 1_000,
      permissionMode: 'workspace-auto',
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(mocks.interruptTurn).toHaveBeenCalledTimes(1);
    expect(mocks.interruptTurn).toHaveBeenCalledWith('session-expired-sibling');
    expect(mocks.stopSession).toHaveBeenCalledWith('session-expired-sibling');
    expect(listBrowserWorkspaceOwnedSessionsForTests()).toEqual([]);
  });

  it('does not interrupt later Desktop work when an adopted browser turn expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const expiresAt = Date.now() + 1_000;
    registerBrowserWorkspaceSession({
      sessionId: 'adopted-desktop-session',
      workspaceId: 'workspace-a',
      grantId: 'grant-adopted',
      expiresAt,
      startedByBrowser: false,
    });
    beginBrowserWorkspaceTurn({
      sessionId: 'adopted-desktop-session',
      grantId: 'grant-adopted',
      expiresAt,
      permissionMode: 'workspace-auto',
    });

    // Completion clears browser-turn attribution before Desktop starts its own
    // work on the adopted process.
    finishBrowserWorkspaceTurn('adopted-desktop-session');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mocks.interruptTurn).not.toHaveBeenCalled();
    expect(mocks.stopSession).not.toHaveBeenCalled();
    expect(listBrowserWorkspaceOwnedSessionsForTests()).toEqual([]);
  });

  it('transfers a directly revoked request turn to a live same-trust sibling', () => {
    const expiresAt = Date.now() + 60_000;
    registerBrowserWorkspaceSession({
      sessionId: 'session-revoked-sibling',
      workspaceId: 'workspace-a',
      grantId: 'grant-revoked',
      trustId: 'trust-a',
      expiresAt,
      startedByBrowser: true,
    });
    registerBrowserWorkspaceSession({
      sessionId: 'session-revoked-sibling',
      workspaceId: 'workspace-a',
      grantId: 'grant-sibling',
      trustId: 'trust-a',
      expiresAt: expiresAt + 60_000,
      startedByBrowser: true,
    });
    beginBrowserWorkspaceTurn({
      sessionId: 'session-revoked-sibling',
      grantId: 'grant-revoked',
      trustId: 'trust-a',
      expiresAt,
      permissionMode: 'workspace-auto',
    });

    revokeBrowserWorkspaceGrant('grant-revoked');

    expect(mocks.interruptTurn).not.toHaveBeenCalled();
    expect(mocks.stopSession).not.toHaveBeenCalled();
    expect(listBrowserWorkspaceOwnedSessionsForTests()).toEqual(['session-revoked-sibling']);
  });

  it('transfers expiry to a renewed sibling while keeping adopted sessions alive', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const oldExpiry = Date.now() + 1_000;
    registerBrowserWorkspaceSession({
      sessionId: 'adopted-renewal',
      workspaceId: 'workspace-a',
      grantId: 'grant-old',
      trustId: 'trust-renewed',
      expiresAt: oldExpiry,
      startedByBrowser: false,
    });
    beginBrowserWorkspaceTurn({
      sessionId: 'adopted-renewal',
      grantId: 'grant-old',
      trustId: 'trust-renewed',
      expiresAt: oldExpiry,
      permissionMode: 'workspace-auto',
    });
    refreshBrowserWorkspaceGrantReferences([
      {
        grantId: 'grant-new',
        trustId: 'trust-renewed',
        expiresAt: Date.now() + 3_000,
      },
    ]);

    vi.advanceTimersByTime(1_000);

    expect(mocks.interruptTurn).not.toHaveBeenCalled();
    expect(mocks.stopSession).not.toHaveBeenCalled();
    expect(listBrowserWorkspaceOwnedSessionsForTests()).toEqual(['adopted-renewal']);

    vi.advanceTimersByTime(2_000);

    expect(mocks.interruptTurn).toHaveBeenCalledWith('adopted-renewal');
    expect(mocks.stopSession).not.toHaveBeenCalled();
    expect(listBrowserWorkspaceOwnedSessionsForTests()).toEqual([]);
  });
});
