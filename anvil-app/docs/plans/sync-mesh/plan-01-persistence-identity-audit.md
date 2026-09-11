# PLAN-01: Persistence and identity audit

Status: complete (read-only).  
Date: 11 September 2026.  
Packet gate: all portable fields and write paths classified.

## 1. Baseline

| Item | Value |
| --- | --- |
| Spec baseline commit | `3ff60e23557fb2dcafcde626e8df145d502a7ab2` |
| Inspected tree | `feature/sync-mesh--foundations` at SCHEMA_VERSION 66 |
| Schema | `src/main/db/schema.ts` line 1: `export const SCHEMA_VERSION = 66` |
| Fresh schema | `SCHEMA_SQL` in the same file (CREATE TABLE block starts line 3) |
| Incremental migrations | `MIGRATIONS` at `schema.ts:1047` |
| Date of this audit | 11 Sep 2026 |

No `sync_bindings`, `sync_outbox`, `sync_state`, `sync_conflicts`, or `device_enrollments` tables exist. Spec §5 tables are not yet present.

Database startup (`src/main/db/database.ts`):

- `getDb()` (lines 11–16) returns a module-level `better-sqlite3` handle or throws if `initDatabase` has not run.
- `initDatabase` (lines 18–32) opens `userData` + `PRIMARY_DB_FILENAME` (legacy filename fallback), sets `journal_mode = WAL` and `foreign_keys = ON`, then calls `runMigrations`.
- `runMigrations` (lines 34–88) reads `schema_meta.schema_version`. Fresh DBs (`currentVersion === 0`) `exec(SCHEMA_SQL)`. Otherwise it splits each `MIGRATIONS[v]` on `;` and `exec`s statements one at a time. Duplicate-column errors are swallowed. Version stamp and `INSERT OR IGNORE INTO settings (id) VALUES (1)` are **not** wrapped in `db.transaction()`.
- Tests do not call `initDatabase`. Typical pattern: `new Database(':memory:')`, `db.exec(SCHEMA_SQL)`, `vi.mock('../../db/database.js', () => ({ getDb: () => db }))`. Seen in `src/main/db/__tests__/schema.test.ts`, `src/main/services/__tests__/workflow-persistence.test.ts`, `src/main/services/__tests__/workspace.service.test.ts`, `src/main/services/__tests__/chat-persistence.service.test.ts`. `schema.test.ts` also has `applyMigration()` (lines 5–18) that mirrors production statement splitting.

`keytar` is not used anywhere in this repository. Secrets go through Electron `safeStorage` in `src/main/services/auth.service.ts`.

## 2. Entity classification table

Sync-enabled candidates from spec G1: workflow templates, workspace definitions, editable agents/personas, allowlisted settings. Related local tables are included so later packets do not treat them as portable by accident.

Classification: **portable** (may enter a sync payload) / **local-only** / **secret-never-sync** / **derived**.

### 2.1 `workflow_templates` (`schema.ts:199–206`)

Current ID: `randomUUID()` in `saveWorkflowTemplate` (`workflow.service.ts:206`). Compatible with spec §4 (“preserve compatible existing UUIDs”).

| Column | Class | Notes |
| --- | --- | --- |
| `id` | portable | Random UUID. Keep. |
| `name` | portable | |
| `description` | portable | |
| `graph_json` | portable (with sanitise) | Parsed as `{ nodes, edges, orchestration }` (`workflow.service.ts:140–151, 222–226`). Nodes include `personaId` (built-in slug), `provider`, `model`, prompts. No absolute paths observed in the template write path. |
| `created_at` | derived | Envelope owns audit timestamps; keep locally. |
| `updated_at` | derived | Same. |

Templates are **not** workspace-scoped. There is no `workspace_id` and no `workflowIds` membership table.

`draftWorkflowTemplate` (`workflow.service.ts:237`) does not write SQLite.

### 2.2 `workflow_runs` (`schema.ts:208–223`) — not a G1 sync entity

