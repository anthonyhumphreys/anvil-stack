# Entitlement incidents — access states, cache and levers

Historical packet reference: **BILL-06** operations. The entitlement decision lives in
`src/hosted/policy.ts` (shape in `cloud/contract/entitlements.ts`);
enforcement is `checkHostedAccess` in `src/hosted/enforcement.ts`, invoked by
AccountCoordinator for every `mutating`-class operation and for artifact
byte upload. Denial is HTTP 403 `forbidden` with `details.reason`.

## The five `HostedAccessState` values

| state | meaning | source |
| --- | --- | --- |
| `preview` | free access before the 2026-11-01T00:00:00Z cutoff | `preview_eligible` flag + server clock |
| `active` | paid subscription in good standing | `stripe_subscriptions` rows |
| `grace` | temporary continued access | `renewal-grace` — 7d after a failed paid renewal; `outage-grace` — ≤24h billing-outage cover |
| `restricted` | no paid/preview/grace cover — mutating ops denied | post-cutoff with no subscription, or canceled/unpaid/expired after grace |
| `unknown` | billing state unresolvable | D1/lookup failure with no usable cache — **fail closed** |

`reason` narrows it: `preview`, `paid`, `renewal-failed`, `billing-outage`,
`preview-ended`, `subscription-required`, `account-deleted`,
`billing-unavailable`.

## Cache behavior

Each AccountCoordinator object keeps a durable SQLite row in
`hosted_entitlement_cache` (single row, `id = 1`) — separate from D1, created
by `ENTITLEMENT_CACHE_DDL` in the object's own storage.

- TTL is 5 minutes (`ENTITLEMENT_CACHE_TTL_MS`) — and never past the
  decision's absolute `access_until`, so a preview grant can't outlive the
  cutoff inside a TTL window.
- **Denials cache for the same 5 minutes.** A fresh payment can take ≤5 min
  to restore write access; tell support before telling them to wait.
- `revision` is stored for observability; practical invalidation is the TTL.

### Force-refresh

Deleting the `hosted_entitlement_cache` row is safe — the next check
re-loads from D1 and rewrites it. There is no operator SQL console for
Durable Object storage, so the supported levers are:

1. Wait out the ≤5 min TTL (default answer for a single-user report).
2. Fix D1 truth via `/internal/hosted/reconcile` — the cache reads the same
   truth on its next load, so reconcile + TTL is the practical refresh.

## Outage grace rules — hard bounds

When the billing lookup fails (D1 error, Stripe down during a reconcile):

- A cached `subscription`-source decision earns at most **24h**
  (`OUTAGE_GRACE_HOURS`) past its stored paid-through boundary, surfaced as
  `state:'grace', source:'outage-grace', reason:'billing-outage'`.
- **Only previously-verified paid accounts** qualify.
- Preview is never extended past the 2026-11-01T00:00:00Z cutoff. Known
  cancellations, deletions and revocations are never overridden.
- No cache entry at all → `unknown` → denied. Unknown is never "free".

## Levers

### Per-account preview eligibility — `billing_accounts.preview_eligible`

INTEGER flag (default 1, migration `0003_preview_flag`). Grant or revoke
preview for one account:

```sh
pnpm exec wrangler d1 execute anvil-hosted-billing --remote --config wrangler.hosted.jsonc \
  --command "UPDATE billing_accounts SET preview_eligible = 0 WHERE id = '<billing_account_id>'"
```

Takes effect within the 5-minute cache TTL. Direct SQL skips `billing_audit`
— record the action in the incident log yourself. This is the audited manual
lever for case-by-case access decisions, not an incident repair mechanism.

### Deployment-wide enforcement — `HOSTED_BILLING_ENFORCEMENT`

`'true'` gates mutating ops; anything else leaves every operation allowed
while `session.describe` still reports state. This is the rollback kill
switch — see `rollback.md` step 5 for when it is and isn't the right move.

## Fail-closed posture

Unmapped identity, D1 error with no cache, malformed state → `unknown` →
mutating ops denied. Never treat `unknown` as free access, and never "fix" a
denial by disabling enforcement before confirming the policy isn't simply
correct — a user denied with `subscription-required` after the preview
cutoff is the system working.
