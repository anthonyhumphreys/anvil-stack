export const SCHEMA_VERSION = 98;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS change_reviews (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  record_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_change_reviews_workspace ON change_reviews(workspace_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS scoped_work_items_cache (
  connection_key TEXT NOT NULL,
  id TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY(connection_key, id)
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  remote_url TEXT,
  default_branch TEXT DEFAULT 'main',
  status TEXT DEFAULT 'connected',
  index_tier TEXT NOT NULL DEFAULT 'connected',
  last_indexed TEXT,
  file_count INTEGER DEFAULT 0,
  branch_count INTEGER DEFAULT 0,
  last_commit_message TEXT,
  last_commit_date TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS repo_summaries (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id),
  overview TEXT,
  architecture_description TEXT,
  mermaid_diagram TEXT,
  patterns TEXT,
  frameworks TEXT,
  entry_points TEXT,
  config_files TEXT,
  language_breakdown TEXT,
  generated_at TEXT,
  model_version TEXT,
  index_mode TEXT DEFAULT 'light',
  index_provider TEXT,
  index_warnings TEXT,
  map_refresh_mode TEXT NOT NULL DEFAULT 'manual',
  generated_commit_sha TEXT
);

CREATE TABLE IF NOT EXISTS module_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT REFERENCES repos(id),
  path TEXT NOT NULL,
  purpose TEXT,
  file_count INTEGER,
  key_files TEXT,
  dependencies TEXT,
  content_hash TEXT,
  generated_at TEXT,
  UNIQUE(repo_id, path)
);

CREATE TABLE IF NOT EXISTS repository_map_graphs (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  indexed_commit_sha TEXT,
  graph_json TEXT NOT NULL,
  generated_at TEXT NOT NULL
);

-- Tiered index queue: one row per repo per tier target. 'running' rows are
-- crash fences — startup recovery re-queues them instead of resetting repos.
CREATE TABLE IF NOT EXISTS repo_index_jobs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('mapped', 'enriched')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  reason TEXT NOT NULL DEFAULT 'manual',
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  error TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_repo_index_jobs_repo ON repo_index_jobs (repo_id, state);
CREATE INDEX IF NOT EXISTS idx_repo_index_jobs_state ON repo_index_jobs (state, queued_at);

CREATE TABLE IF NOT EXISTS chat_threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  persona_id TEXT NOT NULL,
  title TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'normal' CHECK (purpose IN ('normal', 'side-question')),
  side_question_of_thread_id TEXT REFERENCES chat_threads(id) ON DELETE SET NULL,
  work_item_id TEXT,
  work_item_provider TEXT,
  work_item_title TEXT,
  repo_ids_json TEXT NOT NULL DEFAULT '[]',
  active_repo_id TEXT REFERENCES repos(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT,
  provider_thread_id TEXT,
  provider_thread_provider TEXT,
  active_plan_json TEXT,
  active_plan_updated_at TEXT,
  active_goal_json TEXT,
  attention_state TEXT NOT NULL DEFAULT 'idle',
  attention_updated_at TEXT,
  active_turn_started_at TEXT,
  last_viewed_at TEXT,
  settled_at TEXT,
  summary TEXT,
  title_locked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES chat_threads(id),
  repo_id TEXT REFERENCES repos(id),
  persona_id TEXT,
  provider_thread_id TEXT,
  provider_turn_id TEXT,
  provider TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES chat_threads(id),
  repo_id TEXT REFERENCES repos(id),
  persona_id TEXT,
  session_id TEXT REFERENCES chat_sessions(id),
  branch_id TEXT,
  parent_id TEXT,
  kind TEXT NOT NULL DEFAULT 'user',
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  attachments_json TEXT,
  event_json TEXT,
  timestamp TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_threads_workspace_persona
  ON chat_threads(workspace_id, persona_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_threads_workspace_work_item
  ON chat_threads(workspace_id, work_item_provider, work_item_id);

CREATE INDEX IF NOT EXISTS idx_chat_threads_side_question_parent
  ON chat_threads(side_question_of_thread_id);

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_timestamp
  ON chat_messages(thread_id, timestamp ASC);

CREATE TABLE IF NOT EXISTS agent_ui_intents (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  workspace_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  lifecycle TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  binding_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_ui_intents_thread_lifecycle
  ON agent_ui_intents(thread_id, lifecycle, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_thread_pull_requests (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'ado')),
  pull_request_id TEXT NOT NULL,
  remote_url TEXT NOT NULL,
  pull_request_json TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(thread_id, repo_id, provider, pull_request_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_thread_pr_reverse
  ON chat_thread_pull_requests(repo_id, provider, pull_request_id);

CREATE TABLE IF NOT EXISTS agent_ui_intent_events (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES agent_ui_intents(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_ui_intent_events_intent
  ON agent_ui_intent_events(intent_id, created_at ASC);

CREATE TABLE IF NOT EXISTS agent_ui_intent_responses (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE REFERENCES agent_ui_intents(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_threads_provider_thread
  ON chat_threads(provider_thread_id);

CREATE TABLE IF NOT EXISTS workflow_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  graph_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  template_name TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_ids_json TEXT NOT NULL DEFAULT '[]',
  graph_json TEXT NOT NULL,
  kickoff TEXT NOT NULL,
  status TEXT NOT NULL,
  supervisor_thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  node_runs_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workspace_created
  ON workflow_runs(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_artifacts (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  repo_id TEXT REFERENCES repos(id) ON DELETE SET NULL,
  source_message_id TEXT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  storage_scope TEXT NOT NULL DEFAULT 'repository',
  relative_path TEXT NOT NULL,
  file_path TEXT,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  visibility TEXT NOT NULL DEFAULT 'local',
  source TEXT NOT NULL DEFAULT 'assistant',
  model TEXT,
  reasoning_effort TEXT,
  share_id TEXT,
  shared_url TEXT,
  shared_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(thread_id, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_chat_artifacts_thread_updated
  ON chat_artifacts(thread_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_artifact_revisions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES chat_artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source_message_id TEXT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  storage_scope TEXT NOT NULL DEFAULT 'repository',
  relative_path TEXT NOT NULL,
  file_path TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  visibility TEXT NOT NULL DEFAULT 'local',
  source TEXT NOT NULL DEFAULT 'assistant',
  model TEXT,
  reasoning_effort TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(artifact_id, version)
);

CREATE INDEX IF NOT EXISTS idx_chat_artifact_revisions_artifact_version
  ON chat_artifact_revisions(artifact_id, version DESC);

CREATE TABLE IF NOT EXISTS chat_artifact_annotations (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES chat_artifacts(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  quote TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_artifact_annotations_artifact_updated
  ON chat_artifact_annotations(artifact_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS review_workspace_comments (
  id TEXT PRIMARY KEY,
  repo_id TEXT REFERENCES repos(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  line_number INTEGER,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_review_workspace_comments_repo_status
  ON review_workspace_comments(repo_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS work_items_cache (
  id TEXT PRIMARY KEY,
  title TEXT,
  type TEXT,
  state TEXT,
  priority INTEGER,
  assignee TEXT,
  description TEXT,
  acceptance_criteria TEXT,
  repo_url TEXT,
  raw_json TEXT,
  tags TEXT,
  iteration_path TEXT,
  parent_id TEXT,
  fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  llm_provider TEXT DEFAULT 'codex',
  enabled_llm_providers TEXT,
  foundry_endpoint TEXT,
  foundry_deployment TEXT,
  foundry_api_version TEXT DEFAULT '2024-10-21',
  foundry_api_key BLOB,
  openai_api_key BLOB,
  openai_model TEXT DEFAULT 'gpt-5.6-sol',
  reasoning_level TEXT DEFAULT 'medium',
  codex_mode TEXT DEFAULT 'on-request',
  chat_layout TEXT DEFAULT 'classic',
  apple_foundation_models_mode TEXT DEFAULT 'off',
  local_llm_mode TEXT DEFAULT 'off',
  local_llm_provider TEXT DEFAULT 'apple',
  local_llm_endpoint TEXT,
  local_llm_model TEXT,
  thread_assist_provider TEXT DEFAULT 'off',
  thread_assist_model TEXT,
  ollama_endpoint TEXT,
  ollama_model TEXT,
  lm_studio_endpoint TEXT,
  lm_studio_model TEXT,
  ado_org_url TEXT,
  ado_project TEXT,
  ado_team TEXT,
  ado_pat BLOB,
  work_item_provider TEXT DEFAULT 'ado',
  work_item_connections BLOB,
  active_work_item_connection_id TEXT,
  linear_api_key BLOB,
  linear_team_id TEXT,
  jira_host TEXT,
  jira_auth_mode TEXT DEFAULT 'cloud',
  jira_project TEXT,
  jira_board_id TEXT,
  jira_email TEXT,
  jira_api_token BLOB,
  confluence_base_url TEXT,
  confluence_space_key TEXT,
  confluence_pat BLOB,
  docs_provider TEXT DEFAULT 'confluence',
  notion_oauth_token BLOB,
  notion_oauth_expiry TEXT,
  notion_database_id TEXT,
  default_repo_path TEXT,
  code_review_quick_glance_rubric TEXT,
  code_review_senior_dev_rubric TEXT,
  theme TEXT DEFAULT 'system',
  user_role TEXT,
  active_workspace_id TEXT,
  github_pat BLOB,
  github_username TEXT,
  cloud_features_enabled INTEGER NOT NULL DEFAULT 0,
  telemetry_enabled INTEGER NOT NULL DEFAULT 0,
  llm_gateway_api_key BLOB,
  llm_gateway_billing_mode TEXT NOT NULL DEFAULT 'devpass',
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cloud_execution_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  endpoint TEXT NOT NULL,
  token BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mobile_companion_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  host TEXT NOT NULL DEFAULT '0.0.0.0',
  port INTEGER NOT NULL DEFAULT 47631,
  instance_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mobile_companion_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  client_type TEXT NOT NULL DEFAULT 'mobile',
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS companion_enrollment_policies (
  enrollment_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  display_name TEXT,
  tier TEXT NOT NULL DEFAULT 'pending',
  first_seen_at TEXT NOT NULL,
  decided_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_notes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  repo TEXT,
  body TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_workspace_notes_workspace_status
  ON workspace_notes(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS companion_review_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  session_id TEXT,
  request_key TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  requested_action TEXT NOT NULL,
  risk TEXT NOT NULL,
  surface TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'later',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_companion_review_items_workspace_status
  ON companion_review_items(workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS onboard_state (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id),
  detection_json TEXT,
  detected_at TEXT
);

CREATE TABLE IF NOT EXISTS ba_sessions (
  id              TEXT PRIMARY KEY,
  work_item_id    TEXT NOT NULL,
  repo_id         TEXT NOT NULL,
  spike_branch    TEXT NOT NULL,
  origin_branch   TEXT NOT NULL,
  worktree_path   TEXT,
  stash_ref       TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  started_at      TEXT NOT NULL,
  ended_at        TEXT
);

CREATE TABLE IF NOT EXISTS ba_findings (
  id                TEXT PRIMARY KEY,
  work_item_id      TEXT NOT NULL,
  repo_id           TEXT NOT NULL,
  session_id        TEXT,
  type              TEXT NOT NULL,
  content           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',
  source_message_id TEXT,
  follow_up_work_item_id TEXT,
  follow_up_work_item_provider TEXT,
  follow_up_work_item_title TEXT,
  follow_up_work_item_url TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ba_repo_links (
  work_item_id TEXT PRIMARY KEY,
  repo_id      TEXT NOT NULL,
  linked_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ba_messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES ba_sessions(id),
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  event_type  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS code_reviews (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(id),
  mode          TEXT NOT NULL,
  scope_type    TEXT NOT NULL,
  scope_ref     TEXT,
  status        TEXT NOT NULL DEFAULT 'running',
  summary       TEXT,
  rubric_used   TEXT,
  verification_status TEXT NOT NULL DEFAULT 'not_run',
  verification_summary TEXT,
  verification_steps_json TEXT NOT NULL DEFAULT '[]',
  verification_target_ref TEXT,
  verification_worktree_path TEXT,
  verification_worktree_kept INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT,
  source_tree TEXT
);

CREATE TABLE IF NOT EXISTS code_review_findings (
  id            TEXT PRIMARY KEY,
  review_id     TEXT NOT NULL REFERENCES code_reviews(id),
  severity      TEXT NOT NULL,
  category      TEXT NOT NULL,
  file_path     TEXT,
  line_start    INTEGER,
  line_end      INTEGER,
  description   TEXT NOT NULL,
  suggestion    TEXT,
  work_item_id  TEXT,
  pr_comment_id TEXT,
  pr_comment_url TEXT,
  pr_commented_at TEXT,
  dismissed     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pull_request_visualisations (
  id              TEXT PRIMARY KEY,
  repo_id         TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  review_id       TEXT REFERENCES code_reviews(id) ON DELETE SET NULL,
  provider        TEXT NOT NULL,
  pull_request_id TEXT NOT NULL,
  head_sha        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'generating',
  pull_request_json TEXT NOT NULL,
  summary         TEXT,
  intent          TEXT,
  data_json       TEXT NOT NULL DEFAULT '{}',
  error           TEXT,
  created_at      TEXT NOT NULL,
  generated_at    TEXT,
  UNIQUE(repo_id, provider, pull_request_id, head_sha)
);

CREATE INDEX IF NOT EXISTS idx_pr_visualisations_lookup
  ON pull_request_visualisations(repo_id, provider, pull_request_id, created_at DESC);

CREATE TABLE IF NOT EXISTS security_audits (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(id),
  scope         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running',
  summary       TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT,
  model_version TEXT,
  source_tree TEXT
);

CREATE TABLE IF NOT EXISTS security_findings (
  id             TEXT PRIMARY KEY,
  audit_id       TEXT NOT NULL REFERENCES security_audits(id),
  severity       TEXT NOT NULL,
  category       TEXT NOT NULL,
  owasp_ref      TEXT,
  cwe_ref        TEXT,
  affected_files TEXT,
  description    TEXT NOT NULL,
  remediation    TEXT,
  work_item_id   TEXT,
  dismissed      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_code_reviews_repo_started
  ON code_reviews(repo_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_code_reviews_running
  ON code_reviews(repo_id, started_at DESC) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_code_review_findings_review
  ON code_review_findings(review_id);
CREATE INDEX IF NOT EXISTS idx_security_audits_repo_started
  ON security_audits(repo_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_audits_running
  ON security_audits(repo_id, started_at DESC) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_security_findings_audit
  ON security_findings(audit_id);

CREATE TABLE IF NOT EXISTS pentest_scans (
  id              TEXT PRIMARY KEY,
  repo_id         TEXT NOT NULL REFERENCES repos(id),
  target_type     TEXT NOT NULL DEFAULT 'local',
  target_value    TEXT NOT NULL,
  categories      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  container_id    TEXT,
  summary         TEXT,
  started_at      TEXT NOT NULL,
  completed_at    TEXT,
  max_duration_ms INTEGER DEFAULT 7200000
);

CREATE INDEX IF NOT EXISTS idx_pentest_scans_repo_status ON pentest_scans(repo_id, status);

CREATE TABLE IF NOT EXISTS pentest_findings (
  id                  TEXT PRIMARY KEY,
  scan_id             TEXT NOT NULL REFERENCES pentest_scans(id) ON DELETE CASCADE,
  severity            TEXT NOT NULL,
  category            TEXT NOT NULL,
  owasp_ref           TEXT,
  cwe_ref             TEXT,
  affected_endpoints  TEXT,
  description         TEXT NOT NULL,
  poc_payload         TEXT,
  poc_response        TEXT,
  reproduction_steps  TEXT,
  remediation         TEXT,
  agent_trace         TEXT,
  work_item_id        TEXT,
  dismissed           INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pentest_findings_scan ON pentest_findings(scan_id);

CREATE TABLE IF NOT EXISTS run_commands (
  id           TEXT PRIMARY KEY,
  repo_id      TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  command      TEXT NOT NULL,
  source       TEXT NOT NULL,
  last_used_at TEXT,
  pinned       INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_run_commands_repo ON run_commands(repo_id);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  definition_state TEXT NOT NULL DEFAULT 'ready',
  bootstrap_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_repos (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  added_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, repo_id)
);

-- Portable repo membership in a synced workspace definition. repo_id in
-- workspace_repos is a device-local checkout reference; portable_id is the
-- stable cross-device identity a definition carries. mapped_repo_id stays
-- null until the device maps the entry to a local checkout (WS-01).
CREATE TABLE IF NOT EXISTS workspace_repo_definitions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  portable_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  remote_url TEXT,
  default_branch TEXT,
  mapped_repo_id TEXT REFERENCES repos(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, portable_id)
);

-- WS-03: local bootstrap approval records. A record pins the sha256 digest
-- of recipe content + repository commits + effective execution policy —
-- a changed input can never silently reuse an old approval. Approvals are
-- device-local and NEVER sync; each target approves for itself.
CREATE TABLE IF NOT EXISTS bootstrap_approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  digest TEXT NOT NULL,
  recipe_json TEXT NOT NULL,
  repository_commits_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  shell_approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, digest)
);

-- WS-03: bootstrap run journal — step outcomes + bounded evidence per
-- workspace replica. state 'awaiting-approval' parks a run whose digest
-- no current approval covers.
CREATE TABLE IF NOT EXISTS bootstrap_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  definition_revision TEXT,
  digest TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('awaiting-approval', 'running', 'verified', 'failed', 'unknown-outcome')),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bootstrap_runs_workspace
  ON bootstrap_runs(workspace_id, state);

CREATE TABLE IF NOT EXISTS bootstrap_run_steps (
  run_id TEXT NOT NULL REFERENCES bootstrap_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('pending', 'running', 'verified', 'failed', 'unknown-outcome')),
  log_tail TEXT,
  exit_code INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, step_id)
);

CREATE TABLE IF NOT EXISTS editable_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT 'Bot',
  colour TEXT NOT NULL DEFAULT '#64748b',
  prompt_body TEXT NOT NULL DEFAULT '',
  can_write_files INTEGER NOT NULL DEFAULT 1,
  can_run_commands INTEGER NOT NULL DEFAULT 1,
  can_read_files INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- MESH-02: device-local worker opt-in + incarnation bookkeeping (never synced).
CREATE TABLE IF NOT EXISTS mesh_worker_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  incarnation TEXT,
  lease_expires_at TEXT,
  connected_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

-- Local attempt journal, written before any process/work starts.
CREATE TABLE IF NOT EXISTS mesh_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  incarnation TEXT NOT NULL,
  fence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  journal_json TEXT NOT NULL DEFAULT '[]',
  sealed_inputs_json TEXT,
  result_json TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mesh_attempts_state ON mesh_attempts(state);

-- SESSION-03: local session-ownership mirror of the backend's generation
-- authority. 'relinquished' is written BEFORE the backend advance so a
-- restart honours it; absence of a row means an ordinary local-only
-- session that needs no lease (spec §11).
CREATE TABLE IF NOT EXISTS mesh_session_ownership (
  session_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  owner_enrollment_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('owned', 'relinquished')),
  updated_at TEXT NOT NULL
);

-- Local mirror of handoff participation for boot reconciliation: role is
-- this device's side; state is the last durably observed backend state.
CREATE TABLE IF NOT EXISTS mesh_handoff_journal (
  handoff_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('source', 'target')),
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mesh_handoff_journal_session
  ON mesh_handoff_journal(session_id);

-- FLOW-02: parent-side node dispatch records. The dispatch id is the
-- stable identity — a parent restart re-adopts the recorded job rather
-- than recreating one (spec §449).
CREATE TABLE IF NOT EXISTS mesh_node_dispatches (
  dispatch_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  job_id TEXT,
  request_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  request_json TEXT,
  state TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  output_json TEXT,
  placement_explanation TEXT,
  resolved_enrollment_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mesh_node_dispatches_state
  ON mesh_node_dispatches(state);

-- FLOW-03: durable integration runs. An integration applies adopted node
-- results in declared dependency order inside its own worktree; the row
-- records the outcome — integrated commit, visible conflicts, or failure —
-- and the working state for resume/inspection (spec §457).
CREATE TABLE IF NOT EXISTS mesh_integrations (
  integration_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  dispatch_ids_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('integrated', 'conflicted', 'failed')),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- WS-02: durable workspace materialisation journal. The op row and its
-- per-repo stage rows are written BEFORE the matching filesystem mutation so
-- a crash mid-clone/link/remove is reconstructable. request_key is the
-- canonical hash of pinned inputs; concurrent identical requests attach to
-- the same running op (partial unique index below).
CREATE TABLE IF NOT EXISTS workspace_materialization_ops (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('clone', 'link', 'remove')),
  definition_revision TEXT,
  request_key TEXT NOT NULL,
  request_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'running'
    CHECK (state IN ('running', 'completed', 'failed', 'awaiting-review')),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wm_ops_running_request
  ON workspace_materialization_ops(request_key) WHERE state = 'running';
CREATE INDEX IF NOT EXISTS idx_wm_ops_workspace
  ON workspace_materialization_ops(workspace_id, state);

-- stage records the last PROVEN step; recovery only trusts these values plus
-- the journaled paths — never a matching directory name.
CREATE TABLE IF NOT EXISTS workspace_materialization_repo_stages (
  op_id TEXT NOT NULL REFERENCES workspace_materialization_ops(id) ON DELETE CASCADE,
  portable_id TEXT NOT NULL,
  remote_url TEXT,
  requested_ref TEXT,
  requested_commit TEXT,
  destination TEXT,
  staging_path TEXT,
  ownership_intent TEXT NOT NULL DEFAULT 'anvil-created'
    CHECK (ownership_intent IN ('anvil-created', 'linked')),
  stage TEXT NOT NULL DEFAULT 'pending' CHECK (stage IN (
    'pending', 'destination-reserved', 'cloned-to-staging', 'checkout-verified',
    'commit-recorded', 'checks-recorded', 'mapping-published', 'detached',
    'quarantined', 'failed', 'unsupported'
  )),
  stage_reason TEXT,
  resolved_commit TEXT,
  repo_id TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (op_id, portable_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wm_repo_stages_active_destination
  ON workspace_materialization_repo_stages(destination)
  WHERE stage NOT IN ('failed', 'unsupported', 'mapping-published', 'detached', 'quarantined')
    AND destination IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_preferences (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  workitems_json TEXT,
  docs_json TEXT,
  launch_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_scaffold_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  status TEXT NOT NULL,
  completion_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_workspace_scaffold_sessions_status
  ON workspace_scaffold_sessions(status);

CREATE TABLE IF NOT EXISTS automation_definitions (
  workflow_template_id TEXT,
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  repo_ids_json TEXT NOT NULL DEFAULT '[]',
  trigger_mode TEXT NOT NULL DEFAULT 'schedule',
  watch_event TEXT,
  watch_target_json TEXT,
  watch_state_json TEXT,
  schedule_cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  allow_repo_write INTEGER NOT NULL DEFAULT 0,
  allow_command_run INTEGER NOT NULL DEFAULT 0,
  loop_config_json TEXT,
  execution_mode TEXT NOT NULL DEFAULT 'disposable-worktree',
  last_run_at TEXT,
  next_run_at TEXT,
  last_run_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automation_definitions_workspace
  ON automation_definitions(workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_automation_definitions_due
  ON automation_definitions(enabled, next_run_at);

CREATE INDEX IF NOT EXISTS idx_automation_definitions_watchtower
  ON automation_definitions(workspace_id, enabled, trigger_mode, watch_event);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automation_definitions(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,
  trigger_context_json TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  assistant_message TEXT,
  error_message TEXT,
  changed_file_count INTEGER NOT NULL DEFAULT 0,
  worktrees_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_automation
  ON automation_runs(automation_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_automation_runs_status
  ON automation_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS automation_run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automation_run_events_run
  ON automation_run_events(run_id, created_at ASC);

CREATE TABLE IF NOT EXISTS watchtower_events (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automation_definitions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  observed_at TEXT NOT NULL,
  dispatched_at TEXT,
  run_id TEXT REFERENCES automation_runs(id) ON DELETE SET NULL,
  UNIQUE(automation_id, event_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_watchtower_events_pending
  ON watchtower_events(status, observed_at ASC);

CREATE TABLE IF NOT EXISTS dojo_configs (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  lookback_days INTEGER NOT NULL DEFAULT 30,
  schedule_cron TEXT NOT NULL DEFAULT '0 9 * * 1',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  last_run_at TEXT,
  next_run_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dojo_configs_due
  ON dojo_configs(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS dojo_reports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  analysis_json TEXT,
  sample_message_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_dojo_reports_workspace
  ON dojo_reports(workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS governance_boards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS governance_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  board_id TEXT REFERENCES governance_boards(id) ON DELETE SET NULL,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS db_insight_artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  category TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_db_insight_artifacts_workspace
  ON db_insight_artifacts(workspace_id);

CREATE TABLE IF NOT EXISTS db_insight_analyses (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  artifact_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'running',
  summary TEXT,
  database_name TEXT,
  table_count INTEGER NOT NULL DEFAULT 0,
  procedure_count INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  function_count INTEGER NOT NULL DEFAULT 0,
  tables_json TEXT NOT NULL DEFAULT '[]',
  procedures_json TEXT NOT NULL DEFAULT '[]',
  relationships_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '[]',
  recommended_questions_json TEXT NOT NULL DEFAULT '[]',
  raw_snapshot_json TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_db_insight_analyses_workspace
  ON db_insight_analyses(workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS lifecycle_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  stage TEXT NOT NULL DEFAULT 'concept',
  linked_work_item_id TEXT,
  linked_work_item_provider TEXT,
  change_classification TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lifecycle_stages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_stages_workspace_order
  ON lifecycle_stages(workspace_id, sort_order);

CREATE TABLE IF NOT EXISTS lifecycle_item_repos (
  lifecycle_item_id TEXT NOT NULL REFERENCES lifecycle_items(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  PRIMARY KEY (lifecycle_item_id, repo_id)
);

CREATE TABLE IF NOT EXISTS gate_templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  gate TEXT NOT NULL,
  label TEXT NOT NULL,
  criteria TEXT NOT NULL DEFAULT '[]',
  UNIQUE(workspace_id, gate)
);

CREATE TABLE IF NOT EXISTS gate_decisions (
  id TEXT PRIMARY KEY,
  lifecycle_item_id TEXT NOT NULL REFERENCES lifecycle_items(id) ON DELETE CASCADE,
  gate TEXT NOT NULL,
  decision TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  conditions TEXT,
  rationale TEXT,
  decided_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS impact_analyses (
  id TEXT PRIMARY KEY,
  lifecycle_item_id TEXT NOT NULL REFERENCES lifecycle_items(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_ref TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  executive_summary TEXT,
  risk_rating TEXT,
  affected_modules TEXT DEFAULT '[]',
  technology_changes TEXT DEFAULT '[]',
  cross_cutting_concerns TEXT DEFAULT '[]',
  technical_appendix TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS handover_packs (
  id TEXT PRIMARY KEY,
  lifecycle_item_id TEXT NOT NULL REFERENCES lifecycle_items(id) ON DELETE CASCADE,
  generated_at TEXT NOT NULL,
  output_path TEXT NOT NULL,
  sections TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS dojo_execution_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  event_json TEXT NOT NULL,
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dojo_execution_events_session ON dojo_execution_events(session_id, timestamp);
CREATE TABLE IF NOT EXISTS dojo_deliveries (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_item TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, work_item)
);
CREATE TABLE IF NOT EXISTS dojo_prices (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input REAL NOT NULL,
  cached_input REAL NOT NULL,
  output REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, model)
);
CREATE TABLE IF NOT EXISTS dojo_recommendation_states (
  report_id TEXT NOT NULL REFERENCES dojo_reports(id) ON DELETE CASCADE,
  recommendation_key TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  applied_at TEXT,
  PRIMARY KEY (report_id, recommendation_key)
);
CREATE TABLE IF NOT EXISTS device_enrollments (
  id TEXT PRIMARY KEY,
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  dataset_epoch TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  enrollment_generation INTEGER NOT NULL DEFAULT 1,
  next_sequence INTEGER NOT NULL DEFAULT 1,
  display_name TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('active', 'revoked', 'pending')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_enrollments_scope
  ON device_enrollments(backend_id, account_id, dataset_epoch);
CREATE TABLE IF NOT EXISTS sync_bindings (
  id TEXT PRIMARY KEY,
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  dataset_epoch TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  base_revision INTEGER,
  base_payload_json TEXT,
  local_edit_generation INTEGER NOT NULL DEFAULT 0,
  acknowledged_generation INTEGER NOT NULL DEFAULT 0,
  quarantine_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_bindings_scope_entity
  ON sync_bindings(backend_id, account_id, dataset_epoch, entity_type, entity_id);
CREATE TABLE IF NOT EXISTS sync_outbox (
  change_id TEXT PRIMARY KEY,
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  dataset_epoch TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  enrollment_sequence INTEGER,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  base_revision INTEGER,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  payload_json TEXT,
  payload_hash TEXT NOT NULL,
  local_edit_generation INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'dispatched', 'acknowledged', 'conflict', 'rejected')),
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  result_json TEXT,
  sealed_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_scope_state
  ON sync_outbox(backend_id, account_id, dataset_epoch, state, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_outbox_dispatched_entity
  ON sync_outbox(backend_id, account_id, dataset_epoch, entity_type, entity_id)
  WHERE state = 'dispatched';
CREATE TABLE IF NOT EXISTS sync_state (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  dataset_epoch TEXT NOT NULL,
  cursor TEXT,
  last_pull_at TEXT,
  last_push_at TEXT,
  consumed_sequence_high_water INTEGER NOT NULL DEFAULT 0,
  retention_floor_sequence INTEGER,
  protocol_version TEXT,
  server_limits_json TEXT,
  reset_required INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, dataset_epoch)
);
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id TEXT PRIMARY KEY,
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  dataset_epoch TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  base_payload_json TEXT,
  local_payload_json TEXT,
  remote_payload_json TEXT,
  base_revision INTEGER,
  remote_revision INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('edit-edit', 'edit-delete', 'delete-edit')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT CHECK (resolution IN ('keep-local', 'use-remote', 'save-copy'))
);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_scope_entity
  ON sync_conflicts(backend_id, account_id, dataset_epoch, entity_type, entity_id);
CREATE TABLE IF NOT EXISTS sync_backends (
  id TEXT PRIMARY KEY,
  base_url TEXT NOT NULL,
  deployment_id TEXT,
  display_name TEXT,
  profiles_json TEXT NOT NULL,
  auth_modes_json TEXT NOT NULL,
  pinned_descriptor_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','paused','disconnected')),
  connection_mode TEXT NOT NULL DEFAULT 'compatible'
    CHECK (connection_mode IN ('hosted','cloudflare','compatible')),
  identity_review_required INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_backends_one_active
  ON sync_backends(state) WHERE state = 'active';
CREATE TABLE IF NOT EXISTS sync_installation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  installation_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_scan_runs (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  dataset_epoch TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  watermark_start INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, dataset_epoch)
);
CREATE TABLE IF NOT EXISTS sync_scan_staging (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  dataset_epoch TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  payload_json TEXT,
  PRIMARY KEY (backend_id, account_id, dataset_epoch, entity_type, entity_id)
);
-- BILL-05: last-known hosted entitlement per (backend, account). Self-host
-- backends never write a row; restricted pauses sync writes only — pulls,
-- outbox, cursors, and conflicts are untouched. No secrets or tokens.
CREATE TABLE IF NOT EXISTS sync_entitlement (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  state TEXT NOT NULL,
  source TEXT NOT NULL,
  plan_key TEXT,
  preview_ends_at TEXT,
  access_until TEXT,
  grace_until TEXT,
  checked_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  restricted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id)
);
-- E2E key material. Keyed by (backend, account) — the account data key
-- survives dataset-epoch rotation. key_wrapped is safeStorage-encrypted
-- ADK bytes; nothing here is ever sent to the backend.
CREATE TABLE IF NOT EXISTS sync_keyring (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  key_wrapped BLOB NOT NULL,
  source TEXT NOT NULL DEFAULT 'minted' CHECK (source IN ('minted', 'wrap', 'pairing', 'rotation', 'recovery')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, key_version)
);
-- Client-only recovery secret custody. secret_wrapped is safeStorage
-- encrypted and is never serialized into sync entities or sent to a backend.
CREATE TABLE IF NOT EXISTS sync_recovery_secrets (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  recovery_id TEXT NOT NULL,
  secret_wrapped BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  invalidated_at TEXT,
  PRIMARY KEY (backend_id, account_id)
);
-- Server-authorized first-device bootstrap eligibility. A keyless device may
-- mint ADK v1 only after security.get confirms this enrollment is the durable
-- first-device authority; the row is local and scoped to backend/account.
CREATE TABLE IF NOT EXISTS sync_key_bootstrap_eligibility (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  eligible INTEGER NOT NULL DEFAULT 0 CHECK (eligible IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, enrollment_id)
);
-- Per-enrollment X25519 device identities. identity_priv_wrapped is set
-- only on this device's own enrollment row; other rows are pubkey-only
-- caches learned from device-identity entities.
CREATE TABLE IF NOT EXISTS sync_device_keys (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  identity_pub TEXT NOT NULL,
  identity_priv_wrapped BLOB,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, enrollment_id)
);
-- Out-of-band pairing secrets. secret_wrapped is safeStorage-encrypted;
-- role 'issuer' minted the pairing payload, 'redeemer' typed it in and is
-- awaiting the matching keyring-pairing entity. Scoped by
-- (backend, account) so a nonce can never resolve across accounts.
-- proof_nonce (migration 85) is the redemption proof the new device
-- echoes in its keyring-paired entity so the issuer promotes it to
-- trusted membership.
CREATE TABLE IF NOT EXISTS sync_pairing (
  nonce TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  secret_wrapped BLOB NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('issuer', 'redeemer')),
  proof_nonce TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, nonce)
);
-- Per-enrollment decrypt membership (migration 85). Enrollment is
-- authentication only — 'trusted' marks permission to receive ADK
-- deliveries; 'pending' devices sync metadata but get no wraps; 'revoked'
-- is sticky and survives identity re-announcement.
CREATE TABLE IF NOT EXISTS sync_device_trust (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'trusted', 'revoked')),
  decided_at TEXT,
  PRIMARY KEY (backend_id, account_id, enrollment_id)
);
-- Local rotation ledger (migration 85): records rotations this device
-- minted so keyring.report can mark them completed account-side.
CREATE TABLE IF NOT EXISTS sync_keyring_rotations (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  rotation_id TEXT NOT NULL,
  rotor_enrollment_id TEXT NOT NULL DEFAULT '',
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  revoked_json TEXT NOT NULL DEFAULT '[]',
  local_origin INTEGER NOT NULL DEFAULT 0 CHECK (local_origin IN (0, 1)),
  reported_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, rotation_id)
);
-- Local-only completion fence for account revocations. Backend rotation
-- entities are evidence, not proof that this device completed its own
-- post-revocation ADK rotation.
CREATE TABLE IF NOT EXISTS sync_revocation_rotations (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  rotated_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, enrollment_id)
);
-- Task content keys this device holds — as job source or designated
-- result recipient. key_wrapped is safeStorage-encrypted.
CREATE TABLE IF NOT EXISTS mesh_task_keys (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  key_wrapped BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, job_id)
);
-- Dashboard grants this device issued (or pending requests it observed):
-- the wrapped DSK it must reuse to publish follow-up snapshots, plus the
-- granted scopes and latest seq. state 'pending' rows are observed
-- requests awaiting a local decision — they have no DSK yet.
CREATE TABLE IF NOT EXISTS mesh_dashboard_grants (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  browser_pub TEXT NOT NULL,
  dsk_wrapped BLOB,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  workspace_id TEXT,
  repo_ids_json TEXT NOT NULL DEFAULT '[]',
  enrollment_id TEXT,
  expires_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  request_json TEXT,
  last_published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, request_id)
);
-- Browser workspace command receipts. An executing row is a crash fence:
-- recovery marks it uncertain and never re-runs the command automatically.
-- Result bytes are safeStorage-wrapped and never exposed to the renderer.
CREATE TABLE IF NOT EXISTS mesh_browser_command_receipts (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  repo_id TEXT,
  expires_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  command_envelope_json TEXT,
  claim_fence INTEGER,
  state TEXT NOT NULL CHECK (state IN ('executing', 'completed', 'failed', 'uncertain')),
  result_wrapped BLOB,
  result_envelope_json TEXT,
  result_published INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (backend_id, account_id, grant_id, command_id)
);
CREATE INDEX IF NOT EXISTS idx_mesh_browser_command_receipts_state
  ON mesh_browser_command_receipts (backend_id, account_id, state, updated_at);
-- Delivery ledger: which ADK versions this device has wrapped to which
-- enrollment, so re-wraps on rotation are idempotent.
CREATE TABLE IF NOT EXISTS sync_keyring_deliveries (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, enrollment_id, key_version)
);
-- Authenticated keyring wraps that arrived before the sender was locally
-- verified. The ciphertext remains local-only until SAS approval permits
-- retry; no plaintext ADK is stored here.
CREATE TABLE IF NOT EXISTS sync_keyring_pending_wraps (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  recipient_enrollment_id TEXT NOT NULL,
  sender_enrollment_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, recipient_enrollment_id, payload_hash)
);
-- ENV-01 cloud environments. Keep in sync with the migration 84 copies.
CREATE TABLE IF NOT EXISTS cloud_provider_connections (
  id TEXT PRIMARY KEY,
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  display_name TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  secret_blob BLOB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cloud_provider_connections_scope
  ON cloud_provider_connections (backend_id, account_id, provider);
CREATE TABLE IF NOT EXISTS cloud_environments (
  environment_id TEXT PRIMARY KEY,
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  state TEXT NOT NULL,
  handle_json TEXT,
  enrollment_id TEXT,
  job_id TEXT,
  connection_id TEXT,
  created_by TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cloud_environments_scope
  ON cloud_environments (backend_id, account_id, state);
-- Local-first activation funnel events (§7 Measurement). Rows are never
-- transmitted; they exist only for local funnel analysis.
CREATE TABLE IF NOT EXISTS activation_events (
  id INTEGER PRIMARY KEY,
  event TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activation_events_event_created
  ON activation_events (event, created_at);
`;

/**
 * Migrations from one schema version to the next.
 * Key = target version. SQL runs when upgrading from version-1 to version.
 */
export const MIGRATIONS: Record<number, string> = {
  2: `
    ALTER TABLE settings ADD COLUMN llm_provider TEXT DEFAULT 'openai';
    ALTER TABLE settings ADD COLUMN openai_api_key BLOB;
    ALTER TABLE settings ADD COLUMN openai_model TEXT DEFAULT 'gpt-5.4';
  `,
  3: `
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      repo_id TEXT REFERENCES repos(id),
      persona_id TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT
    );
    ALTER TABLE chat_messages ADD COLUMN session_id TEXT REFERENCES chat_sessions(id);
    ALTER TABLE chat_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'user';
    ALTER TABLE chat_messages ADD COLUMN event_json TEXT;
    ALTER TABLE work_items_cache ADD COLUMN tags TEXT;
    ALTER TABLE work_items_cache ADD COLUMN iteration_path TEXT;
    ALTER TABLE work_items_cache ADD COLUMN parent_id TEXT;
  `,
  4: `
    ALTER TABLE settings ADD COLUMN work_item_provider TEXT DEFAULT 'ado';
    ALTER TABLE settings ADD COLUMN linear_api_key BLOB;
    ALTER TABLE settings ADD COLUMN linear_team_id TEXT;
    ALTER TABLE settings ADD COLUMN jira_host TEXT;
    ALTER TABLE settings ADD COLUMN jira_auth_mode TEXT DEFAULT 'cloud';
    ALTER TABLE settings ADD COLUMN jira_project TEXT;
    ALTER TABLE settings ADD COLUMN jira_board_id TEXT;
    ALTER TABLE settings ADD COLUMN jira_email TEXT;
    ALTER TABLE settings ADD COLUMN jira_api_token BLOB;
  `,
  5: `
    CREATE TABLE IF NOT EXISTS ba_sessions (
      id              TEXT PRIMARY KEY,
      work_item_id    TEXT NOT NULL,
      repo_id         TEXT NOT NULL,
      spike_branch    TEXT NOT NULL,
      origin_branch   TEXT NOT NULL,
      stash_ref       TEXT,
      status          TEXT NOT NULL DEFAULT 'active',
      started_at      TEXT NOT NULL,
      ended_at        TEXT
    );

    CREATE TABLE IF NOT EXISTS ba_findings (
      id                TEXT PRIMARY KEY,
      work_item_id      TEXT NOT NULL,
      repo_id           TEXT NOT NULL,
      session_id        TEXT,
      type              TEXT NOT NULL,
      content           TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'open',
      source_message_id TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ba_repo_links (
      work_item_id TEXT PRIMARY KEY,
      repo_id      TEXT NOT NULL,
      linked_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ba_messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES ba_sessions(id),
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      event_type  TEXT,
      created_at  TEXT NOT NULL
    );
  `,
  6: `
    CREATE TABLE IF NOT EXISTS security_audits (
      id            TEXT PRIMARY KEY,
      repo_id       TEXT NOT NULL REFERENCES repos(id),
      scope         TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'running',
      summary       TEXT,
      started_at    TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT,
      model_version TEXT
    );

    CREATE TABLE IF NOT EXISTS security_findings (
      id             TEXT PRIMARY KEY,
      audit_id       TEXT NOT NULL REFERENCES security_audits(id),
      severity       TEXT NOT NULL,
      category       TEXT NOT NULL,
      owasp_ref      TEXT,
      cwe_ref        TEXT,
      affected_files TEXT,
      description    TEXT NOT NULL,
      remediation    TEXT,
      work_item_id   TEXT,
      dismissed      INTEGER NOT NULL DEFAULT 0
    );
  `,
  7: `
    CREATE TABLE IF NOT EXISTS code_reviews (
      id            TEXT PRIMARY KEY,
      repo_id       TEXT NOT NULL REFERENCES repos(id),
      mode          TEXT NOT NULL,
      scope_type    TEXT NOT NULL,
      scope_ref     TEXT,
      status        TEXT NOT NULL DEFAULT 'running',
      summary       TEXT,
      rubric_used   TEXT,
      started_at    TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS code_review_findings (
      id            TEXT PRIMARY KEY,
      review_id     TEXT NOT NULL REFERENCES code_reviews(id),
      severity      TEXT NOT NULL,
      category      TEXT NOT NULL,
      file_path     TEXT,
      line_start    INTEGER,
      line_end      INTEGER,
      description   TEXT NOT NULL,
      suggestion    TEXT,
      work_item_id  TEXT,
      pr_comment_id TEXT,
      pr_comment_url TEXT,
      pr_commented_at TEXT,
      dismissed     INTEGER NOT NULL DEFAULT 0
    );

    ALTER TABLE settings ADD COLUMN code_review_quick_glance_rubric TEXT;
    ALTER TABLE settings ADD COLUMN code_review_senior_dev_rubric TEXT;
    CREATE TABLE IF NOT EXISTS diagrams (
      id              TEXT PRIMARY KEY,
      repo_id         TEXT REFERENCES repos(id),
      session_id      TEXT,
      session_type    TEXT CHECK(session_type IN ('chat', 'ba') OR session_type IS NULL),
      title           TEXT NOT NULL,
      drawio_xml      TEXT NOT NULL,
      mermaid_fallback TEXT,
      source_context  TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    )
  `,
  8: `
    DROP TABLE IF EXISTS diagrams;
  `,
  9: `
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_repos (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      repo_id TEXT NOT NULL REFERENCES repos(id),
      added_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, repo_id)
    );

    ALTER TABLE settings ADD COLUMN active_workspace_id TEXT;
    ALTER TABLE settings ADD COLUMN github_pat BLOB;
    ALTER TABLE settings ADD COLUMN github_username TEXT;
  `,
  10: `
    ALTER TABLE settings ADD COLUMN user_role TEXT;
  `,
  11: `
    CREATE TABLE IF NOT EXISTS governance_boards (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS governance_documents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      board_id TEXT REFERENCES governance_boards(id) ON DELETE SET NULL,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      added_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
  12: `
    ALTER TABLE repo_summaries ADD COLUMN index_mode TEXT DEFAULT 'light';
    ALTER TABLE repo_summaries ADD COLUMN index_provider TEXT;
    ALTER TABLE repo_summaries ADD COLUMN index_warnings TEXT;
  `,
  13: `
    CREATE TABLE IF NOT EXISTS workspace_preferences (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      workitems_json TEXT,
      docs_json TEXT,
      launch_json TEXT,
      updated_at TEXT NOT NULL
    );
  `,
  15: `
    CREATE TABLE IF NOT EXISTS pentest_scans (
      id              TEXT PRIMARY KEY,
      repo_id         TEXT NOT NULL REFERENCES repos(id),
      target_type     TEXT NOT NULL DEFAULT 'local',
      target_value    TEXT NOT NULL,
      categories      TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      container_id    TEXT,
      summary         TEXT,
      started_at      TEXT NOT NULL,
      completed_at    TEXT,
      max_duration_ms INTEGER DEFAULT 7200000
    );

    CREATE INDEX IF NOT EXISTS idx_pentest_scans_repo_status ON pentest_scans(repo_id, status);

    CREATE TABLE IF NOT EXISTS pentest_findings (
      id                  TEXT PRIMARY KEY,
      scan_id             TEXT NOT NULL REFERENCES pentest_scans(id) ON DELETE CASCADE,
      severity            TEXT NOT NULL,
      category            TEXT NOT NULL,
      owasp_ref           TEXT,
      cwe_ref             TEXT,
      affected_endpoints  TEXT,
      description         TEXT NOT NULL,
      poc_payload         TEXT,
      poc_response        TEXT,
      reproduction_steps  TEXT,
      remediation         TEXT,
      agent_trace         TEXT,
      work_item_id        TEXT,
      dismissed           INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_pentest_findings_scan ON pentest_findings(scan_id);
  `,
  14: `
    CREATE TABLE IF NOT EXISTS lifecycle_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      stage TEXT NOT NULL DEFAULT 'concept',
      linked_work_item_id TEXT,
      linked_work_item_provider TEXT,
      change_classification TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lifecycle_item_repos (
      lifecycle_item_id TEXT NOT NULL REFERENCES lifecycle_items(id) ON DELETE CASCADE,
      repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      PRIMARY KEY (lifecycle_item_id, repo_id)
    );

    CREATE TABLE IF NOT EXISTS gate_templates (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      gate TEXT NOT NULL,
      label TEXT NOT NULL,
      criteria TEXT NOT NULL DEFAULT '[]',
      UNIQUE(workspace_id, gate)
    );

    CREATE TABLE IF NOT EXISTS gate_decisions (
      id TEXT PRIMARY KEY,
      lifecycle_item_id TEXT NOT NULL REFERENCES lifecycle_items(id) ON DELETE CASCADE,
      gate TEXT NOT NULL,
      decision TEXT NOT NULL,
      decided_by TEXT NOT NULL,
      conditions TEXT,
      rationale TEXT,
      decided_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS impact_analyses (
      id TEXT PRIMARY KEY,
      lifecycle_item_id TEXT NOT NULL REFERENCES lifecycle_items(id) ON DELETE CASCADE,
      scope_type TEXT NOT NULL,
      scope_ref TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      executive_summary TEXT,
      risk_rating TEXT,
      affected_modules TEXT DEFAULT '[]',
      technology_changes TEXT DEFAULT '[]',
      cross_cutting_concerns TEXT DEFAULT '[]',
      technical_appendix TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS handover_packs (
      id TEXT PRIMARY KEY,
      lifecycle_item_id TEXT NOT NULL REFERENCES lifecycle_items(id) ON DELETE CASCADE,
      generated_at TEXT NOT NULL,
      output_path TEXT NOT NULL,
      sections TEXT NOT NULL DEFAULT '[]'
    );
  `,
  16: `
    CREATE TABLE IF NOT EXISTS run_commands (
      id           TEXT PRIMARY KEY,
      repo_id      TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      label        TEXT NOT NULL,
      command      TEXT NOT NULL,
      source       TEXT NOT NULL,
      last_used_at TEXT,
      pinned       INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_run_commands_repo ON run_commands(repo_id);
  `,
  17: `
    CREATE TABLE IF NOT EXISTS workspace_scaffold_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
      root_path TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      status TEXT NOT NULL,
      completion_json TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_scaffold_sessions_status
      ON workspace_scaffold_sessions(status);
  `,
  18: `
    ALTER TABLE code_review_findings ADD COLUMN pr_comment_id TEXT;
    ALTER TABLE code_review_findings ADD COLUMN pr_comment_url TEXT;
    ALTER TABLE code_review_findings ADD COLUMN pr_commented_at TEXT;
  `,
  19: `
    CREATE TABLE IF NOT EXISTS db_insight_artifacts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      category TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_db_insight_artifacts_workspace
      ON db_insight_artifacts(workspace_id);

    CREATE TABLE IF NOT EXISTS db_insight_analyses (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      artifact_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'running',
      summary TEXT,
      database_name TEXT,
      table_count INTEGER NOT NULL DEFAULT 0,
      procedure_count INTEGER NOT NULL DEFAULT 0,
      view_count INTEGER NOT NULL DEFAULT 0,
      function_count INTEGER NOT NULL DEFAULT 0,
      tables_json TEXT NOT NULL DEFAULT '[]',
      procedures_json TEXT NOT NULL DEFAULT '[]',
      relationships_json TEXT NOT NULL DEFAULT '[]',
      risks_json TEXT NOT NULL DEFAULT '[]',
      recommended_questions_json TEXT NOT NULL DEFAULT '[]',
      raw_snapshot_json TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_db_insight_analyses_workspace
      ON db_insight_analyses(workspace_id, started_at DESC);
  `,
  20: `
    ALTER TABLE settings ADD COLUMN docs_provider TEXT DEFAULT 'confluence';
    ALTER TABLE settings ADD COLUMN notion_oauth_token BLOB;
    ALTER TABLE settings ADD COLUMN notion_oauth_expiry TEXT;
    ALTER TABLE settings ADD COLUMN notion_database_id TEXT;
  `,
  21: `
    ALTER TABLE settings ADD COLUMN reasoning_level TEXT DEFAULT 'medium';
    ALTER TABLE chat_messages ADD COLUMN branch_id TEXT;
    ALTER TABLE chat_messages ADD COLUMN parent_id TEXT;
    UPDATE settings SET openai_model = 'gpt-5.5' WHERE openai_model = 'gpt-5.4';
  `,
  22: `
    CREATE TABLE IF NOT EXISTS chat_threads (
      id TEXT PRIMARY KEY,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
      persona_id TEXT NOT NULL,
      title TEXT NOT NULL,
      repo_ids_json TEXT NOT NULL DEFAULT '[]',
      active_repo_id TEXT REFERENCES repos(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_message_at TEXT
    );

    ALTER TABLE chat_sessions ADD COLUMN thread_id TEXT REFERENCES chat_threads(id);
    ALTER TABLE chat_messages ADD COLUMN thread_id TEXT REFERENCES chat_threads(id);

    INSERT OR IGNORE INTO chat_threads (
      id,
      workspace_id,
      persona_id,
      title,
      repo_ids_json,
      active_repo_id,
      created_at,
      updated_at,
      last_message_at
    )
    SELECT
      'legacy-' || s.id,
      NULL,
      COALESCE(s.persona_id, 'coder'),
      CASE
        WHEN r.name IS NOT NULL THEN 'Imported ' || COALESCE(s.persona_id, 'chat') || ' thread · ' || r.name
        ELSE 'Imported ' || COALESCE(s.persona_id, 'chat') || ' thread'
      END,
      CASE
        WHEN s.repo_id IS NOT NULL THEN '["' || s.repo_id || '"]'
        ELSE '[]'
      END,
      s.repo_id,
      COALESCE(s.started_at, datetime('now')),
      COALESCE(MAX(m.timestamp), s.started_at, datetime('now')),
      MAX(m.timestamp)
    FROM chat_sessions s
    LEFT JOIN chat_messages m ON m.session_id = s.id
    LEFT JOIN repos r ON r.id = s.repo_id
    WHERE s.thread_id IS NULL
    GROUP BY s.id;

    UPDATE chat_sessions
    SET thread_id = 'legacy-' || id
    WHERE thread_id IS NULL;

    UPDATE chat_messages
    SET thread_id = (
      SELECT s.thread_id
      FROM chat_sessions s
      WHERE s.id = chat_messages.session_id
    )
    WHERE thread_id IS NULL AND session_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_chat_threads_workspace_persona
      ON chat_threads(workspace_id, persona_id, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_timestamp
      ON chat_messages(thread_id, timestamp ASC);
  `,
  23: `
    ALTER TABLE ba_findings ADD COLUMN follow_up_work_item_id TEXT;
    ALTER TABLE ba_findings ADD COLUMN follow_up_work_item_provider TEXT;
    ALTER TABLE ba_findings ADD COLUMN follow_up_work_item_title TEXT;
    ALTER TABLE ba_findings ADD COLUMN follow_up_work_item_url TEXT;
  `,
  24: `
    CREATE TABLE IF NOT EXISTS automation_definitions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      repo_ids_json TEXT NOT NULL DEFAULT '[]',
      schedule_cron TEXT NOT NULL,
      timezone TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      allow_repo_write INTEGER NOT NULL DEFAULT 0,
      allow_command_run INTEGER NOT NULL DEFAULT 0,
      execution_mode TEXT NOT NULL DEFAULT 'disposable-worktree',
      last_run_at TEXT,
      next_run_at TEXT,
      last_run_status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_automation_definitions_workspace
      ON automation_definitions(workspace_id, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_automation_definitions_due
      ON automation_definitions(enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automation_definitions(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      assistant_message TEXT,
      error_message TEXT,
      changed_file_count INTEGER NOT NULL DEFAULT 0,
      worktrees_json TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_automation_runs_automation
      ON automation_runs(automation_id, started_at DESC);

    CREATE INDEX IF NOT EXISTS idx_automation_runs_status
      ON automation_runs(status, started_at DESC);

    CREATE TABLE IF NOT EXISTS automation_run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_automation_run_events_run
      ON automation_run_events(run_id, created_at ASC);
  `,
  25: `
    ALTER TABLE code_reviews ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'not_run';
    ALTER TABLE code_reviews ADD COLUMN verification_summary TEXT;
    ALTER TABLE code_reviews ADD COLUMN verification_steps_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE code_reviews ADD COLUMN verification_target_ref TEXT;
    ALTER TABLE code_reviews ADD COLUMN verification_worktree_path TEXT;
    ALTER TABLE code_reviews ADD COLUMN verification_worktree_kept INTEGER NOT NULL DEFAULT 0;
  `,
  26: `
    ALTER TABLE settings ADD COLUMN theme TEXT DEFAULT 'system';
  `,
  27: `
    ALTER TABLE settings ADD COLUMN codex_mode TEXT DEFAULT 'on-request';
  `,
  28: `
    ALTER TABLE chat_messages ADD COLUMN attachments_json TEXT;
  `,
  29: `
    UPDATE gate_templates
    SET label = '', criteria = '[]'
    WHERE label <> '' OR criteria <> '[]';
  `,
  30: `
    ALTER TABLE chat_threads ADD COLUMN active_plan_json TEXT;
    ALTER TABLE chat_threads ADD COLUMN active_plan_updated_at TEXT;
    ALTER TABLE chat_threads ADD COLUMN active_goal_json TEXT;
  `,
  31: `
    CREATE TABLE IF NOT EXISTS mobile_companion_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      host TEXT NOT NULL DEFAULT '0.0.0.0',
      port INTEGER NOT NULL DEFAULT 47631,
      instance_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mobile_companion_devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT
    );
  `,
  32: `
    ALTER TABLE mobile_companion_devices ADD COLUMN client_type TEXT NOT NULL DEFAULT 'mobile';
  `,
  33: `
    ALTER TABLE settings ADD COLUMN apple_foundation_models_mode TEXT DEFAULT 'off';
  `,
  34: `
    CREATE TABLE IF NOT EXISTS workspace_notes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
      repo TEXT,
      body TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      reviewed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_notes_workspace_status
      ON workspace_notes(workspace_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS companion_review_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
      session_id TEXT,
      request_key TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      requested_action TEXT NOT NULL,
      risk TEXT NOT NULL,
      surface TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'later',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_companion_review_items_workspace_status
      ON companion_review_items(workspace_id, status, updated_at DESC);
  `,
  35: `
    ALTER TABLE settings ADD COLUMN chat_layout TEXT DEFAULT 'classic';
    ALTER TABLE chat_threads ADD COLUMN work_item_id TEXT;
    ALTER TABLE chat_threads ADD COLUMN work_item_provider TEXT;
    ALTER TABLE chat_threads ADD COLUMN work_item_title TEXT;

    CREATE INDEX IF NOT EXISTS idx_chat_threads_workspace_work_item
      ON chat_threads(workspace_id, work_item_provider, work_item_id);
  `,
  36: `
    CREATE TABLE IF NOT EXISTS lifecycle_stages (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, stage)
    );

    CREATE INDEX IF NOT EXISTS idx_lifecycle_stages_workspace_order
      ON lifecycle_stages(workspace_id, sort_order);

    INSERT OR IGNORE INTO lifecycle_stages
      (id, workspace_id, stage, label, sort_order, created_at, updated_at)
    SELECT
      id || ':lifecycle-stage:concept',
      id,
      'concept',
      'Concept',
      0,
      datetime('now'),
      datetime('now')
    FROM workspaces;

    INSERT OR IGNORE INTO lifecycle_stages
      (id, workspace_id, stage, label, sort_order, created_at, updated_at)
    SELECT
      id || ':lifecycle-stage:shape',
      id,
      'shape',
      'Shape',
      1,
      datetime('now'),
      datetime('now')
    FROM workspaces;

    INSERT OR IGNORE INTO lifecycle_stages
      (id, workspace_id, stage, label, sort_order, created_at, updated_at)
    SELECT
      id || ':lifecycle-stage:deliver',
      id,
      'deliver',
      'Deliver',
      2,
      datetime('now'),
      datetime('now')
    FROM workspaces;

    INSERT OR IGNORE INTO lifecycle_stages
      (id, workspace_id, stage, label, sort_order, created_at, updated_at)
    SELECT
      id || ':lifecycle-stage:operate',
      id,
      'operate',
      'Operate',
      3,
      datetime('now'),
      datetime('now')
    FROM workspaces;
  `,
  37: `
    ALTER TABLE automation_definitions ADD COLUMN loop_config_json TEXT;
  `,
  38: `
    ALTER TABLE chat_threads ADD COLUMN provider_thread_id TEXT;
    ALTER TABLE chat_sessions ADD COLUMN provider_thread_id TEXT;
    ALTER TABLE chat_sessions ADD COLUMN provider_turn_id TEXT;

    CREATE INDEX IF NOT EXISTS idx_chat_threads_provider_thread
      ON chat_threads(provider_thread_id);

    CREATE TABLE IF NOT EXISTS review_workspace_comments (
      id TEXT PRIMARY KEY,
      repo_id TEXT REFERENCES repos(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      line_number INTEGER,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_review_workspace_comments_repo_status
      ON review_workspace_comments(repo_id, status, created_at DESC);
  `,
  39: `
    ALTER TABLE settings ADD COLUMN cloud_features_enabled INTEGER NOT NULL DEFAULT 0;
  `,
  40: `
    CREATE TABLE IF NOT EXISTS chat_artifacts (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      repo_id TEXT REFERENCES repos(id) ON DELETE SET NULL,
      source_message_id TEXT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      file_path TEXT,
      content TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(thread_id, relative_path)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_artifacts_thread_updated
      ON chat_artifacts(thread_id, updated_at DESC);
  `,
  41: `
    ALTER TABLE ba_sessions ADD COLUMN worktree_path TEXT;
  `,
  42: `
    ALTER TABLE chat_artifacts ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
    ALTER TABLE chat_artifacts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'local';
    ALTER TABLE chat_artifacts ADD COLUMN source TEXT NOT NULL DEFAULT 'assistant';
    ALTER TABLE chat_artifacts ADD COLUMN model TEXT;
    ALTER TABLE chat_artifacts ADD COLUMN reasoning_effort TEXT;

    CREATE TABLE IF NOT EXISTS chat_artifact_revisions (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES chat_artifacts(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      source_message_id TEXT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      file_path TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      visibility TEXT NOT NULL DEFAULT 'local',
      source TEXT NOT NULL DEFAULT 'assistant',
      model TEXT,
      reasoning_effort TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(artifact_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_artifact_revisions_artifact_version
      ON chat_artifact_revisions(artifact_id, version DESC);

    UPDATE settings SET llm_provider = 'codex'
      WHERE llm_provider = 'openai' AND openai_api_key IS NULL;
    UPDATE settings SET openai_model = 'gpt-5.6-sol'
      WHERE openai_model IS NULL OR openai_model IN ('gpt-5.4', 'gpt-5.5');
  `,
  43: `
    CREATE TABLE IF NOT EXISTS workflow_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      graph_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      template_name TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      repo_ids_json TEXT NOT NULL DEFAULT '[]',
      kickoff TEXT NOT NULL,
      status TEXT NOT NULL,
      supervisor_thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      node_runs_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_workspace_created
      ON workflow_runs(workspace_id, created_at DESC);
  `,
  44: `
    ALTER TABLE workflow_runs
      ADD COLUMN graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}';
  `,
  45: `
    ALTER TABLE settings ADD COLUMN work_item_connections BLOB;
    ALTER TABLE settings ADD COLUMN active_work_item_connection_id TEXT;
  `,
  46: `
    ALTER TABLE chat_threads ADD COLUMN attention_state TEXT NOT NULL DEFAULT 'idle';
    ALTER TABLE chat_threads ADD COLUMN attention_updated_at TEXT;
    ALTER TABLE chat_threads ADD COLUMN active_turn_started_at TEXT;
    ALTER TABLE chat_threads ADD COLUMN last_viewed_at TEXT;
    ALTER TABLE chat_threads ADD COLUMN settled_at TEXT;

    CREATE INDEX IF NOT EXISTS idx_chat_threads_inbox
      ON chat_threads(workspace_id, persona_id, settled_at, created_at DESC);
  `,
  47: `
    ALTER TABLE settings ADD COLUMN enabled_llm_providers TEXT;
    UPDATE settings
      SET enabled_llm_providers = json_array(COALESCE(llm_provider, 'codex'))
      WHERE enabled_llm_providers IS NULL;
  `,
  48: `
    ALTER TABLE repo_summaries
      ADD COLUMN map_refresh_mode TEXT NOT NULL DEFAULT 'manual';
    ALTER TABLE repo_summaries ADD COLUMN generated_commit_sha TEXT;
  `,
  49: `
    CREATE TABLE IF NOT EXISTS repository_map_graphs (
      repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
      schema_version INTEGER NOT NULL,
      indexed_commit_sha TEXT,
      graph_json TEXT NOT NULL,
      generated_at TEXT NOT NULL
    );
  `,
  50: `
    CREATE TABLE IF NOT EXISTS pull_request_visualisations (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      review_id TEXT REFERENCES code_reviews(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      pull_request_id TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'generating',
      pull_request_json TEXT NOT NULL,
      summary TEXT,
      intent TEXT,
      data_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at TEXT NOT NULL,
      generated_at TEXT,
      UNIQUE(repo_id, provider, pull_request_id, head_sha)
    );

    CREATE INDEX IF NOT EXISTS idx_pr_visualisations_lookup
      ON pull_request_visualisations(repo_id, provider, pull_request_id, created_at DESC);
  `,
  51: `
    ALTER TABLE chat_artifacts
      ADD COLUMN storage_scope TEXT NOT NULL DEFAULT 'repository';
    ALTER TABLE chat_artifact_revisions
      ADD COLUMN storage_scope TEXT NOT NULL DEFAULT 'repository';
  `,
  52: `
    ALTER TABLE automation_definitions
      ADD COLUMN trigger_mode TEXT NOT NULL DEFAULT 'schedule';
    ALTER TABLE automation_definitions ADD COLUMN watch_event TEXT;
    ALTER TABLE automation_runs ADD COLUMN trigger_context_json TEXT;

    CREATE INDEX IF NOT EXISTS idx_automation_definitions_watchtower
      ON automation_definitions(workspace_id, enabled, trigger_mode, watch_event);
  `,
  53: `
    ALTER TABLE automation_definitions ADD COLUMN watch_target_json TEXT;
    ALTER TABLE automation_definitions ADD COLUMN watch_state_json TEXT;

    CREATE TABLE IF NOT EXISTS watchtower_events (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automation_definitions(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      observed_at TEXT NOT NULL,
      dispatched_at TEXT,
      run_id TEXT REFERENCES automation_runs(id) ON DELETE SET NULL,
      UNIQUE(automation_id, event_type, source_id)
    );

    CREATE INDEX IF NOT EXISTS idx_watchtower_events_pending
      ON watchtower_events(status, observed_at ASC);
  `,
  54: `
    CREATE TABLE IF NOT EXISTS agent_ui_intents (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      workspace_id TEXT,
      run_id TEXT,
      kind TEXT NOT NULL,
      protocol_version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      lifecycle TEXT NOT NULL,
      intent_json TEXT NOT NULL,
      binding_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_ui_intents_thread_lifecycle
      ON agent_ui_intents(thread_id, lifecycle, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_ui_intent_events (
      id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL REFERENCES agent_ui_intents(id) ON DELETE CASCADE,
      actor TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_ui_intent_events_intent
      ON agent_ui_intent_events(intent_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS agent_ui_intent_responses (
      id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL UNIQUE REFERENCES agent_ui_intents(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `,
  55: `
    CREATE TABLE IF NOT EXISTS chat_artifact_annotations (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES chat_artifacts(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      quote TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_artifact_annotations_artifact_updated
      ON chat_artifact_annotations(artifact_id, updated_at DESC);
  `,
  56: `
    CREATE TABLE IF NOT EXISTS cloud_execution_connection (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      endpoint TEXT NOT NULL,
      token BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
  57: `
    ALTER TABLE settings ADD COLUMN local_llm_mode TEXT DEFAULT 'off';
    ALTER TABLE settings ADD COLUMN local_llm_provider TEXT DEFAULT 'apple';
    ALTER TABLE settings ADD COLUMN local_llm_endpoint TEXT;
    ALTER TABLE settings ADD COLUMN local_llm_model TEXT;

    UPDATE settings
      SET local_llm_mode = COALESCE(apple_foundation_models_mode, 'off')
      WHERE local_llm_mode = 'off' AND apple_foundation_models_mode = 'prefer-simple';

    CREATE TABLE IF NOT EXISTS cloud_execution_connection (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      endpoint TEXT NOT NULL,
      token BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
  58: `
    ALTER TABLE settings ADD COLUMN telemetry_enabled INTEGER NOT NULL DEFAULT 0;
  `,
  59: `
    ALTER TABLE chat_threads ADD COLUMN provider_thread_provider TEXT;

    UPDATE chat_threads
      SET provider_thread_provider = 'codex'
      WHERE provider_thread_id IS NOT NULL AND provider_thread_provider IS NULL;
  `,
  60: `
    ALTER TABLE chat_sessions ADD COLUMN provider TEXT;

    UPDATE chat_sessions
      SET provider = COALESCE(
        (SELECT provider_thread_provider
         FROM chat_threads
         WHERE chat_threads.id = chat_sessions.thread_id),
        'codex'
      )
      WHERE provider IS NULL;

    CREATE TABLE IF NOT EXISTS dojo_configs (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0,
      lookback_days INTEGER NOT NULL DEFAULT 30,
      schedule_cron TEXT NOT NULL DEFAULT '0 9 * * 1',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      last_run_at TEXT,
      next_run_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dojo_configs_due
      ON dojo_configs(enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS dojo_reports (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      trigger TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      analysis_json TEXT,
      sample_message_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_dojo_reports_workspace
      ON dojo_reports(workspace_id, started_at DESC);
  `,
  61: `
CREATE TABLE IF NOT EXISTS dojo_execution_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  event_json TEXT NOT NULL,
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dojo_execution_events_session ON dojo_execution_events(session_id, timestamp);
CREATE TABLE IF NOT EXISTS dojo_deliveries (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_item TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, work_item)
);
CREATE TABLE IF NOT EXISTS dojo_prices (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input REAL NOT NULL,
  cached_input REAL NOT NULL,
  output REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, model)
);
CREATE TABLE IF NOT EXISTS dojo_recommendation_states (
  report_id TEXT NOT NULL REFERENCES dojo_reports(id) ON DELETE CASCADE,
  recommendation_key TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  applied_at TEXT,
  PRIMARY KEY (report_id, recommendation_key)
);
`,
  62: `
CREATE TABLE IF NOT EXISTS change_reviews (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  record_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_change_reviews_workspace ON change_reviews(workspace_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS scoped_work_items_cache (
  connection_key TEXT NOT NULL,
  id TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY(connection_key, id)
);
ALTER TABLE code_reviews ADD COLUMN source_tree TEXT;
ALTER TABLE security_audits ADD COLUMN source_tree TEXT;
UPDATE pull_request_visualisations SET status = 'failed' WHERE status = 'ready';
`,
  // Development review/workflow builds also used v62. Reconcile their missing main tables.
  63: `
CREATE TABLE IF NOT EXISTS change_reviews (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  record_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_change_reviews_workspace ON change_reviews(workspace_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS scoped_work_items_cache (
  connection_key TEXT NOT NULL,
  id TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY(connection_key, id)
);
ALTER TABLE code_reviews ADD COLUMN source_tree TEXT;
ALTER TABLE security_audits ADD COLUMN source_tree TEXT;
UPDATE pull_request_visualisations SET status = 'failed' WHERE status = 'ready';
CREATE INDEX IF NOT EXISTS idx_code_reviews_repo_started
  ON code_reviews(repo_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_code_reviews_running
  ON code_reviews(repo_id, started_at DESC) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_code_review_findings_review
  ON code_review_findings(review_id);
CREATE INDEX IF NOT EXISTS idx_security_audits_repo_started
  ON security_audits(repo_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_audits_running
  ON security_audits(repo_id, started_at DESC) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_security_findings_audit
  ON security_findings(audit_id);
  `,
  64: `ALTER TABLE automation_definitions ADD COLUMN workflow_template_id TEXT;`,
  65: `CREATE TABLE IF NOT EXISTS chat_thread_pull_requests (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'ado')),
  pull_request_id TEXT NOT NULL,
  remote_url TEXT NOT NULL,
  pull_request_json TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(thread_id, repo_id, provider, pull_request_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_thread_pr_reverse
  ON chat_thread_pull_requests(repo_id, provider, pull_request_id);
`,
  // Reconcile databases that reached v65 without the v20 docs columns
  // (e.g. a build that stamped a newer schema_version before v20 ran).
  // The migration runner skips statements whose column already exists.
  66: `
ALTER TABLE settings ADD COLUMN docs_provider TEXT DEFAULT 'confluence';
ALTER TABLE settings ADD COLUMN notion_oauth_token BLOB;
ALTER TABLE settings ADD COLUMN notion_oauth_expiry TEXT;
ALTER TABLE settings ADD COLUMN notion_database_id TEXT;
`,
  67: `
ALTER TABLE settings ADD COLUMN llm_gateway_api_key BLOB;
ALTER TABLE settings ADD COLUMN llm_gateway_billing_mode TEXT NOT NULL DEFAULT 'devpass';
`,
  68: `
CREATE TABLE IF NOT EXISTS device_enrollments (
  id TEXT PRIMARY KEY,
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  dataset_epoch TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  enrollment_generation INTEGER NOT NULL DEFAULT 1,
  display_name TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('active', 'revoked', 'pending')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_enrollments_scope
  ON device_enrollments(backend_id, account_id, dataset_epoch);
CREATE TABLE IF NOT EXISTS sync_bindings (
  id TEXT PRIMARY KEY,
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  dataset_epoch TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  base_revision INTEGER,
  base_payload_json TEXT,
  local_edit_generation INTEGER NOT NULL DEFAULT 0,
  acknowledged_generation INTEGER NOT NULL DEFAULT 0,
  quarantine_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_bindings_scope_entity
  ON sync_bindings(backend_id, account_id, dataset_epoch, entity_type, entity_id);
CREATE TABLE IF NOT EXISTS sync_outbox (
  change_id TEXT PRIMARY KEY,
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  dataset_epoch TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  enrollment_sequence INTEGER,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  base_revision INTEGER,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  payload_json TEXT,
  payload_hash TEXT NOT NULL,
  local_edit_generation INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'dispatched', 'acknowledged', 'conflict', 'rejected')),
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  result_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_scope_state
  ON sync_outbox(backend_id, account_id, dataset_epoch, state, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_outbox_dispatched_entity
  ON sync_outbox(backend_id, account_id, dataset_epoch, entity_type, entity_id)
  WHERE state = 'dispatched';
CREATE TABLE IF NOT EXISTS sync_state (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  dataset_epoch TEXT NOT NULL,
  cursor TEXT,
  last_pull_at TEXT,
  last_push_at TEXT,
  consumed_sequence_high_water INTEGER NOT NULL DEFAULT 0,
  retention_floor_sequence INTEGER,
  protocol_version TEXT,
  server_limits_json TEXT,
  reset_required INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, dataset_epoch)
);
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id TEXT PRIMARY KEY,
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  dataset_epoch TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  base_payload_json TEXT,
  local_payload_json TEXT,
  remote_payload_json TEXT,
  base_revision INTEGER,
  remote_revision INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('edit-edit', 'edit-delete', 'delete-edit')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT CHECK (resolution IN ('keep-local', 'use-remote', 'save-copy'))
);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_scope_entity
  ON sync_conflicts(backend_id, account_id, dataset_epoch, entity_type, entity_id);
`,
  69: `
CREATE TABLE IF NOT EXISTS sync_backends (
  id TEXT PRIMARY KEY,
  base_url TEXT NOT NULL,
  deployment_id TEXT,
  display_name TEXT,
  profiles_json TEXT NOT NULL,
  auth_modes_json TEXT NOT NULL,
  pinned_descriptor_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','paused','disconnected')),
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_backends_one_active
  ON sync_backends(state) WHERE state = 'active';
`,
  70: `
ALTER TABLE device_enrollments ADD COLUMN next_sequence INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sync_backends ADD COLUMN identity_review_required INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS sync_installation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  installation_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_scan_runs (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  dataset_epoch TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  watermark_start INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, dataset_epoch)
);
CREATE TABLE IF NOT EXISTS sync_scan_staging (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  dataset_epoch TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  payload_json TEXT,
  PRIMARY KEY (backend_id, account_id, dataset_epoch, entity_type, entity_id)
);
`,
  71: `
ALTER TABLE workspaces ADD COLUMN definition_state TEXT NOT NULL DEFAULT 'ready';
CREATE TABLE IF NOT EXISTS workspace_repo_definitions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  portable_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  remote_url TEXT,
  default_branch TEXT,
  mapped_repo_id TEXT REFERENCES repos(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, portable_id)
);
CREATE TABLE IF NOT EXISTS editable_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT 'Bot',
  colour TEXT NOT NULL DEFAULT '#64748b',
  prompt_body TEXT NOT NULL DEFAULT '',
  can_write_files INTEGER NOT NULL DEFAULT 1,
  can_run_commands INTEGER NOT NULL DEFAULT 1,
  can_read_files INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  72: `
-- MESH-02: device-local worker opt-in + incarnation bookkeeping. The policy
-- is a LOCAL consent record; it is never a synced entity and never enters
-- the outbox. Single-row table (id = 1).
CREATE TABLE IF NOT EXISTS mesh_worker_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  incarnation TEXT,
  lease_expires_at TEXT,
  connected_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
-- Local attempt journal (spec §9): written BEFORE any process/work starts
-- so a crash between spawn and recording is reconstructable. journal_json
-- is an appendable array of {at, event, detail?} entries.
CREATE TABLE IF NOT EXISTS mesh_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  incarnation TEXT NOT NULL,
  fence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  journal_json TEXT NOT NULL DEFAULT '[]',
  result_json TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mesh_attempts_state ON mesh_attempts(state);
`,
  73: `
-- WS-02: durable workspace materialisation journal (spec §7). Written before
-- each filesystem mutation so an interrupted clone/link/remove is
-- reconstructable. Keep in sync with the SCHEMA_SQL copy of these tables.
CREATE TABLE IF NOT EXISTS workspace_materialization_ops (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('clone', 'link', 'remove')),
  definition_revision TEXT,
  request_key TEXT NOT NULL,
  request_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'running'
    CHECK (state IN ('running', 'completed', 'failed', 'awaiting-review')),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wm_ops_running_request
  ON workspace_materialization_ops(request_key) WHERE state = 'running';
CREATE INDEX IF NOT EXISTS idx_wm_ops_workspace
  ON workspace_materialization_ops(workspace_id, state);
CREATE TABLE IF NOT EXISTS workspace_materialization_repo_stages (
  op_id TEXT NOT NULL REFERENCES workspace_materialization_ops(id) ON DELETE CASCADE,
  portable_id TEXT NOT NULL,
  remote_url TEXT,
  requested_ref TEXT,
  requested_commit TEXT,
  destination TEXT,
  staging_path TEXT,
  ownership_intent TEXT NOT NULL DEFAULT 'anvil-created'
    CHECK (ownership_intent IN ('anvil-created', 'linked')),
  stage TEXT NOT NULL DEFAULT 'pending' CHECK (stage IN (
    'pending', 'destination-reserved', 'cloned-to-staging', 'checkout-verified',
    'commit-recorded', 'checks-recorded', 'mapping-published', 'detached',
    'quarantined', 'failed', 'unsupported'
  )),
  stage_reason TEXT,
  resolved_commit TEXT,
  repo_id TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (op_id, portable_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wm_repo_stages_active_destination
  ON workspace_materialization_repo_stages(destination)
  WHERE stage NOT IN ('failed', 'unsupported', 'mapping-published', 'detached', 'quarantined')
    AND destination IS NOT NULL;
`,
  74: `
-- WS-03: bootstrap recipe on the workspace + local-only approval records
-- and the run journal (step outcomes + bounded evidence). Approvals pin a
-- sha256 digest of recipe + commits + effective policy and NEVER sync.
-- Keep in sync with the SCHEMA_SQL copies of these tables.
ALTER TABLE workspaces ADD COLUMN bootstrap_json TEXT;
CREATE TABLE IF NOT EXISTS bootstrap_approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  digest TEXT NOT NULL,
  recipe_json TEXT NOT NULL,
  repository_commits_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  shell_approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, digest)
);
CREATE TABLE IF NOT EXISTS bootstrap_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  definition_revision TEXT,
  digest TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('awaiting-approval', 'running', 'verified', 'failed', 'unknown-outcome')),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bootstrap_runs_workspace
  ON bootstrap_runs(workspace_id, state);
CREATE TABLE IF NOT EXISTS bootstrap_run_steps (
  run_id TEXT NOT NULL REFERENCES bootstrap_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('pending', 'running', 'verified', 'failed', 'unknown-outcome')),
  log_tail TEXT,
  exit_code INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, step_id)
);
`,
  75: `
-- SESSION-03: local session-ownership mirror + handoff participation
-- journal. Keep in sync with the SCHEMA_SQL copies of these tables.
CREATE TABLE IF NOT EXISTS mesh_session_ownership (
  session_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  owner_enrollment_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('owned', 'relinquished')),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mesh_handoff_journal (
  handoff_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('source', 'target')),
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mesh_handoff_journal_session
  ON mesh_handoff_journal(session_id);
`,
  76: `
-- FLOW-02: parent-side node dispatch records. The dispatch id is the
-- stable identity — a parent restart re-adopts the recorded job rather
-- than recreating one (spec §449). Keep in sync with SCHEMA_SQL.
CREATE TABLE IF NOT EXISTS mesh_node_dispatches (
  dispatch_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  state TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  output_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mesh_node_dispatches_state
  ON mesh_node_dispatches(state);
`,
  77: `
-- FLOW-03: durable integration runs. Keep in sync with SCHEMA_SQL.
CREATE TABLE IF NOT EXISTS mesh_integrations (
  integration_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  dispatch_ids_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('integrated', 'conflicted', 'failed')),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  78: `
ALTER TABLE settings ADD COLUMN llm_gateway_api_key BLOB;
ALTER TABLE settings ADD COLUMN llm_gateway_billing_mode TEXT NOT NULL DEFAULT 'devpass';
`,
  79: `
-- BILL-05: last-known hosted entitlement per (backend, account). Keep in
-- sync with the SCHEMA_SQL copy of this table.
CREATE TABLE IF NOT EXISTS sync_entitlement (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  state TEXT NOT NULL,
  source TEXT NOT NULL,
  plan_key TEXT,
  preview_ends_at TEXT,
  access_until TEXT,
  grace_until TEXT,
  checked_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  restricted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id)
);
`,
  80: `
-- MOB-01: per-enrollment companion authorization on this host. tier is
-- 'pending' (first contact, awaiting host decision), 'observe', 'approve',
-- 'steer', or 'denied'. Keep in sync with the SCHEMA_SQL copy.
CREATE TABLE IF NOT EXISTS companion_enrollment_policies (
  enrollment_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  display_name TEXT,
  tier TEXT NOT NULL DEFAULT 'pending',
  first_seen_at TEXT NOT NULL,
  decided_at TEXT,
  updated_at TEXT NOT NULL
);
`,
  81: `
-- Hosted artifact sharing: the backend share id and public URL stamped
-- on a chat artifact when the user publishes it (share.* ops on the
-- session object). Keep in sync with the SCHEMA_SQL copy of chat_artifacts.
ALTER TABLE chat_artifacts ADD COLUMN share_id TEXT;
ALTER TABLE chat_artifacts ADD COLUMN shared_url TEXT;
ALTER TABLE chat_artifacts ADD COLUMN shared_at TEXT;
`,
  82: `
-- E2E sealing: sealed_json stores the exact wire payload produced at
-- dispatch (sealed envelope for domain entities, passthrough for
-- crypto-boundary entities) so replays reuse a stable payload_hash.
-- Keep the new tables in sync with the SCHEMA_SQL copies.
ALTER TABLE sync_outbox ADD COLUMN sealed_json TEXT;
CREATE TABLE IF NOT EXISTS sync_keyring (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  key_wrapped BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, key_version)
);
CREATE TABLE IF NOT EXISTS sync_device_keys (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  identity_pub TEXT NOT NULL,
  identity_priv_wrapped BLOB,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, enrollment_id)
);
CREATE TABLE IF NOT EXISTS sync_pairing (
  nonce TEXT PRIMARY KEY,
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  secret_wrapped BLOB NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('issuer', 'redeemer')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_keyring_deliveries (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, enrollment_id, key_version)
);
`,
  83: `
-- ADK provenance + scoped pairing. sync_keyring.source records where a
-- key came from ('minted' = provisional self-mint, 'wrap'/'pairing' =
-- delivered by a peer, 'rotation' = authoritative local rotation);
-- pre-existing rows are treated as 'minted' so a divergent first-use v1
-- can still be healed by the authoritative wrap when it arrives.
-- sync_pairing gains a composite scope key so a nonce can never resolve
-- or be replaced across backends/accounts. Keep both tables in sync with
-- the SCHEMA_SQL copies.
ALTER TABLE sync_keyring ADD COLUMN source TEXT NOT NULL DEFAULT 'minted'
  CHECK (source IN ('minted', 'wrap', 'pairing', 'rotation'));
CREATE TABLE sync_pairing_scoped (
  nonce TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  secret_wrapped BLOB NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('issuer', 'redeemer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, nonce)
);
INSERT INTO sync_pairing_scoped (nonce, backend_id, account_id, secret_wrapped, role, created_at)
  SELECT nonce, backend_id, account_id, secret_wrapped, role, created_at FROM sync_pairing;
DROP TABLE sync_pairing;
ALTER TABLE sync_pairing_scoped RENAME TO sync_pairing;
`,
  84: `
-- ENV-01 cloud environments: provider connections hold non-secret config
-- plus a secret_ref indirection into OS credential storage (credentials
-- never land in SQLite); cloud_environments is the local registry mirror
-- of backend environment records.
CREATE TABLE IF NOT EXISTS cloud_provider_connections (
  id TEXT PRIMARY KEY,
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  display_name TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  secret_blob BLOB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cloud_provider_connections_scope
  ON cloud_provider_connections (backend_id, account_id, provider);
CREATE TABLE IF NOT EXISTS cloud_environments (
  environment_id TEXT PRIMARY KEY,
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  state TEXT NOT NULL,
  handle_json TEXT,
  enrollment_id TEXT,
  job_id TEXT,
  connection_id TEXT,
  created_by TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cloud_environments_scope
  ON cloud_environments (backend_id, account_id, state);
`,
  85: `
-- E2EE trust model: per-enrollment decrypt membership, rotation ledger,
-- task-scoped keys, dashboard grants, and the pairing redemption proof.
-- Keep in sync with the base-schema copies of these tables.
CREATE TABLE IF NOT EXISTS sync_device_trust (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'trusted', 'revoked')),
  decided_at TEXT,
  PRIMARY KEY (backend_id, account_id, enrollment_id)
);
-- Seed trust for existing enrollments: a device's own active enrollment is
-- trusted; every other known device starts pending (fail closed — peers
-- re-earn decrypt membership via pairing or explicit approval).
INSERT OR IGNORE INTO sync_device_trust (backend_id, account_id, enrollment_id, state, decided_at)
  SELECT backend_id, account_id, enrollment_id, 'pending', NULL FROM sync_device_keys;
CREATE TABLE IF NOT EXISTS sync_keyring_rotations (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  rotation_id TEXT NOT NULL,
  rotor_enrollment_id TEXT NOT NULL DEFAULT '',
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  revoked_json TEXT NOT NULL DEFAULT '[]',
  local_origin INTEGER NOT NULL DEFAULT 0 CHECK (local_origin IN (0, 1)),
  reported_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, rotation_id)
);
ALTER TABLE sync_pairing ADD COLUMN proof_nonce TEXT;
-- Persisted task envelopes: the attempt keeps the job's sealedInputs so a
-- restarted worker can unseal without re-claiming; the dispatch keeps the
-- byte-exact job.create request so a crash between persist and submit
-- replays identically.
ALTER TABLE mesh_attempts ADD COLUMN sealed_inputs_json TEXT;
-- Dispatches persist BEFORE job.create, so job_id must admit NULL and the
-- byte-exact job.create request is stored for deterministic replay.
ALTER TABLE mesh_node_dispatches RENAME TO mesh_node_dispatches_old;
CREATE TABLE mesh_node_dispatches (
  dispatch_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  job_id TEXT,
  request_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  request_json TEXT,
  state TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  output_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO mesh_node_dispatches (
  dispatch_id, run_id, node_id, job_id, request_id, workspace_id,
  manifest_json, state, cancel_requested, output_json, created_at, updated_at
) SELECT
  dispatch_id, run_id, node_id, job_id, request_id, workspace_id,
  manifest_json, state, cancel_requested, output_json, created_at, updated_at
FROM mesh_node_dispatches_old;
DROP TABLE mesh_node_dispatches_old;
CREATE INDEX idx_mesh_node_dispatches_state ON mesh_node_dispatches(state);
CREATE TABLE IF NOT EXISTS mesh_task_keys (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  key_wrapped BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, job_id)
);
CREATE TABLE IF NOT EXISTS mesh_dashboard_grants (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  browser_pub TEXT NOT NULL,
  dsk_wrapped BLOB,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  workspace_id TEXT,
  repo_ids_json TEXT NOT NULL DEFAULT '[]',
  enrollment_id TEXT,
  expires_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  request_json TEXT,
  last_published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, request_id)
);
CREATE TABLE IF NOT EXISTS mesh_browser_command_receipts (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  repo_id TEXT,
  expires_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  command_envelope_json TEXT,
  claim_fence INTEGER,
  state TEXT NOT NULL CHECK (state IN ('executing', 'completed', 'failed', 'uncertain')),
  result_wrapped BLOB,
  result_envelope_json TEXT,
  result_published INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (backend_id, account_id, grant_id, command_id)
);
CREATE INDEX IF NOT EXISTS idx_mesh_browser_command_receipts_state
  ON mesh_browser_command_receipts (backend_id, account_id, state, updated_at);
`,
  86: `
-- FLOW-02: retain the backend placement decision on the durable dispatch so
-- workflow recovery and the run view can explain automatic/environment
-- placement without querying a terminal job again.
ALTER TABLE mesh_node_dispatches ADD COLUMN placement_explanation TEXT;
ALTER TABLE mesh_node_dispatches ADD COLUMN resolved_enrollment_id TEXT;
`,
  87: `
ALTER TABLE settings ADD COLUMN thread_assist_provider TEXT DEFAULT 'off';
ALTER TABLE settings ADD COLUMN ollama_endpoint TEXT;
ALTER TABLE settings ADD COLUMN ollama_model TEXT;
ALTER TABLE settings ADD COLUMN lm_studio_endpoint TEXT;
ALTER TABLE settings ADD COLUMN lm_studio_model TEXT;
ALTER TABLE chat_threads ADD COLUMN summary TEXT;
ALTER TABLE chat_threads ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN thread_assist_model TEXT;
`,
  88: `
ALTER TABLE sync_backends ADD COLUMN connection_mode TEXT NOT NULL DEFAULT 'compatible';
`,
  89: `
-- Device recovery-code secret custody. Existing recovery material is local
-- only and safeStorage-wrapped; no recovery code or plaintext secret is part
-- of a sync payload.
ALTER TABLE sync_keyring RENAME TO sync_keyring_recovery_old;
CREATE TABLE sync_keyring (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  key_wrapped BLOB NOT NULL,
  source TEXT NOT NULL DEFAULT 'minted' CHECK (source IN ('minted', 'wrap', 'pairing', 'rotation', 'recovery')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, key_version)
);
INSERT INTO sync_keyring (backend_id, account_id, key_version, key_wrapped, source, created_at)
  SELECT backend_id, account_id, key_version, key_wrapped, source, created_at
  FROM sync_keyring_recovery_old;
DROP TABLE sync_keyring_recovery_old;
CREATE TABLE IF NOT EXISTS sync_recovery_secrets (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  recovery_id TEXT NOT NULL,
  secret_wrapped BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id)
);
`,
  90: `
-- Persist the server-authorized first-device bootstrap gate locally. A
-- keyless device remains unable to mint an ADK until security.get reports
-- canConfigure and names this enrollment as bootstrapEnrollmentId.
CREATE TABLE IF NOT EXISTS sync_key_bootstrap_eligibility (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  eligible INTEGER NOT NULL DEFAULT 0 CHECK (eligible IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, enrollment_id)
);
`,
  91: `
-- A revoked device may retain its old recovery signer for an explicitly
-- authorized replacement flow, but its old code may not refresh ciphertext
-- containing post-revocation keys.
ALTER TABLE sync_recovery_secrets ADD COLUMN invalidated_at TEXT;
`,
  92: `
-- Mark locally minted rotations separately from opaque rotation entities pulled
-- from the backend. Remote metadata cannot prove this device completed a key
-- rotation after a revoke.
ALTER TABLE sync_keyring_rotations ADD COLUMN local_origin INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS sync_revocation_rotations (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  rotated_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, enrollment_id)
);
`,
  93: `
-- Cache authenticated sender wraps until this device verifies the sender
-- identity locally; the cache contains ciphertext only.
CREATE TABLE IF NOT EXISTS sync_keyring_pending_wraps (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  recipient_enrollment_id TEXT NOT NULL,
  sender_enrollment_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, account_id, recipient_enrollment_id, payload_hash)
);
`,
  94: `
-- DASH-02: bind every newly-approved browser grant to an explicit local
-- workspace/repository selection and approving enrollment. Existing grants
-- remain readable but cannot execute workspace commands without these fields.
ALTER TABLE mesh_dashboard_grants ADD COLUMN workspace_id TEXT;
ALTER TABLE mesh_dashboard_grants ADD COLUMN repo_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE mesh_dashboard_grants ADD COLUMN enrollment_id TEXT;
CREATE TABLE IF NOT EXISTS mesh_browser_command_receipts (
  backend_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  repo_id TEXT,
  expires_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('executing', 'completed', 'failed', 'uncertain')),
  result_wrapped BLOB,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (backend_id, account_id, grant_id, command_id)
);
CREATE INDEX IF NOT EXISTS idx_mesh_browser_command_receipts_state
  ON mesh_browser_command_receipts (backend_id, account_id, state, updated_at);
`,
  95: `
-- DASH-03: durable relay result publication. The original command envelope,
-- claim fence, and exact sealed result are retained so an acknowledged
-- execution is never replayed after a lost completion response.
ALTER TABLE mesh_browser_command_receipts ADD COLUMN command_envelope_json TEXT;
ALTER TABLE mesh_browser_command_receipts ADD COLUMN claim_fence INTEGER;
ALTER TABLE mesh_browser_command_receipts ADD COLUMN result_envelope_json TEXT;
ALTER TABLE mesh_browser_command_receipts ADD COLUMN result_published INTEGER NOT NULL DEFAULT 0;
`,
  96: `
-- Tiered repo indexing: readiness tier on repos, per-module content hashes for
-- incremental enrichment, and the persistent repo_index_jobs queue table.
-- Existing fully-indexed repos are treated as enriched.
ALTER TABLE repos ADD COLUMN index_tier TEXT NOT NULL DEFAULT 'connected';
ALTER TABLE module_summaries ADD COLUMN content_hash TEXT;
CREATE TABLE IF NOT EXISTS repo_index_jobs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('mapped', 'enriched')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  reason TEXT NOT NULL DEFAULT 'manual',
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  error TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_repo_index_jobs_repo ON repo_index_jobs (repo_id, state);
CREATE INDEX IF NOT EXISTS idx_repo_index_jobs_state ON repo_index_jobs (state, queued_at);
UPDATE repos SET index_tier = 'enriched' WHERE status = 'indexed';
`,
  97: `
-- Local-first activation funnel events (§7 Measurement). Rows are never
-- transmitted; they exist only for local funnel analysis.
CREATE TABLE IF NOT EXISTS activation_events (
  id INTEGER PRIMARY KEY,
  event TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activation_events_event_created
  ON activation_events (event, created_at);
`,
  98: `
-- Side questions are retained threads with a durable read-only purpose. The
-- parent link may be cleared if the parent is deleted; purpose remains intact.
ALTER TABLE chat_threads ADD COLUMN purpose TEXT NOT NULL DEFAULT 'normal'
  CHECK (purpose IN ('normal', 'side-question'));
ALTER TABLE chat_threads ADD COLUMN side_question_of_thread_id TEXT
  REFERENCES chat_threads(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_chat_threads_side_question_parent
  ON chat_threads(side_question_of_thread_id);
`,
};

// Development builds could stamp v68 or v69 without the sync table migration.
// Replay its idempotent table/index creation before later migrations alter them.
export const LEGACY_SCHEMA_REPAIR_SQL = `${MIGRATIONS[68]}
${MIGRATIONS[69]}`;
