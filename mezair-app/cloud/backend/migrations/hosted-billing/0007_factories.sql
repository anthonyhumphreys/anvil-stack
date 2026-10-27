-- Content is sealed by trusted endpoints, never decrypted by hosted Sync.
CREATE TABLE hosted_factory_keys (
  organization_id TEXT NOT NULL, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL, public_key TEXT NOT NULL, github_login TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id,user_id)
);
CREATE TABLE hosted_factories (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  executor_account_id TEXT NOT NULL, executor_enrollment_id TEXT NOT NULL, revision INTEGER NOT NULL, policy_json TEXT NOT NULL, source_json TEXT NOT NULL,
  definition_digest TEXT NOT NULL, registry_version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft', active_revision INTEGER, activated_at TEXT,
  snapshot_json TEXT, updated_at INTEGER NOT NULL
);
CREATE INDEX hosted_factories_org ON hosted_factories(organization_id,updated_at);
CREATE TABLE hosted_factory_runs (
  factory_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, payload_digest TEXT NOT NULL,
  snapshot_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(factory_id,id)
);
CREATE TABLE hosted_factory_commands (
  id TEXT PRIMARY KEY, factory_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL, completed_at INTEGER, result_json TEXT, lease_token TEXT, lease_until INTEGER
);
CREATE INDEX hosted_factory_pending ON hosted_factory_commands(factory_id,state,created_at);
CREATE TABLE hosted_factory_audit (
  id TEXT PRIMARY KEY, factory_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  action TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE hosted_factory_issue_claims (
  organization_id TEXT NOT NULL, source TEXT NOT NULL, issue_number INTEGER NOT NULL,
  factory_id TEXT NOT NULL, run_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(organization_id,source,issue_number)
);
