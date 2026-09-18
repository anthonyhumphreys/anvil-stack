// BILL-06 scheduled reconciliation + aggregate metric sweep, driven by
// the hosted deployment's cron trigger (wrangler.hosted.jsonc). Self-host
// workers have no HOSTED_DB and return immediately.
//
// Two jobs per run:
// 1. Reconcile — pull canonical subscription state from Stripe for
//    billing accounts whose reconcile marker is stale, repairing lost or
//    reordered webhooks. Batched: at most RECONCILE_CANDIDATE_LIMIT
//    accounts considered, at most RECONCILE_BATCH_LIMIT provider calls.
// 2. Sweep — emit the aggregate signals from metrics.md that only exist
//    inside D1 (webhook backlog age, failed events, stale checkouts,
//    reconcile freshness), so log-based alerting has data to alert on.
//
// The freshness marker is a billing_meta entry (`reconcile_at:{id}`),
// shared with the manual /internal/hosted/reconcile path — a website
// "Refresh billing" click counts as a reconcile for staleness purposes.

import {
  audit,
  reconcileMetaKey,
  setBillingMeta,
  upsertSubscriptionFromStripe,
} from './billing';
import { stripeConfigured } from './billing-routes';
import { hostedConfigIssues } from './enforcement';
import { emitMetric } from './metrics';
import { parseStripeSubscription, stripeRequest, type StripeList } from './stripe';

const LAST_RECONCILE_KEY = 'last_reconcile_at';
const RECONCILE_KEY_PREFIX = 'reconcile_at:';
/** An account whose marker is older than this is due for a Stripe pull. */
export const RECONCILE_STALE_MS = 12 * 3_600_000;
/** Provider calls per cron run — bounds Stripe load and subrequest cost. */
export const RECONCILE_BATCH_LIMIT = 10;
/** Accounts examined for staleness per run. */
export const RECONCILE_CANDIDATE_LIMIT = 50;
const STALE_CHECKOUT_MS = 24 * 3_600_000;
const ONE_HOUR_MS = 3_600_000;

interface CandidateRow {
  billing_account_id: string;
  stripe_customer_id: string;
}

