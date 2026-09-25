# First run → first change: UX review and remediation plan

Status: proposed · Scope: `anvil-app` renderer + repo indexing pipeline · Date: 2026-09-23

Companions: [`ui-surfaces-review.md`](./ui-surfaces-review.md) covers Chat, Settings, Workspaces, Repository management, navigation and the design system beyond the first-run path. [`agent-harness-parity-and-work-timeline.md`](./agent-harness-parity-and-work-timeline.md) covers Codex/Devin/Cursor harness parity and how reasoning and tool calls are surfaced.

## TL;DR

The path from a fresh install to a first agent-made change has a dead end in the middle. After a user creates a workspace with existing repos, the app sends them to `/chat`. Chat is disabled there and the screen offers nothing to click. They then have to guess that the "Workspace" nav item (the `/repos` route) holds a per-repo **Index** button, press it for each repo, and wait for an LLM pass over every module before Chat unlocks.

This happens because of three separate choices that together produce the dead end:

1. **Nothing starts indexing on the "Existing repos" path.** Only scaffold mode auto-indexes. It does this server-side in `workspace-scaffold.service.ts:186-195`.
2. **Chat is gated on `status === 'indexed'`.** A workspace with one un-indexed repo therefore gets *less* than a workspace with zero repos (`WorkspaceContext.tsx:114-137`).
3. **"Indexed" means "every LLM summary finished".** The fast structural pass (a few seconds) and the slow LLM enrichment (minutes) are one unit. The repo only becomes usable when both are done (`repo-index.service.ts`).

The fix is to split indexing into a fast structural tier that unlocks everything and a background enrichment tier, both run by a main-process queue that starts automatically on connect. The rest of this plan covers rough edges found alongside it, including the missing way to remove a repo from a workspace.

---

## 1. The current journey

| # | Step | Where | What the user runs into |
|---|------|-------|-------------------------|
| 1 | Role picker | `RolePickerOverlay.tsx` | Full-screen, no progress indicator, no idea how many steps are left. OK otherwise. |
| 2 | "Connect Your Tools" | `ConnectorSetupOverlay.tsx` (975 lines) | 4 accordion cards (agent, work items, git provider, Confluence). Only the agent matters for a first change, but all four carry the same weight. "Skip for now" is hidden inside each expanded card. There is no Back. |
| 3 | "Create Your First Workspace" | `WorkspaceCreator.tsx` via `WorkspaceGate` | Modal drawn over an empty shell with no way to cancel. Three modes (Empty / Existing / Scaffold), then Local/Remote tabs, then an optional work-item selector and a VS Code export checkbox. The only hint about indexing is small tertiary text (`:580-586`): *"You can index them from the Repositories page…"*. No page is called "Repositories" in the nav; it's labelled **Workspace** (`sidebar-navigation.ts:21`). |
| 4 | Lands on `/chat` | `App.tsx:737` catch-all | `chatEnabled=false`, so the **Chat nav item is greyed out** while you're on it. The composer is disabled and a warning triangle shows *"Index repositories to unlock this feature."* (`ChatView.tsx:1103-1112`). There is no button. |
| 5 | Sidebar says "Indexing" | `Sidebar.tsx:160-167`, `WorkspaceRail.tsx:200` | Nothing is actually indexing. `statusLabel: 'indexing'` is the fallback for "has repos, none indexed". The status is untrue. |
| 6 | Finds Workspace → Index | `RepoList.tsx:152-163` | You have to click Index once per repo. There is no "Index all". |
| 7 | Waits | `repo-index.service.ts` | Up to 15 module summaries plus 1 overview, all LLM calls. Concurrency is **1** for Codex (`:71`). That takes minutes. Progress only reaches the window that started the job (`repo.ipc.ts:66-71`) and only lives in `ReposView` component state. |
| 8 | Navigates away mid-index, comes back | `RepoList.tsx:139-151` | The repo now shows an amber **"Force Re-index — This repo appears stuck"** button, because local tracking state was lost. Clicking it calls `resetStatus` and starts a **second, concurrent** index of the same repo. `indexRepo` has no guard against that. |
| 9 | Chat unlocks | — | Empty-state suggestions are generic (*"explain how the authentication flow works"*) and ignore the index that was just built. |

