# Mesh verification execution security decision

Accepted by Anth on 2 October 2026. This decision supersedes the earlier
proposal to replace remote verification commands with target-local profiles.

## Decision

Retain arbitrary verification commands and their declared shell semantics.
Executing user-authorized commands across devices is a core Anvil capability;
a fixed profile-only contract would remove useful workflows. No profile
migration or shell-command blacklist is planned.

[CodeQL alert #29](https://github.com/anthonyhumphreys/anvil-stack/security/code-scanning/29)
correctly identifies remote input reaching `sh -c`. The accepted behavior is
command execution from an authorized source with separate target-local consent.
The finding does not by itself establish an authorization or approval bypass.
Dispose of this specific alert as `won't fix`, with the authorization evidence
and this decision recorded. Do not disable CodeQL or its command-injection rule.
Removing the shell capability is not a merge requirement.

## Boundaries retained

- The public Worker authenticates the session and forwards its verified account
  and enrollment identity. Caller-supplied identity headers cannot select a
  different account. The development spike bearer is unavailable unless the
  explicit development switch is enabled.
- A target worker must opt into execution. Its source policy is checked at
  placement and again at claim; explicit targets must be eligible within the
  authenticated account. Revoked sessions cannot continue making requests.
- Execution permission and cryptographic device trust are separate. An explicit
  device allowlist is narrower than the optional `same-account` source policy;
  the latter authorizes account sources and must not be described as checking
  each peer's locally verified cryptographic identity.
- Both remote code-task verification and result integration use
  `runVerificationCommand`. Every exact command requires one-run native consent
  bound to the repository, worktree and job/attempt or integration/run.
  Declined, headless, hidden, minimized and expired approvals do not execute.
- Keep the restricted process environment, execution timeout, bounded output
  and result/journal evidence. These reduce exposure; they do not sandbox the
  process or isolate the user's files and network.

## Accepted risk and reopening criteria

An approved command runs with the user's operating-system permissions. Trust
authenticates and authorizes its source; it does not make every command safe.
Compromised authorized clients, stolen credentials or malicious agent/repository
input can produce a harmful request without physical access to the machine.
The source policy and target-local consent remain required controls.

Reopen this alert or create a specific security finding if an unauthorized,
cross-account or revoked source can cause execution, if approval can be bypassed
or rebound to different command/target data, or if a new execution path omits
these controls. Broadening unattended execution requires a separate decision.

## Verification evidence

Checked the working tree based on `f9e06f1`, with regression tests added in this
decision change. No runtime behavior changed.

- Desktop worktree, worker and integration suites: 57 tests passed. Coverage
  includes successful shell execution, nonzero exits, timeout, exact-command
  consent details, declined/headless requests, hidden/minimized windows and
  approval arriving after the 30-second deadline. The suites ran using the
  installed Electron runtime in Node mode to match the native SQLite ABI.
- Backend auth, jobs, workers, security enrollment and task-key/dashboard
  suites: 85 tests passed. Coverage includes explicit source-policy refusal,
  claim-time source checks, cross-account target/get/claim refusal, expired and
  revoked credentials, verified-account routing, task-key recipients and grant
  revocation. Placement/lifecycle fixtures use the development test bearer;
  the auth suite separately exercises issued device credentials.
- The existing full backend suite passed 434 tests before adding the two job
  regressions. Focused results above cover the final test changes.
- Desktop Node and renderer typechecks, targeted desktop test lint and backend
  typecheck passed after correcting the new window mock's inferred return types.

This is targeted boundary verification, not an exhaustive security audit or
live physical-device acceptance. The existing worker's task-completion result
and integration's verification-success result have different meanings; changing
that reporting contract is outside this alert decision.
