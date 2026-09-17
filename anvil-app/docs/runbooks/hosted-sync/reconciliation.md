# Billing reconciliation — `/internal/hosted/reconcile`

Packet: **BILL-06** operations. Reconcile pulls canonical subscription state
from Stripe (`GET /v1/subscriptions?customer=…&status=all&limit=25`), upserts
each row into `stripe_subscriptions`, stamps `billing_meta.last_reconcile_at`
and writes a `billing_audit` entry. It is the repair path for lost,
duplicated or reordered webhooks — Stripe event order is not guaranteed.

## When to run it

- A webhook backlog just cleared (`webhook-failures.md`) — confirm
  convergence instead of trusting replay alone.
- Suspected drift: entitlement state doesn't match the Stripe dashboard.
- A user reports checkout success but the account still shows
  preview/restricted ("Confirming subscription" that never resolves).
- Routine freshness: see the `last_reconcile_at` target below.

The website's **Refresh billing** button issues the same signed call —
prefer it for single-account support cases. Use this runbook for
operator-driven or bulk verification.

## Signed call (operator)

`/internal/hosted/*` requires the website→backend HMAC channel
(`src/hosted/service-auth.ts`, audience `anvil-hosted`): the signature covers
method, path, body hash, timestamp and a unique request id, with ±5 min skew
and a D1 nonce table for replay protection.

```sh
HOSTED_ORIGIN=https://anvil-backend-hosted.<subdomain>.workers.dev \
HOSTED_KEY_ID=<keyId> \
HOSTED_SECRET=<secret for that keyId> \
WORKOS_CLIENT_ID=client_… \
WORKOS_USER_ID=user_… \
node --input-type=module <<'EOF'
import crypto from 'node:crypto';
const path = '/internal/hosted/reconcile';
const body = new TextEncoder().encode(JSON.stringify({
  workosClientId: process.env.WORKOS_CLIENT_ID,
  workosUserId: process.env.WORKOS_USER_ID,
}));
const ts = String(Date.now());
const requestId = crypto.randomUUID();
const payload = [
  'anvil-hosted/1',
  'anvil-hosted',
  process.env.HOSTED_KEY_ID,
  'POST',
  path,
  ts,
  requestId,
  crypto.createHash('sha256').update(body).digest('hex'),
].join('\n');
const signature = crypto
  .createHmac('sha256', process.env.HOSTED_SECRET)
  .update(payload)
  .digest('hex');
const res = await fetch(`${process.env.HOSTED_ORIGIN}${path}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-anvil-key-id': process.env.HOSTED_KEY_ID,
    'x-anvil-timestamp': ts,
    'x-anvil-request-id': requestId,
    'x-anvil-signature': signature,
  },
  body,
});
console.log(res.status, await res.text());
EOF
```

Use a fresh `requestId` per call — a replayed `(keyId, requestId)` pair is
rejected by the nonce table.

## Responses

| Response | Meaning |
| --- | --- |
| `200 {reconciled:true, subscriptions:N}` | N subscription rows upserted. `0` is legitimate for an account with no Stripe customer yet. |
| `503 unavailable` | Stripe call failed — `last_reconcile_at` was **not** stamped. Retry later; the account stays on last-known state. |
| `unauthenticated` | Signature/keyId mismatch against `HOSTED_SERVICE_KEYS`. |
| `not-found` | No billing account for that WorkOS identity — check the identity values, not the backend. |
| `forbidden` `account-deleted` | Billing row is `deleting`/`deleted`; reconcile is correctly refused. |

## Freshness target

`billing_meta.last_reconcile_at` (epoch-ms string) records the last
successful reconcile, and `billing_meta.reconcile_at:{billingAccountId}`
the per-account marker. Alert when the per-account marker exceeds **24h**
for any account with a live subscription — the `reconcile.freshness`
sweep signal counts exactly this (see `metrics.md`).

The hourly cron trigger (`src/hosted/reconciler.ts`, `triggers.crons` in
`wrangler.hosted.jsonc`) reconciles accounts whose marker is older than
12h, batched at 10 provider calls per run, and emits
`reconcile.run`/`reconcile.failure` metric lines. The manual route below
remains the repair path for single-account support cases and for forcing
an account to converge before the cron gets to it.

Check the marker:

```sh
pnpm exec wrangler d1 execute anvil-hosted-billing --remote --config wrangler.hosted.jsonc \
  --command "SELECT key, value FROM billing_meta WHERE key = 'last_reconcile_at'"
```

## Manual verification

Compare `stripe_subscriptions` against Stripe dashboard → Customers →
Subscriptions for the mapped customer. `status`, `current_period_end` and
`cancel_at_period_end` must match Stripe's current values. When they don't,
reconcile output is correct only if Stripe actually shows the newer state —
never hand-edit rows to force a match.
