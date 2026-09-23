# UI/UX remediation progress

**Status: implementation COMPLETE as of 2026-09-23.** All workstreams landed and verified. Final checks: `vitest run` 206 files / 1,591 tests pass, 0 failures · `tsc` node + web clean · `pnpm lint` 0 errors 0 warnings · `pnpm build` success. Not committed; live `pnpm dev` walkthrough of **verify** items still outstanding. Two stale-failure fixes applied: sync-persistence SCHEMA_VERSION assertion → 96; mobile-companion-addresses `node:os` mock gained `homedir`; `pnpm rebuild better-sqlite3` for Node 24 binding.

Tracks implementation of the two review plans. Source of truth for decisions and workstream status.

## Plans being implemented

- `anvil-app/docs/plans/first-run-to-first-change-remediation.md` (J/R/X/C/O/S IDs, Phases 1–5)
- `anvil-app/docs/plans/ui-surfaces-review.md` (CH/ST/OB/WS/RM/NV/DS IDs, Phases A–E)
- `anvil-app/docs/plans/agent-harness-parity-and-work-timeline.md` (companion doc being written)

## Decisions (2026-09-23, confirmed with Anth)

- **Scope: all phases** of both docs.
- **Nav:** repos are part of a workspace → `/workspace` overview is the workspace home; repository management lives inside it. Nav label "Workspace". `/repos` keeps working (redirect/tab).
- **Workspace delete:** hard delete + honest themed dialog — lists what will be deleted, states it syncs to other devices, type-to-confirm for workspaces with history.
- **Enrichment:** auto-runs for all providers when enabled (no per-provider metering gate).
- **Change Review vs Code Review:** keep separate, renamed "Changes" and "PR Review", different icons (done).
- **RepositoryGarden/RepositoryTwin:** KEEP — plan's "dead code" premise was stale; `RepositoryMap.tsx:77-81,369-391` lazy-loads and renders both (used by RepoDetail + CodeReviewReport). ChatStatusBar deletion still valid (chat agent).
- **Repo forget:** reviews/audits referencing the repo are kept orphaned (no cascade).
- **Access default:** per-workspace default lives in Settings → Workspace.
- Implementation subagents requested as Luna xHigh (host maps model; using general subagent profile).

## Worktree warning

Shared worktree contains unrelated in-flight work (browser workspace, sync mesh, market readiness — see `BROWSER_WORKSPACE_PROGRESS.md`, `MARKET_READINESS_PROGRESS.md`). **Do not revert.** `db/schema.ts` already has browser-workspace migrations — new index migrations append after them with the next SCHEMA_VERSION.

## Waves and workstreams

