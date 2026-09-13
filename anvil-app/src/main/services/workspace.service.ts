import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dialog, BrowserWindow } from 'electron';
import type {
  Workspace,
  WorkspaceCreateOptions,
  WorkspacePreferences,
  WorkspaceScaffoldSession,
  WorkspaceWorkItemsPreferences,
  WorkspaceDocsPreferences,
  WorkspaceLaunchPreferences,
  WorkspaceRepoDefinition,
  WorkspaceWithRepos,
  WorkspaceSummary,
  RepoInfo,
} from '../../shared/types.js';
import {
  SYNC_ENTITY_SCHEMA_VERSIONS,
  SYNC_ENTITY_WORKSPACE_DEFINITION,
} from '../../shared/sync-mesh.js';
import { getDb } from '../db/database.js';
import { getSettings } from './settings.service.js';
import {
  buildEntityPayload,
  materializeRepoDefinitions,
  recomputeWorkspaceDefinitionState,
} from './sync-entity-domain.js';
import { withSyncedEntityWrite } from './sync-persistence.service.js';

/** Emit sync intent for a bound workspace definition after a local write. */
function emitWorkspaceSyncIntent(workspaceId: string): void {
  withSyncedEntityWrite(
    SYNC_ENTITY_WORKSPACE_DEFINITION,
    workspaceId,
    SYNC_ENTITY_SCHEMA_VERSIONS[SYNC_ENTITY_WORKSPACE_DEFINITION],
    'update',
    () => buildEntityPayload(SYNC_ENTITY_WORKSPACE_DEFINITION, workspaceId),
    () => {},
  );
}

// ---------------------------------------------------------------------------
// Internal row types (snake_case columns from SQLite)
// ---------------------------------------------------------------------------

interface WorkspaceRow {
  id: string;
  name: string;
  definition_state: 'ready' | 'needs-setup';
  created_at: string;
  updated_at: string;
}

interface WorkspaceSummaryRow extends WorkspaceRow {
  repo_count: number;
}

interface WorkspacePreferencesRow {
  workspace_id: string;
  workitems_json: string | null;
  docs_json: string | null;
  launch_json: string | null;
  updated_at: string;
}

