# Hosted sync billing and Halloween launch

Status: implementation handoff for Devin using SWE-2. Written 14 September 2026. This is a plan, not evidence that authentication, billing, or paid sync has shipped.

## Outcome and scope

Build a complete journey from the Anvil website through WorkOS account creation, free preview onboarding, Stripe Checkout, account management, and backend-enforced hosted sync access. Website, desktop, and backend must agree on identity and access. Existing local work and self-hosted backends remain independent of Anvil billing.

Anth requested a Halloween launch with hosted sync free through the end of October. Interpret this as a public launch on **31 October 2026**, with preview access ending at the exclusive boundary **2026-11-01T00:00:00Z**, midnight in Europe/London after 31 October. Marketing can launch on Halloween; paid access enforcement starts the following midnight. Use this exact server-side timestamp everywhere, with localized display. Do not silently start charging on the morning of Halloween.

Only the plan is being delivered in this task. The implementation described below is for Devin. Preserve unrelated working-tree changes. Read each affected project's AGENTS.md before editing it; install and run checks inside each independent workspace.

## Product decisions

Confirmed:

- Hosted sync is free during preview through 31 October 2026.
- An Anvil account backed by WorkOS must exist before Stripe Checkout. Users do not need a WorkOS operator/dashboard account.
- All purchasing and billing management happens through the website using Stripe.
- Add a developer account area with the familiar sidebar/detail organization of an editor account dashboard, while retaining Anvil's visual identity.
- Preserve self-hosting and local-only operation without a hosted account or subscription.

Implementation defaults, to make the work concrete:

- Preview requires no card and creates no Stripe subscription. It is a server entitlement, not a rolling Stripe trial.
- Start with one personal hosted product, `sync_personal`, with monthly and annual intervals. Do not build team seats, organizations, enterprise contracts, or multiple paid feature tiers in this release.
- After preview, hosted sync requires payment. This supersedes the earlier suggestion of a permanent hosted free tier for purposes of this plan. Keep that decision visible for Anth's launch review; the policy engine can support a bounded free tier later.
- Provisional price for configuration fixtures and preview mockups: GBP 6/month or GBP 60/year. These are proposals, not approved live prices. Live checkout stays disabled until price, currency, tax presentation, and merchant details are confirmed. Do not publish invented savings or storage promises.
- Publish paid checkout at the preview boundary. Before then the CTA is “Start free preview”; on Halloween it remains “Free through tonight”. If advance paid enrollment becomes required, treat its explicit future-charge consent and fixed trial end as a separate change.
- Propose seven days of payment-recovery grace for previously paid renewals. Initial failed/incomplete payment grants no paid access. Cancellation at period end retains access until the paid period ends.
- No automatic conversion of preview accounts, automatic purchase, or lifetime hosting promise.

## Existing implementation to build on

| Area | Existing location and implication |
| --- | --- |
| Website | `anvil-website/app`, `components/site`, `lib/site.ts`; Next.js App Router, currently no WorkOS/Stripe dependencies or account backend |
| Website checks | `anvil-website/package.json`, `.github/workflows/website-ci.yml`; build/typecheck exist, billing needs a test suite |
| Sync API | `anvil-app/cloud/backend/src/index.ts`, `account-coordinator.ts`, `session-coordinator.ts`, `schema.ts`; Workers, SQLite Durable Objects, R2 |
| Authentication | `cloud/backend/src/oidc.ts`; generic OIDC code exchange expects discovery, PKCE, signed ID token, issuer/audience/expiry/nonce |
| Identity | `session-coordinator.ts` derives `oidc_<sha256(issuer:sub)>`, with new account generations after deletion; do not replace this casually |
| Desktop | `src/main/services/sync-auth.service.ts`, `sync-runtime.service.ts`, `sync-engine.service.ts`, `sync-backend.service.ts` |
| Desktop view | `src/renderer/components/settings/SyncMeshSettingsPanel.tsx`; extend shared contracts, IPC and preload along with it |
| Protocol | `cloud/contract/README.md`, `auth.ts`, `envelope.ts`, `operations.ts`; v1 is frozen, optional response fields are permitted |
| Deployment | `cloud/backend/wrangler.jsonc`; mesh recipe in `anvil-cloud/packages/cloudflare/src/mesh-recipe.ts` reads this config |
| Portability intent | `anvil-sync-mesh-spec-v2.md` and `anvil-backend-integration-contract.md` in this directory |

