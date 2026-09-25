-- BILL-01 hosted billing identity store. This database exists only on
-- hosted deployments (wrangler.hosted.jsonc); the self-host config never
-- provisions it. All timestamps are INTEGER unix epoch milliseconds and all
-- ids are TEXT. Comment lines hold no semicolons so the file can also be
-- applied verbatim through D1 exec in tests.

CREATE TABLE IF NOT EXISTS billing_accounts (
  id TEXT PRIMARY KEY,
  workos_client_id TEXT NOT NULL,
  workos_user_id TEXT NOT NULL,
  sync_account_id TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  lifecycle TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle IN ('active', 'deleting', 'deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workos_client_id, workos_user_id)
);

-- Reverse claim check: at most one ACTIVE billing account may point at a
-- sync account. Partial indexes are supported by SQLite/D1 and keep the
-- invariant atomic instead of relying on a check-then-write race.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_accounts_sync_account
  ON billing_accounts (sync_account_id)
  WHERE sync_account_id IS NOT NULL AND lifecycle = 'active';

CREATE TABLE IF NOT EXISTS hosted_link_codes (
  code_hash TEXT PRIMARY KEY,
  billing_account_id TEXT NOT NULL REFERENCES billing_accounts(id),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hosted_link_codes_account
  ON hosted_link_codes (billing_account_id, consumed_at);

-- Replay protection for the signed website -> backend service channel:
-- one row per seen (key_id, request_id), deleted lazily once the signature
-- acceptance window has passed.
CREATE TABLE IF NOT EXISTS service_nonces (
  key_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, request_id)
);
