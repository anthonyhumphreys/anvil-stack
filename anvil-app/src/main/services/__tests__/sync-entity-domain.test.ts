import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import {
  SYNC_ENTITY_EDITABLE_AGENT,
  SYNC_ENTITY_SETTINGS,
  SYNC_ENTITY_WORKFLOW_TEMPLATE,
  SYNC_ENTITY_WORKSPACE_DEFINITION,
  SYNC_SETTINGS_ENTITY_ID,
  type SyncScope,
} from '../../../shared/sync-mesh';
import { SPIKE_DATASET_EPOCH } from '../../../shared/sync-runtime';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
db.prepare('INSERT INTO settings (id) VALUES (1)').run();

vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf-8').slice('enc:'.length),
  },
}));

import {
  applyRemoteEntityPayload,
  buildEntityPayload,
  deleteLocalEntity,
  entityPayloadIssue,
  isSupportedEntityType,
  listLocalEntityIds,
  materializeRepoDefinitions,
  persistConflictCopy,
  readEntityPayloadJson,
  recomputeWorkspaceDefinitionState,
  SYNCED_SETTINGS_KEYS,
} from '../sync-entity-domain';
import {
  deleteEditableAgent,
  getEditableAgent,
  listEditableAgents,
  saveEditableAgent,
} from '../editable-agent.service';
import {
  canonicalJson,
  listOutboxRows,
  setBindingBase,
  upsertBinding,
  upsertEnrollment,
} from '../sync-persistence.service';
import { resetSyncEngineForTests } from '../sync-engine.service';
import { createWorkspace, updateWorkspace } from '../workspace.service';
import { getSettings, updateSettings } from '../settings.service';

const SCOPE: SyncScope = {
  backendId: 'backend-1',
  accountId: 'account-1',
  datasetEpoch: SPIKE_DATASET_EPOCH,
};

function enroll(): void {
  upsertEnrollment({
    displayName: 'Test device',
    id: 'enrollment-1',
    installationId: 'installation-1',
    scope: SCOPE,
    state: 'active',
  });
}

function insertRepo(id: string, name: string): void {
  db.prepare(
    `INSERT INTO repos (id, name, path, remote_url, default_branch, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'main', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')`,
  ).run(id, name, `/repos/${id}`, `https://example.test/${name}.git`);
}

function getDefinitionState(workspaceId: string): string {
  const row = db
    .prepare('SELECT definition_state FROM workspaces WHERE id = ?')
    .get(workspaceId) as { definition_state: string };
  return row.definition_state;
}

