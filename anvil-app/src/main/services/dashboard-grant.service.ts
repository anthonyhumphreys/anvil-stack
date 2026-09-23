// DASH-01: trusted-device dashboard grant service.
//
// A signed-in browser never receives account key material. It submits a
// bounded authorization request (ephemeral X25519 pub, scopes, expiry,
// origin hint) through the hosted channel; a trusted device observes the
// request via `dashboard.requests`, the user approves or denies it in
// settings, and on approval this device mints a Dashboard Session Key
// (DSK), seals it to the browser's public key, and publishes account
// projections sealed under the DSK at a monotonically increasing seq.
//
// The coordinator stores and relays grants and snapshots but cannot open
// either. Grants are scoped, expiring, and revocable; delegated actions
// ride grant scopes, never ambient session authority.

import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '../db/database.js';
import { rpc as backendRpc } from './sync-backend-client.service.js';
import {
  dashboardGrantAssociatedData,
  dashboardSnapshotAssociatedData,
  SEALED_ENTITY_ALG,
  type DashboardGrantInner,
  type DashboardGrantPayload,
  type SealedDashboardSnapshot,
} from '../../../cloud/contract/sealed.js';
import type {
  DashboardDecideResult,
  DashboardPublishResult,
  DashboardRequest,
  DashboardRequestsResult,
  DashboardRevokeResult,
} from '../../../cloud/contract/dashboard.js';
import {
  BROWSER_WORKSPACE_MAX_RESULT_PLAINTEXT_BYTES,
  BROWSER_WORKSPACE_OPERATION_SCOPE,
  browserWorkspaceCommandAssociatedData,
  browserWorkspaceResultAssociatedData,
  type BrowserWorkspaceCommandEnvelope,
  type BrowserWorkspaceOperation,
  type BrowserWorkspaceResultEnvelope,
} from '../../../cloud/contract/browser-workspace.js';
import type { JobListResult } from '../../../cloud/contract/jobs.js';
import type { SyncScope } from '../../shared/sync-mesh.js';
import {
  sealJsonEnvelope,
  sealToRecipientPub,
  unsealJsonEnvelope,
  unwrapSecretBytes,
  wrapSecretBytes,
} from './sync-keyring.service.js';
import { revokeSharedBrowserWorkspaceGrant } from './browser-workspace-tools.service.js';
import { canonicalJson } from './sync-persistence.service.js';

export const DASHBOARD_WORKSPACE_SCOPES = [
  'read-dashboard',
  'workspace-read',
  'workspace-write',
  'submit-task',
  'approve-action',
  'request-handoff',
  'terminal',
  'preview',
] as const;

export type DashboardWorkspaceScope = (typeof DASHBOARD_WORKSPACE_SCOPES)[number];

export interface DashboardGrantWorkspaceSelection {
  workspaceId: string;
  repoIds: string[];
}

export interface DashboardGrantApproval {
  workspace: DashboardGrantWorkspaceSelection;
  scopes: string[];
}

export type DashboardWorkspaceCommand = BrowserWorkspaceCommandEnvelope & {
  /** Claim fence is Desktop-local relay metadata, not part of the sealed envelope. */
  claimFence?: number;
};

export interface DashboardCommandResult {
  status: 'completed' | 'failed' | 'uncertain' | 'rejected';
  result?: unknown;
  resultEnvelope?: DashboardWorkspaceResultEnvelope;
  error?: string;
}

export type DashboardWorkspaceResultEnvelope = BrowserWorkspaceResultEnvelope;

export interface DashboardGrantRevalidation {
  state: 'approved' | 'expired' | 'revoked' | 'denied' | 'pending';
  expiresAt: string;
  enrollmentId: string;
  workspace: DashboardGrantWorkspaceSelection;
  scopes: string[];
}

export interface DashboardGrantCommandExecutorInput {
  commandId: string;
  requestId: string;
  enrollmentId: string;
  operation: BrowserWorkspaceOperation;
  workspaceId: string;
  repositoryId: string | null;
  repoIds: string[];
  scopes: string[];
  expiresAt: string;
  payload: unknown;
}

export type DashboardGrantCommandExecutor = (
  input: DashboardGrantCommandExecutorInput,
) => Promise<unknown>;

export interface DashboardGrantContext {
  apiUrl: string;
  accessToken: string;
  enrollmentId: string;
  /** Relay adapter. No command is executed without all three callbacks. */
  pullBrowserWorkspaceCommands?: (
    scope: SyncScope,
    enrollmentId: string,
  ) => Promise<DashboardWorkspaceCommand[]>;
  revalidateBrowserWorkspaceGrant?: (
    scope: SyncScope,
    grantId: string,
  ) => Promise<DashboardGrantRevalidation>;
  publishBrowserWorkspaceCommandResult?: (
    scope: SyncScope,
    command: DashboardWorkspaceCommand,
    result: DashboardCommandResult,
  ) => Promise<void>;
  executeBrowserWorkspaceCommand?: DashboardGrantCommandExecutor;
}

let contextProvider: (() => DashboardGrantContext | null) | null = null;

export function configureDashboardGrantContext(provider: () => DashboardGrantContext | null): void {
  contextProvider = provider;
}

export function resetDashboardGrantForTests(): void {
  contextProvider = null;
}

