# Free Sync and Mesh launch checklist

Updated 4 October 2026. The approved offer is free Sync and Mesh, with only future Anvil Cloud Agents
charged for. This checklist replaces the former paid Sync launch gate. It is not a production launch
record; items need real environment evidence before an operator deploys.

## Identity and targets

- [ ] Staging and production use separate WorkOS environments, client IDs, Worker/D1/R2 resources,
      descriptors, and service/operator keys. Website and desktop within one target resolve the same
      account identity.
- [ ] AuthKit sign-in, callback origins, desktop enrollment, device revocation, and re-pairing work
      against the selected target. Development enrollment credentials are absent from production.
- [ ] Selected-target config passes its preflight without requiring a new Sync subscription price or
      Stripe availability. Existing billing records and migrations remain intact.
- [ ] Account lifecycle, local device trust, device limits, and operator fair-use policies remain
      enforced independently of subscriptions.

Use [deploy.md](deploy.md) for generated config and staging/production selection. No production
resource operation is implied by completing local tests.

## Free product acceptance

- [ ] An unsubscribed account syncs configuration, enrolls its machines, submits/completes Mesh jobs,
      approves, cancels, and hands off work after the former preview deadline.
- [ ] Missing/canceled/unpaid legacy subscriptions and billing lookup failures do not pause free access.
- [ ] Workspace creation defaults to local and offers free Sync explicitly. Account sign-in and Sync
      enablement do not silently adopt local workspaces. Existing opted-in replicas retain their data.
- [ ] Opt-out stops future workspace replication without deleting local work; re-enable has verified
      conflict/revision behavior. Task-scoped remote setup works without ongoing Sync.
- [ ] Device revocation and key rotation fail closed where required. Account deletion and operator
      restrictions still deny their respective operations.
- [ ] Desktop, website, and backend accept the free entitlement response. Last released clients are
      tested for compatibility; the update route is proven for clients that cannot accept it.
- [ ] Scoped browser approval/reconnect and two-device execution are verified on real machines.
- [ ] Restore/export/import and rollback are rehearsed on a disposable staging account/database.
      Native runtime and generated headless-worker builds match the candidate source.

## Anvil Cloud Agents

- [ ] `ANVIL_CLOUD_AGENTS_ENABLED` is absent or explicitly false in desktop/backend/provisioner candidate
      configuration. Creation and resume fail before allocating provider resources.
- [ ] Users' own fleet and BYO cloud providers retain their supported execution paths.
- [ ] Existing Anvil Cloud Agent status, suspension, cancellation, and deletion remain available.
- [ ] Website/app describe Anvil Cloud Agents as unavailable in this release, with no invented price,
      paid upgrade CTA, or unlimited-compute promise. The Anvil Cloud framework keeps its own name.

## Website and legacy billing

- [ ] Pricing, homepage/product copy, account pages, metadata, and docs state Sync and Mesh are free.
      Remove paid personal/team Sync offers and the Halloween cutoff promise.
- [ ] Download/sign-in/setup CTAs replace Sync checkout. Stale API calls cannot create a new session
      or change paid seats.
- [ ] Existing billing history and needed portal/cancellation paths remain truthful and usable.
      Production subscription cancellation/refunds are separately planned operator actions.
- [ ] Inventory existing Stripe subscriptions and open checkout sessions. Complete the approved
      billing cutover, including expiring open sessions and stopping legacy renewals, before claiming
      that no further Sync charges can occur. Retain signed webhook processing for late events;
      rejecting a completion webhook does not reverse a payment.
- [ ] No preview-end reminders or subscription-required support messages are scheduled for free access.

## Cost, reliability, and monitoring

- [ ] Record aggregate request/CPU/DO awake-time/row/storage/artifact/reconnect metrics without secrets
      or payloads. Reconcile a representative workload with the provider bill.
- [ ] Allocate an operating budget for free users while Anvil Cloud Agents are disabled. Configure
      account spend, retention, request/error-rate, and quota alerts with a named responder.
- [ ] Verify idle, streaming, reconnect, approval, cancellation, and handoff behavior after polling
      changes. Savings must not come from delaying security updates or accepted-job recovery.
- [ ] Machine-endpoint experiments remain behind their separate rollout flag until authentication,
      application encryption, idempotency, revocation, and fallback are proven.
- [ ] Obtain the managed-tunnel price/capacity/traffic terms before allocating hosted endpoints at
      scale. Do not count an unverified zero-dollar tunnel rate as launch funding.
