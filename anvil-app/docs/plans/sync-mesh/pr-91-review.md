# PR 91 review and environment split

Reviewed 25 September 2026 against `fc8286b33259f3285f36ac10ad01884b89d31280`.
PR: https://github.com/anthonyhumphreys/anvil-stack/pull/91

This is historical review evidence for earlier PR revisions. The current product and rollout
boundary is in the [decision record](decisions.md). The read-only staging observations below do not
establish end-to-end acceptance for the current candidate. No signed-in staging acceptance for the
current candidate is recorded; use the [staging next-steps runbook](../../runbooks/hosted-sync/staging-next-steps.md).

## 3 October connected browser workspace update

The web workspace now selects an account-owned machine by name. Desktop
approves the exact workspace, repositories and capabilities. An optional
remembered browser connection lasts up to 30 days; short sessions renew using
a proof key bound to the account, browser origin, selected machine and original
approval. Disconnect cascades through renewed sessions and browser terminals.
Desktop enforces expiry locally while offline and interrupts only attributable
browser work. Account and machine switches invalidate stale responses and
isolate drafts.

The web chat reuses Desktop's composer, message framing, thread rows, empty
state and default theme. Provider, model and permission controls use the
connected machine's configuration and local maximum. Browser-to-cloud work
is deferred. The installed Anvil application is a standard build from main;
it was not used to verify these changes.