async function dashRpc<T>(operation: string, params: unknown): Promise<T> {
  const ctx = contextProvider?.() ?? null;
  if (ctx === null) {
    throw new Error('Dashboard grants have no active sync session.');
  }
  const { result } = await backendRpc<T>(
    { apiUrl: ctx.apiUrl },
    operation,
    params,
    ctx.accessToken,
  );
  return result;
}

export interface DashboardGrantRow {
  requestId: string;
  browserPub: string;
  scopes: string[];
  expiresAt: string;
  seq: number;
  state: 'pending' | 'approved' | 'denied' | 'expired' | 'revoked';
  request: DashboardRequest | null;
  workspace: DashboardGrantWorkspaceSelection | null;
  enrollmentId: string | null;
}

interface GrantRow {
  request_id: string;
  browser_pub: string;
  dsk_wrapped: Buffer | null;
  scopes_json: string;
  workspace_id: string | null;
  repo_ids_json: string;
  enrollment_id: string | null;
  expires_at: string;
  seq: number;
  state: string;
  request_json: string | null;
  last_published_at: string | null;
}

function rowToGrant(row: GrantRow): DashboardGrantRow {
  const workspaceId = row.workspace_id ?? null;
  const workspace =
    workspaceId === null
      ? null
      : { workspaceId, repoIds: JSON.parse(row.repo_ids_json || '[]') as string[] };
  return {
    requestId: row.request_id,
    browserPub: row.browser_pub,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    seq: row.seq,
    state: row.state as DashboardGrantRow['state'],
    request: row.request_json === null ? null : (JSON.parse(row.request_json) as DashboardRequest),
    workspace,
    enrollmentId: row.enrollment_id ?? null,
  };
}

/** Local mirror of dashboard requests/grants for the approval UI. */
export function listDashboardGrants(scope: SyncScope): DashboardGrantRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM mesh_dashboard_grants
       WHERE backend_id = ? AND account_id = ? ORDER BY created_at DESC`,
    )
    .all(scope.backendId, scope.accountId) as GrantRow[];
  return rows.map(rowToGrant);
}

export interface DashboardGrantWorkspaceOption {
  workspaceId: string;
  name: string;
  repos: Array<{ repoId: string; name: string }>;
}

/** Renderer-safe choices for the explicit grant approval surface. */
export function listDashboardGrantWorkspaces(): DashboardGrantWorkspaceOption[] {
  const rows = getDb()
    .prepare(
      `SELECT w.id AS workspace_id, w.name AS workspace_name,
              r.id AS repo_id, r.name AS repo_name
       FROM workspaces w
       LEFT JOIN workspace_repos wr ON wr.workspace_id = w.id
       LEFT JOIN repos r ON r.id = wr.repo_id
       ORDER BY w.name COLLATE NOCASE ASC, r.name COLLATE NOCASE ASC`,
    )
    .all() as Array<{
    workspace_id: string;
    workspace_name: string;
    repo_id: string | null;
    repo_name: string | null;
  }>;
  const byId = new Map<string, DashboardGrantWorkspaceOption>();
  for (const row of rows) {
    const current = byId.get(row.workspace_id) ?? {
      workspaceId: row.workspace_id,
      name: row.workspace_name,
      repos: [],
    };
    if (row.repo_id !== null && row.repo_name !== null) {
      current.repos.push({ repoId: row.repo_id, name: row.repo_name });
    }
    byId.set(row.workspace_id, current);
  }
  return [...byId.values()];
}

function upsertObserved(scope: SyncScope, request: DashboardRequest): void {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT state FROM mesh_dashboard_grants
       WHERE backend_id = ? AND account_id = ? AND request_id = ?`,
    )
    .get(scope.backendId, scope.accountId, request.requestId) as { state: string } | undefined;
  // A locally decided state (approved/denied/revoked) is authoritative —
  // mirror only requests we have not acted on, or terminal backend
  // transitions we have not seen yet.
  if (existing !== undefined && existing.state !== 'pending') {
    if (
      ['expired', 'revoked', 'denied'].includes(request.state) &&
      existing.state !== request.state
    ) {
      db.prepare(
        `UPDATE mesh_dashboard_grants SET state = ?, request_json = ?, updated_at = ?
         WHERE backend_id = ? AND account_id = ? AND request_id = ?`,
      ).run(
        request.state,
        JSON.stringify(request),
        nowIso(),
        scope.backendId,
        scope.accountId,
        request.requestId,
      );
      // Terminal state observed remotely: the grant's browser-owned PTYs die here.
      revokeSharedBrowserWorkspaceGrant(request.requestId);
    }
    return;
  }
  db.prepare(
    `INSERT INTO mesh_dashboard_grants
       (backend_id, account_id, request_id, browser_pub, scopes_json,
        expires_at, seq, state, request_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
     ON CONFLICT (backend_id, account_id, request_id)
     DO UPDATE SET request_json = excluded.request_json,
                   expires_at = excluded.expires_at,
                   state = excluded.state,
                   updated_at = excluded.updated_at`,
  ).run(
    scope.backendId,
    scope.accountId,
    request.requestId,
    request.browserPub,
    JSON.stringify(request.scopes),
    request.expiresAt,
    request.state,
    JSON.stringify(request),
    nowIso(),
    nowIso(),
  );
  if (request.state !== 'pending' && request.state !== 'approved') {
    revokeSharedBrowserWorkspaceGrant(request.requestId);
  }
}

