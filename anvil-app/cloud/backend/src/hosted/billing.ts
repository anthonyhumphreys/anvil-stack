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
  PREVIEW_END_MS,
  type HostedSponsorshipState,
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
  organization_id: string | null;
  stripe_subscription_item_id: string | null;
  stripe_subscription_schedule_id: string | null;
  seat_quantity: number;
  paid_seat_quantity: number;
  status: string;
  plan_key: string;
  interval: string;
  current_period_end: number;
  paid_through: number | null;
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
  organization_id: string | null;
  seat_quantity: number;
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

export interface StripeOrganizationCustomerRow {
  stripe_customer_id: string;
  organization_id: string;
  owner_billing_account_id: string;
  created_at: number;
}

export interface OrganizationBillingSummary {
  source: 'preview' | 'team' | 'none';
  seatCapacity: number;
  planKey: 'sync_team' | null;
  interval: BillingInterval | null;
  status: string | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  scheduledSeatCapacity: number | null;
  scheduledEffectiveAt: number | null;
  checkoutAvailable: boolean;
}

/**
 * Returns the D1 statements which keep the organization's persisted seat
 * capacity in sync with the latest subscription and scheduled reduction.
 * Include these statements in the same D1 batch as a subscription, invoice,
 * or schedule mutation so seat reservation reads one atomic value.
 */
