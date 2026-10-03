/**
 * Per-entity domain codecs for sync: serialize local rows to canonical
 * payloads, validate remote payloads, apply remote projections, and persist
 * save-copy conflict resolutions. Domain write paths (workflow.service,
 * editable-agent.service, workspace.service, settings.service) emit sync
 * intent through `withSyncedEntityWrite`; the engine calls these codecs when
 * remote changes land. Remote applies MUST write rows directly — never call
 * the domain save functions, or the applied change would echo back as a new
 * local edit.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  SYNC_ENTITY_EDITABLE_AGENT,
  SYNC_ENTITY_SETTINGS,
  SYNC_ENTITY_TYPES,
  SYNC_ENTITY_WORKFLOW_TEMPLATE,
  SYNC_ENTITY_WORKSPACE_DEFINITION,
  SYNC_SETTINGS_ENTITY_ID,
  type SyncEntityType,
} from '../../shared/sync-mesh.js';
import { getDb } from '../db/database.js';
import { canonicalJson } from './sync-persistence.service.js';
import { PERSONAS } from './persona-catalog.js';
import { getEditableAgent } from './editable-agent.service.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

export function isSupportedEntityType(entityType: string): entityType is SyncEntityType {
  return (SYNC_ENTITY_TYPES as readonly string[]).includes(entityType);
}

// ---------------------------------------------------------------------------
// workflow-template
// ---------------------------------------------------------------------------

function buildWorkflowPayload(entityId: string): unknown | null {
  const row = getDb()
    .prepare('SELECT id, name, description, graph_json FROM workflow_templates WHERE id = ?')
    .get(entityId) as
    | { id: string; name: string; description: string; graph_json: string }
    | undefined;
  if (!row) return null;
  let nodes: unknown = [];
  let edges: unknown = [];
  let orchestration: unknown;
  try {
    const graph: unknown = JSON.parse(row.graph_json);
    if (isRecord(graph)) {
      nodes = graph.nodes ?? [];
      edges = graph.edges ?? [];
      orchestration = graph.orchestration;
    }
  } catch {
    /* malformed graph_json serializes as empty lists */
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    nodes,
    edges,
    orchestration,
  };
}

function validateWorkflowPayload(payload: unknown): boolean {
  return isRecord(payload) && Array.isArray(payload.nodes) && Array.isArray(payload.edges);
}

function applyWorkflowPayload(entityId: string, payload: unknown): void {
  if (!validateWorkflowPayload(payload)) return;
  const p = payload as Record<string, unknown>;
  const name = typeof p.name === 'string' ? p.name : '';
  const description = typeof p.description === 'string' ? p.description : '';
  const graphJson = JSON.stringify({
    nodes: p.nodes,
    edges: p.edges,
    orchestration: p.orchestration,
  });
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO workflow_templates (id, name, description, graph_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         graph_json = excluded.graph_json,
         updated_at = excluded.updated_at`,
    )
    .run(entityId, name, description, graphJson, now, now);
}

// ---------------------------------------------------------------------------
// editable-agent
// ---------------------------------------------------------------------------

function buildAgentPayload(entityId: string): unknown | null {
  const agent = getEditableAgent(entityId);
  if (!agent) return null;
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    icon: agent.icon,
    colour: agent.colour,
    promptBody: agent.promptBody,
    capabilities: { ...agent.capabilities },
  };
}

function validateAgentPayload(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (typeof payload.name !== 'string' || payload.name.trim() === '') return false;
  if (typeof payload.promptBody !== 'string') return false;
  if (payload.capabilities !== undefined && !isRecord(payload.capabilities)) return false;
  return true;
}

function applyAgentPayload(entityId: string, payload: unknown): void {
  if (!validateAgentPayload(payload)) return;
  const p = payload as Record<string, unknown>;
  const caps = isRecord(p.capabilities) ? p.capabilities : {};
  const name = (p.name as string).trim();
  const description = typeof p.description === 'string' ? p.description : '';
  const icon = typeof p.icon === 'string' && p.icon.trim() !== '' ? p.icon : 'Bot';
  const colour = typeof p.colour === 'string' && p.colour.trim() !== '' ? p.colour : '#64748b';
  const canWrite = caps.canWriteFiles !== false;
  const canRun = caps.canRunCommands !== false;
  const canRead = caps.canReadFiles !== false;
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO editable_agents
         (id, name, description, icon, colour, prompt_body,
          can_write_files, can_run_commands, can_read_files, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         icon = excluded.icon,
         colour = excluded.colour,
         prompt_body = excluded.prompt_body,
         can_write_files = excluded.can_write_files,
         can_run_commands = excluded.can_run_commands,
         can_read_files = excluded.can_read_files,
         updated_at = excluded.updated_at`,
    )
    .run(
      entityId,
      name,
      description,
      icon,
      colour,
      p.promptBody as string,
      canWrite ? 1 : 0,
      canRun ? 1 : 0,
      canRead ? 1 : 0,
      now,
      now,
    );
}