Activation (first agent-driven change) is currently gated behind steps 5–8. Steps 5, 6 and 8 should not exist.

---

## 2. Findings

Severity: **P0** blocks or misleads the core journey · **P1** notable friction or a correctness bug · **P2** polish · **P3** hygiene.

### 2.1 Journey & workspaces

| ID | Sev | Finding | Evidence |
|----|-----|---------|----------|
| J1 | P0 | "Existing repos" workspaces never auto-index, but scaffold workspaces do. The same outcome goes through two code paths with different behaviour. | `WorkspaceCreator.tsx:179-226` vs `workspace-scaffold.service.ts:186-195` |
| J2 | P0 | Chat is disabled when repos exist but aren't indexed, yet enabled with zero repos. The gate punishes users who add repos. | `WorkspaceContext.tsx:114-137` |
| J3 | P0 | The disabled Chat state has no call to action, and the Chat nav item is disabled while you're on it. | `ChatView.tsx:1103-1112`, `Sidebar.tsx:475-501` |
| J4 | P1 | The workspace status label says "Indexing" when nothing is running. | `WorkspaceContext.tsx:132-137`, `Sidebar.tsx:160-167` |
| J5 | P1 | The same route is called "Workspace" in the nav, "Repositories" in its header and copy, and "Repositories page" in the creator. | `sidebar-navigation.ts:21`, `ReposView.tsx:285`, `WorkspaceCreator.tsx:583` |
| J6 | P1 | Workspace create/rename/delete use `window.prompt`/`window.confirm` (10 call sites across 8 files). These are browser dialogs, don't follow the theme, and are poor for keyboard and a11y. | `WorkspaceRail.tsx:82,91` and others |
| J7 | P2 | Workspace actions live in a hover-only `…` that appears only on the *active* row. It's hard to discover and can't be reached by keyboard unless focused. | `WorkspaceRail.tsx:229-240` |
| J8 | P2 | The creator runs repo connect/clone *serially* in the renderer before the workspace exists. If a clone fails halfway, the user gets a partial result and no workspace. | `WorkspaceCreator.tsx:180-225` |
| J9 | P2 | `connectorsConfigured` is inferred from `activeWorkspaceId`. Quitting between the connectors step and workspace creation replays the connector step. | `App.tsx:224-227` |
| J10 | P3 | No workspace-level settings surface exists. Repos, work-item connection and docs prefs are spread across creator, rail menu, and views. | — |

### 2.2 Repositories & indexing

| ID | Sev | Finding | Evidence |
|----|-----|---------|----------|
| R1 | P0 | Indexing is monolithic. The structural analysis (walk, languages, frameworks, modules, map graph) is fast, but the repo stays unusable until every LLM summary finishes. | `repo-index.service.ts:49-253` |
| R2 | P0 | Indexing is driven by the renderer. It is started by `ReposView`, tracked in component state, and its progress is sent to one `webContents`. The Chat screen, where the user is waiting, can't see it. | `ReposView.tsx:122-174`, `repo.ipc.ts:65-73` |
| R3 | P1 | The false "stuck" affordance plus no concurrency guard means two indexers can race on the same repo and both write `repo_summaries`. | `RepoList.tsx:139-151`, `ReposView.tsx:111-120`, `repo-index.service.ts` (no lock) |
| R4 | P1 | Re-indexing always re-summarises every module, even when nothing in it changed. `on_commit` map refresh does a *full LLM re-index* on every new commit (polled every 15 s). | `repo.ipc.ts:225-271` |
| R5 | P1 | `repo:status` silently flips anything `indexing` for over 30 min to `error`. That's a side effect inside a read call, and it will misfire on large repos with Codex concurrency 1. | `repo.ipc.ts:75-89` |
| R6 | P2 | Codex concurrency is hard-coded to 1 and others to 2. It isn't configurable and ignores module size, so small modules sit behind big ones. | `repo-index.service.ts:71` |
| R7 | P2 | Module identification is "top-level dir, max 15". Monorepos (e.g. `src/` holding 95% of files) produce one giant module and a poor summary. | `indexer.service.ts:179-206` |
| R8 | P2 | Progress UI shows `percent` jumps (15 → 85 in 70/N chunks) with no ETA. Once a job completes the history is discarded, so failures lose their context. | `ReposView.tsx:163-169` |