export function organizationCapacityRefreshStatements(
  db: D1Database,
  organizationId: string,
  now: number,
): D1PreparedStatement[] {
  const latestSubscriptionId = `(
    SELECT stripe_subscription_id FROM stripe_subscriptions
    WHERE organization_id = ? AND plan_key = 'sync_team'
    ORDER BY verified_at DESC, updated_at DESC LIMIT 1
  )`;
  const hasCurrentPaidTeamSubscription = `EXISTS (
    SELECT 1 FROM stripe_subscriptions ss
    WHERE ss.stripe_subscription_id = ${latestSubscriptionId}
      AND ss.organization_id = ? AND ss.plan_key = 'sync_team'
      AND ss.has_paid_invoice = 1 AND ss.status = 'active'
      AND ss.paid_through > ? AND ss.paid_seat_quantity BETWEEN 5 AND 50
  )`;
  const latestSeatQuantity = `(
    SELECT paid_seat_quantity FROM stripe_subscriptions
    WHERE organization_id = ? AND plan_key = 'sync_team'
    ORDER BY verified_at DESC, updated_at DESC LIMIT 1
  )`;
  const latestSubscriptionIsTerminal = `EXISTS (
    SELECT 1 FROM stripe_subscriptions ss
    WHERE ss.stripe_subscription_id = ${latestSubscriptionId}
      AND ss.status IN ('canceled', 'incomplete_expired')
  )`;

  const ensureState = db
    .prepare(
      `INSERT OR IGNORE INTO organization_billing_state
         (organization_id, preview_seat_capacity, effective_seat_capacity,
          scheduled_seat_capacity, scheduled_effective_at,
          seat_update_lease_token, seat_update_lease_until, created_at, updated_at)
       VALUES (?, 5, 5, NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .bind(organizationId, now, now);

  const clearAppliedSchedule = db
    .prepare(
      `UPDATE organization_billing_state
       SET scheduled_seat_capacity = CASE
             WHEN ${latestSubscriptionIsTerminal} THEN NULL
             WHEN scheduled_seat_capacity IS NOT NULL
               AND scheduled_effective_at <= ?
               AND scheduled_seat_capacity = ${latestSeatQuantity} THEN NULL
             ELSE scheduled_seat_capacity END,
           scheduled_effective_at = CASE
             WHEN ${latestSubscriptionIsTerminal} THEN NULL
             WHEN scheduled_seat_capacity IS NOT NULL
               AND scheduled_effective_at <= ?
               AND scheduled_seat_capacity = ${latestSeatQuantity} THEN NULL
             ELSE scheduled_effective_at END,
           updated_at = ?
       WHERE organization_id = ?`,
    )
    .bind(
      organizationId,
      now,
      organizationId,
      organizationId,
      now,
      organizationId,
      now,
      organizationId,
    );

  const updateCapacity = db
    .prepare(
      `UPDATE organization_billing_state
       SET effective_seat_capacity = CASE
             WHEN ${hasCurrentPaidTeamSubscription} THEN MIN(
               COALESCE(${latestSeatQuantity}, 0),
               COALESCE(scheduled_seat_capacity, 50)
             )
             WHEN ? < ${PREVIEW_END_MS} THEN preview_seat_capacity
             ELSE 0 END,
           updated_at = ?
       WHERE organization_id = ?`,
    )
    .bind(organizationId, organizationId, now, organizationId, now, now, organizationId);

  return [ensureState, clearAppliedSchedule, updateCapacity];
}

export async function refreshOrganizationTeamCapacity(
  db: D1Database,
  organizationId: string,
  now: number,
): Promise<number> {
  await db.batch(organizationCapacityRefreshStatements(db, organizationId, now));
  const row = await db
    .prepare(
      'SELECT effective_seat_capacity FROM organization_billing_state WHERE organization_id = ?',
    )
    .bind(organizationId)
    .first<{ effective_seat_capacity: number }>();
  return row?.effective_seat_capacity ?? 0;
}

export function hostedCheckoutAvailable(env: Env, now: number): boolean {
  if (env.HOSTED_CHECKOUT_ENABLED !== 'true') return false;
  const stagingEarlyAccess =
    env.HOSTED_BILLING_ENVIRONMENT === 'staging' && env.HOSTED_ALLOW_EARLY_CHECKOUT === 'true';
  if (now < PREVIEW_END_MS && !stagingEarlyAccess) return false;
  return (
    env.HOSTED_BILLING_ENVIRONMENT === 'staging' ||
    (env.HOSTED_BILLING_ENVIRONMENT === 'production' && now >= PREVIEW_END_MS)
  );
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

export async function getStripeCustomerForOrganization(
  db: D1Database,
  organizationId: string,
): Promise<StripeOrganizationCustomerRow | null> {
  return db
    .prepare('SELECT * FROM stripe_organization_customers WHERE organization_id = ?')
    .bind(organizationId)
    .first<StripeOrganizationCustomerRow>();
}

export async function getOrganizationIdByStripeCustomer(
  db: D1Database,
  stripeCustomerId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      'SELECT organization_id FROM stripe_organization_customers WHERE stripe_customer_id = ?',
    )
    .bind(stripeCustomerId)
    .first<{ organization_id: string }>();
  return row?.organization_id ?? null;
}

export async function upsertStripeOrganizationCustomer(
  db: D1Database,
  organizationId: string,
  ownerBillingAccountId: string,
  stripeCustomerId: string,
): Promise<StripeOrganizationCustomerRow> {
  await db
    .prepare(
      `INSERT INTO stripe_organization_customers
        (stripe_customer_id, organization_id, owner_billing_account_id, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(stripe_customer_id) DO NOTHING`,
    )
    .bind(stripeCustomerId, organizationId, ownerBillingAccountId, Date.now())
    .run();
  const row = await db
    .prepare('SELECT * FROM stripe_organization_customers WHERE stripe_customer_id = ?')
    .bind(stripeCustomerId)
    .first<StripeOrganizationCustomerRow>();
  if (row === null || row.organization_id !== organizationId) {
    throw new Error('stripe organization customer upsert failed');
  }
  return row;
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

export type StripeBillingOwner =
  | { billingAccountId: string; organizationId: null }
  | { billingAccountId: string; organizationId: string };

/** Resolve Stripe customer IDs without conflating personal and org billing. */
export async function getBillingOwnerByCustomer(
  db: D1Database,
  stripeCustomerId: string,
): Promise<StripeBillingOwner | null> {
  const organization = await db
    .prepare(
      `SELECT organization_id, owner_billing_account_id AS billing_account_id
       FROM stripe_organization_customers WHERE stripe_customer_id = ?`,
    )
    .bind(stripeCustomerId)
    .first<{ organization_id: string; billing_account_id: string }>();
  if (organization !== null) {
    return {
      billingAccountId: organization.billing_account_id,
      organizationId: organization.organization_id,
    };
  }
  const accountId = await getBillingAccountIdByCustomer(db, stripeCustomerId);
  return accountId === null ? null : { billingAccountId: accountId, organizationId: null };
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
  env: Env,
  organizationId: string | null = null,
): Promise<void> {
  const item = sub.items.data[0];
  const recurringInterval = item?.price.recurring?.interval;
  const interval: BillingInterval = recurringInterval === 'year' ? 'year' : 'month';
  const planKey = hostedPlanForPrice(
    env,
    item?.price.id ?? '',
    recurringInterval,
    item?.quantity ?? null,
  );
  const write = db
    .prepare(
      `INSERT INTO stripe_subscriptions
       (stripe_subscription_id, stripe_customer_id, billing_account_id,
         organization_id, stripe_subscription_item_id, seat_quantity,
         status, plan_key, interval, current_period_end, paid_through, cancel_at_period_end,
         has_paid_invoice, first_failed_renewal_at, verified_at,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, ?, ?, ?)
       ON CONFLICT(stripe_subscription_id) DO UPDATE SET
         stripe_customer_id = excluded.stripe_customer_id,
         billing_account_id = excluded.billing_account_id,
         organization_id = excluded.organization_id,
         stripe_subscription_item_id = excluded.stripe_subscription_item_id,
         seat_quantity = excluded.seat_quantity,
         status = excluded.status,
         plan_key = excluded.plan_key,
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
      organizationId,
      item?.id ?? null,
      item?.quantity ?? 1,
      sub.status,
      planKey,
      interval,
      sub.current_period_end * 1000,
      sub.cancel_at_period_end ? 1 : 0,
      now,
      now,
      now,
    );
  if (organizationId === null) {
    await write.run();
  } else {
    await db.batch([write, ...organizationCapacityRefreshStatements(db, organizationId, now)]);
  }
}

/** Match provider prices only to the deployment's explicit, allowlisted catalog. */
export function hostedPlanForPrice(
  env: Env,
  priceId: string,
  interval: string | null | undefined,
  quantity: number | null,
): 'sync_personal' | 'sync_team' | 'unsupported' {
  if (interval !== 'month' && interval !== 'year') return 'unsupported';
  const personalPrice =
    interval === 'year' ? env.STRIPE_PRICE_SYNC_ANNUAL : env.STRIPE_PRICE_SYNC_MONTHLY;
  const teamPrice =
    interval === 'year' ? env.STRIPE_PRICE_TEAM_ANNUAL : env.STRIPE_PRICE_TEAM_MONTHLY;
  if (priceId === personalPrice && quantity === 1) return 'sync_personal';
  if (
    priceId === teamPrice &&
    quantity !== null &&
    Number.isSafeInteger(quantity) &&
    quantity >= 5 &&
    quantity <= 50
  ) {
    return 'sync_team';
  }
  return 'unsupported';
}

/** Paid invoice observed: grants the paid marker and clears renewal failure. */
export async function recordInvoicePaid(
  db: D1Database,
  stripeSubscriptionId: string,
  now: number,
): Promise<boolean> {
  const subscription = await db
    .prepare('SELECT organization_id FROM stripe_subscriptions WHERE stripe_subscription_id = ?')
    .bind(stripeSubscriptionId)
    .first<{ organization_id: string | null }>();
  const update = db
    .prepare(
      `UPDATE stripe_subscriptions
       SET has_paid_invoice = 1, paid_seat_quantity = seat_quantity,
           paid_through = current_period_end,
           first_failed_renewal_at = NULL, updated_at = ?
       WHERE stripe_subscription_id = ?`,
    )
    .bind(now, stripeSubscriptionId);
  const results =
    subscription?.organization_id === null || subscription === null
      ? [await update.run()]
      : await db.batch([
          update,
          ...organizationCapacityRefreshStatements(db, subscription.organization_id, now),
        ]);
  return results[0]?.meta.changes === 1;
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
  const subscription = await db
    .prepare('SELECT organization_id FROM stripe_subscriptions WHERE stripe_subscription_id = ?')
    .bind(stripeSubscriptionId)
    .first<{ organization_id: string | null }>();
  const update = db
    .prepare(
      `UPDATE stripe_subscriptions
       SET status = 'canceled', verified_at = ?, updated_at = ?
       WHERE stripe_subscription_id = ?`,
    )
    .bind(now, now, stripeSubscriptionId);
  const results =
    subscription?.organization_id === null || subscription === null
      ? [await update.run()]
      : await db.batch([
          update,
          ...organizationCapacityRefreshStatements(db, subscription.organization_id, now),
        ]);
  return results[0]?.meta.changes === 1;
}

export async function recordCheckoutSession(
  db: D1Database,
  stripeSessionId: string,
  billingAccountId: string,
  planKey: string,
  interval: BillingInterval,
  now: number,
  organizationId: string | null = null,
  seatQuantity = 1,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO checkout_sessions
        (stripe_session_id, billing_account_id, organization_id, seat_quantity,
         plan_key, interval,
         status, created_at, completed_at)
       SELECT ?, ?, ?, ?, ?, ?, 'open', ?, NULL
       WHERE ? IS NULL OR EXISTS (
         SELECT 1 FROM hosted_organizations WHERE id = ? AND status = 'active'
       )
       ON CONFLICT(stripe_session_id) DO NOTHING`,
    )
    .bind(
      stripeSessionId,
      billingAccountId,
      organizationId,
      seatQuantity,
      planKey,
      interval,
      now,
      organizationId,
      organizationId,
    )
    .run();
  if (result.meta.changes === 1) return true;
  const existing = await db
    .prepare(
      `SELECT billing_account_id, organization_id, plan_key, interval, seat_quantity
       FROM checkout_sessions WHERE stripe_session_id = ?`,
    )
    .bind(stripeSessionId)
    .first<{
      billing_account_id: string;
      organization_id: string | null;
      plan_key: string;
      interval: string;
      seat_quantity: number;
    }>();
  return (
    existing?.billing_account_id === billingAccountId &&
    existing.organization_id === organizationId &&
    existing.plan_key === planKey &&
    existing.interval === interval &&
    existing.seat_quantity === seatQuantity
  );
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
       WHERE billing_account_id = ? AND organization_id IS NULL AND status = 'open'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(billingAccountId)
    .first<CheckoutSessionRow>();
}

export async function latestOpenOrganizationCheckout(
  db: D1Database,
  organizationId: string,
): Promise<CheckoutSessionRow | null> {
  return db
    .prepare(
      `SELECT * FROM checkout_sessions
       WHERE organization_id = ? AND status = 'open'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(organizationId)
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
    .bind(billingAccountId, kind, detail === undefined ? null : JSON.stringify(detail), Date.now())
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
    .prepare(
      'INSERT INTO billing_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
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
       WHERE billing_account_id = ? AND organization_id IS NULL
       ORDER BY verified_at DESC, updated_at DESC LIMIT 1`,
    )
    .bind(billingAccountId)
    .first<StripeSubscriptionRow>();
}

export async function latestSubscriptionForOrganization(
  db: D1Database,
  organizationId: string,
): Promise<StripeSubscriptionRow | null> {
  return db
    .prepare(
      `SELECT * FROM stripe_subscriptions
       WHERE organization_id = ? AND plan_key = 'sync_team'
       ORDER BY verified_at DESC, updated_at DESC LIMIT 1`,
    )
    .bind(organizationId)
    .first<StripeSubscriptionRow>();
}

export interface ActiveTeamBilling {
  organizationId: string;
  organizationName: string;
  subscriptions: HostedSubscriptionState[];
}

/** The user's current funded seat, if they have one in an active organization. */
export async function findActiveTeamBillingForUser(
  db: D1Database,
  billingAccountId: string,
): Promise<ActiveTeamBilling | null> {
  const assignment = await db
    .prepare(
      `SELECT o.id AS organization_id, o.name AS organization_name,
              s.id AS seat_id, s.created_at AS seat_created_at
       FROM hosted_team_seat_assignments s
       JOIN hosted_organizations o ON o.id = s.organization_id AND o.status = 'active'
       JOIN hosted_organization_memberships m
         ON m.organization_id = s.organization_id
        AND m.billing_account_id = s.billing_account_id
        AND m.status = 'active'
       WHERE s.billing_account_id = ? AND s.state = 'assigned'
       ORDER BY s.updated_at DESC LIMIT 1`,
    )
    .bind(billingAccountId)
    .first<{
      organization_id: string;
      organization_name: string;
      seat_id: string;
      seat_created_at: number;
    }>();
  if (assignment === null) return null;
  const subscription = await latestSubscriptionForOrganization(db, assignment.organization_id);
  if (subscription === null || subscription.has_paid_invoice !== 1) return null;
  const seatRank = await db
    .prepare(
      `SELECT COUNT(*) AS rank FROM hosted_team_seat_assignments
       WHERE organization_id = ? AND state = 'assigned'
         AND (created_at < ? OR (created_at = ? AND id <= ?))`,
    )
    .bind(
      assignment.organization_id,
      assignment.seat_created_at,
      assignment.seat_created_at,
      assignment.seat_id,
    )
    .first<{ rank: number }>();
  if (
    seatRank === null ||
    !Number.isSafeInteger(seatRank.rank) ||
    seatRank.rank > subscription.paid_seat_quantity
  ) {
    return null;
  }
  const subscriptions: HostedSubscriptionState[] = [
    {
      planKey: 'sync_team',
      status: subscription.status as HostedSubscriptionState['status'],
      hasPaidInvoice: true,
      paidThrough: subscription.paid_through ?? 0,
      failedRenewalAt: subscription.first_failed_renewal_at,
      cancelAtPeriodEnd: subscription.cancel_at_period_end === 1,
      verifiedAt: subscription.verified_at,
    },
  ];
  /* Only the latest mirrored team plan determines seat capacity and access. */
  return {
    organizationId: assignment.organization_id,
    organizationName: assignment.organization_name,
    subscriptions,
  };
}

/** Capacity available for new seats. A scheduled reduction constrains new assignments immediately. */
export async function getOrganizationTeamCapacity(
  db: D1Database,
  organizationId: string,
  now: number,
): Promise<number> {
  return refreshOrganizationTeamCapacity(db, organizationId, now);
}

export async function getOrganizationBillingSummary(
  db: D1Database,
  organizationId: string,
  now: number,
  env: Env,
): Promise<OrganizationBillingSummary> {
  const subscription = await latestSubscriptionForOrganization(db, organizationId);
  const { results: stateRows } = await db
    .prepare('SELECT * FROM organization_billing_state WHERE organization_id = ?')
    .bind(organizationId)
    .all<{
      scheduled_seat_capacity: number | null;
      scheduled_effective_at: number | null;
    }>();
  const state = stateRows?.[0];
  const seatCapacity = await getOrganizationTeamCapacity(db, organizationId, now);
  if (
    subscription !== null &&
    subscription.has_paid_invoice === 1 &&
    subscription.current_period_end > now
  ) {
    return {
      source: 'team',
      seatCapacity,
      planKey: 'sync_team',
      interval: subscription.interval as BillingInterval,
      status: subscription.status,
      currentPeriodEnd: subscription.current_period_end,
      cancelAtPeriodEnd: subscription.cancel_at_period_end === 1,
      scheduledSeatCapacity: state?.scheduled_seat_capacity ?? null,
      scheduledEffectiveAt: state?.scheduled_effective_at ?? null,
      checkoutAvailable: hostedCheckoutAvailable(env, now),
    };
  }
  return {
    source: now < PREVIEW_END_MS ? 'preview' : 'none',
    seatCapacity,
    planKey: null,
    interval: null,
    status: subscription?.status ?? null,
    currentPeriodEnd: subscription?.current_period_end ?? null,
    cancelAtPeriodEnd: subscription?.cancel_at_period_end === 1,
    scheduledSeatCapacity: state?.scheduled_seat_capacity ?? null,
    scheduledEffectiveAt: state?.scheduled_effective_at ?? null,
    checkoutAvailable: hostedCheckoutAvailable(env, now),
  };
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
    .prepare(
      'SELECT * FROM stripe_subscriptions WHERE billing_account_id = ? AND organization_id IS NULL',
    )
    .bind(billingAccountId)
    .all<StripeSubscriptionRow>();
  return (results ?? [])
    .filter((row) => row.plan_key === 'sync_personal')
    .map((row) => ({
      planKey: 'sync_personal',
      status: row.status as HostedSubscriptionState['status'],
      hasPaidInvoice: row.has_paid_invoice === 1,
      paidThrough: row.paid_through ?? 0,
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
  const sponsorship = await findActiveTeamBillingForUser(db, billingAccount.id);
  const teamSponsorship: HostedSponsorshipState | null =
    sponsorship === null
      ? null
      : { organizationId: sponsorship.organizationId, subscriptions: sponsorship.subscriptions };
  const entitlement = evaluateHostedEntitlement({
    now,
    lifecycle: billingAccount.lifecycle,
    previewEligible: billingAccount.preview_eligible === 1,
    revision: Math.max(0, ...subscriptions.map((s) => s.verifiedAt)),
    limits,
    subscriptions,
    sponsorship: teamSponsorship,
    billingUnavailable,
    renewalGraceDays: RENEWAL_GRACE_DAYS,
    outageGraceHours: OUTAGE_GRACE_HOURS,
  });
  const paidThrough =
    entitlement.fundedBy === 'personal'
      ? Math.max(0, ...subscriptions.map((s) => s.paidThrough))
      : 0;
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
      if (key !== 'devices' && value === null) {
        merged[key] = null;
        continue;
      }
      if (!Number.isSafeInteger(value) || (value as number) <= 0) return fallback;
      merged[key] = value as number;
    }
  }
  return merged;
}
