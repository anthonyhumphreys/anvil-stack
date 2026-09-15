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
import {
  audit,
  getBillingAccountIdByCustomer,
  getBillingMeta,
  getEntitlement,
  getStripeCustomerForAccount,
  getWebhookEvent,
  insertWebhookEvent,
  latestOpenCheckout,
  latestSubscriptionForAccount,
  lastWebhookProcessedAt,
  markCheckoutComplete,
  markCheckoutExpired,
  markSubscriptionDeleted,
  markWebhookFailed,
  markWebhookProcessed,
  recordCheckoutSession,
  recordInvoiceFailed,
  recordInvoicePaid,
  resolveHostedLimits,
  setBillingMeta,
  upsertStripeCustomer,
  upsertSubscriptionFromStripe,
} from './billing';
import { validateHostedIdentity, type HostedIdentity } from './identity';
import {
  parseStripeCheckoutSession,
  parseStripeInvoice,
  parseStripeSubscription,
  StripeApiError,
  stripeRequest,
  verifyStripeWebhookSignature,
  type StripeCheckoutSession,
  type StripeList,
  type StripePortalSession,
} from './stripe';
import { getBillingAccountById, getBillingAccountByIdentity, getOrCreateBillingAccount } from './store';

const WEBHOOK_BODY_MAX_BYTES = 64 * 1024;
const LAST_RECONCILE_KEY = 'last_reconcile_at';

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
  object: unknown;
}

function parseStripeEvent(value: unknown): StripeEvent | null {
  if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['type'] !== 'string') {
    return null;
  }
  const data = isRecord(value['data']) ? value['data'] : null;
  return { id: value['id'], type: value['type'], object: data?.['object'] };
}

/** Audit tag for events that cannot be attributed to a billing account. */
const UNMAPPED = 'unmapped';

/**
 * Applies one verified, deduped event. Returns false when the event is a
 * deterministic reject — the caller records it as failed and still
 * acknowledges delivery. Throws only for retryable infrastructure faults.
 */