/**
 * The bounded account projection a dashboard receives. Everything here is
 * sealed under the DSK — the coordinator only sees the envelope — but the
 * projection is still deliberately narrow: device names/trust, environment
 * lifecycle, recent jobs, and pending dashboard requests.
 */
async function buildDashboardSnapshot(scope: SyncScope): Promise<Record<string, unknown>> {
  const db = getDb();
  const devices = db
    .prepare(
      `SELECT e.id, e.display_name, e.state, t.state AS trust
       FROM device_enrollments e
       LEFT JOIN sync_device_trust t
         ON t.backend_id = e.backend_id AND t.account_id = e.account_id
        AND t.enrollment_id = e.id
       WHERE e.backend_id = ? AND e.account_id = ?`,
    )
    .all(scope.backendId, scope.accountId) as Array<{
    id: string;
    display_name: string | null;
    state: string;
    trust: string | null;
  }>;
  const environments = db
    .prepare(
      `SELECT environment_id, provider, state, expires_at
       FROM cloud_environments WHERE backend_id = ? AND account_id = ?`,
    )
    .all(scope.backendId, scope.accountId) as Array<{
    environment_id: string;
    provider: string;
    state: string;
    expires_at: string | null;
  }>;
  const jobs = await dashRpc<JobListResult>('job.list', { limit: 20 })
    .then((r) => r.jobs)
    .catch(() => [] as JobListResult['jobs']);
  return {
    v: 1,
    at: nowIso(),
    devices: devices.map((d) => ({
      enrollmentId: d.id,
      displayName: d.display_name,
      state: d.state,
      trust: d.trust ?? 'pending',
    })),
    environments: environments.map((e) => ({
      environmentId: e.environment_id,
      provider: e.provider,
      state: e.state,
      expiresAt: e.expires_at,
    })),
    jobs: jobs.map((j) => ({
      jobId: j.id,
      kind: j.kind,
      state: j.state,
      keyDelivery: j.keyDelivery ?? 'none',
    })),
    requests: listDashboardGrants(scope)
      .filter((g) => g.state === 'pending')
      .map((g) => ({
        requestId: g.requestId,
        scopes: g.scopes,
        expiresAt: g.expiresAt,
        origin: g.request?.origin,
        userAgent: g.request?.userAgent,
      })),
  };
}

function sealSnapshot(
  scope: SyncScope,
  requestId: string,
  dsk: Buffer,
  seq: number,
  snapshot: unknown,
): SealedDashboardSnapshot {
  const aad = dashboardSnapshotAssociatedData({
    backendId: scope.backendId,
    accountId: scope.accountId,
    requestId,
    seq,
  });
  const { nonce, ct } = sealJsonEnvelope(dsk, aad, snapshot);
  return { enc: SEALED_ENTITY_ALG, seq, nonce, ct };
}

const SNAPSHOT_MIN_INTERVAL_MS = 30_000;

const MAX_COMMANDS_PER_PUMP = 8;
const MAX_BROWSER_COMMAND_RESULT_BYTES = BROWSER_WORKSPACE_MAX_RESULT_PLAINTEXT_BYTES;
const commandPumpInFlight = new Set<string>();
const activeCommandIds = new Set<string>();

function commandScope(operation: BrowserWorkspaceOperation): DashboardWorkspaceScope {
  return BROWSER_WORKSPACE_OPERATION_SCOPE[operation];
}

export function dashboardCommandAssociatedData(input: {
  backendId: string;
  accountId: string;
  requestId: string;
  commandId: string;
  operation: BrowserWorkspaceOperation;
  workspaceId: string;
  repositoryId?: string;
  expiresAt: string;
}): string {
  return browserWorkspaceCommandAssociatedData(input);
}

export function dashboardResultAssociatedData(input: {
  backendId: string;
  accountId: string;
  requestId: string;
  commandId: string;
  operation: BrowserWorkspaceOperation;
  workspaceId: string;
  repositoryId?: string;
  expiresAt: string;
}): string {
  return browserWorkspaceResultAssociatedData(input);
}

interface CommandReceiptRow {
  grant_id: string;
  command_id: string;
  kind: string;
  workspace_id: string;
  repo_id: string | null;
  expires_at: string;
  payload_hash: string;
  command_envelope_json: string | null;
  claim_fence: number | null;
  state: 'executing' | 'completed' | 'failed' | 'uncertain';
  result_wrapped: Buffer | null;
  result_envelope_json: string | null;
  result_published: number;
  error_message: string | null;
}

function commandReceipt(
  scope: SyncScope,
  command: DashboardWorkspaceCommand,
): CommandReceiptRow | undefined {
  return getDb()
    .prepare(
      `SELECT grant_id, command_id, kind, workspace_id, repo_id, expires_at,
              payload_hash, command_envelope_json, claim_fence, state,
              result_wrapped, result_envelope_json, result_published, error_message
       FROM mesh_browser_command_receipts
       WHERE backend_id = ? AND account_id = ? AND grant_id = ? AND command_id = ?`,
    )
    .get(scope.backendId, scope.accountId, command.requestId, command.commandId) as
    | CommandReceiptRow
    | undefined;
}

