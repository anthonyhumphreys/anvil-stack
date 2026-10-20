import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getBillingMeta,
  insertWebhookEvent,
  reconcileMetaKey,
  setBillingMeta,
  upsertStripeCustomer,
  upsertStripeOrganizationCustomer,
  upsertSubscriptionFromStripe,
} from '../src/hosted/billing';
import type { HostedIdentity } from '../src/hosted/identity';
import { runHostedReconcile } from '../src/hosted/reconciler';
import { getOrCreateBillingAccount, markBillingLifecycle } from '../src/hosted/store';
import { organizationReconcileMetaKey } from '../src/hosted/subscription-reconcile';
import { parseStripeSubscription } from '../src/hosted/stripe';

const STRIPE_API = 'https://api.stripe.com';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function hostedDb(): D1Database {
  const db = env.HOSTED_DB;
  if (db === undefined) throw new Error('HOSTED_DB binding missing in test env');
  return db;
}

let logSpy: ReturnType<typeof vi.spyOn>;

function metricsEmitted(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const call of logSpy.mock.calls) {
    try {
      const parsed = JSON.parse(String(call[0])) as Record<string, unknown>;
      if (typeof parsed['metric'] === 'string') out.push(parsed);
    } catch {
      // Non-metric log line.
    }
  }
  return out;
}

function metric(name: string): Record<string, unknown> | undefined {
  return metricsEmitted().find((entry) => entry['metric'] === name);
}

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

async function stripePendingCount(): Promise<number> {
  const pending = (await (await fetch(`${STRIPE_API}/__stripe-stub/pending`)).json()) as {
    pending: unknown[];
  };
  return pending.pending.length;
}

function makeIdentity(tag: string): HostedIdentity {
  return { workosClientId: 'client_hosted_test', workosUserId: `user_${tag}` };
}