### 2.3 Removing a repo from a workspace

| ID | Sev | Finding | Evidence |
|----|-----|---------|----------|
| X1 | P0 | **There is no UI to remove a repo from a workspace.** The whole stack exists (`workspace:remove-repos` IPC → `removeReposFromWorkspace` → `WorkspaceContext.removeRepos`) but no component calls it. Today the only workaround is deleting the workspace. | `workspace.service.ts:536-553`, `WorkspaceContext.tsx:329-336`; grep for `removeRepos(` finds zero renderer callers |
| X2 | P2 | When a repo is no longer in any workspace, its row stays in `repos` along with its summaries and map graph. There's no "forget repository" to reclaim it, and nothing shows it's orphaned. | `repos` table has no workspace FK cleanup |

### 2.4 Chat

| ID | Sev | Finding | Evidence |
|----|-----|---------|----------|
| C1 | P0 | See J2/J3: gating and missing CTA. | — |
| C2 | P1 | Empty-state suggestions are static strings per persona and don't use the index. A repo-grounded first prompt is the quickest route to value. | `ChatEmptyState.tsx:6-…` |
| C3 | P1 | Scaffold copy says *"Other views stay locked until indexing finishes"*. Once tiered indexing lands, that lock should be seconds, not minutes. | `ChatView.tsx:1186` |
| C4 | P2 | `ChatView.tsx` (2 794 lines), `ChatMessage.tsx` (2 018) and `ChatInput.tsx` (1 944) are too big to review or change safely. The four near-identical empty-state branches (`:1103-1178`) show the cost. | — |
| C5 | P2 | The persona colour fallback is a hard-coded `#b5121b` instead of the accent token. | `ChatView.tsx:664` |
| C6 | P3 | Thread delete/rename use `window.confirm`/`prompt` (see J6). | `ChatThreadRail.tsx:183`, `ChatView.tsx:2156,2199` |

### 2.5 Onboarding (first run)

| ID | Sev | Finding | Evidence |
|----|-----|---------|----------|
| O1 | P1 | Three full-screen gates (role → connectors → workspace) with no step indicator, no Back, and branding repeated on each. | `App.tsx:350-364`, `WorkspaceGate` |
| O2 | P1 | The connectors step gives equal weight to 4 integrations. Only "Primary agent" is required for a first change. Work items, Git provider and Confluence should be deferred to point-of-need. | `ConnectorSetupOverlay.tsx:303-795` |
| O3 | P1 | The agent connection is never shown as verified before the user reaches Chat. If it's broken, the first failure happens mid-conversation. | `App.tsx:250-267` tests run silently in the background |
| O4 | P2 | "Onboarding" (`/onboard`) is also the name of a per-repo AGENTS.md/devcontainer wizard. It's gated on `repoFeaturesEnabled` and is a natural *post*-index next step, but nothing links to it. | `OnboardView.tsx`, `sidebar-navigation.ts:62` |
| O5 | P3 | The Danger area copy still says *"Start the MissionControl wizard again"*. | `SettingsView.tsx:2938` |

### 2.6 Settings

| ID | Sev | Finding | Evidence |
|----|-----|---------|----------|
| S1 | P1 | `SettingsView.tsx` is 3 605 lines. "AI & agents" alone runs from about line 1224 to 1993. Categories are `hidden`-toggled blocks in a single component, so every panel mounts at once. | `SettingsView.tsx` |
| S2 | P1 | The save models are mixed. Global settings use an explicit **Save** with an "Unsaved changes" state (`:977-1021`). Workspace prefs, custom agents, Codex AGENTS.md and devices each save separately. Users can't tell what is persisted. | — |
| S3 | P2 | There's no **Workspace** category. Repos, work-item connection, docs and launch prefs have no home (see J10). | — |
| S4 | P3 | Playful copy (*"not ISO-certified"*, *"Handle with tongs"*) is fine in moderation but should not sit on destructive actions. | `SettingsView.tsx:1179,2933` |

---

## 3. Target journey