function hashCommandPayload(command: DashboardWorkspaceCommand): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        commandId: command.commandId,
        requestId: command.requestId,
        operation: command.operation,
        workspaceId: command.workspaceId,
        repositoryId: command.repositoryId,
        expiresAt: command.expiresAt,
        payload: { enc: command.enc, nonce: command.nonce, ct: command.ct },
      }),
    )
    .digest('hex');
}

function resultFromReceipt(receipt: CommandReceiptRow): DashboardCommandResult {
  const result =
    receipt.result_wrapped === null
      ? undefined
      : (() => {
          const bytes = unwrapSecretBytes(receipt.result_wrapped);
          if (bytes === null) return undefined;
          try {
            return JSON.parse(bytes.toString('utf8')) as unknown;
          } catch {
            return undefined;
          }
        })();
  return {
    status: receipt.state === 'executing' ? 'uncertain' : receipt.state,
    ...(result === undefined ? {} : { result }),
    ...(receipt.error_message === null ? {} : { error: receipt.error_message }),
  };
}

function commandResultFailureMessage(result: unknown): string | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const error = (result as Record<string, unknown>).error;
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return null;
  const message = (error as Record<string, unknown>).message;
  return typeof message === 'string' ? message.slice(0, 2_000) : 'The Desktop command failed.';
}

function commandFromReceipt(receipt: CommandReceiptRow): DashboardWorkspaceCommand | null {
  if (receipt.command_envelope_json === null) return null;
  try {
    const envelope = JSON.parse(receipt.command_envelope_json) as DashboardWorkspaceCommand;
    if (
      envelope.requestId !== receipt.grant_id ||
      envelope.commandId !== receipt.command_id ||
      envelope.operation !== receipt.kind ||
      envelope.workspaceId !== receipt.workspace_id ||
      (envelope.repositoryId ?? null) !== receipt.repo_id ||
      envelope.expiresAt !== receipt.expires_at
    ) {
      return null;
    }
    return {
      ...envelope,
      ...(receipt.claim_fence === null ? {} : { claimFence: receipt.claim_fence }),
    };
  } catch {
    return null;
  }
}

function markReceiptUncertain(scope: SyncScope, receipt: CommandReceiptRow): void {
  getDb()
    .prepare(
      `UPDATE mesh_browser_command_receipts
       SET state = 'uncertain', error_message = ?, updated_at = ?
       WHERE backend_id = ? AND account_id = ? AND grant_id = ? AND command_id = ?
         AND state = 'executing'`,
    )
    .run(
      'Desktop restarted or lost the command worker before the outcome was recorded.',
      nowIso(),
      scope.backendId,
      scope.accountId,
      receipt.grant_id,
      receipt.command_id,
    );
}

async function publishStoredReceipt(
  scope: SyncScope,
  command: DashboardWorkspaceCommand,
  receipt: CommandReceiptRow,
  ctx: DashboardGrantContext,
): Promise<void> {
  if (ctx.publishBrowserWorkspaceCommandResult === undefined) return;
  const stored = resultFromReceipt(receipt);
  if (stored.status === 'uncertain') {
    await ctx.publishBrowserWorkspaceCommandResult(scope, command, stored);
    return;
  }
  if (receipt.result_published !== 0) return;
  const grant = getDb()
    .prepare(
      `SELECT dsk_wrapped FROM mesh_dashboard_grants
       WHERE backend_id = ? AND account_id = ? AND request_id = ?`,
    )
    .get(scope.backendId, scope.accountId, command.requestId) as
    | { dsk_wrapped: Buffer | null }
    | undefined;
  const dsk =
    grant?.dsk_wrapped === null || grant?.dsk_wrapped === undefined
      ? null
      : unwrapSecretBytes(grant.dsk_wrapped);
  if (dsk === null || dsk.byteLength !== 32) {
    await ctx.publishBrowserWorkspaceCommandResult(scope, command, {
      status: 'failed',
      error: 'Grant key is unavailable while publishing the command result.',
    });
    return;
  }
  const publishStatus: 'completed' | 'failed' =
    stored.status === 'completed' && stored.result !== undefined ? 'completed' : 'failed';
  const envelope =
    receipt.result_envelope_json === null
      ? (() => {
          const sealed = sealJsonEnvelope(
            dsk,
            dashboardResultAssociatedData({
              backendId: scope.backendId,
              accountId: scope.accountId,
              requestId: command.requestId,
              commandId: command.commandId,
              operation: command.operation,
              workspaceId: command.workspaceId,
              repositoryId: command.repositoryId,
              expiresAt: command.expiresAt,
            }),
            publishStatus === 'failed'
              ? (stored.result ?? { error: stored.error ?? 'The Desktop command failed.' })
              : stored.result,
          );
          const resultEnvelope: DashboardWorkspaceResultEnvelope = {
            v: 1,
            enc: 'aes-256-gcm',
            requestId: command.requestId,
            commandId: command.commandId,
            operation: command.operation,
            workspaceId: command.workspaceId,
            ...(command.repositoryId === undefined ? {} : { repositoryId: command.repositoryId }),
            expiresAt: command.expiresAt,
            ...sealed,
          };
          getDb()
            .prepare(
              `UPDATE mesh_browser_command_receipts SET result_envelope_json = ?, updated_at = ?
               WHERE backend_id = ? AND account_id = ? AND grant_id = ? AND command_id = ?`,
            )
            .run(
              JSON.stringify(resultEnvelope),
              nowIso(),
              scope.backendId,
              scope.accountId,
              command.requestId,
              command.commandId,
            );
          return resultEnvelope;
        })()
      : (JSON.parse(receipt.result_envelope_json) as DashboardWorkspaceResultEnvelope);
  await ctx.publishBrowserWorkspaceCommandResult(scope, command, {
    status: publishStatus,
    resultEnvelope: envelope,
  });
  getDb()
    .prepare(
      `UPDATE mesh_browser_command_receipts SET result_published = 1, updated_at = ?
       WHERE backend_id = ? AND account_id = ? AND grant_id = ? AND command_id = ?`,
    )
    .run(nowIso(), scope.backendId, scope.accountId, command.requestId, command.commandId);
}

