// BILL-02 billing store — the D1 layer over the Stripe mirror tables from
// migrations/hosted-billing/0002_billing.sql, plus the read model that
// feeds evaluateHostedEntitlement.
//
// stripe_subscriptions is a verbatim provider mirror: webhook upserts
// overwrite the Stripe-owned fields (status, period end, cancel flag)
// wholesale because event order is not guaranteed and reconciliation is
// the repair path. Two columns are our own bookkeeping and survive every
// upsert: has_paid_invoice only ever moves 0 -> 1 (recordInvoicePaid),
// and first_failed_renewal_at sticks at the FIRST failed renewal so
// Stripe retry attempts can never restart the grace clock.

import type { HostedEntitlement, HostedLimits } from '../../../contract/entitlements';
import { isRecord } from '../rpc';
import {
  DEFAULT_HOSTED_LIMITS,
  evaluateHostedEntitlement,
  type HostedSubscriptionState,
} from './policy';
import type { StripeSubscription } from './stripe';
import type { BillingAccountRow } from './store';

export const RENEWAL_GRACE_DAYS = 7;
export const OUTAGE_GRACE_HOURS = 24;

export type BillingInterval = 'month' | 'year';

export interface StripeCustomerRow {
  stripe_customer_id: string;
  billing_account_id: string;
  created_at: number;
}

export interface StripeSubscriptionRow {
  stripe_subscription_id: string;
  stripe_customer_id: string;
  billing_account_id: string;
  status: string;
  plan_key: string;
  interval: string;
  current_period_end: number;
  cancel_at_period_end: number;
  has_paid_invoice: number;
  first_failed_renewal_at: number | null;
  verified_at: number;
  created_at: number;
  updated_at: number;
}

export interface CheckoutSessionRow {
  stripe_session_id: string;
  billing_account_id: string;
  plan_key: string;
  interval: string;
  status: 'open' | 'complete' | 'expired';
  created_at: number;
  completed_at: number | null;
}

export interface WebhookEventRow {
  stripe_event_id: string;
  type: string;
  status: 'pending' | 'processed' | 'failed';
  attempts: number;
  last_error: string | null;
  created_at: number;
  processed_at: number | null;
}

export async function getStripeCustomerForAccount(
  db: D1Database,
  billingAccountId: string,
): Promise<StripeCustomerRow | null> {
  return db
    .prepare('SELECT * FROM stripe_customers WHERE billing_account_id = ?')
    .bind(billingAccountId)
    .first<StripeCustomerRow>();
}

/** Customer -> billing account resolution for inbound webhook events. */
export async function getBillingAccountIdByCustomer(
  db: D1Database,
  stripeCustomerId: string,
): Promise<string | null> {
  const row = await db
    .prepare('SELECT billing_account_id FROM stripe_customers WHERE stripe_customer_id = ?')
    .bind(stripeCustomerId)
    .first<{ billing_account_id: string }>();
  return row?.billing_account_id ?? null;
}

/**
 * Records the Stripe customer created for an account. The insert is
 * idempotent on the customer id; a UNIQUE(billing_account_id) violation
 * means the account already has a customer and the existing row wins.
 */
export async function upsertStripeCustomer(
  db: D1Database,
  billingAccountId: string,
  stripeCustomerId: string,
): Promise<StripeCustomerRow> {
  await db
    .prepare(
      `INSERT INTO stripe_customers (stripe_customer_id, billing_account_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(stripe_customer_id) DO NOTHING`,
    )
    .bind(stripeCustomerId, billingAccountId, Date.now())
    .run();
  const row = await db
    .prepare('SELECT * FROM stripe_customers WHERE stripe_customer_id = ?')
    .bind(stripeCustomerId)
    .first<StripeCustomerRow>();
  if (row === null) throw new Error('stripe customer upsert failed');
  return row;
}

/**
 * Last-writer-wins mirror of a Stripe subscription object. Stripe-owned
 * fields are overwritten with the event's values; our bookkeeping columns
 * (has_paid_invoice, first_failed_renewal_at) are deliberately absent
 * from the UPDATE so an event can never unset them. Stripe timestamps
 * arrive in seconds and are stored in milliseconds.
 */
