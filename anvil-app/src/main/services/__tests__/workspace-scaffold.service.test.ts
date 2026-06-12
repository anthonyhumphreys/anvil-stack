import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../db/schema.js';

const inMemoryDb = new Database(':memory:');
inMemoryDb.exec(SCHEMA_SQL);

const { mockScanForRepos, mockConnectRepoPath, mockIndexRepo, mockAddReposToWorkspace } =
  vi.hoisted(() => ({
    mockScanForRepos: vi.fn(),
    mockConnectRepoPath: vi.fn(),
    mockIndexRepo: vi.fn(),
    mockAddReposToWorkspace: vi.fn(),
  }));

vi.mock('../../db/database.js', () => ({
  getDb: () => inMemoryDb,
}));

vi.mock('../repo-scan.service.js', () => ({
  scanForRepos: mockScanForRepos,
}));

vi.mock('../repo-connect.service.js', () => ({
  connectRepoPath: mockConnectRepoPath,
}));

vi.mock('../repo-index.service.js', () => ({
  indexRepo: mockIndexRepo,
}));

vi.mock('../workspace.service.js', () => ({
  addReposToWorkspace: mockAddReposToWorkspace,
}));

import {
  getWorkspaceScaffoldSession,
  maybeCompleteWorkspaceScaffold,
  parseWorkspaceScaffoldCompletion,
  startWorkspaceScaffoldSession,
} from '../workspace-scaffold.service.js';

function seedWorkspace(workspaceId: string): void {
  inMemoryDb
    .prepare(
      `INSERT INTO workspaces (id, name, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))`,
    )
    .run(workspaceId, 'Workspace');

  inMemoryDb
    .prepare(
      `INSERT INTO workspace_preferences (workspace_id, workitems_json, docs_json, launch_json, updated_at)
       VALUES (?, '{}', '{}', '{}', datetime('now'))`,
    )
    .run(workspaceId);
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  inMemoryDb.exec('DELETE FROM workspace_scaffold_sessions');
  inMemoryDb.exec('DELETE FROM workspace_preferences');
  inMemoryDb.exec('DELETE FROM workspaces');
  vi.clearAllMocks();
});

describe('parseWorkspaceScaffoldCompletion', () => {
  it('extracts the completion payload from the assistant marker block', () => {
    const payload = parseWorkspaceScaffoldCompletion(`
Done.
[[DEVHUB_SCAFFOLD_COMPLETE]]
{"repos":[{"name":"orders-service","path":"/tmp/devhub/orders-service"}]}
[[/DEVHUB_SCAFFOLD_COMPLETE]]
`);

    expect(payload).toEqual({
      repos: [{ name: 'orders-service', path: '/tmp/devhub/orders-service' }],
    });
  });

  it('returns null when the marker block is missing or malformed', () => {
    expect(parseWorkspaceScaffoldCompletion('No marker here')).toBeNull();
    expect(
      parseWorkspaceScaffoldCompletion(`
[[DEVHUB_SCAFFOLD_COMPLETE]]
{"repos":[]}
[[/DEVHUB_SCAFFOLD_COMPLETE]]
`),
    ).toBeNull();
  });
});

describe('maybeCompleteWorkspaceScaffold', () => {
  it('ignores assistant messages that do not contain the completion marker', () => {
    seedWorkspace('ws-1');
    startWorkspaceScaffoldSession('ws-1', '/tmp/devhub-root');

    const result = maybeCompleteWorkspaceScaffold('ws-1', 'Still scaffolding...');

    expect(result).toEqual({ triggered: false });
    expect(getWorkspaceScaffoldSession('ws-1')?.status).toBe('active');
  });

  it('syncs, connects, and indexes scaffolded repos once completion is inferred', async () => {
    seedWorkspace('ws-2');
    startWorkspaceScaffoldSession('ws-2', '/tmp/devhub-root');

    mockScanForRepos.mockReturnValue([{ path: '/tmp/devhub-root/orders-service' }]);
    mockConnectRepoPath.mockResolvedValue({
      id: 'repo-1',
      name: 'orders-service',
      path: '/tmp/devhub-root/orders-service',
      defaultBranch: 'main',
      languages: [],
      status: 'connected',
      fileCount: 0,
      branchCount: 0,
    });
    mockIndexRepo.mockResolvedValue(undefined);

    const result = maybeCompleteWorkspaceScaffold(
      'ws-2',
      `
[[DEVHUB_SCAFFOLD_COMPLETE]]
{"repos":[{"name":"orders-service","path":"/tmp/devhub-root/orders-service"}]}
[[/DEVHUB_SCAFFOLD_COMPLETE]]
`,
    );

    expect(result).toEqual({ triggered: true });
    expect(getWorkspaceScaffoldSession('ws-2')?.status).toBe('syncing');

    await flushAsyncWork();

    expect(mockConnectRepoPath).toHaveBeenCalledWith('/tmp/devhub-root/orders-service');
    expect(mockAddReposToWorkspace).toHaveBeenCalledWith('ws-2', ['repo-1']);
    expect(mockIndexRepo).toHaveBeenCalledWith('repo-1');
    expect(getWorkspaceScaffoldSession('ws-2')?.status).toBe('completed');
  });
});

describe('startWorkspaceScaffoldSession', () => {
  it('creates the scaffold root folder when it does not exist yet', () => {
    seedWorkspace('ws-3');
    const parentDir = mkdtempSync(path.join(tmpdir(), 'devhub-scaffold-'));
    const rootPath = path.join(parentDir, 'new-workspace-root');

    startWorkspaceScaffoldSession('ws-3', rootPath);

    expect(existsSync(rootPath)).toBe(true);
    rmSync(parentDir, { recursive: true, force: true });
  });

  it('rejects a non-empty existing scaffold folder', () => {
    seedWorkspace('ws-4');
    const parentDir = mkdtempSync(path.join(tmpdir(), 'devhub-scaffold-'));
    const rootPath = path.join(parentDir, 'existing-root');

    startWorkspaceScaffoldSession('ws-4', rootPath);
    writeFileSync(path.join(rootPath, 'README.md'), '# occupied');

    expect(() => startWorkspaceScaffoldSession('ws-4', rootPath)).toThrow(
      'The scaffold folder already exists and is not empty.',
    );

    rmSync(parentDir, { recursive: true, force: true });
  });
});
