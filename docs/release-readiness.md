# Release readiness

Use these checks for the exact candidate being released. Record the full source
SHA, client builds, deployed backend, environment, observations and evidence for
each check. Historical test counts and screenshots do not verify a later build.
Mark unavailable checks as `BLOCKED` with a reason.

The current implementation contracts are in [PATCH.md](../PATCH.md). Follow the
[identity cutover guide](mezair-identity-cutover.md) for domains, package scopes,
signing identities, hosted resources and profile compatibility.

## Desktop and delivery

- Verify a fresh macOS installation, isolated profile startup, restart recovery,
  native dialogs and the configured signing/notarisation path. Confirm the
  intended release tag and artifact identity. Automatic updates remain disabled.
- Exercise onboarding through the first usable repository and change. Check
  settings save/discard, keyboard navigation, workspace deletion, provider access
  limits, queued messages and per-turn usage with real provider sessions.
- Verify the native Windows titlebar in restored and maximized windows at the
  supported display scales, including menus and dragging, before Windows release.
- Follow [reviewed delivery](../mezair-app/docs/architecture/reviewed-delivery.md)
  with real Git state, Work Item/PR links and controlled external review feedback.
  Keep exact-diff review, unrelated changes, stale evidence, failed publication
  recovery and explicit application in the acceptance scope.
- Run the [chat acceptance checks](../mezair-app/docs/chat-roadmap-acceptance.md)
  and [delivery comparison protocol](../mezair-app/docs/dogfood/anv-7-delivery-comparison.md)
  before claiming live-provider acceptance or measured productivity improvements.
  Synthetic fixtures do not establish human effort, cost or output quality.

## Sync, Mesh and browser workspace

- Use the [rollout checklist](../mezair-app/docs/runbooks/hosted-sync/launch-checklist.md)
  and [staging acceptance runbook](../mezair-app/docs/runbooks/hosted-sync/staging-acceptance.md).
  Match Desktop, daemon, website, optional clients and the deployed backend to
  the selected candidate. Verify advertised capabilities for the features tested.
- Exercise hosted sign-in, entitlement or beta-code admission, recovery and
  revocation with a disposable account. Use two physical hosts on separate WANs
  for bidirectional Sync, approval/denial, interruption, reconnect and cleanup.
- Run the [browser workspace acceptance checks](../mezair-website/content/docs/sync/browser-workspace.md):
  exact repository/capability approval, matching verification codes, real provider
  work, remembered-session renewal, expiry, revocation and terminal closure.
  Check responsive layouts, draft preservation and uncertain command outcomes
  without mutation replay.
- Verify [LAN route selection and session migration](../mezair-app/docs/plans/sync-mesh/lan-first-connectivity.md)
  on physical desktop hosts and native iOS/Android builds, including local-network
  permission, route loss and application backgrounding.
- Public mobile rollout requires a bounded native receive path and physical-device
  resource-abuse acceptance. Keep the
  [receive-buffering limit and review coverage discrepancy](../mezair-app/docs/plans/sync-mesh/host-local-implementation-review.md)
  visible alongside the sealed review and its dispositions.
- Verify managed-route allocation, public ingress, revocation, DNS/tunnel cleanup
  and recovery. Confirm provider capacity and traffic terms, actual billed usage,
  retention, restore and operational alerts before broader managed availability.

## Cloud execution

- Keep Mesh provider environments separate from the
  [Mezair Cloud execution control plane](../mezair-cloud/docs/architecture/agent-execution-control-plane.md).
  An available adapter or configured connection does not establish live execution.
- Verify worker image compatibility, provider credentials or subscription login,
  private repository access, job execution, interruption and inspected teardown
  for each advertised provider path.
- Complete the control plane's credential brokering, hosted persistence and
  concurrency requirements and real-account conformance before production use.
- Run the live release checks for
  [portable application backends](../mezair-cloud/docs/architecture/application-backends.md),
  including recovery and provider delivery evidence.

Keep acceptance evidence attached to its tested revision. A source change,
successful upload or fake-provider test does not clear a live release gate.
