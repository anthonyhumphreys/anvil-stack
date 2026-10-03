// BILL-03 authoritative hosted entitlement resolution and enforcement.
//
// Three surfaces share this module: AccountCoordinator gates mutating
// RPC/WebSocket/artifact-byte work through `checkHostedAccess` (with a
// funding-aware DO-local cache in `hosted_entitlement_cache`), and
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
// throws falls back to the bounded cached decision — personal paid state
// earns at most OUTAGE_GRACE_HOURS past its stored paid-through, preview
// entries keep their absolute deadline, and stale team funding is denied.
// Reads and describe are never affected by the enforcement cache.

import type { HostedEntitlement } from '../../../contract/entitlements';
import {
  getEntitlementSnapshot,
  OUTAGE_GRACE_HOURS,
  RENEWAL_GRACE_DAYS,
  resolveHostedLimits,
} from './billing';
import { emitMetric } from './metrics';
import { evaluateHostedEntitlement, PREVIEW_ENDS_AT, PREVIEW_END_MS } from './policy';
import { findActiveBillingBySyncAccount } from './store';

/** Keep hosted funding and membership changes visible within one minute. */
export const ENTITLEMENT_CACHE_TTL_MS = 60 * 1000;
/** Kept as an explicit alias for callers/tests describing team-seat freshness. */
export const TEAM_ENTITLEMENT_CACHE_TTL_MS = ENTITLEMENT_CACHE_TTL_MS;

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
  funded_by TEXT NOT NULL DEFAULT 'none',
  organization_id TEXT,
  revision INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
)`;

interface CachedEntitlement {
  state: string;
  source: string;
  reason: string;
  access_until: number | null;
  paid_through: number | null;
  funded_by: HostedEntitlement['fundedBy'];
  organization_id: string | null;
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
       (id, state, source, reason, access_until, paid_through, funded_by, organization_id, revision, fetched_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       state = excluded.state,
       source = excluded.source,
       reason = excluded.reason,
       access_until = excluded.access_until,
       paid_through = excluded.paid_through,
       funded_by = excluded.funded_by,
       organization_id = excluded.organization_id,
       revision = excluded.revision,
       fetched_at = excluded.fetched_at`,
    entitlement.state,
    entitlement.source,
    entitlement.reason,
    entitlement.accessUntil === null ? null : Date.parse(entitlement.accessUntil),
    paidThrough,
    entitlement.fundedBy,
    entitlement.organizationId,
    entitlement.revision,
    now,
  );
}

function entitlementFromCache(cached: CachedEntitlement, env: Env): HostedEntitlement {
  return {
    state: cached.state as HostedEntitlement['state'],
    source: cached.source as HostedEntitlement['source'],
    planKey:
      cached.funded_by === 'team'
        ? 'sync_team'
        : cached.funded_by === 'personal'
          ? 'sync_personal'
          : null,
    fundedBy: cached.funded_by,
    organizationId: cached.organization_id,
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
 * path. An account with no billing row is preview-eligible only in the
 * explicit local test-spike environment.
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
      previewEligible: env.ANVIL_DEV_SPIKE === 'true',
      revision: 0,
      limits,
      subscriptions: [],
      billingUnavailable: false,
      renewalGraceDays: RENEWAL_GRACE_DAYS,
      outageGraceHours: OUTAGE_GRACE_HOURS,
    });
  }
  return (await getEntitlementSnapshot(db, billing, now, limits, false)).entitlement;
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
    fundedBy: 'none',
    organizationId: null,
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
  // Team funding comes from a removable organization membership/seat. Once
  // its short cache expires, an outage must not restore that access.
  if (cached.funded_by === 'team') {
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
        fundedBy: 'personal',
        organizationId: null,
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
 * `allowed: false`. Cache reuse is bounded by the funding-specific TTL
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
  const cacheTtl =
    cached?.funded_by === 'team' ? TEAM_ENTITLEMENT_CACHE_TTL_MS : ENTITLEMENT_CACHE_TTL_MS;
  if (
    cached !== null &&
    now - cached.fetched_at >= 0 &&
    now - cached.fetched_at <= cacheTtl &&
    (cached.access_until === null || cached.access_until > now)
  ) {
    const entitlement = entitlementFromCache(cached, env);
    emitMetric('entitlement.decision', {
      state: entitlement.state,
      source: entitlement.source,
      reason: entitlement.reason,
      cached: true,
    });
    if (allowsWrite(entitlement)) return { allowed: true, entitlement };
    emitMetric('enforcement.denial', { reason: entitlement.reason });
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
        previewEligible: env.ANVIL_DEV_SPIKE === 'true',
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
    const fallback = outageFallback(cached, env, now);
    emitMetric('entitlement.decision', {
      state: fallback.entitlement?.state ?? 'unknown',
      source: fallback.entitlement?.source ?? 'none',
      reason: fallback.entitlement?.reason ?? 'billing-unavailable',
      cached: false,
      outageFallback: true,
    });
    if (!fallback.allowed) emitMetric('enforcement.denial', { reason: fallback.reason });
    return fallback;
  }
  try {
    writeCache(storage, entitlement, paidThrough, now);
  } catch {
    // A cache write failure must not change the decision itself.
  }
  emitMetric('entitlement.decision', {
    state: entitlement.state,
    source: entitlement.source,
    reason: entitlement.reason,
    cached: false,
  });
  if (allowsWrite(entitlement)) return { allowed: true, entitlement };
  emitMetric('enforcement.denial', { reason: entitlement.reason });
  return { allowed: false, entitlement, reason: entitlement.reason };
}