The activation goal is a first agent-proposed change reviewed in Chat, **within five minutes of launch, with no dead ends**.

```
Welcome (1 screen)                      ─┐
  role (inline chips) + primary agent     │  one screen, step 1 of 2
  [Test] ✓ connected                      │
                                         ─┘
Add your code (1 screen)                ─┐
  Local folder / Clone / Start empty      │  step 2 of 2
  (Scaffold as secondary link)            │
  Workspace name auto-filled from repo    │
  [Open workspace]                        │
                                         ─┘
Chat (immediately usable)
  ┌ Workspace readiness strip ─────────────────────────────┐
  │ acme-api  ● Mapped · summarising 3/9 modules  ▸ details │
  └─────────────────────────────────────────────────────────┘
  Suggested first asks (generated from structural index):
    "Walk me through src/server"   "Add a test for …"   "Set up AGENTS.md"
  Composer enabled
```

Principles:

- **Never disable Chat because of indexing.** Indexing improves context. It isn't a precondition.
- **Readiness goes where the user is**, as a compact strip in Chat and the workspace rail, not on a separate page.
- **Status is truthful.** "Indexing" appears only while a job is running.
- **Deferred integrations appear at point of need.** Work items ask for a connection inside Work Items. Remote clone asks for a Git provider inside the clone tab.

---

## 4. Indexing redesign (logic and UX)

### 4.1 Tiered repo readiness

Replace the single `status` with an explicit tier. `status` stays for back-compat and is derived from the tier.

| Tier | Contents | Typical time | Unlocks |
|------|----------|--------------|---------|
| `connected` | git metadata (branch, remote, last commit) | instant | listing, editor, terminal, Git |
| `mapped` | `analyseRepo` (walk, languages, frameworks, modules, key files, config files) + repository map graph + `buildFallbackRepoSummary` | seconds | **Chat, all repo features** |
| `enriched` | LLM module summaries + LLM overview | minutes, background | better persona context, richer RepoDetail |

The key change is in `WorkspaceContext.featureAvailability`. `chatEnabled` is always `true` outside scaffold. `repoFeaturesEnabled` becomes `repos.some(r => tier >= 'mapped')`. `statusLabel` becomes `'preparing'` only while a job is actually queued or running, `'ready'` once any repo is mapped, and `'needs-attention'` on error.

`persona.service.ts:84-104` already tolerates missing summaries. It should also prefer structural data (languages, frameworks, entry points) when `enriched` isn't there yet, so the first chat answers stay grounded.

### 4.2 Main-process index queue

Add a new `src/main/services/repo-index-queue.service.ts` that owns all indexing:

- `enqueue(repoId, { reason: 'connect' | 'manual' | 'commit' | 'scaffold', tiers })` does nothing if the repo is already queued or running. This is the single concurrency guard (fixes R3).
- A global worker pool: structural jobs run immediately (cheap, CPU/IO), and enrichment jobs share one LLM pool whose size comes from settings (default 2, Codex 1) (fixes R6).
- Job state is persisted in a small `repo_index_jobs` table (`id, repo_id, tier, state, progress, message, error, started_at, finished_at`). Crash recovery re-queues interrupted jobs instead of the blanket reset in `handleStaleIndexingRepos` and the read-side 30-minute flip in `repo:status` (fixes R5).
- Events are **broadcast to all windows** (`repo:index-progress`) and exposed through `repo:index-jobs` for initial hydration (fixes R2).
- `cancel(repoId)` is used by remove-from-workspace and the "Stop" button.

Triggers:

- `addReposToWorkspace` / workspace create with `repoIds` enqueue `connected → mapped → enriched` automatically (fixes J1).
- Scaffold completion calls `enqueue` instead of its own serial loop (`workspace-scaffold.service.ts:186-195`).
- `on_commit` refresh enqueues a `mapped` refresh plus *incremental* enrichment (§4.3) instead of a full re-index (fixes R4).
- The manual "Re-index" button stays as an explicit full refresh.

### 4.3 Making enrichment cheaper