interface WorkspaceScaffoldSessionRow {
  id: string;
  workspace_id: string;
  root_path: string;
  persona_id: string;
  status: WorkspaceScaffoldSession['status'];
  completion_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface RepoRow {
  id: string;
  name: string;
  path: string;
  remote_url: string | null;
  default_branch: string;
  status: string;
  last_indexed: string | null;
  file_count: number;
  branch_count: number;
  last_commit_message: string | null;
  last_commit_date: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    definitionState: row.definition_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorkspaceSummary(row: WorkspaceSummaryRow): WorkspaceSummary {
  return {
    ...mapWorkspace(row),
    repoCount: row.repo_count,
  };
}

function safeParseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapWorkspacePreferences(row: WorkspacePreferencesRow): WorkspacePreferences {
  return {
    workspaceId: row.workspace_id,
    workitems: safeParseJson<WorkspaceWorkItemsPreferences>(row.workitems_json, {}),
    docs: safeParseJson<WorkspaceDocsPreferences>(row.docs_json, {}),
    launch: safeParseJson<WorkspaceLaunchPreferences>(row.launch_json, {}),
    updatedAt: row.updated_at,
  };
}

function adoptDefaultWorkItemConnection(preferences: WorkspacePreferences): WorkspacePreferences {
  if (preferences.workitems.workItemConnectionId) return preferences;

  const settings = getSettings();
  const connectionId = settings.activeWorkItemConnectionId;
  if (!connectionId) return preferences;

  const workitems = { ...preferences.workitems, workItemConnectionId: connectionId };
  getDb()
    .prepare(
      `UPDATE workspace_preferences
       SET workitems_json = ?, updated_at = datetime('now')
       WHERE workspace_id = ?`,
    )
    .run(JSON.stringify(workitems), preferences.workspaceId);

  return { ...preferences, workitems, updatedAt: new Date().toISOString() };
}

function mapWorkspaceScaffoldSession(row: WorkspaceScaffoldSessionRow): WorkspaceScaffoldSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    rootPath: row.root_path,
    personaId: row.persona_id,
    status: row.status,
    completion: safeParseJson(row.completion_json, undefined),
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function mapRepo(row: RepoRow): RepoInfo {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    remoteUrl: row.remote_url ?? undefined,
    defaultBranch: row.default_branch,
    status: row.status as RepoInfo['status'],
    lastIndexed: row.last_indexed ?? undefined,
    fileCount: row.file_count,
    branchCount: row.branch_count,
    languages: [],
  };
}

// ---------------------------------------------------------------------------
// Workspace CRUD
// ---------------------------------------------------------------------------

/**
 * List all workspaces with their repo counts.
 */
export function listWorkspaces(): WorkspaceSummary[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT w.*, COUNT(wr.repo_id) AS repo_count
       FROM workspaces w
       LEFT JOIN workspace_repos wr ON wr.workspace_id = w.id
       GROUP BY w.id
       ORDER BY w.updated_at DESC`,
    )
    .all() as WorkspaceSummaryRow[];
  return rows.map(mapWorkspaceSummary);
}

/**
 * Get a single workspace by ID, including its full repo list.
 * Throws if the workspace does not exist.
 */
export function getWorkspace(id: string): WorkspaceWithRepos {
  const db = getDb();
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
    | WorkspaceRow
    | undefined;

  if (!row) {
    throw new Error(`Workspace not found: ${id}`);
  }

  const repoRows = db
    .prepare(
      `SELECT r.*
       FROM repos r
       INNER JOIN workspace_repos wr ON wr.repo_id = r.id
       WHERE wr.workspace_id = ?
       ORDER BY r.name ASC`,
    )
    .all(id) as RepoRow[];

  const prefsRow = db
    .prepare('SELECT * FROM workspace_preferences WHERE workspace_id = ?')
    .get(id) as WorkspacePreferencesRow | undefined;
  const scaffoldRow = db
    .prepare('SELECT * FROM workspace_scaffold_sessions WHERE workspace_id = ?')
    .get(id) as WorkspaceScaffoldSessionRow | undefined;

  return {
    ...mapWorkspace(row),
    repos: repoRows.map(mapRepo),
    preferences: prefsRow
      ? adoptDefaultWorkItemConnection(mapWorkspacePreferences(prefsRow))
      : undefined,
    scaffoldSession: scaffoldRow ? mapWorkspaceScaffoldSession(scaffoldRow) : undefined,
  };
}

/**
 * Create a new workspace with an initial set of repos.
 * Uses a transaction for atomicity.
 */
export function createWorkspace(opts: WorkspaceCreateOptions): Workspace {
  const db = getDb();
  const id = randomUUID();
  const repoIds = opts.repoIds ?? [];
  const settings = getSettings();
  const workItemConnectionId = opts.workItemConnectionId ?? settings.activeWorkItemConnectionId;
  if (
    workItemConnectionId &&
    !settings.workItemConnections.some((connection) => connection.id === workItemConnectionId)
  ) {
    throw new Error(`Work item connection not found: ${workItemConnectionId}`);
  }
  const workItemsPreferences: WorkspaceWorkItemsPreferences = workItemConnectionId
    ? { workItemConnectionId }
    : {};

  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO workspaces (id, name, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))`,
    ).run(id, opts.name);

    db.prepare(
      `INSERT INTO workspace_preferences (workspace_id, workitems_json, docs_json, launch_json, updated_at)
       VALUES (?, ?, '{}', '{}', datetime('now'))`,
    ).run(id, JSON.stringify(workItemsPreferences));

    const insertRepo = db.prepare(
      `INSERT INTO workspace_repos (workspace_id, repo_id, added_at)
       VALUES (?, ?, datetime('now'))`,
    );
    for (const repoId of repoIds) {
      insertRepo.run(id, repoId);
    }
    materializeRepoDefinitions(id);
    recomputeWorkspaceDefinitionState(id);
  });
  txn();

  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow;
  return mapWorkspace(row);
}

export function getWorkspacePreferences(workspaceId: string): WorkspacePreferences | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM workspace_preferences WHERE workspace_id = ?')
    .get(workspaceId) as WorkspacePreferencesRow | undefined;

  return row ? adoptDefaultWorkItemConnection(mapWorkspacePreferences(row)) : null;
}

