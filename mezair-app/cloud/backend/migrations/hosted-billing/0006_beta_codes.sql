CREATE TABLE hosted_beta_codes (
  code_hash TEXT PRIMARY KEY CHECK(length(code_hash) = 64),
  redeem_until INTEGER NOT NULL,
  access_until INTEGER NOT NULL CHECK(access_until >= redeem_until),
  created_at INTEGER NOT NULL,
  redeemed_by TEXT REFERENCES billing_accounts(id),
  redeemed_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX hosted_beta_codes_account ON hosted_beta_codes(redeemed_by);