- **Content-hash cache per module.** Hash the sorted `(relativePath, size, mtime)` of the module's files plus the key-file contents. Skip the LLM call if the hash matches the stored `module_summaries.content_hash`. A re-index after a small commit then costs 1–2 LLM calls instead of 16.
- **Smaller-first scheduling** so progress moves early and the overview can start sooner.
- **Smarter module split** (R7): if one top-level dir holds more than 60% of files, descend one level (`src/*`, `packages/*`, `apps/*`) and honour workspace manifests (`pnpm-workspace.yaml`, `package.json#workspaces`, `go.work`, `Cargo.toml [workspace]`).
- **Overview from module purposes only.** Drop the file tree from the overview prompt once modules exist. It's the largest and least useful input.
- Write module summaries **as they complete** rather than in one batch at the end, so RepoDetail and persona context get better progressively.

### 4.4 Renderer changes

- Move index job state into `WorkspaceContext` (or a sibling `RepoIndexContext` hydrated from `repo:index-jobs` plus events). `ReposView` and `RepoList` then read from it, and local `indexingRepoIds` / `indexProgressMap` go away along with the 3 s polling loop (`ReposView.tsx:60-88`).
- **Readiness strip** component (`components/workspace/WorkspaceReadinessStrip.tsx`) shown in Chat and the Workspace view header. It lists repos with tier dots, a combined progress line, Stop/Retry, and expands to per-repo history (errors are kept).
- Remove the "Force Re-index" button. Replace it with Retry on `error` and Stop on running jobs.
- `RepoDetail` empty state: once `mapped`, show structure right away with a small "Summaries in progress" note instead of the "Index {repo}" CTA.

---

## 5. Remove repo from workspace

### Behaviour

- **Remove from workspace** (default): calls the existing `removeReposFromWorkspace`, cancels any queued or running index job for that repo, and keeps the files on disk and the index data (other workspaces may use the repo).
- **Forget repository** (secondary, only when the repo is in no other workspace): also deletes the `repos` row and its `repo_summaries`, `module_summaries` and `repository_map_graphs` rows. It never touches files on disk. This needs a new `repo:forget` IPC and a service function with a guard that refuses if the repo is still referenced.

### Entry points

1. `RepoCard` gets a `…` overflow menu with Open in editor, Open in VS Code, Re-index, a separator, then **Remove from workspace…**. This also clears the icon clutter on the card (`RepoList.tsx:178-201`).
2. `RepoDetail` header gets the same overflow menu.
3. Command palette: "Remove repository from workspace…" with a repo picker.
4. The future Settings → Workspace category (S3) gets a repo list with a remove action.

### Confirmation dialog

Use a themed dialog, not `window.confirm`:

> **Remove `acme-api` from "Payments"?**
> The folder on disk won't be touched. Chat threads and reviews in this workspace keep their history but won't be able to read this repo's code.
> ☐ Also forget this repository's index (it isn't used by any other workspace)
> [Cancel] [Remove]

Edge cases to handle and test:

- Removing the repo currently selected in `ReposView` (already handled by the effect at `ReposView.tsx:202-211`).
- Removing the last repo, which moves the workspace to the `empty` state (Chat stays enabled).
- Removing while indexing, which cancels the job and must not leave the repo stuck in `indexing`.
- Removing a repo mapped from a portable definition: `workspace_repo_definitions` is already deleted, so check that sync emits the intent (`emitWorkspaceSyncIntent` is called).
- Scaffold-session workspaces: disable removal while `scaffoldSession.status` is `active`, `syncing` or `indexing`.
- **To verify:** which features store `repo_id` against workspace-scoped records (chat sessions, code reviews, security audits, work-item links). The dialog copy above assumes history is kept. Confirm, and gracefully handle views that dereference a repo no longer in `activeWorkspace.repos`.

---

## 6. Phased plan

Each phase ships on its own and has its own acceptance criteria. Phase 1 on its own fixes the reported "stuck" state.

### Phase 1: Unblock the journey (P0s, small and low-risk)

