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
`;

/** First-dataset epoch for a fresh account object. Fixed for determinism. */
export const SPIKE_INITIAL_EPOCH = 'spike-epoch-1';