async function loadReconcileMarkers(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT key, value FROM billing_meta WHERE key LIKE '${RECONCILE_KEY_PREFIX}%'`,
    )
    .all<{ key: string; value: string }>();
  const markers = new Map<string, number>();
  for (const row of results ?? []) {
    const ts = Number(row.value);
    if (Number.isFinite(ts)) markers.set(row.key, ts);
  }
  return markers;
}

async function reconcileAccount(
  db: D1Database,
  env: Env,
  candidate: CandidateRow,
  now: number,
): Promise<void> {
  const list = await stripeRequest<StripeList<unknown>>(env, '/v1/subscriptions', {
    method: 'GET',
    params: { customer: candidate.stripe_customer_id, status: 'all', limit: 25 },
  });
  let count = 0;
  for (const item of list.data ?? []) {
    const sub = parseStripeSubscription(item);
    if (sub === null) {
      throw new Error('subscription list item failed validation');
    }
    await upsertSubscriptionFromStripe(db, candidate.billing_account_id, sub, now);
    count += 1;
  }
  await setBillingMeta(db, reconcileMetaKey(candidate.billing_account_id), String(now));
  await audit(db, candidate.billing_account_id, 'reconcile', {
    subscriptions: count,
    scheduled: true,
  });
}

/**
 * Emits the D1-resident aggregate signals from metrics.md. Each query is
 * independent — a failure reports itself and does not suppress the rest.
 */
async function emitAggregateMetrics(db: D1Database, now: number): Promise<void> {
  try {
    const row = await db
      .prepare(
        "SELECT MIN(created_at) AS oldest FROM webhook_events WHERE status != 'processed'",
      )
      .first<{ oldest: number | null }>();
    emitMetric('webhook.backlog', {
      oldestUnprocessedAgeMs: row?.oldest === null || row?.oldest === undefined ? 0 : now - row.oldest,
    });
  } catch {
    emitMetric('sweep.error', { signal: 'webhook.backlog' });
  }
  try {
    const row = await db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS recent
         FROM webhook_events WHERE status = 'failed'`,
      )
      .bind(now - ONE_HOUR_MS)
      .first<{ total: number; recent: number | null }>();
    emitMetric('webhook.failed', {
      total: row?.total ?? 0,
      lastHour: row?.recent ?? 0,
    });
  } catch {
    emitMetric('sweep.error', { signal: 'webhook.failed' });
  }
  try {
    const row = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM checkout_sessions WHERE status = 'open' AND created_at < ?",
      )
      .bind(now - STALE_CHECKOUT_MS)
      .first<{ count: number }>();
    emitMetric('checkout.stale', { count: row?.count ?? 0 });
  } catch {
    emitMetric('sweep.error', { signal: 'checkout.stale' });
  }
  try {
    // Accounts holding at least one subscription row whose reconcile
    // marker is missing or past the 24h freshness target in metrics.md.
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM billing_accounts ba
         WHERE ba.lifecycle = 'active'
           AND EXISTS (SELECT 1 FROM stripe_subscriptions ss WHERE ss.billing_account_id = ba.id)
           AND NOT EXISTS (
             SELECT 1 FROM billing_meta bm
             WHERE bm.key = 'reconcile_at:' || ba.id
               AND CAST(bm.value AS INTEGER) > ?
           )`,
      )
      .bind(now - STALE_CHECKOUT_MS)
      .first<{ count: number }>();
    emitMetric('reconcile.freshness', { staleAccounts: row?.count ?? 0 });
  } catch {
    emitMetric('sweep.error', { signal: 'reconcile.freshness' });
  }
}

/** Cron entry point: reconcile stale accounts, then emit the sweep. */
export async function runHostedReconcile(env: Env): Promise<void> {
  const db = env.HOSTED_DB;
  if (db === undefined) return;
  const now = Date.now();
  for (const missing of hostedConfigIssues(env)) {
    emitMetric('config.issue', { missing });
  }
  if (!stripeConfigured(env)) {
    emitMetric('reconcile.skipped', { reason: 'stripe-unconfigured' });
    await emitAggregateMetrics(db, now);
    return;
  }
  let candidates: CandidateRow[] = [];
  let markers = new Map<string, number>();
  try {
    const { results } = await db
      .prepare(
        `SELECT ba.id AS billing_account_id, sc.stripe_customer_id
         FROM billing_accounts ba
         JOIN stripe_customers sc ON sc.billing_account_id = ba.id
         LEFT JOIN billing_meta bm ON bm.key = 'reconcile_at:' || ba.id
         WHERE ba.lifecycle = 'active'
         -- Stalest first: a missing marker (NULL) sorts before the oldest
         -- timestamp, so every account reaches the head of the queue
         -- instead of the same oldest-50 being re-examined every run.
         ORDER BY CAST(bm.value AS INTEGER) ASC, ba.created_at ASC
         LIMIT ?`,
      )
      .bind(RECONCILE_CANDIDATE_LIMIT)
      .all<CandidateRow>();
    candidates = results ?? [];
    markers = await loadReconcileMarkers(db);
  } catch {
    emitMetric('reconcile.error', { stage: 'candidates' });
    return;
  }
  const stale = candidates
    .filter((candidate) => {
      const marker = markers.get(reconcileMetaKey(candidate.billing_account_id));
      return marker === undefined || now - marker > RECONCILE_STALE_MS;
    })
    .slice(0, RECONCILE_BATCH_LIMIT);
  let reconciled = 0;
  let failed = 0;
  for (const candidate of stale) {
    try {
      await reconcileAccount(db, env, candidate, now);
      reconciled += 1;
    } catch {
      failed += 1;
      emitMetric('reconcile.failure', {});
    }
  }
  if (reconciled > 0) {
    await setBillingMeta(db, LAST_RECONCILE_KEY, String(now)).catch(() => undefined);
  }
  emitMetric('reconcile.run', {
    candidates: candidates.length,
    attempted: stale.length,
    reconciled,
    failed,
  });
  await emitAggregateMetrics(db, now);
}
