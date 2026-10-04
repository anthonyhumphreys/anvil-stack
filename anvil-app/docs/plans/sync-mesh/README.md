# Sync & Mesh feature overview and status

Branch: `feature/sync-mesh--foundations` · PR #91
Normative spec: [v2 spec](anvil-sync-mesh-spec-v2.md) · Companion spec: [cloud-connected companion](cloud-connected-companion.md) · Ops: [hosted sync runbooks](../../runbooks/hosted-sync/deploy.md)

Approved product boundary: [free Sync, free Mesh, and Anvil Cloud Agents](mesh-access-and-monetisation-plan.md).
The [host-local implementation plan](host-local-sync-mesh-implementation-plan.md) records the
integrated direction: host-served live operations, compact free Sync and durable hosted coordination.
The code and review fixes are integrated at source checkpoint `e50e2a9`. Local project checks pass.
The security review is sealed; its metadata discrepancy and remaining mobile native-buffering limit
are recorded in the implementation review. Physical WAN acceptance, real managed-tunnel allocation,
provider capacity/pricing and production rollout flags have not been verified. See the
[implementation review](host-local-implementation-review.md) for source areas and limits.

The [detailed FinOps projection](finops-projection.md) and [editable workbook](outputs/finops-2026-10/anvil-finops-projection.xlsx)
compare earlier cost baselines with the full host-local design, including ownership, trust refresh
and retained recovery data. The assumed USD 10,000 startup-credit balance expires on
18 September 2027. These are projections, not measured deployment costs.

## What the feature is

Anvil's hosted sync layer replaces the "master desktop" model with an **account-scoped peer mesh**:

- The account is the coordination and trust boundary. Desktops, phones, and Raycast enroll as peer devices. No single desktop controls the account; each running attempt has one fenced execution owner.
- A Cloudflare Workers + Durable Objects backend (`cloud/backend`) holds durable account decisions, jobs, presence and a bounded Sync journal. Verified encrypted R2 snapshots and archives retain recovery data.
- Devices sync **portable entities only**: workspace definitions, settings, workflow templates, editable agents, session ownership records. Chat transcripts and code are explicitly not synced entities.
- Direct encrypted host sessions prefer authorised private routes, including Tailscale and LAN. Operator-enabled managed HTTPS routes provide public reachability. Durable coordinator operations provide fallback; live host reads still require the host to be online.
- Sync and Mesh are free authenticated account features. Account lifecycle, device trust and fair-use rules remain enforced. Anvil Cloud Agents are a separate future paid execution service, disabled by default. Account-less and self-hosted modes remain available.

## What this branch contains

### Mesh execution and workspace replication (integrated in the working tree)

- Workspace adoption/materialisation: portable definitions sync; each device keeps a local replica and execution checkouts with journalled clone/link/removal and bootstrap approvals (WS-02/WS-03).
- Durable jobs and attempts with generation fencing, cancellation intents, and per-attempt isolated worktrees (MESH-*).
- Remote `prepare-workspace` and `start-session` job kinds: pinned manifests by content digest, control-channel approvals, provider sessions on remote hosts (SESSION-02).
- Workflow placement and fan-out: code-task jobs carrying per-repo commit pins, ordered result integration with visible conflicts.
- Durable events, approvals, artifact manifests, and socket observation (MESH-03); live/durable channel split — ephemeral frames never persisted.

### Host-local protocol and compact storage (integrated in the working tree)