export async function upsertSubscriptionFromStripe(
  db: D1Database,
  billingAccountId: string,
  sub: StripeSubscription,
  now: number,
): Promise<void> {
  const interval: BillingInterval =
    sub.items.data[0]?.price.recurring?.interval === 'year' ? 'year' : 'month';
  await db
    .prepare(
      `INSERT INTO stripe_subscriptions
        (stripe_subscription_id, stripe_customer_id, billing_account_id,
         status, plan_key, interval, current_period_end, cancel_at_period_end,
         has_paid_invoice, first_failed_renewal_at, verified_at,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, 'sync_personal', ?, ?, ?, 0, NULL, ?, ?, ?)
       ON CONFLICT(stripe_subscription_id) DO UPDATE SET
         stripe_customer_id = excluded.stripe_customer_id,
         billing_account_id = excluded.billing_account_id,
         status = excluded.status,
         interval = excluded.interval,
         current_period_end = excluded.current_period_end,
         cancel_at_period_end = excluded.cancel_at_period_end,
         verified_at = excluded.verified_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      sub.id,
      sub.customer,
      billingAccountId,
      sub.status,
      interval,
      sub.current_period_end * 1000,
      sub.cancel_at_period_end ? 1 : 0,
      now,
      now,
      now,
    )
    .run();
}

/** Paid invoice observed: grants the paid marker and clears renewal failure. */
export async function recordInvoicePaid(
  db: D1Database,
  stripeSubscriptionId: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE stripe_subscriptions
       SET has_paid_invoice = 1, first_failed_renewal_at = NULL, updated_at = ?
       WHERE stripe_subscription_id = ?`,
    )
    .bind(now, stripeSubscriptionId)
    .run();
  return result.meta.changes === 1;
}

/**
 * Failed renewal observed: sticks the FIRST failure timestamp only.
 * COALESCE keeps an existing value so Stripe's dunning retries cannot
 * move the grace window start.
 */
export async function recordInvoiceFailed(
  db: D1Database,
  stripeSubscriptionId: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE stripe_subscriptions
       SET first_failed_renewal_at = COALESCE(first_failed_renewal_at, ?),
           updated_at = ?
       WHERE stripe_subscription_id = ?`,
    )
    .bind(now, now, stripeSubscriptionId)
    .run();
  return result.meta.changes === 1;
}

/** subscription.deleted: mark canceled and stamp provider-truth time. */
export async function markSubscriptionDeleted(
  db: D1Database,
  stripeSubscriptionId: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE stripe_subscriptions
       SET status = 'canceled', verified_at = ?, updated_at = ?
       WHERE stripe_subscription_id = ?`,
    )
    .bind(now, now, stripeSubscriptionId)
    .run();
  return result.meta.changes === 1;
}

export async function recordCheckoutSession(
  db: D1Database,
  stripeSessionId: string,
  billingAccountId: string,
  planKey: string,
  interval: BillingInterval,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO checkout_sessions
        (stripe_session_id, billing_account_id, plan_key, interval,
         status, created_at, completed_at)
       VALUES (?, ?, ?, ?, 'open', ?, NULL)
       ON CONFLICT(stripe_session_id) DO NOTHING`,
    )
    .bind(stripeSessionId, billingAccountId, planKey, interval, now)
    .run();
}

/** Terminal checkout transitions, guarded so only 'open' rows move. */
export async function markCheckoutComplete(
  db: D1Database,
  stripeSessionId: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE checkout_sessions SET status = 'complete', completed_at = ?
       WHERE stripe_session_id = ? AND status = 'open'`,
    )
    .bind(now, stripeSessionId)
    .run();
  return result.meta.changes === 1;
}

export async function markCheckoutExpired(
  db: D1Database,
  stripeSessionId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE checkout_sessions SET status = 'expired'
       WHERE stripe_session_id = ? AND status = 'open'`,
    )
    .bind(stripeSessionId)
    .run();
  return result.meta.changes === 1;
}

export async function latestOpenCheckout(
  db: D1Database,
  billingAccountId: string,
): Promise<CheckoutSessionRow | null> {
  return db
    .prepare(
      `SELECT * FROM checkout_sessions
       WHERE billing_account_id = ? AND status = 'open'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(billingAccountId)
    .first<CheckoutSessionRow>();
}

/**
 * Inbox insert: true when the event id is fresh, false on redelivery.
 * Status starts 'pending' so a crash between insert and processing is
 * recoverable by retry.
 */
export async function insertWebhookEvent(
  db: D1Database,
  stripeEventId: string,
  type: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO webhook_events
        (stripe_event_id, type, status, attempts, last_error, created_at, processed_at)
       VALUES (?, ?, 'pending', 0, NULL, ?, NULL)`,
    )
    .bind(stripeEventId, type, now)
    .run();
  return result.meta.changes === 1;
}

export async function getWebhookEvent(
  db: D1Database,
  stripeEventId: string,
): Promise<WebhookEventRow | null> {
  return db
    .prepare('SELECT * FROM webhook_events WHERE stripe_event_id = ?')
    .bind(stripeEventId)
    .first<WebhookEventRow>();
}

export async function markWebhookProcessed(
  db: D1Database,
  stripeEventId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE webhook_events
       SET status = 'processed', attempts = attempts + 1,
           last_error = NULL, processed_at = ?
       WHERE stripe_event_id = ?`,
    )
    .bind(now, stripeEventId)
    .run();
}