Current ID: `randomUUID()` (`workflow.service.ts:924`). Keep as local execution identity. Do not sync.

| Column | Class | Notes |
| --- | --- | --- |
| `id` | local-only | |
| `template_id` | local-only | No FK. Snapshot of template at start. |
| `template_name` | local-only | Copied name. |
| `workspace_id` | local-only | FK to `workspaces`. |
| `repo_ids_json` | local-only | Local path-derived repo IDs. |
| `graph_json` | local-only | Extra fields: `events`, `deadlineAt`, `sourceAutomationRunId`, `workItemRef`, **`runtimeOwnerPid`**, **`executionPaths`** (`workflow.service.ts:154–163, 379–389, 950–958`). `executionPaths` is `{ id, path }[]` with **absolute paths**. |
| `kickoff` | local-only | User prompt. |
| `status` | local-only | |
| `supervisor_thread_id` | local-only | FK to `chat_threads`. |
| `node_runs_json` | local-only | Includes `attempts[]` (`types.ts:617–629, 692–705`). Attempt-scoped, but execution still shares `executionPaths` at run level. |
| `created_at` / `started_at` / `completed_at` / `error` | local-only | |

### 2.3 `workspaces` (`schema.ts:627–632`)

Current ID: `randomUUID()` (`workspace.service.ts:227`). Compatible with spec §4.

| Column | Class | Notes |
| --- | --- | --- |
| `id` | portable | Random UUID. Keep. |
| `name` | portable | |
| `created_at` / `updated_at` | derived | Envelope owns revision timestamps. |

Missing versus `WorkspaceDefinition` (§4): `schemaVersion`, `description`, `repos[]` portable shape, `workflowIds`, `agentIds`, `preferences` (portable allowlist), `bootstrap`. See §5.

### 2.4 `workspace_repos` (`schema.ts:634–639`)

Composite PK `(workspace_id, repo_id)`. `repo_id` is the **local** `repos.id` (path-hash), not a portable UUID.

| Column | Class | Notes |
| --- | --- | --- |
| `workspace_id` | portable (as workspace id) | |
| `repo_id` | local-only | FK to `repos(id)`. Map to a new portable repo id; do not replace this FK. |
| `added_at` | derived | Local membership time. |

No `remoteUrl`, `relativeDirectory`, or `defaultRef` on this junction.

### 2.5 `repos` (`schema.ts:24–38`) — local checkout table, not a sync entity

Current ID: `repoIdFromPath` = SHA-256 of the **absolute directory path**, first 16 hex chars (`git.service.ts:46–48`). Written by `connectRepoPath` (`repo-connect.service.ts:13–28`). **Not a UUID. Not portable. Same clone on another machine gets a different id.** Compatible-UUID rule does not apply; keep these ids locally.

| Column | Class | Notes |
| --- | --- | --- |
| `id` | local-only | Path-derived. Foreign keys throughout the app. |
| `name` | derived | `path.basename(repoPath)` (`git.service.ts:76`). |
| `path` | local-only | Absolute, `UNIQUE`. |
| `remote_url` | portable (sanitised, on the definition) | Observed origin fetch URL (`git.service.ts:65`). Must be sanitised; absent means link-local-only. |
| `default_branch` | local-only today | Set from `branches.current` (`git.service.ts:66, 79`), i.e. current branch, not a setup `defaultRef`. |
| `status`, `last_indexed`, `file_count`, `branch_count`, `last_commit_*`, timestamps | local-only / derived | Device Git observations. |

### 2.6 `workspace_preferences` (`schema.ts:641–647`)

One row per workspace. JSON blobs, not a closed portable allowlist.

| Column | Class | Notes |
| --- | --- | --- |
| `workspace_id` | portable (as workspace id) | |
| `workitems_json` | mixed | `workItemConnectionId` is a **local credential-binding id** (`types.ts:1772–1776`). `iterationIds` / `iterationNames` are provider-scoped; not portable without a logical connector ref. |
| `docs_json` | mixed | `parentPageId` / `parentPageTitle` / `label` (`types.ts:1778–1782`) are connector-local. |
| `launch_json` | local-only | Deeplink metadata (`types.ts:1784–1788`). |
| `updated_at` | derived | |

