# Sync and Mesh

The current product, architecture, and rollout boundary is in the
[decision record](decisions.md). The implementation plan contains technical detail. The
implementation review records security evidence and acceptance limits. Use the
[staging next-steps runbook](../../runbooks/hosted-sync/staging-next-steps.md) for operator work.

The host-local implementation was recorded at checkpoint `2ee256e`. Local project
checks were recorded at `e50e2a9`. Later staging-workflow preparation passed backend Vitest
with 42 files and 436 tests, plus 27 workflow-agent tests, typecheck, and self-check. Its generated
staging plan had all flags off and no provider calls or service bindings; that was before the
managed staging pilot was enabled. These are historical local-preparation results for those
revisions, not verification of the current source or deployment. Record current-candidate CI and
live acceptance separately.

Sync is opt-in per workspace, with Local as the default for new workspaces. Local use and
self-hosted deployments carry no Anvil subscription charge. The Anvil-hosted beta gates writes on a
paid entitlement or a redeemed beta code; checkout stays closed in staging, and production hosted
access is not yet available. Sync carries portable workspace definitions, repository references,
preferences, templates, agent definitions, and bootstrap instructions. It does not copy repository
contents, `.git`, dirty changes, or machine-local paths. The current serializer includes `remoteUrl`,
which may contain embedded credentials, so synced metadata is not guaranteed to be credential-free.
Workspace chat transcripts are not Sync entities; encrypted Mesh job/result archives may contain
prompts or chat output under their separate retention rules. Personal hosted use needs no
organisation; shared organisation fleets and workspaces are not included.

Mesh runs live work on an execution host. An encrypted WebSocket connects clients to that host over
an authorised private route or, during the approved staging rehearsal, a managed tunnel. The broker
handles identity, discovery, and connection bootstrap. The durable coordinator retains accepted-job
ownership, approvals, cancellation, handoff, and supported recovery decisions; it does not replace
host-only reads. Anvil application services do not relay encrypted machine-session frames. A
managed tunnel still proxies network traffic through its provider. Verified encrypted Sync
snapshots, a bounded change journal, and bounded Mesh archives support recovery. Anvil Cloud Agents
are separate paid execution containers and remain disabled by default. Container provisioning is
excluded from the Sync/Mesh staging workflow.

The RPC contract is `anvil-backend/1` with `sync/2` and `mesh/2`. The cutover targets current clients;
older-host compatibility is not required. This host-local design aims to keep idle per-host usage
near zero, but shared baseline, storage growth, and provider charges remain unmeasured.

## Supporting documents

- [Detailed implementation plan](host-local-sync-mesh-implementation-plan.md)
- [LAN first connectivity implementation plan](lan-first-connectivity.md) — implemented route
  selection, network refresh and safe session migration for desktop, daemon and native mobile;
  physical acceptance remains pending.
- [Implementation and security review](host-local-implementation-review.md)
- [PR 91 review history](pr-91-review.md)
- [Backend integration contract](anvil-backend-integration-contract.md)
- [Cloud environment implementation](cloud-environments.md)
- [Credential storage](credential-storage-fallback.md) and
  [device trust](automatic-device-trust.md)
- [Remote chats](remote-chats.md) and
  [execution permission decision](verification-security-remediation.md)

Managed staging transport results are recorded in the
[transport evidence](../../runbooks/hosted-sync/staging-transport-evidence.md).
Physical multi-host acceptance, signed-in staging acceptance, provider capacity and pricing,
and actual billed usage remain open. The immutable security
review also records a coverage-metadata discrepancy and a mobile native receive-buffering limit.
See the [review](host-local-implementation-review.md) and
[operator next steps](../../runbooks/hosted-sync/staging-next-steps.md) before rollout.
