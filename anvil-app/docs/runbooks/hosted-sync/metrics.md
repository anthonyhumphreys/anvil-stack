# Hosted sync metrics and alerts — what to watch

Historical packet reference: **BILL-06**. Emission is implemented in the worker as structured
JSON log lines (`src/hosted/metrics.ts`) — one `{metric, ts, ...fields}`
object per line, picked up by Workers Logs/observability and Logpush.
Alert routing, dashboards, and named on-call ownership remain deployment
configuration, not code. Suggested thresholds are starting points — tune
after the first week of real traffic.

## Emitted signals

| Log metric | Source | Fields |
| --- | --- | --- |
| `entitlement.decision` | `checkHostedAccess` (cached, fresh, and outage-fallback paths) | `state`, `source`, `reason`, `cached`, `outageFallback?` |
| `enforcement.denial` | `checkHostedAccess` when a mutating op is refused | `reason` |
| `webhook.event` | Stripe webhook handler | `type`, `outcome` (`processed`/`duplicate`/`failed-deterministic`/`failed-fault`) |
| `webhook.rejected` | Webhook signature failure | `reason: 'signature'` |
| `service_auth.failure` | `/internal/hosted/*` signature rejection | `path` |
| `hosted.route_error` | Hosted dispatch catch-all | `path` |
| `config.issue` | Cron run, enforcement-flag sanity check | `missing` |
| `reconcile.run` | Cron run | `candidates`, `attempted`, `reconciled`, `failed` |
| `reconcile.failure` | Per-account reconcile error | — |
| `reconcile.skipped` | Cron run with Stripe unconfigured | `reason` |
| `reconcile.error` | Candidate-query failure | `stage` |
| `webhook.backlog` | Cron sweep | `oldestUnprocessedAgeMs` |
| `webhook.failed` | Cron sweep | `total`, `lastHour` |
| `checkout.stale` | Cron sweep | `count` (open > 24h) |
| `reconcile.freshness` | Cron sweep | `staleAccounts` (> 24h, subscribed) |
| `sweep.error` | Per-signal sweep failure | `signal` |

The hourly cron (`triggers.crons` in `wrangler.hosted.jsonc`) reconciles
stale billing accounts and emits the sweep signals; see
`src/hosted/reconciler.ts`. Query the metrics below by filtering Workers
Logs on the `metric` field.

## Metrics

### Webhook pipeline

- **Oldest unprocessed `webhook_events` age** — `max(now - created_at)` over
  `status != 'processed'`. The single best signal that the inbox is stuck.
- **`webhook_events` failures per hour** — rows transitioning to `failed`,
  split by deterministic-reject (HTTP 200) vs thrown-fault (HTTP 500).
- **Webhook deliveries per hour** — baseline for anomaly detection; a drop
  to zero during active subscriptions is itself a signal.

### Reconciliation

- **`billing_meta.last_reconcile_at` age per account** — time since last
  successful reconcile for any account with a live subscription.
- **Reconcile 5xx rate** — `/internal/hosted/reconcile` failures mean Stripe
  or D1 is degrading and last-known state is aging.

### Checkout

- **Pending `checkout_sessions` older than 24h** — `status='open'` rows past
  a day are abandoned or stuck; count and age.
- **Checkout creation 4xx/5xx split** — `checkout-disabled` refusals are
  expected pre-launch; `unavailable` means missing price/URL config or
  Stripe failure.

### Entitlement decisions

- **State distribution** — count of decisions by `state`
  (`preview`/`active`/`grace`/`restricted`/`unknown`) and `source`
  (`preview`/`subscription`/`renewal-grace`/`outage-grace`/`none`). Watch
  `unknown` and `outage-grace` specifically — both mean the billing lookup
  is degraded.
- **Cache hit/miss rate** on `hosted_entitlement_cache` — a sudden miss
  spike after a deploy is normal; sustained misses mean thrash.
- **Decision staleness** — entitlement decisions older than their 5-min TTL
  still being served (should be zero; non-zero means the TTL guard
  regressed).

### Enforcement refusals

- **403 `forbidden` count by `details.reason`** — `subscription-required`,
  `preview-ended`, `account-deleted`, `billing-unavailable`. A
  `billing-unavailable` spike is an outage signal, not a policy signal.
- **Refusal→recovery latency** — time from a `subscription-required` refusal
  to the same account's first allowed mutating op after payment (the ≤5-min
  cache TTL bounds the floor).

### Platform errors

- **D1 query errors** on the hosted-billing database — any sustained rate is
  page-worthy; billing truth reads/writes all depend on it.
- **Signed-service auth failures** — `/internal/hosted/*` rejects
  (`unauthenticated`): signature mismatch, bad keyId, skew beyond ±5 min,
  nonce replay. A spike suggests a bad key rollout on the website — or
  probing.
- **Artifact bytes vs limits** — stored bytes per account vs
  `artifactBytes`/`historyBytes` from `HOSTED_SYNC_LIMITS`/defaults;
  approaching-limit is a capacity signal, at-limit 413s are expected
  product behavior.

## Suggested alert thresholds

| Signal | Warn | Page |
| --- | --- | --- |
| Oldest unprocessed webhook age | > 15 min | > 1 h |
| Webhook `failed` transitions | > 5/h | > 20/h or any sustained deterministic-reject cluster |
| `last_reconcile_at` age (subscribed accounts) | > 12 h | > 24 h |
| Pending checkouts > 24h | > 20 | n/a — review weekly |
| `unknown` / `outage-grace` decisions | > 1% of decisions over 15 min | > 5% or any `outage-grace` past 20 h |
| 403 `billing-unavailable` | any sustained > 0 | > 10/min |
| D1 errors | > 0.1% of queries | > 1% or any 5-min sustained failure |
| Signed-service auth failures | > 10/h | > 100/h — possible bad key rollout or attack |
| `HOSTED_BILLING_ENFORCEMENT` != 'true' on prod | — | immediate: the kill switch is on |

## Log hygiene (non-negotiable)

Logs and metrics must exclude: `HOSTED_SERVICE_KEYS`/secrets, enrollment
codes and link codes, raw synced content, card/payment details, signature
values. `webhook_events.last_error` and `billing_audit.detail` are already
sanitized — keep them that way when adding fields.