`adoptDefaultWorkItemConnection` (`workspace.service.ts:110–127`) **writes on read** when `workItemConnectionId` is missing, copying `settings.activeWorkItemConnectionId`.

### 2.7 Editable agent / persona — **no table**

`persona.service.ts` exports a hardcoded `PERSONAS` array (lines 9–157). IDs are stable slugs (`coder`, `mentor`, `architect`, …), not UUIDs. `getPersonas` / `getPersonaById` (159–165) are read-only. `getDb()` is used only to load repo summaries when building prompts (199+). There is **no write path and no SQLite projection**.

IPC: `chat.getPersonas` (`ipc-api.d.ts:281`; handler `chat.ipc.ts:438–440`).

Spec G1 “editable agent definitions” has nothing to extend. ENTITY-01 must add a table. Built-in slug IDs are not UUIDs; they can remain catalog keys. New editable agents should use `randomUUID()`.

### 2.8 `settings` (`schema.ts:320–371`) — never sync the row

Singleton `id INTEGER PRIMARY KEY CHECK (id = 1)`. Written by `updateSettings` (`settings.service.ts:364–580`). Spec §13: serialize an allowlist; never sync this row.

| Column | Class |
| --- | --- |
| `id` | local-only (singleton) |
| `llm_provider`, `enabled_llm_providers` | portable (preference) — provider **choice**, not credentials |
| `openai_model`, `reasoning_level` | portable (preference) |
| `chat_layout`, `theme` | portable (preference) |
| `docs_provider`, `work_item_provider` | portable as **logical type only**; credentials stay local |
| `code_review_quick_glance_rubric`, `code_review_senior_dev_rubric` | portable with share-preview (user-authored text; spec §6) |
| `foundry_api_key`, `openai_api_key`, `ado_pat`, `linear_api_key`, `jira_api_token`, `confluence_pat`, `notion_oauth_token`, `github_pat`, `work_item_connections` | **secret-never-sync** (BLOBs via `encryptSecret`) |
| `foundry_endpoint`, `foundry_deployment`, `foundry_api_version` | local-only (device connector binding) |
| `ado_org_url`, `ado_project`, `ado_team`, `linear_team_id`, `jira_host`, `jira_auth_mode`, `jira_project`, `jira_board_id`, `jira_email`, `confluence_base_url`, `confluence_space_key`, `notion_database_id`, `notion_oauth_expiry`, `github_username` | local-only (connector binding / account identity) |
| `active_work_item_connection_id` | local-only |
| `default_repo_path` | local-only (absolute path) |
| `active_workspace_id` | local-only (this device’s open workspace) |
| `codex_mode` | local-only (**execution permission** / sandbox policy) |
| `local_llm_mode`, `local_llm_provider`, `local_llm_endpoint`, `local_llm_model`, `apple_foundation_models_mode` | local-only (this machine) |
| `cloud_features_enabled` | local-only (local permission) |
| `telemetry_enabled` | local-only (consent on this install) |
| `user_role` | local-only (onboarding / role gate) |
| `updated_at` | derived |

`jiraAcceptanceCriteriaField` exists on `WorkItemConnection` (`types.ts:312`) and is copied in `applyWorkItemConnection` (`settings.service.ts:213`); it is **not** a `settings` column. It lives inside the encrypted `work_item_connections` BLOB.

### 2.9 Session tables used by Codex (`schema.ts:79–114`)

`chat_threads` and `chat_sessions` are local conversation/execution records. Not G1 sync entities.

`chat_threads.id`: `randomUUID()` (`chat-persistence.service.ts:449`). Compatible UUID, keep locally.

