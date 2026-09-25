import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceOperation,
} from '../../../../cloud/contract/browser-workspace';
import { SCHEMA_SQL } from '../../db/schema';

/**
 * Local cross-component acceptance only. The SQLite profile, grant pump,
 * browser-workspace executor, filesystem, and git client are real. The
 * backend RPC is a deterministic transport fixture and the Codex provider
 * process is mocked; this does not claim a live WorkOS/provider success path.
 */

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);

const rpc = vi.hoisted(() => vi.fn());
const provider = vi.hoisted(() => ({
  eventListener: undefined as ((payload: unknown) => void) | undefined,
  getCodexSession: vi.fn(),
  claimSessionForBrowser: vi.fn(),
  listActiveCodexSessions: vi.fn(() => []),
  listPendingApprovalRequests: vi.fn(() => []),
  subscribeToCodexEvents: vi.fn((listener: (payload: unknown) => void) => {
    provider.eventListener = listener;
    return () => undefined;
  }),
  startSession: vi.fn(),
  sendMessage: vi.fn(),
  interruptTurn: vi.fn(),
  stopSession: vi.fn(),
  resolveApproval: vi.fn(),
  resolveInputRequest: vi.fn(),
}));
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../sync-backend-client.service.js', () => ({ rpc }));
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf8').slice('enc:'.length),
  },
  BrowserWindow: class {},
  dialog: {},
}));
vi.mock('../codex-session.service.js', () => provider);

import {
  approveDashboardRequest,
  configureDashboardGrantContext,
  pumpBrowserWorkspaceCommands,
  resetDashboardGrantForTests,
  type DashboardCommandResult,
  type DashboardGrantContext,
  type DashboardGrantCommandExecutorInput,
  type DashboardWorkspaceCommand,
} from '../dashboard-grant.service';
import { executeBrowserWorkspaceCommand } from '../browser-workspace-executor.service';
import { unwrapSecretBytes } from '../sync-keyring.service';
const WEBSITE_CRYPTO_MODULE = pathToFileURL(
  path.resolve(process.cwd(), '../anvil-website/lib/mesh-crypto.ts'),
).href;
type WebsiteCrypto = {
  generateBrowserKeypair: () => { priv: Uint8Array; pub: Uint8Array };
  openBrowserWorkspaceResult: (
    dsk: Uint8Array,
    envelope: unknown,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
  sealBrowserWorkspaceCommand: (
    dsk: Uint8Array,
    input: Record<string, unknown>,
  ) => Promise<DashboardWorkspaceCommand>;
};

async function websiteCrypto(): Promise<WebsiteCrypto> {
  return (await import(/* @vite-ignore */ WEBSITE_CRYPTO_MODULE)) as unknown as WebsiteCrypto;
}

const scope = {
  backendId: 'backend-acceptance',
  accountId: 'account-acceptance',
  datasetEpoch: '1',
};
const workspaceId = 'workspace-acceptance';
const repositoryId = 'repository-acceptance';
const enrollmentId = 'desktop-enrollment-acceptance';
const commandExpiry = '2099-01-01T00:00:00.000Z';

let tempRoot: string;
let repoPath: string;
let browser: { priv: Uint8Array; pub: Uint8Array };
let dsk: Buffer;
let queued: DashboardWorkspaceCommand[];
let publications: Array<{ command: DashboardWorkspaceCommand; result: DashboardCommandResult }>;
let revalidate: ReturnType<typeof vi.fn>;
let executeCount: number;
let cryptoImpl: WebsiteCrypto;

function seedRepository(): void {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'anvil-browser-workspace-acceptance-'));
  repoPath = path.join(tempRoot, 'repo');
  mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '-q', repoPath]);
  execFileSync('git', ['-C', repoPath, 'config', 'user.email', 'acceptance@example.test']);
  execFileSync('git', ['-C', repoPath, 'config', 'user.name', 'Acceptance Fixture']);
  writeFileSync(path.join(repoPath, 'README.md'), 'before\n');
  execFileSync('git', ['-C', repoPath, 'add', 'README.md']);
  execFileSync('git', ['-C', repoPath, 'commit', '-qm', 'test: seed browser workspace repo']);
}

