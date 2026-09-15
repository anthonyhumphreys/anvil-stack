import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HostedEntitlement } from '../../contract/entitlements';
import { getEntitlement } from '../src/hosted/billing';
import type { HostedIdentity } from '../src/hosted/identity';
import { DEFAULT_HOSTED_LIMITS, PREVIEW_END_MS } from '../src/hosted/policy';
import { handleHostedRequest } from '../src/hosted/routes';
import { signHostedServiceRequest } from '../src/hosted/service-auth';
import {
  getBillingAccountByIdentity,
  getOrCreateBillingAccount,
  type BillingAccountRow,
} from '../src/hosted/store';
import migration0001 from '../migrations/hosted-billing/0001_init.sql?raw';
import migration0002 from '../migrations/hosted-billing/0002_billing.sql?raw';

const SERVICE_KEY_ID = 'test';
const SERVICE_SECRET = 'a'.repeat(32);
const SERVICE_AUDIENCE = 'anvil-hosted';
const WEBHOOK_SECRET = 'whsec_testfake0123456789';
const STRIPE_API = 'https://api.stripe.com';
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** A fixed evaluation instant safely past the 2026-11-01 preview cutoff. */
const POST_PREVIEW = PREVIEW_END_MS + 30 * DAY;

const ENV_DEFAULTS: Record<string, string> = {
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  HOSTED_CHECKOUT_ENABLED: 'true',
  STRIPE_PRICE_SYNC_MONTHLY: 'price_test_monthly',
  STRIPE_PRICE_SYNC_ANNUAL: 'price_test_annual',
  HOSTED_CHECKOUT_SUCCESS_URL: 'https://example.test/checkout/success',
  HOSTED_CHECKOUT_CANCEL_URL: 'https://example.test/checkout/cancel',
  HOSTED_PORTAL_RETURN_URL: 'https://example.test/account',
};

function hostedDb(): D1Database {
  const db = env.HOSTED_DB;
  if (db === undefined) throw new Error('HOSTED_DB binding missing in test env');
  return db;
}

function applyMigration(sql: string): Promise<unknown> {
  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const db = hostedDb();
  return db.batch(statements.map((statement) => db.prepare(statement)));
}

beforeEach(async () => {
  await applyMigration(migration0001);
  await applyMigration(migration0002);
  // Outbound Stripe calls are served by the miniflare outbound stub in
  // vitest.config.ts; reset its queue between tests.
  await fetch(`${STRIPE_API}/__stripe-stub/reset`, { method: 'POST' });
});

afterEach(async () => {
  // Restore any env mutations and prove every queued Stripe response was
  // consumed — a leftover means an expected provider call never happened.
  for (const [key, value] of Object.entries(ENV_DEFAULTS)) {
    (env as unknown as Record<string, string>)[key] = value;
  }
  const pending = (await (
    await fetch(`${STRIPE_API}/__stripe-stub/pending`)
  ).json()) as { pending: unknown[] };
  expect(pending.pending).toEqual([]);
});

function makeIdentity(tag: string): HostedIdentity {
  return { workosClientId: `client_${tag}`, workosUserId: `user_${tag}` };
}