The backend still contains spike identity/configuration. Production readiness is a prerequisite, not implied by the billing implementation. Read the existing launch acceptance and deployment rehearsal documents. The website database guide currently says cloud sync is absent; update that claim to match the actual release status when shipping this feature.

## Architecture and ownership

Website Next.js server routes authenticate WorkOS sessions and act as the browser's backend. Stripe Checkout and Customer Portal provide payment screens. The hosted Cloudflare backend owns billing records and the entitlement decision used for every hosted operation.

Use a **hosted-only D1 database** for identity mappings, billing records, webhook inbox and reconciliation work. This adds one explicit persistent store because billing needs uniqueness constraints, indexed customer lookup, durable event processing and account-independent reconciliation. Do not add a website database or a second independent subscription truth. Self-host deployment config must not require D1, Stripe, or WorkOS.

Place provider billing operations in a hosted service module within `anvil-app/cloud/backend`. The website calls its restricted internal endpoints over HTTPS using a rotating service credential, timestamped signed requests and replay protection. Include method/path/body hash and a unique request ID in signatures. The website derives WorkOS identity from its verified session, never request-body user IDs. Internal routes are separate from public sync RPC and reject device tokens. Reuse a suitable existing service-auth mechanism if one is found during implementation rather than creating competing mechanisms.

Stripe secrets and the billing database belong to this hosted service. Website routes create checkout/portal sessions through it, so Stripe customer creation and subscription state have one owner. AuthKit credentials/cookie secrets belong to the website. Client bundles, Electron, mobile, and R2 never receive these secrets.

Create a restricted billing overview/device-management facade for the website. Do not issue the website a permanent desktop enrollment merely to display account data. Route its authorized requests through the same account ownership and deletion rules as desktop requests.

Suggested website route surface:

- `/sign-in`, `/sign-up`, `/callback`, sign-out POST using AuthKit conventions.
- `/sync`, `/pricing` for public product information.
- `/account` overview, `/account/billing`, `/account/devices`, `/account/security`, `/account/data`.
- Authenticated POST `/api/billing/checkout` and `/api/billing/portal`.
- Authenticated GET `/api/account/overview` and narrowly scoped device/data actions.
- Public POST `/api/webhooks/stripe`, verifying raw request bytes and Stripe signature in the hosted billing service. The website relays bytes and signature without parsing/re-encoding; return success only after durable acceptance. Alternatively expose the same handler directly on the hosted service under the public website domain if routing supports it. Document the deployed path.

All authenticated pages and endpoints use private/no-store responses. Protect mutations against CSRF with server-verified session plus origin validation and the framework's applicable protections. Return targets are configured same-origin paths; do not accept arbitrary checkout/portal destinations.

## WorkOS identity and desktop enrollment

