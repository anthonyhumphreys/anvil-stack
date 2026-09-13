---
target: Dojo implementation
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
timestamp: 2026-09-05T21-16-13Z
slug: nvil-app-src-renderer-components-dojo-dojoview-tsx
---
# Dojo implementation review

Reviewed `fix/dojo-review-recovery`, HEAD `f1e5670`. Two independent UI assessments, plus service inspection and a focused reproduction. Current source was reviewed; the reported installed-app failure was not reproduced.

## Verdict

Dojo has useful evidence and coaching capabilities, but interaction bugs make it harder to trust. Its terminology, restrained sections, skill previews and evidence links fit Anvil. The main problems are recovery, state preservation and the meaning of the displayed results. Fix those before redesigning the visuals.

## Priority findings

1. **P1: A failed window change can show old data under the new selection.** `anvil-app/src/renderer/components/dojo/DojoView.tsx:31` retains previous data after a failed request; the selector changes at line 281 and the old panel returns at line 315. Selecting 90 days after loading 30 days can leave 30-day figures beneath “Last 90 days.” The panel dates and alert provide clues, but the controls disagree. Associate results with their requested period and explicitly identify stale data. Suggested command: `$impeccable harden`.

2. **P2: Retry does not repeat a failed save or review start.** `DojoView.tsx:87` and line 101 store operation errors in the shared banner. Its Retry button at line 156 only reloads. A successful reload clears the error while the intended action remains undone. Give each operation its own recovery action. Suggested command: `$impeccable harden`.

3. **P2: Changing the period discards the investigation.** `DojoView.tsx:309` unmounts analytics while loading and line 317 keys it by days. The local state at `DojoAnalyticsPanel.tsx:37` includes the subtab, search, filters and selected run. Moving from 30 to 90 days returns users to Overview with those choices cleared. Preserve applicable state while fetching replacement data. Suggested command: `$impeccable harden`.

4. **P2: A one-off review requires enabling scheduled coaching.** `DojoView.tsx:135` disables Review now until enablement is saved under Scheduled coaching at line 165. `anvil-app/src/main/services/dojo.service.ts:780` enforces this, and enabling the configuration schedules future runs. Separate manual review permission from recurrence; explain disabled actions beside the button. Suggested command: `$impeccable clarify`.

5. **P2: Older corrections can crowd recent work out of coaching.** `anvil-app/src/main/services/dojo.service.ts:526` places all flagged messages before the recent-message sample. Selection then stops at 240 messages or 60,000 characters. A temporary test supplied 240 older correction messages and one recent request: the model prompt included the old messages and excluded the recent request. Reserve capacity for recent conversations and include surrounding context. This needs a service fix and regression test.

## Other issues

- Coaching's before/after comparison uses workspace-wide recommendation states and the last selected Performance window, while the Coaching screen shows a separate report selector. Make both scopes explicit. See `DojoCoachingPanel.tsx:277` and `DojoView.tsx:275`.
- Settings remain editable during submission, but the response replaces the draft. New edits can be overwritten. See `DojoView.tsx:83`.
- Recommendation and delivery controls clear their pending state before their refresh finishes, briefly showing the old value. See `DojoCoachingPanel.tsx:26` and `DojoAnalyticsPanel.tsx:756`.
- Chart points have small targets and every point is a keyboard stop. The daily grid also creates a stop per day. Improve chart navigation and visible date landmarks.
- The shared Promise.all load makes otherwise independent configuration, report and analytics results fail together.

## Design assessment

Source-based heuristic score: **24/40**, with 4 being strongest.

| Heuristic | Score |
|---|---:|
| System status | 2 |
| Match with user expectations | 3 |
| User control | 2 |
| Consistency | 3 |
| Error prevention | 3 |
| Recognition over recall | 2 |
| Efficiency | 2 |
| Minimalism | 3 |
| Error recovery | 1 |
| Help | 3 |

The evidence caveats are good: measured tokens, estimates, completed turns and delivered work are distinguished. Skill previews and evidence links support review before installation. Progressive disclosure fits the existing design.

Cognitive load is moderate. Overview combines several investigative jobs, exposes five outcome actions, and makes users remember a hidden comparison window. First-time users face a disabled primary action; experienced users lose filters during comparison; keyboard users face long chart traversal. The useful payoff is a reviewable skill draft, but activation and recovery interrupt that path.

Minor issues include copy confirmation that changes only an icon and accessible recommendation labels that expose internal keys.

## Verification and limits

- All **19 existing Dojo service tests passed** using Electron in Node mode, matching the installed native SQLite module.
- One additional sampling reproduction passed. Its temporary test file was removed.
- Ordinary Node could not load better-sqlite3 because its ABI differed. No dependencies were rebuilt.
- The design detector completed successfully with **0 findings**. It does not verify interaction behaviour.
- No matching live renderer was available. The installed app was on another checkout; native navigation attempts did not produce a Dojo view. No current-branch screenshot, contrast audit or end-to-end reproduction is claimed.
- No implementation changes were made.

## Decisions for a fix pass

Prioritize recovery and state preservation, then sample quality and review activation. Decide whether manual reviews should work without a schedule, and whether coaching comparisons should describe the workspace or the selected report.
