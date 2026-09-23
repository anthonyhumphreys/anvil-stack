# Anvil Desktop: UI surfaces review and remediation plan

Status: proposed · Scope: `anvil-app` renderer · Date: 2026-09-23
Companion to [`first-run-to-first-change-remediation.md`](./first-run-to-first-change-remediation.md). That plan covers the journey from onboarding to first change, auto-indexing, and removing a repo from a workspace. This one covers the rest of each surface. IDs from the first plan (J*, R*, X*, C*, O*, S*) are referenced, not repeated.

Method: code review of the renderer and the IPC/services behind it, checked against `PRODUCT.md` / `DESIGN.md` (Operate mode: calm, truthful status, workspace boundaries as a trust boundary, progressive disclosure, WCAG 2.2 AA). The app was not run, so anything that needs a live check is marked **verify**.

Severity: **P0** data loss, security or trust · **P1** notable friction or correctness · **P2** polish · **P3** hygiene.

---

## What's already good

Keep these when making changes:

- Every route has its own `ErrorBoundary` and is lazy-loaded, so one broken view doesn't take down the shell (`App.tsx`).
- The composer's accessibility is solid: combobox semantics for `/` `@` `$` menus, `aria-activedescendant`, and a keyboard hint (`ChatInput.tsx:869-878`).
- Thread rail status icons (approval / input / failed / working) and the workspace activity badges give a good at-a-glance picture of work across workspaces (`ChatThreadRail.tsx`, `WorkspaceRail.tsx`).
- Onboarding has a preview mode, so you can replay it without changing settings (`App.tsx:326-348`).
- The sidebar resize handle works from the keyboard and is announced as a separator with values (`Sidebar.tsx:431-449`).

---

## 1. Chat

The chat column is strong. The problem is that it's surrounded by too many controls, and the thing that matters most, *what changed*, is hard to find.

| ID | Sev | Finding | Evidence | Fix |
|----|-----|---------|----------|-----|
| CH1 | **P0** | The **Access level** (Read only / Approve for me / Auto approve / **Full access**) is a `<select>` inside the "Run settings" popover. The popover's button label is model · mode · reasoning, so it never shows access. You can be in Full access and have no visible sign of it. | `ChatInput.tsx:1694-1790`, `getRunSettingsLabel` | Always-visible access chip in the composer. Neutral styling for Read only / Approve, warning styling plus shield icon for Auto / Full. Confirm when switching to Full access. Persist per thread and show it in the thread rail. |
| CH2 | P1 | Chat has no per-turn "changes" summary. The aggregated **Review changes** panel (file list plus diff) lives in `ActivityGroupMessage`, which only Automations uses. Chat turns render `TurnWorkMessage`, where each file edit is one row inside "Work · N actions". | `ChatMessage.tsx:89-197` vs `199-329`; `AutomationsView.tsx:1681` | Add a `TurnChangesFooter` under the answer: *"3 files changed · +42 −7"*, then Review (inline diff), Open in Change Review, Commit / Open PR. Reuse the `ActivityGroupMessage` review grid. This is the first-change moment. |
| CH3 | P1 | When a turn finishes, its Work block **auto-expands and stays open** (`setExpandedOverride(true)` on active→idle), so the full tool log sits above every answer. That's the reverse of progressive disclosure. | `ChatMessage.tsx:238-243` | Collapse on finish. Keep the one-line summary, and show failures and approvals outside the collapsed block (already done for approvals and inputs). |
| CH4 | P1 | Too many controls. The header can show Chat/Tickets, Browser, Simulator, ITSM, Activity and Canvas, all icon-only below `xl`. The composer row has persona, new thread, attach, context, run settings, voice and send. That's about 13 controls around one text box. **New thread** is in three places (rail, composer, palette). | `ChatView.tsx:868-1052`, `1324-1419` | Header: title, PR chip, and one segmented **Panels** control (Activity · Canvas · Preview) that is mutually exclusive, matching the existing close-others logic. Move Chat/Tickets into the thread-rail header. Remove the composer's new-thread button (⌘N instead). |
| CH5 | P1 | The chat error is a red box with the raw error string and nothing to click. | `ChatView.tsx:1260-1267` | Classify common failures (auth, rate limit, provider down, sandbox). Offer Retry, Switch provider, Open diagnostics, and a link to the relevant Settings section (see ST4). |
| CH6 | P2 | The thread rail has no search or filter. The only filter is active vs archived. Long-lived workspaces will outgrow it. | `ChatThreadRail.tsx:338-339` | Filter box (title, summary, repo, persona) and ⌘P-style "Jump to thread" in the command palette. |
| CH7 | P2 | Non-active threads that are **working** are drawn at `opacity-70`, so the threads that are running look inactive. | `ChatThreadRail.tsx:82` | Remove the dimming. The status icon already covers it. |
| CH8 | P2 | The `/`, `@` and `$` syntax is only hinted in the placeholder, and only once repos exist. | `ChatInput.tsx:879-887` | A small "/ commands · @ files · $ skills" hint under the composer on empty threads, and a `?` popover. |
| CH9 | P2 | Chat layout (Chat vs Tickets) can be set in the header toggle **and** in Settings → Chat layout. Two controls for one setting. | `ChatView.tsx:623-628`, `SettingsView.tsx:1196-1215` | Keep it in the rail header and remove it from Settings (or make Settings only the default). |
| CH10 | P2 | The persona picker lists every persona grouped by role, with no search or recents. | `ChatView.tsx:1344-1386` | Recents at the top plus type-to-filter. |
| CH11 | P3 | `ChatStatusBar.tsx` is dead code: only its test imports it. | grep | Delete it along with its test. |
| CH12 | P3 | Deleting a thread uses `window.confirm`. Renaming is inline (good). | `ChatThreadRail.tsx:183` | Use `ConfirmDialog` (first plan, Phase 4.4). |

