-- BILL-03 per-account preview lever: ops/tests can exclude a billing
-- account from the free preview window without touching its lifecycle.
-- The default keeps every existing account preview-eligible, matching the
-- pre-column behavior where an active lifecycle implied eligibility.

ALTER TABLE billing_accounts ADD COLUMN preview_eligible INTEGER NOT NULL DEFAULT 1;
