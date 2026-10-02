# Staging CI and desktop candidate

App CI runs on pull requests and pushes to `develop` and `main`. It checks the
actual desktop Node and renderer TypeScript projects, builds the daemon, and
runs desktop, backend, deployment-guard and managed-provisioner tests.

`Hosted Sync staging backend` runs when backend/contract/deployment CLI files
change on `develop`. The feature branch is temporarily included for the PR #91
rehearsal; remove that trigger and its job allowance after the merge. Manual
dispatch is allowed for these same branches.

The workflow checks the backend and deployment guards, builds the Cloud CLI,
generates staging configuration from `hosted-targets.ci.json`, validates a dry
run, applies D1 migrations, upgrades the existing Worker, and verifies discovery.
It does not provision new storage or deploy the managed provisioner image.
Existing Worker secrets are preserved. The account, Worker, D1 ID, R2 bucket and
WorkOS clients remain the existing staging identities. Production remains
incomplete and cannot be selected by this workflow.

GitHub's `anvil-staging` environment needs:

- Secrets `HOSTED_SERVICE_KEYS`, `MANAGED_PROVISIONER_TOKEN`, `WORKOS_API_KEY`,
  and `WORKOS_WEBHOOK_SECRET`, installed from the staging secret source.
- A Cloudflare token named `CLOUDFLARE_DEPLOY_API_TOKEN`, inherited from the
  repository unless overridden here. It must have Worker deployment and D1
  migration access to the staging account. A token scoped only to desktop
  updates may fail; grant the needed staging scope rather than changing the
  workflow to use a different account.
- Variable `ANVIL_STAGING_WORKER_VARS_JSON`, containing only validated non-secret
  Worker settings. Preserve provider settings and admission IDs there. Checkout
  must be explicitly disabled for this rehearsal workflow.

To build the unsigned macOS arm64 candidate, select the feature branch in
`Anvil candidate macOS preview`, then provide PR `91` and its current full head
SHA. The workflow refuses a stale SHA. It retains DMG and ZIP files plus
`preview-manifest.json` with candidate identity and SHA-256 hashes for 14 days.
The preview has isolated application data and no update publishing or
notarization. This is separate from the production `app-v*` release path.

Record the desktop artifact, website deployment, backend version and migration
list in [ANV-11](https://linear.app/anvil-stack/issue/ANV-11/run-hosted-sync-staging-acceptance-for-pr-91).
CI and successful uploads do not prove signed-in or physical-device acceptance.
