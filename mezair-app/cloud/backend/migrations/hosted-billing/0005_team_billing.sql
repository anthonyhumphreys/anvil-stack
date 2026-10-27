-- BILL-08 team subscriptions. Organization billing is separate from each
-- member's personal billing account and never changes the personal sync ID.

CREATE TABLE IF NOT EXISTS stripe_organization_customers (
  stripe_customer_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES hosted_organizations(id),
  owner_billing_account_id TEXT NOT NULL REFERENCES billing_accounts(id),
  created_at INTEGER NOT NULL,
  UNIQUE (organization_id)
);

ALTER TABLE stripe_subscriptions ADD COLUMN organization_id TEXT REFERENCES hosted_organizations(id);
ALTER TABLE stripe_subscriptions ADD COLUMN stripe_subscription_item_id TEXT;
ALTER TABLE stripe_subscriptions ADD COLUMN stripe_subscription_schedule_id TEXT;
ALTER TABLE stripe_subscriptions ADD COLUMN seat_quantity INTEGER NOT NULL DEFAULT 1;
-- Stripe can report a larger item quantity before the proration invoice is
-- paid. Entitlements use only the last quantity confirmed by invoice.paid.
ALTER TABLE stripe_subscriptions ADD COLUMN paid_seat_quantity INTEGER NOT NULL DEFAULT 1;
UPDATE stripe_subscriptions
SET paid_seat_quantity = seat_quantity
WHERE has_paid_invoice = 1;
-- Likewise, do not extend access when Stripe advances the provider period
-- before collecting the renewal invoice.
ALTER TABLE stripe_subscriptions ADD COLUMN paid_through INTEGER;
UPDATE stripe_subscriptions
SET paid_through = current_period_end
WHERE has_paid_invoice = 1 AND paid_through IS NULL;

CREATE INDEX IF NOT EXISTS idx_stripe_subscriptions_organization
  ON stripe_subscriptions (organization_id, verified_at);

ALTER TABLE checkout_sessions ADD COLUMN organization_id TEXT REFERENCES hosted_organizations(id);
ALTER TABLE checkout_sessions ADD COLUMN seat_quantity INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS organization_billing_state (
  organization_id TEXT PRIMARY KEY REFERENCES hosted_organizations(id),
  preview_seat_capacity INTEGER NOT NULL DEFAULT 5 CHECK (preview_seat_capacity BETWEEN 0 AND 50),
  effective_seat_capacity INTEGER NOT NULL DEFAULT 5 CHECK (effective_seat_capacity BETWEEN 0 AND 50),
  scheduled_seat_capacity INTEGER CHECK (scheduled_seat_capacity BETWEEN 5 AND 50),
  scheduled_effective_at INTEGER,
  seat_update_lease_token TEXT,
  seat_update_lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS team_seat_change_quotes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES hosted_organizations(id),
  created_by_billing_account_id TEXT NOT NULL REFERENCES billing_accounts(id),
  stripe_subscription_id TEXT NOT NULL,
  stripe_subscription_item_id TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  current_seat_quantity INTEGER NOT NULL CHECK (current_seat_quantity BETWEEN 5 AND 50),
  requested_seat_quantity INTEGER NOT NULL CHECK (requested_seat_quantity BETWEEN 5 AND 50),
  current_period_end INTEGER NOT NULL,
  amount_due INTEGER NOT NULL,
  currency TEXT NOT NULL,
  tax_amount INTEGER NOT NULL,
  proration_date INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'superseded', 'expired')),
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_team_seat_quotes_org_status
  ON team_seat_change_quotes (organization_id, status, created_at);
