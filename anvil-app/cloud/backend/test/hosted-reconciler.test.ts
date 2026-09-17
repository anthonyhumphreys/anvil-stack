import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getBillingMeta,
  insertWebhookEvent,
  reconcileMetaKey,
  setBillingMeta,
  upsertStripeCustomer,
} from '../src/hosted/billing';
import type { HostedIdentity } from '../src/hosted/identity';
import { runHostedReconcile } from '../src/hosted/reconciler';
import { getOrCreateBillingAccount } from '../src/hosted/store';

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
  const pending = (await (
    await fetch(`${STRIPE_API}/__stripe-stub/pending`)
  ).json()) as { pending: unknown[] };
  return pending.pending.length;
}

function makeIdentity(tag: string): HostedIdentity {
  return { workosClientId: `client_${tag}`, workosUserId: `user_${tag}` };
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
      data: [{ price: { id: 'price_test_monthly', recurring: { interval: 'month' } } }],
    },
  };
}

beforeEach(async () => {
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
    await setBillingMeta(
      hostedDb(),
      reconcileMetaKey(account.id),
      String(Date.now() - 13 * HOUR),
    );
    await stubStripe('GET', '/v1/subscriptions', { object: 'list', data: [] });

    await runHostedReconcile(env);

    const run = metric('reconcile.run');
    expect(run?.['attempted']).toBe(1);
    expect(run?.['reconciled']).toBe(1);
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
});
