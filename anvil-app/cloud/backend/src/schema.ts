/** SQLite DDL for the spike `AccountCoordinator`. All state lives here. */

export const ACCOUNT_SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS enrollments (
  enrollment_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  high_water INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS entities (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  operation TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload TEXT,
  sequence INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_entities_sequence ON entities (sequence);
CREATE TABLE IF NOT EXISTS changes (
  sequence INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  operation TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_entity ON changes (entity_type, entity_id, sequence);
CREATE TABLE IF NOT EXISTS receipts (
  enrollment_id TEXT NOT NULL,
  enrollment_sequence INTEGER NOT NULL,
  change_id TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER,
  content_hash TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (enrollment_id, enrollment_sequence)
);
CREATE TABLE IF NOT EXISTS scans (
  scan_id TEXT PRIMARY KEY,
  watermark_start INTEGER NOT NULL,
  epoch TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  entity_cursor TEXT
);
CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`;

/** First-dataset epoch for a fresh account object. Fixed for determinism. */
export const SPIKE_INITIAL_EPOCH = 'spike-epoch-1';

/**
 * SQLite DDL for the `SessionCoordinator` object: device sessions, rotating
 * refresh credentials, and single-use enrollment codes. Access and refresh
 * tokens are stored as SHA-256 hashes only. `pending_rotated_session` holds
 * the most recent rotation response verbatim for the grace window so a lost
 * refresh response replays idempotently.
 */
export const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS device_sessions (
  enrollment_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  display_name TEXT,
  credential_generation INTEGER NOT NULL,
  access_token_hash TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_token_hash TEXT NOT NULL,
  prev_refresh_token_hash TEXT,
  prev_refresh_grace_until INTEGER,
  pending_rotated_session TEXT,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_access ON device_sessions (access_token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON device_sessions (refresh_token_hash);
CREATE TABLE IF NOT EXISTS enrollment_codes (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  display_name TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_codes_account ON enrollment_codes (account_id, consumed_at);
`;
