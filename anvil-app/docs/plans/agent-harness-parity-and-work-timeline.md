# Agent harness parity and the work timeline: review and remediation plan

Status: proposed · Scope: `anvil-app` provider harnesses (`src/main/services`, `src/shared`, `src/renderer`) · Date: 2026-09-23

Companions: [`first-run-to-first-change-remediation.md`](./first-run-to-first-change-remediation.md) covers the activation journey and indexing; [`ui-surfaces-review.md`](./ui-surfaces-review.md) covers the Chat/Settings/Workspace surfaces (its CH1–CH3 findings on the access chip and Work block are referenced, not repeated). This one covers how Codex, Cursor, Devin and the other agent backends are integrated and how reasoning, tool calls, diffs, approvals and usage are surfaced per harness.

Method: code review only — the app was not run. Anything needing a live check is marked **verify**.

Severity: **P0** data loss, security or trust · **P1** notable friction or correctness · **P2** polish · **P3** hygiene.

---

## TL;DR

There is really **one shared event contract** (`CodexEvent`, `types.ts:1167-1243`) fed by **three producer families**: the Codex app-server JSON-RPC protocol (providers `codex`, `azure`, `openai`, `llmgateway`), the ACP subprocess protocol (`cursor`, `devin`), and a local-LLM shim that synthesises a text-only turn. Normalisation is centralised in `handleCodexServerLine` (`codex-protocol.service.ts`), which is good — but the ACP mapping is lossy in exactly the places that matter most:

- **The worst gap is a trust break, not a rendering one.** Two separate leaks: a persona forced to read-only keeps its clamp on `session.mode` but the raw `codexMode` is what gets sent to `session/set_mode` (H1); and a mid-turn composer send on a Cursor/Devin session calls `steer`, which throws because ACP sessions never have a `turnId` — after the message was already rendered and persisted as `[steer] …` (H2).
- **ACP diffs are dropped.** Cursor/Devin edits arrive as ACP `tool_call` content blocks; the parser flattens them to the string `Edited <path>` and discards the diff body, so no `file_edit` events ever fire. No DiffViewer rows, no "Review changes", and Agent Runs report `changedFileCount: 0` for every ACP chat run (H3).
- **Resume/fork are silently ignored for ACP.** `session/new` is always sent; `providerThreadId` is stored and passed back but never used, while `resumable: true` is still reported (H4).
- **Usage never reaches the chat UI for anyone.** `usage`/`usage_context`/`turn_outcome`/`context_compaction` are recorded for Dojo telemetry and then dropped before the window broadcast — including the ACP cost figure that is computed and then thrown away (H5).
- **Non-chat execution paths are Codex-only.** Automations spawn `codex app-server` regardless of the configured provider; workflows run ACP through a one-shot print CLI that persists no work events at all and spreads the full `process.env` into the child; Mesh sessions don't accept ACP providers (H6, H7).

---

## 1. The harnesses today

| Harness | Providers | Entry | Protocol |
|---------|-----------|-------|----------|
| Codex app-server | `codex`, `azure`, `openai`, `llmgateway` (managed runtime) | `startSession` → `codex app-server` | Codex JSON-RPC: `thread/start|resume|fork`, `turn/start|steer|interrupt`, `item/*`, `thread/*` (`codex-session.service.ts:294-302`, `codex-protocol.service.ts:379-724`) |
| ACP agents | `cursor` (`cursor-agent acp`), `devin` (`devin acp`) | same `startSession`, `isAcpAgentProvider` branch | ACP: `initialize`, `authenticate`, `session/new`, `session/prompt`, `session/set_mode`, `session/set_config_option`, `session/cancel`, `session/update`, `session/request_permission` (`codex-session.service.ts:416-433`, `522-547`) |
| Local LLM | `localLlmProvider` (apple / ollama / lm-studio) — not an `AgentProvider` | `tryLocalLlmChatReply` inside `chat:send` | Synthesised `text`/`status`/`turn_outcome` events via `emitLocalAssistantTurn*` (`chat.ipc.ts:171-233`, `codex-session.service.ts:666-699`) |
| Background (automations) | `settings.llmProvider` — but always Codex-shaped | `automation.service.ts` | `codex app-server` unconditionally (`automation.service.ts:464-466`) |
| Background (workflows) | per-node provider | `runAgentThread` | Codex app-server with full event persistence, or ACP one-shot print CLI with none (`workflow.service.ts:608-937`, `939-958`) |
| Remote (Mesh) | `RemoteSessionProvider = 'codex' \| 'azure' \| 'openai'` | `mesh-session.service.ts` | Codex app-server only; ACP excluded by type (`mesh-session.service.ts:28`) |

