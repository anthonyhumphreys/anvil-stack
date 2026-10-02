# Mesh execution permission decision

Accepted by Anth on 2 October 2026. The node permission model supersedes both
fixed verification profiles and mandatory native approval for every command.

## Decision

Arbitrary shell commands are an intended Anvil capability. Jobs carry their
chosen running mode, and each target sets its own maximum mode locally. The
less permissive mode wins. Neither synced settings nor a source's request can
raise the target ceiling.

- Read only runs the provider and declared commands in a read-only sandbox.
- Ask for approval routes provider requests and bootstrap/verification approval
  through the authenticated Mesh approval channel. Another trusted device can
  approve an exact action; a visible window on the worker is unnecessary.
- Workspace automation runs unattended inside the workspace sandbox, with
  network access disabled. It cannot silently escalate outside that sandbox.
- Full access runs unattended with the target user's operating-system access.
  Both the requested mode and target ceiling must permit it.

Existing nodes default to approval mode. Enabling a worker does not raise its
ceiling. Changing the desktop's general running mode does not change that
ceiling either. Lowering a ceiling cancels active attempts, and subsequent jobs
use the new limit. Raising it never broadens an already started provider turn.

Desktop owners set the maximum in Settings > Sync & Mesh. Headless owners use
`anvil-daemon worker mode <mode>`. Remote workflow steps can override the current
running mode; otherwise submission pins the current mode into encrypted inputs.

Bootstrap transport pins cover the recipe and exact repository commits without
including a different device's local policy. Target authorization separately
pins its own policy, effective mode and job/attempt. Remote bootstrap approvals
apply to that attempt only. Approval details are encrypted under the task key,
bound to the attempt and action digest, and displayed by the approving client.

## Security boundaries

Keep authenticated account/enrollment identity, claim-time source policy,
revocation, task-key recipients, repository containment, restricted process
environments, timeouts, bounded output, cancellation and result evidence.
Execution authorization and cryptographic device trust remain separate controls.
The `same-account` source policy is account authorization, not a per-peer local
cryptographic verification check.

Full access intentionally allows an authorized source to run arbitrary code.
Compromised authorized clients, agent instructions or repositories can submit
harmful commands without physical access to a machine. Approval mode explicitly
authorizes each bootstrap recipe or verification command and provider escalation;
automatic sandbox modes enforce their boundary instead of relying on a prompt.

[CodeQL alert #29](https://github.com/anthonyhumphreys/anvil-stack/security/code-scanning/29)
identifies input reaching a shell. Keep its specific `won't fix` disposition for
intended authorized execution. Do not disable CodeQL or blacklist commands.
Reopen for an authentication/source-policy bypass, a target-ceiling bypass,
rebound approval, revoked source execution, or an unenforced sandbox claim.

## Verification

Regression coverage includes local persistence/migration, mode ceilings,
headless full-access verification, remote approval/refusal, ordinary and shell
bootstrap execution, encrypted approval details, provider approvals and active
attempt cancellation on downgrade. A live installed-Codex check exercises
workspace and read-only filesystem boundaries without a model turn.

Local verification on 2 October passed 1,776 desktop tests (12 skipped), desktop
lint and both TypeScript projects, desktop and daemon builds, 436 backend tests
and backend typecheck. The final handoff contract check passed 13 targeted
backend tests. A separate opt-in installed-Codex run passed 15 command/session
tests, including the live filesystem sandbox check. Daemon authorization
checks and maximum-mode persistence across separate CLI processes also passed.

Physical multi-device acceptance remains on the staging checklist. Unit and
sandbox checks do not replace it.