- The RPC envelope remains `anvil-backend/1`, with required `sync/2` and `mesh/2` profiles. Hosted state is greenfield and uses the current client build.
- `anvil.machine.v1` adds encrypted host reads, commands and cursor subscriptions behind default-off `ANVIL_MESH_MACHINE_ENDPOINTS`. The operator must set the exact value `true` on a selected app or daemon process; the app does not turn it on automatically or prompt users to configure it. A host also needs an active signed-in Sync scope. Source account tokens stay on HTTPS broker endpoints. One-use admission tickets, host-local device policy and browser DSK grants authorize sessions.
- The host listener follows the signed-in Sync scope independently of the local-pairing companion toggle. Mesh execution still requires its separate worker opt-in. Account/device changes dispose the old host pool and listener sessions.
- One host connection per client scope serves shared reads and push invalidations. Remote-chat fallback is jittered 25–35 seconds. Approval waits use scoped push with bounded durable catch-up. Lease renewal remains 30 seconds and includes cancellation state.
- Complete scans include tombstones and catch-up watermarks. Snapshot publication verifies encrypted chunks through the normal reader before a generation-fenced commit. Previous verified recovery images and required journal tails remain available.
- Terminal inputs/results and bounded activity history use verified R2 archives. Detail expiry is explicit; minimal request/outcome records retain execution deduplication. These records are separate from workspace Sync.
- Managed allocations use a separate durable coordinator, generation fencing, loopback ingress, cleanup and operator-held provider credentials. `ANVIL_MESH_MANAGED_ENDPOINTS` remains off in the host and backend until provider capacity, pricing and physical connection checks are complete. The current connector does not install or update `cloudflared`, and does not verify its owner or parent-directory permissions.

### Session ownership and portability (integrated in the working tree)

- Cross-device handoff: `requested → target-prepared → source-quiescing → checkpointed → ownership-transferred → activating → completed`, with a durable ownership mirror in the account object.
- Desktop remote-chat controls and handoff activation are described in [remote chats](remote-chats.md).
- Provider continuity is explicit per adapter (`native-resume` / `checkpoint-import` / `summary-continuation`); a provider thread ID is not portability proof.
- Session ownership chip in the execution view; mesh session-view surface (jobs, approvals, activity, handoffs).

### Account, identity, and legacy billing

- BILL-01/02/03: WorkOS identity binding, enrollment-code + OIDC device enrollment, D1 persistence, legacy Stripe records/webhooks/reconciliation, account authorisation at authoritative handlers. New Sync checkout is disabled under the free product plan.
- BILL-04: `/account` website area — device table (list/rename/revoke), "Connect a device" code minting, billing surface.
- BILL-05: desktop free access status; resumable pauses remain for account/security/operator failures.
- IAC-01/02: deploy + rehearsal harness; live rehearsal passed on a clean account. The current staging/production deployment procedure is in the [deploy runbook](../../runbooks/hosted-sync/deploy.md).
- `device.list`/`rename`/`revoke`, `data.export`/`import`, `account.delete`/`deletionStatus` ops; hosted device + account-deletion service routes.

### Cloud agent environments and default-off Anvil Cloud Agents

- ENV-01 contract: provider-neutral environment lifecycle (`aws-lambda-microvm`, `cloudflare-sandbox`, `vercel-sandbox`, `anvil-managed`), `provision-environment` job kind, `{ kind:'environment' }` job targets that resolve on env enrollment, per-attempt sealed credential grants (`credential.deliver`/`credential.pull`).
- Ephemeral enrollments: class-bound codes with `environment_id` binding, restricted op allowlist pinned on first sight, own session quota + bounded lifetime.
- Provisioner plumbing: provider connections (encrypted at rest), `provision:<provider>` capability advertisement, `provision-environment` executor, `anvil-daemon enroll --pair` + `provider`/`env` commands, orphan/TTL reap sweep, per-attempt grant pull → env-var injection.
- Providers: AWS Lambda MicroVM (direct SDK), Cloudflare Sandbox (customer-deployed provisioner Worker — reference impl at `cloud/provisioner/`), Vercel Sandbox (`@vercel/sandbox`, non-persistent, `ANVIL_BOOTSTRAP_JSON` channel).
- ENV-09 `anvil-managed`: backend-internal claimer + consume-once `environment.bootstrap` pairing channel + `MANAGED_PROVISIONER` service binding + a separate default-off `ANVIL_CLOUD_AGENTS_ENABLED` flag. Existing user-funded providers remain available. No paid Cloud Agent offer is enabled by this PR.
- `anvil-worker` image: `cloud/images/anvil-worker/` — generic OCI Dockerfile + Cloudflare Sandbox variant + `boot.mjs` (env-scrubbing bootstrap → enroll → `anvil-daemon run --worker`).
- Settings provides provider connections and environment request, observation and teardown. Orchestration can select an environment as a job target. Spec: `cloud-environments.md`.
- Runbooks: deploy, rollback, reconciliation, webhook failures, entitlement incidents, account deletion, metrics, launch checklist.