Chat maintainability (first plan C4 / Phase 5) is what makes the fixes above affordable. Do CH4 at the same time as the `ChatView` split.

---

## 2. Settings

| ID | Sev | Finding | Evidence | Fix |
|----|-----|---------|----------|-----|
| ST1 | **P0** | **The save badge can say "Saved" when edits are unsaved.** Theme, Anvil Cloud and LLMGateway connect save instantly and call `setSaved(true)`, which also clears the badge for unrelated pending edits (e.g. a half-entered ADO PAT). | `SettingsView.tsx:472-494`, `704` | Track dirty state per field (`dirtyKeys: Set`). Only the explicit Save clears it. See ST3 for the model. |
| ST2 | P1 | Clicking **Test** on any connector saves *all* pending edits without saying so (`saveBeforeTest`), while the badge still reads "Unsaved changes". | `SettingsView.tsx:531-539` | Test only the fields in that panel, and state it: "Saving these credentials to test…". |
| ST3 | P1 | Settings opens showing **"Unsaved changes"**: `saved` starts `false` and nothing sets it on load. | `SettingsView.tsx:268`, `977` | Derive the badge from `dirtyKeys.size`. Better, adopt a single model: autosave simple fields with an inline tick, and keep explicit Save only for credential forms that need a connection test (first plan S2 / 4.3). |
| ST4 | P1 | **Settings can't be deep-linked.** `activeCategory` is local state defaulting to `profile`. At least 15 messages across the app say "…in Settings" with no link (WorkspaceCreator:364, WorkItemsView:313, DocsView:319, WorkItemThreadRail:355, OrchestrationPanel:244/639, ConnectorsStep:68/96, chat-model-options:116-119…). | `SettingsView.tsx:265`; grep `in Settings` | Route `/settings/:category` with `#panel` anchors, plus a `<SettingsLink to="delivery#git">` component. Replace every "in Settings" string with a link. |
| ST5 | P1 | Leaving Settings (sidebar, ⌘,) with unsaved edits drops them with no warning. | no blocker / `beforeunload` in `SettingsView.tsx` | Solved by autosave (ST3). Credential forms get a "Discard changes?" prompt through the router. |
| ST6 | P1 | The file is 3,605 lines with 48 `useState`. Every category is mounted at once and hidden with `hidden`, including heavy panels (Sync & Mesh 1,582 lines, Cloud Environments 1,140). | `SettingsView.tsx` | One lazy component per category, sharing a `useSettingsDraft()` hook (first plan 4.2). |
| ST7 | P2 | There's no settings search. "AI & agents" alone is about 770 lines of panels (provider, Codex registry, usage, personal AGENTS.md, Anvil Cloud, custom agents). | `SettingsView.tsx:1218-2118` | ⌘F filter over panel titles and descriptions. Split AI into **Providers & models** and **Agents & skills**. |
| ST8 | P2 | Role is chosen here and silently hides nav items. Deep-linking to a hidden feature redirects to `/chat` or `/repos` with no explanation. | `SettingsView.tsx:1098`, `App.tsx:312-320` | Show "Hidden by your role — show anyway / change role" instead of a silent redirect. Add a "Show all tools" toggle. |
| ST9 | P2 | No Workspace category (first plan S3 / 4.1). | — | — |
| ST10 | P3 | Copy: "MissionControl wizard", "not ISO-certified", "Handle with tongs" on the Danger area. | `SettingsView.tsx:1179`, `2933-2938` | Plain copy on destructive panels. Keep personality elsewhere if wanted. |