| Notable column | Class |
| --- | --- |
| `provider_thread_id`, `provider_thread_provider` | local-only | Provider resume handle, not Mesh session identity. |
| `workspace_id`, `persona_id`, `repo_ids_json`, `active_repo_id` | local-only | `persona_id` is a slug. `repo_ids_json` / `active_repo_id` are local repo ids. |

`chat_sessions.id`: caller-supplied (Codex session UUID from `codex-session.service.ts:145`) or `randomUUID()` (`chat-persistence.service.ts:652`). Columns `provider_thread_id`, `provider_turn_id`, `provider` are local-only. **No PID column.**

### 2.10 Mobile companion and other secret/local tables

| Table | ID scheme | Sync? |
| --- | --- | --- |
| `mobile_companion_settings` (`schema.ts:380–387`) | singleton `id=1`; `instance_id` is `randomUUID()` on first insert (`mobile-companion.service.ts:397–403`) | Never. Host/port/instance are this machine. |
| `mobile_companion_devices` (`schema.ts:389–397`) | `randomUUID()` (`:798`); `token_hash` SHA-256 of bearer (`:2403–2404`) | Never. Device pairing secrets. |
| `companion_review_items` (`schema.ts:413–426`) | CarPlay “later” queue | Never. |
| `cloud_execution_connection` (`schema.ts:373–378`) | singleton; `token` BLOB encrypted (`anvil-cloud-execution.service.ts:52–71`) | **secret-never-sync**. |
| `workspace_scaffold_sessions` (`schema.ts:649–660`) | `randomUUID()`; `root_path` absolute (`workspace-scaffold.service.ts:51–65`) | Never. |

## 3. Write-path inventory

`better-sqlite3` auto-commits each statement unless wrapped in `db.transaction()`. Spec §3 invariant 1 requires the domain write **and** the outbox row in one transaction. A single-statement write is atomic today but **cannot** take an outbox row until wrapped.

“Needs outbox txn” applies to G1 sync entities. Execution/session writes are listed for FLOW/SESSION packets.

