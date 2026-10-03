# Staging CI and desktop candidate

App CI runs on pull requests and pushes to `develop` and `main`. It checks the
actual desktop Node and renderer TypeScript projects, builds the daemon, and
runs desktop, backend, deployment-guard and managed-provisioner tests.

`Hosted Sync staging backend` runs when backend, provisioner, worker image,
desktop source or deployment CLI files change on `develop`. The feature branch is temporarily included for the PR #91
rehearsal; remove that trigger and its job allowance after the merge. Manual
dispatch is allowed for these same branches.

The workflow checks the backend and deployment guards, builds the Cloud CLI,
generates staging configuration from `hosted-targets.ci.json`, builds and stages
the daemon, deploys the managed provisioner and its container image through the
guarded CLI, installs the matching provisioner bearer, applies D1 migrations,
upgrades the backend Worker, and verifies discovery. Docker is available on the
Ubuntu runner. The workflow does not provision new storage.
Existing Worker secrets are preserved. The account, Worker, D1 ID, R2 bucket and
WorkOS clients remain the existing staging identities. Production remains
incomplete and cannot be selected by this workflow.

GitHub's `anvil-staging` environment needs:

- Secrets `HOSTED_SERVICE_KEYS`, `MANAGED_PROVISIONER_TOKEN`, `WORKOS_API_KEY`,
  and `WORKOS_WEBHOOK_SECRET`, installed from the staging secret source.
- A Cloudflare token named `CLOUDFLARE_DEPLOY_API_TOKEN`, inherited from the
  repository unless overridden here. It must have Worker deployment and D1
  migration access plus Containers image/deployment access. Scope permissions
  to staging resources wherever supported. A token scoped only to desktop
  updates may fail; grant the needed staging scope rather than changing the
  workflow to use a different account.
- Variable `ANVIL_STAGING_WORKER_VARS_JSON`, containing only validated non-secret
  Worker settings. Preserve provider settings and admission IDs there. Checkout
  must be explicitly disabled for this rehearsal workflow.

The live provisioner smoke check verifies rejection without authentication,
authenticated health, and Sandbox container startup via `listProcesses`. It
uses a fresh `ci-smoke-*` sandbox and requests destruction in a `finally` block,
including when startup fails. This confirms a successful SDK destroy response;
it does not independently inspect terminal container state or enroll a device.
Provider login, daemon enrollment, remote jobs and user interaction remain in
the desktop acceptance checklist. If a runner is forcibly interrupted before
cleanup, inspect Containers for its `ci-smoke-*` sandbox and terminate it.

To build the unsigned macOS arm64 candidate, select the feature branch in
`Anvil candidate macOS preview`, then provide PR `91` and its current full head
SHA. The workflow refuses a stale SHA. It retains DMG and ZIP files plus
`preview-manifest.json` with candidate identity and SHA-256 hashes for 14 days.
The preview has isolated application data and no update publishing or
notarization. This is separate from the production `app-v*` release path.

Record the desktop artifact, website deployment, backend version and migration
list in [ANV-11](https://linear.app/anvil-stack/issue/ANV-11/run-hosted-sync-staging-acceptance-for-pr-91).
CI and successful uploads do not prove signed-in or physical-device acceptance.
