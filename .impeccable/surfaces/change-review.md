# Work items and change review

This brief records the implemented Work Items and Change Review screens. It is scoped to `anvil-app/src/renderer/components/workitems/WorkItemsView.tsx` and `anvil-app/src/renderer/components/review/ChangeReviewPanel.tsx`; the app's existing `DESIGN.md` remains the visual authority.

## Purpose and first view

Developers choose a work item, decide whether to plan or implement it, and review evidence for the resulting source snapshot. The screen preserves the incumbent dark Operate UI and orange accent. It keeps the item list visible while the selected task or review occupies the detail pane.

Search covers item ID, title and assignee. Connection, cycle, state and tag controls narrow the list. At large widths, the list uses 38% of the available width with minimum and maximum bounds. Below the large breakpoint, selection switches between the list and detail instead of squeezing both together.

The selected task presents its identifier, title, status, owner, repository and source link before the action row. `Implement` is the filled orange primary action with dark foreground text. `Plan first` and `Review change` use outlined buttons. Supporting copy explains that planning waits for approval and implementation proceeds while asking for decisions when needed.

Acceptance criteria appear before the description, with provider ownership and refresh behavior stated nearby. Missing explicit criteria produce an explanatory state rather than inferred approved requirements. `Local review` supports a repository review with locally entered criteria.

## Visual treatment

The screen reuses semantic background, text, border and accent tokens from `src/renderer/styles/global.css`. It does not establish a separate palette. Compact sans-serif text, modest semibold headings and smaller metadata preserve the desktop app's density. Monospace text identifies source snapshots and technical output.

Flat panes, thin dividers and tonal selection distinguish regions. Buttons and fields use the existing rounded corners, visible accent focus outlines and disabled states. Status always includes words such as `Stale evidence`, `passed` or `failed`; colour supplements those labels.

The reviewed task screenshot confirms legible dark text on the orange `Implement` button. Comparison modes retain visible `Base` and `Candidate` outcome labels, including overlay and pixel difference. Acceptance remains an expanded section below the evidence and findings, with manual notes and decision controls visible without opening a disclosure.

## Review behavior

A review records the base revision, candidate tree and criteria fetch time. Saved scenarios describe setup, data reset, server startup, readiness and replay steps. The initial scenario contains desktop and mobile viewports. Configuration exposes plain-language labels such as `Start server command` and `Reset test data command`.

`Run base and candidate` collects evidence for both versions. Review history, run selection and viewport selection let the reviewer inspect earlier captures. Side-by-side comparison becomes two columns at the extra-large breakpoint. Overlay uses a translucent candidate, and pixel difference uses a difference blend. These modes aid inspection; they do not decide whether a regression exists.

Reviewers can describe a finding, optionally supply an element locator or click a candidate capture to record coordinates, and reveal its Playwright trace. Actions, assertions and runner output use disclosures. `Request fix` opens a coding conversation with the finding and replay context. `Ready for recheck` precedes a fresh replay; accepting that replay requires a later passing, current run.

Criteria checkboxes explicitly record human review against the selected run. They stay disabled when evidence is stale, verification is running, or the run has not passed. Acceptance also requires a decision note, every criterion checked and every finding accepted. `Request changes` records a rejection. Historical decisions show reviewer, time and candidate identity.

Export opens an editable Markdown or JSON preview. The UI states that commands, logs and binary artifacts are omitted and asks the reviewer to redact before copying. Linked work items expose a separate publication action after a decision; publication status remains visible.

## Limits and evidence

The supplied screenshots use a synthetic QA fixture, not a production-provider session. They establish the task layout, corrected primary foreground, labelled mobile overlay and expanded acceptance controls. They do not establish end-to-end runner reliability, provider publication success, keyboard coverage or a complete accessibility audit.

Captures render at the available pane width. A mobile capture can therefore become tall and push findings and acceptance below the first viewport. This is observed behavior, not a sizing rule for future screens. Coordinate pinning has a pointer interaction; the text finding and optional locator remain available independently. Automated scenario success does not establish visual or keyboard acceptance.

Evidence reviewed on 2026-09-07:

- `WorkItemsView.tsx`, `ChangeReviewPanel.tsx` and `src/renderer/styles/global.css` in `anvil-app`.
- Root `PRODUCT.md` and `anvil-app/PRODUCT.md`.
- `/Users/anthonyhumphreys/.agent-browser/tmp/screenshots/screenshot-1788764907856.png`, selected task.
- `/Users/anthonyhumphreys/.agent-browser/tmp/screenshots/screenshot-1788764934766.png`, labelled mobile overlay.
- `/Users/anthonyhumphreys/.agent-browser/tmp/screenshots/screenshot-1788764934903.png`, finding controls and acceptance.

No existing `.impeccable` surface brief was found in this checkout. This document adds no global tokens, new visual identity or unverified accessibility guarantees.
