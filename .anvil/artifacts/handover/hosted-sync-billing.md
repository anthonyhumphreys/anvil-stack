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

## BILL-03 status

Implemented (in `anvil-app/cloud`, tests in `backend/test/hosted-enforcement.test.ts` + `contract/__tests__/operations.test.ts`):

- `backend/migrations/hosted-billing/0003_preview_flag.sql` — `ALTER TABLE billing_accounts ADD COLUMN preview_eligible INTEGER NOT NULL DEFAULT 1`: the per-account preview lever, independent of lifecycle. `BillingAccountRow` gained `preview_eligible: number`; `getEntitlement`/`getEntitlementSnapshot` now feed `preview_eligible === 1` into the policy input (previously derived from lifecycle alone). `ACCOUNT_SCHEMA` untouched, per the frozen-schema constraint.
- `contract/operations.ts` — additive `HostedOperationClass` + exhaustive `HOSTED_OPERATION_CLASS: Record<OperationName, …>` covering all 41 frozen ops. `mutating` = creates or extends billable work/state (sync.push, scan.begin, import.preview/commit, device.policy.publish, worker.connect/capabilities/replica.publish, job.create/claim, attempt.renew, handoff.create/advance, artifact.reserve). `control` = reads, cancellation, completion reporting, deletion (pull, scan.page/finish on already-open sessions, export.*, operationStatus, worker.describe, job.get/list/cancel, attempt.report, event.pull, approval.get/decide, handoff.get/cancel, artifact.finalize/get/list/delete, session.describe, account.*, device.list/rename/revoke). Contract test asserts key-for-key coverage plus spot classifications.
- `backend/src/hosted/enforcement.ts` — shared resolver + gate:
  - `resolveAccountEntitlement(env, accountId, now)` — uncached D1 resolution for `session.describe`; an account with no billing row is preview-eligible until the absolute 2026-11-01T00:00:00Z cutoff.
  - `checkHostedAccess(storage, env, accountId, now)` — the enforcement check. Inert when `HOSTED_DB` is unbound (self-host) or `HOSTED_BILLING_ENFORCEMENT !== 'true'` (flag off ⇒ no op denied, describe still resolves). Otherwise resolves, caches the decision in the per-object `hosted_entitlement_cache` row, and reuses it for at most `ENTITLEMENT_CACHE_TTL_MS` = 5 minutes — and never past the decision's own absolute `access_until`, so preview grants cannot outlive the cutoff inside the TTL window. Denials cache for the same bound (a fresh payment may take ≤5 min to reflect).
  - Billing-lookup failure is fail-closed for writes via bounded last-verified state: a cached `subscription` decision earns at most `OUTAGE_GRACE_HOURS` (24h) past its stored paid-through as `outage-grace`; cached preview/grace entries keep their absolute deadline and are never extended; no cache ⇒ `unknown` ⇒ denied. Unit-tested with stub env + throwing D1 inside `runInDurableObject`.
  - `hostedConfigIssues(env)` — lists missing `HOSTED_DB`/`HOSTED_SERVICE_KEYS` when enforcement is requested (flag-on-without-bindings would silently self-host).
- `backend/src/account-coordinator.ts` — the single choke point:
  - Constructor execs `ENTITLEMENT_CACHE_DDL` (separate from `ACCOUNT_SCHEMA`).
  - `handleRpc` gates every `mutating`-class operation after auth + envelope validation but before dispatch — a denied `sync.push` consumes no receipts/sequences and marks nothing rejected. Denial = `rpcErrorResponse(requestId, 'forbidden', { reason })`; 401 stays auth-only, 413 stays quota.
  - `handleArtifactUpload` (PUT /v1/artifacts/{id}) gates identically — a restricted account cannot land new billable bytes even on an open reservation; `artifact.finalize` (control) still publishes reservations whose bytes were stored while eligible, within existing expiry/quota checks.
  - `handleActivityFrame` classification: **control — left ungated with the reporting-rationale comment**. The frame only reports on an already-existing fenced attempt (validates attempt ownership, live worker incarnation/lease, fence generation, sequence, terminal-state; `control` streams route to approval handling; ordinary streams journal + fan out). It cannot create work or extend the lease — `attempt.renew` is the mutating op and is gated — so denying frames would only break the plan's "observe/stop running work" guarantee (including the approval channel) without reducing exposure. The other socket frame types (`subscribe`/`unsubscribe`) are observation-only control; `acceptClient` is ungated per the fixed design, so the socket surface needed no additional gate.
  - Live connections re-check per message implicitly: every socket activity frame is bound to an attempt whose renewals are denied post-restriction, so in-flight work dies at its existing deadline.
- `backend/src/session-coordinator.ts` — `handleDescribe` adds `entitlement` when `HOSTED_DB` is bound, via `resolveAccountEntitlement(...).catch(() => null)`; resolver failure omits the field rather than failing describe. Unbound (self-host) omits it entirely.
- `backend/worker-configuration.d.ts` — `HOSTED_BILLING_ENFORCEMENT?: string` declared; `wrangler.hosted.jsonc` sets it `'true'` for hosted deploys and documents the kill switch. Self-host `wrangler.jsonc` is unchanged and has no D1.
- `backend/vitest.config.ts` — binds `HOSTED_BILLING_ENFORCEMENT: 'true'` for the whole pool; `test/hosted-migrations.setup.ts` applies all three hosted migrations to each per-file fresh D1 before test modules evaluate (module-scope fixtures exist, e.g. handoff.test.ts top-level awaits).

