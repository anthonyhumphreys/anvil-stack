# Hosted Sync and Mesh rollout checklist

Sync and Mesh are free. Only future Anvil Cloud Agents are planned as a paid
feature, and they stay disabled by default. This checklist records release
gates; it is not evidence that staging or production passed them and does not
authorize production resource changes.

## Candidate and deployment

- [ ] Record the full candidate SHA. Backend, desktop, daemon, website, and
      optional client builds used for acceptance identify that same source.
- [ ] The staging descriptor advertises `anvil-backend/1`, `sync/2`,
      `mesh/2`, and the current staging identity mode. Do not use an older
      client path as a fallback.
- [ ] The default staging workflow deploys the backend only. Cloud Agents,
      its provisioner, container image deployment, and managed endpoint
      tunnels are off unless their separate gates below apply.
- [ ] Staging data belongs to a new disposable test account and isolated
      test devices. No existing account or customer data was used.

Use [staging-next-steps.md](staging-next-steps.md) for the current
operator sequence and [deploy.md](deploy.md) for the deployment contract.

## Required staging acceptance

- [ ] A new workspace defaults to Local. The user explicitly opts into Sync.
- [ ] Sync carries only portable definitions, preferences, and bootstrap
      settings. Each machine has its own repository checkout or mapping;
      repository bytes, Git history, and dirty changes never move through
      workspace Sync.
- [ ] Two physical devices on separate WANs sign in to one disposable staging
      account and sync harmless changes in both directions.
- [ ] The default Mesh policy pauses a mutation for approval, displays the
      exact action, and prevents mutation on denial. An uncertain outcome
      stays attached to that request until checked or approved.
- [ ] Reconnect from a saved cursor does not duplicate a request or result.
- [ ] Revoking a device removes hosted access within 60 seconds while its
      local data remains available. Fresh authorization reconnects without
      duplicating work.

Record each item as `PASS`, `FAIL`, or `BLOCKED` in
[staging acceptance](staging-acceptance.md). A local test or upload result
does not pass a live gate. Missing a physical host or separate WAN is
`BLOCKED`.

## Optional host tunnel pilot

- [ ] Keep `ANVIL_MESH_MANAGED_ENDPOINTS` false by default in both backend and
      host processes.
- [ ] If running the explicit `managed_endpoint_pilot` workflow dispatch,
      provide the protected account, zone, and tunnel API token secrets; use
      an operator-controlled hostname domain and a trusted `cloudflared`
      installation on the host.
- [ ] Test allocation, readiness, route loss, revocation, teardown, and
      recovery on physical staging hosts. Keep the direct hosted path as the
      supported fallback.

Managed host tunnels provide host reachability. They are separate from the
Anvil Cloud Agents provisioner and do not enable Cloud Agents. See
[host connections](host-connections.md) for the operator requirements.

## Optional client checks and public rollout

- [ ] Record browser dashboard and Raycast results against the same candidate
      SHA if those clients are part of the release.
- [ ] Record controlled iPhone companion results against the same candidate
      SHA if mobile is included. Native WebSocket code may assemble an inbound
      frame before JavaScript receives it, so controlled testing does not clear
      the public mobile rollout gate. Keep public rollout blocked until the
      native receive path can enforce the required size limit before assembly.
- [ ] Complete the required security review and record its disposition.
- [ ] Keep endpoint flags off in default and production configurations until
      physical staging acceptance, security review, and the release owner
      approve the rollout.

## Anvil Cloud Agents

- [ ] `ANVIL_CLOUD_AGENTS_ENABLED` is absent or false in desktop, backend, and
      provisioner configuration. No staging Sync/Mesh workflow deploys the
      Cloud Agents provisioner or its container image.
- [ ] Users' own hosts and supported BYO provider execution remain available
      through their existing paths.
- [ ] Any future paid Cloud Agents launch has its own approved scope, access
      controls, and rollout record. This Sync/Mesh checklist does not authorize
      it.

## Operating cost and public availability

- [ ] Measure idle, active, reconnect and fallback traffic on the staging
      workload. Compare requests, CPU, Durable Object awake time, storage growth
      and cleanup with the FinOps assumptions and a real provider bill.
- [ ] Confirm managed-route capacity, permitted traffic, hostname limits and
      prices before offering managed reachability beyond the controlled pilot.
- [ ] Configure spend, error-rate, retention and quota alerts with a named
      responder. Confirm the remaining Cloudflare startup credit and eligible
      charges; the recorded expiry is 18 September 2027.
- [ ] Restore a fresh device from verified Sync state and confirm that a pending
      change, an opt-out and a deletion survive recovery without resurrecting
      old data. Keep enough verified state and journal tail for recovery.
- [ ] Production uses separate identity, resources and credentials. Public
      availability requires its own approved deployment and acceptance record.