// ---------------------------------------------------------------------------
// workspace-definition
// ---------------------------------------------------------------------------

interface PortableRepoEntry {
  id: string;
  name: string;
  remoteUrl?: string;
  defaultBranch?: string;
}

/**
 * Preference fields that sync. Anything not listed is device-local and never
 * leaves this machine — e.g. `workItemConnectionId` references an encrypted
 * local connection, `parentPageId` a provider-bound docs page, and launch.*
 * records how the workspace was opened on this device.
 */
const PORTABLE_PREFERENCE_FIELDS: Record<string, readonly string[]> = {
  workitems: ['iterationIds', 'iterationNames', 'personaId', 'workflowTemplateId'],
  docs: ['label', 'personaId', 'workflowTemplateId'],
  launch: ['personaId', 'workflowTemplateId'],
};

function filterPreferenceSection(
  sectionName: keyof typeof PORTABLE_PREFERENCE_FIELDS,
  section: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(section)) return undefined;
  const allowed = PORTABLE_PREFERENCE_FIELDS[sectionName];
  const filtered: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in section) filtered[key] = section[key];
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

/** Merge remote portable fields into a local section, preserving local-only keys. */
function mergePreferenceSection(
  sectionName: keyof typeof PORTABLE_PREFERENCE_FIELDS,
  local: unknown,
  remote: unknown,
): Record<string, unknown> {
  const merged: Record<string, unknown> = isRecord(local) ? { ...local } : {};
  const allowed = PORTABLE_PREFERENCE_FIELDS[sectionName];
  const remoteFields = isRecord(remote) ? remote : {};
  for (const key of allowed) {
    if (key in remoteFields) merged[key] = remoteFields[key];
    else delete merged[key];
  }
  return merged;
}

