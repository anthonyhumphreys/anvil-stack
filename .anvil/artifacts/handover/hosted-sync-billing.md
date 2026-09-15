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