// D1 access layer for the hosted billing identity store (BILL-01).
//
// `billing_accounts` maps a verified WorkOS (client, user) identity to at
// most one sync account plus a generation counter: when the mapped sync
// account is tombstoned, the mapping rolls to `${base}~${generation}` —
// the same `base~N` convention SessionCoordinator's OIDC enroll path uses.
// The UNIQUE(workos_client_id, workos_user_id) constraint means a deleted
// identity can never be resurrected as a fresh row; callers get the dead
// row back and must deny on lifecycle.
//
// `service_nonces` backs the HMAC service channel's replay protection.

import { sha256Hex } from '../hash';
import { initialHostedSyncAccountId, type HostedIdentity } from './identity';

const BILLING_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export interface BillingAccountRow {
  id: string;
  workos_client_id: string;
  workos_user_id: string;
  sync_account_id: string | null;
  generation: number;
  lifecycle: 'active' | 'deleting' | 'deleted';
  /** BILL-03 per-account preview lever (migration 0003, default 1). */
  preview_eligible: number;
  created_at: number;
  updated_at: number;
}

/** A guarded write landed on a row that no longer satisfies its guard. */
export class HostedConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedConflictError';
  }
}

function newBillingAccountId(): string {
  const bytes = new Uint8Array(26);
  crypto.getRandomValues(bytes);
  let id = 'bill_';
  for (const byte of bytes) {
    id += BILLING_ID_ALPHABET[byte % BILLING_ID_ALPHABET.length];
  }
  return id;
}

export async function getBillingAccountByIdentity(
  db: D1Database,
  identity: HostedIdentity,
): Promise<BillingAccountRow | null> {
  return db
    .prepare('SELECT * FROM billing_accounts WHERE workos_client_id = ? AND workos_user_id = ?')
    .bind(identity.workosClientId, identity.workosUserId)
    .first<BillingAccountRow>();
}

export async function getBillingAccountById(
  db: D1Database,
  billingAccountId: string,
): Promise<BillingAccountRow | null> {
  return db
    .prepare('SELECT * FROM billing_accounts WHERE id = ?')
    .bind(billingAccountId)
    .first<BillingAccountRow>();
}

/**
 * Returns the existing row for the identity — INCLUDING `deleted` rows:
 * the UNIQUE(client, user) constraint forbids a replacement row, so a
 * deleted identity can only ever map back to its dead record and callers
 * must deny on lifecycle. Creates a fresh unlinked row otherwise. A
 * concurrent insert loses the UNIQUE race and re-reads the winner's row.
 */
export async function getOrCreateBillingAccount(
  db: D1Database,
  identity: HostedIdentity,
): Promise<BillingAccountRow> {
  const existing = await getBillingAccountByIdentity(db, identity);
  if (existing !== null) return existing;
  const now = Date.now();
  try {
    await db
      .prepare(
        `INSERT INTO billing_accounts
          (id, workos_client_id, workos_user_id, sync_account_id,
           generation, lifecycle, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 1, 'active', ?, ?)`,
      )
      .bind(newBillingAccountId(), identity.workosClientId, identity.workosUserId, now, now)
      .run();
  } catch {
    // Concurrent signup raced the same identity: fall through to re-read.
  }
  const row = await getBillingAccountByIdentity(db, identity);
  if (row === null) throw new Error('billing account insert failed');
  return row;
}

/** The active billing account claiming a sync account, if any. */
export async function findActiveBillingBySyncAccount(
  db: D1Database,
  syncAccountId: string,
): Promise<BillingAccountRow | null> {
  return db
    .prepare(
      `SELECT * FROM billing_accounts
       WHERE sync_account_id = ? AND lifecycle = 'active'`,
    )
    .bind(syncAccountId)
    .first<BillingAccountRow>();
}

/** Any lifecycle row claiming a sync account, including deleting/deleted. */
export async function findBillingBySyncAccount(
  db: D1Database,
  syncAccountId: string,
): Promise<BillingAccountRow | null> {
  return db
    .prepare('SELECT * FROM billing_accounts WHERE sync_account_id = ?')
    .bind(syncAccountId)
    .first<BillingAccountRow>();
}

