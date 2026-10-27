import {
  buildDefaultOverviewLayout,
  normalizeOverviewLayout,
  type OverviewLayout,
  type OverviewLayoutState,
  type OverviewLayoutTarget,
  type OverviewScope,
  type OverviewSources,
} from '../../shared/overview.js';
import { getDb } from '../db/database.js';
import { getActiveDocsProvider } from './docs-provider.js';
import { getSettings } from './settings.service.js';
import { getWorkspacePreferences, listWorkspaces } from './workspace.service.js';

interface LayoutRow {
  layout_json: string;
  updated_at: string;
}

/** Integrations the overview can draw from, without exposing credentials. */
export function getOverviewSources(): OverviewSources {
  const settings = getSettings();
  const connections = (settings.workItemConnections ?? []).map((connection) => ({
    id: connection.id,
    name: connection.name,
    provider: connection.provider,
  }));
  const known = new Set(connections.map((connection) => connection.id));
  const workspaceConnectionIds: Record<string, string | undefined> = {};
  for (const workspace of listWorkspaces()) {
    const connectionId = getWorkspacePreferences(workspace.id)?.workitems.workItemConnectionId;
    workspaceConnectionIds[workspace.id] =
      connectionId && known.has(connectionId) ? connectionId : undefined;
  }
  const docsProvider = getActiveDocsProvider();
  let docsConfigured: boolean;
  try {
    docsConfigured = docsProvider?.isConfigured() ?? false;
  } catch {
    docsConfigured = false;
  }
  return {
    workItemConnections: connections,
    workspaceConnectionIds,
    docs: { provider: settings.docsProvider ?? 'none', configured: docsConfigured },
  };
}

export function assertOverviewScope(scope: unknown): OverviewScope {
  const input = (scope && typeof scope === 'object' ? scope : {}) as Record<string, unknown>;
  if (input.kind === 'global') return { kind: 'global' };
  if (input.kind === 'workspace' && typeof input.workspaceId === 'string') {
    const exists = getDb().prepare('SELECT 1 FROM workspaces WHERE id = ?').get(input.workspaceId);
    if (!exists) throw new Error('This workspace no longer exists.');
    return { kind: 'workspace', workspaceId: input.workspaceId };
  }
  throw new Error('Unknown overview scope.');
}

function readLayout(key: OverviewLayoutTarget, scope: OverviewScope) {
  const row = getDb()
    .prepare('SELECT layout_json, updated_at FROM overview_layouts WHERE layout_key = ?')
    .get(key) as LayoutRow | undefined;
  if (!row) return null;
  try {
    return {
      layout: normalizeOverviewLayout(JSON.parse(row.layout_json), scope),
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the effective layout. Workspaces layer: per-workspace override →
 * default workspace layout → built-in. The global overview is personal only.
 */
export function getOverviewLayout(
  scope: OverviewScope,
  sources = getOverviewSources(),
): OverviewLayoutState {
  const builtIn = buildDefaultOverviewLayout(scope, sources);
  if (scope.kind === 'global') {
    const saved = readLayout('global', scope);
    return saved
      ? { layout: saved.layout, source: 'personal', fallback: builtIn, updatedAt: saved.updatedAt }
      : { layout: builtIn, source: 'built-in', fallback: builtIn };
  }

  const shared = readLayout('workspace-default', scope);
  const override = readLayout(`workspace:${scope.workspaceId}`, scope);
  const sharedOrBuiltIn = shared?.layout ?? builtIn;
  if (override) {
    return {
      layout: override.layout,
      source: 'workspace-override',
      fallback: sharedOrBuiltIn,
      updatedAt: override.updatedAt,
    };
  }
  return shared
    ? {
        layout: shared.layout,
        source: 'workspace-default',
        fallback: builtIn,
        updatedAt: shared.updatedAt,
      }
    : { layout: builtIn, source: 'built-in', fallback: builtIn };
}

function targetScope(target: OverviewLayoutTarget): {
  scope: OverviewScope;
  workspaceId: string | null;
} {
  if (target === 'global') return { scope: { kind: 'global' }, workspaceId: null };
  if (target === 'workspace-default') {
    // The default layout applies to every workspace; validate as workspace scope.
    return { scope: { kind: 'workspace', workspaceId: '' }, workspaceId: null };
  }
  const workspaceId = target.slice('workspace:'.length);
  return { scope: assertOverviewScope({ kind: 'workspace', workspaceId }), workspaceId };
}

export function assertOverviewLayoutTarget(target: unknown): OverviewLayoutTarget {
  if (target === 'global' || target === 'workspace-default') return target;
  if (typeof target === 'string' && target.startsWith('workspace:') && target.length > 10) {
    return target as OverviewLayoutTarget;
  }
  throw new Error('Unknown overview layout target.');
}

export function saveOverviewLayout(target: OverviewLayoutTarget, raw: unknown): OverviewLayout {
  const { scope, workspaceId } = targetScope(target);
  const layout = normalizeOverviewLayout(raw, scope);
  getDb()
    .prepare(
      `INSERT INTO overview_layouts (layout_key, workspace_id, layout_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(layout_key) DO UPDATE SET
         layout_json = excluded.layout_json,
         updated_at = excluded.updated_at`,
    )
    .run(target, workspaceId, JSON.stringify(layout), new Date().toISOString());
  return layout;
}

/** Saving the shared workspace default also drops this workspace's override. */
export function saveWorkspaceDefaultLayout(workspaceId: string, raw: unknown): OverviewLayout {
  const layout = saveOverviewLayout('workspace-default', raw);
  resetOverviewLayout(`workspace:${workspaceId}`);
  return layout;
}

export function resetOverviewLayout(target: OverviewLayoutTarget): void {
  getDb().prepare('DELETE FROM overview_layouts WHERE layout_key = ?').run(target);
}
