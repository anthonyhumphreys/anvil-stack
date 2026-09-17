# Hosted sync backend — market readiness

Assessed: `feature/sync-mesh--foundations` (PR #91), `.tmp-sync-mesh-wt` worktree. Not merged to main.

## Verdict
Engineering ~80%, operations ~30%, marketable ~40%. Functionally complete, not launch-ready. Remaining work is mostly human/provisioning gates, not code.

## Built and verified
- Sync core: push/pull/scan, idempotent receipts, conflict handling, hibernating sockets, eviction recovery (258 backend tests pass locally)
- Mesh: durable jobs/attempts, approvals, artifact manifests + R2 bytes, session handoff
- Hosted tier: WorkOS identity, Stripe checkout/webhooks/reconciliation, D1 billing store, entitlement policy with absolute preview cutoff (2026-11-01), fail-closed write enforcement, 5-min bounded cache, 24h outage grace
- Device lifecycle ops, data export/import, account deletion
- Website: /sync, /pricing, /account (devices, billing, deletion)
- Companions: mobile + Raycast account mode; headless daemon

## Blocking gaps (ranked)
1. **Encryption claims exceed implementation** — site promises "sealed payloads / content stays encrypted"; synced payloads are plaintext JSON over TLS (no E2E seal in sync-engine/sync-backend-client; safeStorage only protects local tokens). Fix copy or ship sealing before charging.
2. **Typecheck broken** — 3 errors in account-coordinator.ts (PresenceRow, AdRow index signatures).
3. **Backend tests not in CI** — app-ci.yml doesn't run the 258-test suite; lint blocked by ESLint 10 / eslint-plugin-react.
4. **All BILL-06 gates unchecked** — real WorkOS app, live Stripe keys/prices/webhook/portal, secrets, D1 database_id still `<placeholder-not-created>` in wrangler.hosted.jsonc.
5. **Observability unimplemented** — metrics.md is a spec; no emission, alerts, or scheduled reconciler (reconcile is manual).
6. **No real-device dogfood** — never run end-to-end on physical hardware; prior rehearsal evidence removed as transitive.
7. **Open product decisions** — pricing unapproved (GBP 6/60 fixtures), transcript portability, local-pairing future, production backend URL, @anvil/cloud-contract packaging.

## Path to marketable
1. Truth pass: fix typecheck, add backend suite to CI, align site copy with actual crypto reality (decide E2E sealing: launch feature vs roadmap).
2. Free preview launch: provision D1/WorkOS/Stripe test-mode, real-device dogfood matrix, ship desktop BILL-05 build.
3. Operationalize: implement metrics.md instrumentation, Cron Trigger reconciler, alert routing, rollback rehearsal.
4. Paid GA: live Stripe lifecycle + fault-injection evidence, approved pricing, preview-end comms + support macros.
5. Positioning: "your machines supply the compute; provider-neutral; self-host free forever" — self-host is the differentiator, lead with it.

## Pricing
Single sync_personal plan (monthly/annual) is correct for v1; device/artifact/history limits scale with value. GBP 6/mo is plausible but unvalidated — use preview cohort for willingness-to-pay data before adding tiers.