export const SCHEMA_VERSION = 61;

export const SCHEMA_SQL = `
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

CREATE TABLE IF NOT EXISTS chat_threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  persona_id TEXT NOT NULL,
  title TEXT NOT NULL,
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
  settled_at TEXT
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_repos (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  added_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, repo_id)
);

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
};