function seedWorkspace(): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, created_at, updated_at)
     VALUES (?, ?, datetime('now'), datetime('now'))`,
  ).run(workspaceId, 'Browser workspace acceptance');
  db.prepare(
    `INSERT INTO repos (id, name, path, default_branch, status, created_at, updated_at)
     VALUES (?, ?, ?, 'master', 'connected', datetime('now'), datetime('now'))`,
  ).run(repositoryId, 'Acceptance repository', repoPath);
  db.prepare(
    `INSERT INTO workspace_repos (workspace_id, repo_id, added_at)
     VALUES (?, ?, datetime('now'))`,
  ).run(workspaceId, repositoryId);
}

function seedPendingGrant(requestId: string, expiresAt = commandExpiry): void {
  const request = {
    requestId,
    browserPub: Buffer.from(browser.pub).toString('base64'),
    challenge: 'acceptance-challenge',
    scopes: ['workspace-read', 'workspace-write', 'submit-task'],
    expiresAt,
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
    expiresAt,
    JSON.stringify(request),
    request.createdAt,
    request.createdAt,
  );
}

async function approveGrant(requestId: string, expiresAt = commandExpiry): Promise<void> {
  seedPendingGrant(requestId, expiresAt);
  await approveDashboardRequest(scope, requestId, {
    workspace: { workspaceId, repoIds: [repositoryId] },
    scopes: ['workspace-read', 'workspace-write', 'submit-task'],
  });
  const row = db
    .prepare(
      `SELECT dsk_wrapped FROM mesh_dashboard_grants
       WHERE backend_id = ? AND account_id = ? AND request_id = ?`,
    )
    .get(scope.backendId, scope.accountId, requestId) as { dsk_wrapped: Buffer };
  dsk = unwrapSecretBytes(row.dsk_wrapped)!;
  expect(dsk.byteLength).toBe(32);
}

function metadata(
  commandId: string,
  operation: BrowserWorkspaceOperation,
  expiresAt = commandExpiry,
) {
  return {
    backendId: scope.backendId,
    accountId: scope.accountId,
    requestId: 'grant-acceptance',
    commandId,
    operation,
    workspaceId,
    repositoryId,
    expiresAt,
  } as const;
}

async function browserCommand(
  commandId: string,
  operation: BrowserWorkspaceOperation,
  payload: unknown,
  expiresAt = commandExpiry,
): Promise<DashboardWorkspaceCommand> {
  const input = metadata(commandId, operation, expiresAt);
  const sealed = await cryptoImpl.sealBrowserWorkspaceCommand(dsk, { ...input, payload });
  return sealed;
}

async function openPublishedResult(publication: {
  command: DashboardWorkspaceCommand;
  result: DashboardCommandResult;
}): Promise<unknown> {
  expect(publication.result.status).toBe('completed');
  expect(publication.result.resultEnvelope).toBeDefined();
  const command = publication.command;
  return cryptoImpl.openBrowserWorkspaceResult(
    dsk,
    publication.result.resultEnvelope!,
    metadata(command.commandId, command.operation as BrowserWorkspaceOperation, command.expiresAt),
  );
}

function executeRealCommand(input: DashboardGrantCommandExecutorInput): Promise<unknown> {
  executeCount += 1;
  const payload = input.payload as Record<string, unknown>;
  const command = {
    operation: input.operation as BrowserWorkspaceOperation,
    repositoryId: input.repositoryId ?? undefined,
    ...payload,
  } as BrowserWorkspaceCommand;
  return executeBrowserWorkspaceCommand(command, {
    grantId: input.requestId,
    workspaceId: input.workspaceId,
    repoIds: [repositoryId],
    scopes: input.scopes as never,
    expiresAt: Date.parse(input.expiresAt),
    commandId: input.commandId,
  });
}

beforeEach(async () => {
  cryptoImpl = await websiteCrypto();
  db.exec(
    `DELETE FROM mesh_browser_command_receipts;
     DELETE FROM mesh_dashboard_grants;
     DELETE FROM chat_messages;
     DELETE FROM chat_sessions;
     DELETE FROM chat_threads;
     DELETE FROM workspace_repos;
     DELETE FROM repos;
     DELETE FROM workspaces;`,
  );
  seedRepository();
  seedWorkspace();
  db.exec('INSERT OR IGNORE INTO settings (id) VALUES (1)');
  db.prepare("UPDATE settings SET codex_mode = 'on-request' WHERE id = 1").run();
  browser = cryptoImpl.generateBrowserKeypair();
  dsk = Buffer.alloc(32, 0x37);
  queued = [];
  publications = [];
  executeCount = 0;
  revalidate = vi.fn(async () => ({
    state: 'approved',
    expiresAt: commandExpiry,
    enrollmentId,
    workspace: { workspaceId, repoIds: [repositoryId] },
    scopes: ['workspace-read', 'workspace-write', 'submit-task'],
  }));
  rpc.mockReset();
  rpc.mockImplementation(async (_config: unknown, operation: string) => {
    if (operation === 'job.list') return { result: { jobs: [] } };
    return { result: {} };
  });
  provider.getCodexSession.mockReset();
  provider.getCodexSession.mockReturnValue(null);
  provider.listActiveCodexSessions.mockReset();
  provider.listActiveCodexSessions.mockReturnValue([]);
  provider.startSession.mockReset();
  provider.sendMessage.mockReset();
  provider.sendMessage.mockResolvedValue(undefined);
  configureDashboardGrantContext(() => ({
    apiUrl: 'https://backend.acceptance.test/v1',
    accessToken: 'acceptance-token',
    enrollmentId,
    pullBrowserWorkspaceCommands: async () => {
      const next = queued;
      queued = [];
      return next;
    },
    revalidateBrowserWorkspaceGrant:
      revalidate as DashboardGrantContext['revalidateBrowserWorkspaceGrant'],
    executeBrowserWorkspaceCommand: executeRealCommand,
    publishBrowserWorkspaceCommandResult: async (_scope, command, result) => {
      publications.push({ command, result });
    },
  }));
  await approveGrant('grant-acceptance');
});

afterEach(() => {
  resetDashboardGrantForTests();
  if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true });
});

describe('browser workspace grant pump and real executor acceptance', () => {
  it('runs browser read/write/diff through the real Desktop executor and decrypts retained results', async () => {
    const read = await browserCommand('command-read', 'file.read', { relativePath: 'README.md' });
    queued = [read];
    await pumpBrowserWorkspaceCommands(scope, () => true);
    const readResult = (await openPublishedResult(publications.at(-1)!)) as {
      ok: boolean;
      data: { content: string; revision: string };
    };
    expect(readResult.ok).toBe(true);
    expect(readResult.data.content).toBe('before\n');

    const write = await browserCommand('command-write', 'file.write', {
      relativePath: 'README.md',
      content: 'after\n',
      expectedRevision: readResult.data.revision,
    });
    queued = [write];
    await pumpBrowserWorkspaceCommands(scope, () => true);
    const writeResult = (await openPublishedResult(publications.at(-1)!)) as {
      ok: boolean;
      data: { relativePath: string; revision: string };
    };
    expect(writeResult.ok).toBe(true);
    expect(writeResult.data.relativePath).toBe('README.md');
    expect(readFileSync(path.join(repoPath, 'README.md'), 'utf8')).toBe('after\n');

    const diff = await browserCommand('command-diff', 'git.diff', {
      relativePath: 'README.md',
      staged: false,
    });
    queued = [diff];
    await pumpBrowserWorkspaceCommands(scope, () => true);
    const diffResult = (await openPublishedResult(publications.at(-1)!)) as {
      ok: boolean;
      data: { filePath: string; oldContent: string; newContent: string; hunks: string };
    };
    expect(diffResult.ok).toBe(true);
    expect(diffResult.data).toMatchObject({
      filePath: 'README.md',
      oldContent: 'before\n',
      newContent: 'after\n',
    });
    expect(diffResult.data.hunks).toContain('+after');
    expect(executeCount).toBe(3);
  });

  it('replays a completed receipt for a replacement browser without mutating twice', async () => {
    // Read the current revision through the same real executor before making
    // the mutating command; the second command remains browser-sealed.
    const read = await browserCommand('command-retry-read', 'file.read', {
      relativePath: 'README.md',
    });
    queued = [read];
    await pumpBrowserWorkspaceCommands(scope, () => true);
    const revision = (
      (await openPublishedResult(publications.at(-1)!)) as {
        data: { revision: string };
      }
    ).data.revision;
    const validWrite = await browserCommand('command-retry', 'file.write', {
      relativePath: 'README.md',
      content: 'one mutation\n',
      expectedRevision: revision,
    });

    queued = [validWrite];
    await pumpBrowserWorkspaceCommands(scope, () => true);
    const first = publications.at(-1)!;
    const firstResult = await openPublishedResult(first);
    expect((firstResult as { ok: boolean }).ok).toBe(true);
    expect(executeCount).toBe(2);

    // A replacement browser presents the exact same command id and envelope.
    queued = [validWrite];
    await pumpBrowserWorkspaceCommands(scope, () => true);
    const second = publications.at(-1)!;
    expect(await openPublishedResult(second)).toEqual(firstResult);
    expect(executeCount).toBe(2);
    expect(readFileSync(path.join(repoPath, 'README.md'), 'utf8')).toBe('one mutation\n');
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM mesh_browser_command_receipts
           WHERE grant_id = ? AND command_id = ?`,
        )
        .get('grant-acceptance', 'command-retry'),
    ).toEqual({ count: 1 });
  });

  it('recovers a completed result when the first complete RPC is accepted but its ack is lost', async () => {
    const read = await browserCommand('command-ack-lost-read', 'file.read', {
      relativePath: 'README.md',
    });
    queued = [read];
    await pumpBrowserWorkspaceCommands(scope, () => true);
    const revision = (
      (await openPublishedResult(publications.at(-1)!)) as { data: { revision: string } }
    ).data.revision;
    const sealedWrite = await browserCommand('command-ack-lost', 'file.write', {
      relativePath: 'README.md',
      content: 'ack-lost mutation\n',
      expectedRevision: revision,
    });
    const claimed = { ...sealedWrite, claimFence: 1 };
    let backendState: 'queued' | 'claimed' | 'completed' = 'queued';
    let claimCalls = 0;
    let completeCalls = 0;
    const claimResponses: DashboardWorkspaceCommand[][] = [];
    const published: DashboardCommandResult[] = [];
    const resultEnvelopes: NonNullable<DashboardCommandResult['resultEnvelope']>[] = [];
    let firstCompletedEnvelope: NonNullable<DashboardCommandResult['resultEnvelope']> | undefined;

    // This adapter models sync-runtime's dashboard.command.claim RPC. Once a
    // command is claimed, the backend never redelivers it, even if completion
    // acknowledgement is lost at the Desktop boundary.
    const claimFromBackend = vi.fn(async () => {
      claimCalls += 1;
      let response: DashboardWorkspaceCommand[] = [];
      if (backendState === 'queued') {
        backendState = 'claimed';
        response = [claimed];
      }
      claimResponses.push(response);
      return response;
    });
    // The first call is accepted durably by the backend, then fails as if the
    // response/ack was lost. The retry is an idempotent complete RPC.
    const completeAtBackend = vi.fn(
      async (
        _command: DashboardWorkspaceCommand,
        result: DashboardCommandResult,
      ): Promise<void> => {
        completeCalls += 1;
        expect(result.resultEnvelope).toBeDefined();
        expect(_command.claimFence).toBe(1);
        if (completeCalls === 1) {
          firstCompletedEnvelope = result.resultEnvelope;
          backendState = 'completed';
          throw new Error('dashboard.command.complete acknowledgement lost');
        }
        expect(backendState).toBe('completed');
        expect(result.resultEnvelope).toEqual(firstCompletedEnvelope);
      },
    );
    const configureRelayAfterRestart = (): void => {
      configureDashboardGrantContext(() => ({
        apiUrl: 'https://backend.acceptance.test/v1',
        accessToken: 'acceptance-token',
        enrollmentId,
        pullBrowserWorkspaceCommands: async () => claimFromBackend(),
        revalidateBrowserWorkspaceGrant:
          revalidate as DashboardGrantContext['revalidateBrowserWorkspaceGrant'],
        executeBrowserWorkspaceCommand: executeRealCommand,
        publishBrowserWorkspaceCommandResult: async (_scope, relayCommand, result) => {
          published.push(result);
          if (result.resultEnvelope !== undefined) resultEnvelopes.push(result.resultEnvelope);
          await completeAtBackend(relayCommand, result);
        },
      }));
    };

    configureRelayAfterRestart();
    // The read receipt was already published by the setup pump. Only the
    // mutating command enters the backend's queued relay here.
    backendState = 'queued';
    await pumpBrowserWorkspaceCommands(scope, () => true);
    expect(executeCount).toBe(2);
    expect(completeCalls).toBe(1);
    expect(backendState).toBe('completed');
    expect(resultEnvelopes).toHaveLength(1);

    const outbox = db
      .prepare(
        `SELECT state, result_envelope_json, result_published
         FROM mesh_browser_command_receipts
         WHERE grant_id = ? AND command_id = ?`,
      )
      .get('grant-acceptance', 'command-ack-lost') as {
      state: string;
      result_envelope_json: string;
      result_published: number;
    };
    expect(outbox.state).toBe('completed');
    expect(JSON.parse(outbox.result_envelope_json)).toEqual(resultEnvelopes[0]);
    expect(outbox.result_published).toBe(0);

    // Simulate Desktop service restart: only the SQLite outbox survives.
    resetDashboardGrantForTests();
    configureRelayAfterRestart();
    await pumpBrowserWorkspaceCommands(scope, () => true);

    expect(executeCount).toBe(2);
    expect(completeCalls).toBe(2);
    expect(claimCalls).toBe(2);
    expect(claimResponses[1]).toEqual([]);
    expect(published).toHaveLength(2);
    expect(resultEnvelopes[1]).toEqual(resultEnvelopes[0]);
    expect(outbox.state).toBe('completed');
    expect(
      (
        db
          .prepare(
            `SELECT result_published FROM mesh_browser_command_receipts
             WHERE grant_id = ? AND command_id = ?`,
          )
          .get('grant-acceptance', 'command-ack-lost') as { result_published: number }
      ).result_published,
    ).toBe(1);
    expect(await openPublishedResult({ command: sealedWrite, result: published[1] })).toEqual(
      await openPublishedResult({ command: sealedWrite, result: published[0] }),
    );
    expect(readFileSync(path.join(repoPath, 'README.md'), 'utf8')).toBe('ack-lost mutation\n');
  });

  it('revalidates expiry/revocation before invoking the real executor', async () => {
    const revoked = await browserCommand('command-revoked', 'file.write', {
      relativePath: 'README.md',
      content: 'must not write\n',
      expectedRevision: 'wrong',
    });
    revalidate.mockResolvedValueOnce({
      state: 'revoked',
      expiresAt: commandExpiry,
      enrollmentId,
      workspace: { workspaceId, repoIds: [repositoryId] },
      scopes: ['workspace-write'],
    });
    queued = [revoked];
    await pumpBrowserWorkspaceCommands(scope, () => true);
    expect(executeCount).toBe(0);
    expect(publications.at(-1)?.result).toMatchObject({ status: 'failed' });
    expect(readFileSync(path.join(repoPath, 'README.md'), 'utf8')).toBe('before\n');

    const expired = await browserCommand(
      'command-expired',
      'file.write',
      { relativePath: 'README.md', content: 'also must not write\n', expectedRevision: 'wrong' },
      '2020-01-01T00:00:00.000Z',
    );
    queued = [expired];
    await pumpBrowserWorkspaceCommands(scope, () => true);
    expect(executeCount).toBe(0);
    expect(publications.at(-1)?.result).toMatchObject({ status: 'failed' });
    expect(readFileSync(path.join(repoPath, 'README.md'), 'utf8')).toBe('before\n');
  });

  it('persists browser chat create/send/history while the provider remains a deterministic fixture', async () => {
    const create = await browserCommand('command-chat-create', 'chat.create', {
      personaId: 'coder',
      title: 'Acceptance chat',
      repositoryIds: [repositoryId],
      activeRepositoryId: repositoryId,
    });
    queued = [create];
    await pumpBrowserWorkspaceCommands(scope, () => true);
    const created = (await openPublishedResult(publications.at(-1)!)) as {
      ok: boolean;
      data: { id: string };
    };
    expect(created.ok).toBe(true);

    const sessionId = 'provider-session-acceptance';
    const session = {
      id: sessionId,
      workspaceId,
      appThreadId: created.data.id,
      repoId: repositoryId,
      personaId: 'coder',
      provider: 'codex' as const,
      status: 'ready' as const,
      startedAt: new Date().toISOString(),
      origin: 'browser' as const,
    };
    provider.startSession.mockResolvedValue(session);
    provider.getCodexSession.mockReturnValue(session);
    provider.listActiveCodexSessions.mockReturnValue([]);

    const start = await browserCommand('command-chat-start', 'chat.session.start', {
      threadId: created.data.id,
    });
    queued = [start];
    await pumpBrowserWorkspaceCommands(scope, () => true);
    expect((await openPublishedResult(publications.at(-1)!)) as { ok: boolean }).toMatchObject({
      ok: true,
    });

    const send = await browserCommand('command-chat-send', 'chat.send', {
      threadId: created.data.id,
      sessionId,
      message: 'Inspect this repository',
    });
    queued = [send];
    await pumpBrowserWorkspaceCommands(scope, () => true);
    expect(provider.sendMessage).toHaveBeenCalledWith(sessionId, 'Inspect this repository');

    const history = await browserCommand('command-chat-history', 'chat.history.read', {
      threadId: created.data.id,
    });
    queued = [history];
    await pumpBrowserWorkspaceCommands(scope, () => true);
    const historyResult = (await openPublishedResult(publications.at(-1)!)) as {
      ok: boolean;
      data: { messages: Array<{ role: string; content: string }> };
    };
    expect(historyResult.ok).toBe(true);
    expect(historyResult.data.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'Inspect this repository' }),
      ]),
    );
  });
});