## 2. Per-harness capability matrix (chat)

| Capability | Codex-family | Cursor (ACP) | Devin (ACP) | Local LLM |
|------------|--------------|--------------|-------------|-----------|
| Streamed answer | `item/agentMessage/delta` + `codex/event/agent_message_content_delta`, with `itemId` + phase | `agent_message_chunk`, no `itemId`/phase | same as Cursor | `text` deltas only |
| Reasoning stream | `item/reasoning/*Delta` → `thinking` (`codex-protocol.service.ts:682-688`) | `agent_thought_chunk` → `thinking` (`:256-258`) | same | none |
| Command rows | `command_exec` with command, streamed output, exit code | `tool_call` kind `execute` — no exit code, output folded into `toolOutput` text | same | none |
| File edits | `file_edit` with real unified diffs, streamed via `patchUpdated`/`outputDelta` (`:525-527`, `568-572`, `658-670`) | **none** — diff blocks become the text `Edited <path>` (`:806-808`) | same | none |
| Tool calls | `tool_call` (`:527-535`) | `tool_call`/`tool_call_update` merged by `toolCallId` (`:277-295`) | same | none |
| Approvals | `command` / `file_change` / `permissions` kinds with command, cwd, grantRoot (`:574-611`) | `session/request_permission` → generic `permissions` kind + options (`:308-329`) | same | n/a |
| Structured input | `user_input` + `mcp_elicitation` (`:613-646`) | `cursor_ask_question`, `cursor_create_plan`, `elicitation/create` (`:331-377`) | `elicitation/create` only | n/a |
| Plans | `turn/plan/updated` → `plan_update` + plan intent | `session/update` `plan` → `plan_update`; `cursor/create_plan` → question intent | `plan` update only | none |
| Goals | `thread/goal/updated|cleared` (`:488-497`) | none | none | none |
| Subagents | `collabAgentToolCall` / `subAgentActivity` → `subagent_update` (`:536-539`) | none | none | none |
| Mid-turn steer | `turn/steer` | **broken** — `steerTurn` throws (no `turnId`) | same | n/a |
| Interrupt | `turn/interrupt` | `session/cancel` (`codex-session.service.ts:706-713`) | same | n/a |
| Resume / fork | `thread/resume` + `thread/fork` (`:453-465`) | ignored — `session/new` only (`:429-433`) | same | n/a |
| Token usage | `thread/tokenUsage/updated` → `usage` deltas (`:408-434`) — Dojo telemetry only, never reaches the renderer | `usage_update` → `usage_context` (context used/size + cumulative USD delta, `:223-252`) — same dead end | same | none |
| Access-level mapping | `approvalPolicy` + `sandboxPolicy` per turn (`codex-session.service.ts:552-561`) | collapses to `ask`/`agent`/`plan` (`:218-219`) | `ask`/`accept-edits`/`smart`/`bypass`/`plan` (`:205-216`) | n/a |
| Agent UI intents | `plan_update` + `input_request` → intents (`codex-agent-ui.adapter.ts:26-52`) | same adapter, plus Cursor question/plan kinds | same adapter | n/a |
| Thread status flags | `thread/status/changed` → `waitingOnApproval`/`waitingOnUserInput` (`:392-406`) | none | none | none |

