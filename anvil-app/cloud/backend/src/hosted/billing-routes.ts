// BILL-02 billing routes — the public Stripe webhook inbox plus the
// signed internal billing surface (/internal/hosted/{checkout,portal,
// billing,entitlement,reconcile}) dispatched from routes.ts.
//
// Webhook policy: the raw body is signature-verified before anything is
// persisted, then the event id is deduped through the webhook_events
// inbox. Deterministic rejects — malformed objects, unknown accounts,
// unmapped customers — are marked failed or processed-ignored and still
// answer 200, because Stripe retries can never repair them. Thrown
// errors (D1, unexpected shapes) mark the event failed and answer 500 so
// Stripe redelivers; every side-effecting step is an upsert or guarded
// write, so redelivery stays idempotent.

import { isRecord, rpcErrorResponse } from '../rpc';
import { getOrCreateAdmittedBillingAccount } from './admission';
import {
  audit,
  findActiveTeamBillingForUser,
  getBillingAccountIdByCustomer,
  getBillingOwnerByCustomer,
  getBillingMeta,
  getEntitlement,
  getOrganizationIdByStripeCustomer,
  getStripeCustomerForOrganization,
  getStripeCustomerForAccount,
  getOrganizationTeamCapacity,
  getWebhookEvent,
  hostedCheckoutAvailable,
  hostedPlanForPrice,
  insertWebhookEvent,
  latestOpenCheckout,
  latestOpenOrganizationCheckout,
  latestSubscriptionForOrganization,
  latestSubscriptionForAccount,
  lastWebhookProcessedAt,
  organizationCapacityRefreshStatements,
  reconcileMetaKey,
  markCheckoutComplete,
  markCheckoutExpired,
  markSubscriptionDeleted,
  markWebhookFailed,
  markWebhookProcessed,
  recordInvoicePaid,
  recordCheckoutSession,
  recordInvoiceFailed,
  resolveHostedLimits,
  setBillingMeta,
  upsertStripeOrganizationCustomer,
  upsertStripeCustomer,
  upsertSubscriptionFromStripe,
  type StripeSubscriptionRow,
} from './billing';
import { validateHostedIdentity, type HostedIdentity } from './identity';
import { ensureOwnerSeatForPaidOrganization } from './organizations';
import { reconcileStripeBillingOwner } from './subscription-reconcile';
import { emitMetric } from './metrics';
import {
  parseStripeCheckoutSession,
  parseStripeInvoice,
  parseStripePrice,
  parseStripeSubscription,
  StripeApiError,
  stripeRequest,
  verifyStripeWebhookSignature,
  type StripeCheckoutSession,
  type StripePortalSession,
  type StripeSubscription,
} from './stripe';
import {
  getBillingAccountById,
  getBillingAccountByIdentity,
  type BillingAccountRow,
} from './store';

const WEBHOOK_BODY_MAX_BYTES = 64 * 1024;
const LAST_RECONCILE_KEY = 'last_reconcile_at';
const SEAT_UPDATE_LEASE_MS = 30_000;

function syncCheckoutDisabled(): Response {
  return rpcErrorResponse(undefined, 'forbidden', { reason: 'sync-checkout-disabled' });
}

async function readWebhookBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > WEBHOOK_BODY_MAX_BYTES) {
    return null;
  }
  let buffer: ArrayBuffer;
  try {
    buffer = await request.arrayBuffer();
  } catch {
    return null;
  }
  if (buffer.byteLength > WEBHOOK_BODY_MAX_BYTES) return null;
  return new TextDecoder().decode(buffer);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

interface StripeEvent {
  id: string;
  type: string;
  livemode: boolean;
  object: unknown;
}

function parseStripeEvent(value: unknown): StripeEvent | null {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    typeof value['type'] !== 'string' ||
    typeof value['livemode'] !== 'boolean'
  ) {
    return null;
  }
  const data = isRecord(value['data']) ? value['data'] : null;
  return {
    id: value['id'],
    type: value['type'],
    livemode: value['livemode'],
    object: data?.['object'],
  };
}

/** Audit tag for events that cannot be attributed to a billing account. */
const UNMAPPED = 'unmapped';

/**
 * Applies one verified, deduped event. Returns false when the event is a
 * deterministic reject — the caller records it as failed and still
 * acknowledges delivery. Throws only for retryable infrastructure faults.
 */