| Wave | Workstream | Owns | Status |
|------|-----------|------|--------|
| 1 | `indexing-backend` | `src/main/services/repo-index*.ts`, `indexer.service.ts`, `persona.service.ts`, `src/main/ipc/repo.ipc.ts`, `workspace.ipc.ts` (triggers only), `workspace-scaffold.service.ts`, `db/schema.ts` (new migration), `src/shared/*` index-job types, `src/preload/index.ts` (index APIs only) | done — schema v96, repo_index_jobs + index_tier + content_hash, 9 files/99 tests pass, node typecheck clean. IPC: `repo:index`, `repo:index-jobs`, `repo:cancel-index`, `repo:forget`, `repo:index-progress` broadcast; tiers mapped/enriched; reasons connect/manual/commit/scaffold. Flagged: workitems.ipc.ts:118 still gates on `status='indexed'`; live `pnpm dev` unverified |
| 1 | `ui-primitives` | `src/renderer/components/ui/*` (new), `styles/global.css`, tailwind config | done — Button/IconButton/Dialog/ConfirmDialog/PromptDialog/Menu/SegmentedControl/cx; `accent-foreground` + `scrim` + `text-eyebrow` tokens; AA contrast test parses CSS; typecheck/lint/build green |
| 1 | `harness-parity-doc` | `anvil-app/docs/plans/agent-harness-parity-and-work-timeline.md` only | done — written; found trust-level gaps (H1–H16): persona read-only clamp not enforced on ACP (Cursor/Devin run in agent mode), ACP diffs discarded, steer() throws post-render, env allowlist bypass. **Remediation is new scope — flagged to Anth, not started.** |
| 2 | `chat-surface` | `src/renderer/components/chat/**`, ChatPaneState/ChatView split, access chip, TurnChangesFooter | done — ChatView 2,794→791 lines, access chip+Full-access confirm, TurnChangesFooter (review/commit/PR), error classifier, rail filter+layout toggle, persona recents, ChatStatusBar deleted, 98 chat tests pass |
| 2 | `settings-surface` | `src/renderer/components/settings/**`, dirty tracking, category split, `/settings/:category` contract | done — SettingsView 3,605→~456 lines, 9 lazy categories + registry, per-key dirty+autosave (credentials manual), `/settings/:category#panel` wired, `SettingsLink` + `RoleHiddenNotice` built, AI split providers/agents, 28 tests pass |
| 2 | `workspace-shell` | WorkspaceContext/RepoIndexContext, readiness strip, repos+workspace overview, remove-repo UI, onboarding, App.tsx | done — `/workspace` home route, merged 2-step Welcome flow + onboardingStep resume, RepoIndexContext + WorkspaceReadinessStrip, RemoveRepoDialog + repo:forget, AddRepositoriesDialog, mapped-tier unlocks, starter-prompts helper, 15 new tests pass |
| 2 | `nav-shell` | sidebar-navigation, Sidebar, StatusBar, CommandPalette | done — NV1-5, WS4 palette+⌃1-9, OB1 "Repo setup" label, pin-to-nav (cap 5), aria-disabled gating, services/repo popovers, 35 tests pass |
| 3a | `integration` | cross-workstream wiring per checklist below + Workspace settings category + gated-view empty states + audits | done — nav→/workspace, strip mounted in Chat, starter prompts wired, RoleHiddenNotice in guard, SettingsLink sweep, WorkspaceCategory panel (repos/add/remove/forget/re-index + per-workspace access default), RepoFeatureEmptyState on 12 gated routes, all audits pass, typecheck+lint clean |
| 3b | `cleanup` | text-white-on-accent codemod, remaining native dialogs, DS3/DS4 lint, copy sweep, measurement note | done — DS1: ~60 `bg-accent`+`text-white` sites → `text-accent-foreground` (incl. icons in accent buttons, `text-white/70` selected rows); left text-white on bg-error/recording (intentional) + bg-info/bg-success/dynamic persona & agent colours (no token). Native dialogs: last 2 sites (AutomationsView delete, GateConfigView clear-all) → ConfirmDialog; zero remain. DS3: all 52 semantic amber/emerald/red/green sites → warning/success/error; `no-restricted-syntax` warn rule added scoped to `src/renderer` (verified firing); stage-utils.ts categorical stage hues intentionally left raw with scoped eslint-disable. DS4: 123 sub-12px sites → 46 `text-eyebrow` (badges/counters/uppercase) + 77 `text-xs`; zero remain. DS5: 7 `group-focus-within` reveals added (governance/git/terminal tabs); plan-named sites were already done. Copy: MissionControl/ISO/tongs already gone; nav "Workspace"/WorkspaceView/ReposView consistent; `branding.ts` "Developer mission control" subtitle is deliberate brand copy. Verify: tsc web 0 errors, lint 0 problems, vitest 1589 pass + 2 known unrelated failures, build green |

## Wave-3 integration checklist (flags from completed agents)

- Swap primary nav `/repos` → `/workspace` once route lands (`sidebar-navigation.ts` + `Sidebar.tsx`, one-line each).
- StatusBar Fix links use `/settings?category=…` fallback → swap to `SettingsLink` (`components/shared/SettingsLink.tsx`, `to="delivery#git"` form) — `/settings/:category?` route is live in App.tsx:708; `/settings/ai` aliases to providers.
- Replace "in Settings" strings with `SettingsLink` at: WorkspaceCreator:364, WorkItemsView:313, DocsView:319, WorkItemThreadRail:374, OrchestrationPanel:244/639, ConnectorsStep:68, WorkflowsView:1203, ConnectorSetupOverlay, chat-model-options, SyncMeshSetupCard ×4.
- Wire `RoleHiddenNotice` into App.tsx `guard()` (App.tsx:312-320) — role-hidden routes currently redirect silently.
- Settings → Workspace category: registry seam documented in `settings-registry.tsx`; needs repo actions UI (repo:forget, index jobs) + per-workspace access default — assign in wave 3.
- Gated nav items now always navigate → each gated view needs an empty state with unblock CTA (`/editor`, `/security`, etc.).
- `ErrorBoundary.tsx:43` `bg-accent text-white` → `text-accent-foreground`; full codemod sweep of remaining `text-white`-on-accent + `window.confirm/prompt` call sites outside workstream files.
- Mount `WorkspaceReadinessStrip` in ChatView (component built by workspace-shell; ChatView owned by chat agent).
- `ChatEmptyState` starter-prompts integration — helper ready at `src/renderer/utils/starter-prompts.ts` (`getStarterPrompts`); needs chat-side consumer.
- `ChatContext.tsx:1037` and `ComplianceView.tsx:49` still gate on legacy `status === 'indexed'` → evaluate `index_tier`-based check.
- WS7 remainder: per-workspace chat drafts restore-on-return is chat-scoped — confirm with chat agent's report.
- Repo-scoped chat could later use `?repos=<id>` pinning (future).
- 2 failing test files in `src/main` (mobile-companion-addresses, sync-persistence schema-version assertion) — from in-flight sync-mesh work, NOT this effort; verify whether they're pre-existing dirty-tree failures before shipping.
- `workitems.ipc.ts:118` still gates on `status='indexed'` → switch to `index_tier`-based check.
- ⌃1–9 workspace shortcuts currently in CommandPalette; consider moving into Shell keydown handler.
- Measurement (plan §7): no PostHog/capture path exists in the desktop app — either wire minimal local instrumentation or document the gap.
- Full-suite `pnpm test`/`lint`/`build` + live `pnpm dev` pass on **verify** items.

