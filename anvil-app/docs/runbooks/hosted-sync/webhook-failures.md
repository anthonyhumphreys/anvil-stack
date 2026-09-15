# Stripe webhook failures — diagnosis and replay

Packet: **BILL-06** operations. Pipeline:
`POST /v1/hosted/stripe-webhook` → raw-body signature verify against
`STRIPE_WEBHOOK_SECRET` → dedupe insert into `webhook_events` → inline
`processStripeEvent` → mark `processed`/`failed`.

## Symptoms

- `webhook_events` rows with `status = 'failed'` (columns: `attempts`,
  `last_error`).
- Stripe dashboard → Developers → Webhooks shows non-2xx deliveries and
  schedules its own retries.
- Subscription drift: a paid account still `restricted`, or a canceled one
  still `active` → run `reconciliation.md`.

## The response split — already implemented, do not "fix" it

| Outcome | Row marked | HTTP | Stripe retries? |
| --- | --- | --- | --- |
| Processed | `processed` | 200 | — |
| Deterministic reject (event cannot be applied — unmapped object, invalid payload) | `failed` | 200 | No |
| Thrown fault (D1 error, Stripe timeout mid-processing) | `failed` | 500 `unavailable` | Yes — Stripe's schedule, roughly hourly, up to ~3 days |
| Duplicate delivery of a `processed` event | — | 200 `{received:true,duplicate:true}` | — |
| Bad signature / oversized body | nothing persisted | `unauthenticated` / `payload-too-large` | Yes |

The 200-on-poison half exists so Stripe doesn't hammer a permanently-failing
event for days; the 500-on-throw half exists so transient faults get retried.
A `failed` row from a deterministic reject needs a human — replaying the same
bytes produces the same result until the cause is fixed.

## Inspect the inbox

```sh
pnpm exec wrangler d1 execute anvil-hosted-billing --remote --config wrangler.hosted.jsonc \
  --command "SELECT id, type, status, attempts, last_error, created_at \
             FROM webhook_events WHERE status != 'processed' ORDER BY created_at"
```

`last_error` is sanitized — no tokens, no card data, no synced content.

## Manual replay

1. **Preferred** — Stripe dashboard → Developers → Events → resend the event
   to the endpoint. A resend carries a fresh signature; the dedupe insert
   treats it as a normal delivery and reprocessing is idempotent.
2. **Bulk/state repair** — fix the underlying cause, then run a signed
   `POST /internal/hosted/reconcile` for each affected account
   (`reconciliation.md`). Reconcile pulls canonical subscription state from
   Stripe and repairs lost, duplicated, or reordered events wholesale —
   usually the right answer when more than one event is involved.

## Alerting inputs

See `metrics.md`. Page on:

- **Age of oldest unprocessed `webhook_events` row** — a growing backlog
  during a Stripe or D1 outage is expected; stale is not. Suggested page: >
  1h oldest unprocessed; warn > 15min.
- **Failure rate** — `failed` rows per hour above baseline.
- Count of `failed` rows as an absolute number is a weak signal alone —
  replay clears it; age is the actionable metric.

## Notes

- Verified-but-unmapped events (Stripe customer not yet linked to a billing
  account) stay in the inbox rather than disappearing — reconcile or replay
  picks them up after the mapping exists.
- Stripe delivers out of order; processors write the delivered state verbatim
  and reconcile is the convergence path. Never hand-edit
  `stripe_subscriptions` to match the "latest" event — run reconcile.