## 3. What's already good

Keep these when making changes:

- **One event contract, one renderer.** `ChatEventRenderer`/`TurnWorkMessage`/`ActivityGroupMessage` consume `CodexEvent` with almost no per-provider branches (`ChatMessage.tsx:44-87`); the only provider-named UI is the Cursor question/plan components and the `cursor_*` request kinds in shared types.
- **ACP normalisation is centralised** in `handleCodexServerLine`, so fixing the lossy mappings fixes both ACP providers at once.
- **Tool-call lifecycle merging works for ACP**: `tool_call` + repeated `tool_call_update`s collapse into one row via `toolCallId` (`ChatContext.tsx:2745-2785`), including id-less updates attaching to the running call.
- **Approvals and questions are unified into AgentUIIntents** across all three providers (`codex-agent-ui.adapter.ts`), including JSON-schema elicitation → question mapping.
- **A provider capability registry already exists** (`provider-capability.service.ts:51-98`) and honestly records that Cursor can't resume and Devin is unverified — it just isn't read by anything but its own test.
- **ACP mode/model are set per prompt** (`session/set_mode` + `session/set_config_option`, `codex-session.service.ts:529-540`), so switching access level or model mid-thread works on Cursor/Devin.
- **Reasoning does stream for ACP** (`agent_thought_chunk` → `thinking`) and coalesces into one collapsible trace (`chat-turns.ts:111-121`). Parity at the event level is real; the gap is downstream.

## 4. Findings

### 4.1 Trust and correctness