export function updateWorkspacePreferences(
  workspaceId: string,
  updates: {
    workitems?: Partial<WorkspaceWorkItemsPreferences>;
    docs?: Partial<WorkspaceDocsPreferences>;
    launch?: Partial<WorkspaceLaunchPreferences>;
  },
): WorkspacePreferences {
  const db = getDb();
  const current = getWorkspacePreferences(workspaceId) ?? {
    workspaceId,
    workitems: {},
    docs: {},
    launch: {},
    updatedAt: new Date().toISOString(),
  };

  const next: WorkspacePreferences = {
    workspaceId,
    workitems: { ...current.workitems, ...(updates.workitems ?? {}) },
    docs: { ...current.docs, ...(updates.docs ?? {}) },
    launch: { ...current.launch, ...(updates.launch ?? {}) },
    updatedAt: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO workspace_preferences (workspace_id, workitems_json, docs_json, launch_json, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(workspace_id) DO UPDATE SET
       workitems_json = excluded.workitems_json,
       docs_json = excluded.docs_json,
       launch_json = excluded.launch_json,
       updated_at = datetime('now')`,
  ).run(
    workspaceId,
    JSON.stringify(next.workitems),
    JSON.stringify(next.docs),
    JSON.stringify(next.launch),
  );

  db.prepare(`UPDATE workspaces SET updated_at = datetime('now') WHERE id = ?`).run(workspaceId);

  db.transaction(() => {
    recomputeWorkspaceDefinitionState(workspaceId);
    emitWorkspaceSyncIntent(workspaceId);
  })();

  return getWorkspacePreferences(workspaceId)!;
}

export function clearWorkspacePreferences(
  workspaceId: string,
  sections?: Array<'workitems' | 'docs' | 'launch'>,
): WorkspacePreferences {
  const clearSections = sections ?? ['workitems', 'docs', 'launch'];
  const current = getWorkspacePreferences(workspaceId) ?? {
    workspaceId,
    workitems: {},
    docs: {},
    launch: {},
    updatedAt: new Date().toISOString(),
  };

  const updates: {
    workitems?: WorkspaceWorkItemsPreferences;
    docs?: WorkspaceDocsPreferences;
    launch?: WorkspaceLaunchPreferences;
  } = {};

  if (clearSections.includes('workitems')) updates.workitems = {};
  else updates.workitems = current.workitems;

  if (clearSections.includes('docs')) updates.docs = {};
  else updates.docs = current.docs;

  if (clearSections.includes('launch')) updates.launch = {};
  else updates.launch = current.launch;

  return updateWorkspacePreferences(workspaceId, updates);
}

/**
 * Update a workspace's name. Throws if the workspace does not exist.
 */
export function updateWorkspace(id: string, opts: { name: string }): Workspace {
  const db = getDb();
  const result = db
    .prepare(`UPDATE workspaces SET name = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(opts.name, id);

  if (result.changes === 0) {
    throw new Error(`Workspace not found: ${id}`);
  }

  emitWorkspaceSyncIntent(id);

  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow;
  return mapWorkspace(row);
}

/**
 * Delete a workspace. CASCADE will remove junction rows automatically.
 * Throws if the workspace does not exist.
 */
export function deleteWorkspace(id: string): void {
  const db = getDb();
  const deleteWorkspaceTxn = db.transaction(() => {
    withSyncedEntityWrite(
      SYNC_ENTITY_WORKSPACE_DEFINITION,
      id,
      SYNC_ENTITY_SCHEMA_VERSIONS[SYNC_ENTITY_WORKSPACE_DEFINITION],
      'delete',
      () => null,
      () => {
        deleteWorkspaceRows(id);
      },
    );
  });

  deleteWorkspaceTxn();
}

function deleteWorkspaceRows(id: string): void {
  const db = getDb();
  db.prepare(
    `DELETE FROM chat_messages
     WHERE thread_id IN (SELECT id FROM chat_threads WHERE workspace_id = ?)`,
  ).run(id);
  db.prepare(
    `DELETE FROM chat_sessions
     WHERE thread_id IN (SELECT id FROM chat_threads WHERE workspace_id = ?)`,
  ).run(id);
  db.prepare('DELETE FROM chat_threads WHERE workspace_id = ?').run(id);
  const result = db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);

  if (result.changes === 0) {
    throw new Error(`Workspace not found: ${id}`);
  }

  db.prepare('UPDATE settings SET active_workspace_id = NULL WHERE active_workspace_id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Repo membership
// ---------------------------------------------------------------------------

/**
 * Add repos to a workspace. Duplicates are silently ignored.
 */
export function addReposToWorkspace(workspaceId: string, repoIds: string[]): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO workspace_repos (workspace_id, repo_id, added_at)
     VALUES (?, ?, datetime('now'))`,
  );

  const txn = db.transaction(() => {
    for (const repoId of repoIds) {
      insert.run(workspaceId, repoId);
    }
    db.prepare(`UPDATE workspaces SET updated_at = datetime('now') WHERE id = ?`).run(workspaceId);
    materializeRepoDefinitions(workspaceId);
    recomputeWorkspaceDefinitionState(workspaceId);
    emitWorkspaceSyncIntent(workspaceId);
  });
  txn();
}

/**
 * Portable repo entries for a workspace definition — the WS-01 mapping surface.
 * Entries with mappedRepoId = null need a local checkout chosen before the
 * workspace is runnable on this device.
 */
export function listWorkspaceRepoDefinitions(workspaceId: string): WorkspaceRepoDefinition[] {
  const rows = getDb()
    .prepare(
      `SELECT portable_id, name, remote_url, default_branch, mapped_repo_id
       FROM workspace_repo_definitions WHERE workspace_id = ? ORDER BY name`,
    )
    .all(workspaceId) as Array<{
    portable_id: string;
    name: string;
    remote_url: string | null;
    default_branch: string | null;
    mapped_repo_id: string | null;
  }>;
  return rows.map((row) => ({
    portableId: row.portable_id,
    name: row.name,
    remoteUrl: row.remote_url ?? undefined,
    defaultBranch: row.default_branch ?? undefined,
    mappedRepoId: row.mapped_repo_id,
  }));
}

/**
 * WS-01: map a portable definition entry to an existing local checkout.
 * Device-local only — the synced payload carries portable ids, never local
 * repo ids — so no sync intent is emitted. Adds the checkout to workspace
 * membership and recomputes readiness.
 */
export function mapWorkspaceRepoToCheckout(
  workspaceId: string,
  portableId: string,
  repoId: string,
): void {
  const db = getDb();
  const repo = db.prepare('SELECT id FROM repos WHERE id = ?').get(repoId) as
    | { id: string }
    | undefined;
  if (!repo) throw new Error(`Repo not found: ${repoId}`);
  const txn = db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE workspace_repo_definitions
         SET mapped_repo_id = ?, updated_at = datetime('now')
         WHERE workspace_id = ? AND portable_id = ?`,
      )
      .run(repoId, workspaceId, portableId);
    if (result.changes === 0) {
      throw new Error(`Repo definition not found: ${portableId}`);
    }
    db.prepare(
      `INSERT OR IGNORE INTO workspace_repos (workspace_id, repo_id, added_at)
       VALUES (?, ?, datetime('now'))`,
    ).run(workspaceId, repoId);
    recomputeWorkspaceDefinitionState(workspaceId);
  });
  txn();
}