---

## 3. Onboarding (beyond the first-run plan)

| ID | Sev | Finding | Evidence | Fix |
|----|-----|---------|----------|-----|
| OB1 | P1 | "Onboarding" means two things: the first-run overlays, and the per-repo **AGENTS.md / devcontainer / environment** wizard at Tools → Onboarding. The second is valuable (agent readiness) but nothing points to it. | `OnboardView.tsx`, `sidebar-navigation.ts:62` | Rename it to **Repo setup** (or "Agent readiness"). Show its checks as a checklist on RepoDetail (AGENTS.md ✓, devcontainer ✗, env vars ✓) with "Fix with agent" actions. |
| OB2 | P2 | Wizard progress is kept in `sessionStorage` under one key, so it's lost on restart and can't track more than one repo. | `OnboardView.tsx:31-64` | Store detection and completion per repo in SQLite (`onboard` state already exists in the schema, **verify**). |
| OB3 | P2 | The wizard only auto-selects repos with `status === 'indexed'`. With tiered indexing this should be `mapped`. | `OnboardView.tsx:73` | Update as part of the first plan's Phase 2. |
| OB4 | P2 | Sync & Mesh setup (`SyncMeshSetupCard`) says "finish later in Settings" four times with no link. | `SyncMeshSetupCard.tsx:102-389` | `SettingsLink` (ST4). |

---

## 4. Workspaces

| ID | Sev | Finding | Evidence | Fix |
|----|-----|---------|----------|-----|
| WS1 | **P0** | **Deleting a workspace permanently deletes all its chat threads, sessions and messages, and the deletion is synced to other devices.** The confirm (`window.confirm`) only says *"Repositories will not be removed."* | `workspace.service.ts:406-431` (`withSyncedEntityWrite … 'delete'`), `WorkspaceRail.tsx:91` | Themed dialog listing what will be deleted ("12 threads, 3 notes…") and that it applies on all synced devices, with type-to-confirm for workspaces that have history. Consider soft-delete with a 30-day restore. **Verify** which other workspace-scoped tables (notes, automations, workflow runs, reviews) are orphaned rather than deleted. |
| WS2 | P1 | There's no workspace home. The "Workspace" nav item is a repo list, and notes, preferences, activity, readiness and setup live elsewhere. | `sidebar-navigation.ts:21` | A **workspace overview** at `/workspace`: readiness strip, repos, recent threads, open changes/PRs, setup checklist (checkouts, bootstrap, repo setup), notes preview. `/repos` becomes a tab or section. |
| WS3 | P1 | Synced workspaces from another device show "Needs checkout setup" in tiny rail text. The only fix is a hover-only `…` → "Set up checkouts…". | `WorkspaceRail.tsx:202-203`, `260-269` | Banner on the workspace overview with a primary **Set up checkouts** CTA. Scope repo features to mapped checkouts until it's done. |
| WS4 | P1 | The command palette has no **Switch workspace** command, and there are no keyboard shortcuts for switching. The rail list is capped at `max-h-44` with no filter. | `CommandPalette.tsx`, `WorkspaceRail.tsx:167` | Palette "Switch to <workspace>" entries, ⌃1-9 shortcuts, and type-to-filter in the rail once there are more than 6 workspaces. |
| WS5 | P2 | "Bootstrap…" (WS-03 recipe approval) is an unexplained menu item. The panel explains it, but the entry point doesn't. | `WorkspaceRail.tsx:270-277`, `WorkspaceBootstrapPanel.tsx:12` | Only show it when a recipe is pending approval, with a badge and label: "Review setup recipe". |
| WS6 | P2 | Rename uses `window.prompt`. Actions only appear on hover on the active row (first plan J6/J7). | `WorkspaceRail.tsx:82`, `229-240` | Inline rename (same pattern as threads). Right-click context menu on any row. |
| WS7 | P2 | Switching workspace swaps Chat context with no transition. If you're mid-draft, the draft key changes and the text seems to vanish (it's kept per thread, but it isn't visible). | `ChatView.tsx:669-673` | Brief "Switched to *X*" toast with Undo. Keep drafts per workspace and restore them on return. |