| ID | Sev | Finding | Evidence |
|----|-----|---------|----------|
| H1 | **P0** | **The persona read-only clamp is dropped for ACP providers.** `resolvePersonaCodexPolicy` computes `sandbox: 'read-only'` for personas with `canWriteFiles: false` (and for plan mode) and stores it on `session.mode`, but the ACP branch sends `session/set_mode` with the raw settings `mode`, not the clamped one. On Codex the same policy feeds `approvalPolicy`/`sandboxPolicy` and is enforced per turn. A read-only persona on Cursor/Devin still runs in `agent`/`smart`/`accept-edits` mode. **verify** live that a read-only persona on Cursor can write. | `codex-session.service.ts:515-532` (uses `mode`, not `session.mode`), vs `:552-561` (Codex path uses `codexPolicy`) |
| H2 | **P0** | **Mid-turn sends are silently undeliverable on Cursor/Devin.** When `busy`, the composer routes to `steer()` (`ChatView.tsx:588-596`). `steerTurn` throws `No active Codex turn to steer` because `turnId` is only ever set by Codex's `turn/started` (`codex-protocol.service.ts:440-448`); ACP has no turn object. The renderer has already appended and persisted the message as `[steer] …` (`ChatContext.tsx:1979-2005`), and the rejection is unhandled (`void steer(...)`). The transcript shows a message the agent never received. **verify** the user-visible outcome. | `codex-session.service.ts:585-598`, `ChatView.tsx:588-596`, `ChatContext.tsx:1969-2006` |
| H3 | P1 | **ACP file edits never become `file_edit` events.** ACP `tool_call` `content` blocks of `type: 'diff'` are flattened to `Edited <path>` and the diff body is discarded. Consequences: no `DiffViewer` row, no "Review changes" affordance (`ActivityGroupMessage` keys off `file_edit`, `ChatMessage.tsx:98`), `changedFileCount` in Agent Runs is always 0 for ACP chat runs, and evidence/test detection that keys off `command_exec`/`file_edit` misses everything (`chat-evidence.service.ts:200-204`, `245-255`). | `codex-protocol.service.ts:806-808`, `agent-run.service.ts:80-93` |
| H4 | P1 | **Resume and fork are silently ignored for ACP.** `providerThreadId`/`forkFromProviderThreadId` are honoured only in the Codex handshake; the ACP branch always sends `session/new`. `chat:fork-provider-thread` then stores the fresh ACP session id as if a fork had happened. `sessionToPublic` reports `resumable: true` anyway. The capability registry documents the limitation but nothing consumes it, so the UI never degrades the affordance. | `codex-session.service.ts:429-433` vs `:446-465`, `:1390`; `chat.ipc.ts:292-300`, `426-455`; `provider-capability.service.ts:79-91` |
| H5 | P1 | **Usage and cost never reach the chat UI, for any provider.** `broadcastEvent` records `usage`/`usage_context`/`turn_outcome`/`context_compaction` to Dojo telemetry and returns before notifying subscribers or windows. ACP `observedCostUsd` is computed and thrown away; `contextUsage` (used/size) likewise. The only usage surface is `codex-usage:snapshot`, which is Codex-only (`account/usage/read`). agent-run-system.md §9 lists "provider, model, context, duration and cost metadata" as a product goal — the data exists and goes nowhere. **verify** whether any surface reads `contextUsage`. | `codex-session.service.ts:1302-1330`, `codex-usage.service.ts:103-204`, `codex-protocol.service.ts:223-252` |
| H6 | P1 | **Non-chat execution ignores the provider.** Automations spawn `codex app-server` whenever `llmProvider` isn't `llmgateway` — a Cursor- or Devin-primary setup runs the Codex CLI anyway (and fails if it isn't installed). Mesh sessions exclude ACP by type. Workflows do handle ACP but through a one-shot print CLI (`cursor-agent -p`, `devin --print`) that persists only the final assistant text — no tool calls, no diffs, no reasoning — so an ACP workflow step's work timeline is empty compared to a Codex step's full event stream. | `automation.service.ts:462-466`, `mesh-session.service.ts:28`, `workflow.service.ts:706-732` vs `:805-937` |
| H7 | P1 | **`runAcpCliThread` bypasses the spawn-env allowlist and the chosen access level.** It spreads the full `process.env` into the child (ambient tokens leak — the exact thing `providerSpawnEnv()`/SESSION-01 exists to prevent), and Devin steps are hard-coded to `--permission-mode smart --respect-workspace-trust false` regardless of the user's access setting or persona policy. | `workflow.service.ts:853-871` vs `agent-spawn-env.ts:1-20`, `workflow.service.ts:772-789` (Codex path applies `personaPolicy`) |

### 4.2 Surfacing inconsistencies

| ID | Sev | Finding | Evidence |
|----|-----|---------|----------|
| H8 | P2 | **ACP approvals lose their detail and never reach secondary surfaces.** All ACP permission requests become `approvalKind: 'permissions'` — no command string, cwd or grant root (the renderer falls back to a JSON dump of `toolInput`, `ChatMessage.tsx:664-668`). And `pendingApprovalDetails` is only populated for `command`/`file_change`, so mobile-companion approvals and the statusbar pending count are blind to Cursor/Devin requests. | `codex-session.service.ts:1123-1135`, `codex-protocol.service.ts:308-329`, `mobile-companion.service.ts:1173-1174`, `statusbar.service.ts:56` |
| H9 | P2 | **The four-level access control collapses on Cursor.** `resolveAcpSessionMode` maps everything except `read-only`/`plan` to `agent` — "Approve for me", "Auto approve" and "Full access" are indistinguishable. Devin maps four levels more honestly (`ask`/`accept-edits`/`smart`/`bypass`). Combined with CH1 (the access level is invisible in the composer), a user can believe they chose "Approve for me" while Cursor runs in its normal agent mode. | `codex-session.service.ts:200-220` |
| H10 | P2 | **Command rows lose their semantics on ACP.** ACP `execute` tools render as generic `Tool:` rows — no `command`/`exitCode`/`output` fields, so the terminal-style `CommandExecEvent` UI (exit badge, output tail, copy actions) is never exercised, and `isLikelyTestCommand` never sees ACP runs (test detection in turn summaries is Codex-only in practice). | `codex-protocol.service.ts:277-295`, `ChatMessage.tsx:1412-1487`, `chat-evidence.service.ts:202` |
| H11 | P2 | **Reasoning is live-only for every provider.** `thinking` is excluded from `shouldPersistEvidenceEvent` (duplicated in both places the list exists), so the reasoning trace vanishes on thread reload even though tool calls and plans persist. If that's deliberate (privacy/size), it isn't stated anywhere. | `ChatContext.tsx:2721-2738`, `browser-workspace-executor.service.ts:224-240` |
| H12 | P2 | **The goal control is Codex-backed but not gated.** The goal popover works by sending a prompt and waiting for `thread/goal/updated`, which only Codex emits. Its copy says "Stored on this thread when Codex confirms the goal update" — on a Cursor/Devin thread the control silently does nothing. **verify** whether the popover renders for ACP sessions. | `ChatView.tsx:2007-2028`, `codex-protocol.service.ts:488-497` |
| H13 | P2 | **Shared copy hard-codes "Codex"** in strings that show on Cursor/Devin turns: "Codex did not provide a renderable patch", "Codex wants permission", "Codex needs your input", "Codex sent an empty input request", "Codex could not complete this turn." The protocol layer already knows the agent's label (`agentLabel`, `codex-session.service.ts:344`) — it just isn't carried onto the events the renderer sees. | `ChatMessage.tsx:587, 637, 807, 920`; `ChatContext.tsx:1498` |