function stripeSubscription(customer: string): Record<string, unknown> {
  return {
    id: `sub_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
    object: 'subscription',
    status: 'active',
    customer,
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
    cancel_at_period_end: false,
    items: {
      object: 'list',
      data: [
        {
          id: 'si_test_personal',
          quantity: 1,
          current_period_start: Math.floor(Date.now() / 1000) - 86400,
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
          price: { id: 'price_test_monthly', recurring: { interval: 'month' } },
        },
      ],
    },
  };
}

beforeEach(async () => {
  // The Worker test pool retains D1 state between tests. Retire prior
  // fixtures so queued provider responses belong only to this case.
  await hostedDb().batch([
    hostedDb().prepare("UPDATE billing_accounts SET lifecycle = 'deleted'"),
    hostedDb().prepare("UPDATE hosted_organizations SET status = 'closed'"),
  ]);
  await fetch(`${STRIPE_API}/__stripe-stub/reset`, { method: 'POST' });
  logSpy = vi.spyOn(console, 'log');
});

afterEach(async () => {
  logSpy.mockRestore();
  (env as unknown as Record<string, string>)['STRIPE_SECRET_KEY'] = 'sk_test_fake';
  expect(await stripePendingCount()).toBe(0);
});

describe('runHostedReconcile', () => {
  it('reconciles a stale account, upserts subscriptions, and stamps markers', async () => {
    const account = await getOrCreateBillingAccount(hostedDb(), makeIdentity('stale'));
    await upsertStripeCustomer(hostedDb(), account.id, 'cus_stale');
    const subscription = stripeSubscription('cus_stale');
    await stubStripe('GET', '/v1/subscriptions', { object: 'list', data: [subscription] });

    await runHostedReconcile(env);

    const row = await hostedDb()
      .prepare('SELECT status, plan_key FROM stripe_subscriptions WHERE billing_account_id = ?')
      .bind(account.id)
      .first<{ status: string; plan_key: string }>();
    expect(row?.status).toBe('active');
    expect(row?.plan_key).toBe('sync_personal');
    expect(await getBillingMeta(hostedDb(), reconcileMetaKey(account.id))).not.toBeNull();
    expect(await getBillingMeta(hostedDb(), 'last_reconcile_at')).not.toBeNull();
    const run = metric('reconcile.run');
    expect(run?.['attempted']).toBe(1);
    expect(run?.['reconciled']).toBe(1);
    expect(run?.['failed']).toBe(0);
  });

  it('leaves fresh accounts alone — no provider call', async () => {
    const account = await getOrCreateBillingAccount(hostedDb(), makeIdentity('fresh'));
    await upsertStripeCustomer(hostedDb(), account.id, 'cus_fresh');
    await setBillingMeta(hostedDb(), reconcileMetaKey(account.id), String(Date.now()));

    await runHostedReconcile(env);

    const run = metric('reconcile.run');
    expect(run?.['attempted']).toBe(0);
    expect(run?.['reconciled']).toBe(0);
  });

  it('re-reconciles an account whose marker is older than the stale window', async () => {
    const account = await getOrCreateBillingAccount(hostedDb(), makeIdentity('old'));
    await upsertStripeCustomer(hostedDb(), account.id, 'cus_old');
    await setBillingMeta(hostedDb(), reconcileMetaKey(account.id), String(Date.now() - 13 * HOUR));
    await stubStripe('GET', '/v1/subscriptions', { object: 'list', data: [] });

    await runHostedReconcile(env);

    const run = metric('reconcile.run');
    expect(run?.['attempted']).toBe(1);
    expect(run?.['reconciled']).toBe(1);
  });

  it('reaches accounts beyond the candidate window over successive runs', async () => {
    const db = hostedDb();
    const accountIds: string[] = [];
    // One past the candidate limit: created_at ordering would re-examine
    // the same oldest 50 every run and starve the 51st account forever.
    for (let i = 0; i < 51; i += 1) {
      const account = await getOrCreateBillingAccount(db, makeIdentity(`starve-${i}`));
      await upsertStripeCustomer(db, account.id, `cus_starve_${i}`);
      accountIds.push(account.id);
    }
    // Every account lacks a marker → all stale. Stalest-first ordering
    // walks the whole set at RECONCILE_BATCH_LIMIT per run.
    for (let i = 0; i < 51; i += 1) {
      await stubStripe('GET', '/v1/subscriptions', { object: 'list', data: [] });
    }
    for (let run = 0; run < 6; run += 1) {
      await runHostedReconcile(env);
    }
    for (const id of accountIds) {
      expect(await getBillingMeta(db, reconcileMetaKey(id))).not.toBeNull();
    }
  });

  it('emits reconcile.failure and leaves the marker unset when Stripe errors', async () => {
    const account = await getOrCreateBillingAccount(hostedDb(), makeIdentity('fail'));
    await upsertStripeCustomer(hostedDb(), account.id, 'cus_fail');
    await stubStripe('GET', '/v1/subscriptions', { error: { message: 'boom' } }, 500);

    await runHostedReconcile(env);

    expect(metric('reconcile.failure')).toBeDefined();
    const run = metric('reconcile.run');
    expect(run?.['failed']).toBe(1);
    expect(await getBillingMeta(hostedDb(), reconcileMetaKey(account.id))).toBeNull();
  });

  it('skips reconciliation but still emits the sweep when Stripe is unconfigured', async () => {
    (env as unknown as Record<string, string>)['STRIPE_SECRET_KEY'] = '';

    await runHostedReconcile(env);

    expect(metric('reconcile.skipped')).toBeDefined();
    expect(metric('webhook.backlog')).toBeDefined();
    expect(metric('webhook.failed')).toBeDefined();
    expect(metric('checkout.stale')).toBeDefined();
    expect(metric('reconcile.freshness')).toBeDefined();
  });

  it('reports the oldest unprocessed webhook age in the sweep', async () => {
    await insertWebhookEvent(hostedDb(), 'evt_old', 'invoice.paid', Date.now() - 2 * HOUR);
    await insertWebhookEvent(hostedDb(), 'evt_new', 'invoice.paid', Date.now() - HOUR / 2);

    await runHostedReconcile(env);

    const backlog = metric('webhook.backlog');
    expect(typeof backlog?.['oldestUnprocessedAgeMs']).toBe('number');
    expect(backlog?.['oldestUnprocessedAgeMs'] as number).toBeGreaterThanOrEqual(2 * HOUR);
  });

  it('counts stale open checkouts older than 24h', async () => {
    const account = await getOrCreateBillingAccount(hostedDb(), makeIdentity('checkout'));
    await hostedDb()
      .prepare(
        `INSERT INTO checkout_sessions
           (stripe_session_id, billing_account_id, plan_key, interval, status, created_at)
         VALUES (?, ?, 'sync_personal', 'month', 'open', ?)`,
      )
      .bind('cs_stale', account.id, Date.now() - 2 * DAY)
      .run();

    await runHostedReconcile(env);

    expect(metric('checkout.stale')?.['count']).toBe(1);
  });
  it('paginates subscriptions and repairs a missed paid invoice', async () => {
    const account = await getOrCreateBillingAccount(hostedDb(), makeIdentity('paged'));
    await upsertStripeCustomer(hostedDb(), account.id, 'cus_paged');
    const first: Record<string, unknown> = {
      ...stripeSubscription('cus_paged'),
      latest_invoice: 'in_repaired',
    };
    const second = stripeSubscription('cus_paged');
    await stubStripe('GET', '/v1/subscriptions', { object: 'list', data: [first], has_more: true });
    await stubStripe('GET', '/v1/invoices/in_repaired', {
      id: 'in_repaired',
      customer: 'cus_paged',
      status: 'paid',
      billing_reason: 'subscription_cycle',
      parent: { subscription_details: { subscription: first.id } },
    });
    await stubStripe('GET', '/v1/subscriptions', {
      object: 'list',
      data: [second],
      has_more: false,
    });
    await runHostedReconcile(env);
    const row = await hostedDb()
      .prepare(
        'SELECT has_paid_invoice, paid_through, paid_seat_quantity FROM stripe_subscriptions WHERE stripe_subscription_id = ?',
      )
      .bind(first.id)
      .first<{ has_paid_invoice: number; paid_through: number; paid_seat_quantity: number }>();
    expect(row?.has_paid_invoice).toBe(1);
    expect(row?.paid_seat_quantity).toBe(1);
    expect(row?.paid_through).toBeGreaterThan(Date.now());
    expect(metric('reconcile.run')?.['reconciled']).toBe(1);
    expect(await getBillingMeta(hostedDb(), reconcileMetaKey(account.id))).not.toBeNull();
  });

  it.each(['active', 'closed'] as const)(
    'reconciles %s team billing independently of a deleted original payer',
    async (organizationStatus) => {
      const db = hostedDb();
      const creator = await getOrCreateBillingAccount(
        db,
        makeIdentity(`old-payer-${organizationStatus}`),
      );
      const orgId = `anvil_org_reconcile_${organizationStatus}`;
      const customerId = `cus_org_reconcile_${organizationStatus}`;
      await db
        .prepare(
          `INSERT INTO hosted_organizations
      (id, idempotency_key, name, status, created_by_workos_user_id, created_at, updated_at)
      VALUES (?, ?, 'Team', 'active', ?, ?, ?)`,
        )
        .bind(
          orgId,
          `reconcile-org-fixture-${organizationStatus}`,
          creator.workos_user_id,
          Date.now(),
          Date.now(),
        )
        .run();
      await upsertStripeOrganizationCustomer(db, orgId, creator.id, customerId);
      await markBillingLifecycle(db, creator.id, 'deleted');
      const sub = stripeSubscription(customerId);
      sub.items = {
        data: [
          {
            id: 'si_team',
            quantity: 5,
            current_period_start: Math.floor(Date.now() / 1000) - 86400,
            current_period_end: Math.floor(Date.now() / 1000) + 86400,
            price: { id: 'price_test_team_monthly', recurring: { interval: 'month' } },
          },
        ],
      };
      if (organizationStatus === 'closed') {
        await upsertSubscriptionFromStripe(
          db,
          creator.id,
          parseStripeSubscription(sub)!,
          Date.now(),
          env,
          orgId,
        );
        await db
          .prepare("UPDATE hosted_organizations SET status = 'closed' WHERE id = ?")
          .bind(orgId)
          .run();
      }
      await stubStripe('GET', '/v1/subscriptions', {
        object: 'list',
        data: [sub],
        has_more: false,
      });
      await runHostedReconcile(env);
      const stored = await db
        .prepare(
          'SELECT organization_id, plan_key FROM stripe_subscriptions WHERE stripe_subscription_id = ?',
        )
        .bind(sub.id)
        .first<{ organization_id: string; plan_key: string }>();
      expect(stored).toMatchObject({ organization_id: orgId, plan_key: 'sync_team' });
      expect(await getBillingMeta(db, organizationReconcileMetaKey(orgId))).not.toBeNull();
      expect(await getBillingMeta(db, reconcileMetaKey(creator.id))).toBeNull();
    },
  );

  it('keeps existing subscriptions on partial failure and cancels absent mirrors only after a complete snapshot', async () => {
    const db = hostedDb();
    const account = await getOrCreateBillingAccount(db, makeIdentity('partial'));
    await upsertStripeCustomer(db, account.id, 'cus_partial');
    const old = parseStripeSubscription(stripeSubscription('cus_partial'))!;
    await upsertSubscriptionFromStripe(db, account.id, old, Date.now(), env);
    const other = stripeSubscription('cus_partial');
    await stubStripe('GET', '/v1/subscriptions', { object: 'list', data: [other], has_more: true });
    await stubStripe('GET', '/v1/subscriptions', { error: { message: 'temporary outage' } }, 503);
    await runHostedReconcile(env);
    const status = () =>
      db
        .prepare('SELECT status FROM stripe_subscriptions WHERE stripe_subscription_id = ?')
        .bind(old.id)
        .first<{ status: string }>();
    expect((await status())?.status).toBe('active');
    expect(await getBillingMeta(db, reconcileMetaKey(account.id))).toBeNull();
    await stubStripe('GET', '/v1/subscriptions', { object: 'list', data: [], has_more: false });
    await runHostedReconcile(env);
    expect((await status())?.status).toBe('canceled');
    expect(await getBillingMeta(db, reconcileMetaKey(account.id))).not.toBeNull();
  });
});