1. Add the maintained WorkOS AuthKit Next.js integration. Validate its compatibility with the installed Next.js major and use the current proxy/session pattern from official documentation. Protect routes on the server, not only by hiding navigation.
2. On first authenticated request, upsert the personal billing account using the verified immutable WorkOS user ID and environment. Email is display/contact data, never a linking key.
3. Prove desktop compatibility in a test WorkOS environment before building purchase-dependent onboarding. WorkOS Connect supports public OAuth applications with PKCE, but compatibility with Anvil's ephemeral `127.0.0.1:<port>/callback`, ID token claims, nonce and subject mapping must be demonstrated.
4. Preferred path: a first-party public Connect application with the existing generic OIDC enrollment. Never embed a client secret in Electron. Confirm that website identity and desktop issuer/subject resolve to exactly one billing account through an explicit server mapping.
5. Supported fallback: after website signup, an authenticated “Connect device” action issues a short-lived, single-use enrollment code for the mapped sync account. Use the existing enrollment-code contract, rate limits and expiry. Return it once, redact it from logs/analytics, and require explicit user pairing. Do not expose the general enrollment-admin secret or arbitrary-account bootstrap endpoint to the browser.
6. Preserve existing sync account IDs and deletion generations. For an existing non-WorkOS preview account, require proof of both the existing device session and the WorkOS session to link it; never infer ownership from matching email. Add collision tests and an operator recovery path that cannot silently merge accounts.
7. A user can sign in, pair within limits, view billing, export or delete data after access expires. Authentication and payment authorization are separate.
8. Deleting sync data, deleting the entire Anvil account and canceling a subscription are separate, explicitly named actions. Full account deletion must durably arrange subscription cancellation before discarding billing mappings; retry failures. Late webhooks must not recreate deleted data or transfer entitlement to a new account generation.

WorkOS configuration must use one intended user environment across website and hosted sync, with separate development and production resources. Custom-domain/issuer changes require an identity migration, not a new hash that strands subscribers.

## Billing persistence and checkout

Store migrations under a hosted billing directory and keep provider types out of the generic sync contract. Minimum logical records:

- `billing_accounts`: internal ID, unique WorkOS environment/user ID, current sync account mapping and generation, lifecycle state, timestamps.
- `billing_customers`: unique Stripe environment/customer ID mapped to one billing account.
- `billing_subscriptions`: subscription ID, account, allowlisted product/price/interval, provider status, period boundary, cancellation fields, grace deadline, last successful provider reconciliation.
- `billing_webhook_events`: unique environment/event ID, object/customer reference, received time, processing state, attempts, next retry, redacted error. Store only needed event data and set retention.
- `billing_checkout_attempts`: account, idempotency key, Stripe session, expiry, state. Enforce one effective pending purchase per account.
- `billing_entitlements`: account, revision, source, access state, capability/limit policy version, effective expiry, last reconciliation time.
- `billing_audit`: actor/event, transition and reason without card details, tokens or synced user content.

Use unique constraints and durable reservation records to prevent concurrent signup from creating duplicate Stripe customers. Serialize subscription-affecting processing per account using a recoverable lease or a small billing coordinator, with timeout/fencing and idempotent external calls. Do not assume an in-process mutex spans Worker instances.

Checkout sequence:

1. User chooses plan on the website; anonymous visitors complete WorkOS signup/sign-in first, with a validated plan key preserved.
2. Server resolves the billing account and existing subscription. Existing subscribers open Customer Portal, rather than buying a second subscription.
3. Server resolves an allowlisted plan/interval to environment-specific Stripe Price IDs. Ignore submitted amounts, customer IDs, account IDs, arbitrary prices and entitlement claims.
4. Create/reuse the customer and Checkout Session with stable idempotency keys, subscription mode, server-set account metadata and fixed return URLs. Handle double-clicks, abandoned sessions and concurrent devices.
5. Checkout success page shows “Confirming subscription” until the server has verified current Stripe state and persisted entitlement. The redirect/session query parameter alone never grants access. Verify session ownership before using it to accelerate reconciliation.
6. Portal sessions are created afresh for the authenticated account's stored customer. Stripe handles payment method changes, invoices and cancellation. Configure allowed plan changes, cancellation behavior and prorations deliberately.

Use test prices in development; never bake live Price IDs into the app. One versioned plan policy governs public copy and backend limits. Website retrieves a sanitized public catalog from the hosted service with a static unavailable state, rather than directly importing server implementation across workspace roots.

## Webhooks and reconciliation