Tests: backend `pnpm exec vitest run` — **19 files / 242 tests, all green** (226 pre-existing + 16 new in `hosted-enforcement.test.ts`); contract `operations.test.ts` — 3 tests green under the root vitest include; `pnpm typecheck` clean. Enforcement-on broke zero pre-existing tests (all test accounts are unlinked ⇒ preview).

New coverage includes: restricted account — sync.push 403 `subscription-required` / sync.pull 200 / job.create 403 / job.list 200 / data.export.begin 200; pre-restriction attempt completes via attempt.report while attempt.renew is denied and job.cancel stays live; artifact.reserve 403, PUT bytes 403 on an open reservation, finalize of an already-uploaded reservation publishes; handoff.create 403 / handoff.cancel 200; account.delete 200 (real enrolled session); session.describe reports `restricted`/`subscription-required` and `preview` for unlinked; paid active subscription keeps mutating ops allowed; cache TTL honored then refreshed by forced `fetched_at` staleness (both directions); outage paths (paid ≤24h grace, preview never extended past cutoff, no-cache ⇒ unknown/denied); self-host + flag-off inert; `hostedConfigIssues` contents.

Deviations / notes:
- `sync.scan.page`/`sync.scan.finish` are `control` (only `scan.begin` creates state) — same finish-what-exists rule as `artifact.finalize`.
- Denied decisions cache for the full TTL too, so a payment can take ≤5 min to restore write access; the TTL is the spec bound.
- `handleArtifactDownload` and internal `/internal/*` routes are intentionally ungated: download is an authenticated read of retained data; internal routes power deletion/revocation/sweep paths that must keep working on restricted accounts.
- Enforcement cache stores `revision` for observability; practical invalidation is the 5-minute TTL plus explicit `fetched_at` aging (used by tests).
- No new deps, no wire changes (existing `forbidden` code + optional `details.reason`), no commits made; no deploy or real credentials touched.

## BILL-06 status

Implemented (operations surface only — no production provisioning):

- `anvil-app/cloud/backend/scripts/verify-hosted-config.mjs` — deployment validation gate. Dependency-free JSONC parse (string-aware comment + trailing-comma strip), then: HOSTED_DB binding present with a real `database_id` (placeholder/empty **fails**, per the plan's "missing billing configuration must fail hosted deployment validation"), `HOSTED_BILLING_ENFORCEMENT === 'true'`, `vars` free of `ANVIL_DEV_SPIKE`/`ENROLLMENT_ADMIN_TOKEN`, and DO bindings + `migrations` + R2 parity against `wrangler.jsonc`. `--json` emits stable `{ok, issues, warnings}`; `--self-check` validates inline known-good/broken fixtures so CI proves the validator without a real database_id. Secrets (`HOSTED_SERVICE_KEYS`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) are checked as documented-in-comments warnings — they can't be verified from a config file. Wired as `pnpm verify:hosted-config`; `--self-check` runs in `.github/workflows/app-ci.yml` (the workflow whose `anvil-app/**` filter covers `cloud/backend`; the backend workspace is not in the root pnpm workspace, and the script needs no deps).
- `anvil-app/docs/runbooks/hosted-sync/` — `deploy.md` (provision → verify → migrate → deploy checkout-off → secrets-after-first-deploy per the IAC-02 stub-version lesson → smoke → Stripe webhook → checkout vars), `rollback.md` (checkout off → keep webhooks flowing → never drop D1 → schema-compatible code only → enforcement flag last), `webhook-failures.md` (the implemented 500-on-throw / 200-on-poison split, replay, alerting), `reconciliation.md` (signed `/internal/hosted/reconcile` incl. a runnable operator signing snippet, 24h `last_reconcile_at` target), `entitlement-incidents.md` (five states, `hosted_entitlement_cache` 5-min TTL + safe row deletion, outage-grace bounds, `preview_eligible` lever, fail-closed posture), `account-deletion.md` (delete flow, 90-day window as policy-not-mechanism, WorkOS as a separate deletion), `launch-checklist.md` (gate list), `metrics.md` (metric list + suggested thresholds, log hygiene).

Verified: `node --check` clean; `--self-check` exits 0; the real config exits 1 naming the `<placeholder-not-created>` database_id (correct pre-launch); a tmp copy with a real-looking id exits 0.

NOT done — requires live credentials/approvals, not more code:

- No real Stripe test-mode lifecycle run — stubbed outbound only; needs live-mode sandbox credentials.
- No production deployment — `database_id` placeholder remains; nothing was provisioned or deployed.
- Website copy/nav/theme and its env example are the website workspace's packet (BILL-04); a docs-site nav entry listing the runbooks is still owed there.
- No metrics/alerts implementation — `metrics.md` is the spec; wiring is launch work.
- No scheduled reconciler — `/internal/hosted/reconcile` exists; per-account on demand until a scheduled trigger is added.

Precise remaining manual steps to go live: (1) `wrangler d1 create anvil-hosted-billing` → real `database_id` into `wrangler.hosted.jsonc`; (2) `verify-hosted-config` green; (3) `wrangler d1 migrations apply --remote`; (4) `wrangler deploy --config wrangler.hosted.jsonc`; (5) `wrangler secret put` × 3 after first deploy; (6) descriptor + signed smoke; (7) register the Stripe webhook endpoint (event list in `deploy.md`/`launch-checklist.md`); (8) Anth approves prices/limits/tax → set `HOSTED_CHECKOUT_*`/`STRIPE_PRICE_*` vars + `HOSTED_CHECKOUT_ENABLED` → redeploy; (9) website `WORKOS_*`/`ANVIL_BACKEND_ORIGIN`/`ANVIL_HOSTED_*` env on the website host; (10) walk `launch-checklist.md` with a named approver.
