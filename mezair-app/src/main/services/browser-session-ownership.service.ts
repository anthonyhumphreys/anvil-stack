import {
  constrainPermissionMode,
  type PermissionMode,
} from '../../../cloud/contract/permissions.js';
import { interruptTurn, stopSession } from './codex-session.service.js';

export interface BrowserWorkspaceGrantReference {
  grantId: string;
  trustId?: string;
  expiresAt: number;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface BrowserSessionOwnership {
  sessionId: string;
  workspaceId: string;
  /** Browser-created sessions are owned by their grants and may be stopped. */
  startedByBrowser: boolean;
  trustIds: Set<string>;
  grants: Map<string, BrowserWorkspaceGrantReference>;
  activeTurnGrants: Map<string, BrowserWorkspaceGrantReference>;
  activeTurnMode?: PermissionMode;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

const ownershipBySession = new Map<string, BrowserSessionOwnership>();
let activeGrants = new Map<string, BrowserWorkspaceGrantReference>();

export function resetBrowserSessionOwnershipForTests(): void {
  for (const ownership of ownershipBySession.values()) {
    if (ownership.expiryTimer !== undefined) clearTimeout(ownership.expiryTimer);
  }
  ownershipBySession.clear();
  activeGrants = new Map();
}

/**
 * Refresh the authorization references before processing per-request expiry.
 * A renewed grant for the same remembered browser trust keeps sessions alive
 * even when the previous one-hour request expires before the browser's next
 * command arrives.
 */
export function refreshBrowserWorkspaceGrantReferences(
  references: readonly BrowserWorkspaceGrantReference[],
): void {
  const now = Date.now();
  activeGrants = new Map(
    references
      .filter(
        (reference) =>
          Number.isFinite(reference.expiresAt) && reference.expiresAt > now && reference.grantId,
      )
      .map((reference) => [reference.grantId, reference]),
  );

  for (const ownership of ownershipBySession.values()) {
    for (const [grantId, previousReference] of ownership.grants) {
      if (!activeGrants.has(grantId)) {
        removeGrantReference(ownership, grantId, previousReference, now);
      }
    }
    for (const trustId of ownership.trustIds) {
      for (const reference of activeGrants.values()) {
        if (reference.trustId === trustId) ownership.grants.set(reference.grantId, reference);
      }
    }
    stopUnreferencedBrowserSession(ownership);
    scheduleOwnershipExpiry(ownership);
  }
}

export function registerBrowserWorkspaceSession(input: {
  sessionId: string;
  workspaceId: string;
  grantId: string;
  trustId?: string;
  expiresAt: number;
  startedByBrowser: boolean;
}): void {
  let ownership = ownershipBySession.get(input.sessionId);
  if (!ownership) {
    ownership = {
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      startedByBrowser: input.startedByBrowser,
      trustIds: new Set(),
      grants: new Map(),
      activeTurnGrants: new Map(),
    };
    ownershipBySession.set(input.sessionId, ownership);
  } else if (ownership.workspaceId !== input.workspaceId) {
    throw new Error('Browser session ownership cannot cross workspaces.');
  }

  const reference = {
    grantId: input.grantId,
    ...(input.trustId ? { trustId: input.trustId } : {}),
    expiresAt: input.expiresAt,
  } satisfies BrowserWorkspaceGrantReference;
  ownership.grants.set(input.grantId, reference);
  if (isLive(reference, Date.now())) activeGrants.set(reference.grantId, reference);
  if (input.trustId) {
    ownership.trustIds.add(input.trustId);
    for (const activeReference of activeGrants.values()) {
      if (activeReference.trustId === input.trustId && isLive(activeReference, Date.now())) {
        ownership.grants.set(activeReference.grantId, activeReference);
      }
    }
  }
  scheduleOwnershipExpiry(ownership);
}

/**
 * Attribute a chat turn to the grant that submitted it. Multiple browser
 * grants can contribute turns to the same session over its lifetime.
 */
export function beginBrowserWorkspaceTurn(input: {
  sessionId: string;
  grantId: string;
  trustId?: string;
  expiresAt: number;
  permissionMode: PermissionMode;
}): void {
  const ownership = ownershipBySession.get(input.sessionId);
  if (!ownership) return;
  const reference = {
    grantId: input.grantId,
    ...(input.trustId ? { trustId: input.trustId } : {}),
    expiresAt: input.expiresAt,
  } satisfies BrowserWorkspaceGrantReference;
  ownership.grants.set(input.grantId, reference);
  ownership.activeTurnGrants.set(input.grantId, reference);
  ownership.activeTurnMode = input.permissionMode;
  if (isLive(reference, Date.now())) activeGrants.set(reference.grantId, reference);
  if (input.trustId) ownership.trustIds.add(input.trustId);
  scheduleOwnershipExpiry(ownership);
}

export function finishBrowserWorkspaceTurn(sessionId: string): void {
  const ownership = ownershipBySession.get(sessionId);
  if (!ownership) return;
  ownership.activeTurnGrants.clear();
  ownership.activeTurnMode = undefined;
  stopUnreferencedBrowserSession(ownership);
  scheduleOwnershipExpiry(ownership);
}

export function abandonBrowserWorkspaceTurn(sessionId: string, grantId: string): void {
  const ownership = ownershipBySession.get(sessionId);
  if (!ownership) return;
  ownership.activeTurnGrants.delete(grantId);
  if (ownership.activeTurnGrants.size === 0) ownership.activeTurnMode = undefined;
  scheduleOwnershipExpiry(ownership);
}

/** Revoke only one short-lived request, preserving live renewal siblings. */
export function revokeBrowserWorkspaceGrant(grantId: string): void {
  activeGrants.delete(grantId);
  for (const ownership of ownershipBySession.values()) {
    const reference = ownership.grants.get(grantId) ?? ownership.activeTurnGrants.get(grantId);
    if (reference !== undefined) removeGrantReference(ownership, grantId, reference, Date.now());
    stopUnreferencedBrowserSession(ownership);
    scheduleOwnershipExpiry(ownership);
  }
}

/** A remembered browser trust revocation cascades across every renewal. */
export function revokeBrowserWorkspaceTrust(trustId: string): void {
  for (const [grantId, reference] of activeGrants) {
    if (reference.trustId === trustId) activeGrants.delete(grantId);
  }
  for (const ownership of ownershipBySession.values()) {
    if (!ownership.trustIds.has(trustId)) continue;
    for (const [grantId, reference] of ownership.grants) {
      if (reference.trustId === trustId) ownership.grants.delete(grantId);
    }
    let interrupted = false;
    for (const [grantId, reference] of ownership.activeTurnGrants) {
      if (reference.trustId === trustId) {
        ownership.activeTurnGrants.delete(grantId);
        interrupted = true;
      }
    }
    if (interrupted) interruptOwnedBrowserTurn(ownership);
    stopUnreferencedBrowserSession(ownership);
    scheduleOwnershipExpiry(ownership);
  }
}

/** Prevent an in-flight browser turn from exceeding a newly lowered node cap. */
export function interruptBrowserWorkspaceTurnsAbove(maximum: PermissionMode): void {
  for (const ownership of ownershipBySession.values()) {
    if (!ownership.activeTurnMode) continue;
    if (constrainPermissionMode(ownership.activeTurnMode, maximum) === ownership.activeTurnMode) {
      continue;
    }
    interruptOwnedBrowserTurn(ownership);
  }
}

function stopUnreferencedBrowserSession(ownership: BrowserSessionOwnership): void {
  const now = Date.now();
  for (const [grantId, reference] of ownership.grants) {
    if (!isLive(reference, now)) ownership.grants.delete(grantId);
  }
  if (ownership.grants.size > 0) return;

  if (ownership.expiryTimer !== undefined) {
    clearTimeout(ownership.expiryTimer);
    ownership.expiryTimer = undefined;
  }
  ownershipBySession.delete(ownership.sessionId);
  if (ownership.startedByBrowser) {
    try {
      stopSession(ownership.sessionId);
    } catch {
      // Session may already have stopped or failed.
    }
  }
}

function scheduleOwnershipExpiry(ownership: BrowserSessionOwnership): void {
  if (ownership.expiryTimer !== undefined) {
    clearTimeout(ownership.expiryTimer);
    ownership.expiryTimer = undefined;
  }
  if (!ownershipBySession.has(ownership.sessionId)) return;
  const nextExpiry = Math.min(
    ...[...ownership.grants.values()].map((reference) =>
      Number.isFinite(reference.expiresAt) ? reference.expiresAt : Date.now(),
    ),
  );
  if (!Number.isFinite(nextExpiry)) return;

  ownership.expiryTimer = setTimeout(
    () => {
      ownership.expiryTimer = undefined;
      expireBrowserWorkspaceGrants();
    },
    Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextExpiry - Date.now())),
  );
  ownership.expiryTimer.unref?.();
}