Verify Stripe signatures against the **unaltered request body** and configured endpoint secret. Separate test/live resources and reject wrong-mode events. Durably insert/dedupe the inbox event before acknowledging. Duplicate delivery returns success; persistence failure returns an error so Stripe retries. Verified but currently unmapped events enter a durable quarantine/retry path rather than disappearing.

Handle Checkout completion/expiry and async success/failure as applicable; subscription created/updated/deleted; invoice paid/payment failed/payment action required. Decide and test a refund/dispute policy: a refund event alone must not be guessed to cancel a subscription. Do not create an entitlement from an invoice for an unrelated product.

Process events by retrieving the current canonical subscription/customer state from Stripe. Stripe events may arrive out of order; an old delivery must not undo a later cancellation or payment. Serialize per account, recompute the effective entitlement over known relevant subscriptions, persist it transactionally and increase its revision. Inspect current API fields against the pinned Stripe API/SDK version rather than assuming a legacy subscription period shape.

Schedule retries for failed processing with bounded backoff and an observable dead-letter state. Reconcile active/grace accounts at least every six hours, and accounts near a billing boundary more frequently. Reconcile after Checkout return and user-requested “Refresh billing” with rate limiting. This repairs lost webhooks and manual Stripe changes. Avoid Stripe calls on every sync request.

## Entitlement policy and failure behavior

Compute a provider-neutral snapshot with `state`, `source`, `planKey`, `capabilities`, `limits`, `previewEndsAt`, `accessUntil`, `graceUntil`, `checkedAt`, `revision`, and a sanitized reason. Suggested states are `preview`, `active`, `grace`, `restricted`, `unknown`; raw Stripe status is additional website billing information, not the client authorization algorithm.

| Condition | Hosted behavior |
| --- | --- |
| Before preview boundary, eligible account | Preview capabilities, no card or Stripe subscription required |
| Successful current paid subscription | Paid capabilities through applicable paid entitlement boundary |
| Subscription set to cancel at period end | Retain paid access until that boundary; display date |
| Previously paid renewal becomes past_due | Seven-day grace starting at the failed renewal boundary; retries do not restart it |
| Initial incomplete/incomplete_expired payment | No paid access; preview still applies before its boundary |
| Canceled, unpaid, paused or expired after applicable grace | Restricted access; account/recovery functions remain available |
| Stripe trialing | Do not grant paid access unless an explicitly approved trial policy exists; preview is independent |
| Billing unavailable | Use bounded last verified state; unknown is not “free” or “canceled” |
| Self-hosted or compatible backend | Operator policy only; no Anvil subscription lookup |

Persist and evaluate preview cutoff using server time even when webhooks or scheduled tasks stop. Cache entitlement inside AccountCoordinator for no more than five minutes, with absolute access/preview deadlines checked per request. Invalidate on billing revision changes where practical. A stale paid record may receive at most a separately configured 24-hour outage grace beyond its last verified access boundary, only for previously verified paid accounts; never extend preview or override a known cancellation, deletion or revocation. Mark outage grace distinctly in diagnostics. Test recovery and expiry of this grace.

Payment enforcement is a deployment-owned server setting. Missing billing configuration must fail hosted deployment validation. Never infer enforcement from a client-supplied connection-mode label or silently fall back to self-host behavior. Self-host configs exclude hosted billing routes and dependencies at runtime.

Use the existing HTTP 403 `forbidden` error with optional details such as `reason: 'subscription-required'` or `'preview-ended'`; retain 401 for actual authentication failure and 413 `quota-exceeded` for existing size limits. Do not add a wire-major-breaking 402/error enum. Add optional entitlement information to `session.describe`; old clients must ignore it. Hosted billing management API remains outside frozen sync RPC.

Enforce at authoritative operation handlers, including HTTP RPC, WebSocket messages and artifact upload/finalize routes. A UI button, a handshake check or an old access token is insufficient. Include a typed exhaustive map covering every operation in `cloud/contract/operations.ts` and all non-RPC routes.

