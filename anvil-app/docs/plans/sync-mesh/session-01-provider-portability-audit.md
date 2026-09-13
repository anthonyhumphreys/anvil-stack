# SESSION-01 — Provider portability and process-start audit

Read-only. Branch `feature/sync-mesh--foundations`. Schema at inspection: `SCHEMA_VERSION = 67` (`schema.ts:1`). Continuation modes from `cloud/contract/handoff.ts:19–23`: `native-resume | checkpoint-import | summary-continuation | unsupported`. Spec §11 (`anvil-sync-mesh-spec-v2.md:423`) requires adapters to **declare** a mode with versions and verification. Spec §9 (`:379`) requires a local attempt journal **before** process start; PID is not identity after restart. Spec §13 table (`:479`) names `codex-session.service.ts` as the session integration surface. PLAN-01 §6 is the prior session-identity note; this packet verifies and extends it.

**Claim vs code:** no runtime adapter declares a continuation mode. `ProviderContinuationMode` is a type only (`handoff.ts:19–23`). `SessionCheckpoint` (`handoff.ts:30–45`) is unused by services. Public `resumable` is `!!session.threadId` (`codex-session.service.ts:1124`), which is a local provider handle, not Mesh portability (spec §11:423).

---

## 1. Provider capability matrix

`AgentProvider` is `'azure' | 'openai' | 'codex' | 'cursor'` (`types.ts:580`). Interactive chat and BA share `startSession` (`codex-session.service.ts:139–334`). Workflow, automation, and LLM one-shots spawn separately.

Legend: **I** = implemented and called; **P** = possible from stored data, no adapter; **—** = not implemented. Evidence is what the code **does**, not what CLI vendors might support off-path.

| Provider / path | native-resume | checkpoint-import | summary-continuation | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- |
| Codex app-server `codex` | **I** same `CODEX_HOME` | — | **P** | **Launch candidate (same-home only)** | `thread/resume` `:317–321`; `thread/fork` `:312–316`; `thread/start` `:323`. Binding: `chat_threads.provider_thread_id` (`schema.ts:92–93`, `chat-persistence.service.ts:690–702`). IPC resume: `chat.ipc.ts:208–217`. **Not** cross-device: CLI state is `~/.codex` (`codex-bridge.service.ts:44, 131–132`). |
| Codex app-server `openai` | **I** same-home | — | **P** | Same adapter as `codex` | Spawn `app-server -c model_provider="openai"` (`:178–180`). Env injects `OPENAI_API_KEY` (`:184–186`). Resume RPC identical. |
| Codex app-server `azure` | **I** same-home | — | **P** | Same adapter as `codex` | Spawn `app-server -c model_provider="azure"` (`:176–177`). Relies on `~/.codex/config.toml` (`:182–183`). Resume RPC identical. |
| Cursor ACP (`cursor-agent acp`) | — | — | **P** | **unsupported** for native-resume | Always `initialize` + `authenticate` + `session/new` (`:285–292`). Ignores `providerThreadId` / `forkFromProviderThreadId`. Prompt uses ACP `sessionId` as `session.threadId` (`:365–380`; protocol maps `result.sessionId` at `codex-protocol.service.ts:170–174`). No `session/load`. |
| Cursor print (`cursor-agent -p`) | — | — | **P** | **unsupported** | Workflow: `workflow.service.ts:674–682` (`-p --output-format text`). LLM: `llm.service.ts:286`. No thread id stored (`runCursorThread` `createChatSession(..., null, 'cursor')` `:656–662`). |
| Workflow Codex node | **I** supervisor/chat resume only | — | **P** | Same-home Codex | `runCodexThread` `thread/resume` vs `thread/start` (`workflow.service.ts:619–625`). Supervisor ask passes `resumeProviderThreadId` (`:1023–1028`). Node execute path (`:836–868`) does **not** pass resume; each node is a new thread. |
| Automation Codex | — | — | — | **unsupported** | Always `thread/start` (`automation.service.ts:549–554`). No provider thread persist. |
| `codex exec` (LLM helper) | — | — | — | **unsupported** | One-shot `spawn('codex', buildCodexExecArgs)` (`llm.service.ts:359`). Temp last-message file; no session. |
| Local LLM / Apple FM | — | — | — | **unsupported** | `chat.ipc.ts:133–149` intercepts send; `emitLocalAssistantTurn` (`codex-session.service.ts:477–488`) fakes a completed turn. Spawn: `apple-foundation-models.service.ts:64–66`. No thread. |
| `run-process.service.ts` | n/a | n/a | n/a | Not an agent session | Shell `-c` keyed by `repoId` (`:60–102`). In-memory `Map` only. |
| `agent-run.service.ts` | n/a | n/a | n/a | Read projection | Lists `chat_messages` / `automation_runs` / `code_reviews` (`:45–150`). No spawn. |
| `cursor-bridge` / `codex-bridge` | n/a | n/a | n/a | Detection only | CLI which/version/models. Bridge ACP discovery also `session/new` then `child.kill()` (`cursor-bridge.service.ts:110–123, 161`). |