function buildWorkspacePayload(entityId: string): unknown | null {
  const db = getDb();
  const ws = db.prepare('SELECT id, name FROM workspaces WHERE id = ?').get(entityId) as
    | { id: string; name: string }
    | undefined;
  if (!ws) return null;
  const repos = db
    .prepare(
      `SELECT portable_id, name, remote_url, default_branch
       FROM workspace_repo_definitions WHERE workspace_id = ? ORDER BY portable_id`,
    )
    .all(entityId) as Array<{
    portable_id: string;
    name: string;
    remote_url: string | null;
    default_branch: string | null;
  }>;
  const prefs = db
    .prepare(
      'SELECT workitems_json, docs_json, launch_json FROM workspace_preferences WHERE workspace_id = ?',
    )
    .get(entityId) as
    | { workitems_json: string | null; docs_json: string | null; launch_json: string | null }
    | undefined;
  const parse = (json: string | null): Record<string, unknown> | undefined => {
    if (!json) return undefined;
    try {
      const parsed: unknown = JSON.parse(json);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  const preferences: Record<string, unknown> = {};
  for (const sectionName of ['workitems', 'docs', 'launch'] as const) {
    const column =
      sectionName === 'workitems'
        ? prefs?.workitems_json
        : sectionName === 'docs'
          ? prefs?.docs_json
          : prefs?.launch_json;
    const filtered = filterPreferenceSection(sectionName, parse(column ?? null));
    if (filtered !== undefined) preferences[sectionName] = filtered;
  }
  const bootstrapRow = db
    .prepare('SELECT bootstrap_json FROM workspaces WHERE id = ?')
    .get(entityId) as { bootstrap_json: string | null } | undefined;
  const bootstrap = parse(bootstrapRow?.bootstrap_json ?? null);
  return {
    id: ws.id,
    name: ws.name,
    repos: repos.map((r) => ({
      id: r.portable_id,
      name: r.name,
      ...(r.remote_url !== null ? { remoteUrl: r.remote_url } : {}),
      ...(r.default_branch !== null ? { defaultBranch: r.default_branch } : {}),
    })),
    preferences,
    ...(bootstrap !== undefined ? { bootstrap } : {}),
  };
}

/** Closed validator for a synced bootstrap recipe — anything else drops. */
function isBootstrapRecipe(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== 1) return false;
  if (!Array.isArray(value.steps)) return false;
  if (value.platforms !== undefined) {
    if (!Array.isArray(value.platforms)) return false;
    for (const p of value.platforms as unknown[]) {
      if (p !== 'darwin' && p !== 'linux' && p !== 'win32') return false;
    }
  }
  for (const step of value.steps as unknown[]) {
    if (!isRecord(step)) return false;
    if (typeof step.id !== 'string' || step.id === '') return false;
    if (step.kind !== 'command' && step.kind !== 'verify') return false;
    if (
      typeof step.workingDirectory !== 'string' ||
      !isRepoRelativeWorkingDirectory(step.workingDirectory)
    )
      return false;
    // Exactly one of argv / shell.
    const hasArgv =
      Array.isArray(step.argv) &&
      (step.argv as unknown[]).length > 0 &&
      (step.argv as unknown[]).every((a) => typeof a === 'string');
    const hasShell = typeof step.shell === 'string' && step.shell !== '';
    if (hasArgv === hasShell) return false;
    if (typeof step.timeoutMs !== 'number' || !(step.timeoutMs > 0)) return false;
    if (
      !Array.isArray(step.envNames) ||
      !(step.envNames as unknown[]).every((n) => typeof n === 'string')
    )
      return false;
    if (step.retry !== 'safe' && step.retry !== 'inspect-before-retry' && step.retry !== 'never')
      return false;
  }
  return true;
}

function isRepoRelativeWorkingDirectory(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || value.startsWith('\\')) return false;
  // Reject Windows drive paths as well as traversal on either platform. The
  // recipe is portable data, so both separator styles are path separators.
  if (/^[a-z]:/i.test(value)) return false;
  return !value.split(/[\\/]+/).some((segment) => segment === '..');
}

function validateWorkspacePayload(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (typeof payload.name !== 'string') return false;
  if (!Array.isArray(payload.repos)) return false;
  for (const repo of payload.repos as unknown[]) {
    if (!isRecord(repo)) return false;
    if (typeof repo.id !== 'string' || repo.id === '') return false;
    if (typeof repo.name !== 'string') return false;
  }
  if (payload.preferences !== undefined && !isRecord(payload.preferences)) return false;
  if (payload.bootstrap !== undefined && !isBootstrapRecipe(payload.bootstrap)) return false;
  return true;
}

/**
 * Portable preferences may reference other synced entities (a workflow to
 * launch, a persona to default to). Unresolved references mark the definition
 * needs-setup rather than failing the projection (spec §4).
 */
function personaResolvable(id: string): boolean {
  return PERSONAS.some((p) => p.id === id) || getEditableAgent(id) !== null;
}

function workspaceHasUnresolvedRefs(preferences: Record<string, unknown> | undefined): boolean {
  if (!preferences) return false;
  const db = getDb();
  for (const section of Object.values(preferences)) {
    if (!isRecord(section)) continue;
    const personaId = section['personaId'];
    if (typeof personaId === 'string' && !personaResolvable(personaId)) return true;
    const workflowId = section['workflowTemplateId'] ?? section['templateId'];
    if (typeof workflowId === 'string') {
      const row = db.prepare('SELECT id FROM workflow_templates WHERE id = ?').get(workflowId) as
        | { id: string }
        | undefined;
      if (row === undefined) return true;
    }
  }
  return false;
}