### 4.3 Hygiene

| ID | Sev | Finding | Evidence |
|----|-----|---------|----------|
| H14 | P3 | **Dead capability surface.** `file_read` is in the `CodexEvent` union, rendered, persisted and counted — but no provider path emits it (no producer in `codex-protocol.service.ts`). `CodexSession.resumable` is set but has no renderer readers. `chat:list-turn-summaries`/`listChatTurnSummaries` builds a per-turn evidence model (changed files, commands, tests, errors) that no renderer calls. `provider-capability.service.ts` is read only by its test. | `types.ts:1171`, `codex-session.service.ts:1390`, `chat-evidence.service.ts:134`, `preload/index.ts:263-264` |
| H15 | P3 | **Devin's env-var auth path is inconsistent.** `devin-bridge.service.ts` documents `WINDSURF_API_KEY` as a credential source and `detectDevinCli` (ambient env) honours it, but `providerSpawnEnv`'s `PROVIDER_CREDENTIAL_ALLOWLIST` has no `WINDSURF_API_KEY`/`DEVIN_*`, so detection can pass while the spawned ACP session can't authenticate. **verify** against a real key-based setup. | `devin-bridge.service.ts:213-215`, `agent-spawn-env.ts:68-73` |
| H16 | P3 | **Provider-branded naming for a multi-provider contract.** `CodexEvent`, `CodexSession`, `chat:event`, `cursor_ask_question`/`cursor_create_plan` request kinds in shared types. Renames are cheap to do mechanically now and get more expensive as the browser companion and Mesh adopt the contract. | `types.ts:1137-1165`, `1167-1243` |

## 5. Remediation plan

### Phase 0 — stop the trust leaks (H1, H7, H2)

- Pass the persona-clamped policy into `resolveAcpSessionMode` (feed it `session.mode` or the resolved sandbox, not raw `settings.codexMode`) so `canWriteFiles: false` personas land on `ask` for both ACP providers.
- `runAcpCliThread`: use `providerSpawnEnv()` like every other spawn, and map the node's access level to Devin's `--permission-mode` instead of hard-coding `smart`.
- Fix the busy-send path for ACP: either route it to `sendMessage` after the turn completes (reuse the `pendingPlanFeedback` queue mechanism, `codex-session.service.ts:1044-1054`, `1244-1260`) or show "agent is busy — send when it finishes" instead of writing a `[steer]` entry that goes nowhere. Don't persist the user entry until the provider accepted it.