**Fork vs resume.** `chat:fork-provider-thread` (`chat.ipc.ts:318–367`) calls `startSession` with `forkFromProviderThreadId`, then `stopSession` immediately (`:358`). Codex-only (`thread/fork`). Cursor fork still hits `session/new`. Binding copied only if a new `providerThreadId` returns (`:359–365`).

**Chat start sequence (today).** `chat:start-session` (`chat.ipc.ts:173–229`): resolve repo paths → optional repair cwd (`:197–205`) → load stored binding if same provider (`:208–211`) → `startSession` (UUID, env copy, spawn, RPC, wait 20s) → `createChatSession` with returned `providerThreadId`. Resume is implicit: same `options.threadId` + matching `provider_thread_provider` re-sends `thread/resume`. Switching provider drops the stored id (`:211`). Legacy `chat:start-codex-session` (`:420–435`) kills any session for that `repoId` then starts **without** persist or resume options.

**CLI vs in-process identity.** `codex-bridge.service.ts` / `cursor-bridge.service.ts` only detect install, version, models, and `auth.json`. They do not own threads. Interactive Cursor and Codex share `codex-session.service.ts` + `codex-protocol.service.ts`; workflow Cursor bypasses ACP entirely.

**Checkpoint-import:** no import/export of provider checkpoint packages anywhere under `src/main/services/`. Spec artifact contract (`spec §10:407`) is unimplemented.

**Summary-continuation (latent):** `chat_messages` (`schema.ts:116–128`) plus `chat_threads.active_plan_json` / `active_goal_json` (`:94–96`) could seed a **new** `thread/start`. No code builds a summary, declares omitted context, or starts a fresh provider thread for handoff. Workflow “handoffs” are prompt text (`workflow.service.ts:862–866`), explicitly “not independent proof” (`:809`).

**Verification:** no vitest covers `thread/resume` or `thread/fork` (`codex-session.service.test.ts` tests helpers only). Cross-device native-resume is **unverified**. Do not ship it as G3 without a SESSION-02 fixture against a second `CODEX_HOME`.

---

## 2. Process identity

### 2.1 What is recorded at spawn

| Identity | Where | Durable? |
| --- | --- | --- |
| Logical session UUID | `randomUUID()` at `startSession` (`codex-session.service.ts:145`); in-memory `sessions` Map (`:98, :233`) | Only after IPC `createChatSession(..., codexSession.id)` (`chat.ipc.ts:220–227`) |
| App thread id | `options.threadId` → `ManagedSession.appThreadId` (`:212`) | `chat_threads.id` (already exists) |
| Provider thread id | Set when RPC result/notification yields id (`codex-protocol.service.ts:170–174, 339–347`) | `chat_sessions.provider_thread_id` + `chat_threads.provider_thread_id` **after** ready (`chat.ipc.ts:225`; `chat-persistence.service.ts:659–661`) |
| Provider turn id | In-memory `session.turnId` (`:225, :882–884`) | Column exists (`schema.ts:110`). **`setChatSessionProviderTurnId` has no callers** outside its definition (`chat-persistence.service.ts:704–711`) |
| Child PID | `ChildProcess` on `ManagedSession.process` (`:69, :216`) | **Never written.** `sessionToPublic` has no pid (`:1110–1125`) |
| CWD | `resolveSessionCwd` (`:839–857`) | In-memory only |
| Git commit | — | **Not recorded** at session start |
| Attempt / fence / incarnation | — | Absent (Mesh types only in `cloud/contract`) |
| Creation / idempotency key | — | **None.** Spec §9 “stable creation key” unused |

