# Hosted sync launch checklist — pre-launch gate

Historical packet reference: **BILL-06**. Every item must be checked and initialled before paid
checkout is published. Drawn from the launch plan's operations/rollout gates;
the plan file is authoritative where wording differs. For current branch
deployment commands, use [deploy.md](deploy.md).

## Identity (WorkOS)

- [ ] Separate production WorkOS environment created. Its desktop and hosted
      client IDs differ from both staging client IDs; the issuer may remain
      `https://api.workos.com/user_management` because client IDs select the
      environment. Website and desktop clients in this environment map to the
      same production user/account.
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

## Production deployment split

- [ ] Production values are complete in the ignored
      `.wrangler/hosted-targets.json` file copied from
      `hosted-targets.example.json`; no production secrets or resource ids are
      committed.
- [ ] Production generated config under
      `.wrangler/mesh/<production-worker>/wrangler.jsonc` points to its own
      provisioned D1 id, Worker and R2 bucket. Do not edit
      `wrangler.hosted.jsonc` to select a deployment target.
- [ ] `HOSTED_BILLING_ENFORCEMENT: 'true'` present; no `ANVIL_DEV_SPIKE` or
      `ENROLLMENT_ADMIN_TOKEN` in `vars`.
- [ ] Production `HOSTED_SERVICE_KEYS` is fresh and installed as a secret;
      production website service credentials match it; key id/secret rotation
      owner named.
- [ ] D1 migrations applied (`migrations/hosted-billing/` 0001–0003).
- [ ] Production Worker, R2 bucket, D1 database, provisioner and descriptor
      id are distinct from staging. Production managed-provisioner token and
      Stripe credentials are fresh.
- [ ] `anvil-staging` and `anvil-production` GitHub environments select the
      matching hosted backend URL. Production is limited to `main` and
      `app-v*` tags and has a required reviewer whose owner is recorded.
- [ ] Production website has its own WorkOS API key, hosted client ID,
      callback URIs, backend origin and `ANVIL_DEPLOYMENT_ENV=production`.

## Evidence

- [ ] Signed-in staging acceptance completed against the recorded release
      candidate, including a website WorkOS sign-in, the same user on two
      physical desktop devices, device revoke/re-pair, scoped browser approval
      and reconnection, managed job run/verified teardown, and disposable
      hosted account deletion. See [staging-acceptance.md](staging-acceptance.md).
      Missing Stripe/WorkOS/Cloudflare credentials or a second physical device
      is **BLOCKED**, not a pass.
- [ ] Stripe test-mode purchase, 3DS-required checkout, failed initial
      payment, cancel-at-period-end, immediate cancellation, annual interval,
      duplicate delivery, abandoned checkout, and reconciliation complete;
      record test event IDs and results in the acceptance record.
- [ ] Renewal failure → grace → recovery, unpaid/paused, and accelerated
      renewal cases completed through a test-only customer bound to a Stripe
      Test Clock. The current website checkout does not attach a Test Clock to
      its customer; this gate remains **BLOCKED** until the clock-bound test
      path exists. Unmapped `stripe trigger` fixtures do not satisfy it.
- [ ] Fault injection evidence: duplicated/reordered/lost events, crash
      after inbox insert, crash after Stripe success before local commit,
      D1 failure, Stripe outage beyond grace, delayed webhook after
      deletion.
- [ ] Rollback rehearsal per [rollback.md](rollback.md) completed on a
      disposable staging D1: export/import verified, Time Travel restore
      verified, and prior Worker code checked against every applied D1
      migration before a code rollback. Record version IDs, bookmark, export
      checksum, and schema check.

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

- [ ] Worker observability collection verified for the selected Worker;
      saved application-metric queries show the expected JSON messages.
- [ ] Cloudflare Worker error alert and external descriptor uptime check
      notify the chosen destination; test notification received and policy
      IDs recorded.
- [ ] Application metrics routed to a threshold-capable alert service with
      the starting thresholds in [metrics.md](metrics.md); D1 rows-read/
      rows-written and account spend-budget notifications configured; named
      responder and escalation route recorded. Saved dashboards alone do
      not satisfy alerting.
- [ ] Preview-end transactional reminders (7d / 1d) approved and scheduled
      where consent/configuration permits.
- [ ] Launch comms copy approved: pricing page, preview-end notice, support
      macros for `subscription-required` / `preview-ended` refusals.
- [ ] Named approver sign-off recorded: prices, limits, grace policy,
      retention policy, launch date.
