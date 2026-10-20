# Staging workflow and candidate builds

Start with [staging-next-steps.md](staging-next-steps.md) for the
current run. This page describes the workflow contract and the credentials it
needs. CI deployment is evidence for one backend SHA; it does not pass
signed-in or physical-device acceptance.

## Hosted backend workflow

`.github/workflows/sync-backend-staging.yml` deploys the existing staging
backend on matching pushes to `develop` and
`feature/sync-mesh--foundations`. The workflow checks backend and deployment
guards, builds the Cloud CLI, generates staging config from
`hosted-targets.ci.json`, reviews a plan, applies D1 migrations, deploys the
Worker, installs the protected runtime secrets, verifies their names on the
deployed Worker, and checks the public descriptor. Validating CI inputs alone
does not install Worker secrets. Both deployment paths install them explicitly.

The manual `workflow_dispatch` input `managed_endpoint_pilot` defaults to
`false`. Pushes and normal dispatches preserve the saved
`ANVIL_MESH_MANAGED_ENDPOINTS` setting in the staging vars. The manual input
can additionally enable it for one run. Both paths force
`ANVIL_CLOUD_AGENTS_ENABLED=false`. The workflow deploys the backend only. It
does not deploy the Anvil Cloud Agents provisioner, build or deploy a
container image, create a managed environment, or enroll a device.

The `anvil-staging` GitHub environment needs these secrets:

- `CLOUDFLARE_DEPLOY_API_TOKEN` for the existing staging Worker and D1
  migration. Scope it to the staging resources and operations the workflow
  uses.
- `HOSTED_SERVICE_KEYS`, `WORKOS_API_KEY`, and `WORKOS_WEBHOOK_SECRET` from
  the protected staging secret source.
- Variable `ANVIL_STAGING_WORKER_VARS_JSON` with validated non-secret Worker
  settings. It must set `HOSTED_CHECKOUT_ENABLED` to the string `false`.
  Never put secret values in this JSON.

For the current managed host rehearsal, save
`ANVIL_MESH_MANAGED_ENDPOINTS: "true"` and a valid `MACHINE_ENDPOINT_DOMAIN` in
`ANVIL_STAGING_WORKER_VARS_JSON`, and add protected secrets
`CLOUDFLARE_TUNNEL_ACCOUNT_ID`, `CLOUDFLARE_TUNNEL_ZONE_ID`, and
`CLOUDFLARE_TUNNEL_API_TOKEN`, scoped to the required tunnel operations in
that account and zone. Automatic deployments retain this setting. A
participating desktop or daemon has host sessions and the managed connector
available by default. Each host needs a trusted
`cloudflared` binary. See
[deploy.md](deploy.md) and [host connections](host-connections.md).

Keep the pilot off until its controlled domain, scoped Cloudflare token, and
trusted host connector are ready. The workflow's descriptor check requires
`anvil-backend/1`, `sync/2`, `mesh/2`, `workos-device`, and the staging public
client.

## Desktop candidates

Use `.github/workflows/app-candidate-preview.yml` to build unsigned macOS arm64
and Linux x64 candidates in one run. Select the candidate branch, provide the pull request number
and its full 40-character head SHA, and use the current SHA. The workflow
checks that the selected ref and current pull request both match the supplied
SHA before building. The preview pins the staging environment. Host sessions
and the managed connector are available by default in preview and ordinary builds.
Explicit runtime `false` remains an operator disable switch. Workspace Sync
and Mesh job execution still require their separate user opt-ins.

The run retains macOS DMG and ZIP files, Linux AppImage, `.deb` and `.pacman`
files, and a `preview-manifest.json` for each platform for 14 days. Each
manifest identifies the commit and hashes the installable files. These previews
do not sign, notarize, publish updates, or run live acceptance. Build the
website from the same candidate commit when it is part of the test.

## What CI proves

Record the full backend SHA from the workflow summary, the descriptor result,
and the desktop artifact SHA from `preview-manifest.json`. Keep the workflow
run URLs with the acceptance record. Do not treat successful CI, a Worker
upload, or an artifact build as a pass for account identity, workspace Sync,
Mesh approvals, reconnect, revocation, or WAN behavior. Run
[staging acceptance](staging-acceptance.md) with the exact candidate on
disposable staging data. Browser, mobile, and Raycast checks are separate
optional tests; use the current source SHA for each.