---

## 5. Repository management (beyond the first-run plan)

| ID | Sev | Finding | Evidence | Fix |
|----|-----|---------|----------|-----|
| RM1 | P1 | **Connect** only handles local folders. Clone from GitHub/ADO is only in the Workspace creator, so after onboarding there's no way to clone into an existing workspace. | `ReposView.tsx:348-382` vs `WorkspaceCreator.tsx:360-510` | One `AddRepositoriesDialog` (Local · Clone · Scaffold) used in both places. |
| RM2 | P1 | The scanner recursively scans the chosen folder (depth 4) and **pre-selects everything found**, which can pull in nested or vendored repos. Repos already in the workspace aren't marked. Choosing a repo folder itself still goes through the scan list. | `RepoScanner.tsx:20-41` | If the chosen folder is a repo, add it directly. Otherwise pre-select only top-level repos. Show "Already in workspace" as disabled. Support dropping a folder onto the Workspace view. |
| RM3 | P1 | RepoDetail's quick actions each use a different colour (info, accent, **error-red for "Security audit"**). A non-destructive action in the destructive colour, and no primary action. The most useful action, **Chat about this repo**, isn't there. | `RepoDetail.tsx:146-184` | Primary: *Ask in Chat* (opens a thread scoped to this repo). Secondary buttons neutral. Security, Diagrams and Editor go in a row of neutral buttons. |
| RM4 | P1 | "Refresh map" and the "On commit" toggle both run a **full LLM re-index** (first plan R4). The labels suggest something cheap and local. | `RepoDetail.tsx:234-275` | Once tiered: "Refresh structure" (fast) and "Re-summarise" (LLM, shows an estimate). "On commit" only refreshes structure plus incremental enrichment. |
| RM5 | P2 | On error, the card shows an **Index** button and no reason. Progress history is kept only in memory, so the failure explanation is lost when you navigate away. | `RepoList.tsx:152-163`, `ReposView.tsx:163-169` | Persist the last job error (first plan §4.2 `repo_index_jobs`). Show it on the card with Retry and "Copy details". |
| RM6 | P2 | Neither the repo list nor RepoDetail shows git state (branch, dirty, ahead/behind), even though `git.status` exists. The status bar shows the branch of the **first** repo only, with no repo name. | `StatusBar.tsx:38-60`, `RepoList.tsx` | Branch plus dirty dot on each card. In the status bar, show the active thread's repo (or "3 repos") with a popover listing each repo's branch. |
| RM7 | P2 | The card is crowded: status, name, badge, warning, primary Index / Re-index button (orange on every row), path, two icon buttons, metrics. | `RepoList.tsx:112-237` | Overflow menu (first plan 1.5). No per-row primary buttons once auto-indexing lands. |
| RM8 | P3 | **About 1,950 lines of dead UI**: `RepositoryGarden.tsx` (1,647) and `RepositoryTwin.tsx` (297) are never rendered. | grep for `<RepositoryGarden` / `<RepositoryTwin` → 0 | Delete them, or record in an ADR why they're kept. |

---

## 6. Navigation and the overall journey

