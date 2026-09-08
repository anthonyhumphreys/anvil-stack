import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { getSettings, applyWorkItemConnection } from './settings.service.js';
import { getDb } from '../db/database.js';
import type { WorkItem } from '../../shared/types.js';

type Settings = ReturnType<typeof getSettings>;
const context = new AsyncLocalStorage<{ settings: Settings; fresh: boolean }>();
export const getWorkItemSettings = (): Settings => context.getStore()?.settings ?? getSettings();
export function withWorkItemContext<T>(settings: Settings, fresh: boolean, action: () => T): T {
  return context.run({ settings, fresh }, action);
}
export function workItemConnectionKey(): string {
  const s = getWorkItemSettings();
  return createHash('sha256')
    .update(
      JSON.stringify([
        'provider-text-v2',
        s.activeWorkItemConnectionId,
        s.workItemProvider,
        s.adoOrganizationUrl,
        s.adoProject,
        s.linearTeamId,
        s.jiraHost,
        s.jiraProject,
        s.jiraAcceptanceCriteriaField,
      ]),
    )
    .digest('hex');
}
const completeLists = new Map<string, { ids: string[]; fetchedAt: number }>();
export function getCachedWorkItems(): WorkItem[] | null {
  if (context.getStore()?.fresh) return null;
  const list = completeLists.get(workItemConnectionKey());
  if (!list || Date.now() - list.fetchedAt > 300_000) return null;
  if (!list.ids.length) return [];
  const rows = getDb()
    .prepare('SELECT raw_json, fetched_at FROM scoped_work_items_cache WHERE connection_key = ?')
    .all(workItemConnectionKey()) as { raw_json: string; fetched_at: string }[];
  if (!rows.length || rows.some((r) => Date.now() - Date.parse(r.fetched_at) > 300_000))
    return null;
  if (list.ids.some((id) => !rows.some((row) => (JSON.parse(row.raw_json) as WorkItem).id === id)))
    return null;
  return rows
    .map((r) => JSON.parse(r.raw_json) as WorkItem)
    .filter((item) => list.ids.includes(item.id))
    .sort((a, b) => a.priority - b.priority);
}
export function getCachedWorkItem(id: string): WorkItem | null {
  if (context.getStore()?.fresh) return null;
  const row = getDb()
    .prepare(
      'SELECT raw_json, fetched_at FROM scoped_work_items_cache WHERE connection_key = ? AND id = ?',
    )
    .get(workItemConnectionKey(), id) as { raw_json: string; fetched_at: string } | undefined;
  return row && Date.now() - Date.parse(row.fetched_at) <= 300_000
    ? (JSON.parse(row.raw_json) as WorkItem)
    : null;
}
export function invalidateWorkItemsCache(): void {
  completeLists.delete(workItemConnectionKey());
  getDb()
    .prepare('DELETE FROM scoped_work_items_cache WHERE connection_key = ?')
    .run(workItemConnectionKey());
}
export function cacheSingleWorkItem(item: WorkItem): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO scoped_work_items_cache VALUES (?, ?, ?, ?)')
    .run(workItemConnectionKey(), item.id, JSON.stringify(item), new Date().toISOString());
}
export function cacheWorkItems(items: WorkItem[]): void {
  getDb().transaction(() => {
    invalidateWorkItemsCache();
    items.forEach(cacheSingleWorkItem);
  })();
  completeLists.set(workItemConnectionKey(), {
    ids: items.map((item) => item.id),
    fetchedAt: Date.now(),
  });
}

/** Offline readers receive only the selected workspace's provider cache, with its fetch timestamp. */
export function cachedWorkItemRows(workspaceId?: string) {
  let settings = getSettings();
  if (workspaceId) {
    const row = getDb()
      .prepare('SELECT workitems_json FROM workspace_preferences WHERE workspace_id = ?')
      .get(workspaceId) as { workitems_json: string | null } | undefined;
    let connectionId: string | undefined;
    try {
      connectionId = JSON.parse(row?.workitems_json ?? '{}').workItemConnectionId;
    } catch {
      /* no preference */
    }
    const connection = settings.workItemConnections?.find((c) => c.id === connectionId);
    if (connectionId && !connection) return [];
    if (connection)
      settings = {
        ...applyWorkItemConnection(settings, connection),
        activeWorkItemConnectionId: connection.id,
      };
  }
  return withWorkItemContext(settings, false, () => {
    const rows = getDb()
      .prepare('SELECT raw_json, fetched_at FROM scoped_work_items_cache WHERE connection_key = ?')
      .all(workItemConnectionKey()) as { raw_json: string; fetched_at: string }[];
    return rows.flatMap((row) => {
      try {
        const item = JSON.parse(row.raw_json) as WorkItem;
        return [
          {
            id: item.id,
            title: item.title,
            type: item.type,
            state: item.state,
            priority: item.priority,
            assignee: item.assignee ?? null,
            description: item.description ?? null,
            acceptance_criteria: item.acceptanceCriteria ?? null,
            repo_url: item.repoUrl ?? null,
            tags: item.tags?.join(';') ?? null,
            iteration_path: item.iterationPath ?? null,
            parent_id: item.parentId ?? null,
            ...row,
          },
        ];
      } catch {
        return [];
      }
    });
  });
}
