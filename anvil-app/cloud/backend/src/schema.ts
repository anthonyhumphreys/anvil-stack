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
  created_at INTEGER NOT NULL,
  -- ENV-01: 'device' | 'ephemeral', pinned on first sight (worker-verified).
  enrollment_class TEXT NOT NULL DEFAULT 'device',
  -- ENV-01: environment record this enrollment is bound to, when any.
  environment_id TEXT
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
-- MESH-01 worker lifecycle. One row per enrolled device that has published
-- a device policy: incarnation/last_seen_at/lease_expires_at stay NULL
-- until the first worker.connect. policy/capabilities hold JSON contract
-- documents. revoked_at marks a session-revoked worker; re-publishing the
-- local policy is the only re-arm path (fresh opt-in, fresh incarnation).
CREATE TABLE IF NOT EXISTS workers (
  enrollment_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  policy TEXT NOT NULL,
  incarnation TEXT,
  capabilities TEXT,
  connected_at INTEGER,
  last_seen_at INTEGER,
  lease_expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS worker_replicas (
  enrollment_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  definition_revision TEXT NOT NULL,
  readiness TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (enrollment_id, workspace_id)
);
-- MESH-02 durable jobs + execution attempts. Jobs/attempts are account
-- metadata: their writes never touch the sync change sequence and are never
-- emitted as entity changes (spec §13). requested_target/input_manifest hold
-- JSON contract documents pinned at creation; placement_explanation records
-- why the resolved target was chosen (or why none qualified). next_fence is
-- the per-job monotonically increasing claim fence; retried bounds the one
-- 'safe' re-queue.
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  source_enrollment_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  requested_target TEXT NOT NULL,
  target_enrollment_id TEXT,
  placement_explanation TEXT,
  input_manifest TEXT NOT NULL,
  -- E2EE: sensitive inputs sealed under the job's TCK (opaque envelope),
  -- and the declared result-recipient enrollment ids.
  sealed_inputs TEXT,
  result_recipients TEXT,
  state TEXT NOT NULL,
  state_reason TEXT,
  queue_deadline INTEGER NOT NULL,
  retry_policy TEXT NOT NULL,
  retried INTEGER NOT NULL DEFAULT 0,
  next_fence INTEGER NOT NULL DEFAULT 1,
  active_attempt_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Creation idempotency: request ids are unique per (account-scoped) source.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_request
  ON jobs (source_enrollment_id, request_id);
-- Claim/notify path: queued jobs for one target by deadline (spec §13 asks
-- for a target/queued-job index; no account-wide scans on claim).
CREATE INDEX IF NOT EXISTS idx_jobs_target_queue
  ON jobs (target_enrollment_id, state, queue_deadline);
-- Deadline sweeps and state-filtered job.list.
CREATE INDEX IF NOT EXISTS idx_jobs_state_deadline
  ON jobs (state, queue_deadline);
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  worker_enrollment_id TEXT NOT NULL,
  worker_incarnation TEXT NOT NULL,
  fence INTEGER NOT NULL,
  state TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  outcome TEXT,
  result TEXT,
  -- E2EE: rich result detail sealed under the job's TCK (opaque envelope).
  sealed_result TEXT,
  error TEXT,
  late_result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Fences are monotonic per job: at most one attempt per fence value.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_job_fence
  ON attempts (job_id, fence);
-- Worker capacity check on claim (active attempts per worker).
CREATE INDEX IF NOT EXISTS idx_attempts_worker_state
  ON attempts (worker_enrollment_id, state);
-- Duplicate-active-attempt check and per-job attempt listing.
CREATE INDEX IF NOT EXISTS idx_attempts_job_state
  ON attempts (job_id, state);
-- MESH-03 durable event journal (spec §10). Two sequence spaces by design:
-- event_seq is the per-job monotonic durable cursor (event.pull/afterSequence);
-- sequence is the per-(attempt, stream) sequence carried by socket
-- activity/gap frames. attempt_id '' marks job-scope lifecycle rows.
-- covers_through = event_seq for ordinary rows; for 'gap' rows it is the
-- highest dropped event_seq the row covers, so a pull can tell a cursor
-- sitting mid-gap from a clean one. durable=1 rows are never budget-gated;
-- durable=0 rows (worker activity) are journaled only while the job's
-- intermediate-metadata budget (job_event_meta.activity_bytes) has room —
-- past it they allocate a cursor but materialize as 'gap' rows, never a
-- silent drop.
CREATE TABLE IF NOT EXISTS events (
  job_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  durable INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  payload TEXT NOT NULL,
  covers_through INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, event_seq)
);
CREATE INDEX IF NOT EXISTS idx_events_attempt
  ON events (job_id, attempt_id, event_seq);