/**
 * First-time (or idempotent same-account) link write. The guard refuses to
 * move an existing link to a different account — that path is
 * `bumpGeneration` — and refuses dead rows entirely.
 */
export async function setSyncAccountLink(
  db: D1Database,
  billingAccountId: string,
  syncAccountId: string,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE billing_accounts SET sync_account_id = ?, updated_at = ?
       WHERE id = ? AND lifecycle = 'active'
         AND (sync_account_id IS NULL OR sync_account_id = ?)`,
    )
    .bind(syncAccountId, Date.now(), billingAccountId, syncAccountId)
    .run();
  if (result.meta.changes !== 1) {
    throw new HostedConflictError('billing account link guard rejected the write');
  }
}

/**
 * Rolls the mapping to the next generation after the mapped sync account
 * was tombstoned: generation+1 and sync_account_id =
 * `${initialHostedSyncAccountId}~${generation}`. Guarded on the exact row
 * state we read (`IS ?` is SQLite's null-safe equality) so a concurrent
 * relink or lifecycle change loses cleanly.
 */
export async function bumpGeneration(
  db: D1Database,
  billingAccountId: string,
): Promise<{ syncAccountId: string; generation: number }> {
  const row = await getBillingAccountById(db, billingAccountId);
  if (row === null || row.lifecycle !== 'active') {
    throw new HostedConflictError('billing account is not active');
  }
  const base = await initialHostedSyncAccountId({
    workosClientId: row.workos_client_id,
    workosUserId: row.workos_user_id,
  });
  const generation = row.generation + 1;
  const syncAccountId = `${base}~${generation}`;
  const result = await db
    .prepare(
      `UPDATE billing_accounts
       SET sync_account_id = ?, generation = ?, updated_at = ?
       WHERE id = ? AND lifecycle = 'active'
         AND generation = ? AND sync_account_id IS ?`,
    )
    .bind(
      syncAccountId,
      generation,
      Date.now(),
      billingAccountId,
      row.generation,
      row.sync_account_id,
    )
    .run();
  if (result.meta.changes !== 1) {
    throw new HostedConflictError('billing account generation guard rejected the write');
  }
  return { syncAccountId, generation };
}

/**
 * Lifecycle transitions are one-way: active → deleting → deleted. Anything
 * else (resurrection, skipping states) lands zero rows and returns false.
 * When reconciling a probed generation, pass its id so a stale probe cannot
 * apply deletion to a billing row that has since advanced to a new mapping.
 */
export async function markBillingLifecycle(
  db: D1Database,
  billingAccountId: string,
  next: 'deleting' | 'deleted',
  expectedSyncAccountId?: string,
): Promise<boolean> {
  const syncAccountGuard = expectedSyncAccountId === undefined ? '' : ' AND sync_account_id = ?';
  const statement = db.prepare(
    `UPDATE billing_accounts SET lifecycle = ?, updated_at = ?
     WHERE id = ? AND (
       (? = 'deleting' AND lifecycle = 'active') OR
       (? = 'deleted' AND lifecycle IN ('active', 'deleting'))
     )${syncAccountGuard}`,
  );
  const result =
    expectedSyncAccountId === undefined
      ? await statement.bind(next, Date.now(), billingAccountId, next, next).run()
      : await statement
          .bind(next, Date.now(), billingAccountId, next, next, expectedSyncAccountId)
          .run();
  return result.meta.changes === 1;
}

/**
 * Replay-protection nonce insert: true when the (keyId, requestId) pair is
 * fresh, false on replay. Also sweeps rows whose signature window has
 * passed — cheap at this table's size.
 */
export async function consumeServiceNonce(
  db: D1Database,
  keyId: string,
  requestId: string,
  expiresAt: number,
): Promise<boolean> {
  const now = Date.now();
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO service_nonces (key_id, request_id, expires_at, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(keyId, requestId, expiresAt, now)
    .run();
  await db.prepare('DELETE FROM service_nonces WHERE expires_at < ?').bind(now).run();
  return inserted.meta.changes > 0;
}