| # | Change | Files |
|---|--------|-------|
| 1.1 | Always set `chatEnabled: true` outside scaffold. `statusLabel` reflects real job state. | `WorkspaceContext.tsx`, `Sidebar.tsx`, `SidebarActivityCenter.tsx` |
| 1.2 | Auto-enqueue indexing after `workspace:create` with repos and after `workspace:add-repos`. For this phase, a thin main-process wrapper around `indexRepo` with an in-memory per-repo lock and broadcast progress is enough. | `workspace.ipc.ts`, new `repo-index-queue.service.ts` (minimal), `repo.ipc.ts` |
| 1.3 | Hoist index progress into context (hydrate plus broadcast). Delete the renderer polling and the "Force Re-index" button, and add Retry/Stop. | `WorkspaceContext.tsx` (or `RepoIndexContext.tsx`), `ReposView.tsx`, `RepoList.tsx` |
| 1.4 | Minimal readiness strip in Chat, with a CTA to the Workspace view on error. | new `WorkspaceReadinessStrip.tsx`, `ChatView.tsx` |
| 1.5 | **Remove from workspace** via a RepoCard overflow menu and a themed confirm dialog (no "forget" yet). | `RepoList.tsx`, `RepoDetail.tsx`, new `components/shared/ConfirmDialog.tsx` |
| 1.6 | Copy: rename the nav label to "Repositories" (or rename the view to "Workspace"; pick one, see Q1) and update the creator hint to *"Anvil will index these in the background."* | `sidebar-navigation.ts`, `WorkspaceCreator.tsx`, `ReposView.tsx` |

**Tests:** `WorkspaceContext` availability truth table (new unit test beside `contexts/__tests__`). Queue dedupe/lock (`services/__tests__/repo-index-queue.service.test.ts`). `removeReposFromWorkspace` cancels jobs.

**Accept:**
- Create workspace with 1 local repo → land in Chat → composer enabled immediately.
- Indexing starts with no clicks.
- Leaving and returning to Workspace never shows "stuck".
- A repo can be removed from a workspace.

### Phase 2: Tiered indexing (speed)

| # | Change | Files |
|---|--------|-------|
| 2.1 | Split `indexRepo` into `mapRepo` (structural + map graph + fallback summary; sets `mapped`) and `enrichRepo` (LLM; sets `enriched`). Stream module writes. | `repo-index.service.ts` |
| 2.2 | Schema migration: add `repos.index_tier`, `module_summaries.content_hash`, and a `repo_index_jobs` table. Bump `SCHEMA_VERSION`. | `db/schema.ts` |
| 2.3 | Persistent queue, crash recovery, configurable LLM pool, cancel. Remove the side effect from `repo:status` and replace `handleStaleIndexingRepos`. | `repo-index-queue.service.ts`, `repo.ipc.ts` |
| 2.4 | Content-hash skip, smaller-first ordering, monorepo-aware module split. | `repo-index.service.ts`, `indexer.service.ts` |
| 2.5 | `on_commit` becomes incremental. | `repo.ipc.ts` |
| 2.6 | `repoFeaturesEnabled` keys off `mapped`. Scaffold uses the queue. | `WorkspaceContext.tsx`, `workspace-scaffold.service.ts` |
| 2.7 | Persona context prefers structural data when not enriched. | `persona.service.ts` |

**Tests:** `mapRepo` produces a summary without any LLM (mock `foundry.service`). Content-hash skip. Monorepo split fixtures. Migration test for the new columns. Queue crash-recovery.

**Accept:**
- On a 5k-file repo, `mapped` arrives in under 10 s.
- A re-index after a 1-file change makes at most 2 LLM calls.
- Killing the app mid-enrichment resumes on relaunch.

### Phase 3: First-run flow (activation)

| # | Change | Files |
|---|--------|-------|
| 3.1 | Merge role + primary agent into one "Welcome" step with a visible **Test** result. Two-step progress indicator and Back. | `RolePickerOverlay.tsx`, `ConnectorSetupOverlay.tsx`, `App.tsx` |
| 3.2 | Defer Work items, Git provider and Confluence to point-of-need prompts (Work Items view, creator Remote tab, Docs view). Keep them all in Settings. | `ConnectorSetupOverlay.tsx`, `WorkspaceCreator.tsx`, `WorkItemsView.tsx`, `DocsView.tsx` |
| 3.3 | Persist `onboardingStep` in settings so relaunch resumes where it left off (J9). | `App.tsx`, settings types |
| 3.4 | Simplify the workspace creator: a local-folder picker as the primary action, name auto-filled from the first repo, Clone as a tab, Scaffold/Empty as secondary links. Create the workspace first, then connect/clone into it with per-repo status inline, so partial failures still leave a usable workspace (J8). | `WorkspaceCreator.tsx`, `workspace.ipc.ts` |
| 3.5 | Repo-grounded first-prompt suggestions built from `mapped` data (top modules, entry points, missing AGENTS.md → "Set up AGENTS.md" linking to `/onboard`). | `ChatEmptyState.tsx`, small `repo:starter-prompts` helper |

