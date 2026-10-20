import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import type { ExecutionManifest } from '../../../../cloud/contract/jobs';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));

import {
  installTaskWorkspaceDefinition,
  remoteWorkspaceDefinition,
} from '../mesh-workspace-input.service';
import { workspaceDefinitionRevision } from '../sync-entity-domain';

beforeEach(() => {
  db.exec('DELETE FROM workspace_repo_definitions; DELETE FROM workspaces;');
  db.prepare(
    "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('workspace-task', 'Task workspace', datetime('now'), datetime('now'))",
  ).run();
  db.prepare(
    `INSERT INTO workspace_repo_definitions
    (workspace_id, portable_id, name, remote_url, default_branch, created_at, updated_at)
    VALUES ('workspace-task', 'repo-task', 'Repository', 'https://github.com/example/repository.git', 'main', datetime('now'), datetime('now'))`,
  ).run();
});

function taskManifest(): ExecutionManifest {
  return {
    workspaceDefinitionRevision: workspaceDefinitionRevision('workspace-task')!,
    repositories: [{ repositoryId: 'repo-task', commit: 'a'.repeat(40) }],
    bootstrapDigest: 'none',
    provider: 'codex',
    model: 'default',
    configVersions: {},
    inputs: {
      workspaceId: 'workspace-task',
      workspaceDefinition: remoteWorkspaceDefinition('workspace-task'),
    },
  };
}

describe('task-scoped cloud workspace definitions', () => {
  it('installs a fresh definition from task data without an account sync key', () => {
    const manifest = taskManifest();
    db.prepare("DELETE FROM workspaces WHERE id = 'workspace-task'").run();
    expect(workspaceDefinitionRevision('workspace-task')).toBeNull();
    installTaskWorkspaceDefinition(manifest);
    expect(workspaceDefinitionRevision('workspace-task')).toBe(
      manifest.workspaceDefinitionRevision,
    );
    expect(
      db
        .prepare(
          "SELECT remote_url, mapped_repo_id FROM workspace_repo_definitions WHERE portable_id = 'repo-task'",
        )
        .get(),
    ).toEqual({
      remote_url: 'https://github.com/example/repository.git',
      mapped_repo_id: null,
    });
    expect(
      db.prepare("SELECT sync_selected FROM workspaces WHERE id = 'workspace-task'").get(),
    ).toEqual({ sync_selected: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM sync_bindings').get()).toEqual({ count: 0 });
  });

  it('keeps an identical local definition local without creating a Sync association', () => {
    const manifest = taskManifest();
    installTaskWorkspaceDefinition(manifest);

    expect(workspaceDefinitionRevision('workspace-task')).toBe(
      manifest.workspaceDefinitionRevision,
    );
    expect(
      db.prepare("SELECT sync_selected FROM workspaces WHERE id = 'workspace-task'").get(),
    ).toEqual({ sync_selected: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM sync_bindings').get()).toEqual({ count: 0 });
  });

  it('rejects altered task definitions before changing local state', () => {
    const manifest = taskManifest();
    (manifest.inputs.workspaceDefinition as Record<string, unknown>).name = 'Changed';
    expect(() => installTaskWorkspaceDefinition(manifest)).toThrow(
      'task-workspace-definition-pin-mismatch',
    );
    expect(workspaceDefinitionRevision('workspace-task')).toBe(
      manifest.workspaceDefinitionRevision,
    );
  });

  it('does not overwrite a different local definition from task inputs', () => {
    const manifest = taskManifest();
    db.prepare("UPDATE workspaces SET name = 'Local change' WHERE id = 'workspace-task'").run();
    const localRevision = workspaceDefinitionRevision('workspace-task');
    expect(() => installTaskWorkspaceDefinition(manifest)).toThrow(
      'task-workspace-definition-conflicts-with-local-workspace',
    );
    expect(workspaceDefinitionRevision('workspace-task')).toBe(localRevision);
  });

  it('rejects a definition for a different workspace', () => {
    const manifest = taskManifest();
    manifest.inputs.workspaceId = 'other-workspace';
    expect(() => installTaskWorkspaceDefinition(manifest)).toThrow(
      'task-workspace-definition-invalid',
    );
  });
});