beforeEach(() => {
  for (const table of [
    'editable_agents',
    'workspace_repo_definitions',
    'workspace_preferences',
    'workspace_repos',
    'workspaces',
    'workflow_templates',
    'repos',
    'sync_outbox',
    'sync_bindings',
    'sync_conflicts',
    'sync_scan_staging',
    'sync_scan_runs',
    'sync_state',
    'device_enrollments',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare('INSERT OR IGNORE INTO settings (id) VALUES (1)').run();
  resetSyncEngineForTests();
});

describe('entity type support', () => {
  it('recognizes all four synced entity types', () => {
    expect(isSupportedEntityType(SYNC_ENTITY_WORKFLOW_TEMPLATE)).toBe(true);
    expect(isSupportedEntityType(SYNC_ENTITY_EDITABLE_AGENT)).toBe(true);
    expect(isSupportedEntityType(SYNC_ENTITY_WORKSPACE_DEFINITION)).toBe(true);
    expect(isSupportedEntityType(SYNC_ENTITY_SETTINGS)).toBe(true);
    expect(isSupportedEntityType('future-entity')).toBe(false);
  });
});

describe('editable agents', () => {
  it('round-trips through save → payload → apply', () => {
    const saved = saveEditableAgent({
      name: 'Reviewer',
      description: 'Reviews code',
      promptBody: 'Review {{repo}} carefully.',
      capabilities: { canWriteFiles: false, canRunCommands: true, canReadFiles: true },
    });
    expect(getEditableAgent(saved.id)?.name).toBe('Reviewer');
    expect(listEditableAgents()).toHaveLength(1);

    const payload = buildEntityPayload(SYNC_ENTITY_EDITABLE_AGENT, saved.id) as Record<
      string,
      unknown
    >;
    expect(payload).not.toBeNull();
    expect(payload.name).toBe('Reviewer');
    expect(payload.promptBody).toBe('Review {{repo}} carefully.');
    expect(entityPayloadIssue(SYNC_ENTITY_EDITABLE_AGENT, payload)).toBeNull();

    // Apply the same payload under a different id (cross-device projection).
    applyRemoteEntityPayload(SYNC_ENTITY_EDITABLE_AGENT, 'remote-agent', payload);
    const projected = getEditableAgent('remote-agent');
    expect(projected?.name).toBe('Reviewer');
    expect(projected?.promptBody).toBe('Review {{repo}} carefully.');
    expect(projected?.capabilities.canWriteFiles).toBe(false);
  });

  it('emits synced writes through the outbox when bound', () => {
    enroll();
    const saved = saveEditableAgent({ name: 'Agent', promptBody: 'Do things.' });
    upsertBinding(SCOPE, SYNC_ENTITY_EDITABLE_AGENT, saved.id);

    saveEditableAgent({ name: 'Agent v2', promptBody: 'Do better.' }, saved.id);
    let rows = listOutboxRows(SCOPE).filter(
      (r) => r.entityType === SYNC_ENTITY_EDITABLE_AGENT && r.entityId === saved.id,
    );
    // First write while baseRevision is null normalizes to create.
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe('create');

    // Create + delete before first upload cancels the pending row entirely.
    deleteEditableAgent(saved.id);
    rows = listOutboxRows(SCOPE).filter(
      (r) => r.entityType === SYNC_ENTITY_EDITABLE_AGENT && r.entityId === saved.id,
    );
    expect(rows).toHaveLength(0);
    expect(getEditableAgent(saved.id)).toBeNull();
  });

  it('emits delete for an acknowledged entity', () => {
    enroll();
    const saved = saveEditableAgent({ name: 'Synced', promptBody: 'p' });
    upsertBinding(SCOPE, SYNC_ENTITY_EDITABLE_AGENT, saved.id);
    // Simulate an acknowledged create: binding carries a remote base revision.
    setBindingBase(
      SCOPE,
      SYNC_ENTITY_EDITABLE_AGENT,
      saved.id,
      7,
      canonicalJson({ id: saved.id, name: 'Synced' }),
    );

    deleteEditableAgent(saved.id);
    const rows = listOutboxRows(SCOPE).filter(
      (r) => r.entityType === SYNC_ENTITY_EDITABLE_AGENT && r.entityId === saved.id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe('delete');
    expect(rows[0].baseRevision).toBe(7);
  });

  it('rejects malformed remote payloads without writing a row', () => {
    expect(entityPayloadIssue(SYNC_ENTITY_EDITABLE_AGENT, { name: 'x' })).toBe('malformed-payload');
    expect(entityPayloadIssue(SYNC_ENTITY_EDITABLE_AGENT, 'nope')).toBe('malformed-payload');
    applyRemoteEntityPayload(SYNC_ENTITY_EDITABLE_AGENT, 'ghost', { name: '' });
    expect(getEditableAgent('ghost')).toBeNull();
  });

  it('deletes locally on remote delete', () => {
    const saved = saveEditableAgent({ name: 'Gone', promptBody: 'x' });
    deleteLocalEntity(SYNC_ENTITY_EDITABLE_AGENT, saved.id);
    expect(getEditableAgent(saved.id)).toBeNull();
  });

  it('persists a conflicted copy under a fresh id with a renamed label', () => {
    const saved = saveEditableAgent({ name: 'Mine', promptBody: 'local' });
    const copy = persistConflictCopy(SYNC_ENTITY_EDITABLE_AGENT, {
      id: saved.id,
      name: 'Mine',
      promptBody: 'local',
      description: '',
      icon: 'Bot',
      colour: '#fff',
      capabilities: {},
    });
    expect(copy).not.toBeNull();
    expect(copy!.entityId).not.toBe(saved.id);
    const copyRow = getEditableAgent(copy!.entityId);
    expect(copyRow?.name).toBe('Mine (local copy)');
    expect(copyRow?.promptBody).toBe('local');
  });
});

describe('workspace definitions', () => {
  it('serializes membership and preferences into the portable payload', () => {
    insertRepo('repo-1', 'anvil-app');
    insertRepo('repo-2', 'anvil-cloud');
    const ws = createWorkspace({ name: 'Anvil', repoIds: ['repo-1', 'repo-2'] });
    updateWorkspace(ws.id, { name: 'Anvil Mono' });
    db.prepare(
      `INSERT INTO workspace_preferences (workspace_id, workitems_json, docs_json, launch_json, updated_at)
       VALUES (?, ?, ?, '{}', '2024-01-01T00:00:00Z')
       ON CONFLICT(workspace_id) DO UPDATE SET
         workitems_json = excluded.workitems_json, docs_json = excluded.docs_json`,
    ).run(
      ws.id,
      JSON.stringify({ personaId: 'coder', workItemConnectionId: 'local-conn-secret' }),
      JSON.stringify({ label: 'Design docs', parentPageId: 'notion-local-page' }),
    );

    const payload = buildEntityPayload(SYNC_ENTITY_WORKSPACE_DEFINITION, ws.id) as Record<
      string,
      unknown
    >;
    expect(payload.name).toBe('Anvil Mono');
    const repos = payload.repos as Array<Record<string, unknown>>;
    expect(repos).toHaveLength(2);
    expect(repos.map((r) => r.name).sort()).toEqual(['anvil-app', 'anvil-cloud']);
    const prefs = payload.preferences as Record<string, unknown>;
    // Portable fields sync; device-local connector references never do.
    expect(prefs.workitems).toEqual({ personaId: 'coder' });
    expect(prefs.docs).toEqual({ label: 'Design docs' });
    expect(prefs.launch).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('local-conn-secret');
    expect(JSON.stringify(payload)).not.toContain('notion-local-page');
    expect(entityPayloadIssue(SYNC_ENTITY_WORKSPACE_DEFINITION, payload)).toBeNull();
  });

  it('merges remote prefs over local-only fields on apply', () => {
    const ws = createWorkspace({ name: 'W', repoIds: [] });
    db.prepare(
      `INSERT INTO workspace_preferences (workspace_id, workitems_json, docs_json, launch_json, updated_at)
       VALUES (?, ?, '{}', '{}', '2024-01-01T00:00:00Z')
       ON CONFLICT(workspace_id) DO UPDATE SET workitems_json = excluded.workitems_json`,
    ).run(ws.id, JSON.stringify({ workItemConnectionId: 'local-conn', personaId: 'coder' }));

    applyRemoteEntityPayload(SYNC_ENTITY_WORKSPACE_DEFINITION, ws.id, {
      id: ws.id,
      name: 'W',
      repos: [],
      preferences: { workitems: { iterationNames: ['Sprint 7'] } },
    });

    const row = db
      .prepare('SELECT workitems_json FROM workspace_preferences WHERE workspace_id = ?')
      .get(ws.id) as { workitems_json: string };
    const workitems = JSON.parse(row.workitems_json) as Record<string, unknown>;
    // Remote portable fields apply; local-only connection id is preserved; a
    // portable field absent remotely is dropped (remote is authoritative).
    expect(workitems.iterationNames).toEqual(['Sprint 7']);
    expect(workitems.workItemConnectionId).toBe('local-conn');
    expect(workitems.personaId).toBeUndefined();
  });

  it('applies a remote definition: repos unmapped → needs-setup; prefs land', () => {
    const payload = {
      id: 'ws-remote',
      name: 'Shared',
      repos: [
        { id: 'portable-1', name: 'anvil-app', remoteUrl: 'https://x/anvil.git' },
        { id: 'portable-2', name: 'anvil-cloud' },
      ],
      preferences: { workitems: { personaId: 'coder' } },
    };
    applyRemoteEntityPayload(SYNC_ENTITY_WORKSPACE_DEFINITION, 'ws-remote', payload);

    const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get('ws-remote') as {
      name: string;
      definition_state: string;
    };
    expect(ws.name).toBe('Shared');
    expect(ws.definition_state).toBe('needs-setup'); // unmapped portable repos

    const defs = db
      .prepare('SELECT * FROM workspace_repo_definitions WHERE workspace_id = ?')
      .all('ws-remote') as Array<{ portable_id: string; mapped_repo_id: string | null }>;
    expect(defs).toHaveLength(2);
    expect(defs.every((d) => d.mapped_repo_id === null)).toBe(true);

    const prefs = db
      .prepare('SELECT workitems_json FROM workspace_preferences WHERE workspace_id = ?')
      .get('ws-remote') as { workitems_json: string };
    expect(JSON.parse(prefs.workitems_json)).toEqual({ personaId: 'coder' });
  });

  it('marks ready once all portable repos map to local checkouts', () => {
    insertRepo('repo-local', 'anvil-app');
    const ws = createWorkspace({ name: 'W', repoIds: ['repo-local'] });
    expect(getDefinitionState(ws.id)).toBe('ready');

    // Simulate a remote update adding an unmapped repo.
    applyRemoteEntityPayload(SYNC_ENTITY_WORKSPACE_DEFINITION, ws.id, {
      id: ws.id,
      name: 'W',
      repos: [
        { id: 'portable-1', name: 'anvil-app' },
        { id: 'portable-new', name: 'elsewhere' },
      ],
    });
    expect(getDefinitionState(ws.id)).toBe('needs-setup');
  });

  it('flags needs-setup when a preference references an unknown persona', () => {
    const ws = createWorkspace({ name: 'W', repoIds: [] });
    db.prepare(
      `INSERT INTO workspace_preferences (workspace_id, workitems_json, docs_json, launch_json, updated_at)
       VALUES (?, ?, '{}', '{}', '2024-01-01T00:00:00Z')
       ON CONFLICT(workspace_id) DO UPDATE SET workitems_json = excluded.workitems_json`,
    ).run(ws.id, JSON.stringify({ personaId: 'nonexistent-persona' }));
    recomputeWorkspaceDefinitionState(ws.id);
    expect(getDefinitionState(ws.id)).toBe('needs-setup');
  });

  it('cascades remote deletes without leaving orphan rows', () => {
    insertRepo('repo-1', 'anvil-app');
    const ws = createWorkspace({ name: 'Doomed', repoIds: ['repo-1'] });
    deleteLocalEntity(SYNC_ENTITY_WORKSPACE_DEFINITION, ws.id);
    expect(db.prepare('SELECT id FROM workspaces WHERE id = ?').get(ws.id)).toBeUndefined();
    expect(
      db
        .prepare('SELECT workspace_id FROM workspace_repo_definitions WHERE workspace_id = ?')
        .all(ws.id),
    ).toHaveLength(0);
  });

  it('emits synced intent when a bound workspace is renamed', () => {
    enroll();
    const ws = createWorkspace({ name: 'W', repoIds: [] });
    upsertBinding(SCOPE, SYNC_ENTITY_WORKSPACE_DEFINITION, ws.id);
    updateWorkspace(ws.id, { name: 'Renamed' });
    const rows = listOutboxRows(SCOPE).filter(
      (r) => r.entityType === SYNC_ENTITY_WORKSPACE_DEFINITION && r.entityId === ws.id,
    );
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payloadJson as string) as { name: string };
    expect(payload.name).toBe('Renamed');
  });

  it('materializes definitions for pre-existing membership on bind', () => {
    insertRepo('repo-1', 'anvil-app');
    const ws = createWorkspace({ name: 'W', repoIds: ['repo-1'] });
    // createWorkspace already materialized; wipe and re-materialize to prove idempotence.
    db.prepare('DELETE FROM workspace_repo_definitions WHERE workspace_id = ?').run(ws.id);
    materializeRepoDefinitions(ws.id);
    materializeRepoDefinitions(ws.id);
    const defs = db
      .prepare(
        'SELECT portable_id, mapped_repo_id FROM workspace_repo_definitions WHERE workspace_id = ?',
      )
      .all(ws.id) as Array<{ portable_id: string; mapped_repo_id: string | null }>;
    expect(defs).toHaveLength(1);
    expect(defs[0].mapped_repo_id).toBe('repo-1');
  });

  it('round-trips a bootstrap recipe and drops malformed ones', () => {
    const ws = createWorkspace({ name: 'W', repoIds: [] });
    const recipe = {
      schemaVersion: 1,
      steps: [
        {
          id: 'install',
          kind: 'command',
          workingDirectory: '.',
          argv: ['pnpm', 'install'],
          timeoutMs: 60_000,
          envNames: [],
          retry: 'safe',
        },
      ],
    };
    db.prepare('UPDATE workspaces SET bootstrap_json = ? WHERE id = ?').run(
      JSON.stringify(recipe),
      ws.id,
    );
    const payload = buildEntityPayload(SYNC_ENTITY_WORKSPACE_DEFINITION, ws.id) as Record<
      string,
      unknown
    >;
    expect(payload.bootstrap).toEqual(recipe);
    expect(entityPayloadIssue(SYNC_ENTITY_WORKSPACE_DEFINITION, payload)).toBeNull();

    // Remote apply lands the recipe on the local row.
    applyRemoteEntityPayload(SYNC_ENTITY_WORKSPACE_DEFINITION, 'ws-boot', {
      id: 'ws-boot',
      name: 'B',
      repos: [],
      bootstrap: recipe,
    });
    const applied = db
      .prepare('SELECT bootstrap_json FROM workspaces WHERE id = ?')
      .get('ws-boot') as { bootstrap_json: string | null };
    expect(JSON.parse(applied.bootstrap_json!)).toEqual(recipe);

    // A malformed recipe (both argv and shell) is rejected at the boundary.
    expect(
      entityPayloadIssue(SYNC_ENTITY_WORKSPACE_DEFINITION, {
        id: 'ws-bad',
        name: 'Bad',
        repos: [],
        bootstrap: {
          schemaVersion: 1,
          steps: [
            {
              id: 'x',
              kind: 'command',
              workingDirectory: '.',
              argv: ['a'],
              shell: 'b',
              timeoutMs: 1,
              envNames: [],
              retry: 'safe',
            },
          ],
        },
      }),
    ).not.toBeNull();

    expect(
      entityPayloadIssue(SYNC_ENTITY_WORKSPACE_DEFINITION, {
        id: 'ws-traversal',
        name: 'Traversal',
        repos: [],
        bootstrap: {
          ...recipe,
          steps: [{ ...recipe.steps[0], workingDirectory: '../outside' }],
        },
      }),
    ).not.toBeNull();

    expect(
      entityPayloadIssue(SYNC_ENTITY_WORKSPACE_DEFINITION, {
        id: 'ws-windows-path',
        name: 'Windows path',
        repos: [],
        bootstrap: {
          ...recipe,
          steps: [{ ...recipe.steps[0], workingDirectory: 'C:\\outside' }],
        },
      }),
    ).not.toBeNull();
  });
});

describe('settings entity', () => {
  it('serializes only allowlisted fields and never secrets', () => {
    updateSettings({ theme: 'dark', openaiApiKey: 'sk-secret-123', adoPat: 'pat-456' });
    const payload = buildEntityPayload(SYNC_ENTITY_SETTINGS, SYNC_SETTINGS_ENTITY_ID) as Record<
      string,
      unknown
    >;
    const json = JSON.stringify(payload);
    expect(payload.id).toBe(SYNC_SETTINGS_ENTITY_ID);
    const fields = payload.fields as Record<string, unknown>;
    expect(fields.theme).toBe('dark');
    expect(SYNCED_SETTINGS_KEYS).not.toContain('openaiApiKey');
    expect(SYNCED_SETTINGS_KEYS).not.toContain('adoPat');
    expect(SYNCED_SETTINGS_KEYS).not.toContain('localLlmEndpoint');
    expect(SYNCED_SETTINGS_KEYS).not.toContain('defaultRepoPath');
    expect(json).not.toContain('sk-secret-123');
    expect(json).not.toContain('pat-456');
    expect(json).not.toContain('enc:'); // no ciphertext leaks either
  });

  it('emits sync intent only for allowlisted updates', () => {
    enroll();
    upsertBinding(SCOPE, SYNC_ENTITY_SETTINGS, SYNC_SETTINGS_ENTITY_ID);

    updateSettings({ adoPat: 'secret-pat' }); // not allowlisted
    expect(listOutboxRows(SCOPE).filter((r) => r.entityType === SYNC_ENTITY_SETTINGS)).toHaveLength(
      0,
    );

    updateSettings({ theme: 'merge-conflict' }); // allowlisted
    const rows = listOutboxRows(SCOPE).filter((r) => r.entityType === SYNC_ENTITY_SETTINGS);
    expect(rows).toHaveLength(1);
    expect(rows[0].entityId).toBe(SYNC_SETTINGS_ENTITY_ID);
  });

  it('applies only allowlisted remote fields and drops unknown keys', () => {
    applyRemoteEntityPayload(SYNC_ENTITY_SETTINGS, SYNC_SETTINGS_ENTITY_ID, {
      id: SYNC_SETTINGS_ENTITY_ID,
      fields: { theme: 'dark', githubPat: 'steal-me', mystery: true },
    });
    const settings = getSettings();
    expect(settings.theme).toBe('dark');
    const row = db.prepare('SELECT github_pat FROM settings WHERE id = 1').get() as {
      github_pat: Buffer | null;
    };
    expect(row.github_pat).toBeNull();
  });

  it('resets allowlisted fields to defaults on remote delete', () => {
    updateSettings({ theme: 'dark', codexMode: 'full-access' });
    deleteLocalEntity(SYNC_ENTITY_SETTINGS, SYNC_SETTINGS_ENTITY_ID);
    const settings = getSettings();
    expect(settings.theme).toBe('system');
    expect(settings.codexMode).toBe('on-request');
  });

  it('has no save-copy support (singleton)', () => {
    expect(persistConflictCopy(SYNC_ENTITY_SETTINGS, { fields: { theme: 'dark' } })).toBeNull();
  });
});

describe('canonical payloads', () => {
  it('serializes with sorted keys for stable hashing', () => {
    const saved = saveEditableAgent({
      name: 'Z',
      description: 'd',
      icon: 'Bot',
      colour: '#abc',
      promptBody: 'p',
    });
    const json = readEntityPayloadJson(SYNC_ENTITY_EDITABLE_AGENT, saved.id);
    expect(json).toBe(
      canonicalJson(
        buildEntityPayload(SYNC_ENTITY_EDITABLE_AGENT, saved.id) as Record<string, unknown>,
      ),
    );
    // Sorted: capabilities < colour < description < icon < id < name < promptBody
    const keys = Object.keys(JSON.parse(json!) as Record<string, unknown>);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe('listLocalEntityIds', () => {
  it('lists ids per type with the settings singleton', () => {
    saveEditableAgent({ name: 'A', promptBody: 'p' });
    createWorkspace({ name: 'W', repoIds: [] });
    expect(listLocalEntityIds(SYNC_ENTITY_EDITABLE_AGENT)).toHaveLength(1);
    expect(listLocalEntityIds(SYNC_ENTITY_WORKSPACE_DEFINITION)).toHaveLength(1);
    expect(listLocalEntityIds(SYNC_ENTITY_SETTINGS)).toEqual([SYNC_SETTINGS_ENTITY_ID]);
    expect(listLocalEntityIds('unknown-type')).toEqual([]);
  });
});