Local checks passed 1,928 Desktop tests with 12 skipped, 451 backend tests,
both Desktop TypeScript projects, Desktop and website lint, Electron and
daemon builds, website production builds, 16 website environment/crypto/store
tests and validation of 100 documentation pages. Physical-device login,
remembered-browser renewal, expiry/revocation and provider interaction remain
manual acceptance in [ANV-11](https://linear.app/anvil-stack/issue/ANV-11/run-hosted-sync-staging-acceptance-for-pr-91).
The browser acceptance cases are documented in
`anvil-website/content/docs/sync/browser-workspace.md`.

The following review records the earlier foundation changes and observations.

This is a targeted merge-readiness and deployment review, not an exhaustive
audit of all 829 changed files. GitHub reports 160,406 additions and 14,723
deletions. The PR description still describes about 170 files and omits later
hosted billing, browser workspace, and managed environment work.

The remote app, backend, cloud, website, Linux, and Windows checks passed.
The separate CodeQL policy check failed with one new critical alert. A green
CodeQL analysis job only means the scan completed, not that its policy passed.

## High priority

1. **Node-capped execution modes implemented; shell capability retained.**
   Anth's 2 October decision replaces mandatory native consent with the chosen
   running mode constrained by each target's local maximum. Full access runs
   unattended; approval mode accepts exact-action decisions through Mesh;
   workspace and read-only modes use the OS sandbox. Existing nodes default to
   approval mode. Source policy, revocation and account isolation remain.
   The [security decision](verification-security-remediation.md) supersedes both
   native-per-command consent and fixed profiles. CodeQL #29 retains its
   specific `won't fix` disposition for intended authorized command execution.

2. **Remote bootstrap approval repaired; checkout containment retained.**
   Ordinary argv and shell recipes now follow the effective running mode.
   A remote approval can authorize that exact attempt when the target's mode
   allows it. Job content pins exclude the submitting node's local ceiling;
   local authorization additionally binds the target policy and attempt.
   Working directories remain contained, including real-path/symlink checks.

3. **Backend-bound sessions implemented.**
   Sync, refresh, diagnostics, artifact access, and sign-out revocation require
   the session's exact backend ID. Unbound legacy sessions require sign-in
   again; they are not silently attached to staging or production.

4. **Attestation account check implemented.**
   `session.attest` now returns `unauthenticated` for a foreign account token
   and only the expected claims for a same-account token. Two-account
   regression coverage passes; live staging authentication is still untested.

5. **Placement and sync consistency blockers implemented.**
   A null-target auto claim now rechecks capability and workspace readiness;
   unresolved environment jobs cannot be claimed early. Open conflicts fence
   pull apply and refresh their remote tip as later changes arrive. Reset
   rejects uncertain dispatched rows and reconciles preexisting conflicts when
   a scan shows convergence. The original review described possible local
   data loss; the confirmed failure was stale replay and conflict resolution.

6. **Complete the production identity and deployment setup before launch.**
   Current resources and WorkOS clients are staging. Production needs separate
   WorkOS identities, Worker and Durable Object namespaces, D1, R2, provisioner,
   signing keys, session cookie password, and billing configuration. Do not
   copy staging users, tokens, object data, or the staging deployment ID.
   Repository guardrails cannot prove that dashboard settings are correct.

## Medium priority

1. **Hosted deletion bookkeeping implemented.**
   The delete response and retryable status probe now advance billing lifecycle
   to `deleted` when the coordinator reports completed purge. Focused tests
   cover deletion and idempotency; a live cross-restart test remains in staging
   acceptance.

2. **Run signed-in staging acceptance against the current release candidate.**
   Verify website and desktop resolve to one account, device pairing/revocation,
   browser approval and reconnection, two physical devices, managed job execution
   and verified teardown, and deletion. The checked-in market-readiness report
   explicitly leaves hosted identity/billing, authenticated dashboard, physical
   devices, and real-provider jobs unverified. Existing local and IAC evidence
   does not close those gates. Record the deployed commit and result.

3. **Runbooks prepared; rehearsal and owner remain open.**
   The rollback, D1 restore drill, alert thresholds, and Stripe test-mode
   scenarios now have executable runbooks. Backup/restore and schema-compatible
   rollback must still be exercised, alerts routed to a named owner, and test
   billing events recorded before enabling checkout. The launch checklist
   remains unchecked; live prices and business settings need approval.

4. **Additional security hardening implemented.**
   OS credential storage remains the default. An explicit [encrypted vault
   fallback](credential-storage-fallback.md) now supports session passphrases
   and protected key files for unattended macOS/Linux use. Locked values remain
   configured, unreadable credentials are retained and readable integration
   keys migrate transactionally. Sync refresh preserves unavailable sessions.
   Mobile companion event streams use short-lived single-use tickets instead
   of bearer query parameters, invalidate attestation/tickets on sign-out and
   revocation, restrict CORS, and hide health data from LAN peers. Backend
   trailing-slash normalization is linear. No physical LAN test has run.

5. **Cloud recipe guards implemented.**
   Opted-in enrollment admin secrets are required and installed via stdin
   after apply; removal needs a live evidence artifact matching its target and
   generated config. The broad cloud CLI suite passes locally.

6. **Complete the CI environment configuration.**
   This change selects production for macOS releases and Linux/Windows tag
   releases, and staging for candidate/PR builds. GitHub environments
   `anvil-staging` and `anvil-production` have been created; production accepts
   only branch `main` and tags `app-v*`. The staging URL is configured.
   Set the production endpoint after provisioning and decide who approves
   production deployments. A Vercel production deployment slot or Node's
   `NODE_ENV=production` does not itself select the Anvil production service.

## Low priority

1. Refresh the PR description around its actual scope and current test evidence.
   The current staging workflow still needs signed-in acceptance. Use the
   [staging next-steps runbook](../../runbooks/hosted-sync/staging-next-steps.md)
   and keep unverified launch claims explicit.
2. Split the 11,153-line account coordinator along its existing RPC domains in
   follow-up PRs with contract tests. Avoid mixing that restructuring into the
   environment split.
3. Retire or clearly label stale spike templates and manual deployment examples
   once the guarded deployment path is adopted. Avoid renaming live staging
   storage merely to make the names prettier.

## Live staging observations

Read-only checks on 25 September confirmed:

- Cloudflare account `715060911f9418f1df0f9de0265d8a64` is accessible through
  the local Wrangler OAuth login. The Cloudflare connector is logged into a
  different account and cannot access this backend.
- Worker `anvil-sync-hosted-staging` responds at
  `https://anvil-sync-hosted-staging.still-glitter-7d20.workers.dev`.
- Discovery reports `Anvil hosted staging`, deployment ID
  `spike-0000-0000-0000-backend01demo`, and device client
  `client_01M2XPX4PF98H2P7HCNRBZATTE`.
- The local generated config identifies website client
  `client_01M27GDYFBX70F16V6ZQ74KSDE`, bucket
  `anvil-sync-hosted-staging-artifacts`, and database
  `anvil-sync-hosted-staging-billing`. These storage bindings were read from
  local configuration, not independently inspected in the live Worker.
- The latest listed deployment was 22 September. Secret names present are
  `HOSTED_SERVICE_KEYS` and `MANAGED_PROVISIONER_TOKEN`. Secret values were not
  retrieved. No Stripe secret names were present.

No Cloudflare production resources were provisioned and no existing backend
deployment was changed. The GitHub environment configuration above is the only
shared-system change made during this task.

## Implementation and verification

The accompanying changes add explicit environment selection to desktop builds
and website authentication/service credentials. Production cannot fall back to
staging settings. Desktop sessions now require an exact backend binding before
credentials are used, including refresh, diagnostics, artifact access, and
sign-out revocation. Unbound legacy sessions require sign-in again.

Hosted deployment uses the manifest and guarded CLI wrapper documented in
[the deployment runbook](../../runbooks/hosted-sync/deploy.md). The current
staging identities are preserved, and the production entry stays incomplete
until the operator supplies its own infrastructure and WorkOS configuration.
The website also validates its selected configuration before AuthKit loads.

Checks performed during this task:

- Full desktop suite after these fixes: 1,676 passed, 11 skipped. The skipped integration tests
  do not count as live or physical-device acceptance.
- Desktop lint, both actual TypeScript projects, and the normal Electron build
  passed. The focused runtime suite passed again after correcting two type
  narrowing errors found by the TypeScript check.
- Desktop staging/production bundle checks confirmed that each build contains
  only its selected endpoint; invalid deployment selection failed the build.
- Backend runtime suite: 360 passed; backend typecheck passed. Guarded deploy
  Node tests: 7 passed. Cloud CLI suite: 72 passed.
- Website environment regression suite: 10 passed; typecheck passed. Staging
  and synthetic production builds passed. The production build also had the
  existing local staging settings present. This is configuration evidence,
  not a real production WorkOS login.
- Website lint had no errors and one existing dynamic-image warning.
- The current Cloud CLI and its dependencies built successfully. The guarded
  staging plan ran through that CLI with no diagnostics and only wrote local
  generated files. The incomplete production target was rejected.
- Hosted deployment guard tests passed, and both the validator self-check and
  generated staging config validation passed. The latter warns that a generated
  config cannot prove secret installation. Secret names were checked separately
  as recorded above; their values were not read from Cloudflare.
- All six changed GitHub workflow YAML files parsed, and `git diff --check`
  passed. The changed workflows have not run on GitHub yet.

## Decisions and setup Anth needs to supply

- Production website and backend hostnames, and the Cloudflare account to own
  production. The existing account can hold separate resources; a separate
  account also isolates account-level permissions and administration.
- Separate production WorkOS website/device client IDs, approved redirects and
  origins, and the production API key installed through the secret manager.
  The issuer hostname alone does not distinguish WorkOS environments.
- Production website secret configuration and backend signing/provisioner keys.
  Generate new values rather than copying staging secrets.
- `ANVIL_PRODUCTION_HOSTED_BACKEND_URL` in GitHub's `anvil-production`
  environment, once that endpoint is deployed and verified. Without it,
  release builds keep hosted access unavailable.
- Anvil Cloud Agents remain disabled by default. Before any paid hosted-execution
  launch, decide provider capacity, metering, pricing, billing, and a named
  operational owner. This review does not enable that service.

Platform references:
[WorkOS environments](https://workos.com/docs/authkit/environments) and
[Cloudflare environments](https://developers.cloudflare.com/workers/wrangler/environments/).
Cloudflare bindings and variables must be configured per environment; WorkOS
staging and production have separate environment configuration.


## Remote follow-up on 3 October 2026

The reviewed handoff, fresh-worker and remote-chat wiring gaps are implemented.
Remote chats expose Desktop's six provider choices on enrolled desktops/BYO
workers. Managed cloud launch supports Codex, with destination account sign-in
as the default and an optional explicit API-key grant. There is no standalone
Claude provider.

Handoff prepares the target before quiescing the source, carries the checkpoint
inside the encrypted task inputs, and recovers submission/adoption after
reconnect or restart. A failed destination activation can explicitly retry a
fresh turn while retaining destination edits and ownership. Fresh cloud workers
receive the selected portable definition through the task content key, without
an account-wide sync key.

Verification passed 1,840 desktop tests with 12 skipped, 438 backend tests,
desktop/backend TypeScript, desktop ESLint, Electron/daemon builds and both
worker image builds. Container smoke checks passed vault restart/missing-key
behavior, the Codex runtime pin and authentication protocol configuration.
Live provider execution and signed-in/physical-device acceptance remain pending.
See [remote chats](remote-chats.md) for the auth decision, interaction limits and
the remaining acceptance scope.

### 3 October correction: launch-host Codex auth

The earlier device-code default diverged from the agreed launch-host `auth.json`
strategy. Managed cloud chats and handoff now default to an encrypted copy of
that account cache. A protected session-scoped worker home retains refreshes and
native continuation files. Device-code login is an explicit fallback and API
keys remain separately billed. Missing host credentials fail before launching
work or stopping the handoff source. The source cache is never overwritten.
Live cloud auth/refresh/teardown acceptance remains pending.

Local verification for the correction passed 1,859 desktop tests with 12 skipped,
440 backend tests, both desktop TypeScript projects, backend TypeScript,
desktop ESLint, and Electron/daemon builds. Both final worker images built;
offline synthetic-cache checks verified the pinned CLI reads account auth with
and without the optional account ID. No real credentials or inference were used.
Headless fallback tests include consent, login completion, account verification,
ambient API-key stripping and explicit handoff selection.

### Cloud provider connection settings, 3 October 2026

Cloud launch now uses the chosen Desktop provider after a per-provider opt-in
in Cloud agent settings. Cursor connects through the official SDK browser flow
and stores the resulting expiring user API key encrypted. Devin connects once by
importing the host CLI login or starting its browser login, with manual-token
instructions when the CLI requires them. OpenAI, Azure and LLMGateway use saved
API settings. Encrypted attempt grants support the provider identity and bounded
Devin cache; credentials never enter public job inputs or chat records. Worker
images install pinned Cursor and Devin CLIs alongside Codex. Codex host-cache and
explicit headless fallback flows remain intact. Live provider login, usage and
cloud execution acceptance remain required in ANV-11.

Verification passed 1,892 desktop tests with 12 skipped, 440 backend tests,
both desktop TypeScript projects, backend TypeScript, ESLint and Electron/daemon
builds. Both final worker images built and passed offline vault, Codex host-cache
and headless/API auth checks, plus Cursor and Devin version/ACP checks from fresh
homes. The Cursor SDK connection is mocked in regression tests; no real login
or cloud inference ran. Provider setup and live execution remain acceptance gates.