-- Worker-replayed activity dedupe: same (attempt, stream, sequence) never
-- journals twice. 'gap' rows are excluded so a replayed frame that was once
-- budget-dropped can still land if budget later frees.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_stream_seq
  ON events (job_id, attempt_id, stream_id, sequence) WHERE kind != 'gap';
-- Per-job journal counters: next durable cursor + retained activity bytes.
CREATE TABLE IF NOT EXISTS job_event_meta (
  job_id TEXT PRIMARY KEY,
  next_event_seq INTEGER NOT NULL,
  activity_bytes INTEGER NOT NULL DEFAULT 0
);
-- MESH-03 durable approvals (spec §10): expiring requests bound to an
-- attempt, an action digest, the attempt fence (generation), and a
-- permitted approver. A decision never loosens target-local policy.
CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  generation INTEGER NOT NULL,
  approver_enrollment_id TEXT,
  approver_role TEXT NOT NULL DEFAULT 'user',
  state TEXT NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_job ON approvals (job_id, state);
-- At most one pending approval per attempt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_pending_attempt
  ON approvals (attempt_id) WHERE state = 'pending';
-- Lazy/sweep expiry lookups.
CREATE INDEX IF NOT EXISTS idx_approvals_expiry ON approvals (state, expires_at);
-- MESH-03 artifact manifests (spec §10): rows are the state authority; the
-- R2 object at r2_key is reconciled against them (reserved→uploaded→
-- published, deleting→deleted). Never a SQL/R2 atomic transaction.
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  media_type TEXT NOT NULL,
  retention_days INTEGER NOT NULL,
  state TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  upload_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  expires_at INTEGER,
  deleted_at INTEGER,
  sealed INTEGER NOT NULL DEFAULT 0,
  key_version INTEGER,
  plaintext_bytes INTEGER
);
CREATE INDEX IF NOT EXISTS idx_artifacts_job ON artifacts (job_id, state);
CREATE INDEX IF NOT EXISTS idx_artifacts_attempt ON artifacts (attempt_id, state);
-- Retention-expiry sweep (published/uploaded past expires_at).
CREATE INDEX IF NOT EXISTS idx_artifacts_expiry ON artifacts (state, expires_at);
-- Orphaned-reservation sweep (reserved past upload_expires_at).
CREATE INDEX IF NOT EXISTS idx_artifacts_upload_expiry
  ON artifacts (state, upload_expires_at);