| ID | Sev | Finding | Evidence | Fix |
|----|-----|---------|----------|-----|
| NV1 | P1 | **Change Review** (`/review`) and **Code Review** (`/codereview`) sit next to each other under Delivery with the **same icon** (`GitPullRequest`). Users can't tell which is for their agent's changes and which is for PRs. | `sidebar-navigation.ts:35-42`, `Sidebar.tsx:70-71` | Rename to **Changes** (local working-tree review) and **PR Review**, or merge into one Review view with tabs. Different icons. |
| NV2 | P1 | Labels don't describe the destination: *Watchtower & schedules*, *Dojo*, *Argent*, *Lifecycle* (for `/governance`), *Onboarding* (repo setup). About 19 tools sit behind a collapsed "Tools" with no descriptions. | `sidebar-navigation.ts:24-89` | Descriptive labels, with brand names as a secondary line or tooltip ("Dojo — agent practice runs"). Keep the palette as the power path. Pin up to 5 tools to the primary nav. |
| NV3 | P2 | Disabled nav items always show `repoFeatureReason` as the tooltip, including chat-gated items. Disabled items can't be focused, so keyboard users never hear why. | `Sidebar.tsx:475-501` | Use `aria-disabled` (focusable) with a reason for each gate. Clicking goes to the page's empty state with a CTA rather than doing nothing. |
| NV4 | P2 | Status bar: "N/M services connected" can't be clicked and doesn't say which one failed. The OS name uses space. Connection tests only run at startup and on settings save. | `StatusBar.tsx:62-111`, `App.tsx:213-272` | Make it a button with a popover listing each service, its status and a Fix link (ST4). Re-test on window focus with backoff. Drop the OS label. |
| NV5 | P2 | The first nav item is **Activity** (the inbox), but the default route is `/chat`. Returning users land in Chat while the attention list sits one click away. | `sidebar-navigation.ts:19-21`, `App.tsx:737` | Returning users with pending attention items land on Activity (or Chat shows an "N items need you" banner). New users land on Chat. |

---

## 7. Design system and accessibility

| ID | Sev | Finding | Evidence | Fix |
|----|-----|---------|----------|-----|
| DS1 | P1 | **White text on the accent fails contrast.** Primary buttons use `bg-accent … text-white`. With the DESIGN.md accent `#ff8a3d`, that's about **2.3:1**, below AA for normal (4.5:1) and large (3:1) text. `WorkspaceRail` already uses the correct `text-bg-primary` on accent. There are 126 `text-white` uses across components. | `DESIGN.md` colours; e.g. `ReposView.tsx:295`, `WorkspaceCreator.tsx:622` | Add an `accent-foreground` token (dark canvas colour on orange) and a shared `<Button variant="primary">`. Codemod `bg-accent … text-white`. **Verify** against each theme. |
| DS2 | P1 | There's no shared Button / Dialog / Menu primitive. Every view hand-writes Tailwind strings for buttons, modals (`fixed inset-0 bg-black/60`) and menus, so hover, focus-ring, radius and padding drift (`rounded-md` vs `rounded-lg` vs `rounded-xl` on neighbouring buttons). | `ReposView.tsx:348-381`, `WorkspaceCreator.tsx:246`, `WorkspaceRail.tsx:241-292` | `components/ui/`: `Button`, `IconButton`, `Dialog` (focus trap, Esc, return focus), `ConfirmDialog`, `PromptDialog`, `Menu`, `SegmentedControl`. Migrate the surfaces in this plan first. |
| DS3 | P2 | Tokens are bypassed: 52 raw `amber-*` / `emerald-*` classes and 19 `text-red-400`, instead of `warning` / `success` / `error`. | grep | Lint rule (`no-restricted-syntax` on class strings, or Tailwind config that removes the default palette). |
| DS4 | P2 | 133 uses of `text-[10px]` / `text-[11px]`. Heavy sub-12px text works against the text-zoom and AA goals in `PRODUCT.md`. | grep | Type scale floor of 12px for readable text. 11px only for uppercase eyebrows and counters, via a token. |
| DS5 | P2 | Hover-only affordances (workspace `…`, the "open in new window" nav button, thread actions via `getThreadActionVisibilityClass`) can't be discovered by touch or keyboard, and some have no focus-within reveal. | `WorkspaceRail.tsx:234`, `Sidebar.tsx:507-517` | Reveal on `group-focus-within`. Add right-click context menus as the discoverable path. |