/** Signs and POSTs a service request to an /internal/hosted/* route. */
async function signedHostedPost(
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = new TextEncoder().encode(JSON.stringify(body));
  const url = `https://spike.test${path}`;
  const headers = await signHostedServiceRequest(
    new Request(url, { method: 'POST' }),
    payload,
    { audience: SERVICE_AUDIENCE, keyId: SERVICE_KEY_ID, secret: SERVICE_SECRET },
    Date.now(),
  );
  const response = await SELF.fetch(
    new Request(url, { method: 'POST', headers, body: payload }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Queues one canned Stripe API response on the miniflare outbound stub. */
async function stubStripe(
  method: string,
  path: string,
  body: unknown,
  status = 200,
): Promise<void> {
  const response = await fetch(`${STRIPE_API}/__stripe-stub/enqueue`, {
    method: 'POST',
    body: JSON.stringify({ method, path, status, body }),
  });
  expect(response.status).toBe(200);
}

async function signStripePayload(rawBody: string, timestampMs: number): Promise<string> {
  const seconds = Math.floor(timestampMs / 1000);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${seconds}.${rawBody}`),
  );
  const hex = [...new Uint8Array(signature)]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
  return `t=${seconds},v1=${hex}`;
}

function stripeEvent(id: string, type: string, object: unknown): string {
  return JSON.stringify({ id, object: 'event', type, data: { object } });
}

async function postWebhook(
  rawBody: string,
  options: { header?: string | null; timestamp?: number } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers({ 'content-type': 'application/json' });
  const header =
    options.header === null
      ? null
      : (options.header ?? (await signStripePayload(rawBody, options.timestamp ?? Date.now())));
  if (header !== null) headers.set('stripe-signature', header);
  const response = await SELF.fetch('https://spike.test/v1/hosted/stripe-webhook', {
    method: 'POST',
    headers,
    body: rawBody,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function stripeSubscription(
  customer: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `sub_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
    object: 'subscription',
    status: 'active',
    customer,
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
    cancel_at_period_end: false,
    items: {
      object: 'list',
      data: [{ price: { id: 'price_test_monthly', recurring: { interval: 'month' } } }],
    },
    ...overrides,
  };
}

async function insertStripeCustomer(
  billingAccountId: string,
  stripeCustomerId: string,
): Promise<void> {
  await hostedDb()
    .prepare(
      'INSERT INTO stripe_customers (stripe_customer_id, billing_account_id, created_at) VALUES (?, ?, ?)',
    )
    .bind(stripeCustomerId, billingAccountId, Date.now())
    .run();
}

async function subscriptionRow(
  stripeSubscriptionId: string,
): Promise<Record<string, unknown> | null> {
  return hostedDb()
    .prepare('SELECT * FROM stripe_subscriptions WHERE stripe_subscription_id = ?')
    .bind(stripeSubscriptionId)
    .first<Record<string, unknown>>();
}

async function webhookRow(
  stripeEventId: string,
): Promise<Record<string, unknown> | null> {
  return hostedDb()
    .prepare('SELECT * FROM webhook_events WHERE stripe_event_id = ?')
    .bind(stripeEventId)
    .first<Record<string, unknown>>();
}

async function auditKinds(billingAccountId: string): Promise<string[]> {
  const { results } = await hostedDb()
    .prepare(
      'SELECT kind FROM billing_audit WHERE billing_account_id = ? ORDER BY id',
    )
    .bind(billingAccountId)
    .all<{ kind: string }>();
  return (results ?? []).map((row) => row.kind);
}

describe('stripe webhook signature gate', () => {
  it('processes a validly signed event and answers received', async () => {
    const result = await postWebhook(
      stripeEvent(`evt_${crypto.randomUUID()}`, 'account.updated', { id: 'acct_x' }),
    );
    expect(result.status).toBe(200);
    expect(result.body['received']).toBe(true);
  });

  it('rejects a tampered body, a stale timestamp, and a missing header', async () => {
    const eventId = `evt_${crypto.randomUUID()}`;
    const raw = stripeEvent(eventId, 'account.updated', { id: 'acct_y' });
    const signature = await signStripePayload(raw, Date.now());
    const tampered = await postWebhook(raw.replace('acct_y', 'acct_z'), {
      header: signature,
    });
    expect(tampered.status).toBe(401);

    const stale = await postWebhook(raw, { timestamp: Date.now() - 600_000 });
    expect(stale.status).toBe(401);

    const missing = await postWebhook(raw, { header: null });
    expect(missing.status).toBe(401);

    const goodHeader = await signStripePayload(raw, Date.now());
    const corrupted =
      goodHeader.slice(0, -2) + (goodHeader.endsWith('00') ? 'ff' : '00');
    const wrong = await postWebhook(raw, { header: corrupted });
    expect(wrong.status).toBe(401);
    // None of the rejected deliveries reached the inbox.
    expect(await webhookRow(eventId)).toBeNull();
  });

  it('answers 404 without HOSTED_DB and without STRIPE_WEBHOOK_SECRET', async () => {
    const selfHostEnv = {
      ACCOUNT: env.ACCOUNT,
      SESSIONS: env.SESSIONS,
      ARTIFACTS: env.ARTIFACTS,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    } as Env;
    const noDb = await handleHostedRequest(
      new Request('https://selfhost.test/v1/hosted/stripe-webhook', {
        method: 'POST',
        body: '{}',
      }),
      selfHostEnv,
    );
    expect(noDb.status).toBe(404);

    env.STRIPE_WEBHOOK_SECRET = '';
    const noSecret = await postWebhook(
      stripeEvent(`evt_${crypto.randomUUID()}`, 'account.updated', {}),
      { header: null },
    );
    expect(noSecret.status).toBe(404);
  });
});

describe('checkout.session.completed', () => {
  it('stores the customer, completes the checkout row, and audits', async () => {
    const identity = makeIdentity(`co-${crypto.randomUUID()}`);
    const account = await getOrCreateBillingAccount(hostedDb(), identity);
    const customerId = `cus_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const sessionId = `cs_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await stubStripe('POST', '/v1/customers', { id: customerId });
    await stubStripe('POST', '/v1/checkout/sessions', {
      id: sessionId,
      url: `https://checkout.stripe.test/pay/${sessionId}`,
      status: 'open',
      customer: customerId,
      subscription: null,
      client_reference_id: account.id,
    });
    const checkout = await signedHostedPost('/internal/hosted/checkout', {
      ...identity,
      interval: 'month',
    });
    expect(checkout.status).toBe(200);
    expect(checkout.body['checkoutUrl']).toBe(`https://checkout.stripe.test/pay/${sessionId}`);
    expect(checkout.body['sessionId']).toBe(sessionId);
    const open = await hostedDb()
      .prepare('SELECT status FROM checkout_sessions WHERE stripe_session_id = ?')
      .bind(sessionId)
      .first<{ status: string }>();
    expect(open?.status).toBe('open');

    // A repeat checkout reuses the stored customer: the stub queue holds
    // no second POST /v1/customers response, so a recreate would fail.
    const sessionId2 = `cs_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await stubStripe('POST', '/v1/checkout/sessions', {
      id: sessionId2,
      url: `https://checkout.stripe.test/pay/${sessionId2}`,
      status: 'open',
      customer: customerId,
      subscription: null,
      client_reference_id: account.id,
    });
    const again = await signedHostedPost('/internal/hosted/checkout', {
      ...identity,
      interval: 'month',
    });
    expect(again.status).toBe(200);
    expect(again.body['sessionId']).toBe(sessionId2);
    const customers = await hostedDb()
      .prepare('SELECT COUNT(*) AS n FROM stripe_customers WHERE billing_account_id = ?')
      .bind(account.id)
      .first<{ n: number }>();
    expect(customers?.n).toBe(1);

    const eventId = `evt_${crypto.randomUUID()}`;
    const completed = await postWebhook(
      stripeEvent(eventId, 'checkout.session.completed', {
        id: sessionId,
        object: 'checkout.session',
        status: 'complete',
        customer: customerId,
        subscription: 'sub_new_1',
        client_reference_id: account.id,
      }),
    );
    expect(completed.status).toBe(200);
    expect(completed.body['received']).toBe(true);

    const session = await hostedDb()
      .prepare('SELECT * FROM checkout_sessions WHERE stripe_session_id = ?')
      .bind(sessionId)
      .first<Record<string, unknown>>();
    expect(session?.['status']).toBe('complete');
    expect(session?.['completed_at']).toBeTypeOf('number');

    const customer = await hostedDb()
      .prepare('SELECT * FROM stripe_customers WHERE billing_account_id = ?')
      .bind(account.id)
      .first<Record<string, unknown>>();
    expect(customer?.['stripe_customer_id']).toBe(customerId);

    const kinds = await auditKinds(account.id);
    expect(kinds).toContain('checkout.created');
    expect(kinds).toContain('checkout.completed');
  });

  it('expires an open checkout session on checkout.session.expired', async () => {
    const identity = makeIdentity(`exp-${crypto.randomUUID()}`);
    const account = await getOrCreateBillingAccount(hostedDb(), identity);
    const sessionId = `cs_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const now = Date.now();
    await hostedDb()
      .prepare(
        `INSERT INTO checkout_sessions
          (stripe_session_id, billing_account_id, plan_key, interval, status, created_at)
         VALUES (?, ?, 'sync_personal', 'month', 'open', ?)`,
      )
      .bind(sessionId, account.id, now)
      .run();
    const result = await postWebhook(
      stripeEvent(`evt_${crypto.randomUUID()}`, 'checkout.session.expired', {
        id: sessionId,
        object: 'checkout.session',
        status: 'expired',
        customer: null,
        subscription: null,
        client_reference_id: null,
      }),
    );
    expect(result.status).toBe(200);
    const row = await hostedDb()
      .prepare('SELECT status FROM checkout_sessions WHERE stripe_session_id = ?')
      .bind(sessionId)
      .first<{ status: string }>();
    expect(row?.status).toBe('expired');
    expect(await auditKinds(account.id)).toContain('checkout.expired');
  });

  it('fails the event for an unknown client_reference_id', async () => {
    const eventId = `evt_${crypto.randomUUID()}`;
    const result = await postWebhook(
      stripeEvent(eventId, 'checkout.session.completed', {
        id: 'cs_test_unknown',
        object: 'checkout.session',
        status: 'complete',
        customer: 'cus_ghost',
        client_reference_id: 'bill_doesnotexist',
      }),
    );
    expect(result.status).toBe(200);
    const row = await webhookRow(eventId);
    expect(row?.['status']).toBe('failed');
  });
});

describe('subscription lifecycle webhooks', () => {
  it('upserts subscription state verbatim and cancels on deleted', async () => {
    const identity = makeIdentity(`sub-${crypto.randomUUID()}`);
    const account = await getOrCreateBillingAccount(hostedDb(), identity);
    const customerId = `cus_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await insertStripeCustomer(account.id, customerId);

    const sub = stripeSubscription(customerId);
    const created = await postWebhook(
      stripeEvent(`evt_${crypto.randomUUID()}`, 'customer.subscription.created', sub),
    );
    expect(created.status).toBe(200);
    let row = await subscriptionRow(sub['id'] as string);
    expect(row).not.toBeNull();
    expect(row?.['status']).toBe('active');
    expect(row?.['billing_account_id']).toBe(account.id);
    expect(row?.['interval']).toBe('month');
    expect(row?.['has_paid_invoice']).toBe(0);

    // Move verified_at backwards so the next upsert provably advances it.
    const earlier = (row?.['verified_at'] as number) - 60_000;
    await hostedDb()
      .prepare('UPDATE stripe_subscriptions SET verified_at = ? WHERE stripe_subscription_id = ?')
      .bind(earlier, sub['id'])
      .run();
    const periodEnd = Math.floor(Date.now() / 1000) + 60 * 86_400;
    const updated = await postWebhook(
      stripeEvent(
        `evt_${crypto.randomUUID()}`,
        'customer.subscription.updated',
        stripeSubscription(customerId, {
          id: sub['id'],
          status: 'past_due',
          current_period_end: periodEnd,
          cancel_at_period_end: true,
        }),
      ),
    );
    expect(updated.status).toBe(200);
    row = await subscriptionRow(sub['id'] as string);
    expect(row?.['status']).toBe('past_due');
    expect(row?.['cancel_at_period_end']).toBe(1);
    expect(row?.['current_period_end']).toBe(periodEnd * 1000);
    expect(row?.['verified_at'] as number).toBeGreaterThan(earlier);

    const deleted = await postWebhook(
      stripeEvent(
        `evt_${crypto.randomUUID()}`,
        'customer.subscription.deleted',
        stripeSubscription(customerId, { id: sub['id'], status: 'canceled' }),
      ),
    );
    expect(deleted.status).toBe(200);
    row = await subscriptionRow(sub['id'] as string);
    expect(row?.['status']).toBe('canceled');
    expect(await auditKinds(account.id)).toContain('subscription.deleted');
  });

  it('processes events for unknown customers without side-effects', async () => {
    const eventId = `evt_${crypto.randomUUID()}`;
    const result = await postWebhook(
      stripeEvent(
        eventId,
        'customer.subscription.created',
        stripeSubscription(`cus_stray_${crypto.randomUUID().slice(0, 8)}`),
      ),
    );
    expect(result.status).toBe(200);
    expect(result.body['received']).toBe(true);
    const row = await webhookRow(eventId);
    expect(row?.['status']).toBe('processed');
    const audit = await hostedDb()
      .prepare("SELECT kind FROM billing_audit WHERE kind = 'subscription.ignored-unknown-customer'")
      .all<{ kind: string }>();
    expect((audit.results ?? []).length).toBeGreaterThan(0);
  });

  it('dedupes redelivered event ids without double side-effects', async () => {
    const identity = makeIdentity(`dup-${crypto.randomUUID()}`);
    const account = await getOrCreateBillingAccount(hostedDb(), identity);
    const customerId = `cus_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await insertStripeCustomer(account.id, customerId);
    const sub = stripeSubscription(customerId, { status: 'active' });
    const eventId = `evt_${crypto.randomUUID()}`;
    const raw = stripeEvent(eventId, 'customer.subscription.updated', sub);

    const first = await postWebhook(raw);
    expect(first.status).toBe(200);
    const again = await postWebhook(raw);
    expect(again.status).toBe(200);
    expect(again.body['duplicate']).toBe(true);

    const count = await hostedDb()
      .prepare(
        'SELECT COUNT(*) AS n FROM stripe_subscriptions WHERE stripe_subscription_id = ?',
      )
      .bind(sub['id'])
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
    const event = await webhookRow(eventId);
    expect(event?.['attempts']).toBe(1);
  });
});

describe('invoice webhooks', () => {
  async function seedSubscription(
    overrides: {
      status?: string;
      hasPaidInvoice?: number;
      firstFailedRenewalAt?: number | null;
    } = {},
  ): Promise<{ account: BillingAccountRow; subscriptionId: string }> {
    const identity = makeIdentity(`inv-${crypto.randomUUID()}`);
    const account = await getOrCreateBillingAccount(hostedDb(), identity);
    const customerId = `cus_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await insertStripeCustomer(account.id, customerId);
    const subscriptionId = `sub_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const now = Date.now();
    await hostedDb()
      .prepare(
        `INSERT INTO stripe_subscriptions
          (stripe_subscription_id, stripe_customer_id, billing_account_id,
           status, plan_key, interval, current_period_end, cancel_at_period_end,
           has_paid_invoice, first_failed_renewal_at, verified_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'sync_personal', 'month', ?, 0, ?, ?, ?, ?, ?)`,
      )
      .bind(
        subscriptionId,
        customerId,
        account.id,
        overrides.status ?? 'active',
        now + 30 * DAY,
        overrides.hasPaidInvoice ?? 0,
        overrides.firstFailedRenewalAt ?? null,
        now,
        now,
        now,
      )
      .run();
    return { account, subscriptionId };
  }

  it('marks has_paid_invoice and clears a recorded renewal failure', async () => {
    const { account, subscriptionId } = await seedSubscription({
      firstFailedRenewalAt: Date.now() - DAY,
    });
    const result = await postWebhook(
      stripeEvent(`evt_${crypto.randomUUID()}`, 'invoice.paid', {
        id: 'in_paid_1',
        object: 'invoice',
        subscription: subscriptionId,
        billing_reason: 'subscription_cycle',
        status: 'paid',
      }),
    );
    expect(result.status).toBe(200);
    const row = await subscriptionRow(subscriptionId);
    expect(row?.['has_paid_invoice']).toBe(1);
    expect(row?.['first_failed_renewal_at']).toBeNull();
    expect(await auditKinds(account.id)).toContain('invoice.paid');
  });

  it('records the first renewal failure once and never moves it', async () => {
    const { subscriptionId } = await seedSubscription({ status: 'past_due' });
    const failed = async () =>
      postWebhook(
        stripeEvent(`evt_${crypto.randomUUID()}`, 'invoice.payment_failed', {
          id: `in_${crypto.randomUUID().slice(0, 8)}`,
          object: 'invoice',
          subscription: subscriptionId,
          billing_reason: 'subscription_cycle',
          status: 'open',
        }),
      );
    expect((await failed()).status).toBe(200);
    const first = (await subscriptionRow(subscriptionId))?.['first_failed_renewal_at'];
    expect(first).toBeTypeOf('number');

    // A later failure must not restart the grace clock.
    const pinned = (first as number) - 2 * HOUR;
    await hostedDb()
      .prepare(
        'UPDATE stripe_subscriptions SET first_failed_renewal_at = ? WHERE stripe_subscription_id = ?',
      )
      .bind(pinned, subscriptionId)
      .run();
    expect((await failed()).status).toBe(200);
    expect((await subscriptionRow(subscriptionId))?.['first_failed_renewal_at']).toBe(pinned);
  });

  it('ignores non-cycle failure reasons', async () => {
    const { subscriptionId } = await seedSubscription();
    const result = await postWebhook(
      stripeEvent(`evt_${crypto.randomUUID()}`, 'invoice.payment_failed', {
        id: 'in_create_1',
        object: 'invoice',
        subscription: subscriptionId,
        billing_reason: 'subscription_create',
        status: 'open',
      }),
    );
    expect(result.status).toBe(200);
    expect(
      (await subscriptionRow(subscriptionId))?.['first_failed_renewal_at'],
    ).toBeNull();
  });
});

describe('entitlement over stored provider truth', () => {
  it('reports active paid access through the stored period end', async () => {
    const identity = makeIdentity(`ent-${crypto.randomUUID()}`);
    const account = await getOrCreateBillingAccount(hostedDb(), identity);
    const customerId = `cus_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await insertStripeCustomer(account.id, customerId);
    const paidThroughSec = Math.floor((POST_PREVIEW + 30 * DAY) / 1000);
    const sub = stripeSubscription(customerId, {
      status: 'active',
      current_period_end: paidThroughSec,
    });
    expect(
      (await postWebhook(stripeEvent(`evt_${crypto.randomUUID()}`, 'customer.subscription.created', sub))).status,
    ).toBe(200);
    await postWebhook(
      stripeEvent(`evt_${crypto.randomUUID()}`, 'invoice.paid', {
        id: 'in_1',
        object: 'invoice',
        subscription: sub['id'],
        billing_reason: 'subscription_create',
        status: 'paid',
      }),
    );
    const entitlement = await getEntitlement(
      hostedDb(),
      account,
      POST_PREVIEW,
      DEFAULT_HOSTED_LIMITS,
      false,
    );
    expect(entitlement.state).toBe('active');
    expect(entitlement.source).toBe('subscription');
    expect(entitlement.reason).toBe('paid');
    expect(entitlement.accessUntil).toBe(new Date(paidThroughSec * 1000).toISOString());
    expect(entitlement.capabilities).toEqual({ syncWrite: true, meshSubmit: true });
  });

  it('grants seven-day renewal grace for a recently failed paid renewal', async () => {
    const identity = makeIdentity(`grace-${crypto.randomUUID()}`);
    const account = await getOrCreateBillingAccount(hostedDb(), identity);
    const customerId = `cus_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await insertStripeCustomer(account.id, customerId);
    const periodEnd = POST_PREVIEW + 5 * DAY;
    const subscriptionId = `sub_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const now = Date.now();
    await hostedDb()
      .prepare(
        `INSERT INTO stripe_subscriptions
          (stripe_subscription_id, stripe_customer_id, billing_account_id,
           status, plan_key, interval, current_period_end, cancel_at_period_end,
           has_paid_invoice, first_failed_renewal_at, verified_at, created_at, updated_at)
         VALUES (?, ?, ?, 'past_due', 'sync_personal', 'month', ?, 0, 1, ?, ?, ?, ?)`,
      )
      .bind(subscriptionId, customerId, account.id, periodEnd, periodEnd, periodEnd + HOUR, now, now)
      .run();
    const entitlement = await getEntitlement(
      hostedDb(),
      account,
      periodEnd + 3 * DAY,
      DEFAULT_HOSTED_LIMITS,
      false,
    );
    expect(entitlement.state).toBe('grace');
    expect(entitlement.source).toBe('renewal-grace');
    expect(entitlement.reason).toBe('renewal-failed');
    expect(entitlement.graceUntil).toBe(new Date(periodEnd + 7 * DAY).toISOString());
  });

  it('restricts an incomplete-only subscription after the preview cutoff', async () => {
    const identity = makeIdentity(`inc-${crypto.randomUUID()}`);
    const account = await getOrCreateBillingAccount(hostedDb(), identity);
    const customerId = `cus_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await insertStripeCustomer(account.id, customerId);
    const subscriptionId = `sub_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const now = Date.now();
    await hostedDb()
      .prepare(
        `INSERT INTO stripe_subscriptions
          (stripe_subscription_id, stripe_customer_id, billing_account_id,
           status, plan_key, interval, current_period_end, cancel_at_period_end,
           has_paid_invoice, first_failed_renewal_at, verified_at, created_at, updated_at)
         VALUES (?, ?, ?, 'incomplete', 'sync_personal', 'month', ?, 0, 0, NULL, ?, ?, ?)`,
      )
      .bind(subscriptionId, customerId, account.id, now + DAY, now, now, now)
      .run();
    const postCutoff = await getEntitlement(
      hostedDb(),
      account,
      POST_PREVIEW,
      DEFAULT_HOSTED_LIMITS,
      false,
    );
    expect(postCutoff.state).toBe('restricted');
    expect(postCutoff.reason).toBe('preview-ended');
    // The same row still grants preview before the boundary.
    const preCutoff = await getEntitlement(
      hostedDb(),
      account,
      PREVIEW_END_MS - DAY,
      DEFAULT_HOSTED_LIMITS,
      false,
    );
    expect(preCutoff.state).toBe('preview');
  });
});