/** Recompute runnable state: unmapped portable repos or unresolved refs → needs-setup. */
export function recomputeWorkspaceDefinitionState(workspaceId: string): void {
  const db = getDb();
  const unmapped = db
    .prepare(
      'SELECT COUNT(*) AS count FROM workspace_repo_definitions WHERE workspace_id = ? AND mapped_repo_id IS NULL',
    )
    .get(workspaceId) as { count: number };
  const prefs = db
    .prepare(
      'SELECT workitems_json, docs_json, launch_json FROM workspace_preferences WHERE workspace_id = ?',
    )
    .get(workspaceId) as
    | { workitems_json: string | null; docs_json: string | null; launch_json: string | null }
    | undefined;
  let merged: Record<string, unknown> = {};
  for (const json of [prefs?.workitems_json, prefs?.docs_json, prefs?.launch_json]) {
    if (!json) continue;
    try {
      const parsed: unknown = JSON.parse(json);
      if (isRecord(parsed)) merged = { ...merged, ...parsed };
    } catch {
      /* ignore */
    }
  }
  const needsSetup = unmapped.count > 0 || workspaceHasUnresolvedRefs({ prefs: merged });
  db.prepare('UPDATE workspaces SET definition_state = ? WHERE id = ?').run(
    needsSetup ? 'needs-setup' : 'ready',
    workspaceId,
  );
}

function applyWorkspacePayload(entityId: string, payload: unknown): void {
  if (!validateWorkspacePayload(payload)) return;
  const p = payload as Record<string, unknown>;
  const repos = (p.repos as unknown[]).map((r) => r as PortableRepoEntry & Record<string, unknown>);
  const db = getDb();
  const now = nowIso();
  const txn = db.transaction(() => {
    const bootstrapJson = p.bootstrap !== undefined ? JSON.stringify(p.bootstrap) : null;
    db.prepare(
      `INSERT INTO workspaces (id, name, definition_state, bootstrap_json, created_at, updated_at)
       VALUES (?, ?, 'ready', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name,
         bootstrap_json = excluded.bootstrap_json, updated_at = excluded.updated_at`,
    ).run(entityId, typeof p.name === 'string' ? p.name : '', bootstrapJson, now, now);

    // Reconcile portable repo definitions; preserve existing local mappings.
    const incoming = new Set(repos.map((r) => String(r.id)));
    const existing = db
      .prepare('SELECT portable_id FROM workspace_repo_definitions WHERE workspace_id = ?')
      .all(entityId) as Array<{ portable_id: string }>;
    for (const row of existing) {
      if (!incoming.has(row.portable_id)) {
        db.prepare(
          'DELETE FROM workspace_repo_definitions WHERE workspace_id = ? AND portable_id = ?',
        ).run(entityId, row.portable_id);
      }
    }
    const upsertDef = db.prepare(
      `INSERT INTO workspace_repo_definitions
         (workspace_id, portable_id, name, remote_url, default_branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, portable_id) DO UPDATE SET
         name = excluded.name,
         remote_url = excluded.remote_url,
         default_branch = excluded.default_branch,
         updated_at = excluded.updated_at`,
    );
    for (const repo of repos) {
      upsertDef.run(
        entityId,
        String(repo.id),
        typeof repo.name === 'string' ? repo.name : '',
        typeof repo.remoteUrl === 'string' ? repo.remoteUrl : null,
        typeof repo.defaultBranch === 'string' ? repo.defaultBranch : null,
        now,
        now,
      );
    }

    const prefs = isRecord(p.preferences) ? p.preferences : {};
    // Merge remote portable fields over existing local prefs so device-local
    // keys (connection ids, provider page refs, launch provenance) survive.
    const existingPrefs = db
      .prepare(
        'SELECT workitems_json, docs_json, launch_json FROM workspace_preferences WHERE workspace_id = ?',
      )
      .get(entityId) as
      | { workitems_json: string | null; docs_json: string | null; launch_json: string | null }
      | undefined;
    const parseLocal = (json: string | null): unknown => {
      if (!json) return undefined;
      try {
        return JSON.parse(json);
      } catch {
        return undefined;
      }
    };
    const workitems = mergePreferenceSection(
      'workitems',
      parseLocal(existingPrefs?.workitems_json ?? null),
      prefs.workitems,
    );
    const docs = mergePreferenceSection(
      'docs',
      parseLocal(existingPrefs?.docs_json ?? null),
      prefs.docs,
    );
    const launch = mergePreferenceSection(
      'launch',
      parseLocal(existingPrefs?.launch_json ?? null),
      prefs.launch,
    );
    db.prepare(
      `INSERT INTO workspace_preferences (workspace_id, workitems_json, docs_json, launch_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         workitems_json = excluded.workitems_json,
         docs_json = excluded.docs_json,
         launch_json = excluded.launch_json,
         updated_at = excluded.updated_at`,
    ).run(entityId, JSON.stringify(workitems), JSON.stringify(docs), JSON.stringify(launch), now);

    recomputeWorkspaceDefinitionState(entityId);
  });
  txn();
}

