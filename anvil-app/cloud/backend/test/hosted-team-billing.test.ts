import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getOrganizationTeamCapacity,
  recordInvoicePaid,
  upsertSubscriptionFromStripe,
} from '../src/hosted/billing';
import {
  handleOrganizationSeatChange,
  handleOrganizationSeatConfirm,
  handleOrganizationSeatQuote,
  handlePortal,
  handleStripeWebhook,
} from '../src/hosted/billing-routes';
import type { HostedIdentity } from '../src/hosted/identity';
import { parseStripeSubscription } from '../src/hosted/stripe';

const STRIPE_API = 'https://api.stripe.com';
const HOSTED_CLIENT_ID = 'client_hosted_test';
const TEAM_MONTHLY_PRICE = 'price_test_team_monthly';
const SEAT_QUANTITY = 5;

function hostedDb(): D1Database {
  const db = env.HOSTED_DB;
  if (db === undefined) throw new Error('HOSTED_DB binding missing in test env');
  return db;
}

function testEnv(): Env {
  return {
    ...env,
    HOSTED_BILLING_ENVIRONMENT: 'staging',
    HOSTED_CHECKOUT_ENABLED: 'true',
    HOSTED_ALLOW_EARLY_CHECKOUT: 'true',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_testfake0123456789',
    STRIPE_PRICE_TEAM_MONTHLY: TEAM_MONTHLY_PRICE,
    STRIPE_PRICE_TEAM_ANNUAL: 'price_test_team_annual',
  };
}

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function makeIdentity(userId: string): HostedIdentity {
  return { workosClientId: HOSTED_CLIENT_ID, workosUserId: userId };
}

async function queueStripe(
  method: string,
  path: string,
  body: unknown,
  status = 200,
): Promise<void> {
  const response = await fetch(`${STRIPE_API}/__stripe-stub/enqueue`, {
    method: 'POST',
    body: JSON.stringify({ method, path, body, status }),
  });
  expect(response.status).toBe(200);
}

async function pendingStripeCalls(): Promise<unknown[]> {
  const response = await fetch(`${STRIPE_API}/__stripe-stub/pending`);
  return ((await response.json()) as { pending: unknown[] }).pending;
}

