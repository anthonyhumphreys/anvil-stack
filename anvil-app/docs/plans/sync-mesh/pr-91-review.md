# PR 91 review and environment split

Reviewed 25 September 2026 against `fc8286b33259f3285f36ac10ad01884b89d31280`.
PR: https://github.com/anthonyhumphreys/anvil-stack/pull/91

This is a targeted merge-readiness and deployment review, not an exhaustive
audit of all 829 changed files. GitHub reports 160,406 additions and 14,723
deletions. The PR description still describes about 170 files and omits later
hosted billing, browser workspace, and managed environment work.

The remote app, backend, cloud, website, Linux, and Windows checks passed.
The separate CodeQL policy check failed with one new critical alert. A green
CodeQL analysis job only means the scan completed, not that its policy passed.

## High priority

1. **Target-local verification consent implemented; CodeQL rerun pending.**
   Remote-authored commands still use their declared shell semantics, but each
   exact command now requires one-run native approval on the target device,
   showing its job/attempt or integration/run, repository and worktree. An
   unattended/headless worker declines immediately. A scrubbed environment and
   disposable worktree alone would not isolate the user's files or network.
   Recheck CodeQL alert 29 against this commit before merge.

2. **Bootstrap consent and checkout containment implemented.**
   Every executable recipe step, including argv and package managers, now
   requires target-local code consent in addition to its pinned recipe digest;
   backend-only approval leaves it parked. The runner resolves working
   directories under the checkout and checks real paths, including symlinks.
   The approval panel shows the commands and working directories.

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
   Secret writes fail closed when Electron secure storage is unavailable;
   legacy plaintext data is readable only after secure storage returns.
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

1. Rewrite the PR description around its actual scope and current test evidence.
   The feature status page and runbooks now point to current checks and a real
   staging acceptance document. Keep unverified launch claims explicit.
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
- Before paid launch: Stripe live credentials/webhooks, approved prices and
  business settings, and a named operational owner.

Platform references:
[WorkOS environments](https://workos.com/docs/authkit/environments) and
[Cloudflare environments](https://developers.cloudflare.com/workers/wrangler/environments/).
Cloudflare bindings and variables must be configured per environment; WorkOS
staging and production have separate environment configuration.
