Implementation plan for Devin using SWE-2:
[Full plan](anvil-app/docs/plans/sync-mesh/hosted-sync-billing-launch-plan.md)

Deliver six packets: identity, billing infrastructure, backend enforcement, website account area, app integration, and launch operations.

Free preview runs through 31 October 2026. Paid enforcement starts 1 November at 00:00 UTC. The plan assumes paid hosted sync afterward; final prices, quotas and any permanent free tier require launch approval. Self-hosting remains independent of Anvil billing.

## BILL-01 status

Implemented (in `anvil-app/cloud/backend`, tests in `test/hosted-*.test.ts`):

- Entitlement policy state machine (`src/hosted/policy.ts`) — preview/active/grace/restricted/unknown with the 2026-11-01T00:00:00Z cutoff, renewal + outage grace bounds.
- WorkOS identity contract (`src/hosted/identity.ts`) — `client_*`/`user_*` validation, deterministic `workos_<sha256>` sync account derivation, `base~N` generation convention.
- HMAC service auth (`src/hosted/service-auth.ts`) — signed method/path/body/timestamp/request-id, ±5 min skew, nonce callback.
- D1 identity store (`migrations/hosted-billing/0001_init.sql`, `src/hosted/store.ts`) — `billing_accounts` (UNIQUE WorkOS identity, partial unique index claiming a sync account while active), `hosted_link_codes` (hashed, 10-min TTL, cap 5), `service_nonces` replay table. Deleted identities can never resurrect.
- Routes (`src/hosted/routes.ts`): public `POST /v1/hosted/link` (device bearer + link code) and signed `/internal/hosted/{pair-device,link-code,account}` (audience `anvil-hosted`, D1 nonce consumption). SessionCoordinator gained internal-only `/internal/issue-enrollment-code`, `/internal/deletion-state`, `/internal/resolve-device` (stub.fetch only, never publicly routed).
- `wrangler.hosted.jsonc` is the dedicated hosted deploy config; `wrangler.jsonc` stays D1-free so self-hosters see no hosted surface (all hosted paths 404 without HOSTED_DB).

Not implemented yet (later packets): real WorkOS AuthKit sandbox verification and Connect/OIDC proof on desktop, Stripe customer/subscription/checkout/webhook persistence (BILL-02), per-operation entitlement enforcement and session.describe entitlement population (BILL-03), website account area (BILL-04).

Fixture limitation: tests exercise the hosted surface with a miniflare D1 binding and a static `HOSTED_SERVICE_KEYS` test key — no live WorkOS or Stripe credentials were used, so pairing is proven against the code path, not a real WorkOS environment.

## BILL-02 status

Implemented (in `anvil-app/cloud/backend`, tests in `test/hosted-billing.test.ts`):

- `migrations/hosted-billing/0002_billing.sql` — `stripe_customers` (one per billing account, UNIQUE both directions), `stripe_subscriptions` (verbatim provider mirror + `has_paid_invoice`/`first_failed_renewal_at` bookkeeping columns that upserts never overwrite), `checkout_sessions` (open/complete/expired), `webhook_events` (pending/processed/failed inbox with attempts + last_error), `billing_audit` (sanitized JSON detail only), `billing_meta` (reconciliation markers).
- `src/hosted/stripe.ts` — SDK-free Stripe REST client (fetch + form-encoded bodies, `Idempotency-Key` on POSTs, `StripeApiError` on missing key/network/non-2xx) and `verifyStripeWebhookSignature` (raw-body `t,v1` HMAC-SHA256, 5-min tolerance, constant-time compare, multiple v1 tolerated for rotation).
- `src/hosted/billing.ts` — store layer: customer/subscription upserts, invoice paid/failed bookkeeping (first failure sticks, paid clears it), checkout row lifecycle, webhook inbox dedupe, audit, `loadSubscriptions` → `getEntitlement` (policy evaluation over stored truth; renewal grace 7d / outage grace 24h constants; `DEFAULT_HOSTED_LIMITS` in policy.ts + `HOSTED_SYNC_LIMITS` JSON override).
- `src/hosted/billing-routes.ts` — public `POST /v1/hosted/stripe-webhook` (64 KiB raw body, signature-verified, deduped, inline processing: checkout complete/expired, subscription created/updated/deleted, invoice paid/payment_failed-cycle; deterministic rejects marked failed with HTTP 200, thrown faults marked failed with HTTP 500 so Stripe retries) and signed internal `checkout`, `portal`, `billing` (overview), `entitlement`, `reconcile` endpoints. All config gates run before any provider call; checkout refuses with 403 `checkout-disabled` unless `HOSTED_CHECKOUT_ENABLED === 'true'`.
- `wrangler.hosted.jsonc` documents the hosted-only vars/secrets; `worker-configuration.d.ts` declares every new optional binding; self-host sees 404s throughout (no HOSTED_DB ⇒ no webhook route either).
- Reconciliation pulls `GET /v1/subscriptions?customer=…&status=all&limit=25`, upserts each row, stamps `last_reconcile_at`, audits; provider failure propagates 503 without marking reconciled; missing customer reconciles cleanly to `subscriptions: 0`.

Not implemented yet / deferred: real Stripe test-mode credentials were never exercised (stubbed outbound only — miniflare `outboundService` interceptor in `vitest.config.ts`, because `cloudflare:test` in `@cloudflare/vitest-plugin@1.1.7` exports no `fetchMock`; Stripe API version pinning not sent — account default applies), no scheduled/6-hour reconciliation trigger (the endpoint exists; a scheduled handler is BILL-03/ops work), no webhook retry scheduling/dead-letter beyond the failed-event record, entitlement caching in AccountCoordinator and all enforcement are BILL-03, website account area is BILL-04.

Policy notes: post-cutoff restricted reason is `preview-ended` (policy's existing behavior) rather than `subscription-required`; out-of-order subscription events take the latest event's values verbatim with reconcile as the repair path, per plan.
