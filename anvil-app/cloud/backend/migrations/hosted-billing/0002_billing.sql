-- BILL-02 hosted billing provider state. Same hosted-only D1 database as
-- 0001: these tables exist only on hosted deployments and hold the Stripe
-- mirror the entitlement policy reads. All timestamps are INTEGER unix
-- epoch milliseconds, all provider ids are TEXT, and comment lines hold
-- no semicolons so tests can apply the file statement-by-statement.

-- One Stripe customer per billing account, enforced both ways.
CREATE TABLE IF NOT EXISTS stripe_customers (
  stripe_customer_id TEXT PRIMARY KEY,
  billing_account_id TEXT NOT NULL REFERENCES billing_accounts(id),
  created_at INTEGER NOT NULL,
  UNIQUE (billing_account_id)
);

-- Verbatim provider mirror: status is the raw Stripe status string and
-- verified_at records when we last saw this provider truth. The
-- has_paid_invoice and first_failed_renewal_at columns are our own
-- bookkeeping and are preserved across upserts on purpose.
CREATE TABLE IF NOT EXISTS stripe_subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT NOT NULL,
  billing_account_id TEXT NOT NULL REFERENCES billing_accounts(id),
  status TEXT NOT NULL,
  plan_key TEXT NOT NULL,
  interval TEXT NOT NULL CHECK (interval IN ('month', 'year')),
  current_period_end INTEGER NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  has_paid_invoice INTEGER NOT NULL DEFAULT 0,
  first_failed_renewal_at INTEGER,
  verified_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stripe_subscriptions_account
  ON stripe_subscriptions (billing_account_id);

CREATE INDEX IF NOT EXISTS idx_stripe_subscriptions_customer
  ON stripe_subscriptions (stripe_customer_id);

-- Durable reservation record for checkout attempts: one row per Stripe
-- Checkout Session we created, so a late webhook or a reconcile can match
-- it back to the owning account without trusting client input.
CREATE TABLE IF NOT EXISTS checkout_sessions (
  stripe_session_id TEXT PRIMARY KEY,
  billing_account_id TEXT NOT NULL REFERENCES billing_accounts(id),
  plan_key TEXT NOT NULL,
  interval TEXT NOT NULL CHECK (interval IN ('month', 'year')),
  status TEXT NOT NULL CHECK (status IN ('open', 'complete', 'expired')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_account
  ON checkout_sessions (billing_account_id, status);

-- Webhook inbox: dedupe on the provider event id, then track a
-- pending/processed/failed lifecycle so Stripe retries stay idempotent
-- and poison events stay observable instead of being silently dropped.
CREATE TABLE IF NOT EXISTS webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_status
  ON webhook_events (status, created_at);

-- Audit trail: transition records with sanitized JSON detail, never card
-- data, tokens, secrets, or synced user content.
CREATE TABLE IF NOT EXISTS billing_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  billing_account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_billing_audit_account
  ON billing_audit (billing_account_id, created_at);

-- Reconciliation markers and similar singleton state, e.g.
-- last_reconcile_at.
CREATE TABLE IF NOT EXISTS billing_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
