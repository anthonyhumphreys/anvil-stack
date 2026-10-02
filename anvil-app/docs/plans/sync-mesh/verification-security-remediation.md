# Mesh verification security remediation

Status: proposed on 2 October 2026. No security implementation change is included
in this proposal. [CodeQL alert #29](https://github.com/anthonyhumphreys/anvil-stack/security/code-scanning/29)
must remain a merge blocker until the replacement is implemented and verified.

## Finding and current controls

`mesh-worktree.service.ts:runVerificationCommand` executes remote-authored text
through `execFileAsync('sh', ['-c', input.command])`. Both remote code-task jobs
in `mesh-worker.service.ts` and result integration in
`mesh-integration.service.ts` reach this helper.

The target device already requires native approval for the exact command,
repository and job/integration. Headless, hidden, minimized and expired approval
requests fail closed. The process receives a restricted environment and bounded
execution/output. These controls reduce unattended execution, but approved text
still becomes arbitrary shell code with the user's operating-system permissions.
The inline CodeQL suppression does not change that behavior.

[CodeQL's guidance](https://codeql.github.com/codeql-query-help/javascript/js-command-line-injection/)
recommends execution without a shell and separate arguments. Here, allowing the
remote caller to choose an executable and arguments would still permit
`sh -c`, `node -e`, or a package runner executing remote-selected code. The
replacement must also restrict who defines the action.

## Recommended contract

Remote requests carry bounded verification profile IDs. Profiles are defined
and approved on the executing device, outside synced entities and repository
worktrees. A remote request cannot create or modify a profile, or override its
executable, arguments, environment, working directory or timeout.

Start with a small explicit set of local profiles rather than a general shell
editor. Each profile fixes an absolute executable, argument array, repository
binding, worktree working-directory policy and bounded timeout. The main process
resolves and snapshots the profile before prompting, then executes that same
snapshot with `shell: false`. Resolve tool paths from trusted local configuration;
do not discover executables from the remote-controlled worktree or its PATH.

Keep per-run native consent, restricted environment, timeout, bounded log tail,
and journal evidence. Consent displays the resolved action and exact target.
Running repository test scripts still executes repository code and requires
approval; profiles do not make worktrees a process or network sandbox.

## Implementation and compatibility

1. Define a typed profile-reference contract and target-local resolver. Validate
   IDs and request size at runtime, including persisted and sealed job inputs.
   Reject unknown profiles, extra execution fields and legacy freeform commands
   explicitly. Never filter malformed entries into an empty successful run.
2. Update workflow nodes, shared IPC types, preload, workflow services, dispatch
   builders, worker execution and integration together. Both callers must use
   the same resolver and consent gate.
3. Replace the shell sink and remove its suppression. Record profile identity,
   the resolved display action, approval/refusal reason, exit status, timeout and
   bounded output in results and journals. Make failed, declined or invalid
   verification visibly prevent a verified-success outcome. The worker currently
   returns `ok: true` even after unsuccessful verification, while integration
   returns `failed`; preserve useful task results but make verification status
   explicit and gate downstream integration consistently.
4. Migrate existing templates and queued jobs. Existing tests and inputs include
   compound commands, redirection and shell builtins. Those require a new local
   profile or a visible compatibility refusal. If an exact legacy value maps to
   a fixed approved action, use an explicit mapping with no parser, shell fallback
   or interpretation of unknown strings.

Do not add shell-character blacklists, remote argv as executable authority, or a
new suppression to close the alert. A configurable profile UI can follow the
initial fixed-action implementation if real usage requires it.

## Verification and completion criteria

- At both worker and integration entry points, malicious command fields,
  executable/argument overrides, unknown IDs and legacy strings never spawn a
  process. Invalid verification cannot become an empty successful check set.
- Synced entity updates and repository writes cannot overwrite local profiles.
  Profile changes during approval cannot change the approved executable action.
- Declined, headless and expired approval requests never execute. A known local
  profile executes its fixed arguments in the intended pinned worktree.
- Nonzero exits, timeouts, output limits, environment filtering and refusal
  evidence remain covered. Repository scripts retain the explicit consent gate.
- Run focused worktree/worker/integration/workflow tests, desktop typechecks,
  lint, tests and build. Run CodeQL without the sink suppression and verify the
  original path is absent with no equivalent remote-controlled execution path.
- Close the alert and resolve the PR review thread only after that evidence is
  available. Native approval alone is not the remediation completion criterion.
