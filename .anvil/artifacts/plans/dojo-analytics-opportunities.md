# Dojo analytics opportunities

The screenshots contain useful operational detail. Borrow the execution ledger, evidence labels, and actionable failure breakdowns. Keep Dojo's overview compact.

These are proposed additions, not implemented analytics.

## Priorities

| Priority | Metric | Decision it supports | Anvil readiness |
|---|---|---|---|
| 1 | Run outcomes and failure reasons | Find recurring blockers and distinguish failed, cancelled, interrupted, and completed execution | Normalize persisted session events. Session closure alone does not prove delivery |
| 1 | Median and p90 run duration | Identify slow runs and changes over time | Session start/end timestamps exist. Separate unfinished sessions and label wall time |
| 1 | Correction rate | Assess whether instructions reduce repeated steering | Existing Dojo counts support corrections per 100 user messages. Show denominator and mark phrase matching as heuristic |
| 1 | Review health | Explain failed reviews and make recovery obvious | Report status, errors, timestamps, and trigger already exist |
| 2 | Verified token usage and coverage | Understand consumption without confusing estimates with billing | Dojo currently uses character-count estimates. Add provider-reported usage with provenance |
| 2 | Tool failures and retries | Identify unreliable commands, integrations, and repeated work | Audit persisted event coverage, then normalize errors and explicit retries |
| 2 | Spend per completed work item | Compare cost against useful outcomes | Requires usage, historical pricing snapshots, and explicit work-item completion evidence |
| 3 | Agent-role cost and timing | See whether coordination or validation dominates a run | Requires stable parent/child run IDs and role attribution |
| 3 | Recommendation follow-through | See which coaching changes were applied and whether friction declined | Requires accepted, dismissed, and applied states plus subsequent comparable review windows |

## Presentation

Keep the overview focused on run outcomes, duration, correction rate, and usage coverage. Each number should open its supporting runs.

Add a searchable run ledger showing workspace, work item, provider/model, outcome, elapsed time, token evidence, cost availability, and failure reason. Put agent timelines inside run details.

Show a short list of recurring blockers with counts and example runs. This makes analytics useful for deciding what to fix next.

## Accounting rules

- Count each provider execution once. Parent totals and child totals must not both enter the same aggregate.
- Distinguish provider-reported, estimated, and unavailable usage.
- Show attribution coverage alongside totals.
- Preserve pricing snapshots so changing today's rates does not rewrite historical costs.
- Keep account-wide Codex usage separate from workspace consumption.
- Use non-overlapping periods for trends. Scheduled 30-day review windows overlap.
- Do not call a completed agent turn a successfully delivered feature without supporting evidence.

## Avoid copying

The screenshots' efficiency index and adoption-pressure score lack visible formulas. Prefer transparent counts and rates.

Profanity is a weak headline metric. Keep it as optional coaching context rather than a productivity judgment.

Prerequisite health is useful, but detailed CLI and authentication checks belong in Diagnostics. Dojo should link to the specific issue when it explains a failed run.

## Suggested delivery order

First add review health, duration, and normalized correction rates using existing data. Then establish a run ledger and provider usage accounting. Add cost and role comparisons once attribution is reliable.