| Function | File:line | Writes | Explicit `db.transaction()`? | Outbox change |
| --- | --- | --- | --- | --- |
| `saveWorkflowTemplate` | `workflow.service.ts:197–230` | `INSERT … ON CONFLICT` `workflow_templates` | No (one statement) | Wrap save + outbox in `db.transaction()`. |
| `deleteWorkflowTemplate` | `workflow.service.ts:233–234` | `DELETE FROM workflow_templates` | No | Same; emit `operation: 'delete'`. |
| `draftWorkflowTemplate` | `workflow.service.ts:237` | none | n/a | No persist. |
| `persistRun` | `workflow.service.ts:372–397` | `UPDATE workflow_runs` (PID + absolute `executionPaths` inside `graph_json`) | No | Do **not** outbox. FLOW-01: per-attempt journal, still wrap related local writes together. |
| `startWorkflowRun` | `workflow.service.ts:900–975` | `createChatThread` + `INSERT workflow_runs` + `saveChatEntry` | **No** (three statements) | Not a sync entity. Still wrap the three writes for crash safety. |
| `cancelWorkflowRun` / `pauseWorkflowRun` / `resumeWorkflowRun` / `decideWorkflowNode` / `retryWorkflowNode` | `workflow.service.ts:1037–1145` | `persistRun` | No | Local only. |
| `recoverInterruptedWorkflowRuns` | `workflow.service.ts:1148–1183` | `persistRun` per recovered row | No (loop of single updates) | Local only. Called from `workflow.ipc.ts:21` at handler registration. |
| `launchWorkflow` | `workflow.service.ts:798–802` | sets `runtimeOwnerPid = process.pid` then persist via runtime | No | Local. PID is the **Electron main** pid, not a child agent pid. |
| `createWorkspace` | `workspace.service.ts:225–264` | `workspaces` + `workspace_preferences` + `workspace_repos` | **Yes** (`:241`) | Insert outbox inside this txn. |
| `updateWorkspace` | `workspace.service.ts:354–366` | `UPDATE workspaces` name | No | Wrap + outbox. |
| `deleteWorkspace` | `workspace.service.ts:372–396` | chat rows + `workspaces` + `settings.active_workspace_id` | **Yes** (`:374`) | Spec §3.7: global definition delete vs local checkout. Outbox the definition delete; do not treat CASCADE chat/settings as portable. Confirm product rule before emitting delete. |
| `addReposToWorkspace` | `workspace.service.ts:405–418` | `workspace_repos` + `workspaces.updated_at` | **Yes** (`:412`) | Outbox definition update (membership) inside txn. Payload must use portable repo ids, not path-hash ids. |
| `removeReposFromWorkspace` | `workspace.service.ts:424–434` | same | **Yes** (`:428`) | Same. |
| `updateWorkspacePreferences` | `workspace.service.ts:275–317` | upsert prefs + `UPDATE workspaces.updated_at` | **No** (two statements) | Wrap; only allowlisted portable preference fields go to outbox. |
| `clearWorkspacePreferences` | `workspace.service.ts:320–348` | delegates to `updateWorkspacePreferences` | No | Same. |
| `adoptDefaultWorkItemConnection` | `workspace.service.ts:110–127` | `UPDATE workspace_preferences` **on get** | No | Do not outbox. This is a local credential default. |
| `connectRepoPath` | `repo-connect.service.ts:5–31` | `INSERT OR REPLACE INTO repos` | No | Do not outbox the local `repos` row. Mapping/adoption is WS-01. |
| `updateSettings` | `settings.service.ts:364–580` | dynamic `UPDATE settings`; may `DELETE FROM work_items_cache` first (`:487, :502`) | **No** (cache delete is a separate statement) | Never outbox this row. If a portable-settings entity is introduced, write that projection + outbox in one txn; keep secrets on this row. |
| `resetOnboardingState` | `settings.service.ts:680–687` | `UPDATE settings` + `DELETE` prefs/repos/workspaces/scaffold | **No** (five statements) | Destructive local reset; not a sync write. Needs an explicit txn for crash safety regardless. |
| `getPersonas` / `getPersonaById` / `buildSystemPrompt` | `persona.service.ts` | none (prompt builder **reads** `repos`) | n/a | ENTITY-01 must add writes. |
| `createChatThread` | `chat-persistence.service.ts:447–485` | `INSERT chat_threads` | No | Local. |
| `createChatSession` | `chat-persistence.service.ts:643–664` | `INSERT chat_sessions`; may `setChatThreadProviderThreadId` | **No** (two statements) | Local. SESSION-01: persist attempt journal before spawn, not after. |
| `setChatThreadProviderThreadId` | `chat-persistence.service.ts:690–702` | `UPDATE chat_threads` | No | Local. |
| `setChatSessionProviderTurnId` / `endChatSession` | `chat-persistence.service.ts:704–716` | `UPDATE chat_sessions` | No | Local. |
| `saveChatEntry` | `chat-persistence.service.ts:718+` | messages | `db.transaction` at `:608` for one path | Local. |
| `clearChatHistory` | `chat-persistence.service.ts:841–853` | messages + sessions + thread | **Yes** (`:843`) | Local. Pattern to copy. |
| `setMobileCompanionEnabled` | `mobile-companion.service.ts:251–259` | `UPDATE mobile_companion_settings` | No | Never sync. |
| `createCompanionDevice` | `mobile-companion.service.ts:792–805` | `INSERT mobile_companion_devices` | No | Never sync. |
| `revokeMobileCompanionDevice` | `mobile-companion.service.ts:383–391` | `UPDATE … revoked_at` | No | Never sync. |
| `saveAnvilCloudExecutionConnection` | `anvil-cloud-execution.service.ts:62–71` | encrypted token | No | Never sync. |

`git.service.ts` has **no** `getDb` usage. It only derives ids and talks to Git.

## 4. Settings allowlist proposal

Do not sync the `settings` row. Introduce a closed `PortableWorkspacePreferences` / account-level portable-settings document, versioned, validated both ways.