async function invoke(
  handler: (body: unknown, env: Env, db: D1Database) => Promise<Response>,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(body, testEnv(), hostedDb());
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function postStripeWebhook(event: unknown): Promise<Response> {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('whsec_testfake0123456789'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return handleStripeWebhook(
    new Request('https://spike.test/v1/hosted/stripe-webhook', {
      method: 'POST',
      headers: { 'stripe-signature': `t=${timestamp},v1=${hex}` },
      body,
    }),
    testEnv(),
    hostedDb(),
  );
}

function providerSubscription(
  subscriptionId: string,
  customerId: string,
  quantity: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    id: subscriptionId,
    object: 'subscription',
    status: 'active',
    customer: customerId,
    cancel_at_period_end: false,
    schedule: null,
    items: {
      object: 'list',
      data: [
        {
          id: 'si_team_1',
          quantity,
          current_period_start: nowSeconds - 10 * 86_400,
          current_period_end: nowSeconds + 20 * 86_400,
          price: {
            id: TEAM_MONTHLY_PRICE,
            recurring: { interval: 'month', interval_count: 1 },
          },
        },
      ],
    },
    ...overrides,
  };
}

interface TeamFixture {
  accountId: string;
  organizationId: string;
  subscriptionId: string;
  customerId: string;
  identity: HostedIdentity;
}

async function createTeamFixture(userId = makeId('user')): Promise<TeamFixture> {
  const db = hostedDb();
  const now = Date.now();
  const accountId = makeId('bill');
  const organizationId = makeId('org');
  const subscriptionId = makeId('sub');
  const customerId = makeId('cus');
  const paidThrough = now + 20 * 86_400_000;
  const identity = makeIdentity(userId);
  await db.batch([
    db
      .prepare(
        `INSERT INTO billing_accounts
           (id, workos_client_id, workos_user_id, sync_account_id, generation, lifecycle,
            preview_eligible, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 1, 'active', 1, ?, ?)`,
      )
      .bind(accountId, identity.workosClientId, identity.workosUserId, now, now),
    db
      .prepare(
        `INSERT INTO hosted_organizations
           (id, idempotency_key, workos_organization_id, name, status,
            created_by_workos_user_id, created_at, updated_at)
         VALUES (?, ?, ?, 'Test team', 'active', ?, ?, ?)`,
      )
      .bind(organizationId, makeId('idem'), makeId('org_provider'), userId, now, now),
    db
      .prepare(
        `INSERT INTO hosted_organization_memberships
           (organization_id, billing_account_id, workos_client_id, workos_user_id, email,
            role, status, seat_opted_out, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'owner', 'active', 0, ?, ?)`,
      )
      .bind(
        organizationId,
        accountId,
        identity.workosClientId,
        identity.workosUserId,
        `${userId}@example.test`,
        now,
        now,
      ),
    db
      .prepare(
        `INSERT INTO stripe_organization_customers
           (stripe_customer_id, organization_id, owner_billing_account_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(customerId, organizationId, accountId, now),
    db
      .prepare(
        `INSERT INTO stripe_subscriptions
           (stripe_subscription_id, stripe_customer_id, billing_account_id, organization_id,
            stripe_subscription_item_id, stripe_subscription_schedule_id, seat_quantity,
            paid_seat_quantity, status, plan_key, interval, current_period_end, paid_through,
            cancel_at_period_end, has_paid_invoice, first_failed_renewal_at, verified_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, 'si_team_1', NULL, ?, ?, 'active', 'sync_team', 'month', ?, ?,
                 0, 1, NULL, ?, ?, ?)`,
      )
      .bind(
        subscriptionId,
        customerId,
        accountId,
        organizationId,
        SEAT_QUANTITY,
        SEAT_QUANTITY,
        paidThrough,
        paidThrough,
        now,
        now,
        now,
      ),
    db
      .prepare(
        `INSERT INTO organization_billing_state
           (organization_id, preview_seat_capacity, effective_seat_capacity, created_at, updated_at)
         VALUES (?, 5, 5, ?, ?)`,
      )
      .bind(organizationId, now, now),
  ]);
  return { accountId, organizationId, subscriptionId, customerId, identity };
}

beforeEach(async () => {
  await fetch(`${STRIPE_API}/__stripe-stub/reset`, { method: 'POST' });
});

afterEach(async () => {
  expect(await pendingStripeCalls()).toEqual([]);
});

describe('hosted team seat billing', () => {
  it('requires a current quote and paid invoice before increasing seat capacity', async () => {
    const fixture = await createTeamFixture();
    const provider = providerSubscription(
      fixture.subscriptionId,
      fixture.customerId,
      SEAT_QUANTITY,
    );
    const parsed = parseStripeSubscription(provider);
    expect(parsed).not.toBeNull();

    await queueStripe('GET', `/v1/subscriptions/${fixture.subscriptionId}`, provider);
    await queueStripe('POST', '/v1/invoices/create_preview', {
      amount_due: 1400,
      currency: 'gbp',
      total_taxes: [{ amount: 200 }],
    });
    const quoted = await invoke(handleOrganizationSeatQuote, {
      ...fixture.identity,
      organizationId: fixture.organizationId,
      seats: 7,
    });
    expect(quoted.status).toBe(200);
    const quote = quoted.body as unknown as {
      quoteId: string;
      amountDue: number;
      currency: string;
      taxAmount: number;
      prorationDate: number;
      expiresAt: number;
    };
    expect(quote.amountDue).toBe(1400);
    expect(quote.currency).toBe('gbp');
    expect(quote.taxAmount).toBe(200);
    expect(quote.prorationDate).toBeLessThan(1_000_000_000_000);
    expect(quote.expiresAt).toBeGreaterThan(Date.now());
    expect(await getOrganizationTeamCapacity(hostedDb(), fixture.organizationId, Date.now())).toBe(
      5,
    );

    await queueStripe('GET', `/v1/subscriptions/${fixture.subscriptionId}`, provider);
    await queueStripe('POST', '/v1/invoices/create_preview', {
      amount_due: 1400,
      currency: 'gbp',
      total_taxes: [{ amount: 200 }],
    });
    await queueStripe(
      'POST',
      `/v1/subscriptions/${fixture.subscriptionId}`,
      providerSubscription(fixture.subscriptionId, fixture.customerId, 7, {
        latest_invoice: { id: 'in_paid_upgrade', status: 'paid' },
      }),
    );
    const confirmed = await invoke(handleOrganizationSeatConfirm, {
      ...fixture.identity,
      organizationId: fixture.organizationId,
      quoteId: quote.quoteId,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toEqual({
      seatCapacity: 7,
      scheduledSeatCapacity: null,
      effectiveAt: null,
    });
    const subscription = await hostedDb()
      .prepare(
        `SELECT seat_quantity, paid_seat_quantity, paid_through
         FROM stripe_subscriptions WHERE stripe_subscription_id = ?`,
      )
      .bind(fixture.subscriptionId)
      .first<{ seat_quantity: number; paid_seat_quantity: number; paid_through: number }>();
    expect(subscription).toEqual({
      seat_quantity: 7,
      paid_seat_quantity: 7,
      paid_through: expect.any(Number),
    });
  });

  it('does not grant capacity from a subscription update before invoice.paid', async () => {
    const fixture = await createTeamFixture();
    const updatedProvider = providerSubscription(fixture.subscriptionId, fixture.customerId, 8);
    const updated = parseStripeSubscription(updatedProvider);
    expect(updated).not.toBeNull();
    await upsertSubscriptionFromStripe(
      hostedDb(),
      fixture.accountId,
      updated!,
      Date.now(),
      testEnv(),
      fixture.organizationId,
    );
    expect(await getOrganizationTeamCapacity(hostedDb(), fixture.organizationId, Date.now())).toBe(
      5,
    );
    const beforePayment = await hostedDb()
      .prepare(
        `SELECT seat_quantity, paid_seat_quantity FROM stripe_subscriptions
         WHERE stripe_subscription_id = ?`,
      )
      .bind(fixture.subscriptionId)
      .first<{ seat_quantity: number; paid_seat_quantity: number }>();
    expect(beforePayment).toEqual({ seat_quantity: 8, paid_seat_quantity: 5 });

    await recordInvoicePaid(hostedDb(), fixture.subscriptionId, Date.now());
    expect(await getOrganizationTeamCapacity(hostedDb(), fixture.organizationId, Date.now())).toBe(
      8,
    );
  });

  it('ignores an old paid invoice when Stripe has a newer unpaid invoice', async () => {
    const fixture = await createTeamFixture();
    const now = Date.now();
    const initialSubscription = await hostedDb()
      .prepare('SELECT paid_through FROM stripe_subscriptions WHERE stripe_subscription_id = ?')
      .bind(fixture.subscriptionId)
      .first<{ paid_through: number }>();
    const oldPaidThrough = initialSubscription?.paid_through;
    const provider = providerSubscription(fixture.subscriptionId, fixture.customerId, 8, {
      items: {
        object: 'list',
        data: [
          {
            id: 'si_team_1',
            quantity: 8,
            current_period_start: Math.floor(now / 1000),
            current_period_end: Math.floor((now + 50 * 86_400_000) / 1000),
            price: {
              id: TEAM_MONTHLY_PRICE,
              recurring: { interval: 'month', interval_count: 1 },
            },
          },
        ],
      },
      latest_invoice: { id: 'in_new_unpaid', status: 'open' },
    });
    const parsed = parseStripeSubscription(provider);
    expect(parsed).not.toBeNull();
    await upsertSubscriptionFromStripe(
      hostedDb(),
      fixture.accountId,
      parsed!,
      now,
      testEnv(),
      fixture.organizationId,
    );
    await queueStripe('GET', `/v1/subscriptions/${fixture.subscriptionId}`, provider);
    const response = await postStripeWebhook({
      id: makeId('evt'),
      object: 'event',
      type: 'invoice.paid',
      livemode: false,
      data: {
        object: {
          id: 'in_old_paid',
          object: 'invoice',
          status: 'paid',
          customer: fixture.customerId,
          billing_reason: 'subscription_cycle',
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: fixture.subscriptionId },
          },
        },
      },
    });
    expect(response.status).toBe(200);
    const row = await hostedDb()
      .prepare(
        `SELECT seat_quantity, paid_seat_quantity, paid_through
         FROM stripe_subscriptions WHERE stripe_subscription_id = ?`,
      )
      .bind(fixture.subscriptionId)
      .first<{ seat_quantity: number; paid_seat_quantity: number; paid_through: number }>();
    expect(row).toEqual({
      seat_quantity: 8,
      paid_seat_quantity: 5,
      paid_through: oldPaidThrough,
    });
    expect(await getOrganizationTeamCapacity(hostedDb(), fixture.organizationId, now)).toBe(5);
  });

  it('requires renewed confirmation when Stripe preview changes before confirmation', async () => {
    const fixture = await createTeamFixture();
    const provider = providerSubscription(
      fixture.subscriptionId,
      fixture.customerId,
      SEAT_QUANTITY,
    );
    await queueStripe('GET', `/v1/subscriptions/${fixture.subscriptionId}`, provider);
    await queueStripe('POST', '/v1/invoices/create_preview', {
      amount_due: 1400,
      currency: 'gbp',
      total_taxes: [{ amount: 200 }],
    });
    const quoted = await invoke(handleOrganizationSeatQuote, {
      ...fixture.identity,
      organizationId: fixture.organizationId,
      seats: 7,
    });
    const originalQuoteId = quoted.body['quoteId'] as string;

    await queueStripe('GET', `/v1/subscriptions/${fixture.subscriptionId}`, provider);
    await queueStripe('POST', '/v1/invoices/create_preview', {
      amount_due: 1500,
      currency: 'gbp',
      total_taxes: [{ amount: 200 }],
    });
    await queueStripe('POST', '/v1/invoices/create_preview', {
      amount_due: 1500,
      currency: 'gbp',
      total_taxes: [{ amount: 200 }],
    });
    const result = await invoke(handleOrganizationSeatConfirm, {
      ...fixture.identity,
      organizationId: fixture.organizationId,
      quoteId: originalQuoteId,
    });
    expect(result.status).toBe(409);
    const error = result.body['error'] as Record<string, unknown>;
    const details = error['details'] as Record<string, unknown>;
    expect(details['reason']).toBe('seat-quote-changed');
    expect((details['quote'] as Record<string, unknown>)['quoteId']).not.toBe(originalQuoteId);
    const subscription = await hostedDb()
      .prepare(
        'SELECT paid_seat_quantity FROM stripe_subscriptions WHERE stripe_subscription_id = ?',
      )
      .bind(fixture.subscriptionId)
      .first<{ paid_seat_quantity: number }>();
    expect(subscription?.paid_seat_quantity).toBe(5);
  });

  it('does not grant a seat increase when Stripe rejects the immediate invoice', async () => {
    const fixture = await createTeamFixture();
    const provider = providerSubscription(
      fixture.subscriptionId,
      fixture.customerId,
      SEAT_QUANTITY,
    );
    await queueStripe('GET', `/v1/subscriptions/${fixture.subscriptionId}`, provider);
    await queueStripe('POST', '/v1/invoices/create_preview', {
      amount_due: 1400,
      currency: 'gbp',
      total_taxes: [{ amount: 200 }],
    });
    const quoted = await invoke(handleOrganizationSeatQuote, {
      ...fixture.identity,
      organizationId: fixture.organizationId,
      seats: 7,
    });

    await queueStripe('GET', `/v1/subscriptions/${fixture.subscriptionId}`, provider);
    await queueStripe('POST', '/v1/invoices/create_preview', {
      amount_due: 1400,
      currency: 'gbp',
      total_taxes: [{ amount: 200 }],
    });
    await queueStripe(
      'POST',
      `/v1/subscriptions/${fixture.subscriptionId}`,
      { error: { message: 'payment method declined' } },
      402,
    );
    const result = await invoke(handleOrganizationSeatConfirm, {
      ...fixture.identity,
      organizationId: fixture.organizationId,
      quoteId: quoted.body['quoteId'],
    });
    expect(result.status).toBe(409);
    expect((result.body['error'] as Record<string, unknown>)['details']).toEqual({
      reason: 'payment-not-confirmed',
    });
    expect(await getOrganizationTeamCapacity(hostedDb(), fixture.organizationId, Date.now())).toBe(
      5,
    );
  });

  it('allows only one concurrent confirmation of the same quote', async () => {
    const fixture = await createTeamFixture();
    const provider = providerSubscription(
      fixture.subscriptionId,
      fixture.customerId,
      SEAT_QUANTITY,
    );
    await queueStripe('GET', `/v1/subscriptions/${fixture.subscriptionId}`, provider);
    await queueStripe('POST', '/v1/invoices/create_preview', {
      amount_due: 1400,
      currency: 'gbp',
      total_taxes: [{ amount: 200 }],
    });
    const quoted = await invoke(handleOrganizationSeatQuote, {
      ...fixture.identity,
      organizationId: fixture.organizationId,
      seats: 7,
    });
    const quoteId = quoted.body['quoteId'] as string;

    await queueStripe('GET', `/v1/subscriptions/${fixture.subscriptionId}`, provider);
    await queueStripe('POST', '/v1/invoices/create_preview', {
      amount_due: 1400,
      currency: 'gbp',
      total_taxes: [{ amount: 200 }],
    });
    await queueStripe(
      'POST',
      `/v1/subscriptions/${fixture.subscriptionId}`,
      providerSubscription(fixture.subscriptionId, fixture.customerId, 7, {
        latest_invoice: { id: 'in_paid_concurrent', status: 'paid' },
      }),
    );
    const body = { ...fixture.identity, organizationId: fixture.organizationId, quoteId };
    const results = await Promise.all([
      invoke(handleOrganizationSeatConfirm, body),
      invoke(handleOrganizationSeatConfirm, body),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await getOrganizationTeamCapacity(hostedDb(), fixture.organizationId, Date.now())).toBe(
      7,
    );
  });

  it('preserves a scheduled capacity clamp until Stripe confirms its reduced quantity', async () => {
    const fixture = await createTeamFixture();
    const now = Date.now();
    const periodEnd = now + 20 * 86_400_000;
    await hostedDb().batch([
      hostedDb()
        .prepare(
          `UPDATE stripe_subscriptions
           SET seat_quantity = 10, paid_seat_quantity = 10, current_period_end = ?,
               paid_through = ?, status = 'past_due'
           WHERE stripe_subscription_id = ?`,
        )
        .bind(periodEnd, now - 1, fixture.subscriptionId),
      hostedDb()
        .prepare(
          `UPDATE organization_billing_state
           SET scheduled_seat_capacity = 5, scheduled_effective_at = ?
           WHERE organization_id = ?`,
        )
        .bind(now - 1, fixture.organizationId),
    ]);

    // A later provider period or old-quantity invoice must not remove the
    // conservative scheduled limit after the old paid period has lapsed.
    await getOrganizationTeamCapacity(hostedDb(), fixture.organizationId, now);
    await hostedDb()
      .prepare("UPDATE stripe_subscriptions SET status = 'active' WHERE stripe_subscription_id = ?")
      .bind(fixture.subscriptionId)
      .run();
    await recordInvoicePaid(hostedDb(), fixture.subscriptionId, now);
    let state = await hostedDb()
      .prepare(
        `SELECT scheduled_seat_capacity, effective_seat_capacity
         FROM organization_billing_state WHERE organization_id = ?`,
      )
      .bind(fixture.organizationId)
      .first<{ scheduled_seat_capacity: number | null; effective_seat_capacity: number }>();
    expect(state).toEqual({ scheduled_seat_capacity: 5, effective_seat_capacity: 5 });

    // Only the provider-confirmed paid renewal at the scheduled quantity
    // clears the clamp.
    await hostedDb()
      .prepare(
        `UPDATE stripe_subscriptions SET seat_quantity = 5, current_period_end = ?,
           paid_through = ? WHERE stripe_subscription_id = ?`,
      )
      .bind(periodEnd + 30 * 86_400_000, now - 1, fixture.subscriptionId)
      .run();
    await recordInvoicePaid(hostedDb(), fixture.subscriptionId, now + 1);
    state = await hostedDb()
      .prepare(
        `SELECT scheduled_seat_capacity, effective_seat_capacity
         FROM organization_billing_state WHERE organization_id = ?`,
      )
      .bind(fixture.organizationId)
      .first<{ scheduled_seat_capacity: number | null; effective_seat_capacity: number }>();
    expect(state).toEqual({ scheduled_seat_capacity: null, effective_seat_capacity: 5 });
  });

  it('serializes concurrent quote requests for one organization', async () => {
    const fixture = await createTeamFixture();
    const provider = providerSubscription(
      fixture.subscriptionId,
      fixture.customerId,
      SEAT_QUANTITY,
    );
    await queueStripe('GET', `/v1/subscriptions/${fixture.subscriptionId}`, provider);
    await queueStripe('POST', '/v1/invoices/create_preview', {
      amount_due: 1400,
      currency: 'gbp',
      total_taxes: [{ amount: 200 }],
    });
    const requestBody = {
      ...fixture.identity,
      organizationId: fixture.organizationId,
      seats: 7,
    };
    const results = await Promise.all([
      invoke(handleOrganizationSeatQuote, requestBody),
      invoke(handleOrganizationSeatQuote, requestBody),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const pendingQuotes = await hostedDb()
      .prepare(
        `SELECT COUNT(*) AS count FROM team_seat_change_quotes
         WHERE organization_id = ? AND status = 'pending'`,
      )
      .bind(fixture.organizationId)
      .first<{ count: number }>();
    expect(pendingQuotes?.count).toBe(1);
  });

  it('rejects a direct increase without charging and requires explicit quote confirmation', async () => {
    const fixture = await createTeamFixture();
    const provider = providerSubscription(
      fixture.subscriptionId,
      fixture.customerId,
      SEAT_QUANTITY,
    );
    await queueStripe('GET', `/v1/subscriptions/${fixture.subscriptionId}`, provider);
    const result = await invoke(handleOrganizationSeatChange, {
      ...fixture.identity,
      organizationId: fixture.organizationId,
      seats: 7,
    });
    expect(result.status).toBe(409);
    expect((result.body['error'] as Record<string, unknown>)['details']).toEqual({
      reason: 'seat-quote-required',
    });
    expect(await getOrganizationTeamCapacity(hostedDb(), fixture.organizationId, Date.now())).toBe(
      5,
    );
  });

  it('lets a retained owner open billing portal for a closed organization', async () => {
    const fixture = await createTeamFixture();
    await hostedDb()
      .prepare("UPDATE hosted_organizations SET status = 'closed' WHERE id = ?")
      .bind(fixture.organizationId)
      .run();
    await queueStripe('POST', '/v1/billing_portal/sessions', {
      id: 'bps_recovery',
      url: 'https://billing.stripe.test/portal/recovery',
    });
    const result = await invoke(handlePortal, {
      ...fixture.identity,
      organizationId: fixture.organizationId,
    });
    expect(result.status).toBe(200);
    expect(result.body['portalUrl']).toBe('https://billing.stripe.test/portal/recovery');
  });

  it('denies portal access to a removed former billing owner', async () => {
    const fixture = await createTeamFixture();
    await hostedDb()
      .prepare(
        `UPDATE hosted_organization_memberships SET status = 'inactive'
         WHERE organization_id = ? AND workos_user_id = ?`,
      )
      .bind(fixture.organizationId, fixture.identity.workosUserId)
      .run();
    const result = await invoke(handlePortal, {
      ...fixture.identity,
      organizationId: fixture.organizationId,
    });
    expect(result.status).toBe(403);
    expect((result.body['error'] as Record<string, unknown>)['details']).toEqual({
      reason: 'organization-owner-required',
    });
  });
});
