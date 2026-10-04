# Free Sync and Mesh launch checklist

Updated 4 October 2026. Sync and Mesh are free. Only future Anvil Cloud Agents
are planned as a paid feature, and they remain disabled by default. This is a
launch checklist, not a production launch record. Operators must attach real
environment evidence before deployment.

## Identity and protocol

- [ ] Staging and production use separate WorkOS environments, client IDs,
      Worker/D1/R2 resources, descriptors and service/operator keys. The
      website and desktop resolve to the same account within each target.
- [ ] The descriptor advertises `anvil-backend/1`, `sync/2` and `mesh/2`.
      Sync and Mesh clients require those profiles.
- [ ] AuthKit sign-in, callback origins, desktop enrollment, device revocation
      and re-pairing work against the selected target. Development credentials
      are absent from production.
- [ ] Selected-target preflight does not require a new Sync subscription price
      or Stripe availability. Existing billing records and migrations remain
      intact.
- [ ] Account lifecycle, local device trust, device limits and operator
      fair-use policies remain enforced independently of subscriptions.

Use [deploy.md](deploy.md) for generated config and staging/production
selection. Completing local tests does not authorize production resource
operations.

## Free product acceptance

- [ ] A personal account, without an organization or shared fleet, can sync
      configuration, enroll its machines, submit and complete Mesh jobs,
      approve, cancel and hand off work after the former preview deadline.
- [ ] Missing, canceled or unpaid legacy subscriptions and billing lookup
      failures do not pause free access.
- [ ] Workspace creation defaults to local and offers free Sync explicitly.
      Account sign-in and Sync enablement do not silently adopt local
      workspaces. Existing opted-in replicas retain their data.
- [ ] Opt-out stops future workspace replication without deleting local work.
      Re-enable has verified conflict and revision behavior. Task-scoped
      remote setup works without ongoing Sync.
- [ ] Device revocation and key rotation fail closed where required. Account
      deletion and operator restrictions still deny their respective
      operations.
- [ ] Scoped browser approval, reconnect and two-device execution are verified
      on real machines.
- [ ] Restore, export, import and rollback are rehearsed on a disposable
      staging account and database. Native runtime and generated headless
      worker builds match the candidate source.

## Host sessions and reachability

- [ ] `ANVIL_MESH_MACHINE_ENDPOINTS` is absent or not `true` in default and
      production configuration until a staged rollout is approved. Setting it
      is an operator action, not an automatic launch or user preference.
- [ ] With the flag explicitly set and an active Sync scope, host discovery
      and session startup work without requiring the Mesh worker opt-in or the
      legacy companion preference.
- [ ] Two physical devices on one disposable staging account connect over
      separate WANs. Test route loss, host sleep and resume, generation change,
      revocation and reconnect. Local tests and two profiles on one host do not
      count as WAN acceptance.
- [ ] The source account bearer goes only to the HTTPS broker. One-use
      admission tickets expire and reject replay; host policy, session proof,
      encrypted frames and revocation checks pass on the real route.
- [ ] The direct session path has a measured, supported fallback when the
      private route is unavailable. No feature claims reduced hosted traffic
      until the fallback rate and payload classes are measured.
- [ ] `ANVIL_MESH_MANAGED_ENDPOINTS` stays off in the host and backend by
      default. Before a managed pilot, verify target-specific domain and
      credentials, generation-fenced allocation and cleanup, loopback-only
      upstream, trusted connector executable handling, failure UX, and
      measured capacity and cost.
- [ ] Provider pricing, permitted traffic, account limits, DNS/hostname
      capacity and billing behavior for managed endpoints have an owner and
      current evidence. These commercial limits are not yet verified.

See [host connections](host-connections.md) for operator setup and protocol
details. No managed allocation or production flag change is implied by this
checklist.

## Anvil Cloud Agents

- [ ] `ANVIL_CLOUD_AGENTS_ENABLED` is absent or explicitly false in desktop,
      backend and provisioner candidate configuration. Creation and resume
      fail before allocating provider resources.
- [ ] Users' own fleets and BYO cloud providers retain their supported
      execution paths.
- [ ] Existing Anvil Cloud Agent status, suspension, cancellation and deletion
      remain available.
- [ ] Website and app describe Anvil Cloud Agents as unavailable in this
      release, with no invented price, paid upgrade CTA or unlimited-compute
      promise. The Anvil Cloud framework keeps its own name.

## Website and legacy billing

- [ ] Pricing, homepage and product copy, account pages, metadata and docs say
      Sync and Mesh are free. Remove paid personal/team Sync offers and the
      Halloween cutoff promise.
- [ ] Download, sign-in and setup calls replace Sync checkout. Stale API calls
      cannot create a new session or change paid seats.
- [ ] Existing billing history and needed portal/cancellation paths remain
      truthful and usable. Production subscription cancellation/refunds are
      separately planned operator actions.
- [ ] Inventory existing Stripe subscriptions and open checkout sessions.
      Complete the approved billing cutover, including expiring open sessions
      and stopping legacy renewals, before claiming that no further Sync
      charges can occur. Retain signed webhook processing for late events; a
      rejected completion webhook does not reverse a payment.
- [ ] No preview-end reminders or subscription-required support messages are
      scheduled for free access.

## Cost, reliability and monitoring

- [ ] Record aggregate request, CPU, Durable Object awake-time, row, storage,
      artifact and reconnect metrics without secrets or payloads. Reconcile a
      representative workload with the provider bill.
- [ ] Allocate an operating budget for free users while Anvil Cloud Agents
      remain disabled. Configure account spend, retention, request/error-rate
      and quota alerts with a named responder.
- [ ] Verify idle, streaming, reconnect, approval, cancellation and handoff
      behavior after polling changes. Savings must not come from delaying
      security updates or accepted-job recovery.
