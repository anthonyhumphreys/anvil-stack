# Anvil Mobile Companion UI And Widget Plan

## Critical Read

The current direction is closer to the right product: terse labels, status tiles, fewer brochure paragraphs, and a real command surface. Good. The previous version had too much “look at this app doing app things” energy.

The remaining problem is trust and usefulness. The mobile app should feel like a remote cockpit for a local developer agent, not a dashboard about a remote cockpit for a local developer agent. At the moment, the tabs are improving visually, but the hierarchy still over-indexes on counts and panels. The widgets have a real snapshot and deep-link path, but they still risk feeling like passive status postcards unless every visible action has a clear outcome.

Relevant code:
- [mobile/app/(tabs)/index.tsx](/Users/anthonyhumphreys/Code/anvil/anvil-app/mobile/app/(tabs)/index.tsx:167): Work tab now leads with workspace, status, live host, launch controls, runbook, and queue.
- [mobile/lib/widget-bridge.ts](/Users/anthonyhumphreys/Code/anvil/anvil-app/mobile/lib/widget-bridge.ts:105): widget snapshots are generated from real `MobileOverview` data.
- [mobile/contexts/companion-context.tsx](/Users/anthonyhumphreys/Code/anvil/anvil-app/mobile/contexts/companion-context.tsx:94): overview updates publish widget snapshots.
- [mobile/contexts/companion-context.tsx](/Users/anthonyhumphreys/Code/anvil/anvil-app/mobile/contexts/companion-context.tsx:276): widget deep links can start workflows via `anvil-companion://workflow/:actionId`.
- [mobile/plugins/withAnvilCompanionSurfaces.js](/Users/anthonyhumphreys/Code/anvil/anvil-app/mobile/plugins/withAnvilCompanionSurfaces.js:791): WidgetKit currently exposes small and medium command widgets.

## Product Position

This is for developers already using Anvil on a Mac. They are likely away from the keyboard, glancing at a phone, or responding to an approval while another task is running.

Design scene: a developer checks an iPhone while code review, tests, or a long agent run is happening on the Mac, often in a focused work session with low patience for fluff.

Visual lane:
- Restrained product UI.
- Native-feeling, dense, matte, calm.
- Slight command-center edge, but not fake terminal cosplay.
- References: Codex task surfaces for confidence and control, Cursor for compact developer workflow affordances, T3-style directness for copy and hierarchy.

## Non-Negotiables

1. No promotional copy.
   Replace product explanation with operational state and action labels.

2. No fake functionality.
   If a tile looks tappable, it must navigate, filter, start, resolve, interrupt, refresh, or open the Mac.

3. No unsafe approval shortcuts.
   High-risk or desktop-review approvals must stay blocked on mobile/watch/widget. The current `requiresFullReview` treatment should become visually unmissable, not just a red-tinted panel.

4. The widget must earn its Home Screen slot.
   It should answer: what is running, what needs me, what can I safely start?

5. The UI vocabulary must be shared.
   `companion-ui.tsx` should become the compact design system for mobile: tiles, action rows, queue rows, status rails, blocked notices, and input surfaces.

## Implementation Plan

### 1. Stabilize The Current Diff

Review the existing modified files before editing:
- `mobile/components/companion-ui.tsx`
- `mobile/app/(tabs)/index.tsx`
- `mobile/app/(tabs)/approvals.tsx`
- `mobile/app/(tabs)/chats.tsx`
- `mobile/app/(tabs)/settings.tsx`
- `mobile/app/(tabs)/_layout.tsx`

Goal:
- Keep the useful direction: status tiles, terse copy, denser runbook rows.
- Remove inconsistencies introduced by the pass: duplicated `signalGridStyle`, one-off colors, repeated local layout primitives.
- Pull common patterns into `companion-ui.tsx`.

### 2. Reframe The App Around Three Jobs

Work tab:
- Primary job: start or inspect work.
- Top area: active workspace, host/live state, pending approvals, running sessions.
- Main control: prompt/run composer with mode, repo scope, queue context.
- Secondary: runbook actions and active queue.
- Make tiles actionable where sensible: approvals tile jumps to Approvals, running tile anchors queue, host opens Settings/host picker.

Approvals tab:
- Primary job: make a safe decision quickly.
- Separate into “mobile-approvable” and “desktop review required”.
- For mobile-safe approvals, show command/root/reason/risk and actions.
- For blocked approvals, show one clear action: “Review on Mac”.
- Avoid “Approve” as the first visible action for anything with elevated risk. Decorative security belongs in the bin.

