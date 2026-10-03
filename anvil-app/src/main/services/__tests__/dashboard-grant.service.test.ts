import Database from 'better-sqlite3';
import { createHmac, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';

const rpcState = vi.hoisted(() => ({
  calls: [] as Array<{ operation: string; params: unknown }>,
  requests: [] as unknown[],
  secureStorageAvailable: true,
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => rpcState.secureStorageAvailable,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').slice('enc:'.length),
  },
}));

vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../sync-backend-client.service.js', () => ({
  rpc: async <T>(_: unknown, operation: string, params: unknown): Promise<{ result: T }> => {
    rpcState.calls.push({ operation, params });
    if (operation === 'dashboard.requests') {
      return { result: { requests: rpcState.requests } as T };
    }
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
  revokeDashboardGrant,
  resetDashboardGrantForTests,
  serviceDashboardGrants,
} from '../dashboard-grant.service';
import {
  dashboardRenewalProofMessage,
  type DashboardRequest,
  type DashboardScope,
} from '../../../../cloud/contract/dashboard';
import { sealJsonEnvelope, unwrapSecretBytes, wrapSecretBytes } from '../sync-keyring.service';

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

function insertPendingGrant(
  requestId = 'request-1',
  overrides: Partial<DashboardRequest> = {},
): DashboardRequest {
  const request = {
    requestId,
    browserPub: randomBytes(32).toString('base64'),
    challenge: 'challenge',
    scopes: ['workspace-read', 'workspace-write'],
    expiresAt: expiry,
    state: 'pending',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as DashboardRequest;
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
  return request;
}

function configureApprovalContext(enrollmentId = 'enrollment-1'): void {
  configureDashboardGrantContext(() => ({
    apiUrl: 'https://backend.test/v1',
    accessToken: 'token',
    enrollmentId,
  }));
}

async function createRememberedTrust(): Promise<{
  trustId: string;
  browserPub: string;
  origin: string;
  targetEnrollmentId: string;
  challenge: string;
  expiresAt: string;
  workspaceBindings: Array<{ workspaceId: string; repositoryIds: string[] }>;
  scopes: DashboardScope[];
  proofKey: Buffer;
}> {
  const browserPub = randomBytes(32).toString('base64');
  const origin = 'https://anvil.dev';
  const targetEnrollmentId = 'enrollment-1';
  const challenge = 'first-pairing-challenge';
  insertPendingGrant('pairing-remembered', {
    browserPub,
    origin,
    targetEnrollmentId,
    challenge,
    scopes: [],
    workspaceBindings: [],
  });
  configureApprovalContext();
  const result = await approveDashboardRequest(scope, 'pairing-remembered', {
    workspace: { workspaceId: 'workspace-1', repoIds: ['repo-1'] },
    scopes: ['workspace-write', 'submit-task'],
    rememberBrowser: true,
  });
  expect(result).toEqual({
    decision: 'approved',
    rememberedBrowser: true,
    sessionOnly: false,
  });
  const trust = db
    .prepare(
      `SELECT trust_id, proof_key_wrapped, origin, target_enrollment_id,
              workspace_bindings_json, scopes_json, expires_at
       FROM mesh_dashboard_browser_trusts WHERE backend_id = ? AND account_id = ?`,
    )
    .get(scope.backendId, scope.accountId) as {
    trust_id: string;
    proof_key_wrapped: Buffer;
    origin: string;
    target_enrollment_id: string;
    workspace_bindings_json: string;
    scopes_json: string;
    expires_at: string;
  };
  const proofKey = unwrapSecretBytes(trust.proof_key_wrapped);
  if (proofKey === null) throw new Error('The remembered renewal key was not persisted.');
  expect(Date.parse(trust.expires_at)).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
  expect(trust.origin).toBe(origin);
  expect(trust.target_enrollment_id).toBe(targetEnrollmentId);
  return {
    trustId: trust.trust_id,
    browserPub,
    origin,
    targetEnrollmentId,
    challenge,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    workspaceBindings: JSON.parse(trust.workspace_bindings_json) as Array<{
      workspaceId: string;
      repositoryIds: string[];
    }>,
    scopes: JSON.parse(trust.scopes_json) as DashboardScope[],
    proofKey,
  };
}

type SignedRenewalRequest = DashboardRequest &
  Required<
    Pick<DashboardRequest, 'trustId' | 'origin' | 'targetEnrollmentId' | 'workspaceBindings'>
  >;

function renewalRequest(
  trusted: Awaited<ReturnType<typeof createRememberedTrust>>,
  requestId: string,
  changes: {
    accountId?: string;
    browserPub?: string;
    origin?: string;
    targetEnrollmentId?: string;
    expiresAt?: string;
    scopes?: DashboardScope[];
    proofKey?: Buffer;
  } = {},
): SignedRenewalRequest {
  const request: SignedRenewalRequest = {
    requestId,
    trustId: trusted.trustId,
    browserPub: changes.browserPub ?? trusted.browserPub,
    origin: changes.origin ?? trusted.origin,
    targetEnrollmentId: changes.targetEnrollmentId ?? trusted.targetEnrollmentId,
    challenge: `challenge-${requestId}`,
    expiresAt: changes.expiresAt ?? trusted.expiresAt,
    workspaceBindings: trusted.workspaceBindings,
    scopes: changes.scopes ?? trusted.scopes,
    state: 'pending',
    createdAt: new Date().toISOString(),
  };
  const proofMessage = dashboardRenewalProofMessage({
    accountId: changes.accountId ?? scope.accountId,
    requestId,
    trustId: request.trustId,
    browserPub: request.browserPub,
    origin: request.origin,
    targetEnrollmentId: request.targetEnrollmentId,
    challenge: request.challenge,
    expiresAt: request.expiresAt,
    workspaceBindings: request.workspaceBindings,
    scopes: request.scopes,
  });
  return {
    ...request,
    renewalProof: createHmac('sha256', changes.proofKey ?? trusted.proofKey)
      .update(proofMessage, 'utf8')
      .digest('base64'),
  };
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
  rpcState.calls.length = 0;
  rpcState.requests.length = 0;
  rpcState.secureStorageAvailable = true;
  resetDashboardGrantForTests();
  db.exec(
    `DELETE FROM mesh_browser_command_receipts;
     DELETE FROM mesh_dashboard_grants;
     DELETE FROM mesh_dashboard_browser_trusts;
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

describe('remembered browser trust', () => {
  it('remembers a first machine pairing while keeping its DSK and renewal proof sealed', async () => {
    const trusted = await createRememberedTrust();
    const row = db
      .prepare(
        `SELECT state, scopes_json, dsk_wrapped, trust_id FROM mesh_dashboard_grants
         WHERE backend_id = ? AND account_id = ? AND request_id = ?`,
      )
      .get(scope.backendId, scope.accountId, 'pairing-remembered') as {
      state: string;
      scopes_json: string;
      dsk_wrapped: Buffer;
      trust_id: string;
    };
    const decision = rpcState.calls.find((call) => call.operation === 'dashboard.decide');
    const params = decision?.params as Record<string, unknown>;
    const browserTrust = params['browserTrust'] as Record<string, unknown>;

    expect(row.state).toBe('approved');
    expect(JSON.parse(row.scopes_json)).toEqual([
      'workspace-read',
      'workspace-write',
      'submit-task',
    ]);
    expect(row.dsk_wrapped).toBeInstanceOf(Buffer);
    expect(row.trust_id).toBe(trusted.trustId);
    expect(Object.keys(browserTrust).sort()).toEqual(['expiresAt', 'trustId']);
    expect(browserTrust.trustId).toBe(trusted.trustId);
    expect((params['grant'] as Record<string, unknown>)['ct']).toEqual(expect.any(String));
    expect(params).not.toHaveProperty('proofKey');
    expect(params).not.toHaveProperty('browserTrust.proofKey');
  });

  it('falls back to a session-only approval when secure storage is unavailable', async () => {
    rpcState.secureStorageAvailable = false;
    insertPendingGrant('pairing-temporary', {
      browserPub: randomBytes(32).toString('base64'),
      origin: 'https://anvil.dev',
      targetEnrollmentId: 'enrollment-1',
      scopes: [],
      workspaceBindings: [],
    });
    configureApprovalContext();

    const result = await approveDashboardRequest(scope, 'pairing-temporary', {
      workspace: { workspaceId: 'workspace-1', repoIds: ['repo-1'] },
      scopes: [],
      rememberBrowser: true,
    });

    expect(result).toEqual({
      decision: 'approved',
      rememberedBrowser: false,
      sessionOnly: true,
      sessionOnlyReason: 'secure-storage-unavailable',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM mesh_dashboard_browser_trusts').get()).toEqual(
      { count: 0 },
    );
    expect(
      db
        .prepare('SELECT dsk_wrapped FROM mesh_dashboard_grants WHERE request_id = ?')
        .get('pairing-temporary'),
    ).toEqual({ dsk_wrapped: null });
    const decision = rpcState.calls.find((call) => call.operation === 'dashboard.decide');
    expect(decision?.params).not.toHaveProperty('browserTrust');
  });

  it.each([
    { name: 'account', change: { accountId: 'account-other' } },
    { name: 'origin', change: { origin: 'https://other.example' } },
    { name: 'browser key', change: { browserPub: randomBytes(32).toString('base64') } },
    { name: 'target enrollment', change: { targetEnrollmentId: 'enrollment-other' } },
    { name: 'scopes', change: { scopes: ['workspace-read'] as DashboardScope[] } },
    { name: 'proof key', change: { proofKey: randomBytes(32) } },
    {
      name: 'expiry',
      change: { expiresAt: new Date(Date.now() - 1_000).toISOString() },
    },
  ])('denies a renewal with a mismatched $name', async ({ change }) => {
    const trusted = await createRememberedTrust();
    const request = renewalRequest(trusted, `renewal-${Math.random()}`, change);
    rpcState.requests = [request];

    await serviceDashboardGrants(scope, () => true);

    expect(
      db
        .prepare('SELECT state FROM mesh_dashboard_grants WHERE request_id = ?')
        .get(request.requestId),
    ).toEqual({ state: 'denied' });
    expect(rpcState.calls.filter((call) => call.operation === 'dashboard.decide')).toHaveLength(2); // initial approval, then fail-closed renewal denial
  });

  it('does not replay an already-approved renewal request', async () => {
    const trusted = await createRememberedTrust();
    const request = renewalRequest(trusted, 'renewal-replay');
    rpcState.requests = [request];

    await serviceDashboardGrants(scope, () => true);
    await serviceDashboardGrants(scope, () => true);

    expect(
      db
        .prepare('SELECT state FROM mesh_dashboard_grants WHERE request_id = ?')
        .get(request.requestId),
    ).toEqual({ state: 'approved' });
    expect(
      rpcState.calls.filter(
        (call) =>
          call.operation === 'dashboard.decide' &&
          (call.params as Record<string, unknown>)['requestId'] === request.requestId,
      ),
    ).toHaveLength(1);
  });

  it('revokes the complete browser trust and every grant attached to it', async () => {
    const trusted = await createRememberedTrust();

    await revokeDashboardGrant(scope, 'pairing-remembered');

    expect(
      db
        .prepare('SELECT state FROM mesh_dashboard_browser_trusts WHERE trust_id = ?')
        .get(trusted.trustId),
    ).toEqual({ state: 'revoked' });
    expect(
      db.prepare('SELECT state FROM mesh_dashboard_grants WHERE trust_id = ?').get(trusted.trustId),
    ).toEqual({ state: 'revoked' });
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