/** last_error is a short internal message — never event payloads. */
export async function markWebhookFailed(
  db: D1Database,
  stripeEventId: string,
  error: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE webhook_events
       SET status = 'failed', attempts = attempts + 1, last_error = ?
       WHERE stripe_event_id = ?`,
    )
    .bind(error.slice(0, 500), stripeEventId)
    .run();
}

/** Sanitized transition record; detail must already be free of secrets. */
export async function audit(
  db: D1Database,
  billingAccountId: string,
  kind: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO billing_audit (billing_account_id, kind, detail, created_at) VALUES (?, ?, ?, ?)',
    )
    .bind(
      billingAccountId,
      kind,
      detail === undefined ? null : JSON.stringify(detail),
      Date.now(),
    )
    .run();
}

export async function getBillingMeta(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM billing_meta WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/** Per-account reconcile freshness marker, stored alongside the global key. */
export function reconcileMetaKey(billingAccountId: string): string {
  return `reconcile_at:${billingAccountId}`;
}

export async function setBillingMeta(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO billing_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}

/** The subscription shown on the overview: most recently provider-verified. */
export async function latestSubscriptionForAccount(
  db: D1Database,
  billingAccountId: string,
): Promise<StripeSubscriptionRow | null> {
  return db
    .prepare(
      `SELECT * FROM stripe_subscriptions
       WHERE billing_account_id = ?
       ORDER BY verified_at DESC, updated_at DESC LIMIT 1`,
    )
    .bind(billingAccountId)
    .first<StripeSubscriptionRow>();
}

export async function lastWebhookProcessedAt(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare('SELECT MAX(processed_at) AS processed_at FROM webhook_events')
    .first<{ processed_at: number | null }>();
  return row?.processed_at ?? null;
}

/** Store rows -> policy input. Only the allowlisted plan is modeled. */
export async function loadSubscriptions(
  db: D1Database,
  billingAccountId: string,
): Promise<HostedSubscriptionState[]> {
  const { results } = await db
    .prepare('SELECT * FROM stripe_subscriptions WHERE billing_account_id = ?')
    .bind(billingAccountId)
    .all<StripeSubscriptionRow>();
  return (results ?? [])
    .filter((row) => row.plan_key === 'sync_personal')
    .map((row) => ({
      planKey: 'sync_personal',
      status: row.status as HostedSubscriptionState['status'],
      hasPaidInvoice: row.has_paid_invoice === 1,
      paidThrough: row.current_period_end,
      failedRenewalAt: row.first_failed_renewal_at,
      cancelAtPeriodEnd: row.cancel_at_period_end === 1,
      verifiedAt: row.verified_at,
    }));
}

/**
 * Entitlement evaluation plus the pieces the BILL-03 enforcement cache
 * needs alongside it: `paidThrough` is the max stored subscription period
 * end, which bounds the outage-grace path when billing is unreachable.
 * Never calls Stripe — billingUnavailable is the caller's statement that
 * provider truth cannot currently be refreshed, which unlocks the bounded
 * outage-grace path. `preview_eligible` (migration 0003) is the
 * per-account preview lever, independent of lifecycle.
 */
export async function getEntitlementSnapshot(
  db: D1Database,
  billingAccount: BillingAccountRow,
  now: number,
  limits: HostedLimits,
  billingUnavailable: boolean,
): Promise<{ entitlement: HostedEntitlement; paidThrough: number | null }> {
  const subscriptions = await loadSubscriptions(db, billingAccount.id);
  const entitlement = evaluateHostedEntitlement({
    now,
    lifecycle: billingAccount.lifecycle,
    previewEligible: billingAccount.preview_eligible === 1,
    revision: Math.max(0, ...subscriptions.map((s) => s.verifiedAt)),
    limits,
    subscriptions,
    billingUnavailable,
    renewalGraceDays: RENEWAL_GRACE_DAYS,
    outageGraceHours: OUTAGE_GRACE_HOURS,
  });
  const paidThrough = Math.max(0, ...subscriptions.map((s) => s.paidThrough));
  return { entitlement, paidThrough: paidThrough > 0 ? paidThrough : null };
}

/**
 * Entitlement snapshot over stored provider truth. Never calls Stripe —
 * billingUnavailable is the caller's statement that provider truth cannot
 * currently be refreshed, which unlocks the bounded outage-grace path.
 */
export async function getEntitlement(
  db: D1Database,
  billingAccount: BillingAccountRow,
  now: number,
  limits: HostedLimits,
  billingUnavailable: boolean,
): Promise<HostedEntitlement> {
  return (await getEntitlementSnapshot(db, billingAccount, now, limits, billingUnavailable))
    .entitlement;
}

/** HOSTED_SYNC_LIMITS is a JSON partial override over the defaults. */
export function resolveHostedLimits(env: Env): HostedLimits {
  const fallback = { ...DEFAULT_HOSTED_LIMITS };
  const raw = env.HOSTED_SYNC_LIMITS;
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!isRecord(parsed)) return fallback;
  const merged = { ...fallback };
  for (const key of ['devices', 'artifactBytes', 'historyBytes'] as const) {
    const value = parsed[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || (value as number) <= 0) return fallback;
      merged[key] = value as number;
    }
  }
  return merged;
}