Restricted-access policy:

- Allow identity/session refresh, account status, billing, device list/revoke, data export/status, account deletion and authenticated reads of retained data, with rate limits.
- Deny new sync pushes, import commits, new jobs/claims, new handoffs and new artifact reservations. A rejected sync push must not consume receipts/sequences or mark queued local changes permanently rejected.
- Allow cancellation and bounded completion/reporting for attempts already running at expiry, with their existing ownership fences and deadlines. No new work may masquerade as completion. Permit artifact finalize only for eligible prior reservations, within existing expiry/quota.
- Existing live connections recheck access on messages and before mutating or dispatching work. Server evaluation must catch expiry without requiring reconnect. Preserve read/control access needed to observe or stop running work.
- Enforce storage/device limits atomically including pending reservations. Downgrades block additional usage without deleting data. Final quota values require usage evidence; fixtures can use test quotas without advertising them as product limits.

Payment expiry never wipes local data. Document a proposed 90-day hosted data recovery window after access ends, distinguish it from the protocol's 90-day change/receipt retention, and obtain approval before enabling automated expiry deletion. Implement notices and export availability; do not invent an immediate destructive cleanup job. Reactivation after journal retention requires existing scan/recovery, not cursor reuse.

## Website and app experience

Account area uses a compact sidebar, account identity at the top, and readable detail sections. Reuse existing Anvil color/typography tokens and components. Avoid copying Cursor assets or presenting dummy charts.

- Overview: signed-in identity, preview/paid state, expiry/renewal date, linked devices, measured storage, “Connect a device” and “Open Anvil”.
- Billing: plan and interval, upcoming charge where actually available, cancellation/grace dates, checkout/portal actions and webhook-confirmation state. No fabricated invoices or usage.
- Devices: real enrolled devices with last-seen information where supported, rename/revoke actions and confirmation for revocation.
- Security: supported profile/session controls through WorkOS; make clear whether website sign-out also revokes devices. Full account deletion must cover both systems as specified above.
- Data: existing export/deletion operations with progress, limitations and recovery information. Do not promise a full binary artifact migration until supported and tested.
- Public `/sync` and `/pricing`: explain what sync includes, that user machines/providers supply agent compute, preview cutoff, self-host option, and the approved paid offer when enabled.

Halloween treatment is limited to the sync landing/launch banner, a restrained pumpkin/forge illustration or existing icon, and optional short motion respecting reduced-motion settings. Pricing, invoices and account controls remain easy to read. Use date-driven copy with a tested post-launch state and removal date for seasonal decoration. Never claim “free” after the server cutoff.

Desktop settings gains an entitlement summary, preview end/renewal/grace date, usage where supported and “Manage account” opening the fixed website origin. After browser return or app focus, refresh server status; do not accept a deep-link “paid=true” as proof. Refresh also at login, reconnect and relevant backend refusals.

Treat expired hosted entitlement as a resumable sync pause, distinct from signed-out, offline, conflict and quota states. Preserve pending/dispatched outbox state, installation/enrollment identity, cursors and conflicts. Keep local edits working. On payment recovery resume through normal idempotent push/reconciliation. Account controls stay available.

Cover desktop shared types, IPC, preload, runtime, engine and renderer together. Inspect mobile and Raycast hosted consumers and apply the same status/refusal handling wherever used. Mobile purchasing still happens on the website; do not add an external purchase CTA to store-distributed builds until the release owner verifies applicable storefront rules. Status display and safe pause/resume do not depend on that CTA decision.

## Delivery packets and acceptance

Implement as reviewable commits/PRs in this order. Each packet must include tests and an updated handoff/evidence note. No production provisioning is required to make the code reviewable.