-- SESSION-03 session-generation authority (spec §11): a logical session
-- records its current execution generation and owning enrollment. Only the
-- owner of the current generation may accept a new remote turn; ownership
-- moves once, via the handoff transfer CAS. The first handoff.create seen
-- for a session binds its asserted (generation, owner).
CREATE TABLE IF NOT EXISTS mesh_sessions (
  session_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  owner_enrollment_id TEXT NOT NULL,
  checkpoint_lineage TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- SESSION-03 handoff state machine (contract handoff.ts): at most one
-- in-flight handoff per session; handoff_id is the idempotency key.
-- checkpoint_json carries the bounded SessionCheckpoint written when the
-- source relinquishes; cancelled_from preserves the pre/post-transfer
-- boundary so a cancel can resume the proven-stopped side correctly.
CREATE TABLE IF NOT EXISTS handoffs (
  handoff_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  source_enrollment_id TEXT NOT NULL,
  target_enrollment_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  target_generation INTEGER,
  checkpoint_json TEXT,
  cancelled_from TEXT,
  cancel_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoffs_session ON handoffs (session_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_handoffs_active_session
  ON handoffs (session_id) WHERE state NOT IN ('completed', 'cancelled', 'failed');
-- Data portability (sync/1): durable export/import operations. Export rows
-- carry the snapshot watermark + paging cursor; import rows stage the
-- validated plan JSON until commit (idempotent via the result column).
CREATE TABLE IF NOT EXISTS data_operations (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  watermark INTEGER,
  entity_cursor TEXT,
  plan TEXT,
  result TEXT
);
-- MOB-01 companion presence: one row per enrollment's latest endpoint
-- advertisement. Ephemeral metadata — TTL'd at read time, never a sync
-- change, never part of the durable entity store.
CREATE TABLE IF NOT EXISTS presence_advertisements (
  enrollment_id TEXT PRIMARY KEY,
  endpoints TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  protocol INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- ENV-01 cloud environment records (contract environment.ts). Descriptive
-- lifecycle + cleanup intent: handle is an opaque provider reference
-- (never a credential), enrollment_id links the ephemeral worker once
-- bootstrapped, and reap_requested_at is the durable intent any
-- provisioner-capable device may complete when the creator is offline.
CREATE TABLE IF NOT EXISTS environments (
  environment_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  state TEXT NOT NULL,
  handle TEXT,
  enrollment_id TEXT,
  job_id TEXT,
  created_by TEXT NOT NULL,
  expires_at INTEGER,
  reap_requested_at INTEGER,
  reaped_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_environments_account ON environments (account_id, state);
CREATE INDEX IF NOT EXISTS idx_environments_enrollment ON environments (enrollment_id);
-- ENV-06 per-attempt credential grants: sealed envelopes bound to
-- (job, attempt, fence, target). The backend stores but cannot open them —
-- they are never journaled and never sync entities. Rows drop at expiry or
-- attempt-terminal; envelope_sha dedupes identical re-deliveries.
CREATE TABLE IF NOT EXISTS credential_grants (
  grant_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  fence INTEGER NOT NULL,
  target_enrollment_id TEXT NOT NULL,
  envelope TEXT NOT NULL,
  envelope_sha TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_credential_grants_dedupe
  ON credential_grants (job_id, attempt_id, envelope_sha);
CREATE INDEX IF NOT EXISTS idx_credential_grants_attempt
  ON credential_grants (attempt_id, fence, expires_at);
-- E2EE task content keys (contract sealed.ts): one wrap per (job, target)
-- — the job's TCK sealed to that enrollment's X25519 identity. The backend
-- stores and relays opaque envelopes; it can never open them. Wraps are
-- upserted idempotently; delivered_at marks first pull.
CREATE TABLE IF NOT EXISTS task_key_wraps (
  job_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  target_enrollment_id TEXT NOT NULL,
  envelope TEXT NOT NULL,
  envelope_sha TEXT NOT NULL,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, target_enrollment_id)
);
CREATE INDEX IF NOT EXISTS idx_task_key_wraps_target
  ON task_key_wraps (target_enrollment_id, delivered_at);
-- keyring.report: a trusted device's record that a post-revocation
-- rotation completed — lets dashboards distinguish 'access revoked' from
-- 'rotation pending'. Idempotent on rotation_id.
CREATE TABLE IF NOT EXISTS keyring_rotation_reports (
  rotation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  reporter_enrollment_id TEXT NOT NULL,
  revoked_json TEXT NOT NULL,
  to_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
-- Browser dashboard authorization (contract dashboard.ts): the request
-- row is the lifecycle authority. grant/snapshot are sealed envelopes the
-- coordinator relays but cannot open — the DSK lives only inside grant.ct.
-- snapshot_seq enforces strictly increasing publication.
CREATE TABLE IF NOT EXISTS dashboard_requests (
  request_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  browser_pub TEXT NOT NULL,
  challenge TEXT NOT NULL,
  scopes TEXT NOT NULL,
  origin TEXT,
  user_agent TEXT,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  grant TEXT,
  snapshot TEXT,
  snapshot_seq INTEGER NOT NULL DEFAULT 0,
  decided_by TEXT,
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dashboard_requests_account
  ON dashboard_requests (account_id, state);
-- ENV-09 managed-environment bootstrap staging: the anvil-pair payload
-- a source minted for a backend-provisioned environment. These rows ARE
-- plaintext pairing material held inside the hosted trust boundary —
-- never journaled, consume-once (the managed claimer deletes what it
-- reads), and swept at expiry. BYO providers never touch this table:
-- their pairings are minted on the claiming device.
CREATE TABLE IF NOT EXISTS environment_bootstrap (
  environment_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
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
  created_at INTEGER NOT NULL,
  -- ENV-01: 'device' | 'ephemeral'. Ephemeral rows are cloud environments:
  -- restricted ops, own quota, and bounded by enrollment_expires_at.
  enrollment_class TEXT NOT NULL DEFAULT 'device',
  provider TEXT,
  created_by TEXT,
  enrollment_expires_at INTEGER,
  -- ENV-01: environment record this enrollment was minted for (ephemeral
  -- codes only). Lets the env authorize its own enrolled report.
  environment_id TEXT,
  -- Account security: proof provenance is immutable for the enrollment;
  -- revoked is a sticky trust floor and cannot be re-announced.
  proof_method TEXT NOT NULL DEFAULT 'enrollment-code',
  trust_state TEXT NOT NULL DEFAULT 'pending',
  trusted_at INTEGER,
  signing_public_key TEXT,
  trust_source TEXT,
  trust_generation INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_access ON device_sessions (access_token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON device_sessions (refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_class ON device_sessions (account_id, enrollment_class);
-- WorkOS device codes are provider-owned one-use proofs. Keep only a hash so
-- an Anvil retry or race cannot mint a second enrollment after success.
CREATE TABLE IF NOT EXISTS workos_device_proofs (
  device_code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  consumed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workos_device_rate (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_attempt_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS enrollment_codes (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  display_name TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  -- ENV-01: class-bound codes. An 'ephemeral' code can only mint an
  -- ephemeral session; session_ttl_ms bounds that session's lifetime.
  enrollment_class TEXT NOT NULL DEFAULT 'device',
  provider TEXT,
  session_ttl_ms INTEGER,
  -- ENV-01: environment record binding for ephemeral codes.
  environment_id TEXT,
  -- Explicit pairing is opt-in; ordinary codes stay pending on existing
  -- accounts even when account policy is automatic-auth.
  trust_mode TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_codes_account ON enrollment_codes (account_id, consumed_at);

-- Account-scoped durable security policy. A missing row is migrated to
-- require-approval by SessionCoordinator without changing existing session
-- membership. Revisions are CAS inputs for every security mutation.
CREATE TABLE IF NOT EXISTS account_security (
  account_id TEXT PRIMARY KEY,
  policy TEXT NOT NULL DEFAULT 'require-approval',
  revision INTEGER NOT NULL DEFAULT 1,
  generation INTEGER NOT NULL DEFAULT 1,
  recovery_revision INTEGER NOT NULL DEFAULT 0,
  recovery_id TEXT,
  backend_id TEXT,
  recovery_ciphertext TEXT,
  recovery_verifier_public_key TEXT,
  recovery_owner_enrollment_id TEXT,
  recovery_invalidated_at INTEGER,
  bootstrap_enrollment_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_security_generation
  ON account_security (account_id, generation);

-- One-use short-lived challenge records. expected_public_key is metadata,
-- never private key material; challenge values and signatures are not audit
-- content and are deleted after expiry.
CREATE TABLE IF NOT EXISTS security_challenges (
  challenge_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  action TEXT NOT NULL,
  account_revision INTEGER NOT NULL,
  recovery_revision INTEGER NOT NULL,
  challenge TEXT NOT NULL,
  expected_public_key TEXT,
  recovery_id TEXT,
  backend_id TEXT,
  identity_pub TEXT,
  payload_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_challenges_account
  ON security_challenges (account_id, expires_at, used_at);

-- Bounded metadata-only security audit. Ciphertexts, signatures and public
-- keys never enter this table.
CREATE TABLE IF NOT EXISTS security_audit (
  audit_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  enrollment_id TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  proof_method TEXT,
  enrollment_class TEXT,
  metadata TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_audit_account
  ON security_audit (account_id, created_at);
-- Account deletion tombstones (spec §140/§560): the identity directory's
-- durable record that an accountId was deleted. It survives the account
-- object's purge, blocks enrollment-code issuance for the dead id, and
-- carries the deletion generation so restore cannot revive authority.
CREATE TABLE IF NOT EXISTS account_deletions (
  account_id TEXT PRIMARY KEY,
  deletion_generation INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  deleted_at INTEGER
);
-- Hosted artifact shares (contract shares.ts): user-published durable
-- content behind a revocable, unguessable share id. The row is the state
-- authority; the R2 object at r2_key is reconciled against it
-- (reserved→uploaded→published, revoked/expired terminal). Lives on the
-- session object because public resolution must find a share from its id
-- alone — an account-object row cannot be located without the accountId.
CREATE TABLE IF NOT EXISTS shared_artifacts (
  share_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  title TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  expires_in_days INTEGER NOT NULL,
  state TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  upload_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  sealed INTEGER NOT NULL DEFAULT 0,
  plaintext_bytes INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shared_artifacts_account
  ON shared_artifacts (account_id, state);
CREATE INDEX IF NOT EXISTS idx_shared_artifacts_expiry
  ON shared_artifacts (state, expires_at);
CREATE INDEX IF NOT EXISTS idx_shared_artifacts_upload_expiry
  ON shared_artifacts (state, upload_expires_at);
`;
