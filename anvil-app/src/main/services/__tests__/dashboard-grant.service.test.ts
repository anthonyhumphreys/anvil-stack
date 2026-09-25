import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';

const rpcCalls = vi.hoisted(() => [] as Array<{ operation: string; params: unknown }>);

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').slice('enc:'.length),
  },
}));

vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../sync-backend-client.service.js', () => ({
  rpc: async <T>(_: unknown, operation: string, params: unknown): Promise<{ result: T }> => {
    rpcCalls.push({ operation, params });
    if (operation === 'dashboard.requests') return { result: { requests: [] } as T };
    if (operation === 'job.list') return { result: { jobs: [] } as T };
    return { result: { request: {} } as T };
  },
}));

import {
  approveDashboardRequest,
  configureDashboardGrantContext,
  dashboardCommandAssociatedData,
  listDashboardGrantWorkspaces,
  pumpBrowserWorkspaceCommands,
  resetDashboardGrantForTests,
} from '../dashboard-grant.service';
import { sealJsonEnvelope, wrapSecretBytes } from '../sync-keyring.service';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);

const scope = { backendId: 'backend-1', accountId: 'account-1', datasetEpoch: 'epoch-1' };
const expiry = new Date(Date.now() + 60_000).toISOString();

function insertWorkspace(): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, created_at, updated_at)
     VALUES (?, ?, datetime('now'), datetime('now'))`,
  ).run('workspace-1', 'Mission workspace');
  db.prepare(
    `INSERT INTO repos (id, name, path, default_branch, created_at, updated_at)
     VALUES (?, ?, ?, 'main', datetime('now'), datetime('now'))`,
  ).run('repo-1', 'Anvil', '/tmp/anvil');
  db.prepare(
    `INSERT INTO workspace_repos (workspace_id, repo_id, added_at)
     VALUES (?, ?, datetime('now'))`,
  ).run('workspace-1', 'repo-1');
}

function insertPendingGrant(requestId = 'request-1'): void {
  const request = {
    requestId,
    browserPub: randomBytes(32).toString('base64'),
    challenge: 'challenge',
    scopes: ['workspace-read', 'workspace-write'],
    expiresAt: expiry,
    state: 'pending',
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO mesh_dashboard_grants
      (backend_id, account_id, request_id, browser_pub, scopes_json, expires_at,
       state, request_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    scope.backendId,
    scope.accountId,
    requestId,
    request.browserPub,
    JSON.stringify(request.scopes),
    request.expiresAt,
    JSON.stringify(request),
    request.createdAt,
    request.createdAt,
  );
}

function insertApprovedGrant(dsk: Buffer, grantId = 'grant-1'): void {
  const request = {
    requestId: grantId,
    browserPub: randomBytes(32).toString('base64'),
    challenge: 'challenge',
    scopes: ['workspace-read'],
    expiresAt: expiry,
    state: 'approved',
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO mesh_dashboard_grants
      (backend_id, account_id, request_id, browser_pub, dsk_wrapped, scopes_json,
       workspace_id, repo_ids_json, enrollment_id, expires_at, seq, state,
       request_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'approved', ?, ?, ?)`,
  ).run(
    scope.backendId,
    scope.accountId,
    grantId,
    request.browserPub,
    wrapSecretBytes(dsk),
    JSON.stringify(request.scopes),
    'workspace-1',
    JSON.stringify(['repo-1']),
    'enrollment-1',
    expiry,
    JSON.stringify(request),
    request.createdAt,
    request.createdAt,
  );
}

beforeEach(() => {
  rpcCalls.length = 0;
  resetDashboardGrantForTests();
  db.exec(
    `DELETE FROM mesh_browser_command_receipts;
     DELETE FROM mesh_dashboard_grants;
     DELETE FROM workspace_repos;
     DELETE FROM repos;
     DELETE FROM workspaces;`,
  );
  insertWorkspace();
});

