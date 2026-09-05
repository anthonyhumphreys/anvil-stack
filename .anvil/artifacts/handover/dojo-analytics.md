# Dojo analytics

Implemented in the Desktop workspace.

## Experience
Performance includes outcome breakdowns, median/p90 duration, correction trends, usage coverage, recurring blockers, searchable runs, evidence drilldowns, observed agent timelines, role summaries, pricing and work-item spend.

Coaching includes curated recommendations and generated skill drafts grounded in conversation evidence. Drafts can be previewed, copied or downloaded. Recommendations support accepted, applied and dismissed states.

## Accounting
- All supported providers use a shared analytics model.
- Missing token or cost evidence remains unavailable.
- Character-based estimates remain separate from provider measurements.
- Prices are captured with new usage observations; editing rates does not reprice history.
- Session closure does not prove successful delivery. Work-item delivery is explicitly marked.
- Duration is wall time, including pauses.
- Monthly summaries group by session-start month.
- Child activity is shown without inventing attributed token usage.
- Before/after correction comparisons are observational, not causal.

## Operation
Run a new review to populate crafted skills. Downloads are reviewable drafts, not automatically installed skills.

Schema migration 61 adds execution telemetry, prices, recommendation states and delivery markers.

## Verification
582 tests passed across 104 files. Production build and targeted lint passed. Wide and narrow layouts and key interactions were checked using illustrative data.

Live provider runs were not exercised. Full TypeScript checks still report existing errors outside the Dojo implementation.