/**
 * A claimed command that fails a local or remote grant check still needs a
 * fenced failed outcome. Recording it first makes the encrypted failure a
 * durable outbox item if the completion response is lost.
 */
async function rejectBrowserWorkspaceCommand(
  scope: SyncScope,
  command: DashboardWorkspaceCommand,
  reason: string,
  ctx: DashboardGrantContext,
): Promise<void> {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO mesh_browser_command_receipts
       (backend_id, account_id, grant_id, command_id, kind, workspace_id, repo_id,
        expires_at, payload_hash, command_envelope_json, claim_fence, state,
        error_message, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?)`,
  ).run(
    scope.backendId,
    scope.accountId,
    command.requestId,
    command.commandId,
    command.operation,
    command.workspaceId,
    command.repositoryId ?? null,
    command.expiresAt,
    hashCommandPayload(command),
    JSON.stringify(command),
    command.claimFence ?? null,
    reason.slice(0, 2_000),
    nowIso(),
    nowIso(),
    nowIso(),
  );
  const receipt = commandReceipt(scope, command);
  if (receipt !== undefined) await publishStoredReceipt(scope, command, receipt, ctx);
}

async function dispatchBrowserWorkspaceCommand(
  scope: SyncScope,
  command: DashboardWorkspaceCommand,
  guard: () => boolean,
  ctx: DashboardGrantContext,
): Promise<void> {
  const receipt = commandReceipt(scope, command);
  if (receipt !== undefined) {
    if (receipt.state === 'executing' && !activeCommandIds.has(command.commandId)) {
      markReceiptUncertain(scope, receipt);
      const recovered = commandReceipt(scope, command);
      if (recovered !== undefined) await publishStoredReceipt(scope, command, recovered, ctx);
    } else if (receipt.state !== 'executing') {
      await publishStoredReceipt(scope, command, receipt, ctx);
    }
    return;
  }
  if (
    ctx.revalidateBrowserWorkspaceGrant === undefined ||
    ctx.publishBrowserWorkspaceCommandResult === undefined ||
    ctx.executeBrowserWorkspaceCommand === undefined
  ) {
    // No relay or executor means no execution. This also keeps older builds
    // with read-only dashboard support from accidentally running commands.
    return;
  }

  const grant = getDb()
    .prepare(
      `SELECT * FROM mesh_dashboard_grants
       WHERE backend_id = ? AND account_id = ? AND request_id = ?`,
    )
    .get(scope.backendId, scope.accountId, command.requestId) as GrantRow | undefined;
  if (
    grant === undefined ||
    grant.state !== 'approved' ||
    grant.workspace_id === null ||
    grant.enrollment_id === null ||
    grant.enrollment_id !== ctx.enrollmentId ||
    Date.parse(grant.expires_at) <= Date.now() ||
    Date.parse(command.expiresAt) <= Date.now()
  ) {
    await rejectBrowserWorkspaceCommand(
      scope,
      command,
      'Grant is missing, expired, revoked, or not bound to this Desktop enrollment.',
      ctx,
    );
    return;
  }
  const requestedScope = commandScope(command.operation);
  const grantedScopes = JSON.parse(grant.scopes_json) as string[];
  const repoIds = JSON.parse(grant.repo_ids_json || '[]') as string[];
  if (
    requestedScope === null ||
    !grantedScopes.includes(requestedScope) ||
    command.workspaceId !== grant.workspace_id ||
    (command.repositoryId !== undefined && !repoIds.includes(command.repositoryId))
  ) {
    await rejectBrowserWorkspaceCommand(
      scope,
      command,
      'Command is outside the grant workspace or action scope.',
      ctx,
    );
    return;
  }

  const remote = await ctx.revalidateBrowserWorkspaceGrant(scope, command.requestId);
  if (
    !guard() ||
    remote.state !== 'approved' ||
    remote.enrollmentId !== grant.enrollment_id ||
    remote.workspace.workspaceId !== grant.workspace_id ||
    Date.parse(remote.expiresAt) <= Date.now() ||
    remote.expiresAt !== grant.expires_at ||
    !remote.scopes.includes(requestedScope) ||
    (command.repositoryId !== undefined && !remote.workspace.repoIds.includes(command.repositoryId))
  ) {
    await rejectBrowserWorkspaceCommand(
      scope,
      command,
      'Grant was revoked, expired, or changed before dispatch.',
      ctx,
    );
    return;
  }

  const payloadHash = hashCommandPayload(command);
  getDb()
    .prepare(
      `INSERT INTO mesh_browser_command_receipts
       (backend_id, account_id, grant_id, command_id, kind, workspace_id, repo_id,
        expires_at, payload_hash, command_envelope_json, claim_fence, state,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'executing', ?, ?)`,
    )
    .run(
      scope.backendId,
      scope.accountId,
      command.requestId,
      command.commandId,
      command.operation,
      command.workspaceId,
      command.repositoryId ?? null,
      command.expiresAt,
      payloadHash,
      JSON.stringify(command),
      command.claimFence ?? null,
      nowIso(),
      nowIso(),
    );
  activeCommandIds.add(command.commandId);
  try {
    const dsk = grant.dsk_wrapped === null ? null : unwrapSecretBytes(grant.dsk_wrapped);
    if (dsk === null || dsk.byteLength !== 32) throw new Error('Grant key is unavailable.');
    const payload = unsealJsonEnvelope(
      dsk,
      dashboardCommandAssociatedData({
        backendId: scope.backendId,
        accountId: scope.accountId,
        requestId: command.requestId,
        commandId: command.commandId,
        operation: command.operation,
        workspaceId: command.workspaceId,
        repositoryId: command.repositoryId,
        expiresAt: command.expiresAt,
      }),
      { enc: command.enc, nonce: command.nonce, ct: command.ct },
    );
    if (!guard()) return;
    const result = await ctx.executeBrowserWorkspaceCommand({
      commandId: command.commandId,
      requestId: command.requestId,
      enrollmentId: grant.enrollment_id,
      operation: command.operation,
      workspaceId: command.workspaceId,
      repositoryId: command.repositoryId ?? null,
      repoIds,
      scopes: grantedScopes,
      expiresAt: command.expiresAt,
      payload,
    });
    const serializedResult = canonicalJson(result);
    if (Buffer.byteLength(serializedResult, 'utf8') > MAX_BROWSER_COMMAND_RESULT_BYTES) {
      throw new Error('Browser workspace command result exceeds the relay limit.');
    }
    const wrappedResult = wrapSecretBytes(Buffer.from(serializedResult, 'utf8'));
    const failed =
      typeof result === 'object' &&
      result !== null &&
      !Array.isArray(result) &&
      (result as Record<string, unknown>).ok === false;
    const failureMessage = failed ? commandResultFailureMessage(result) : null;
    getDb()
      .prepare(
        `UPDATE mesh_browser_command_receipts
         SET state = ?, result_wrapped = ?, error_message = ?,
             updated_at = ?, completed_at = ?
         WHERE backend_id = ? AND account_id = ? AND grant_id = ? AND command_id = ?`,
      )
      .run(
        failed ? 'failed' : 'completed',
        wrappedResult,
        failureMessage,
        nowIso(),
        nowIso(),
        scope.backendId,
        scope.accountId,
        command.requestId,
        command.commandId,
      );
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    getDb()
      .prepare(
        `UPDATE mesh_browser_command_receipts
         SET state = 'failed', error_message = ?, updated_at = ?, completed_at = ?
         WHERE backend_id = ? AND account_id = ? AND grant_id = ? AND command_id = ?`,
      )
      .run(
        message,
        nowIso(),
        nowIso(),
        scope.backendId,
        scope.accountId,
        command.requestId,
        command.commandId,
      );
  } finally {
    activeCommandIds.delete(command.commandId);
  }
  const completed = commandReceipt(scope, command);
  if (completed !== undefined) await publishStoredReceipt(scope, command, completed, ctx);
}

/**
 * Pull and dispatch browser workspace commands without extending the sync
 * cycle. The relay adapter must revalidate the grant before every mutation.
 */
export async function pumpBrowserWorkspaceCommands(
  scope: SyncScope,
  guard: () => boolean,
): Promise<void> {
  const key = `${scope.backendId}:${scope.accountId}`;
  if (commandPumpInFlight.has(key)) return;
  const ctx = contextProvider?.() ?? null;
  if (
    ctx === null ||
    ctx.pullBrowserWorkspaceCommands === undefined ||
    ctx.revalidateBrowserWorkspaceGrant === undefined ||
    ctx.publishBrowserWorkspaceCommandResult === undefined ||
    ctx.executeBrowserWorkspaceCommand === undefined
  ) {
    return;
  }
  commandPumpInFlight.add(key);
  try {
    // Any executing receipt left by a previous process is deliberately
    // uncertain. Retrying a mutation after a crash is unsafe.
    const stale = getDb()
      .prepare(
        `SELECT grant_id, command_id, kind, workspace_id, repo_id, expires_at,
                payload_hash, command_envelope_json, claim_fence, state,
                result_wrapped, result_envelope_json, result_published, error_message
         FROM mesh_browser_command_receipts
         WHERE backend_id = ? AND account_id = ? AND state = 'executing'`,
      )
      .all(scope.backendId, scope.accountId) as CommandReceiptRow[];
    for (const receipt of stale) {
      if (!activeCommandIds.has(receipt.command_id)) markReceiptUncertain(scope, receipt);
    }
    // Complete/failed receipts are a durable result outbox. A lost response
    // from dashboard.command.complete must be retried byte-for-byte without
    // claiming or executing the command again.
    const pendingResults = getDb()
      .prepare(
        `SELECT grant_id, command_id, kind, workspace_id, repo_id, expires_at,
                payload_hash, command_envelope_json, claim_fence, state,
                result_wrapped, result_envelope_json, result_published, error_message
         FROM mesh_browser_command_receipts
         WHERE backend_id = ? AND account_id = ?
           AND state IN ('completed', 'failed') AND result_published = 0
         ORDER BY updated_at ASC LIMIT ?`,
      )
      .all(scope.backendId, scope.accountId, MAX_COMMANDS_PER_PUMP) as CommandReceiptRow[];
    for (const receipt of pendingResults) {
      const command = commandFromReceipt(receipt);
      if (command === null) continue;
      if (!guard()) return;
      try {
        await publishStoredReceipt(scope, command, receipt, ctx);
      } catch {
        // Keep the exact envelope in the local outbox and let the next pump
        // retry it. One unavailable/revoked grant must not starve new work.
      }
    }
    const commands = await ctx.pullBrowserWorkspaceCommands(scope, ctx.enrollmentId);
    for (const command of commands) {
      if (!guard()) return;
      try {
        await dispatchBrowserWorkspaceCommand(scope, command, guard, ctx);
      } catch {
        // Network/relay failures leave the claim fenced remotely and are
        // retried or become unknown-outcome; continue servicing other grants.
      }
    }
  } finally {
    commandPumpInFlight.delete(key);
  }
}

async function publishSnapshot(scope: SyncScope, row: GrantRow): Promise<void> {
  const dsk = row.dsk_wrapped === null ? null : unwrapSecretBytes(row.dsk_wrapped);
  if (dsk === null) return;
  const seq = row.seq + 1;
  const snapshot = await buildDashboardSnapshot(scope);
  const sealed = sealSnapshot(scope, row.request_id, dsk, seq, snapshot);
  const result = await dashRpc<DashboardPublishResult>('dashboard.publish', {
    requestId: row.request_id,
    snapshot: sealed,
  });
  getDb()
    .prepare(
      `UPDATE mesh_dashboard_grants SET seq = ?, last_published_at = ?, updated_at = ?
       WHERE backend_id = ? AND account_id = ? AND request_id = ?`,
    )
    .run(result.seq, nowIso(), nowIso(), scope.backendId, scope.accountId, row.request_id);
}

/**
 * Sync-cycle hook: pull pending requests into the local mirror, then
 * republish snapshots for live approved grants (bounded by a 30s floor).
 * `guard` aborts the cycle when the runtime generation changed.
 */
export async function serviceDashboardGrants(
  scope: SyncScope,
  guard: () => boolean,
): Promise<void> {
  const { requests } = await dashRpc<DashboardRequestsResult>('dashboard.requests', {});
  for (const request of requests) {
    upsertObserved(scope, request);
  }
  if (!guard()) return;
  // Command work is intentionally detached from this sync cycle. A slow
  // Desktop command must never hold the account sync cursor or block pulls.
  void pumpBrowserWorkspaceCommands(scope, guard).catch(() => undefined);
  const db = getDb();
  const approved = db
    .prepare(
      `SELECT * FROM mesh_dashboard_grants
       WHERE backend_id = ? AND account_id = ? AND state = 'approved'`,
    )
    .all(scope.backendId, scope.accountId) as GrantRow[];
  const now = Date.now();
  for (const row of approved) {
    if (!guard()) return;
    if (Date.parse(row.expires_at) <= now) {
      db.prepare(
        `UPDATE mesh_dashboard_grants SET state = 'expired', updated_at = ?
         WHERE backend_id = ? AND account_id = ? AND request_id = ?`,
      ).run(nowIso(), scope.backendId, scope.accountId, row.request_id);
      revokeSharedBrowserWorkspaceGrant(row.request_id);
      continue;
    }
    const last = row.last_published_at === null ? 0 : Date.parse(row.last_published_at);
    if (now - last < SNAPSHOT_MIN_INTERVAL_MS) continue;
    await publishSnapshot(scope, row).catch(() => undefined);
  }
}

/**
 * Approves a pending request: mints the DSK, seals the grant to the
 * browser's pubkey, publishes the first snapshot, and records the
 * decision. `scopes` must be a subset of the requested set.
 */
export async function approveDashboardRequest(
  scope: SyncScope,
  requestId: string,
  approval?: DashboardGrantApproval,
): Promise<void> {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM mesh_dashboard_grants
       WHERE backend_id = ? AND account_id = ? AND request_id = ?`,
    )
    .get(scope.backendId, scope.accountId, requestId) as GrantRow | undefined;
  if (row === undefined || row.request_json === null) {
    throw new Error(`dashboard request not found: ${requestId}`);
  }
  if (row.state !== 'pending') {
    throw new Error(`dashboard request is ${row.state}, not pending`);
  }
  const request = JSON.parse(row.request_json) as DashboardRequest;
  if (approval === undefined) {
    throw new Error('dashboard approval requires an explicit workspace and repository selection');
  }
  const workspaceId = approval.workspace.workspaceId.trim();
  const repoIds = [...new Set(approval.workspace.repoIds.map((id) => id.trim()).filter(Boolean))];
  if (workspaceId === '') throw new Error('dashboard approval requires a workspace');
  if (repoIds.length === 0) {
    throw new Error('dashboard approval requires at least one repository');
  }
  const workspaceRepoRows = getDb()
    .prepare(
      `SELECT repo_id FROM workspace_repos
       WHERE workspace_id = ? AND repo_id IN (${repoIds.map(() => '?').join(',')})`,
    )
    .all(workspaceId, ...repoIds) as Array<{ repo_id: string }>;
  if (workspaceRepoRows.length !== repoIds.length) {
    throw new Error('dashboard approval includes a repository outside the selected workspace');
  }
  const granted = [...new Set(approval.scopes)];
  // Dashboard projection access is the non-action baseline. Keep existing
  // dashboard flows intact while leaving every workspace action unchecked by
  // default in the approval UI.
  if (
    (request.scopes as readonly string[]).includes('read-dashboard') &&
    !granted.includes('read-dashboard')
  ) {
    granted.unshift('read-dashboard');
  }
  const invalid = granted.filter((s) => !(request.scopes as readonly string[]).includes(s));
  if (invalid.length > 0) {
    throw new Error(`scopes not requested: ${invalid.join(', ')}`);
  }
  if (
    granted.some(
      (scopeName) => !DASHBOARD_WORKSPACE_SCOPES.includes(scopeName as DashboardWorkspaceScope),
    )
  ) {
    throw new Error('dashboard approval includes an unknown scope');
  }
  const expiresAt = request.expiresAt;
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
    throw new Error('dashboard request has expired');
  }
  const dsk = randomBytes(32);
  const inner: DashboardGrantInner = {
    v: 1,
    dsk: dsk.toString('base64'),
    scopes: granted,
    expiresAt,
    workspace: { workspaceId, repoIds },
    enrollmentId: contextProvider?.()?.enrollmentId ?? '',
  };
  if (inner.enrollmentId === '') {
    throw new Error('dashboard approval requires an active enrollment');
  }
  const aad = dashboardGrantAssociatedData({
    backendId: scope.backendId,
    accountId: scope.accountId,
    requestId,
    browserPub: request.browserPub,
    expiresAt,
  });
  const wrapped = sealToRecipientPub(
    request.browserPub,
    Buffer.from(JSON.stringify(inner), 'utf8'),
    aad,
  );
  const grant: DashboardGrantPayload = {
    v: 1,
    enc: 'x25519-aes-256-gcm',
    requestId,
    browserPub: request.browserPub,
    expiresAt,
    ephPub: wrapped.ephPub,
    nonce: wrapped.nonce,
    ct: wrapped.ct,
  };
  const snapshot = sealSnapshot(scope, requestId, dsk, 1, await buildDashboardSnapshot(scope));
  await dashRpc<DashboardDecideResult>('dashboard.decide', {
    requestId,
    decision: 'approved',
    grant,
    snapshot,
    workspaceBindings: [{ workspaceId, repositoryIds: repoIds }],
    grantedScopes: granted,
  });
  db.prepare(
    `UPDATE mesh_dashboard_grants
     SET state = 'approved', dsk_wrapped = ?, scopes_json = ?, workspace_id = ?,
         repo_ids_json = ?, enrollment_id = ?, seq = 1,
         last_published_at = ?, updated_at = ?
     WHERE backend_id = ? AND account_id = ? AND request_id = ?`,
  ).run(
    wrapSecretBytes(dsk),
    JSON.stringify(granted),
    workspaceId,
    JSON.stringify(repoIds),
    inner.enrollmentId,
    nowIso(),
    nowIso(),
    scope.backendId,
    scope.accountId,
    requestId,
  );
}

