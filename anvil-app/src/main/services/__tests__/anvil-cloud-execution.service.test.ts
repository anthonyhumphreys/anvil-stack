import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema.js';

const inMemoryDb = new Database(':memory:');
inMemoryDb.pragma('foreign_keys = ON');
inMemoryDb.exec(SCHEMA_SQL);

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('node:child_process', () => ({ execFile: execFileMock }));
vi.mock('../../db/database.js', () => ({ getDb: () => inMemoryDb }));
vi.mock('../auth.service.js', () => ({
  encryptSecret: (value: string) => Buffer.from(`encrypted:${value}`),
  decryptSecret: (value: Buffer | null) =>
    value?.toString().replace(/^encrypted:/, '') ?? undefined,
}));

import {
  getAnvilCloudExecutionConnection,
  listAnvilCloudExecutions,
  saveAnvilCloudExecutionConnection,
  startAnvilCloudExecution,
} from '../anvil-cloud-execution.service.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  inMemoryDb.exec('DELETE FROM cloud_execution_connection');
  inMemoryDb.exec('DELETE FROM workspace_repos');
  inMemoryDb.exec('DELETE FROM repos');
  inMemoryDb.exec('DELETE FROM workspaces');
  inMemoryDb
    .prepare(
      `INSERT INTO workspaces (id, name, created_at, updated_at)
       VALUES ('workspace-1', 'Workspace', datetime('now'), datetime('now'))`,
    )
    .run();
  inMemoryDb
    .prepare(
      `INSERT INTO repos (
        id, name, path, remote_url, default_branch, status,
        file_count, branch_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'main', 'connected', 1, 1, datetime('now'), datetime('now'))`,
    )
    .run('repo-1', 'repository', '/tmp/repository', 'https://github.com/example/repository.git');
  inMemoryDb
    .prepare(
      `INSERT INTO workspace_repos (workspace_id, repo_id, added_at)
       VALUES (?, ?, datetime('now'))`,
    )
    .run('workspace-1', 'repo-1');
});

describe('Anvil Cloud remote execution service', () => {
  it('stores encrypted connection state and never returns its bearer token', () => {
    const connection = saveAnvilCloudExecutionConnection({
      endpoint: 'https://cloud.example.test/',
      token: 'a-secure-control-token',
    });
    const stored = inMemoryDb
      .prepare('SELECT token FROM cloud_execution_connection WHERE id = 1')
      .get() as { token: Buffer };

    expect(connection).toMatchObject({
      configured: true,
      endpoint: 'https://cloud.example.test',
      tokenConfigured: true,
    });
    expect(connection).not.toHaveProperty('token');
    expect(stored.token.toString()).toBe('encrypted:a-secure-control-token');
  });

  it('rejects plaintext remote endpoints while allowing loopback development', () => {
    expect(() =>
      saveAnvilCloudExecutionConnection({
        endpoint: 'http://cloud.example.test',
        token: 'a-secure-control-token',
      }),
    ).toThrow('must use HTTPS');

    expect(
      saveAnvilCloudExecutionConnection({
        endpoint: 'http://127.0.0.1:4764',
        token: 'a-secure-control-token',
      }).configured,
    ).toBe(true);
  });

  it('does not reuse a saved bearer when the execution endpoint changes', () => {
    saveAnvilCloudExecutionConnection({
      endpoint: 'https://cloud-a.example.test',
      token: 'a-secure-control-token',
    });

    expect(() =>
      saveAnvilCloudExecutionConnection({ endpoint: 'https://cloud-b.example.test' }),
    ).toThrow('Enter a new bearer token');
  });

  it('uses the decrypted token only at the privileged HTTP boundary', async () => {
    saveAnvilCloudExecutionConnection({
      endpoint: 'https://cloud.example.test',
      token: 'a-secure-control-token',
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ executions: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(listAnvilCloudExecutions()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloud.example.test/v1/executions',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer a-secure-control-token',
        }),
      }),
    );
    expect(JSON.stringify(getAnvilCloudExecutionConnection())).not.toContain(
      'a-secure-control-token',
    );
  });

  it('archives committed files, uploads a snapshot, and starts a read-only lease', async () => {
    saveAnvilCloudExecutionConnection({
      endpoint: 'https://cloud.example.test',
      token: 'a-secure-control-token',
    });
    execFileMock.mockImplementation((_command, args, _options, callback) => {
      if (args.includes('archive')) {
        callback(null, Buffer.from('tar archive'), Buffer.alloc(0));
        return;
      }
      if (args.includes('rev-parse')) callback(null, `${'a'.repeat(40)}\n`, '');
      else if (args.includes('branch')) callback(null, 'main\n', '');
      else if (args.includes('status')) callback(null, ' M README.md\n', '');
      else callback(new Error('Unexpected git command'), '', '');
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          snapshot: {
            kind: 'snapshot',
            snapshotId: `snap_${'b'.repeat(64)}`,
            sha256: 'b'.repeat(64),
            sizeBytes: 11,
            baseCommit: 'a'.repeat(40),
            selection: {
              includesWorkingTreePatch: false,
              excluded: [
                'git-metadata',
                'ignored-files',
                'secret-files',
                'unrelated-untracked-files',
              ],
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          execution: {
            schemaVersion: '0.1',
            id: 'exec-1',
            status: 'running',
            provider: 'fake-execution',
            request: {
              workspace: 'workspace-1',
              task: 'Inspect this repository.',
              cell: 'repository',
              environment: 'desktop-session',
              policy: { mode: 'read-only', ttlSeconds: 3600 },
              source: { kind: 'snapshot', baseCommit: 'a'.repeat(40) },
            },
            createdAt: '2026-08-10T10:00:00.000Z',
            updatedAt: '2026-08-10T10:00:00.000Z',
            expiresAt: '2026-08-10T11:00:00.000Z',
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await startAnvilCloudExecution({
      workspaceId: 'workspace-1',
      repoId: 'repo-1',
      task: 'Inspect this repository.',
      provider: 'auto',
    });
    const executionBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string) as {
      policy: { mode: string };
      source: { kind: string };
      modelAuth: { kind: string; provider?: string };
    };

    expect(result).toMatchObject({
      execution: { id: 'exec-1' },
      source: { excludedWorkingTreeChanges: true, archiveBytes: 11 },
    });
    expect(executionBody).toMatchObject({
      policy: { mode: 'read-only' },
      source: { kind: 'snapshot' },
      modelAuth: { kind: 'provider-subscription', provider: 'codex' },
    });
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['archive', '--format=tar', 'HEAD', ':(exclude)**/.env']),
      expect.objectContaining({ encoding: 'buffer' }),
      expect.any(Function),
    );
  });
});