/**
 * Remove repos from a workspace.
 */
export function removeReposFromWorkspace(workspaceId: string, repoIds: string[]): void {
  const db = getDb();
  const del = db.prepare(`DELETE FROM workspace_repos WHERE workspace_id = ? AND repo_id = ?`);
  const delDef = db.prepare(
    `DELETE FROM workspace_repo_definitions WHERE workspace_id = ? AND mapped_repo_id = ?`,
  );

  const txn = db.transaction(() => {
    for (const repoId of repoIds) {
      del.run(workspaceId, repoId);
      delDef.run(workspaceId, repoId);
    }
    db.prepare(`UPDATE workspaces SET updated_at = datetime('now') WHERE id = ?`).run(workspaceId);
    recomputeWorkspaceDefinitionState(workspaceId);
    emitWorkspaceSyncIntent(workspaceId);
  });
  txn();
}

// ---------------------------------------------------------------------------
// VS Code workspace export
// ---------------------------------------------------------------------------

/**
 * Export a workspace as a .code-workspace file.
 * Opens a native save dialog, then writes the file.
 */
export async function exportVSCodeWorkspace(workspaceId: string): Promise<void> {
  const workspace = getWorkspace(workspaceId);

  const codeWorkspace = {
    folders: workspace.repos.map((repo) => ({ path: repo.path })),
    settings: {},
  };

  const focusedWindow = BrowserWindow.getFocusedWindow();
  const { canceled, filePath } = await dialog.showSaveDialog(focusedWindow!, {
    defaultPath: `${workspace.name}.code-workspace`,
    filters: [{ name: 'VS Code Workspace', extensions: ['code-workspace'] }],
  });

  if (canceled || !filePath) {
    return;
  }

  writeFileSync(filePath, JSON.stringify(codeWorkspace, null, 2), 'utf-8');
}
