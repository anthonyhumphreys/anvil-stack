# Hosted sync launch checklist — pre-launch gate

Packet: **BILL-06**. Every item must be checked and initialled before paid
checkout is published. Drawn from the launch plan's operations/rollout gates;
the plan file is authoritative where wording differs.

## Identity (WorkOS)

- [ ] Real WorkOS application created (not the spike fixture); production
      user environment separate from development.
- [ ] AuthKit configured on the website: sign-in/sign-up/callback routes,
      session cookie, correct callback origins.
- [ ] Desktop OIDC/Connect pairing proven against the real WorkOS
      environment — website identity and desktop issuer/subject resolve to
      exactly one billing account.
- [ ] One intended user environment across website and hosted sync; issuer/
      domain changes documented as an identity migration, not a re-hash.

## Stripe

- [ ] Live-mode secret key + webhook signing secret issued and stored as
      `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` via `wrangler secret put`.
- [ ] Real prices approved by Anth: amount, currency, tax presentation,
      merchant/legal details. Provisional fixture prices (GBP 6/mo, 60/yr)
      are **not** approved live prices.
- [ ] Live Price IDs set as `STRIPE_PRICE_SYNC_MONTHLY` /
      `STRIPE_PRICE_SYNC_ANNUAL`; checkout return URLs fixed same-origin.
- [ ] Webhook endpoint registered, live mode, URL
      `https://<worker>.workers.dev/v1/hosted/stripe-webhook`, events:
      `checkout.session.completed`, `checkout.session.expired`,
      `customer.subscription.created`, `customer.subscription.updated`,
      `customer.subscription.deleted`, `invoice.paid`,
      `invoice.payment_failed`.
- [ ] Customer Portal configured: allowed plan changes, cancellation
      behavior, prorations decided deliberately.

## Production config

- [ ] `database_id` in `wrangler.hosted.jsonc` is the real D1 id (no
      placeholder) — `node scripts/verify-hosted-config.mjs` exits 0.
- [ ] `HOSTED_BILLING_ENFORCEMENT: 'true'` present; no `ANVIL_DEV_SPIKE` or
      `ENROLLMENT_ADMIN_TOKEN` in `vars`.
- [ ] `HOSTED_SERVICE_KEYS` set as a secret; website `ANVIL_HOSTED_*` values
      match it; keyId/secret rotation owner named.
- [ ] D1 migrations applied (`migrations/hosted-billing/` 0001–0003).
- [ ] Separate development / staging / live resources confirmed — no shared
      Stripe customers, webhook secrets, billing DB or WorkOS environment
      across them.

## Evidence

- [ ] Stripe test-mode lifecycle run complete: purchase,
      authentication-required payment, failed initial payment, renewal
      failure → grace → recovery, cancel-at-period-end, immediate cancel,
      unpaid/paused, annual interval, duplicate + abandoned checkout.
      Recorded as evidence, not recited.
- [ ] Fault injection evidence: duplicated/reordered/lost events, crash
      after inbox insert, crash after Stripe success before local commit,
      D1 failure, Stripe outage beyond grace, delayed webhook after
      deletion.
- [ ] Rollback rehearsal per `rollback.md` actually performed — including
      the schema-compatibility check on the rolled-back code.

## Clients and docs

- [ ] Desktop release containing BILL-05 (entitlement status, resumable
      pause, manage-account link) shipped and verified against the deployed
      backend.
- [ ] Website copy/nav updated: preview cutoff date correct, CTA states
      ("Start free preview" → post-cutoff paid copy) tested across the
      boundary; no "free" claims after 2026-11-01T00:00:00Z.
- [ ] Runbooks in this directory reviewed by the on-call owner.
- [ ] `docs/` index or docs-site nav updated to list the runbooks (owned by
      the website workspace — file or hand off before launch).

## Observability and comms

- [ ] Metrics wired per `metrics.md`; alerts routed to a named owner.
- [ ] Preview-end transactional reminders (7d / 1d) approved and scheduled
      where consent/configuration permits.
- [ ] Launch comms copy approved: pricing page, preview-end notice, support
      macros for `subscription-required` / `preview-ended` refusals.
- [ ] Named approver sign-off recorded: prices, limits, grace policy,
      retention policy, launch date.