async function processStripeEvent(db: D1Database, env: Env, event: StripeEvent): Promise<boolean> {
  const now = Date.now();
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = parseStripeCheckoutSession(event.object);
      if (session === null) return false;
      const checkoutRow = await db
        .prepare(
          `SELECT billing_account_id, organization_id, plan_key
           FROM checkout_sessions WHERE stripe_session_id = ?`,
        )
        .bind(session.id)
        .first<{ billing_account_id: string; organization_id: string | null; plan_key: string }>();
      const accountId = checkoutRow?.billing_account_id ?? session.client_reference_id;
      const account = accountId === null ? null : await getBillingAccountById(db, accountId);
      if (account === null || checkoutRow === null || account.id !== accountId) {
        await audit(db, accountId ?? UNMAPPED, 'checkout.rejected', {
          eventId: event.id,
          sessionId: session.id,
        });
        return false;
      }
      if (session.customer !== null && checkoutRow.organization_id === null) {
        await upsertStripeCustomer(db, account.id, session.customer);
      } else if (session.customer !== null && checkoutRow.organization_id !== null) {
        await upsertStripeOrganizationCustomer(
          db,
          checkoutRow.organization_id,
          account.id,
          session.customer,
        );
      }
      await markCheckoutComplete(db, session.id, now);
      await audit(db, account.id, 'checkout.completed', {
        eventId: event.id,
        sessionId: session.id,
      });
      return true;
    }
    case 'checkout.session.expired': {
      const session = parseStripeCheckoutSession(event.object);
      if (session === null) return false;
      const accountId = (await accountIdForSession(db, session.id)) ?? session.client_reference_id;
      if (accountId === null) {
        await audit(db, UNMAPPED, 'checkout.expired', { eventId: event.id, sessionId: session.id });
        return true;
      }
      await markCheckoutExpired(db, session.id);
      await audit(db, accountId, 'checkout.expired', { eventId: event.id, sessionId: session.id });
      return true;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = parseStripeSubscription(event.object);
      if (sub === null) return false;
      const owner = await getBillingOwnerByCustomer(db, sub.customer);
      if (owner === null) {
        // Stripe also delivers events for unrelated/test objects on the
        // same endpoint — those are noise, processed without side-effects.
        await audit(db, UNMAPPED, 'subscription.ignored-unknown-customer', {
          eventId: event.id,
          customer: sub.customer,
          subscription: sub.id,
          type: event.type,
        });
        return true;
      }
      await upsertSubscriptionFromStripe(
        db,
        owner.billingAccountId,
        sub,
        now,
        env,
        owner.organizationId,
      );
      await audit(db, owner.billingAccountId, 'subscription.upserted', {
        eventId: event.id,
        subscription: sub.id,
        status: sub.status,
        type: event.type,
      });
      return true;
    }
    case 'customer.subscription.deleted': {
      const sub = parseStripeSubscription(event.object);
      if (sub === null) return false;
      const owner = await getBillingOwnerByCustomer(db, sub.customer);
      if (owner === null) {
        await audit(db, UNMAPPED, 'subscription.ignored-unknown-customer', {
          eventId: event.id,
          customer: sub.customer,
          subscription: sub.id,
          type: event.type,
        });
        return true;
      }
      await markSubscriptionDeleted(db, sub.id, now);
      await audit(db, owner.billingAccountId, 'subscription.deleted', {
        eventId: event.id,
        subscription: sub.id,
      });
      return true;
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const invoice = parseStripeInvoice(event.object);
      if (invoice === null) return false;
      const subscription =
        invoice.subscription === null
          ? null
          : await findSubscriptionOrFetch(db, env, invoice.subscription, now);
      if (invoice.subscription === null || subscription === null) {
        await audit(db, UNMAPPED, 'invoice.ignored', {
          eventId: event.id,
          invoice: invoice.id,
          subscription: invoice.subscription,
        });
        return true;
      }
      if (invoice.status !== 'paid') {
        await audit(db, subscription.billing_account_id, 'invoice.ignored-not-paid', {
          eventId: event.id,
          invoice: invoice.id,
          subscription: invoice.subscription,
        });
        return true;
      }
      const rawCurrent = await stripeRequest<unknown>(
        env,
        `/v1/subscriptions/${encodeURIComponent(invoice.subscription)}`,
        { params: { 'expand[0]': 'latest_invoice' } },
      );
      const current = parseStripeSubscription(rawCurrent);
      const latestInvoiceId = stripeLatestInvoiceId(rawCurrent);
      const latestInvoice = isRecord(rawCurrent) ? rawCurrent['latest_invoice'] : null;
      if (
        current === null ||
        (invoice.customer !== null && current.customer !== invoice.customer) ||
        latestInvoiceId !== invoice.id ||
        (isRecord(latestInvoice) &&
          latestInvoice['status'] !== undefined &&
          latestInvoice['status'] !== 'paid')
      ) {
        await audit(db, subscription.billing_account_id, 'invoice.ignored-stale', {
          eventId: event.id,
          invoice: invoice.id,
          subscription: invoice.subscription,
          latestInvoice: latestInvoiceId,
        });
        return true;
      }
      const owner = await getBillingOwnerByCustomer(db, current.customer);
      if (owner === null) {
        await audit(db, UNMAPPED, 'invoice.ignored-unknown-customer', {
          eventId: event.id,
          invoice: invoice.id,
          customer: current.customer,
        });
        return true;
      }
      await upsertSubscriptionFromStripe(
        db,
        owner.billingAccountId,
        current,
        now,
        env,
        owner.organizationId,
      );
      await recordInvoicePaid(db, invoice.subscription, now);
      if (owner.organizationId !== null) {
        await ensureOwnerSeatForPaidOrganization(db, owner.organizationId, now);
      }
      await audit(db, owner.billingAccountId, 'invoice.paid', {
        eventId: event.id,
        invoice: invoice.id,
        subscription: invoice.subscription,
      });
      return true;
    }
    case 'invoice.payment_failed': {
      const invoice = parseStripeInvoice(event.object);
      if (invoice === null) return false;
      if (invoice.billing_reason !== 'subscription_cycle' || invoice.subscription === null) {
        await audit(db, UNMAPPED, 'webhook.ignored', { eventId: event.id, type: event.type });
        return true;
      }
      const subscription = await findSubscriptionOrFetch(db, env, invoice.subscription, now);
      if (subscription === null) {
        await audit(db, UNMAPPED, 'invoice.ignored', {
          eventId: event.id,
          invoice: invoice.id,
          subscription: invoice.subscription,
        });
        return true;
      }
      const rawCurrent = await stripeRequest<unknown>(
        env,
        `/v1/subscriptions/${encodeURIComponent(invoice.subscription)}`,
        { params: { 'expand[0]': 'latest_invoice' } },
      );
      const current = parseStripeSubscription(rawCurrent);
      const latestInvoiceId = stripeLatestInvoiceId(rawCurrent);
      const latestInvoice = isRecord(rawCurrent) ? rawCurrent['latest_invoice'] : null;
      if (
        current === null ||
        (invoice.customer !== null && current.customer !== invoice.customer) ||
        latestInvoiceId !== invoice.id ||
        (isRecord(latestInvoice) && latestInvoice['status'] === 'paid')
      ) {
        await audit(db, subscription.billing_account_id, 'invoice.failure-ignored-stale', {
          eventId: event.id,
          invoice: invoice.id,
          subscription: invoice.subscription,
          latestInvoice: latestInvoiceId,
        });
        return true;
      }
      const owner = await getBillingOwnerByCustomer(db, current.customer);
      if (owner === null) {
        await audit(db, UNMAPPED, 'invoice.ignored-unknown-customer', {
          eventId: event.id,
          invoice: invoice.id,
          customer: current.customer,
        });
        return true;
      }
      await upsertSubscriptionFromStripe(
        db,
        owner.billingAccountId,
        current,
        now,
        env,
        owner.organizationId,
      );
      await recordInvoiceFailed(db, invoice.subscription, now);
      await audit(db, owner.billingAccountId, 'invoice.payment_failed', {
        eventId: event.id,
        invoice: invoice.id,
        subscription: invoice.subscription,
      });
      return true;
    }
    default: {
      await audit(db, UNMAPPED, 'webhook.ignored', { eventId: event.id, type: event.type });
      return true;
    }
  }
}

