// BILL-03 authoritative hosted entitlement resolution and enforcement.
//
// Three surfaces share this module: AccountCoordinator gates mutating
// RPC/WebSocket/artifact-byte work through `checkHostedAccess` (with a
// five-minute DO-local cache in `hosted_entitlement_cache`), and
// SessionCoordinator surfaces the same decision on `session.describe`
// through `resolveAccountEntitlement`.
//
// Deployment modes:
// - Self-host (no HOSTED_DB binding): fully inert — `checkHostedAccess`
//   never denies and `resolveAccountEntitlement` is never called.
// - Hosted with HOSTED_BILLING_ENFORCEMENT !== 'true': entitlement is
//   still resolved for describe, but no operation is denied.
// - Hosted with the flag 'true': restricted/unknown entitlements deny
//   mutating operations with `forbidden`.
//
// Failure modes are fail-closed for writes only: a billing lookup that
// throws falls back to the bounded cached decision — last verified paid
// state earns at most OUTAGE_GRACE_HOURS past its stored paid-through,
// preview/grace entries keep their already-absolute deadline, and no
// cache resolves to `unknown` (denied). Reads and describe are never
// affected by the cache.

import type { HostedEntitlement } from '../../../contract/entitlements';
import {
  getEntitlementSnapshot,
  OUTAGE_GRACE_HOURS,
  RENEWAL_GRACE_DAYS,
  resolveHostedLimits,
} from './billing';
import { evaluateHostedEntitlement, PREVIEW_ENDS_AT, PREVIEW_END_MS } from './policy';
import { findActiveBillingBySyncAccount } from './store';

/** BILL-03 bound: a cached entitlement decision is reused at most this long. */
export const ENTITLEMENT_CACHE_TTL_MS = 5 * 60 * 1000;

const OUTAGE_GRACE_MS = OUTAGE_GRACE_HOURS * 3_600_000;

/**
 * Per-account entitlement cache living in the AccountCoordinator's SQLite
 * storage — deliberately NOT part of ACCOUNT_SCHEMA (schema.ts is frozen);
 * the constructor executes this DDL separately.
 */
export const ENTITLEMENT_CACHE_DDL = `CREATE TABLE IF NOT EXISTS hosted_entitlement_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  access_until INTEGER,
  paid_through INTEGER,
  revision INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
)`;

interface CachedEntitlement {
  state: string;
  source: string;
  reason: string;
  access_until: number | null;
  paid_through: number | null;
  revision: number;
  fetched_at: number;
}

/**
 * Result of the enforcement check. `entitlement` is null only on the
 * inert path (self-host or enforcement flag off); `reason` on a denial is
 * a HostedEntitlement reason, mapped to `forbidden` details by callers.
 */
export type HostedAccess =
  | { allowed: true; entitlement: HostedEntitlement | null }
  | { allowed: false; entitlement: HostedEntitlement | null; reason: string };

/** Whether the deployment denies mutating work for restricted accounts. */
export function hostedEnforcementEnabled(env: Env): boolean {
  return env.HOSTED_BILLING_ENFORCEMENT === 'true' && env.HOSTED_DB !== undefined;
}

/**
 * Sanity check for hosted deployments: with enforcement requested, the
 * billing database and the hosted service-surface keys must both exist —
 * a flag without bindings would silently behave like self-host.
 */
export function hostedConfigIssues(env: Env): string[] {
  if (env.HOSTED_BILLING_ENFORCEMENT !== 'true') return [];
  const missing: string[] = [];
  if (env.HOSTED_DB === undefined) missing.push('HOSTED_DB');
  if (typeof env.HOSTED_SERVICE_KEYS !== 'string' || env.HOSTED_SERVICE_KEYS.length === 0) {
    missing.push('HOSTED_SERVICE_KEYS');
  }
  return missing;
}

function readCache(storage: DurableObjectStorage): CachedEntitlement | null {
  return (
    (storage.sql
      .exec('SELECT * FROM hosted_entitlement_cache WHERE id = 1')
      .toArray()[0] as unknown as CachedEntitlement | undefined) ?? null
  );
}

function writeCache(
  storage: DurableObjectStorage,
  entitlement: HostedEntitlement,
  paidThrough: number | null,
  now: number,
): void {
  storage.sql.exec(
    `INSERT INTO hosted_entitlement_cache
       (id, state, source, reason, access_until, paid_through, revision, fetched_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       state = excluded.state,
       source = excluded.source,
       reason = excluded.reason,
       access_until = excluded.access_until,
       paid_through = excluded.paid_through,
       revision = excluded.revision,
       fetched_at = excluded.fetched_at`,
    entitlement.state,
    entitlement.source,
    entitlement.reason,
    entitlement.accessUntil === null ? null : Date.parse(entitlement.accessUntil),
    paidThrough,
    entitlement.revision,
    now,
  );
}

function entitlementFromCache(cached: CachedEntitlement, env: Env): HostedEntitlement {
  return {
    state: cached.state as HostedEntitlement['state'],
    source: cached.source as HostedEntitlement['source'],
    planKey: cached.source === 'preview' || cached.source === 'none' ? null : 'sync_personal',
    capabilities:
      cached.state === 'preview' || cached.state === 'active' || cached.state === 'grace'
        ? { syncWrite: true, meshSubmit: true }
        : { syncWrite: false, meshSubmit: false },
    limits: resolveHostedLimits(env),
    previewEndsAt: PREVIEW_ENDS_AT,
    accessUntil: cached.access_until === null ? null : new Date(cached.access_until).toISOString(),
    graceUntil:
      cached.state === 'grace' && cached.access_until !== null
        ? new Date(cached.access_until).toISOString()
        : null,
    checkedAt: new Date(cached.fetched_at).toISOString(),
    revision: cached.revision,
    reason: cached.reason as HostedEntitlement['reason'],
  };
}

