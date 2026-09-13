---
title: Evidence-backed change review
navTitle: Change review
description: Replay base and candidate scenarios, inspect screenshots and traces, and record acceptance against a specific source snapshot and criteria version.
product: Anvil Desktop
section: Assurance
journey: build
order: 119
---

# Evidence-backed change review

Change review ties a human decision to a source tree, acceptance criteria, and an observed browser replay. Open Review for a repository change or start from a connected work item. Work-item references include the provider connection, so identical ticket IDs from different connections remain separate.

## Configure a replay

1. Choose the repository and base ref. Anvil captures the candidate source snapshot.
2. Link a work item or supply local acceptance criteria. Refreshing provider criteria creates a version that the evidence must match.
3. Configure the fixture version, optional setup command, reset command, start command, readiness path, browser steps, and viewports.
4. Run the scenario against the base and candidate.
5. Inspect the paired captures, step results, logs, and traces before recording a decision.

The runner prepares separate detached worktrees, data directories, and local ports for the two sides. It supplies `PORT`, `ANVIL_REVIEW_URL`, `ANVIL_REVIEW_DATA`, and `ANVIL_REVIEW_TREE` to the scenario commands. Reset fixtures deterministically so the comparison exercises the same starting state.

Supported browser steps navigate, click, fill, press keys, and assert visibility or text. Screenshots and traces carry digests so altered or missing artifacts cannot silently stand in for the original evidence. Setup or reset changes to the source snapshot fail the run.

## Findings and acceptance

Annotate a capture with a concrete issue. Mark a repair ready for recheck, then run a subsequent passing replay before accepting that finding.

Accepting the change requires a passing candidate run, an accepted decision for every criterion, and no unresolved findings. The decision records the source snapshot, criteria version, run, reviewer, and note. Rejection is also recorded.

Source, scenario, or criteria changes can make evidence stale. Refresh and replay the current candidate before relying on an earlier acceptance. A successful browser run proves only its configured assertions and captures; it does not prove untested behavior or replace code and security review.

## Export and publish

Export the review as Markdown or JSON. To publish to a linked work item, inspect and redact the prepared text before submitting it. Publishing requires a recorded decision and a provider that supports review publication.

An uncertain publication result is not retried automatically. Inspect the remote work item first to avoid duplicate comments.

## Requirements and limits

The reviewed repository must already have `@playwright/test` or `playwright` and the required Chromium browser installed. The runner does not download a browser package for you. Its current process and listener checks use `lsof`, `ps`, and POSIX process groups; this replay path is not Windows-portable yet, even though Desktop has Windows packages.

Setup, reset, and start commands execute locally with the user's permissions. Worktrees isolate source state, not the operating system. Use test fixtures and inspect commands before running a scenario.

See [Security and review](/docs/desktop/security-and-review) for review scope and [Workflow graphs](/docs/desktop/workflow-graphs) for agent coordination.