async function accountIdForSession(db: D1Database, sessionId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT billing_account_id FROM checkout_sessions WHERE stripe_session_id = ?')
    .bind(sessionId)
    .first<{ billing_account_id: string }>();
  return row?.billing_account_id ?? null;
}

async function findSubscriptionOrFetch(
  db: D1Database,
  env: Env,
  stripeSubscriptionId: string,
  now: number,
): Promise<{ billing_account_id: string; organization_id: string | null } | null> {
  const existing = await findSubscription(db, stripeSubscriptionId);
  if (existing !== null) return existing;
  const raw = await stripeRequest<unknown>(
    env,
    `/v1/subscriptions/${encodeURIComponent(stripeSubscriptionId)}`,
  );
  const subscription = parseStripeSubscription(raw);
  if (subscription === null) return null;
  const owner = await getBillingOwnerByCustomer(db, subscription.customer);
  if (owner === null) return null;
  await upsertSubscriptionFromStripe(
    db,
    owner.billingAccountId,
    subscription,
    now,
    env,
    owner.organizationId,
  );
  return findSubscription(db, stripeSubscriptionId);
}

async function findSubscription(
  db: D1Database,
  stripeSubscriptionId: string,
): Promise<{ billing_account_id: string; organization_id: string | null } | null> {
  return db
    .prepare(
      'SELECT billing_account_id, organization_id FROM stripe_subscriptions WHERE stripe_subscription_id = ?',
    )
    .bind(stripeSubscriptionId)
    .first<{ billing_account_id: string; organization_id: string | null }>();
}

/**
 * `POST /v1/hosted/stripe-webhook` — public Stripe inbox. Present only
 * when STRIPE_WEBHOOK_SECRET is configured; unsigned/oversized/invalid
 * bodies reject before anything is persisted.
 */
export async function handleStripeWebhook(
  request: Request,
  env: Env,
  db: D1Database,
): Promise<Response> {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (typeof secret !== 'string' || secret.length === 0) {
    return rpcErrorResponse(undefined, 'not-found');
  }
  const rawBody = await readWebhookBody(request);
  if (rawBody === null) {
    return rpcErrorResponse(undefined, 'payload-too-large');
  }
  const verified = await verifyStripeWebhookSignature(
    rawBody,
    request.headers.get('stripe-signature') ?? '',
    secret,
    Date.now(),
  );
  if (!verified) {
    emitMetric('webhook.rejected', { reason: 'signature' });
    return rpcErrorResponse(undefined, 'unauthenticated');
  }
  const event = parseStripeEvent(parseJson(rawBody));
  if (event === null) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const expectedLiveMode = env.HOSTED_BILLING_ENVIRONMENT === 'production';
  if (
    (env.HOSTED_BILLING_ENVIRONMENT !== 'staging' &&
      env.HOSTED_BILLING_ENVIRONMENT !== 'production') ||
    event.livemode !== expectedLiveMode
  ) {
    emitMetric('webhook.rejected', { reason: 'environment-mode' });
    return rpcErrorResponse(undefined, 'unauthenticated');
  }
  const now = Date.now();
  const fresh = await insertWebhookEvent(db, event.id, event.type, now);
  if (!fresh) {
    const existing = await getWebhookEvent(db, event.id);
    if (existing !== null && existing.status === 'processed') {
      emitMetric('webhook.event', { type: event.type, outcome: 'duplicate' });
      return Response.json({ received: true, duplicate: true });
    }
  }
  try {
    if (!(await processStripeEvent(db, env, event))) {
      await markWebhookFailed(db, event.id, 'event could not be applied', now);
      emitMetric('webhook.event', { type: event.type, outcome: 'failed-deterministic' });
      return Response.json({ received: true });
    }
    await markWebhookProcessed(db, event.id, now);
    emitMetric('webhook.event', { type: event.type, outcome: 'processed' });
    return Response.json({ received: true });
  } catch (error) {
    await markWebhookFailed(db, event.id, errorMessage(error), now);
    emitMetric('webhook.event', { type: event.type, outcome: 'failed-fault' });
    return rpcErrorResponse(undefined, 'unavailable');
  }
}

export function stripeConfigured(env: Env): boolean {
  if (typeof env.STRIPE_SECRET_KEY !== 'string' || env.STRIPE_SECRET_KEY.length === 0) {
    return false;
  }
  if (
    env.HOSTED_BILLING_ENVIRONMENT === 'staging' &&
    env.STRIPE_SECRET_KEY.startsWith('sk_test_')
  ) {
    return true;
  }
  return (
    env.HOSTED_BILLING_ENVIRONMENT === 'production' &&
    env.STRIPE_SECRET_KEY.startsWith('sk_live_') &&
    (env.STRIPE_API_BASE === undefined || env.STRIPE_API_BASE.length === 0)
  );
}

function identityFrom(body: HostedIdentity): HostedIdentity {
  return { workosClientId: body.workosClientId, workosUserId: body.workosUserId };
}

async function activeOrganizationOwner(
  db: D1Database,
  organizationId: string,
  identity: HostedIdentity,
  allowClosed = false,
): Promise<{ billing_account_id: string } | null> {
  return db
    .prepare(
      `SELECT m.billing_account_id
       FROM hosted_organization_memberships m
       JOIN hosted_organizations o ON o.id = m.organization_id
         AND (o.status = 'active' OR (? = 1 AND o.status = 'closed'))
       WHERE m.organization_id = ? AND m.workos_client_id = ? AND m.workos_user_id = ?
         AND m.role = 'owner' AND m.status = 'active'`,
    )
    .bind(allowClosed ? 1 : 0, organizationId, identity.workosClientId, identity.workosUserId)
    .first<{ billing_account_id: string }>();
}

function stripeScheduleId(subscriptionValue: unknown): string | null {
  if (!isRecord(subscriptionValue)) return null;
  const schedule = subscriptionValue['schedule'];
  if (typeof schedule === 'string') return schedule;
  return isRecord(schedule) && typeof schedule['id'] === 'string' ? schedule['id'] : null;
}