describe('dashboard grant workspace approval', () => {
  it('lists repository choices without exposing checkout paths', () => {
    expect(listDashboardGrantWorkspaces()).toEqual([
      {
        workspaceId: 'workspace-1',
        name: 'Mission workspace',
        repos: [{ repoId: 'repo-1', name: 'Anvil' }],
      },
    ]);
  });

  it('persists the explicit workspace, repo subset, and enrollment', async () => {
    insertPendingGrant();
    configureDashboardGrantContext(() => ({
      apiUrl: 'https://backend.test/v1',
      accessToken: 'token',
      enrollmentId: 'enrollment-1',
    }));

    await approveDashboardRequest(scope, 'request-1', {
      workspace: { workspaceId: 'workspace-1', repoIds: ['repo-1'] },
      scopes: ['workspace-read'],
    });

    const row = db
      .prepare(
        `SELECT state, workspace_id, repo_ids_json, enrollment_id, dsk_wrapped
         FROM mesh_dashboard_grants WHERE request_id = ?`,
      )
      .get('request-1') as Record<string, unknown>;
    expect(row.state).toBe('approved');
    expect(row.workspace_id).toBe('workspace-1');
    expect(JSON.parse(row.repo_ids_json as string)).toEqual(['repo-1']);
    expect(row.enrollment_id).toBe('enrollment-1');
    expect(row.dsk_wrapped).toBeInstanceOf(Buffer);
  });

  it('requires an explicit repository and rejects repositories outside the workspace', async () => {
    insertPendingGrant('request-missing-repo');
    configureDashboardGrantContext(() => ({
      apiUrl: 'https://backend.test/v1',
      accessToken: 'token',
      enrollmentId: 'enrollment-1',
    }));
    await expect(
      approveDashboardRequest(scope, 'request-missing-repo', {
        workspace: { workspaceId: 'workspace-1', repoIds: [] },
        scopes: ['workspace-read'],
      }),
    ).rejects.toThrow(/at least one repository/);

    insertPendingGrant('request-outside-repo');
    await expect(
      approveDashboardRequest(scope, 'request-outside-repo', {
        workspace: { workspaceId: 'workspace-1', repoIds: ['repo-other'] },
        scopes: ['workspace-read'],
      }),
    ).rejects.toThrow(/outside the selected workspace/);
  });
});

