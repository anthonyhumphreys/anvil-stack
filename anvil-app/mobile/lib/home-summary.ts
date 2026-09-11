import type { MobileOverview } from '../../src/shared/types';

/** Keep each thread in one home section, scoped to the selected workspace. */
export function homeSummary(overview: MobileOverview) {
  const workspaceId = overview.activeWorkspace?.id;
  const sessions = overview.activeSessions.filter(
    (session) => !workspaceId || session.workspaceId === workspaceId,
  );
  const failedIds = new Set(
    sessions.filter((session) => session.status === 'error').map((session) => session.id),
  );
  const attention = overview.workQueue.filter(
    (item) =>
      (!workspaceId || item.workspaceId === workspaceId) &&
      (item.kind === 'approval' ||
        (item.kind === 'session' && failedIds.has(item.sessionId ?? ''))),
  );
  const approvalSessionIds = new Set(
    overview.pendingApprovals.map((approval) => approval.sessionId),
  );
  const running = sessions.filter(
    (session) =>
      (session.status === 'busy' || session.status === 'starting') &&
      !approvalSessionIds.has(session.id),
  );
  const shownThreadIds = new Set([
    ...attention.map((item) => item.threadId),
    ...running.map((session) => session.appThreadId),
    ...overview.threads
      .filter((thread) => running.some((session) => session.id === thread.activeSessionId))
      .map((thread) => thread.id),
  ]);
  const recent = overview.threads
    .filter(
      (thread) =>
        (!workspaceId || thread.workspaceId === workspaceId) && !shownThreadIds.has(thread.id),
    )
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 3);
  return { attention, running, recent };
}