function activeScheduleStart(scheduleValue: unknown, nowSeconds: number): number | null {
  if (!isRecord(scheduleValue)) return null;
  const currentPhase = isRecord(scheduleValue['current_phase'])
    ? scheduleValue['current_phase']
    : null;
  const phases = Array.isArray(scheduleValue['phases']) ? scheduleValue['phases'] : [];
  const active = phases.find((phase) => {
    if (!isRecord(phase)) return false;
    return (
      Number.isSafeInteger(phase['start_date']) &&
      Number.isSafeInteger(phase['end_date']) &&
      (phase['start_date'] as number) <= nowSeconds &&
      (phase['end_date'] as number) > nowSeconds
    );
  });
  const phase = isRecord(active) ? active : currentPhase;
  return phase !== null && Number.isSafeInteger(phase['start_date'])
    ? (phase['start_date'] as number)
    : null;
}

interface TeamSeatContext {
  account: BillingAccountRow;
  current: StripeSubscriptionRow;
  customerId: string;
  provider: StripeSubscription;
  rawProvider: unknown;
  item: StripeSubscription['items']['data'][number];
  currentSeats: number;
  interval: 'month' | 'year';
  providerScheduleId: string | null;
}

interface SeatQuoteAmounts {
  amountDue: number;
  currency: 'gbp';
  taxAmount: number;
}

interface SeatQuoteResponse extends SeatQuoteAmounts {
  quoteId: string;
  seatCapacity: number;
  requestedSeats: number;
  prorationDate: number;
  expiresAt: number;
}

interface SeatQuoteRow {
  id: string;
  organization_id: string;
  created_by_billing_account_id: string;
  stripe_subscription_id: string;
  stripe_subscription_item_id: string;
  stripe_customer_id: string;
  current_seat_quantity: number;
  requested_seat_quantity: number;
  current_period_end: number;
  amount_due: number;
  currency: string;
  tax_amount: number;
  proration_date: number;
  expires_at: number;
  status: 'pending' | 'confirmed' | 'superseded' | 'expired';
}

async function loadTeamSeatContext(
  db: D1Database,
  env: Env,
  organizationId: string,
  identity: HostedIdentity,
  now: number,
): Promise<{ context: TeamSeatContext } | { response: Response }> {
  const account = await getBillingAccountByIdentity(db, identity);
  if (account === null) return { response: rpcErrorResponse(undefined, 'not-found') };
  if (account.lifecycle !== 'active') {
    return { response: rpcErrorResponse(undefined, 'forbidden', { reason: 'account-deleted' }) };
  }
  const owner = await activeOrganizationOwner(db, organizationId, identity);
  if (owner === null || owner.billing_account_id !== account.id) {
    return {
      response: rpcErrorResponse(undefined, 'forbidden', { reason: 'organization-owner-required' }),
    };
  }
  const customer = await getStripeCustomerForOrganization(db, organizationId);
  if (customer === null) return { response: rpcErrorResponse(undefined, 'not-found') };

  const initial = await latestSubscriptionForOrganization(db, organizationId);
  if (
    initial === null ||
    initial.plan_key !== 'sync_team' ||
    initial.status !== 'active' ||
    initial.has_paid_invoice !== 1 ||
    initial.paid_through === null ||
    initial.paid_through <= now ||
    initial.stripe_subscription_item_id === null
  ) {
    return {
      response: rpcErrorResponse(undefined, 'conflict', {
        reason: 'active-team-subscription-required',
      }),
    };
  }
  if (initial.cancel_at_period_end === 1) {
    return {
      response: rpcErrorResponse(undefined, 'conflict', { reason: 'cancellation-scheduled' }),
    };
  }

  const rawProvider = await stripeRequest<unknown>(
    env,
    `/v1/subscriptions/${encodeURIComponent(initial.stripe_subscription_id)}`,
  );
  const provider = parseStripeSubscription(rawProvider);
  if (
    provider === null ||
    provider.id !== initial.stripe_subscription_id ||
    provider.customer !== customer.stripe_customer_id ||
    provider.status !== 'active' ||
    provider.current_period_end * 1000 <= now
  ) {
    return {
      response: rpcErrorResponse(undefined, 'conflict', { reason: 'subscription-changed' }),
    };
  }
  const item = provider.items.data[0];
  const currentSeats = item.quantity;
  const interval = item.price.recurring?.interval;
  if (
    currentSeats === null ||
    item.id === null ||
    (interval !== 'month' && interval !== 'year') ||
    hostedPlanForPrice(env, item.price.id, interval, currentSeats) !== 'sync_team'
  ) {
    return {
      response: rpcErrorResponse(undefined, 'conflict', {
        reason: 'unsupported-team-subscription',
      }),
    };
  }

  await upsertSubscriptionFromStripe(db, account.id, provider, now, env, organizationId);
  const current = await latestSubscriptionForOrganization(db, organizationId);
  if (
    current === null ||
    current.has_paid_invoice !== 1 ||
    current.paid_seat_quantity !== currentSeats ||
    current.paid_through === null ||
    current.paid_through <= now
  ) {
    return {
      response: rpcErrorResponse(undefined, 'conflict', { reason: 'payment-not-confirmed' }),
    };
  }
  const providerScheduleId = stripeScheduleId(rawProvider);
  if (
    providerScheduleId !== null &&
    current.stripe_subscription_schedule_id !== providerScheduleId
  ) {
    return {
      response: rpcErrorResponse(undefined, 'conflict', { reason: 'schedule-managed-externally' }),
    };
  }
  return {
    context: {
      account,
      current,
      customerId: customer.stripe_customer_id,
      provider,
      rawProvider,
      item,
      currentSeats,
      interval,
      providerScheduleId,
    },
  };
}

async function claimSeatUpdateLease(
  db: D1Database,
  organizationId: string,
  now: number,
): Promise<string | null> {
  const token = crypto.randomUUID();
  const result = await db
    .prepare(
      `UPDATE organization_billing_state
       SET seat_update_lease_token = ?, seat_update_lease_until = ?, updated_at = ?
       WHERE organization_id = ?
         AND (seat_update_lease_token IS NULL OR seat_update_lease_until <= ?)`,
    )
    .bind(token, now + SEAT_UPDATE_LEASE_MS, now, organizationId, now)
    .run();
  return result.meta.changes === 1 ? token : null;
}