describe('browser workspace relay pump', () => {
  it('executes a command once and republishes a stored result on retry', async () => {
    const dsk = randomBytes(32);
    insertApprovedGrant(dsk);
    const sealedCommand = sealJsonEnvelope(
      dsk,
      dashboardCommandAssociatedData({
        backendId: scope.backendId,
        accountId: scope.accountId,
        requestId: 'grant-1',
        commandId: 'command-1',
        operation: 'workspace.get',
        workspaceId: 'workspace-1',
        repositoryId: 'repo-1',
        expiresAt: expiry,
      }),
      { path: 'README.md' },
    );
    const command = {
      v: 1 as const,
      enc: 'aes-256-gcm' as const,
      requestId: 'grant-1',
      commandId: 'command-1',
      operation: 'workspace.get' as const,
      workspaceId: 'workspace-1',
      repositoryId: 'repo-1',
      expiresAt: expiry,
      ...sealedCommand,
    };
    let executions = 0;
    const published: Array<{ status: string; result?: unknown; resultEnvelope?: unknown }> = [];
    let publicationAttempts = 0;
    let firstEnvelope: unknown;
    configureDashboardGrantContext(() => ({
      apiUrl: 'https://backend.test/v1',
      accessToken: 'token',
      enrollmentId: 'enrollment-1',
      pullBrowserWorkspaceCommands: async () => [command],
      revalidateBrowserWorkspaceGrant: async () => ({
        state: 'approved',
        expiresAt: expiry,
        enrollmentId: 'enrollment-1',
        workspace: { workspaceId: 'workspace-1', repoIds: ['repo-1'] },
        scopes: ['workspace-read'],
      }),
      executeBrowserWorkspaceCommand: async (input) => {
        executions += 1;
        expect(input.payload).toEqual({ path: 'README.md' });
        return { content: 'hello' };
      },
      publishBrowserWorkspaceCommandResult: async (_, __, result) => {
        publicationAttempts += 1;
        if (publicationAttempts === 1) {
          firstEnvelope = result.resultEnvelope;
          throw new Error('completion response lost');
        }
        published.push(result);
      },
    }));

    await pumpBrowserWorkspaceCommands(scope, () => true);
    await pumpBrowserWorkspaceCommands(scope, () => true);

    expect(executions).toBe(1);
    expect(publicationAttempts).toBe(2);
    expect(published.map((entry) => entry.status)).toEqual(['completed']);
    expect(published[0]?.resultEnvelope).toEqual(firstEnvelope);
    expect(published[0]?.resultEnvelope).toMatchObject({
      requestId: 'grant-1',
      commandId: 'command-1',
      operation: 'workspace.get' as const,
      workspaceId: 'workspace-1',
    });
  });

  it('persists an executor-declared failure and publishes it as failed', async () => {
    const dsk = randomBytes(32);
    insertApprovedGrant(dsk, 'grant-failed');
    const sealedCommand = sealJsonEnvelope(
      dsk,
      dashboardCommandAssociatedData({
        backendId: scope.backendId,
        accountId: scope.accountId,
        requestId: 'grant-failed',
        commandId: 'command-failed',
        operation: 'workspace.get',
        workspaceId: 'workspace-1',
        repositoryId: 'repo-1',
        expiresAt: expiry,
      }),
      {},
    );
    const command = {
      v: 1 as const,
      enc: 'aes-256-gcm' as const,
      requestId: 'grant-failed',
      commandId: 'command-failed',
      operation: 'workspace.get' as const,
      workspaceId: 'workspace-1',
      repositoryId: 'repo-1',
      expiresAt: expiry,
      ...sealedCommand,
    };
    const published: Array<{ status: string; resultEnvelope?: unknown }> = [];
    configureDashboardGrantContext(() => ({
      apiUrl: 'https://backend.test/v1',
      accessToken: 'token',
      enrollmentId: 'enrollment-1',
      pullBrowserWorkspaceCommands: async () => [command],
      revalidateBrowserWorkspaceGrant: async () => ({
        state: 'approved',
        expiresAt: expiry,
        enrollmentId: 'enrollment-1',
        workspace: { workspaceId: 'workspace-1', repoIds: ['repo-1'] },
        scopes: ['workspace-read'],
      }),
      executeBrowserWorkspaceCommand: async () => ({
        commandId: 'command-failed',
        ok: false,
        error: { code: 'forbidden', message: 'Denied by Desktop policy.' },
      }),
      publishBrowserWorkspaceCommandResult: async (_, __, result) => {
        published.push(result);
      },
    }));

    await pumpBrowserWorkspaceCommands(scope, () => true);

    expect(published[0]?.status).toBe('failed');
    expect(published[0]?.resultEnvelope).toBeDefined();
    expect(
      db
        .prepare(
          `SELECT state FROM mesh_browser_command_receipts
           WHERE grant_id = ? AND command_id = ?`,
        )
        .get('grant-failed', 'command-failed'),
    ).toEqual({ state: 'failed' });
  });

  it('turns an interrupted execution into an unknown outcome without replaying it', async () => {
    const dsk = randomBytes(32);
    insertApprovedGrant(dsk, 'grant-unknown');
    const sealedCommand = sealJsonEnvelope(
      dsk,
      dashboardCommandAssociatedData({
        backendId: scope.backendId,
        accountId: scope.accountId,
        requestId: 'grant-unknown',
        commandId: 'command-unknown',
        operation: 'workspace.get' as const,
        workspaceId: 'workspace-1',
        repositoryId: 'repo-1',
        expiresAt: expiry,
      }),
      {},
    );
    const command = {
      v: 1 as const,
      enc: 'aes-256-gcm' as const,
      requestId: 'grant-unknown',
      commandId: 'command-unknown',
      operation: 'workspace.get' as const,
      workspaceId: 'workspace-1',
      repositoryId: 'repo-1',
      expiresAt: expiry,
      ...sealedCommand,
    };
    db.prepare(
      `INSERT INTO mesh_browser_command_receipts
       (backend_id, account_id, grant_id, command_id, kind, workspace_id, repo_id,
        expires_at, payload_hash, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'executing', ?, ?)`,
    ).run(
      scope.backendId,
      scope.accountId,
      command.requestId,
      command.commandId,
      command.operation,
      command.workspaceId,
      command.repositoryId,
      expiry,
      'hash',
      new Date().toISOString(),
      new Date().toISOString(),
    );
    let executions = 0;
    const published: Array<{ status: string }> = [];
    configureDashboardGrantContext(() => ({
      apiUrl: 'https://backend.test/v1',
      accessToken: 'token',
      enrollmentId: 'enrollment-1',
      pullBrowserWorkspaceCommands: async () => [command],
      revalidateBrowserWorkspaceGrant: async () => ({
        state: 'approved',
        expiresAt: expiry,
        enrollmentId: 'enrollment-1',
        workspace: { workspaceId: 'workspace-1', repoIds: ['repo-1'] },
        scopes: ['workspace-read'],
      }),
      executeBrowserWorkspaceCommand: async () => {
        executions += 1;
        return {};
      },
      publishBrowserWorkspaceCommandResult: async (_, __, result) => {
        published.push(result);
      },
    }));

    await pumpBrowserWorkspaceCommands(scope, () => true);

    expect(executions).toBe(0);
    expect(published).toEqual([
      {
        status: 'uncertain',
        error: 'Desktop restarted or lost the command worker before the outcome was recorded.',
      },
    ]);
  });
});