1. **BILL-01: identity proof and contract.** WorkOS sandbox signup plus existing desktop OIDC proof, or working enrollment-code fallback; website and device resolve to one account. Define typed hosted API/entitlement shapes, mapping/deletion rules, policy state machine and fixture catalog. Test account collision, untrusted identity, issuer changes and generation reuse.
2. **BILL-02: hosted persistence and provider flow.** D1 migrations, restricted service API, customer uniqueness, checkout/portal creation, raw-body webhook inbox, canonical reconciliation and audit trail. Verify duplicate/concurrent checkout, invalid signature, duplicate/out-of-order events, provider timeout after a successful create and replay recovery.
3. **BILL-03: backend enforcement.** Exhaustive operation policy, optional status field, five-minute cache bound, absolute cutoff, billing-outage behavior, storage/reservation limits and running-attempt completion. Prove old clients cannot bypass payment, and self-hosted deployment has no WorkOS/Stripe/D1 runtime requirement.
4. **BILL-04: website account area.** AuthKit routes/session protection, dashboard and real billing/device/data views. Show signup-before-checkout, cancel and payment-failed paths, pending webhook state and portal round trip. Add keyboard, mobile layout, empty/error state and reduced-motion checks.
5. **BILL-05: desktop and other clients.** Typed status throughout IPC; managed website links; resumable outbox pause, reactivation, existing socket expiry, and local-only/self-host regression coverage. Test restart while payment is pending and payment recovery after history compaction.
6. **BILL-06: public launch and operations.** Update website copy/docs/nav, launch theme and date transitions; CI for backend/website billing; configuration samples, migration/runbook, reconciliation tools and rollback rehearsal. Produce test-mode end-to-end evidence and the launch approval checklist.

Candidate new modules are `cloud/backend/src/hosted/{billing,entitlements,identity,webhooks}.ts`, `cloud/backend/migrations/hosted-billing/`, and website `lib/auth.ts`, `lib/billing.ts`, `components/account/`, plus routes above. Names are illustrative; fit existing conventions rather than creating layers without a purpose. Keep the hosted configuration separate from the portable backend config.

The current mesh deployment recipe may filter bindings/vars. Use a dedicated hosted configuration/deployment path initially, document it, and verify existing personal deployment still works. If extending the mesh recipe is necessary, read `anvil-cloud/AGENTS.md` and relevant `PATCH.md` owned intent first, update affected docs and tests in that change. Do not make self-hosters provision billing resources.

## Verification matrix

- Boundary clock tests: one millisecond before, exactly at, and after `2026-11-01T00:00:00Z`; browser timezone/clock changes cannot alter access. Halloween page agrees with backend.
- Stripe test-mode lifecycle: purchase, authentication-required payment, failed initial payment, paid renewal failure/grace/recovery, cancel-at-end, immediate cancellation, unpaid/paused, annual plan, duplicate checkout and abandoned checkout. Use Stripe test clocks where supported.
- Fault injection: event duplicated/reordered/lost, crash after inbox insert, crash after Stripe success before local commit, stale processor lease, D1 failure, Stripe outage beyond grace and delayed webhook after deletion.
- Ownership: another user's checkout/session/customer/device/export ID is rejected; email change cannot relink an account; untrusted forwarding headers/signatures cannot select an account.
- Protocol: optional fields ignored by old clients; exact 401/403/413 meanings; enrollment-code and generic OIDC fixtures continue to pass; no hosted lookup on compatible/self-host backend.
- Enforcement: every operation and upload/socket route is accounted for; existing connection cannot write past expiry; already running work can stop/report safely; quota reservations cannot race past the limit.
- Client: unpaid restart, outbox survives pause, successful upgrade resumes once without duplication, payment pause differs from auth failure, export remains available, local work remains usable.
- Website browser flow: anonymous pricing -> WorkOS signup -> preview account -> paid checkout when enabled -> pending verification -> active dashboard -> app refresh -> portal cancellation. Also test a different website identity from the connected desktop and explain the mismatch rather than claiming it was upgraded.

