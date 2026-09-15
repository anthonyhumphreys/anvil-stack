# Hosted sync rollback — incident response order

Packet: **BILL-06** operations. Goal: stop the bleeding without breaking
subscription truth. The order below is deliberate — billing state must keep
converging even while product behavior rolls back.

## Order

### 1. Disable checkout first

Remove `HOSTED_CHECKOUT_ENABLED` (or set `"false"`) and the `STRIPE_PRICE_*` /
`HOSTED_CHECKOUT_*_URL` vars in `wrangler.hosted.jsonc`, then redeploy:

```sh
pnpm exec wrangler deploy --config wrangler.hosted.jsonc
```

New paid signups pause immediately — `/internal/hosted/checkout` returns 403
`checkout-disabled`. Existing subscribers are unaffected.

### 2. Keep the webhook endpoint processing

Do **not** remove `STRIPE_WEBHOOK_SECRET`, do not block
`/v1/hosted/stripe-webhook`. Webhooks must keep flowing so the D1 subscription
mirror converges. A paused webhook backlog means stale entitlement state and a
harder recovery — the inbox is the repair path, not the problem.

### 3. Preserve D1 customer records

Never drop or truncate hosted-billing tables during rollback.
`stripe_customers`, `stripe_subscriptions`, `webhook_events`,
`checkout_sessions` and `billing_audit` are the record of who paid and what was
processed. Deleting them during an incident is unrecoverable and turns a
rollback into data loss.

### 4. Redeploy only schema-compatible code

D1 migrations are forward-only — there is no down-migration path. Roll back
`src/` to a version that tolerates the current schema: every migration already
applied stays applied. If the bad deploy added a migration, the rolled-back
code must still run against it. Check this *before* rolling back code, not
after.

### 5. Enforcement flag is the last resort

```jsonc
"HOSTED_BILLING_ENFORCEMENT": "false"
```

plus redeploy restores pre-enforcement behavior: every operation is allowed
while `session.describe` still reports entitlement state. Security posture:
denials stop — restricted and unknown accounts can write again. Prefer
checkout-disable (step 1) for billing incidents; reach for the kill switch
only when enforcement itself is the fault. Re-verify the flag is back to
`'true'` as part of incident closure — `verify-hosted-config` fails the
config while it is off, which is the intended tripwire.

## Explicit non-actions

- **No automatic access extension** to placate users during an incident. An
  audited manual extension (e.g. `preview_eligible` flip — see
  `entitlement-incidents.md`) may be approved case-by-case; never automatic,
  never to repair the incident itself.
- **No data deletion** — no rows, no artifacts, no `webhook_events` backlog.
- **No WorkOS or Stripe resource deletion/re-creation.** Deleting a Stripe
  customer or WorkOS user mid-incident breaks the mapping that recovery needs.

## Recovery verification after rollback

- `node scripts/verify-hosted-config.mjs` — green again (the enforcement flag
  diff is deliberate and visible).
- Signed `/internal/hosted/billing` and `/internal/hosted/entitlement` calls
  return sane state for a known account (signing snippet in
  `reconciliation.md`).
- Stripe dashboard shows webhook deliveries returning 200; the
  `webhook_events` backlog drains — see `webhook-failures.md`.