### Cloud-connected companions

- Contract (`cloud/contract/companion.ts`): `device.advertise`, `device.presence`, `session.attest`; endpoint ordering Tailscale → LAN → loopback.
- Backend: expiring endpoint advertisements and authenticated discovery/admission. Source credentials authorize broker calls; opaque tickets authorize host bootstrap.
- Desktop: `companion_enrollment_policies` gate per-enrollment `observe`/`approve`/`steer` permissions. First contact requests host approval. Paired LAN/Raycast tokens keep their separate existing access path.
- Mobile: enrollment-code sign-in, SecureStore session, account discovery and encrypted host dialing. Account-mode hosts require the current machine protocol. A denied or unavailable host needs clear approval/retry guidance.
- Raycast: account-connected discovery and encrypted sessions; manual local token configuration remains available.

### Headless daemon — DAEMON-01 (integrated in the working tree)

- `src/daemon/`: plain-Node entrypoint bundling the host services with an `electron` stub (`app.getPath` → data dir, `safeStorage` → AES-256-GCM file store, UI surfaces inert).
- `anvil-daemon enroll --api-url --code` / `run` / `status` / `policy …` / `worker` / `companion` / `sign-out`.
- `defaultPolicyTier` config for zero-touch hosts; desktop still defaults first contact to `pending`.
- Service templates: `daemon/com.anvil.daemon.plist`, `daemon/anvil-daemon.service`; runbook: `docs/runbooks/hosted-sync/headless-daemon.md`.

## Earlier baseline validation (2 October 2026, before host-local follow-up)

- The desktop suite passed 1,797 tests with 12 skipped. All GitHub checks passed for `bf48b4c`, including desktop, backend/provisioner, cloud, website, Linux and Windows. Desktop lint, typechecks, and build passed. The [PR review](pr-91-review.md) records the exact checks and limits. This baseline predates the current host-local changes and is not evidence for this implementation.
- The current Cloudflare Worker and WorkOS clients are **staging**. The [launch checklist](../../runbooks/hosted-sync/launch-checklist.md) tracks production identity, billing, and operational gates.
- Real physical-device flows and signed-in hosted acceptance remain unverified; passing local suites is not a launch sign-off.

## Remaining verification and rollout gates

| Task | Why |
| --- | --- |
| Formal security review | All 247 changed files and 13 candidates reviewed; original findings and subsequent fixes recorded. Sealed coverage metadata retains superseded pending entries. Mobile native buffering and operational acceptance remain open. See the [implementation review](host-local-implementation-review.md). |
| Physical host acceptance | Use the current desktop and daemon build on at least two physical machines over separate WANs; test private-route use, host sleep, loss/reconnect, revocation, browser and phone behavior. See the [four-surface rehearsal](../../runbooks/hosted-sync/four-device-test-plan.md). |
| Managed reachability | Keep the feature off until an operator has verified a real tunnel allocation and cleanup, permitted traffic, hostname/DNS capacity, provider price and billing. See [host connections](../../runbooks/hosted-sync/host-connections.md). |
| Staged rollout | Keep `ANVIL_MESH_MACHINE_ENDPOINTS` and `ANVIL_MESH_MANAGED_ENDPOINTS` off in defaults and production until local, physical and commercial gates have evidence and an owner. See the [launch checklist](../../runbooks/hosted-sync/launch-checklist.md). |

## Known sharp edges

- Remote verification intentionally retains shell execution, source-policy
  checks and the chosen running mode capped by each destination's local maximum. The [security decision](verification-security-remediation.md)
  records the accepted capability and CodeQL alert #29 disposition.
- Backend revocation reaches direct connections within ~60s (attestation cache TTL); push invalidation is a Phase 5 candidate.
- Live host reads need the host awake, signed in with an active Sync scope and the machine endpoint flag explicitly set by the operator. That lifecycle is independent of the Mesh worker opt-in and the companion preference. The coordinator supplies discovery and current durable recovery/control operations where supported; it does not replace host-only reads.
- A new companion needs its host-local tier approved, then reconnects. Account mode uses the current machine protocol; account tokens are never probed against plain HTTP host addresses.
- Mobile OIDC and universal links are spec'd, unimplemented; enrollment codes are the v1 path.