async function renewSeatUpdateLease(
  db: D1Database,
  organizationId: string,
  token: string,
  now: number = Date.now(),
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE organization_billing_state
       SET seat_update_lease_until = ?, updated_at = ?
       WHERE organization_id = ? AND seat_update_lease_token = ?
         AND seat_update_lease_until > ?`,
    )
    .bind(now + SEAT_UPDATE_LEASE_MS, now, organizationId, token, now)
    .run();
  return result.meta.changes === 1;
}

async function releaseSeatUpdateLease(
  db: D1Database,
  organizationId: string,
  token: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE organization_billing_state
       SET seat_update_lease_token = NULL, seat_update_lease_until = NULL, updated_at = ?
       WHERE organization_id = ? AND seat_update_lease_token = ?`,
    )
    .bind(Date.now(), organizationId, token)
    .run();
}

function parseSeatQuoteAmounts(value: unknown): SeatQuoteAmounts | null {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value['amount_due']) ||
    (value['amount_due'] as number) < 0 ||
    value['currency'] !== 'gbp'
  ) {
    return null;
  }
  const taxRows = value['total_taxes'] ?? value['total_tax_amounts'] ?? [];
  if (!Array.isArray(taxRows)) return null;
  let taxAmount = 0;
  for (const row of taxRows) {
    if (!isRecord(row) || !Number.isSafeInteger(row['amount']) || (row['amount'] as number) < 0) {
      return null;
    }
    taxAmount += row['amount'] as number;
    if (!Number.isSafeInteger(taxAmount)) return null;
  }
  return { amountDue: value['amount_due'] as number, currency: 'gbp', taxAmount };
}

async function previewTeamSeatChange(
  env: Env,
  context: TeamSeatContext,
  requestedSeats: number,
  prorationDate: number,
): Promise<SeatQuoteAmounts> {
  const preview = await stripeRequest<unknown>(env, '/v1/invoices/create_preview', {
    method: 'POST',
    params: {
      customer: context.customerId,
      subscription: context.current.stripe_subscription_id,
      'subscription_details[items][0][id]': context.item.id as string,
      'subscription_details[items][0][quantity]': requestedSeats,
      'subscription_details[proration_behavior]': 'always_invoice',
      'subscription_details[proration_date]': prorationDate,
    },
  });
  const amounts = parseSeatQuoteAmounts(preview);
  if (amounts === null) throw new StripeApiError(0, 'seat invoice preview failed validation');
  return amounts;
}