**Safe to sync (closed list):**

- `theme`
- `chat_layout`
- `llm_provider`
- `enabled_llm_providers`
- `openai_model`
- `reasoning_level`
- `docs_provider` (enum only: `confluence` \| `notion` \| `none`)
- `work_item_provider` (enum only: `ado` \| `linear` \| `jira` \| `none`)
- `code_review_quick_glance_rubric`
- `code_review_senior_dev_rubric` (preview before upload; user text)

Connector **logical** refs (new fields, not current columns): e.g. `workItemConnectorRef`, `docsConnectorRef` as portable ids that bind to **local** credentials on each device. Do not put `workItemConnectionId` or PATs in the payload.

**Must never sync:**

- All BLOB / `encryptSecret` fields: `foundry_api_key`, `openai_api_key`, `ado_pat`, `linear_api_key`, `jira_api_token`, `confluence_pat`, `notion_oauth_token`, `github_pat`, `work_item_connections`
- `cloud_execution_connection.endpoint` / `token`
- Absolute / device paths: `default_repo_path`, any repo `path`, scaffold `root_path`, `executionPaths`
- Local permission / policy: `codex_mode`, `cloud_features_enabled`, `telemetry_enabled`, `user_role`
- Device UI/session: `active_workspace_id`, `active_work_item_connection_id`
- Local model runtime: `local_llm_*`, `apple_foundation_models_mode`, `local_llm_endpoint`
- Connector bindings: Foundry/ADO/Linear/Jira/Confluence/Notion/GitHub host, org, project, email, username, OAuth expiry, database id
- Env vars (Codex spawn copies `process.env` and may set `OPENAI_API_KEY` — `codex-session.service.ts:167–186`)
- Mobile companion host/port/tokens/`instance_id`

`codex_mode` is the sandbox/approval policy (`read-only` \| `on-request` \| `workspace-auto` \| `full-access`). Syncing it would remotely loosen a target’s execution policy, which spec §6 forbids.

## 5. Workspace model gaps

`Workspace` today (`types.ts:1759–1764`) is `{ id, name, createdAt, updatedAt }`. Membership is `workspace_repos` → local `repos`. Preferences are three JSON objects. That is not `WorkspaceDefinition`.

| Spec field | Current | Gap |
| --- | --- | --- |
| `id` | `workspaces.id` UUID | Keep. |
| `schemaVersion` | absent | Add on the portable document, not necessarily as a SQL column on `workspaces`. |
| `name` | `workspaces.name` | Keep. |
| `description` | absent | Add. |
| `repos[].id` | local path-hash `repos.id` | **New portable UUID per workspace-repo.** Mapping table: `(workspace_id, portable_repo_id) → local repos.id`. Do not rewrite FKs (`chat_threads.active_repo_id`, `workflow_runs.repo_ids_json`, automations, reviews, etc.). |
| `repos[].remoteUrl` | `repos.remote_url` | Copy sanitised URL into the definition; keep observed URL on `repos` as local Git observation. |
| `repos[].relativeDirectory` | absent (`repos.path` is absolute UNIQUE) | Add on the portable document. Local canonical path stays on the mapping row. |
| `repos[].defaultRef` | `repos.default_branch` is **current branch** at connect (`git.service.ts:66`) | Do not treat `default_branch` as `defaultRef`. New setup-preference field; never an execution snapshot. |
| `workflowIds` | templates are global; no join | Add membership (or account-global templates plus optional workspace pin list). |
| `agentIds` | no editable agents | Depends on ENTITY-01 table. Built-in persona slugs are catalog, not this list, unless explicitly included as non-editable refs. |
| `preferences` | `workspace_preferences` JSON | Replace with closed `PortableWorkspacePreferences`. Leave `workItemConnectionId` local. |
| `bootstrap` | absent (`workspace_scaffold_sessions` is a local agent scaffold, not a recipe) | New type; do not overload scaffold sessions. |