function isLive(reference: BrowserWorkspaceGrantReference, now: number): boolean {
  return Number.isFinite(reference.expiresAt) && reference.expiresAt > now;
}

function liveSiblingGrant(
  trustId: string | undefined,
  now: number,
): BrowserWorkspaceGrantReference | undefined {
  if (trustId === undefined) return undefined;
  return [...activeGrants.values()]
    .filter((reference) => reference.trustId === trustId && isLive(reference, now))
    .sort((left, right) => right.expiresAt - left.expiresAt)[0];
}

function removeGrantReference(
  ownership: BrowserSessionOwnership,
  grantId: string,
  previousReference: BrowserWorkspaceGrantReference,
  now: number,
): void {
  ownership.grants.delete(grantId);
  if (!ownership.activeTurnGrants.delete(grantId)) return;

  const renewal = liveSiblingGrant(previousReference.trustId, now);
  if (renewal !== undefined) {
    ownership.grants.set(renewal.grantId, renewal);
    ownership.activeTurnGrants.set(renewal.grantId, renewal);
    return;
  }

  interruptOwnedBrowserTurn(ownership);
}

function interruptOwnedBrowserTurn(ownership: BrowserSessionOwnership): void {
  ownership.activeTurnGrants.clear();
  ownership.activeTurnMode = undefined;
  safelyInterrupt(ownership.sessionId);
}