async function persistSeatQuote(
  db: D1Database,
  organizationId: string,
  context: TeamSeatContext,
  requestedSeats: number,
  prorationDate: number,
  now: number,
  amounts: SeatQuoteAmounts,
): Promise<SeatQuoteResponse> {
  const quoteId = crypto.randomUUID();
  const expiresAt = now + 5 * 60_000;
  await db.batch([
    db
      .prepare(
        `UPDATE team_seat_change_quotes SET status = 'superseded'
         WHERE organization_id = ? AND status = 'pending'`,
      )
      .bind(organizationId),
    db
      .prepare(
        `INSERT INTO team_seat_change_quotes
          (id, organization_id, created_by_billing_account_id,
           stripe_subscription_id, stripe_subscription_item_id, stripe_customer_id,
           current_seat_quantity, requested_seat_quantity, current_period_end,
           amount_due, currency, tax_amount, proration_date, expires_at, status,
           created_at, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
      )
      .bind(
        quoteId,
        organizationId,
        context.account.id,
        context.current.stripe_subscription_id,
        context.item.id,
        context.customerId,
        context.currentSeats,
        requestedSeats,
        context.provider.current_period_end * 1000,
        amounts.amountDue,
        amounts.currency,
        amounts.taxAmount,
        prorationDate,
        expiresAt,
        now,
      ),
  ]);
  return {
    quoteId,
    seatCapacity: context.currentSeats,
    requestedSeats,
    amountDue: amounts.amountDue,
    currency: amounts.currency,
    taxAmount: amounts.taxAmount,
    prorationDate,
    expiresAt,
  };
}

function quoteResponse(row: SeatQuoteRow): SeatQuoteResponse {
  return {
    quoteId: row.id,
    seatCapacity: row.current_seat_quantity,
    requestedSeats: row.requested_seat_quantity,
    amountDue: row.amount_due,
    currency: 'gbp',
    taxAmount: row.tax_amount,
    prorationDate: row.proration_date,
    expiresAt: row.expires_at,
  };
}

function stripeLatestInvoiceId(rawSubscription: unknown): string | null {
  if (!isRecord(rawSubscription)) return null;
  const latest = rawSubscription['latest_invoice'];
  if (typeof latest === 'string') return latest;
  return isRecord(latest) && typeof latest['id'] === 'string' ? latest['id'] : null;
}

async function latestInvoicePaid(env: Env, rawSubscription: unknown): Promise<boolean> {
  if (!isRecord(rawSubscription)) return false;
  const latest = rawSubscription['latest_invoice'];
  let invoice: unknown = latest;
  if (typeof latest === 'string') {
    invoice = await stripeRequest<unknown>(env, `/v1/invoices/${encodeURIComponent(latest)}`);
  }
  return isRecord(invoice) && invoice['status'] === 'paid';
}

/**
 * `POST /internal/hosted/checkout` — retired Sync subscription checkout.
 * Return before any provider or billing-account lookup so stale clients cannot
 * create a new Stripe customer, session, or subscription.
 */
export async function handleCheckout(body: unknown, _env: Env, _db: D1Database): Promise<Response> {
  if (
    !isRecord(body) ||
    !validateHostedIdentity(body) ||
    (body['interval'] !== 'month' && body['interval'] !== 'year') ||
    (body['planKey'] !== undefined &&
      body['planKey'] !== 'sync_personal' &&
      body['planKey'] !== 'sync_team')
  ) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  return syncCheckoutDisabled();
}

/** `POST /internal/hosted/portal` — Stripe Customer Portal session. */
export async function handlePortal(body: unknown, env: Env, db: D1Database): Promise<Response> {
  if (
    !isRecord(body) ||
    !validateHostedIdentity(body) ||
    (body['organizationId'] !== undefined &&
      (typeof body['organizationId'] !== 'string' || body['organizationId'].length === 0))
  ) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  if (!stripeConfigured(env)) {
    return rpcErrorResponse(undefined, 'unavailable');
  }
  const returnUrl = env.HOSTED_PORTAL_RETURN_URL;
  if (typeof returnUrl !== 'string' || returnUrl.length === 0) {
    return rpcErrorResponse(undefined, 'unavailable');
  }
  const organizationId = body['organizationId'];
  let billingAccountId: string;
  let customerId: string | null;
  if (typeof organizationId === 'string') {
    const owner = await activeOrganizationOwner(db, organizationId, identityFrom(body), true);
    if (owner === null) {
      return rpcErrorResponse(undefined, 'forbidden', { reason: 'organization-owner-required' });
    }
    billingAccountId = owner.billing_account_id;
    const customer = await getStripeCustomerForOrganization(db, organizationId);
    customerId = customer?.stripe_customer_id ?? null;
  } else {
    const account = await getBillingAccountByIdentity(db, identityFrom(body));
    if (account === null) {
      return rpcErrorResponse(undefined, 'not-found');
    }
    if (account.lifecycle !== 'active') {
      return rpcErrorResponse(undefined, 'forbidden', { reason: 'account-deleted' });
    }
    billingAccountId = account.id;
    const customer = await getStripeCustomerForAccount(db, account.id);
    customerId = customer?.stripe_customer_id ?? null;
  }
  if (customerId === null) {
    return rpcErrorResponse(undefined, 'not-found');
  }
  const session = await stripeRequest<StripePortalSession>(env, '/v1/billing_portal/sessions', {
    method: 'POST',
    params: { customer: customerId, return_url: returnUrl },
    idempotencyKey: `portal:${typeof organizationId === 'string' ? `organization:${organizationId}` : billingAccountId}:${Math.floor(Date.now() / 3_600_000)}`,
  });
  if (typeof session.url !== 'string' || session.url.length === 0) {
    throw new StripeApiError(0, 'portal session missing url');
  }
  await audit(db, billingAccountId, 'portal.created', {
    sessionId: session.id,
    organizationId: typeof organizationId === 'string' ? organizationId : null,
  });
  return Response.json({ portalUrl: session.url });
}

async function authorizeActiveSeatOwner(
  db: D1Database,
  organizationId: string,
  identity: HostedIdentity,
): Promise<{ account: BillingAccountRow } | { response: Response }> {
  const account = await getBillingAccountByIdentity(db, identity);
  if (account === null) return { response: rpcErrorResponse(undefined, 'not-found') };
  if (account.lifecycle !== 'active') {
    return { response: rpcErrorResponse(undefined, 'forbidden', { reason: 'account-deleted' }) };
  }
  const owner = await activeOrganizationOwner(db, organizationId, identity);
  if (owner === null || owner.billing_account_id !== account.id) {
    return {
      response: rpcErrorResponse(undefined, 'forbidden', { reason: 'organization-owner-required' }),
    };
  }
  return { account };
}

/** `POST /internal/hosted/seats/quote` — previews and persists an upgrade quote. */
export async function handleOrganizationSeatQuote(
  body: unknown,
  env: Env,
  db: D1Database,
): Promise<Response> {
  if (
    !isRecord(body) ||
    !validateHostedIdentity(body) ||
    typeof body['organizationId'] !== 'string' ||
    body['organizationId'].length === 0 ||
    !Number.isSafeInteger(body['seats']) ||
    (body['seats'] as number) < 5 ||
    (body['seats'] as number) > 50
  ) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const organizationId = body['organizationId'];
  const requestedSeats = body['seats'] as number;
  const now = Date.now();
  if (!hostedCheckoutAvailable(env, now)) {
    return syncCheckoutDisabled();
  }
  if (!stripeConfigured(env)) return rpcErrorResponse(undefined, 'unavailable');

  const identity = identityFrom(body);
  const authorization = await authorizeActiveSeatOwner(db, organizationId, identity);
  if ('response' in authorization) return authorization.response;
  const leaseToken = await claimSeatUpdateLease(db, organizationId, now);
  if (leaseToken === null) {
    return rpcErrorResponse(undefined, 'conflict', { reason: 'seat-update-in-progress' });
  }
  try {
    const loaded = await loadTeamSeatContext(db, env, organizationId, identity, Date.now());
    if ('response' in loaded) return loaded.response;
    const context = loaded.context;
    if (requestedSeats <= context.currentSeats) {
      return rpcErrorResponse(undefined, 'conflict', { reason: 'seat-quote-requires-increase' });
    }
    if (
      context.providerScheduleId !== null ||
      context.current.stripe_subscription_schedule_id !== null
    ) {
      return rpcErrorResponse(undefined, 'conflict', { reason: 'scheduled-seat-change-pending' });
    }
    const quoteNow = Date.now();
    const prorationDate = Math.floor(quoteNow / 1000);
    const amounts = await previewTeamSeatChange(env, context, requestedSeats, prorationDate);
    if (!(await renewSeatUpdateLease(db, organizationId, leaseToken))) {
      return rpcErrorResponse(undefined, 'conflict', { reason: 'seat-update-lease-expired' });
    }
    const quote = await persistSeatQuote(
      db,
      organizationId,
      context,
      requestedSeats,
      prorationDate,
      quoteNow,
      amounts,
    );
    return Response.json(quote);
  } finally {
    await releaseSeatUpdateLease(db, organizationId, leaseToken);
  }
}

/**
 * `POST /internal/hosted/seats/confirm` — confirms a displayed quote only
 * while its amount and subscription version still match Stripe's preview.
 */
export async function handleOrganizationSeatConfirm(
  body: unknown,
  env: Env,
  db: D1Database,
): Promise<Response> {
  if (
    !isRecord(body) ||
    !validateHostedIdentity(body) ||
    typeof body['organizationId'] !== 'string' ||
    body['organizationId'].length === 0 ||
    typeof body['quoteId'] !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body['quoteId'])
  ) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const organizationId = body['organizationId'];
  const quoteId = body['quoteId'];
  const now = Date.now();
  if (!hostedCheckoutAvailable(env, now)) {
    return syncCheckoutDisabled();
  }
  if (!stripeConfigured(env)) return rpcErrorResponse(undefined, 'unavailable');

  const identity = identityFrom(body);
  const authorization = await authorizeActiveSeatOwner(db, organizationId, identity);
  if ('response' in authorization) return authorization.response;
  const leaseToken = await claimSeatUpdateLease(db, organizationId, now);
  if (leaseToken === null) {
    return rpcErrorResponse(undefined, 'conflict', { reason: 'seat-update-in-progress' });
  }
  try {
    const quote = await db
      .prepare('SELECT * FROM team_seat_change_quotes WHERE id = ? AND organization_id = ?')
      .bind(quoteId, organizationId)
      .first<SeatQuoteRow>();
    if (
      quote === null ||
      quote.created_by_billing_account_id !== authorization.account.id ||
      quote.status !== 'pending'
    ) {
      return rpcErrorResponse(undefined, 'conflict', { reason: 'seat-quote-invalid' });
    }
    if (quote.expires_at <= now) {
      await db
        .prepare(
          `UPDATE team_seat_change_quotes SET status = 'expired'
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(quoteId)
        .run();
      return rpcErrorResponse(undefined, 'conflict', { reason: 'seat-quote-expired' });
    }

    const loaded = await loadTeamSeatContext(db, env, organizationId, identity, Date.now());
    if ('response' in loaded) return loaded.response;
    const context = loaded.context;
    if (
      context.providerScheduleId !== null ||
      context.current.stripe_subscription_schedule_id !== null
    ) {
      return rpcErrorResponse(undefined, 'conflict', { reason: 'scheduled-seat-change-pending' });
    }
    if (quote.requested_seat_quantity <= context.currentSeats) {
      await db
        .prepare(
          `UPDATE team_seat_change_quotes SET status = 'superseded'
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(quoteId)
        .run();
      return rpcErrorResponse(undefined, 'conflict', { reason: 'seat-change-already-applied' });
    }

    const sameSubscriptionVersion =
      quote.stripe_subscription_id === context.current.stripe_subscription_id &&
      quote.stripe_subscription_item_id === context.item.id &&
      quote.stripe_customer_id === context.customerId &&
      quote.current_seat_quantity === context.currentSeats &&
      quote.current_period_end === context.provider.current_period_end * 1000;
    const freshAmounts = await previewTeamSeatChange(
      env,
      context,
      quote.requested_seat_quantity,
      quote.proration_date,
    );
    const samePrice =
      quote.amount_due === freshAmounts.amountDue &&
      quote.currency === freshAmounts.currency &&
      quote.tax_amount === freshAmounts.taxAmount;
    if (!sameSubscriptionVersion || !samePrice) {
      const newProrationDate = Math.floor(Date.now() / 1000);
      const newAmounts = await previewTeamSeatChange(
        env,
        context,
        quote.requested_seat_quantity,
        newProrationDate,
      );
      if (!(await renewSeatUpdateLease(db, organizationId, leaseToken))) {
        return rpcErrorResponse(undefined, 'conflict', { reason: 'seat-update-lease-expired' });
      }
      const replacement = await persistSeatQuote(
        db,
        organizationId,
        context,
        quote.requested_seat_quantity,
        newProrationDate,
        Date.now(),
        newAmounts,
      );
      await db
        .prepare(
          `UPDATE team_seat_change_quotes SET status = 'superseded'
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(quoteId)
        .run();
      return rpcErrorResponse(undefined, 'conflict', {
        reason: 'seat-quote-changed',
        quote: replacement,
      });
    }

    if (!(await renewSeatUpdateLease(db, organizationId, leaseToken))) {
      return rpcErrorResponse(undefined, 'conflict', { reason: 'seat-update-lease-expired' });
    }

    let rawUpdated: unknown;
    try {
      rawUpdated = await stripeRequest<unknown>(
        env,
        `/v1/subscriptions/${encodeURIComponent(context.current.stripe_subscription_id)}`,
        {
          method: 'POST',
          params: {
            'items[0][id]': context.item.id as string,
            'items[0][quantity]': quote.requested_seat_quantity,
            proration_behavior: 'always_invoice',
            payment_behavior: 'error_if_incomplete',
            proration_date: quote.proration_date,
            'expand[0]': 'latest_invoice',
          },
          idempotencyKey: `team-seat-confirm:${quote.id}`,
        },
      );
    } catch (error) {
      if (error instanceof StripeApiError && error.status === 402) {
        await db
          .prepare(
            `UPDATE team_seat_change_quotes SET status = 'superseded'
             WHERE id = ? AND status = 'pending'`,
          )
          .bind(quoteId)
          .run();
        return rpcErrorResponse(undefined, 'conflict', { reason: 'payment-not-confirmed' });
      }
      throw error;
    }
    const updated = parseStripeSubscription(rawUpdated);
    if (
      updated === null ||
      updated.id !== context.current.stripe_subscription_id ||
      updated.customer !== context.customerId ||
      updated.status !== 'active' ||
      updated.items.data[0].quantity !== quote.requested_seat_quantity ||
      hostedPlanForPrice(
        env,
        updated.items.data[0].price.id,
        updated.items.data[0].price.recurring?.interval,
        updated.items.data[0].quantity,
      ) !== 'sync_team'
    ) {
      return rpcErrorResponse(undefined, 'conflict', { reason: 'payment-not-confirmed' });
    }
    const updatedInvoiceId = stripeLatestInvoiceId(rawUpdated);
    const invoiceWasPaid = await latestInvoicePaid(env, rawUpdated);
    if (
      !invoiceWasPaid ||
      (quote.amount_due > 0 && updatedInvoiceId === stripeLatestInvoiceId(context.rawProvider))
    ) {
      // Mirror the Stripe quantity but keep paid_seat_quantity unchanged;
      // the capacity refresh therefore cannot grant the unpaid upgrade.
      await upsertSubscriptionFromStripe(
        db,
        context.account.id,
        updated,
        Date.now(),
        env,
        organizationId,
      );
      await db
        .prepare(
          `UPDATE team_seat_change_quotes SET status = 'superseded'
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(quoteId)
        .run();
      return rpcErrorResponse(undefined, 'conflict', { reason: 'payment-not-confirmed' });
    }
    const confirmedAt = Date.now();
    await upsertSubscriptionFromStripe(
      db,
      context.account.id,
      updated,
      confirmedAt,
      env,
      organizationId,
    );
    await recordInvoicePaid(db, updated.id, confirmedAt);
    const confirmed = await db
      .prepare(
        `UPDATE team_seat_change_quotes SET status = 'confirmed', confirmed_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'pending'`,
      )
      .bind(confirmedAt, quoteId, organizationId)
      .run();
    if (confirmed.meta.changes !== 1) {
      return rpcErrorResponse(undefined, 'conflict', { reason: 'seat-quote-invalid' });
    }
    const capacity = await getOrganizationTeamCapacity(db, organizationId, confirmedAt);
    if (capacity !== quote.requested_seat_quantity) {
      return rpcErrorResponse(undefined, 'conflict', { reason: 'payment-not-confirmed' });
    }
    await audit(db, context.account.id, 'team.seats.increased', {
      organizationId,
      previousSeats: context.currentSeats,
      seats: quote.requested_seat_quantity,
      quoteId,
      amountDue: quote.amount_due,
      currency: quote.currency,
    });
    return Response.json({
      seatCapacity: capacity,
      scheduledSeatCapacity: null,
      effectiveAt: null,
    });
  } finally {
    await releaseSeatUpdateLease(db, organizationId, leaseToken);
  }
}

/**
 * `POST /internal/hosted/seats` — owner-controlled team quantity changes.
 * Increases take effect only after Stripe confirms an immediately invoiced
 * update; decreases are scheduled for the end of the current paid period.
 */
export async function handleOrganizationSeatChange(
  body: unknown,
  _env: Env,
  _db: D1Database,
): Promise<Response> {
  if (
    !isRecord(body) ||
    !validateHostedIdentity(body) ||
    typeof body['organizationId'] !== 'string' ||
    body['organizationId'].length === 0 ||
    !Number.isSafeInteger(body['seats']) ||
    (body['seats'] as number) < 5 ||
    (body['seats'] as number) > 50
  ) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  // Team seats are part of the fixed free fair-use quota. Do not mutate old
  // Stripe subscriptions or schedules through stale seat-management clients.
  return syncCheckoutDisabled();
}

export async function handleBillingOverview(
  body: unknown,
  env: Env,
  db: D1Database,
): Promise<Response> {
  if (!isRecord(body) || !validateHostedIdentity(body)) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const account = await getBillingAccountByIdentity(db, identityFrom(body));
  if (account === null) {
    return rpcErrorResponse(undefined, 'not-found');
  }
  const now = Date.now();
  const entitlement = await getEntitlement(
    db,
    account,
    now,
    resolveHostedLimits(env),
    !stripeConfigured(env),
  );
  const subscription = await latestSubscriptionForAccount(db, account.id);
  const pending = await latestOpenCheckout(db, account.id);
  const team = await findActiveTeamBillingForUser(db, account.id);
  const teamSubscription =
    team === null ? null : await latestSubscriptionForOrganization(db, team.organizationId);
  const reconcileAt = await getBillingMeta(db, LAST_RECONCILE_KEY);
  const personalSubscription =
    subscription === null
      ? null
      : {
          planKey: subscription.plan_key,
          interval: subscription.interval,
          status: subscription.status,
          currentPeriodEnd: subscription.current_period_end,
          cancelAtPeriodEnd: subscription.cancel_at_period_end === 1,
        };
  return Response.json({
    billingAccountId: account.id,
    lifecycle: account.lifecycle,
    entitlement,
    checkoutAvailable: hostedCheckoutAvailable(env, now),
    subscription: personalSubscription,
    personalSubscription,
    teamSponsorship:
      team === null || teamSubscription === null
        ? null
        : {
            organizationId: team.organizationId,
            organizationName: team.organizationName,
            planKey: teamSubscription.plan_key,
            interval: teamSubscription.interval,
            status: teamSubscription.status,
            currentPeriodEnd: teamSubscription.current_period_end,
            cancelAtPeriodEnd: teamSubscription.cancel_at_period_end === 1,
            seatCapacity: await getOrganizationTeamCapacity(db, team.organizationId, now),
          },
    pendingCheckout:
      pending === null
        ? null
        : { sessionId: pending.stripe_session_id, createdAt: pending.created_at },
    lastReconcileAt: reconcileAt === null ? null : Number(reconcileAt),
    lastWebhookAt: await lastWebhookProcessedAt(db),
  });
}

/**
 * `POST /internal/hosted/entitlement` — the stored entitlement snapshot.
 * Pure read of D1 provider truth; BILL-03 enforcement and desktop status
 * consume the same shape.
 */
export async function handleEntitlement(
  body: unknown,
  env: Env,
  db: D1Database,
): Promise<Response> {
  if (!isRecord(body) || !validateHostedIdentity(body)) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const account = await getBillingAccountByIdentity(db, identityFrom(body));
  if (account === null) {
    return rpcErrorResponse(undefined, 'not-found');
  }
  const entitlement = await getEntitlement(
    db,
    account,
    Date.now(),
    resolveHostedLimits(env),
    !stripeConfigured(env),
  );
  return Response.json(entitlement);
}

/**
 * `POST /internal/hosted/reconcile` — pulls the canonical subscription
 * list from Stripe and upserts each row, repairing lost or reordered
 * webhooks. A provider failure propagates as 503 without touching
 * last_reconcile_at.
 */
export async function handleReconcile(body: unknown, env: Env, db: D1Database): Promise<Response> {
  if (!isRecord(body) || !validateHostedIdentity(body)) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  if (!stripeConfigured(env)) {
    return rpcErrorResponse(undefined, 'unavailable');
  }
  const account = await getBillingAccountByIdentity(db, identityFrom(body));
  if (account === null) {
    return rpcErrorResponse(undefined, 'not-found');
  }
  if (account.lifecycle !== 'active') {
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'account-deleted' });
  }
  const now = Date.now();
  const customer = await getStripeCustomerForAccount(db, account.id);
  if (customer === null) {
    // Webhooks can legitimately be ahead of any subscription existing.
    await setBillingMeta(db, LAST_RECONCILE_KEY, String(now));
    await setBillingMeta(db, reconcileMetaKey(account.id), String(now));
    await audit(db, account.id, 'reconcile', { subscriptions: 0 });
    return Response.json({ reconciled: true, subscriptions: 0 });
  }
  const count = await reconcileStripeBillingOwner(
    db,
    env,
    {
      billingAccountId: account.id,
      organizationId: null,
      stripeCustomerId: customer.stripe_customer_id,
    },
    now,
  );
  await setBillingMeta(db, LAST_RECONCILE_KEY, String(now));
  await setBillingMeta(db, reconcileMetaKey(account.id), String(now));
  await audit(db, account.id, 'reconcile', { subscriptions: count });
  return Response.json({ reconciled: true, subscriptions: count });
}
