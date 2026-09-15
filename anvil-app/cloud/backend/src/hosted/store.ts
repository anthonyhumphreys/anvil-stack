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
// `hosted_link_codes` are the website→device link secret: only SHA-256
// hashes of the normalized code are stored, exactly like enrollment codes.
// `service_nonces` backs the HMAC service channel's replay protection.

import { sha256Hex } from '../hash';
import { initialHostedSyncAccountId, type HostedIdentity } from './identity';

const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ACTIVE_LINK_CODES_PER_ACCOUNT = 5;
/** Same unambiguous alphabet as SessionCoordinator enrollment codes. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const BILLING_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export interface BillingAccountRow {
  id: string;
  workos_client_id: string;
  workos_user_id: string;
  sync_account_id: string | null;
  generation: number;
  lifecycle: 'active' | 'deleting' | 'deleted';
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

/** `anvil-lc-XXXXX-…` — enrollment-code format, distinct hosted prefix. */
function generateLinkCode(): { code: string; normalized: string } {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let raw = '';
  for (const byte of bytes) {
    raw += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return {
    code: `anvil-lc-${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`,
    normalized: raw,
  };
}

/** Mirrors enrollment-code normalization: prefix, separators and case go. */
function normalizeLinkCode(code: string): string {
  return code
    .trim()
    .replace(/^anvil-lc-/i, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

export async function getBillingAccountByIdentity(
  db: D1Database,
  identity: HostedIdentity,
): Promise<BillingAccountRow | null> {
  return db
    .prepare(
      'SELECT * FROM billing_accounts WHERE workos_client_id = ? AND workos_user_id = ?',
    )
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
    .bind(syncAccountId, generation, Date.now(), billingAccountId, row.generation, row.sync_account_id)
    .run();
  if (result.meta.changes !== 1) {
    throw new HostedConflictError('billing account generation guard rejected the write');
  }
  return { syncAccountId, generation };
}

/**
 * Lifecycle transitions are one-way: active → deleting → deleted. Anything
 * else (resurrection, skipping states) lands zero rows and returns false.
 */
export async function markBillingLifecycle(
  db: D1Database,
  billingAccountId: string,
  next: 'deleting' | 'deleted',
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE billing_accounts SET lifecycle = ?, updated_at = ?
       WHERE id = ? AND (
         (? = 'deleting' AND lifecycle = 'active') OR
         (? = 'deleted' AND lifecycle IN ('active', 'deleting'))
       )`,
    )
    .bind(next, Date.now(), billingAccountId, next, next)
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

/**
 * Mints a single-use link code (10-minute TTL, hashed at rest). Returns
 * null when the account already has 5 live codes — the caller maps that
 * to 429 throttled.
 */
export async function issueHostedLinkCode(
  db: D1Database,
  billingAccountId: string,
): Promise<{ code: string; expiresAt: string } | null> {
  const now = Date.now();
  const active = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM hosted_link_codes
       WHERE billing_account_id = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .bind(billingAccountId, now)
    .first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_ACTIVE_LINK_CODES_PER_ACCOUNT) return null;
  const { code, normalized } = generateLinkCode();
  const codeHash = await sha256Hex(normalized);
  await db
    .prepare(
      `INSERT INTO hosted_link_codes (code_hash, billing_account_id, expires_at, consumed_at, created_at)
       VALUES (?, ?, ?, NULL, ?)`,
    )
    .bind(codeHash, billingAccountId, now + LINK_CODE_TTL_MS, now)
    .run();
  return { code, expiresAt: new Date(now + LINK_CODE_TTL_MS).toISOString() };
}

/**
 * Single atomic consume: the UPDATE lands only for an unconsumed,
 * unexpired code, so a replayed code can never win the race twice.
 * Returns the owning billing_account_id, or null for wrong/spent/expired.
 */
export async function consumeHostedLinkCode(
  db: D1Database,
  code: string,
): Promise<string | null> {
  const normalized = normalizeLinkCode(code);
  if (normalized.length === 0) return null;
  const codeHash = await sha256Hex(normalized);
  const now = Date.now();
  const updated = await db
    .prepare(
      `UPDATE hosted_link_codes SET consumed_at = ?
       WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .bind(now, codeHash, now)
    .run();
  if (updated.meta.changes === 0) return null;
  const row = await db
    .prepare('SELECT billing_account_id FROM hosted_link_codes WHERE code_hash = ?')
    .bind(codeHash)
    .first<{ billing_account_id: string }>();
  return row?.billing_account_id ?? null;
}