`chat_sessions` (`schema.ts:104–114`): `id, thread_id, repo_id, persona_id, provider_thread_id, provider_turn_id, provider, started_at, ended_at`. No pid, cwd, commit, attempt. `endChatSession` also has **no callers**.

### 2.2 PID as identity

Codex children: PID is not identity. Matches spec §9 (`:379`) and PLAN-01 §6.

Workflow: `runtimeOwnerPid = process.pid` of **Electron main** (`workflow.service.ts:817`), persisted inside `workflow_runs.graph_json` (`persistRun` `:387–403`). Recovery uses `process.kill(pid, 0)` (`:1043, :1172`). Test “live owner = this process” (`workflow-persistence.test.ts:216–223`). PID reuse can skip recovery if another process occupies the old pid — spec warns this; code still uses it as liveness, not as Mesh `workerIncarnation`.

`run-process.service.ts` tracks `proc.pid` only to decide `running` (`:125–126, :154`) and to SIGTERM (`:106–118`). Key is `repoId`. Lost on app quit except the kill sweep (`cleanupRunProcesses` `:139–148`, hooked from `index.ts:442`).

### 2.3 Spawn / persist gaps → `unknown-outcome`

1. **Chat / scaffold / fork:** `spawn` at `:190` **before** `createChatSession` (`chat.ipc.ts:212` then `:220`). Crash between spawn and insert: live child, no SQLite row. Spec: journal first.
2. **`waitForThreadReady` timeout 20s** (`:1128–1136`): rejects; process stays in `sessions` Map; IPC never inserts `chat_sessions`. Orphan app-server until quit (`cleanupChatSessions` → `stopAllSessions`, `chat.ipc.ts:637–638`).
3. **Workflow Codex:** `spawn` then `createChatSession` (`workflow.service.ts:483–493`). Same gap. `activeProcesses` Map (`:484`) is process-local only.
4. **Workflow Cursor:** inserts `chat_sessions` **before** spawn (`:656–682`) — better crash shape, still no attempt journal / creation key; `provider_thread_id` is null.
5. **BA:** `createBaSession` then `startSession` (`ba.ipc.ts:101–113`) with **no** `createChatSession`. BA row exists; Codex child may be untracked in `chat_sessions`.
6. **Automation:** spawn with no session/attempt row (`automation.service.ts:465–469`).
7. **`stopSession`** SIGTERM only (`:517–526`); no wait, no SIGKILL fallback (unlike `run-process.service.ts:108–118`). Spec §11 (`:439`): do not activate a target unless source stop is proven. Not proven today.
8. No restart reconnection to an orphan Codex child. App restart: in-memory Map gone; `recoverInterruptedWorkflowRuns` does not scan chat sessions.
9. **No stable creation key** is passed into `thread/start` / `session/new`. A crash after spawn and before `thread/started` cannot be distinguished from a failed start; spec names this `unknown-outcome` (`spec §9:379`). Re-clicking Start would spawn a second app-server.

---

## 3. Environment / credentials a remote worker would inherit unsafely

All agent spawns copy **full** `process.env`:

| Spawn | Env | Extra secrets |
| --- | --- | --- |
| Chat Codex/Cursor | `{ ...(process.env) }` (`codex-session.service.ts:167–169`) | `openai` → `OPENAI_API_KEY` from settings (`:184–186`) |
| Workflow Codex | same (`workflow.service.ts:477–480`) | same OpenAI inject |
| Workflow Cursor | same (`:679`) | ambient only |
| Automation Codex | same (`automation.service.ts:460–463`) | OpenAI inject if `settings.llmProvider === 'openai'` |
| LLM Cursor/Codex | `{ ...process.env }` (`llm.service.ts:288, 361–364`) | Codex also `OTEL_SDK_DISABLED` |
| Apple FM helper | `{ ...process.env }` (`apple-foundation-models.service.ts:65`) | ambient |
| `run-process` | `process.env` (`run-process.service.ts:69`) | ambient; **arbitrary shell** |
| Cursor ACP discovery | default inherit (`cursor-bridge.service.ts:110–112`) | ambient |