function deleteWorkspaceLocally(entityId: string): void {
  // Mirror deleteWorkspace's local cleanup without emitting sync intent.
  const db = getDb();
  const txn = db.transaction(() => {
    db.prepare(
      `DELETE FROM chat_messages
       WHERE thread_id IN (SELECT id FROM chat_threads WHERE workspace_id = ?)`,
    ).run(entityId);
    db.prepare(
      `DELETE FROM chat_sessions
       WHERE thread_id IN (SELECT id FROM chat_threads WHERE workspace_id = ?)`,
    ).run(entityId);
    db.prepare('DELETE FROM chat_threads WHERE workspace_id = ?').run(entityId);
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(entityId);
    db.prepare('UPDATE settings SET active_workspace_id = NULL WHERE active_workspace_id = ?').run(
      entityId,
    );
  });
  txn();
}

// ---------------------------------------------------------------------------
// settings (singleton; allowlist only — never secrets, paths, or connectors)
// ---------------------------------------------------------------------------

const SETTINGS_COLUMN_MAP: Record<string, string> = {
  llmProvider: 'llm_provider',
  enabledLlmProviders: 'enabled_llm_providers',
  openaiModel: 'openai_model',
  reasoningLevel: 'reasoning_level',
  codexMode: 'codex_mode',
  chatLayout: 'chat_layout',
  localLlmMode: 'local_llm_mode',
  localLlmProvider: 'local_llm_provider',
  localLlmModel: 'local_llm_model',
  appleFoundationModelsMode: 'apple_foundation_models_mode',
  theme: 'theme',
  userRole: 'user_role',
  cloudFeaturesEnabled: 'cloud_features_enabled',
};

/** The closed, versioned settings allowlist — spec §4 PortableWorkspacePreferences analogue. */
export const SYNCED_SETTINGS_KEYS = Object.keys(SETTINGS_COLUMN_MAP);

const SETTINGS_DEFAULTS: Record<string, unknown> = {
  llmProvider: 'codex',
  openaiModel: 'gpt-5.6-sol',
  reasoningLevel: 'medium',
  codexMode: 'on-request',
  chatLayout: 'classic',
  appleFoundationModelsMode: 'off',
  localLlmMode: 'off',
  localLlmProvider: 'apple',
  cloudFeaturesEnabled: 0,
  theme: 'system',
};

function buildSettingsPayload(): unknown {
  const db = getDb();
  const row = db.prepare('SELECT * FROM settings WHERE id = 1').get() as
    | Record<string, unknown>
    | undefined;
  const fields: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(SETTINGS_COLUMN_MAP)) {
    const value = row?.[column];
    if (value === null || value === undefined) continue;
    fields[key] = column === 'enabled_llm_providers' ? safeJsonParse(value) : value;
  }
  return { id: SYNC_SETTINGS_ENTITY_ID, fields };
}