## Wave-3 integration notes (2026-09-23)

- Measurement (plan §7) is **not wired**: no analytics capture path exists in
  the desktop app (no PostHog/capture plumbing in main, preload, or renderer),
  and this remediation deliberately does not invent one. The `gate_shown` /
  `first_repo_connected` / `mapped_to_unlocked` events in the plan remain
  undocumented instrumentation to revisit if/when a desktop analytics path is
  adopted.
- `RepoFeatureEmptyState` (`components/shared/RepoFeatureEmptyState.tsx`) is
  the shared unblock surface for all nav-gated routes: "Add a repository" →
  `/workspace` when empty, and the readiness strip while repos index.
- Settings → Workspace category landed (`settings-registry.tsx` +
  `categories/WorkspaceCategory.tsx`): workspace name, repo list with
  add/remove/re-index/forget, connection deep links, and the per-workspace
  chat access default (`WorkspaceContext.workspaceAccessDefault`, resolved in
  `thread-access.ts` ahead of the store default for threads without
  overrides).

## Caveat-fix wave (harness parity + measurement)

| Workstream | Scope | Status |
|-----------|-------|--------|
| `harness-session` | codex-session, agent-spawn-env, provider-capability, automation, workflow, shared types — H1/H2/H4/H6/H7/H9/H15 | done — persona clamp enforced on ACP, queued-send contract (`ChatSteerResult`, `queue_update`), native `session/load` resume verified on both installed CLIs, spawn-env allowlist, provider-aware automations, 48 tests pass |
| `harness-protocol` | codex-protocol, chat-evidence, agent-run, chat.ipc, ChatContext persist-list — H3/H5/H8/H10/H11/H14 | done — ACP diffs→file_edit (unified reconstruction+dedup), execute→command_exec, permission detail carried, thinking persists, dead listTurnSummaries removed, 140 tests pass |
| `harness-renderer` | components/chat/**, ChatContext — H2/H5/H8/H9/H12/H13/H14 renderer | done — queued-send UX, TurnUsageFooter, provider-aware access chip, goal gating, agentLabel strings, full suite 1639 pass |
| `metrics` | activation_events table + metrics.service + metrics:track IPC + §7 funnel emits (local-only) | done — schema v97 `activation_events`, `metrics:track` (allowlisted), emits wired in WelcomeOverlay/App/ChatView/TurnChangesFooter + main-side index-tier/enrich events, 44 tests pass |

**Final state (2026-09-23):** full suite 210 files / 1,646 tests — 0 failures · tsc node+web clean · lint clean · `pnpm build` success. Caveat fix complete: harness parity H1–H16 implemented (both ACP CLIs probed live — `loadSession` advertised, resume implemented), local-first activation metrics wired, live smoke verified migration path on real DB. Remaining: real `pnpm dev` session for **verify** items (blocked by installed Anvil's single-instance lock), commit decision deferred to Anth (worktree interleaved with other workstreams).

**Live smoke (2026-09-23):** `pnpm dev` builds main+preload+renderer clean; DB migrated v93→v96 without error against the real user database; startup then correctly refused because a release Anvil instance holds the single-instance lock. Remaining live **verify** items (read-only persona on Cursor writing, queued-send UX, per-turn usage footer) need a real `pnpm dev` session after the user quits the installed app — or wait for the next installable build.

Root integration fixes applied between agents: usage/usage_context now forwarded to renderer (early-return removed, `model` stamped); `stopSession` broadcasts `queue_update:0`; mobile approvals label `permissions` kind; `listTurnSummaries`/`ChatTurnSummary`/`file_read` dead surface removed from preload/ipc-api/types (file_read renderer handling kept for replaying old persisted events).

Decisions taken for harness work: ACP diffs→`file_edit`, execute→`command_exec`; `thinking` persists; busy ACP send = queued-ack (flush on turn end); goal control gated Codex-only; per-turn usage footer; fork on ACP = transcript-seeded honest state; cursor-agent + devin CLIs installed locally for capability checks.

## Verification

- Per-workstream: focused Vitest files + `pnpm lint` scoped.
- Per wave: `pnpm --dir anvil-app test`, `pnpm --dir anvil-app lint`, `pnpm --dir anvil-app build`.
- Items marked **verify** in the plans need a live `pnpm dev` check before sign-off.
