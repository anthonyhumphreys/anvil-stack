# Hosted sync deploy — production rollout for `anvil-backend-hosted`

Packet: **BILL-06** operations. Scope: first production deploy of
`anvil-app/cloud/backend/wrangler.hosted.jsonc` — the hosted worker carrying the
D1 billing store. Self-host deploys keep using `wrangler.jsonc` and need none of
this.

## Prerequisites

- Cloudflare account with Workers, D1, R2 and the Durable Objects classes
  available; `wrangler` authenticated (`wrangler login` or
  `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`).
- Live Stripe and WorkOS resources approved per `launch-checklist.md`. Vars and
  secrets are per-worker — do not deploy test keys expecting to flip them later
  without a redeploy.
- `pnpm install` already run in `anvil-app/cloud/backend` (wrangler is a dev
  dependency; invoke it as `pnpm exec wrangler …`).

## Sequence

Order matters: provision → verify → migrate → deploy checkout-disabled →
secrets → smoke → webhook registration → checkout vars → redeploy.

### 1. Provision D1

```sh
cd anvil-app/cloud/backend
pnpm exec wrangler d1 create anvil-hosted-billing --config wrangler.hosted.jsonc
```

Copy the emitted `database_id` into `wrangler.hosted.jsonc`, replacing
`<placeholder-not-created>`. Commit-free handoff: the real id is deploy config,
not a secret.

### 2. Validate the config

```sh
node scripts/verify-hosted-config.mjs    # or: pnpm verify:hosted-config
```

Must exit 0. Any ISSUE line fails the deploy gate — fix the config, do not
deploy around it. Warnings (missing documented secrets checklist) should be
resolved but do not block.

### 3. Apply billing migrations

```sh
pnpm exec wrangler d1 migrations apply anvil-hosted-billing --remote --config wrangler.hosted.jsonc
```

Migrations under `migrations/hosted-billing/` (`0001_init`, `0002_billing`,
`0003_preview_flag`) are forward-only. Never edit an applied migration file;
add a new one.

### 4. First deploy — checkout still disabled

`HOSTED_CHECKOUT_ENABLED` must be absent at this point. Checkout refuses with
403 `checkout-disabled` without it, which is what we want while secrets land.

```sh
pnpm exec wrangler deploy --config wrangler.hosted.jsonc
```

### 5. Set secrets — only after the first deploy exists

Per IAC-02's live run: `wrangler secret put` against a never-deployed worker
creates a stub version the real deploy does not carry forward. Deploy first,
then:

```sh
pnpm exec wrangler secret put HOSTED_SERVICE_KEYS --config wrangler.hosted.jsonc
pnpm exec wrangler secret put STRIPE_SECRET_KEY --config wrangler.hosted.jsonc
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET --config wrangler.hosted.jsonc
```

- `HOSTED_SERVICE_KEYS` — JSON map `{"<keyId>":"<secret>"}` for the website →
  backend HMAC channel. keyId matches `^[A-Za-z0-9_-]{1,64}$`; each secret must
  be ≥32 bytes. Generate fresh; share with the website host over a secrets
  channel, never in a ticket or commit.
- `STRIPE_SECRET_KEY` — live-mode secret key.
- `STRIPE_WEBHOOK_SECRET` — the endpoint signing secret from step 7's webhook
  registration (create the endpoint first if you want the real value now;
  otherwise put a temporary value and re-put after registration — each
  `secret put` publishes a new version carrying all previously set secrets).

Never put any of these in `vars`. `verify-hosted-config` fails if a dev-only
credential (`ANVIL_DEV_SPIKE`, `ENROLLMENT_ADMIN_TOKEN`) ever appears there.

### 6. Smoke — checkout still disabled

```sh
curl -s https://<worker>.workers.dev/.well-known/anvil-backend
```

Descriptor must advertise the frozen contract (`anvil-backend/1`, `sync/1`,
`enrollment-code`).

Signed internal call — `POST /internal/hosted/account` with a known WorkOS
identity, signed per `src/hosted/service-auth.ts` (reusable signing snippet in
`reconciliation.md`). Expected: `not-found` for an identity with no billing
account, or the account row for a known one. An `unauthenticated` response means
the keyId/secret used to sign doesn't match `HOSTED_SERVICE_KEYS`.

Webhook route liveness:

```sh
curl -s -X POST https://<worker>.workers.dev/v1/hosted/stripe-webhook -d '{}'
```

`unauthenticated` = route live, `STRIPE_WEBHOOK_SECRET` loaded. `not-found` =
the secret never landed — re-put it.

### 7. Register the Stripe webhook endpoint

Stripe dashboard → Developers → Webhooks → add endpoint, live mode:

- URL: `https://<worker>.workers.dev/v1/hosted/stripe-webhook`
- Events: `checkout.session.completed`, `checkout.session.expired`,
  `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`

Copy the endpoint's signing secret into `STRIPE_WEBHOOK_SECRET` (step 5).

### 8. Publish checkout — only after launch approval

Set in `wrangler.hosted.jsonc` `vars`, then re-verify and redeploy:

```jsonc
"HOSTED_CHECKOUT_ENABLED": "true",
"HOSTED_CHECKOUT_SUCCESS_URL": "https://<website-origin>/account/billing?checkout=success",
"HOSTED_CHECKOUT_CANCEL_URL": "https://<website-origin>/account/billing?checkout=cancel",
"HOSTED_PORTAL_RETURN_URL": "https://<website-origin>/account/billing",
"STRIPE_PRICE_SYNC_MONTHLY": "price_…",
"STRIPE_PRICE_SYNC_ANNUAL": "price_…",
```

Optional: `HOSTED_SYNC_LIMITS` (JSON partial quota override) once published
limits are evidence-backed; `STRIPE_API_BASE` is test-only and must never
appear in production.

Return URLs are fixed same-origin website paths — the backend ignores
client-supplied redirect targets.

### 9. Website environment wiring

On the website host (not this worker), per the website workspace's env
example — confirm exact names there before launch:

- `WORKOS_*` — AuthKit API key, client id, cookie password, redirect URI.
- `ANVIL_BACKEND_ORIGIN` — this worker's origin.
- `ANVIL_HOSTED_*` — the keyId/secret pair matching `HOSTED_SERVICE_KEYS`;
  the website signs, the backend verifies.

## Post-deploy verification

- `node scripts/verify-hosted-config.mjs` — still green against the committed
  config.
- Website smoke: anonymous → WorkOS sign-up → preview account → checkout →
  "Confirming subscription" → active dashboard.
- Stripe dashboard shows webhook deliveries returning 200;
  `webhook_events` shows `processed` rows.
