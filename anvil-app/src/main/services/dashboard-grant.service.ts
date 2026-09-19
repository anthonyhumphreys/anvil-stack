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

import { randomBytes } from 'node:crypto';
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
  DashboardScope,
} from '../../../cloud/contract/dashboard.js';
import type { JobListResult } from '../../../cloud/contract/jobs.js';
import type { SyncScope } from '../../shared/sync-mesh.js';
import {
  sealJsonEnvelope,
  sealToRecipientPub,
  unwrapSecretBytes,
  wrapSecretBytes,
} from './sync-keyring.service.js';
import { canonicalJson } from './sync-persistence.service.js';

interface DashboardGrantContext {
  apiUrl: string;
  accessToken: string;
  enrollmentId: string;
}

let contextProvider: (() => DashboardGrantContext | null) | null = null;

export function configureDashboardGrantContext(
  provider: () => DashboardGrantContext | null,
): void {
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
}

interface GrantRow {
  request_id: string;
  browser_pub: string;
  dsk_wrapped: Buffer | null;
  scopes_json: string;
  expires_at: string;
  seq: number;
  state: string;
  request_json: string | null;
  last_published_at: string | null;
}

function rowToGrant(row: GrantRow): DashboardGrantRow {
  return {
    requestId: row.request_id,
    browserPub: row.browser_pub,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    seq: row.seq,
    state: row.state as DashboardGrantRow['state'],
    request: row.request_json === null ? null : (JSON.parse(row.request_json) as DashboardRequest),
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

function upsertObserved(scope: SyncScope, request: DashboardRequest): void {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT state FROM mesh_dashboard_grants
       WHERE backend_id = ? AND account_id = ? AND request_id = ?`,
    )
    .get(scope.backendId, scope.accountId, request.requestId) as
    | { state: string }
    | undefined;
  // A locally decided state (approved/denied/revoked) is authoritative —
  // mirror only requests we have not acted on, or terminal backend
  // transitions we have not seen yet.
  if (existing !== undefined && existing.state !== 'pending') {
    if (['expired', 'revoked', 'denied'].includes(request.state) && existing.state !== request.state) {
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
  scopes?: DashboardScope[],
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
  const granted = scopes ?? request.scopes;
  const invalid = granted.filter((s) => !request.scopes.includes(s));
  if (invalid.length > 0) {
    throw new Error(`scopes not requested: ${invalid.join(', ')}`);
  }
  const expiresAt = request.expiresAt;
  const dsk = randomBytes(32);
  const inner: DashboardGrantInner = {
    v: 1,
    dsk: dsk.toString('base64'),
    scopes: granted,
    expiresAt,
  };
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
  });
  db.prepare(
    `UPDATE mesh_dashboard_grants
     SET state = 'approved', dsk_wrapped = ?, scopes_json = ?, seq = 1,
         last_published_at = ?, updated_at = ?
     WHERE backend_id = ? AND account_id = ? AND request_id = ?`,
  ).run(
    wrapSecretBytes(dsk),
    JSON.stringify(granted),
    nowIso(),
    nowIso(),
    scope.backendId,
    scope.accountId,
    requestId,
  );
}

/** Denies a pending request. */
export async function denyDashboardRequest(
  scope: SyncScope,
  requestId: string,
): Promise<void> {
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
}

/** Revokes a live grant — the snapshot stream ends immediately. */
export async function revokeDashboardGrant(
  scope: SyncScope,
  requestId: string,
): Promise<void> {
  await dashRpc<DashboardRevokeResult>('dashboard.revoke', { requestId });
  getDb()
    .prepare(
      `UPDATE mesh_dashboard_grants SET state = 'revoked', updated_at = ?
       WHERE backend_id = ? AND account_id = ? AND request_id = ?`,
    )
    .run(nowIso(), scope.backendId, scope.accountId, requestId);
}

function nowIso(): string {
  return new Date().toISOString();
}

// Re-export for callers that hash/compare snapshot content.
export { canonicalJson };