/** Denies a pending request. */
export async function denyDashboardRequest(scope: SyncScope, requestId: string): Promise<void> {
  await dashRpc<DashboardDecideResult>('dashboard.decide', {
    requestId,
    decision: 'denied',
  });
  getDb()
    .prepare(
      `UPDATE mesh_dashboard_grants SET state = 'denied', updated_at = ?
       WHERE backend_id = ? AND account_id = ? AND request_id = ?`,
    )
    .run(nowIso(), scope.backendId, scope.accountId, requestId);
  revokeSharedBrowserWorkspaceGrant(requestId);
}

/** Revokes a live grant — the snapshot stream ends immediately. */
export async function revokeDashboardGrant(scope: SyncScope, requestId: string): Promise<void> {
  await dashRpc<DashboardRevokeResult>('dashboard.revoke', { requestId });
  getDb()
    .prepare(
      `UPDATE mesh_dashboard_grants SET state = 'revoked', updated_at = ?
       WHERE backend_id = ? AND account_id = ? AND request_id = ?`,
    )
    .run(nowIso(), scope.backendId, scope.accountId, requestId);
  revokeSharedBrowserWorkspaceGrant(requestId);
}

function nowIso(): string {
  return new Date().toISOString();
}

// Re-export for callers that hash/compare snapshot content.
export { canonicalJson };