`exportVSCodeWorkspace` (`workspace.service.ts:445–463`) writes a `.code-workspace` file of absolute `repo.path`s — local only.

Two independently connected clones of the same remote are two `repos` rows (different path hashes). Spec §4: do not auto-merge; offer explicit linking.

## 6. Session / process identity (SESSION-01)

- **Logical vs provider vs process:** `CodexSession.id` is a `randomUUID()` (`codex-session.service.ts:145`) stored in an in-memory `Map` (`sessions`). `chat_sessions.id` reuses that id when IPC calls `createChatSession` **after** spawn (`chat.ipc.ts:212–227`). Provider thread id is `ManagedSession.threadId`, persisted on `chat_threads.provider_thread_id` / `chat_sessions.provider_thread_id`. Resume uses `thread/resume` (`codex-session.service.ts:317–321`). Public `resumable` is `!!session.threadId` (`:1124`).
- **PID:** Codex `ChildProcess` is not written to SQLite. `sessionToPublic` (`:1110–1126`) has no pid. Workflow `runtimeOwnerPid` is `process.pid` of the **desktop app** (`workflow.service.ts:802`), stored in `workflow_runs.graph_json`. Recovery uses `process.kill(pid, 0)` (`:1028, :1157`). Spec §9: PID alone is insufficient after restart; this matches. PID reuse can skip recovery if another process occupies the old pid (`workflow-persistence.test.ts:216–223` covers “live owner = this process”).
- **Spawn/persist gap:** process is spawned at `codex-session.service.ts:190` before `createChatSession` in IPC. A crash between spawn and insert leaves an unrecorded child. Spec: write a local attempt journal before process start.
- **Environment:** spawn env is `process.env` plus optional `OPENAI_API_KEY` (`:167–186`). Ambient credentials ride along. Mesh must strip this (spec §7 bootstrap / §12 isolation).
- **Approvals:** `pendingApprovalDetails` / `pendingServerRequests` are **in-memory Maps** (`listPendingApprovalRequests` at `:566–569`; `resolveApproval` at `:594–618`). They die with the process. Mesh durable approvals cannot reuse this store as-is; they can reuse the **decision API**.
- **Interrupted workflows:** `recoverInterruptedWorkflowRuns` marks in-flight node attempts `interrupted` and requires `retryWorkflowNode` before `resumeWorkflowRun` (`:1073–1074, :1112`). Inspect-before-retry already exists at run scope, not per isolated worktree.

## 7. Reusable facilities

| Facility | Where | Use later |
| --- | --- | --- |
| `Database.transaction()` | `workspace.service.ts:241, 374, 412, 428`; `automation-persistence.service.ts:396`; `chat-persistence.service.ts:608, 843`; also code-review / security / lifecycle / agent-ui-intent | SYNC-01 outbox: same callback style. Prefer wrapping existing helpers rather than a second write API. |
| In-memory + `SCHEMA_SQL` tests | `schema.test.ts`, `workflow-persistence.test.ts`, `workspace.service.test.ts`, `chat-persistence.service.test.ts` | SYNC-01 crash/restart tests: temp file DB (not only `:memory:`) for WAL durability; keep the mock-`getDb` pattern. |
| `applyMigration` | `schema.test.ts:5–18` | Incremental migrations from 66; never rewrite history (`AGENTS.md`). |
| `encryptSecret` / `decryptSecret` | `auth.service.ts:7–52` | AUTH-01 device refresh credentials. Note: if `safeStorage.isEncryptionAvailable()` is false, values are stored as UTF-8 buffers (`:8–12, :34–36`). |
| Workflow inspect-before-retry | `recoverInterruptedWorkflowRuns` + `retryWorkflowNode` | FLOW-01 / MESH-02: preserve; move from run-scoped `executionPaths` to attempt-scoped worktrees. |
| Companion **domain** ops | `listPendingApprovalRequests`, `resolveApproval`, `interruptTurn`, `startSession`, `listActiveCodexSessions` imported by `mobile-companion.service.ts:43–51` | MESH-03: reuse these functions. Do **not** reuse the HTTP server as Mesh transport. |
| Companion **transport** (do not reuse for Mesh) | `http.createServer` listen `0.0.0.0:47631` (`:285–304`); Bearer or `access_token` query (`:816–835`); in-memory pairing tickets 5 minutes (`:175, :321–331`); SHA-256 token hash | LAN companion pairing. Spec Mesh auth is OIDC/enrollment device sessions. |
| CarPlay policy | `approveCarPlayApproval` (`:2182–2187`) via `buildApprovalPolicy` / `isCarPlayActionAllowed` | Example of “target policy cannot be loosened by a remote UI”. |