/** Enforce grant expiry locally, even when the Desktop cannot reach sync. */
function expireBrowserWorkspaceGrants(): void {
  const now = Date.now();
  for (const [grantId, reference] of activeGrants) {
    if (!isLive(reference, now)) activeGrants.delete(grantId);
  }

  for (const ownership of [...ownershipBySession.values()]) {
    let shouldInterrupt = false;
    for (const [grantId, reference] of ownership.grants) {
      if (isLive(reference, now)) continue;
      ownership.grants.delete(grantId);
      if (ownership.activeTurnGrants.delete(grantId)) {
        const renewal = liveSiblingGrant(reference.trustId, now);
        if (renewal !== undefined) {
          ownership.grants.set(renewal.grantId, renewal);
          ownership.activeTurnGrants.set(renewal.grantId, renewal);
        } else {
          shouldInterrupt = true;
        }
      }
    }

    for (const trustId of ownership.trustIds) {
      for (const reference of activeGrants.values()) {
        if (reference.trustId === trustId && isLive(reference, now)) {
          ownership.grants.set(reference.grantId, reference);
        }
      }
    }
    if (shouldInterrupt) interruptOwnedBrowserTurn(ownership);

    stopUnreferencedBrowserSession(ownership);
    scheduleOwnershipExpiry(ownership);
  }
}

function safelyInterrupt(sessionId: string): void {
  try {
    interruptTurn(sessionId);
  } catch {
    // Expiry/revocation must still continue to the remaining sessions.
  }
}

export function listBrowserWorkspaceOwnedSessionsForTests(): string[] {
  return [...ownershipBySession.keys()];
}