**Accept:**
- A fresh install reaches an enabled Chat composer in 2 screens.
- Relaunching mid-onboarding resumes at the same step.
- Suggestions reference real paths in the connected repo.

### Phase 4: Settings, workspace management, consistency

| # | Change | Files |
|---|--------|-------|
| 4.1 | Add a Settings → **Workspace** category: name, repos (add/remove/re-index/forget), work-item connection, docs and launch prefs. | `SettingsView.tsx` → new `settings/WorkspaceSettingsPanel.tsx` |
| 4.2 | Split `SettingsView.tsx` into one component per category, lazily mounted. Keep `SettingsPanel` as the shared shell. | `settings/*` |
| 4.3 | One save model: autosave with a per-field saved tick for simple fields, explicit Save only for credential forms that need a connection test. Document it in `DESIGN.md`. | `SettingsView.tsx` |
| 4.4 | Replace all 10 `window.confirm/prompt` call sites with `ConfirmDialog` / `PromptDialog`. | files listed in J6/C6 |
| 4.5 | `repo:forget` plus the orphaned-repo indicator (X2). | `repo.ipc.ts`, new service fn, preload, `ipc-api.d.ts` |
| 4.6 | Make workspace rail actions keyboard-reachable (visible on focus-within, context menu on right-click, available for non-active rows too). | `WorkspaceRail.tsx` |
| 4.7 | Copy sweep: MissionControl → Anvil, no playful copy on destructive actions, and consistent "repository" vs "repo" in UI strings. | `SettingsView.tsx` and others |

### Phase 5: Chat maintainability (enabler, no user-visible change)

- Extract the empty/blocked/scaffold states from `ChatView.tsx:1103-1189` into a single `ChatPaneState` component driven by one derived enum.
- Split `ChatView.tsx` along existing seams (thread rail wiring, goal/plan intents, composer wiring, canvas). The target is under 800 lines per file.
- Swap the hard-coded persona colour fallback for the accent token.

---

## 7. Measurement

The app has PostHog available through the stack, but check what the desktop app actually captures before adding events. Keep events local-first and in line with the Privacy setting.

| Metric | Event(s) | Target |
|--------|----------|--------|
| Time to enabled composer | `onboarding_started` → `chat_composer_enabled` | < 90 s median |
| Time to first agent change | `onboarding_started` → first `diff_proposed` / `change_applied` | < 5 min median |
| Dead-end rate | sessions with `chat_blocked_shown` | 0 after Phase 1 |
| Time to `mapped` / `enriched` | `repo_index_tier_reached {tier, ms, fileCount}` | mapped < 10 s p90 on 5k files |
| Enrichment LLM calls per re-index | `repo_enrich_completed {calls, skipped}` | ≥ 80% skipped on incremental |
| Onboarding completion | `onboarding_step_completed {step}` funnel | track drop-off per step |

---

## 8. Open questions

1. **Naming:** should `/repos` be "Repositories" (it's a repo list) or "Workspace" (it becomes the workspace home with readiness, repos and notes)? I recommend **Repositories** in the nav and moving workspace-level management into Settings → Workspace.
2. **Enrichment cost control:** should enrichment auto-run on connect for every provider, or only when the provider is local/subscription-based (Codex, Cursor, Devin CLI) and be opt-in for metered API keys?
3. **Forget semantics:** when a repo is forgotten, should code reviews and security audits that reference it be kept (orphaned) or cascaded? This decides whether `repo:forget` needs a migration for FK behaviour.
4. **Scaffold mode:** once tiered indexing lands, should scaffold still lock non-Chat routes (`Shell.tsx:70-83`), or only until `mapped`?