function safeJsonParse(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function applySettingsPayload(payload: unknown): void {
  if (!isRecord(payload) || !isRecord(payload.fields)) return;
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(payload.fields)) {
    const column = SETTINGS_COLUMN_MAP[key];
    if (column === undefined) continue; // closed allowlist: unknown keys are dropped
    sets.push(`${column} = ?`);
    values.push(
      key === 'enabledLlmProviders'
        ? JSON.stringify(value)
        : key === 'cloudFeaturesEnabled'
          ? value
            ? 1
            : 0
          : value,
    );
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE settings SET ${sets.join(', ')} WHERE id = 1`).run(...values);
}

function deleteSettingsLocally(): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(SETTINGS_COLUMN_MAP)) {
    if (!(key in SETTINGS_DEFAULTS)) continue;
    sets.push(`${column} = ?`);
    values.push(SETTINGS_DEFAULTS[key]);
  }
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE settings SET ${sets.join(', ')} WHERE id = 1`).run(...values);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function readEntityPayloadJson(entityType: string, entityId: string): string | null {
  const payload = buildEntityPayload(entityType, entityId);
  return payload === null ? null : canonicalJson(payload);
}

/**
 * The revision a job manifest pins for a workspace definition: sha256 over
 * the canonical payload. `workspaces.updated_at` is a LOCAL clock — remote
 * applies re-stamp it — so only a content digest converges across devices.
 * Device-local state (repo mappings, merged local pref keys) is absent from
 * the payload, so replicas of the same definition share the revision.
 */
export function workspaceDefinitionRevision(workspaceId: string): string | null {
  const payload = buildWorkspacePayload(workspaceId);
  if (payload === null) return null;
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/** The canonical local payload for one entity, or null when absent locally. */
export function buildEntityPayload(entityType: string, entityId: string): unknown | null {
  switch (entityType) {
    case SYNC_ENTITY_WORKFLOW_TEMPLATE:
      return buildWorkflowPayload(entityId);
    case SYNC_ENTITY_EDITABLE_AGENT:
      return buildAgentPayload(entityId);
    case SYNC_ENTITY_WORKSPACE_DEFINITION:
      return buildWorkspacePayload(entityId);
    case SYNC_ENTITY_SETTINGS:
      return entityId === SYNC_SETTINGS_ENTITY_ID ? buildSettingsPayload() : null;
    default:
      return null;
  }
}

/** null when the payload is well-formed for the type; else a quarantine reason. */
export function entityPayloadIssue(entityType: string, payload: unknown): string | null {
  switch (entityType) {
    case SYNC_ENTITY_WORKFLOW_TEMPLATE:
      return validateWorkflowPayload(payload) ? null : 'malformed-payload';
    case SYNC_ENTITY_EDITABLE_AGENT:
      return validateAgentPayload(payload) ? null : 'malformed-payload';
    case SYNC_ENTITY_WORKSPACE_DEFINITION:
      return validateWorkspacePayload(payload) ? null : 'malformed-payload';
    case SYNC_ENTITY_SETTINGS:
      return isRecord(payload) && isRecord(payload.fields) ? null : 'malformed-payload';
    default:
      return 'unsupported-entity-type';
  }
}

/** Apply a remote create/update to the domain store inside the caller's transaction. */
export function applyRemoteEntityPayload(
  entityType: string,
  entityId: string,
  payload: unknown,
): void {
  switch (entityType) {
    case SYNC_ENTITY_WORKFLOW_TEMPLATE:
      applyWorkflowPayload(entityId, payload);
      return;
    case SYNC_ENTITY_EDITABLE_AGENT:
      applyAgentPayload(entityId, payload);
      return;
    case SYNC_ENTITY_WORKSPACE_DEFINITION:
      applyWorkspacePayload(entityId, payload);
      return;
    case SYNC_ENTITY_SETTINGS:
      if (entityId === SYNC_SETTINGS_ENTITY_ID) applySettingsPayload(payload);
      return;
  }
}

/** Apply a remote delete to the domain store inside the caller's transaction. */
export function deleteLocalEntity(entityType: string, entityId: string): void {
  switch (entityType) {
    case SYNC_ENTITY_WORKFLOW_TEMPLATE:
      getDb().prepare('DELETE FROM workflow_templates WHERE id = ?').run(entityId);
      return;
    case SYNC_ENTITY_EDITABLE_AGENT:
      getDb().prepare('DELETE FROM editable_agents WHERE id = ?').run(entityId);
      return;
    case SYNC_ENTITY_WORKSPACE_DEFINITION:
      deleteWorkspaceLocally(entityId);
      return;
    case SYNC_ENTITY_SETTINGS:
      if (entityId === SYNC_SETTINGS_ENTITY_ID) deleteSettingsLocally();
      return;
  }
}

/**
 * Persist a conflicted local version as a new entity under a fresh id.
 * Returns the new entity id and its payload, or null when the type cannot
 * duplicate (settings is a singleton).
 */
export function persistConflictCopy(
  entityType: string,
  payload: Record<string, unknown>,
): { entityId: string; payload: Record<string, unknown> } | null {
  const copyId = randomUUID();
  const baseName = typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : '';
  switch (entityType) {
    case SYNC_ENTITY_WORKFLOW_TEMPLATE:
    case SYNC_ENTITY_EDITABLE_AGENT: {
      const copyPayload = { ...payload, name: `${baseName || 'Entity'} (local copy)` };
      applyRemoteEntityPayload(entityType, copyId, copyPayload);
      return { entityId: copyId, payload: copyPayload };
    }
    case SYNC_ENTITY_WORKSPACE_DEFINITION: {
      const copyPayload: Record<string, unknown> = {
        ...payload,
        name: `${baseName || 'Workspace'} (local copy)`,
        // A copied workspace gets fresh portable repo ids: membership identity
        // is scoped to the workspace, so two workspaces must not share it.
        repos: Array.isArray(payload.repos)
          ? (payload.repos as unknown[]).map((r) => (isRecord(r) ? { ...r, id: randomUUID() } : r))
          : [],
      };
      applyRemoteEntityPayload(entityType, copyId, copyPayload);
      // The copy shares the original's local checkout mappings by portable
      // position: map each new portable id to the original's mapped repo.
      const originals = getDb()
        .prepare(
          'SELECT portable_id, mapped_repo_id FROM workspace_repo_definitions WHERE workspace_id = ?',
        )
        .all(typeof payload.id === 'string' ? payload.id : '') as Array<{
        portable_id: string;
        mapped_repo_id: string | null;
      }>;
      const copies = getDb()
        .prepare(
          'SELECT portable_id FROM workspace_repo_definitions WHERE workspace_id = ? ORDER BY created_at',
        )
        .all(copyId) as Array<{ portable_id: string }>;
      const setMapped = getDb().prepare(
        'UPDATE workspace_repo_definitions SET mapped_repo_id = ? WHERE workspace_id = ? AND portable_id = ?',
      );
      originals.forEach((orig, index) => {
        const copy = copies[index];
        if (copy !== undefined && orig.mapped_repo_id !== null) {
          setMapped.run(orig.mapped_repo_id, copyId, copy.portable_id);
        }
      });
      recomputeWorkspaceDefinitionState(copyId);
      return { entityId: copyId, payload: copyPayload };
    }
    default:
      return null;
  }
}

/** All local entity ids of a type, for adoption binding. Settings is a singleton. */
export function listLocalEntityIds(entityType: string): string[] {
  const db = getDb();
  switch (entityType) {
    case SYNC_ENTITY_WORKFLOW_TEMPLATE:
      return (db.prepare('SELECT id FROM workflow_templates').all() as Array<{ id: string }>).map(
        (r) => r.id,
      );
    case SYNC_ENTITY_EDITABLE_AGENT:
      return (db.prepare('SELECT id FROM editable_agents').all() as Array<{ id: string }>).map(
        (r) => r.id,
      );
    case SYNC_ENTITY_WORKSPACE_DEFINITION:
      return (db.prepare('SELECT id FROM workspaces').all() as Array<{ id: string }>).map(
        (r) => r.id,
      );
    case SYNC_ENTITY_SETTINGS:
      return [SYNC_SETTINGS_ENTITY_ID];
    default:
      return [];
  }
}

/**
 * Create workspace_repo_definitions rows from existing local membership
 * (workspace_repos + repos) so the portable definition can serialize.
 */
export function materializeRepoDefinitions(workspaceId: string): void {
  const db = getDb();
  const members = db
    .prepare(
      `SELECT wr.repo_id, r.name, r.remote_url, r.default_branch
       FROM workspace_repos wr JOIN repos r ON r.id = wr.repo_id
       WHERE wr.workspace_id = ?`,
    )
    .all(workspaceId) as Array<{
    repo_id: string;
    name: string;
    remote_url: string | null;
    default_branch: string | null;
  }>;
  const now = nowIso();
  const upsert = db.prepare(
    `INSERT INTO workspace_repo_definitions
       (workspace_id, portable_id, name, remote_url, default_branch, mapped_repo_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, portable_id) DO NOTHING`,
  );
  for (const member of members) {
    const existing = db
      .prepare(
        'SELECT portable_id FROM workspace_repo_definitions WHERE workspace_id = ? AND mapped_repo_id = ?',
      )
      .get(workspaceId, member.repo_id) as { portable_id: string } | undefined;
    if (existing !== undefined) continue;
    upsert.run(
      workspaceId,
      randomUUID(),
      member.name,
      member.remote_url,
      member.default_branch,
      member.repo_id,
      now,
      now,
    );
  }
}