function allowsWrite(entitlement: HostedEntitlement): boolean {
  return entitlement.capabilities.syncWrite && entitlement.capabilities.meshSubmit;
}

/**
 * Uncached resolution straight from hosted truth — the session.describe
 * path. An account with no billing row is preview-eligible until the
 * absolute preview cutoff, matching the empty-subscription policy result.
 */
export async function resolveAccountEntitlement(
  env: Env,
  accountId: string,
  now: number,
): Promise<HostedEntitlement> {
  const db = env.HOSTED_DB;
  if (db === undefined) throw new Error('resolveAccountEntitlement requires HOSTED_DB');
  const limits = resolveHostedLimits(env);
  const billing = await findActiveBillingBySyncAccount(db, accountId);
  if (billing === null) {
    return evaluateHostedEntitlement({
      now,
      lifecycle: 'active',
      previewEligible: true,
      revision: 0,
      limits,
      subscriptions: [],
      billingUnavailable: false,
      renewalGraceDays: RENEWAL_GRACE_DAYS,
      outageGraceHours: OUTAGE_GRACE_HOURS,
    });
  }
  return (
    await getEntitlementSnapshot(db, billing, now, limits, false)
  ).entitlement;
}

/**
 * Bounded last-verified-state fallback when the billing lookup itself
 * fails. Paid cache earns outage grace bounded by the stored paid-through
 * (+ OUTAGE_GRACE_HOURS); preview/grace entries keep their absolute
 * deadline and are never extended by the outage; anything else — and no
 * cache — resolves to `unknown`, which denies writes.
 */
function outageFallback(cached: CachedEntitlement | null, env: Env, now: number): HostedAccess {
  const limits = resolveHostedLimits(env);
  const base: HostedEntitlement = {
    state: 'unknown',
    source: 'none',
    planKey: null,
    capabilities: { syncWrite: false, meshSubmit: false },
    limits,
    previewEndsAt: PREVIEW_ENDS_AT,
    accessUntil: null,
    graceUntil: null,
    checkedAt: new Date(now).toISOString(),
    revision: cached?.revision ?? 0,
    reason: 'billing-unavailable',
  };
  if (cached === null) {
    return { allowed: false, entitlement: base, reason: 'billing-unavailable' };
  }
  if (cached.source === 'subscription' && cached.paid_through !== null) {
    const graceEnd = cached.paid_through + OUTAGE_GRACE_MS;
    if (graceEnd > now) {
      const entitlement: HostedEntitlement = {
        ...base,
        state: 'grace',
        source: 'outage-grace',
        planKey: 'sync_personal',
        capabilities: { syncWrite: true, meshSubmit: true },
        accessUntil: new Date(graceEnd).toISOString(),
        graceUntil: new Date(graceEnd).toISOString(),
        reason: 'billing-outage',
      };
      return { allowed: true, entitlement };
    }
    return { allowed: false, entitlement: base, reason: 'billing-unavailable' };
  }
  if (cached.access_until !== null && cached.access_until > now) {
    const entitlement = entitlementFromCache(cached, env);
    if (allowsWrite(entitlement)) {
      return { allowed: true, entitlement };
    }
  }
  return { allowed: false, entitlement: base, reason: 'billing-unavailable' };
}

/**
 * The enforcement check. Mutating callers deny when this returns
 * `allowed: false`. Cache reuse is bounded by ENTITLEMENT_CACHE_TTL_MS
 * and by the decision's absolute access deadline, so a preview grant can
 * never outlive the cutoff even inside the TTL window.
 */
export async function checkHostedAccess(
  storage: DurableObjectStorage,
  env: Env,
  accountId: string,
  now: number,
): Promise<HostedAccess> {
  if (!hostedEnforcementEnabled(env)) {
    return { allowed: true, entitlement: null };
  }
  const cached = readCache(storage);
  if (
    cached !== null &&
    now - cached.fetched_at >= 0 &&
    now - cached.fetched_at <= ENTITLEMENT_CACHE_TTL_MS &&
    (cached.access_until === null || cached.access_until > now)
  ) {
    const entitlement = entitlementFromCache(cached, env);
    if (allowsWrite(entitlement)) return { allowed: true, entitlement };
    return { allowed: false, entitlement, reason: entitlement.reason };
  }
  let entitlement: HostedEntitlement;
  let paidThrough: number | null = null;
  try {
    const db = env.HOSTED_DB;
    if (db === undefined) throw new Error('HOSTED_DB binding required');
    const limits = resolveHostedLimits(env);
    const billing = await findActiveBillingBySyncAccount(db, accountId);
    if (billing === null) {
      entitlement = evaluateHostedEntitlement({
        now,
        lifecycle: 'active',
        previewEligible: true,
        revision: 0,
        limits,
        subscriptions: [],
        billingUnavailable: false,
        renewalGraceDays: RENEWAL_GRACE_DAYS,
        outageGraceHours: OUTAGE_GRACE_HOURS,
      });
    } else {
      const snapshot = await getEntitlementSnapshot(db, billing, now, limits, false);
      entitlement = snapshot.entitlement;
      paidThrough = snapshot.paidThrough;
    }
  } catch {
    return outageFallback(cached, env, now);
  }
  try {
    writeCache(storage, entitlement, paidThrough, now);
  } catch {
    // A cache write failure must not change the decision itself.
  }
  if (allowsWrite(entitlement)) return { allowed: true, entitlement };
  return { allowed: false, entitlement, reason: entitlement.reason };
}