Chats tab:
- Primary job: continue or launch agent conversation.
- Make thread selection and current conversation feel like one flow.
- Prefer “Follow-up”, “Launch”, “Interrupt”, “Open on Mac”.
- Reduce message chrome; developer chat should be readable first, pretty second.

Settings tab:
- Primary job: pair and select host.
- QR pairing first, paired hosts second, manual connection last.
- Show active host health and last update.
- Manual connection should be compact and clearly secondary.

### 3. Make Widgets Functional, Not Decorative

Current widget facts:
- Widget data is written through the native bridge from app overview snapshots.
- Widget links already open workflow deep links.
- Medium widget exposes quick action links.
- Small widget links to the first quick action.

Changes:
- Add explicit widget destinations:
  - `anvil-companion://workflow/:actionId`
  - `anvil-companion://approvals`
  - `anvil-companion://work`
  - `anvil-companion://settings`
- Extend the app deep-link handler to route non-workflow paths to the right tab.
- Make the small widget choose destination by state:
  - pending approvals: Approvals
  - busy session: Work queue
  - unpaired: Settings
  - otherwise: default quick action
- Make medium widget show:
  - workspace/health
  - pending approvals
  - running sessions
  - two or three safe quick actions
  - “Open” or “Pair” state when unconfigured
- Remove widget copy like “Launch focused Anvil workflows from your Home Screen” where it appears in generated display text if it feels promotional. Use “Start Anvil workflows” or “Anvil command deck”.

### 4. Improve Snapshot Semantics

In `mobile/lib/widget-bridge.ts`:
- Replace fallback marketing-ish strings with operational defaults:
  - headline: `No host paired`
  - detail: `Open Anvil on Mac and scan the pairing code.`
- Include derived widget intent:
  - `primaryDestination`
  - `primaryLabel`
  - `attentionLevel`
  - maybe `staleAfterSeconds`
- Use generated time in UI: fresh, stale, offline.
- Do not silently swallow snapshot write failures forever if we need diagnostics. At minimum, keep the app UI state clear when widgets are not available.

### 5. Visual System Pass

In `companion-ui.tsx`:
- Keep 8px radius.
- Use restrained neutral surfaces with one amber action accent.
- Add reusable:
  - `SignalGrid`
  - `SignalTile` with optional `onPress`
  - `CommandPanel`
  - `ActionRow`
  - `BlockedNotice`
  - `ConnectionBar`
  - `QueueItemShell`
- Remove one-off hardcoded reds/blues where shared tokens exist.
- Ensure text truncation on tiles and buttons is deliberate.
- Prefer icon + label where it improves scanning.

Target feel:
- Dense like a serious developer tool.
- Calm like Codex.
- Direct like T3.
- Controlled like Cursor when an agent is about to touch your repo.
- Absolutely allergic to “Here’s how our innovative mobile companion helps you...” nonsense.

### 6. Safety And State Rules

Approval actions:
- `requiresFullReview`: no mobile approve buttons.
- `destructive` or `high`: require stronger visual warning and prefer desktop review unless policy says mobile is allowed.
- `acceptForSession`: only show when policy makes sense and label it as session-scoped.
- Always keep Decline available.

Failure states:
- Host unreachable: show last known state, mark stale, make retry obvious.
- Pairing expired: plain error, no blame.
- No workspace: Settings/desktop action, not empty-dashboard sadness.
- No quick actions: hide runbook section or show one actionable pairing/refresh row.

### 7. Verification Plan

Code checks:
- `pnpm --dir anvil-app/mobile typecheck`
- `pnpm --dir anvil-app/mobile lint`

Native checks if implementation touches plugin-generated widget/watch code:
- run the existing Expo prebuild/build path used by this repo
- inspect generated WidgetKit Swift for compile issues
- verify widget target still has App Group entitlement
- verify deep links from widget open the correct tab/action

Manual/device checks:
- paired iPhone: Work, Approvals, Chats, Settings
- no-host state
- host offline state
- pending approval, including desktop-review-only approval
- widget small and medium
- widget quick action starts the correct workflow
- stale widget after host/app stops updating

## Suggested First Build Slice

Start with a focused slice, not a grand rewrite wearing a cape:

1. Consolidate shared UI primitives in `companion-ui.tsx`.
2. Clean the four tabs to use those primitives consistently.
3. Add route-aware deep-link handling for widget destinations.
4. Upgrade widget snapshot/default copy and destination logic.
5. Run mobile lint/typecheck.
6. If clean, build/install to device and inspect real widgets.

This should produce a visibly better app without wandering into native-target archaeology unless WidgetKit demands tribute.