async function processStripeEvent(db: D1Database, event: StripeEvent): Promise<boolean> {
  const now = Date.now();
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = parseStripeCheckoutSession(event.object);
      const accountId = session?.client_reference_id ?? null;
      const account = accountId === null ? null : await getBillingAccountById(db, accountId);
      if (session === null || account === null) {
        await audit(db, accountId ?? UNMAPPED, 'checkout.rejected', {
          eventId: event.id,
          sessionId: session?.id ?? null,
        });
        return false;
      }
      if (session.customer !== null) {
        await upsertStripeCustomer(db, account.id, session.customer);
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
      const accountId =
        session.client_reference_id ?? (await accountIdForSession(db, session.id));
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
      const accountId = await getBillingAccountIdByCustomer(db, sub.customer);
      if (accountId === null) {
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
      await upsertSubscriptionFromStripe(db, accountId, sub, now);
      await audit(db, accountId, 'subscription.upserted', {
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
      const accountId = await getBillingAccountIdByCustomer(db, sub.customer);
      if (accountId === null) {
        await audit(db, UNMAPPED, 'subscription.ignored-unknown-customer', {
          eventId: event.id,
          customer: sub.customer,
          subscription: sub.id,
          type: event.type,
        });
        return true;
      }
      await markSubscriptionDeleted(db, sub.id, now);
      await audit(db, accountId, 'subscription.deleted', {
        eventId: event.id,
        subscription: sub.id,
      });
      return true;
    }
    case 'invoice.paid': {
      const invoice = parseStripeInvoice(event.object);
      if (invoice === null) return false;
      const subscription =
        invoice.subscription === null ? null : await findSubscription(db, invoice.subscription);
      if (invoice.subscription === null || subscription === null) {
        await audit(db, UNMAPPED, 'invoice.ignored', {
          eventId: event.id,
          invoice: invoice.id,
          subscription: invoice.subscription,
        });
        return true;
      }
      await recordInvoicePaid(db, invoice.subscription, now);
      await audit(db, subscription.billing_account_id, 'invoice.paid', {
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
      const subscription = await findSubscription(db, invoice.subscription);
      if (subscription === null) {
        await audit(db, UNMAPPED, 'invoice.ignored', {
          eventId: event.id,
          invoice: invoice.id,
          subscription: invoice.subscription,
        });
        return true;
      }
      await recordInvoiceFailed(db, invoice.subscription, now);
      await audit(db, subscription.billing_account_id, 'invoice.payment_failed', {
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

async function findSubscription(
  db: D1Database,
  stripeSubscriptionId: string,
): Promise<{ billing_account_id: string } | null> {
  return db
    .prepare(
      'SELECT billing_account_id FROM stripe_subscriptions WHERE stripe_subscription_id = ?',
    )
    .bind(stripeSubscriptionId)
    .first<{ billing_account_id: string }>();
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
    return rpcErrorResponse(undefined, 'unauthenticated');
  }
  const event = parseStripeEvent(parseJson(rawBody));
  if (event === null) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  const now = Date.now();
  const fresh = await insertWebhookEvent(db, event.id, event.type, now);
  if (!fresh) {
    const existing = await getWebhookEvent(db, event.id);
    if (existing !== null && existing.status === 'processed') {
      return Response.json({ received: true, duplicate: true });
    }
  }
  try {
    if (!(await processStripeEvent(db, event))) {
      await markWebhookFailed(db, event.id, 'event could not be applied', now);
      return Response.json({ received: true });
    }
    await markWebhookProcessed(db, event.id, now);
    return Response.json({ received: true });
  } catch (error) {
    await markWebhookFailed(db, event.id, errorMessage(error), now);
    return rpcErrorResponse(undefined, 'unavailable');
  }
}

function stripeConfigured(env: Env): boolean {
  return typeof env.STRIPE_SECRET_KEY === 'string' && env.STRIPE_SECRET_KEY.length > 0;
}

function identityFrom(body: HostedIdentity): HostedIdentity {
  return { workosClientId: body.workosClientId, workosUserId: body.workosUserId };
}

/**
 * `POST /internal/hosted/checkout` — creates a Stripe Checkout Session in
 * subscription mode for the caller's billing account. Every config gate
 * runs before any provider call, so a disabled/misconfigured deployment
 * never creates customers or sessions.
 */
export async function handleCheckout(
  body: unknown,
  env: Env,
  db: D1Database,
): Promise<Response> {
  if (
    !isRecord(body) ||
    !validateHostedIdentity(body) ||
    (body['interval'] !== 'month' && body['interval'] !== 'year')
  ) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  if (env.HOSTED_CHECKOUT_ENABLED !== 'true') {
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'checkout-disabled' });
  }
  const interval = body['interval'];
  const price =
    interval === 'year' ? env.STRIPE_PRICE_SYNC_ANNUAL : env.STRIPE_PRICE_SYNC_MONTHLY;
  const successUrl = env.HOSTED_CHECKOUT_SUCCESS_URL;
  const cancelUrl = env.HOSTED_CHECKOUT_CANCEL_URL;
  if (
    !stripeConfigured(env) ||
    typeof price !== 'string' ||
    price.length === 0 ||
    typeof successUrl !== 'string' ||
    successUrl.length === 0 ||
    typeof cancelUrl !== 'string' ||
    cancelUrl.length === 0
  ) {
    return rpcErrorResponse(undefined, 'unavailable');
  }
  const account = await getOrCreateBillingAccount(db, identityFrom(body));
  if (account.lifecycle !== 'active') {
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'account-deleted' });
  }
  let customer = await getStripeCustomerForAccount(db, account.id);
  if (customer === null) {
    const created = await stripeRequest<{ id: string }>(env, '/v1/customers', {
      method: 'POST',
      params: { 'metadata[billing_account_id]': account.id },
      idempotencyKey: `customer:${account.id}`,
    });
    customer = await upsertStripeCustomer(db, account.id, created.id);
  }
  const session = await stripeRequest<StripeCheckoutSession>(env, '/v1/checkout/sessions', {
    method: 'POST',
    params: {
      mode: 'subscription',
      customer: customer.stripe_customer_id,
      'line_items[0][price]': price,
      'line_items[0][quantity]': 1,
      client_reference_id: account.id,
      'metadata[billing_account_id]': account.id,
      success_url: successUrl,
      cancel_url: cancelUrl,
    },
    idempotencyKey: `checkout:${account.id}:${interval}:${Math.floor(Date.now() / 3_600_000)}`,
  });
  if (typeof session.url !== 'string' || session.url.length === 0) {
    throw new StripeApiError(0, 'checkout session missing url');
  }
  await recordCheckoutSession(db, session.id, account.id, 'sync_personal', interval, Date.now());
  await audit(db, account.id, 'checkout.created', { sessionId: session.id, interval });
  return Response.json({ checkoutUrl: session.url, sessionId: session.id });
}

/** `POST /internal/hosted/portal` — Stripe Customer Portal session. */
export async function handlePortal(
  body: unknown,
  env: Env,
  db: D1Database,
): Promise<Response> {
  if (!isRecord(body) || !validateHostedIdentity(body)) {
    return rpcErrorResponse(undefined, 'malformed-request');
  }
  if (!stripeConfigured(env)) {
    return rpcErrorResponse(undefined, 'unavailable');
  }
  const returnUrl = env.HOSTED_PORTAL_RETURN_URL;
  if (typeof returnUrl !== 'string' || returnUrl.length === 0) {
    return rpcErrorResponse(undefined, 'unavailable');
  }
  const account = await getBillingAccountByIdentity(db, identityFrom(body));
  if (account === null) {
    return rpcErrorResponse(undefined, 'not-found');
  }
  if (account.lifecycle !== 'active') {
    return rpcErrorResponse(undefined, 'forbidden', { reason: 'account-deleted' });
  }
  const customer = await getStripeCustomerForAccount(db, account.id);
  if (customer === null) {
    return rpcErrorResponse(undefined, 'not-found');
  }
  const session = await stripeRequest<StripePortalSession>(env, '/v1/billing_portal/sessions', {
    method: 'POST',
    params: { customer: customer.stripe_customer_id, return_url: returnUrl },
    idempotencyKey: `portal:${account.id}:${Math.floor(Date.now() / 3_600_000)}`,
  });
  if (typeof session.url !== 'string' || session.url.length === 0) {
    throw new StripeApiError(0, 'portal session missing url');
  }
  await audit(db, account.id, 'portal.created', { sessionId: session.id });
  return Response.json({ portalUrl: session.url });
}

/** `POST /internal/hosted/billing` — the website's billing overview. */
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
  const reconcileAt = await getBillingMeta(db, LAST_RECONCILE_KEY);
  return Response.json({
    billingAccountId: account.id,
    lifecycle: account.lifecycle,
    entitlement,
    subscription:
      subscription === null
        ? null
        : {
            planKey: subscription.plan_key,
            interval: subscription.interval,
            status: subscription.status,
            currentPeriodEnd: subscription.current_period_end,
            cancelAtPeriodEnd: subscription.cancel_at_period_end === 1,
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
export async function handleReconcile(
  body: unknown,
  env: Env,
  db: D1Database,
): Promise<Response> {
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
    await audit(db, account.id, 'reconcile', { subscriptions: 0 });
    return Response.json({ reconciled: true, subscriptions: 0 });
  }
  const list = await stripeRequest<StripeList<unknown>>(env, '/v1/subscriptions', {
    method: 'GET',
    params: { customer: customer.stripe_customer_id, status: 'all', limit: 25 },
  });
  let count = 0;
  for (const item of list.data ?? []) {
    const sub = parseStripeSubscription(item);
    if (sub === null) {
      throw new StripeApiError(0, 'subscription list item failed validation');
    }
    await upsertSubscriptionFromStripe(db, account.id, sub, now);
    count += 1;
  }
  await setBillingMeta(db, LAST_RECONCILE_KEY, String(now));
  await audit(db, account.id, 'reconcile', { subscriptions: count });
  return Response.json({ reconciled: true, subscriptions: count });
}