Ambient inheritance includes: `SSH_AUTH_SOCK`, `GITHUB_TOKEN`/`GH_TOKEN`, cloud CLIs, `CODEX_HOME`, `HOME` → `~/.codex/auth.json` (`codex-bridge.service.ts:44, 131–132`), Azure/`az` tokens, `ANVIL_*`, proxy vars. Spec §7 (`:305`) bootstrap runner “strips ambient credentials by default”; spec §12 (`:453`) worktrees do not isolate credentials. **Remote Mesh workers must not reuse this spawn env.** Need an allowlist + target-local bindings (OPENAI key, Codex home, PATH to pinned CLI).

`codex_mode` (`read-only | on-request | workspace-auto | full-access`) is applied at thread start (`:308–310, :1139–1153`) from **local** settings. Syncing it would loosen target policy (spec §6; PLAN-01). Cursor maps mode to ACP `ask|agent|plan` (`:127–133, :372–376`).

Approvals: `pendingServerRequests` / `pendingApprovalDetails` in-memory (`:117–118, :566–569, :594–619`). Die with process. Cannot be the Mesh durable approval store (spec §10:413). Decision RPC itself is reusable.

Attachments pass **absolute** `localImage` / `mention` paths (`:445–456`). Not portable.

---

## 4. Handoff blockers (spec §11 / G4)

1. **Dirty Git not gated on chat start.** `hasUncommittedChanges` (`git.service.ts:163–167`) is used by spike-guard (`spike-guard.service.ts:170, :195`), not by `startSession`. No commit-id pin. Spec: every checkpoint names exact commits (`spec §11:419`); dirty/untracked/local-only commits block G4 (`:421`). Branch checkout/pull is forbidden as identity (`:419`) — current cwd is just the repo path.
2. **Provider thread IDs are not portable.** Codex ids resume via local app-server + `CODEX_HOME`. Cursor ACP `sessionId` is process-lifetime (`session/new` only). Spec: “A provider thread ID is not proof of portability” (`:423`). `resumable: !!threadId` overclaims for Mesh.
3. **No `SessionCheckpoint` writer.** Missing: `schemaVersion`, `sourceGeneration`, `repositories[]` commits, transferable messages/summary, `artifactRefs`, `unresolvedApprovals`. Plan/goal JSON on `chat_threads` is local UI state (`:94–96`), not a checkpoint.
4. **No quiescence protocol.** Handoff machine in `HANDOFF_TRANSITIONS` (`handoff.ts:53–63`) is unused. `interruptTurn` (`:491–515`) + `stopSession` (`:517–526`) do not confirm child exit before returning.
5. **Approvals cannot transfer** (spec `:425`). In-memory map would be lost anyway; must cancel/reissue on target.
6. **Absolute paths:** session `cwd` (`:164, :839–857`), repair workdirs (`chat.ipc.ts:197–205`), scaffold `root_path` (`schema.ts:652`), BA `worktree_path` / `stash_ref` (`schema.ts:443–444`). Stash is explicitly **not** a transfer (`spec §11:421`).
7. **Workflow executionPaths** are absolute worktree paths inside `graph_json` (`workflow.service.ts:402–403, :853–855`). Run-scoped, not attempt-scoped (spec §13:478).
8. **Missing CLI / wrong `CODEX_HOME` on target** → resume fails; no fallback to summary-continuation.

---

## 5. Recommended SESSION-02 / SESSION-03 defaults

Spec packets: SESSION-02 remote prepare/start (`spec :587`); SESSION-03 exact Git checkpoint + ownership handoff (`:588`). Gate: “at least one fully verified continuation mode.”