### Phase 1 — work-timeline parity (H3, H10, H8, H5)

- Emit `file_edit` events from ACP `diff` content blocks (keep `path` + reconstruct a unified diff from `oldText`/`newText` when offered, else emit `file_edit` with empty diff — the renderer already handles "no renderable patch"). Emit `command_exec` from ACP `execute` tool calls with command + output + status.
- Promote ACP `session/request_permission` detail into the approval event (command/cwd where the tool call carries them) and register ACP approvals in `pendingApprovalDetails` so mobile and the statusbar see them.
- Forward `usage`/`usage_context` to the renderer (drop only the raw turn internals if needed) and render a per-turn footer: model · tokens or context used · cost when known. This is also the cheapest place to land the "changes summary" footer from CH2 once `file_edit` flows for ACP.
- Decide whether `thinking` persists (H11) — if yes, add it to `shouldPersistEvidenceEvent` in both copies and reconstruct it in `chatMessagesToEntries`.

### Phase 2 — lifecycle honesty (H4, H9, H12)

- Wire `provider-capability.service.ts` into the session surface: return the provider's verified modes on `CodexSession`, and gate Steer/Fork/Goal and the access-level options on it rather than showing Codex-shaped affordances for ACP sessions. Fix `resumable` to reflect the registry (or delete it if nothing reads it — it currently has no readers).
- If Cursor/Devin CLIs now expose `session/load` or resume, implement it and flip the registry to verified; if not, make fork produce an honest "new thread seeded from transcript" state. **verify** current CLI capabilities.
- Label the access select per provider (Devin's `smart`/`bypass` are closer to Auto approve/Full access; Cursor's collapse should at least be acknowledged in copy or collapsed to two options).

### Phase 3 — naming and non-chat parity (H13–H16, H6)

- Carry the agent label onto `CodexEvent` (`event.agentLabel`) and replace the hard-coded "Codex" strings. Optionally rename the shared contract (`AgentSessionEvent`) behind a type alias — mechanical, but do it once.
- Automations: route through `runAgentThread`-style provider selection (or extract the shared spawn logic) so a Cursor/Devin-primary install doesn't invoke `codex`.
- Workflows: consider driving ACP through the long-lived `acp` subprocess (like chat) instead of print mode so steps stream `tool_call`/`plan` events into the timeline; if print mode stays, say so in the run UI ("step ran without event capture").
- Add `WINDSURF_API_KEY` (and any `DEVIN_*` vars the CLI documents) to the credential allowlist, or drop the claim from `devin-bridge.service.ts`.
- Clean up dead surface: `file_read` (emit it or remove it), `listTurnSummaries` (wire it into a per-turn evidence view or remove the IPC), `resumable`, `ChatStatusBar` (already CH11).

## 6. Open questions

- Do current Cursor/Devin CLI versions expose `session/load`, checkpoints, or any resume primitive? The audit that produced `provider-capability.service.ts` says no; that was written before whatever the CLIs ship now. **verify**
- ACP `diff` blocks: emit them as `file_edit` (same render path, requires reconstructing a unified diff) or as a new event type that preserves `oldText`/`newText` fidelity for a dedicated editor?
- Should reasoning persist across reloads? Streaming it and then discarding it makes the work timeline thinner on reload than live — which may be a deliberate privacy choice that should be written down, or an oversight.
- Do Devin's `session/request_permission` options always use the same `allow_once`/`allow_always`/`reject_*` kinds as Cursor, or does Devin need its own parsing? `getCursorPermissionOptions` is Cursor-named but generic — if Devin's option shapes differ, approvals will silently fall back to Approve/Decline. **verify**
- Is the goal feature intended to stay Codex-only? If yes, gate the control; if no, it needs a non-protocol fallback (e.g. thread metadata rather than provider events).
- Where should per-turn cost live: the turn footer (Phase 1), the thread header, or Dojo only? ACP already computes USD deltas that currently vanish.