## 8. Risks and decisions

1. **Portable repo identity vs `repos.id`.** Recommended default: add `workspace_repo_bindings` (or equivalent) mapping `portable_repo_id` (new `randomUUID()`) → existing `repos.id`. Never replace `repos.id` or rewrite FKs. Linking an existing checkout is a local operation (WS-01).

2. **Path-hash ids are machine-specific.** `repoIdFromPath` hashes the absolute path. Moving a folder or using another device creates a new id. Recommended default: treat current ids as local-only forever; portable ids are assigned at first sync/adoption.

3. **`saveWorkflowTemplate` / `deleteWorkflowTemplate` have no explicit transaction.** Recommended default: introduce `withSyncIntent(db, fn)` used by SYNC-01; first consumer is these two functions. Single-statement writes are not enough once an outbox insert is added.

4. **`startWorkflowRun` is not transactional** across thread insert, run insert, and kickoff message. Recommended default: wrap those three writes now or in FLOW-01 before adding remote nodes. Not a G1 outbox issue.

5. **No editable-agent table.** Recommended default: new `agent_definitions` (name TBD) with `randomUUID()` ids; keep `PERSONAS` as a built-in catalog referenced by slug. Workspace `agentIds` point at editable UUIDs only. Do not pretend slugs are UUIDs.

6. **Workflow templates are account-global, workspaces have no `workflowIds`.** Recommended default: keep templates as their own entity type (matches current table); add optional workspace pin list later in ENTITY-01. Do not invent a fake FK by stuffing template ids into `workspace_preferences`.

7. **`codex_mode` and `cloud_features_enabled` look like “settings” but are execution policy.** Recommended default: never sync. Mesh enablement is a separate local opt-in (MESH-01).

8. **`default_branch` is not `defaultRef`.** Recommended default: leave `repos.default_branch` as a local observation; store setup `defaultRef` only on the portable repo entry.

9. **Workflow recovery keys off Electron `process.pid`.** Recommended default: keep inspect-before-retry; do not use this pid as Mesh `workerIncarnation` or attempt identity. SESSION-01 / MESH-02 introduce incarnation + fence.

10. **Companion HTTP + hashed bearer ≠ Mesh enrollment.** Recommended default: reuse approval/session **functions**; new AUTH-01 credentials in `safeStorage`; do not send companion tokens to the account coordinator.

11. **`updateSettings` can delete `work_items_cache` then update `settings` without a transaction.** Recommended default: wrap those two statements even before sync. Portable-settings writes (when added) must not touch secret columns in the same payload.

12. **`adoptDefaultWorkItemConnection` mutates on read.** Recommended default: stop writing inside `getWorkspace` before sync, or the read path will generate spurious local generations.

13. **User-authored workflow prompts and review rubrics may contain secrets.** Recommended default: closed serializer + share preview (spec §6). Size cap 64 KiB/entity (spec §5) may reject large graphs; keep them local with an actionable error.

14. **`resetOnboardingState` deletes all workspaces without a transaction and without sync tombstones.** Recommended default: out of G1 scope; when account lifecycle exists, this must not replay as a cloud wipe (spec §3.7).

---

PLAN-01 gate: portable fields and write paths above are classified. Implementation starts at SYNC-01 / ENTITY-01 / WS-01; this document does not change schema.
