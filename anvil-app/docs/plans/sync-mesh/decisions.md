# Sync and Mesh decisions

Current product, architecture, and rollout decisions, updated 27 October 2026. This record governs
the feature. The [implementation plan](host-local-sync-mesh-implementation-plan.md) holds technical
detail; the [implementation review](host-local-implementation-review.md) holds audit evidence and
acceptance limits.

## Product boundary

- Sync is optional per workspace, and Local is the default for a new workspace. Local use and
  self-hosted deployments carry no Anvil subscription charge. The Anvil-hosted beta gates writes on
  a paid entitlement or a redeemed beta code. Checkout stays closed in staging, and production
  hosted access is not available. Users choose when to sync portable workspace definitions,
  repository references, preferences, templates, agent definitions, and bootstrap instructions.
- Workspace Sync does not copy repository contents, `.git`, dirty changes, or machine-local paths.
  The current workspace serializer includes `remoteUrl`, which may contain embedded credentials;
  do not promise that every synced metadata field is credential-free. Workspace chat transcripts
  are not Sync entities, though encrypted Mesh job/result archives may contain prompts or chat
  output under their separate retention rules.
- A personal account is enough for hosted Sync and Mesh. An organisation is not required. Existing
  organisation membership, roles, and invitations remain account management; shared organisation
  workspaces and fleets are outside this feature.
- Users run Mesh work on their own machines or through providers they configure and pay. Hosted
  Mesh coordination uses the same entitlement as hosted Sync. Anvil Cloud Agents, meaning
  Anvil-supplied execution containers, are a separate paid service and stay disabled by default.
  Container provisioning is not part of the Sync/Mesh staging workflow.
- Managed public reachability is included in the controlled staging rehearsal, approved on
  5 October 2026. From 6 October, host sessions and managed connectors are available by default
  in desktop and daemon builds. Explicit runtime `false` remains an operator disable switch.
  Availability does not enable workspace Sync or Mesh job execution without user opt-in.
  Automatic backend deployments preserve the saved staging provisioning setting; production
  provisioning remains off. This is not general availability. The hosted backend still requires a
  paid entitlement or beta code for writes. A separate
  private network is not a prerequisite for physical testing through managed tunnels.

## Device setup and trust

- First-run onboarding offers Sync after agent setup, with a visible local-only
  choice. Hosted setup is one sign-in action; custom service controls are advanced.
  Authentication is followed by security setup and explicit device Sync consent.
- Check encrypted credential storage before authentication or an API-key save.
  A machine without a usable OS keyring gets inline passphrase-vault setup;
  a saved vault gets inline unlock. No Settings detour or plaintext fallback.
  Unlock resumes the existing backend-bound session without re-enrollment or
  account-key replacement. Invalid configuration requires restoration.
  Browser sign-in can be cancelled so the user can continue locally.
- From 7 October 2026, WorkOS sign-in and automatic own-account connection
  are the defaults for new hosted accounts. Keep mutual device verification
  as an optional stricter policy; preserve existing configured policies.
  Remove hosted human enrollment/pairing codes and the obsolete existing-install
  account-link flow. Self-hosted non-WorkOS codes and internal ephemeral
  environment bootstrap remain separate protocol uses.
  Initial setup creates a separately saved recovery code. A new automatic device
  waits for an online trusted device to deliver its account key, or uses recovery.
- Automatic admission requires an immutable authenticated X25519 enrollment
  binding and possession proof, exact identity matches, eligible durable account
  membership, current policy, and revocation checks. It deliberately trusts the
  identity provider and pinned service's membership attestation; account/provider
  compromise or a malicious service can admit a recipient in this mode. Manual
  code comparison retains the independent out-of-band check. See
  [device connection and encryption access](automatic-device-trust.md).
- Worker execution remains separate permission on each machine. Sync setup never
  grants it. Login codes, device-verification codes and recovery codes have
  different purposes and are labelled separately in the daemon.

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
- Desktop/daemon and native mobile prefer validated LAN-address candidates, then other private
  routes, explicit HTTPS and managed ingress. Reachability probes are bounded and carry no account
  credentials. A replacement session must authenticate and catch up before it takes ownership;
  requests already sent remain on their original connection and mutations are never replayed by
  transport migration. Hosts must advertise `machine.stream-handoff/1` for proactive upgrades.
  Route hints are preferences, not trust or physical-locality evidence: UI labels use `Direct`
  with host LAN-address detail. Network changes refresh discovery without rotating host identity.
  Admission and continuing authorization still require the backend; this is not offline Mesh.
  See the [LAN connectivity implementation record](lan-first-connectivity.md) for controls and
  pending physical acceptance. Existing managed connector lifecycle and execution grants remain
  independent of route selection.
- Hosted durability is limited to what coordination and recovery require. R2 holds verified,
  encrypted current and previous Sync snapshots. Sync changes, tombstones, and push receipts have a
  90-day retention. Mesh artifacts default to seven days, with a 30-day maximum; durable event
  history has a 90-day retention, while minimal deduplication records may outlive payload detail.
  Required recovery data is not removed before a verified replacement is available. Ephemeral live
  frames are not persisted.
- The design aims for near-zero idle metering for an unused host. That is not a zero-cost hosting
  claim. Shared service baseline, storage growth, managed-route charges, and provider billing remain
  unknown until measured against real usage and invoices.

## Rollout and operational acceptance

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