describe('internal billing routes', () => {
  it('checkout refuses when disabled, when the price is absent, and without Stripe', async () => {
    const identity = makeIdentity(`gate-${crypto.randomUUID()}`);
    env.HOSTED_CHECKOUT_ENABLED = 'false';
    const disabled = await signedHostedPost('/internal/hosted/checkout', {
      ...identity,
      interval: 'month',
    });
    expect(disabled.status).toBe(403);
    expect(
      (disabled.body['error'] as { details: { reason: string } }).details.reason,
    ).toBe('checkout-disabled');

    env.HOSTED_CHECKOUT_ENABLED = 'true';
    env.STRIPE_PRICE_SYNC_MONTHLY = '';
    const noPrice = await signedHostedPost('/internal/hosted/checkout', {
      ...identity,
      interval: 'month',
    });
    expect(noPrice.status).toBe(503);

    env.STRIPE_PRICE_SYNC_MONTHLY = 'price_test_monthly';
    env.STRIPE_SECRET_KEY = '';
    const noKey = await signedHostedPost('/internal/hosted/checkout', {
      ...identity,
      interval: 'month',
    });
    expect(noKey.status).toBe(503);

    // None of the refusals touched the provider or left a checkout row
    // (the gates all run before the billing account is even resolved).
    const account = await getBillingAccountByIdentity(hostedDb(), identity);
    expect(account).toBeNull();
  });

  it('portal 404s without a customer and returns a portal URL with one', async () => {
    const identity = makeIdentity(`portal-${crypto.randomUUID()}`);
    const missing = await signedHostedPost('/internal/hosted/portal', identity);
    expect(missing.status).toBe(404);

    const account = await getOrCreateBillingAccount(hostedDb(), identity);
    const noCustomer = await signedHostedPost('/internal/hosted/portal', identity);
    expect(noCustomer.status).toBe(404);

    const customerId = `cus_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await insertStripeCustomer(account.id, customerId);
    await stubStripe('POST', '/v1/billing_portal/sessions', {
      id: 'bps_test_1',
      url: 'https://billing.stripe.test/session/bps_test_1',
    });
    const portal = await signedHostedPost('/internal/hosted/portal', identity);
    expect(portal.status).toBe(200);
    expect(portal.body['portalUrl']).toBe(
      'https://billing.stripe.test/session/bps_test_1',
    );
  });

  it('billing overview and entitlement answer the stored state', async () => {
    const identity = makeIdentity(`over-${crypto.randomUUID()}`);
    const unknown = await signedHostedPost('/internal/hosted/billing', identity);
    expect(unknown.status).toBe(404);

    await getOrCreateBillingAccount(hostedDb(), identity);
    const entitlement = await signedHostedPost('/internal/hosted/entitlement', identity);
    expect(entitlement.status).toBe(200);
    expect(entitlement.body['state']).toBe('preview');

    const overview = await signedHostedPost('/internal/hosted/billing', identity);
    expect(overview.status).toBe(200);
    expect(overview.body['lifecycle']).toBe('active');
    expect(overview.body['subscription']).toBeNull();
    expect(overview.body['pendingCheckout']).toBeNull();
    expect(overview.body['lastReconcileAt']).toBeNull();
    expect((overview.body['entitlement'] as HostedEntitlement).state).toBe('preview');
  });
});

describe('reconcile', () => {
  it('marks reconciled with zero subscriptions when no customer exists', async () => {
    const identity = makeIdentity(`rec-${crypto.randomUUID()}`);
    await getOrCreateBillingAccount(hostedDb(), identity);
    const result = await signedHostedPost('/internal/hosted/reconcile', identity);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ reconciled: true, subscriptions: 0 });
    const meta = await hostedDb()
      .prepare("SELECT value FROM billing_meta WHERE key = 'last_reconcile_at'")
      .first<{ value: string }>();
    expect(meta).not.toBeNull();
  });

  it('upserts the canonical subscription list and repairs stale rows', async () => {
    const identity = makeIdentity(`rec-${crypto.randomUUID()}`);
    const account = await getOrCreateBillingAccount(hostedDb(), identity);
    const customerId = `cus_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await insertStripeCustomer(account.id, customerId);

    // Out-of-order delivery: a stale updated lands after a newer state.
    const subId = `sub_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const newerEnd = Math.floor(Date.now() / 1000) + 60 * 86_400;
    const olderEnd = Math.floor(Date.now() / 1000) + 30 * 86_400;
    await postWebhook(
      stripeEvent(
        `evt_${crypto.randomUUID()}`,
        'customer.subscription.updated',
        stripeSubscription(customerId, { id: subId, current_period_end: newerEnd }),
      ),
    );
    await postWebhook(
      stripeEvent(
        `evt_${crypto.randomUUID()}`,
        'customer.subscription.updated',
        stripeSubscription(customerId, {
          id: subId,
          status: 'past_due',
          current_period_end: olderEnd,
        }),
      ),
    );
    let row = await subscriptionRow(subId);
    expect(row?.['status']).toBe('past_due');
    expect(row?.['current_period_end']).toBe(olderEnd * 1000);

    // Reconciliation restores provider truth.
    await stubStripe('GET', '/v1/subscriptions', {
      object: 'list',
      data: [
        stripeSubscription(customerId, { id: subId, current_period_end: newerEnd }),
      ],
      has_more: false,
    });
    const reconciled = await signedHostedPost('/internal/hosted/reconcile', identity);
    expect(reconciled.status).toBe(200);
    expect(reconciled.body).toMatchObject({ reconciled: true, subscriptions: 1 });
    row = await subscriptionRow(subId);
    expect(row?.['status']).toBe('active');
    expect(row?.['current_period_end']).toBe(newerEnd * 1000);
    expect(await auditKinds(account.id)).toContain('reconcile');
  });

  it('propagates a provider failure without marking the account reconciled', async () => {
    const identity = makeIdentity(`rec-${crypto.randomUUID()}`);
    const account = await getOrCreateBillingAccount(hostedDb(), identity);
    await insertStripeCustomer(
      account.id,
      `cus_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
    );
    const before = await hostedDb()
      .prepare("SELECT value FROM billing_meta WHERE key = 'last_reconcile_at'")
      .first<{ value: string }>();
    await stubStripe('GET', '/v1/subscriptions', { error: { message: 'boom' } }, 500);
    const result = await signedHostedPost('/internal/hosted/reconcile', identity);
    expect(result.status).toBe(503);
    expect((result.body['error'] as { code: string }).code).toBe('unavailable');
    const meta = await hostedDb()
      .prepare("SELECT value FROM billing_meta WHERE key = 'last_reconcile_at'")
      .first<{ value: string }>();
    expect(meta?.value ?? null).toBe(before?.value ?? null);
  });
});

describe('audit hygiene', () => {
  it('writes no secret or token material into billing_audit', async () => {
    const identity = makeIdentity(`audit-${crypto.randomUUID()}`);
    const account = await getOrCreateBillingAccount(hostedDb(), identity);
    const customerId = `cus_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await insertStripeCustomer(account.id, customerId);
    await postWebhook(
      stripeEvent(
        `evt_${crypto.randomUUID()}`,
        'customer.subscription.created',
        stripeSubscription(customerId),
      ),
    );
    await signedHostedPost('/internal/hosted/billing', identity);
    const { results } = await hostedDb()
      .prepare('SELECT kind, detail FROM billing_audit WHERE billing_account_id = ?')
      .bind(account.id)
      .all<{ kind: string; detail: string | null }>();
    expect((results ?? []).length).toBeGreaterThan(0);
    const blob = JSON.stringify(results ?? []);
    for (const secret of ['sk_test_fake', 'whsec_testfake', SERVICE_SECRET]) {
      expect(blob).not.toContain(secret);
    }
    expect(blob).not.toContain('Authorization');
  });
});
