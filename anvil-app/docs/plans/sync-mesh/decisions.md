# Sync and Mesh decisions

Current product, architecture, and rollout decisions, 6 October 2026. This record governs the
feature. The [implementation plan](host-local-sync-mesh-implementation-plan.md) holds technical
detail; the [implementation review](host-local-implementation-review.md) holds audit evidence and
acceptance limits.

## Product boundary

- Sync and Mesh are free. Sync is optional per workspace, and Local is the default for a new
  workspace. Users choose when to sync portable workspace definitions, repository references,
  preferences, templates, agent definitions, and bootstrap instructions.
- Workspace Sync does not copy repository contents, `.git`, dirty changes, or machine-local paths.
  The current workspace serializer includes `remoteUrl`, which may contain embedded credentials;
  do not promise that every synced metadata field is credential-free. Workspace chat transcripts
  are not Sync entities, though encrypted Mesh job/result archives may contain prompts or chat
  output under their separate retention rules.
- A personal account is enough for hosted Sync and Mesh. An organisation is not required. Existing
  organisation membership, roles, and invitations remain account management; shared organisation
  workspaces and fleets are outside this feature.
- Users run Mesh work on their own machines or through providers they configure and pay. Anvil
  Cloud Agents, meaning Anvil-supplied execution containers, are a separate paid service and stay
  disabled by default. Container provisioning is not part of the free Sync/Mesh staging workflow.
- Managed public reachability is included in the controlled staging rehearsal, approved on
  5 October 2026. From 6 October, host sessions and managed connectors are available by default
  in desktop and daemon builds. Explicit runtime `false` remains an operator disable switch.
  Availability does not enable workspace Sync or Mesh job execution without user opt-in.
  Automatic backend deployments preserve the saved staging provisioning setting; production
  provisioning remains off. This is not general availability and does not make Sync or Mesh
  billable. A separate
  private network is not a prerequisite for physical testing through managed tunnels.

## Architecture boundary

- The current backend contract is `anvil-backend/1` with required `sync/2` and `mesh/2` profiles.
  This is a greenfield cutover for current clients. Older-host compatibility and legacy hosted-state
  migration are not launch requirements.
- The execution host owns live work. Clients use an encrypted WebSocket directly over an authorised
  private route where possible, or an operator-enabled managed tunnel during an approved pilot. The
  hosted broker handles identity, discovery, and connection bootstrap. The durable coordinator
  retains accepted-job ownership, approvals, cancellation, handoff, and supported recovery
  decisions; it does not replace host-only reads. Anvil application services do not relay encrypted
  machine-session frames. A managed tunnel still proxies network traffic through its provider.
- Hosted durability is limited to what coordination and recovery require. R2 holds verified,
  encrypted current and previous Sync snapshots. Sync changes, tombstones, and push receipts have a
  90-day retention. Mesh artifacts default to seven days, with a 30-day maximum; durable event
  history has a 90-day retention, while minimal deduplication records may outlive payload detail.
  Required recovery data is not removed before a verified replacement is available. Ephemeral live
  frames are not persisted.
- The design aims for near-zero idle metering for an unused host. That is not a zero-cost hosting
  claim. Shared service baseline, storage growth, managed-route charges, and provider billing remain
  unknown until measured against real usage and invoices.

## Rollout and cost limits

- The host-local implementation was recorded at checkpoint `2ee256e`. Local project checks at
  `e50e2a9` and subsequent staging-workflow preparation are historical evidence for those revisions,
  not checks of later staging/client changes. That earlier preparation passed backend Vitest across
  42 files and 436 tests, plus 27 workflow-agent tests, typecheck, and self-check. Its generated CI
  staging plan had no provider calls or service bindings and all flags off; it predates the enabled
  managed staging pilot. Record current-candidate CI and live acceptance separately.
- Managed staging transport results are recorded in the
  [transport evidence](../../runbooks/hosted-sync/staging-transport-evidence.md).
  Signed-in and physical-device acceptance remain open. Follow the
  [staging next-steps runbook](../../runbooks/hosted-sync/staging-next-steps.md).
  Provider capacity and pricing, production billing, and measured storage growth
  remain public-rollout gates.
- The immutable security review retains its coverage-metadata discrepancy and the mobile native
  WebSocket receive-buffering limit. Both remain visible in the
  [implementation review](host-local-implementation-review.md); neither clears public rollout.
- The FinOps model assumes USD 10,000 in Cloudflare startup credit expiring on 18 September 2027.
  The account balance, eligible charges, invoice treatment, and remaining storage/provider costs
  have not been verified. Forecasts are planning inputs, not measured bills.
