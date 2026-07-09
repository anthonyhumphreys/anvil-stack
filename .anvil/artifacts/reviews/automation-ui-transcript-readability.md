# Automation UI Transcript Review

Source checked against the current Web Interface Guidelines: https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md

## Findings

[AutomationsView.tsx](/Users/anthonyhumphreys/Code/anvil/anvil-app/src/renderer/components/automations/AutomationsView.tsx:520) - The page uses a fixed two-column editor/run layout, and the transcript is trapped in the narrower right column. Long assistant output should get a primary reading surface: either a full-width run detail mode, a drawer, or tabs for `Runs`, `Transcript`, `Worktrees`, and `Events`.

[AutomationsView.tsx](/Users/anthonyhumphreys/Code/anvil/anvil-app/src/renderer/components/automations/AutomationsView.tsx:875) - The run list and transcript split vertical space almost evenly. On real runs, the run list is navigation, while the transcript is the work product. This should bias heavily toward transcript height, or collapse the run list after selection.

[AutomationsView.tsx](/Users/anthonyhumphreys/Code/anvil/anvil-app/src/renderer/components/automations/AutomationsView.tsx:938) - `assistantMessage` renders above `Run events`, then text events render again inside the event stream. That duplication makes the transcript harder to scan and creates “wait, did I read this already?” energy. Pick one canonical transcript stream.

[automation-run-events.ts](/Users/anthonyhumphreys/Code/anvil/anvil-app/src/renderer/utils/automation-run-events.ts:5) - Display entries keep `createdAt`, but the UI never shows it. A transcript without timestamps loses pacing, especially for long automation runs. Show subtle time markers per grouped chunk or activity cluster.

[automation-run-events.ts](/Users/anthonyhumphreys/Code/anvil/anvil-app/src/renderer/utils/automation-run-events.ts:12) - Automation activity grouping omits `file_read`, `approval_request`, `plan_update`, and goal events, while chat grouping includes them. The automation transcript will feel noisier and less coherent than chat for similar agent work.

[AutomationsView.tsx](/Users/anthonyhumphreys/Code/anvil/anvil-app/src/renderer/components/automations/AutomationsView.tsx:987) - The label `Run events` frames the transcript as logs, not narrative. If the user is trying to read what happened, call the primary view `Transcript`; put raw-ish events behind `Activity`.

[ChatMessage.tsx](/Users/anthonyhumphreys/Code/anvil/anvil-app/src/renderer/components/chat/ChatMessage.tsx:743) - `AssistantMessage` has generous chat bubble padding/actions intended for the main chat column. In the automation side panel this creates chunky blocks and hover controls that compete with reading. Use a compact transcript variant here.

[global.css](/Users/anthonyhumphreys/Code/anvil/anvil-app/src/renderer/styles/global.css:531) - `transition: all` violates the UI guidelines and makes hover/action behavior less disciplined. Small thing, but it is the kind of small thing that breeds layout vibes in production.

## Recommended Direction

Make the selected run the main object. Keep automation editing on the left or behind an `Edit` tab, then give the run detail a readable transcript-first layout:

- Header: run status, start/end time, trigger, changed files, retained worktree count.
- Tabs: `Transcript`, `Activity`, `Worktrees`, `Raw Events`.
- Transcript: merged assistant/thinking/system chunks with timestamps, compact activity separators, no duplicate summary.
- Activity: grouped commands, tool calls, file reads/edits, approvals, plans, and goals.
- Worktrees: retained paths and open actions.
- Raw Events: existing stream for debugging.

This is not a colour problem. It is an information hierarchy problem wearing a hoodie.