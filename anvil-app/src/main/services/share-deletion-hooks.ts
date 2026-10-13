// Deletion hooks: capture the shareable items of threads synchronously (before
// rows cascade away), then revoke their live links in the background. Kept
// free of share.service imports so deletion paths stay light and testable.

import { getDb } from '../db/database.js';

function liveShareItemIds(
  itemType: 'artifact' | 'surface',
  sourceSql: string,
  threadIds: readonly string[],
): string[] {
  const placeholders = threadIds.map(() => '?').join(', ');
  return (
    getDb()
      .prepare(
        `SELECT DISTINCT s.item_id AS id FROM shares s
         WHERE s.item_type = ? AND s.revoked_at IS NULL
           AND s.item_id IN (${sourceSql.replace('%THREADS%', placeholders)})`,
      )
      .all(itemType, ...threadIds) as Array<{ id: string }>
  ).map((row) => row.id);
}

export function revokeThreadSharesInBackground(threadIds: readonly string[]): void {
  if (threadIds.length === 0) return;
  let artifactIds: string[];
  let surfaceIds: string[];
  try {
    artifactIds = liveShareItemIds(
      'artifact',
      'SELECT id FROM chat_artifacts WHERE thread_id IN (%THREADS%)',
      threadIds,
    );
    surfaceIds = liveShareItemIds(
      'surface',
      "SELECT id FROM agent_ui_intents WHERE kind = 'surface' AND thread_id IN (%THREADS%)",
      threadIds,
    );
  } catch {
    return;
  }
  if (artifactIds.length === 0 && surfaceIds.length === 0) return;
  void import('./share.service.js')
    .then(({ revokeSharesForItems }) =>
      Promise.all([
        revokeSharesForItems('artifact', artifactIds),
        revokeSharesForItems('surface', surfaceIds),
      ]),
    )
    .catch((error: unknown) => console.warn('[Shares] Revoke after deletion failed:', error));
}

export function revokeWorkspaceSharesInBackground(workspaceId: string): void {
  try {
    const threadIds = (
      getDb().prepare('SELECT id FROM chat_threads WHERE workspace_id = ?').all(workspaceId) as Array<{
        id: string;
      }>
    ).map((row) => row.id);
    revokeThreadSharesInBackground(threadIds);
  } catch {
    // Shares table may be absent in partial test schemas; deletion proceeds.
  }
}