---

## 8. Phased plan

These phases build on the first plan's Phases 1–5. **A** runs alongside the first plan's Phase 1 because it fixes trust and data-loss problems.

### Phase A: Trust and safety fixes (small)

| # | Items | Files |
|---|-------|-------|
| A1 | WS1: honest workspace-delete dialog (lists threads, mentions sync), type-to-confirm. **Verify** orphaned tables. | `WorkspaceRail.tsx`, `workspace.service.ts`, new `ui/ConfirmDialog.tsx` |
| A2 | ST1–ST3: per-field dirty tracking, correct badge, Test only saves its own panel. | `SettingsView.tsx` |
| A3 | CH1: visible access chip, confirm on Full access. | `ChatInput.tsx`, `ChatView.tsx` |
| A4 | DS1: `accent-foreground` token and primary button fix. | `global.css`, tailwind config, codemod |

**Tests:** Settings dirty-state reducer unit test. Workspace delete-summary service test (counts per table). Access-chip label helper test.

### Phase B: The first-change moment in Chat

| # | Items |
|---|-------|
| B1 | CH2: `TurnChangesFooter` (files, +/−, Review, Open in Change Review, Commit/PR). |
| B2 | CH3: collapse Work on finish, keep failures and approvals visible. |
| B3 | CH5: error classification and recovery actions. |
| B4 | RM3: "Ask in Chat" from RepoDetail opens a repo-scoped thread. |

### Phase C: Settings and navigation structure

| # | Items |
|---|-------|
| C1 | ST4: `/settings/:category#panel` routing and `SettingsLink`, then replace every "in Settings" string. |
| C2 | ST6/ST7: split into lazy category components, search, split AI & agents. |
| C3 | NV1/NV2: rename or merge Change Review and Code Review, descriptive labels, pinned tools. |
| C4 | NV3/NV4: focusable disabled nav with reasons, actionable services popover. |
| C5 | ST8: explain role-hidden features instead of redirecting silently. |

### Phase D: Workspace home and repository management

| # | Items |
|---|-------|
| D1 | WS2/WS3: `/workspace` overview (readiness, repos, threads, changes, setup checklist, checkout banner). |
| D2 | RM1/RM2: unified `AddRepositoriesDialog` (Local · Clone · Scaffold), smarter scanner, drag-and-drop. |
| D3 | WS4/WS6/WS7: palette switch and shortcuts, inline rename, context menus, switch toast and drafts. |
| D4 | RM5/RM6/RM7: persisted index errors, git state on cards, multi-repo status bar. |
| D5 | OB1/OB2: rename to Repo setup, readiness checklist on RepoDetail, per-repo persistence. |

### Phase E: Chat density and design system

| # | Items |
|---|-------|
| E1 | DS2: `components/ui` primitives, then migrate Chat, Settings, Workspace, Repos. Replace all 10 native dialogs. |
| E2 | CH4/CH9/CH10: Panels segmented control, layout toggle into the rail, remove duplicate new-thread, persona recents and filter. Do this with the first plan's Phase 5 `ChatView` split. |
| E3 | CH6/CH7/CH8: thread search, remove working-thread dimming, composer syntax hint. |
| E4 | DS3/DS4/DS5: token lint, type floor, focus-within reveals. |
| E5 | RM8/CH11: delete dead components (about 2,100 lines). |

---

## 9. Open questions

1. **Workspace deletion:** soft-delete with restore, or hard delete with a clearer warning? Either way, should deletion sync by default?
2. **Access default:** what should a new thread default to (currently whatever the last choice was, **verify**)? A per-workspace default in Settings → Workspace fits the trust-boundary principle.
3. **Change Review vs Code Review:** merge into one Review surface, or keep them separate with clearer names?
4. **Workspace home vs Repositories:** does `/workspace` replace `/repos` as the primary nav item (my recommendation), with Repositories as a section inside it?
5. **RepositoryGarden / RepositoryTwin:** delete, or planned work in progress?