**Launch provider:** Codex app-server (`AgentProvider` `codex` / `openai` / `azure` — one adapter). It is the only path with implemented `thread/resume` + persisted `provider_thread_id`.

**Verified mode for G3 remote start (SESSION-02):** treat Codex `native-resume` as **same-enrollment, same `CODEX_HOME` recovery** (worker restart / inspect-retry on the device that created the thread). Do **not** declare cross-device `native-resume` until a second-home test proves the thread id is importable. PLAN-01 already: thread id is a resume handle, not Mesh session identity.

**Verified mode for G4 handoff (SESSION-03):** default **`summary-continuation`** on Codex:

- Pin repo commits (fail on dirty/untracked/unpushed).
- Build `SessionCheckpoint` from `chat_messages` + plan/goal + artifact refs; UI must state omitted context (spec `:423`).
- Target `thread/start` (new provider thread). Cancel source approvals; reissue.
- Keep Codex `native-resume` as optional same-home fast path, never as proof of move.

**Cursor:** `unsupported` for SESSION-02/03 launch. No ACP resume. Print path has no thread. Do not block launch on Cursor native-resume.

**Must build before remote design freeze (SESSION-02):**

1. Local **attempt journal** written **before** `spawn` (chat, workflow Codex, automation). Stable attempt id = Mesh attempt id later. Unknown-outcome if spawn succeeds and journal write is not acknowledged.
2. Env **allowlist**; no `process.env` copy. Target-local credentials only.
3. Adapter module declaring `{ provider, cliMinVersion, modes[], verified: boolean }` — start with Codex `native-resume` (same-home) + `summary-continuation` (declared, implement in SESSION-03) + Cursor `unsupported`.
4. `workerIncarnation` + fence (MESH-02); stop using Electron `process.pid` as ownership.
5. Stop/interrupt that **waits** for child exit (SIGTERM then SIGKILL), required by handoff `:439`.
6. Persist `provider_turn_id` or drop the column; wire `endChatSession`.
7. Do not spawn on `waitForThreadReady` timeout without killing the child.

**SESSION-03 must build:** Git commit manifest + dirty blocker; checkpoint schema persistence; generation/ownership transfer using `handoff.ts` states; no dual activation tests (crash during quiesce, crash after transfer, missing ack ≠ rollback).

**FLOW-01:** move workflow from run-scoped `executionPaths` + Electron pid to attempt-scoped worktrees; preserve inspect-before-retry (below).

---

## 6. Interrupted-run recovery (inspect-before-retry)

`recoverInterruptedWorkflowRuns` (`workflow.service.ts:1163–1198`) runs at IPC register (`workflow.ipc.ts:21`):

- Selects `workflow_runs` in `running|queued|paused`.
- If `runtimeOwnerPid` still lives (`kill(pid, 0)`), skip (assumes that Electron still owns the run).
- Else: `status = paused`, clear pid, mark in-flight **node** (and last attempt) `interrupted` with “Inspect the workspace before retrying.” (`:1183–1185`). Event: “No agent work was automatically repeated.” (`:1195`).
- `resumeWorkflowRun` refuses if any node is `interrupted` (`:1088–1089`).
- `retryWorkflowNode` requires paused/failed run, user-chosen node, then queues retry and leaves run paused (`:1121–1153`). User must `resume` again.

This **is** inspect-before-retry at **run/node** scope, not Mesh attempt/worktree scope. It does **not** kill orphan Codex children (those maps died with the old process). It does **not** cover chat sessions. Preserve the user-visible inspect/retry; replace pid liveness with incarnation+lease in MESH-02.

---

## 7. SQLite tables touching sessions / threads