Run `pnpm test` in `anvil-app` and the backend's separate `pnpm test`, `pnpm typecheck`, and `pnpm conformance:fixture`. Run external conformance against a configured test server as documented by that suite. Run app lint/build as required by project CI. Website requires `pnpm typecheck`, `pnpm build`, `pnpm validate:docs` plus new focused billing tests and browser flow tests. Add an appropriate Vitest/browser test setup to website CI because the current workspace has none. Run mobile typecheck/lint if changing mobile. Record exact commands and failures; credentials missing for provider/browser evidence must be stated, not treated as a pass.

## Operations, rollout and launch gates

Keep development, staging and live WorkOS, Stripe prices/customers/webhook secrets, billing DB and backend URLs separate. Pin Stripe API version, document signing key rotation, provider SDK versions, AuthKit callback origins, preview cutoff and service origins in an environment example. Never commit real secrets.

Add metrics for webhook age/failures, reconciliation age, pending checkouts, entitlement source/state, authorization refusals and actual hosted usage. Alert when processed entitlement state is stale. Logs must exclude tokens, enrollment codes, raw synced content and payment data.

Roll out storage/schema and event ingestion first, then shadow entitlement evaluation, then website/account UI and preview client states. Compare shadow decisions to expected policy before switching enforcement on. Use separate explicit switches for checkout publication and billing enforcement. A missing switch/config must fail validation in hosted production, not accidentally grant unlimited access.

Target schedule: identity/provider proof by late September; integrated billing/backend/client flow in early October; test-mode lifecycle and failure rehearsal by mid-October; release candidate and preview-ending notice by 24 October; Halloween launch on 31 October; paid boundary at 00:00 UTC on 1 November. These are targets for planning, not delivery claims. Send transactional preview-end reminders at seven days and one day where consent/configuration permits; no emails are sent as part of implementing this plan.

Before enabling real charges Anth supplies/approves:

- Final monthly/annual price, currency and whether a permanent bounded free tier is desired. Until then use the stated paid-only post-preview default in tests.
- Published storage/device limits based on measurements, payment grace and hosted retention policy.
- Stripe merchant/tax/refund configuration and customer-facing terms/privacy/support details. Implement the resulting configuration; do not infer tax obligations from currency.
- Live WorkOS/Stripe resources, production website/backend origins and ownership of operational alerts.
- Evidence that WorkOS identity/pairing and subscription enforcement work across website and released desktop build; account migration rehearsal for existing preview users.
- Tested rollback: pause new Checkout Sessions first, keep processing payments/webhooks and preserve customer records; revert application code only to a version compatible with new schema. An audited temporary access extension may address an incident, but never auto-charge or delete data to repair it.

Devin should complete code, migrations, tests, sandbox evidence possible with available credentials, and a concrete deployment checklist before handing back. Unapproved commercial values or absent live credentials block live checkout activation, not the rest of implementation. Do not deploy production or create live charges as an incidental test.

## Documentation references

Official documentation checked while preparing this plan on 14 September 2026. Recheck exact SDK/API configuration during implementation.

- [WorkOS AuthKit for Next.js](https://workos.com/docs/authkit/nextjs): website integration and authenticated sessions.
- [WorkOS Connect OAuth applications](https://workos.com/docs/authkit/connect/oauth): public applications, PKCE and token verification. The Anvil-specific loopback compatibility proof is still required.
- [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks): subscription and invoice lifecycle handling.
- [Stripe webhook delivery](https://docs.stripe.com/webhooks): signature verification, retries and event ordering considerations.
- [Stripe Customer Portal integration](https://docs.stripe.com/customer-management/integrate-customer-portal): authenticated customer portal sessions.

Read alongside `anvil-sync-mesh-spec-v2.md`, `anvil-backend-integration-contract.md`, `execution-handoff.md`, `launch-acceptance.md` and `iac-01-deployment.md` in this directory. Update these when implementation changes their documented behavior.