| Table | Role | Mesh |
| --- | --- | --- |
| `chat_threads` (`schema.ts:79–102`) | Conversation; `provider_thread_id` + `provider_thread_provider` | Local resume handle |
| `chat_sessions` (`:104–114`) | One execution of a thread; id = Codex UUID when IPC supplies it | Local; no pid/attempt |
| `chat_messages` (`:116+`) | Transcript; `session_id` FK | Latent summary input |
| `chat_artifacts` (`:228+`) | File artifacts; `file_path` may be absolute | Not provider checkpoints |
| `agent_ui_intents` (`:141–155`) | Plan/question UI | Local; `providerThreadId` in JSON scope |
| `workflow_runs` (`:208–223`) | Graph + `runtimeOwnerPid` in `graph_json` | Local execution |
| `automation_runs` (`:700–713`) | Daemon runs; `worktrees_json` | Local |
| `ba_sessions` (`:437–448`) | Spike worktree + stash | Local; stash ≠ handoff |
| `workspace_scaffold_sessions` (`:649–660`) | Absolute `root_path` | Local |

No attempt-journal, handoff, or checkpoint table. Add in SESSION-02/03 + MESH-02; do not overload `chat_sessions.id` as Mesh `sessionId` without a separate logical id (spec §10:391).

---

## 8. Risks

1. **Cross-device `thread/resume` looks implemented and is not portable.** Highest product-risk. SESSION-02 must label same-home vs remote.
2. **Spawn-before-journal** orphans processes; remote retries would double-apply Git/API effects (spec §9:381). Default `inspect-before-retry` / `never` for coding jobs.
3. **Ambient `process.env` on a Mesh worker** leaks host credentials into untrusted agent processes (spec §7, §12).
4. **Electron pid reuse** can skip workflow recovery (`workflow-persistence.test.ts:216–223` only tests live-self).
5. **`stopSession` does not prove stop** → dual activation under SESSION-03 if copied as-is.
6. **Cursor listed beside Codex in `AgentProvider`** but has no resume; UI `resumable` may be true after ACP `session/new` while handoff is impossible.
7. **Timeout orphan** (20s) leaves app-server running with no IPC session.
8. **Approvals / plans in RAM** vanish on crash; Mesh durable approvals need a new store (MESH-03), reusing only `resolveApproval`.
9. **No CLI version pin** on resume (`detectCodexCli` caches 30s, `codex-bridge.service.ts:17–19`). Adapter must record verified CLI versions.
10. **BA and automation** sit outside chat persistence; easy to miss in SESSION-02 job kinds.

**Out of scope for SESSION-02:** making Cursor ACP portable; checkpoint-import (vendor-dependent; only after Codex documents an export); using `run-process` or companion HTTP as Mesh transport (PLAN-01).

PLAN-01 §6 findings confirmed: logical id ≠ provider thread id ≠ PID; spawn-before-persist; ambient env; in-memory approvals; workflow inspect-before-retry at run scope. This packet adds: Cursor ACP has no resume; workflow Cursor is print-only; `provider_turn_id` / `endChatSession` are dead APIs; 20s ready-timeout orphans; BA skips `chat_sessions`; no adapter declarations; summary-continuation is the honest G4 default.

---

## 9. Remediation log

- **Env allowlist (done, this branch):** `agent-spawn-env.ts` exports `providerSpawnEnv()` — an allowlisted spawn env (base session vars, proxies, XDG/`CODEX_HOME`, git transport incl. `SSH_AUTH_SOCK` for local agent-driven git ops, and provider credential vars `OPENAI_API_KEY`/`AZURE_OPENAI_API_KEY`/`CODEX_API_KEY`/`CURSOR_API_KEY` as target-local bindings). Applied to all provider CLI spawns: `codex-session.service.ts` (interactive), `llm.service.ts` (`cursor-agent` print + `codex exec`). `run-process` keeps ambient env by design (user-invoked arbitrary shell). A remote Mesh worker job spawn uses the stricter bootstrap-runner env — `providerSpawnEnv` is local-interactive only.
- **Capability matrix (done, `b38abc6`):** `provider-capabilities.ts` encodes the continuation-mode verdicts (`native-resume` same-`CODEX_HOME`-only for Codex, `summary-continuation` for Cursor, `unsupported` for one-shot print mode).
- **Still open:** attempt journal before spawn; stable creation key into `thread/start`; 20s ready-timeout orphan kill; CLI version pinning on resume; `stopSession` proof; BA/automation outside `chat_sessions`.
