# Hosted Sync staging deployment

Use the guarded staging workflow for the current free Sync and Mesh release.
It deploys the existing staging backend and applies D1 migrations. It does not
deploy the Anvil Cloud Agents provisioner or container image. Cloud Agents
remain disabled by default. Start with
[staging-next-steps.md](staging-next-steps.md) for the current
candidate and action sequence.

## Default staging deployment

The workflow is
[Hosted Sync staging backend](../../../../.github/workflows/sync-backend-staging.yml).
Pushes to `develop` and `feature/sync-mesh--foundations` deploy the backend
when one of its configured paths changes. A manual `workflow_dispatch` uses
`managed_endpoint_pilot: false` by default. Both paths preserve the saved
staging managed endpoint setting, set checkout off,
force `ANVIL_CLOUD_AGENTS_ENABLED` to false, review the guarded deployment
plan, migrate the existing staging D1 database, and apply the Worker.

The workflow uses the tracked `cloud/backend/hosted-targets.ci.json`, which
pins the existing staging Worker, D1 id, R2 bucket, descriptor, and WorkOS
clients. The staging database is not created by this procedure. The deployment
does not add a provisioner binding, build a container image, or start a
managed environment. Do not run `provisioner` commands for this release.

The local convenience template `cloud/backend/hosted-targets.example.json`
also defaults the managed provisioner off. It is not the staging workflow
manifest, which pins the exact staging target. Keep the provisioner disabled
for this release.

## Managed host tunnel staging setup

Managed host reachability is a separate feature from Anvil Cloud Agents. To
run the current staging rehearsal, save `ANVIL_MESH_MANAGED_ENDPOINTS: "true"`
in `ANVIL_STAGING_WORKER_VARS_JSON`. The protected `anvil-staging` environment must
provide `CLOUDFLARE_TUNNEL_ACCOUNT_ID`, `CLOUDFLARE_TUNNEL_ZONE_ID`, and
`CLOUDFLARE_TUNNEL_API_TOKEN`, with the token scoped to the required tunnel
operations in that account and zone. Required API permissions are account
Cloudflare Tunnel Edit and zone DNS Edit. Use a dedicated staging token.
Add the operator-controlled hostname domain as
the non-secret `MACHINE_ENDPOINT_DOMAIN` value in
`ANVIL_STAGING_WORKER_VARS_JSON`. The workflow validates that domain and turns
on `ANVIL_MESH_MANAGED_ENDPOINTS` in the staging Worker. Later automatic pushes
preserve the saved choice. The manual `managed_endpoint_pilot: true` input
also enables a single deployment without changing the saved configuration.

The selected Cloudflare account is `715060911f9418f1df0f9de0265d8a64`, and
`anvilstack.dev` is its active zone `aa52d2318e7bb29a10e3d54c27153ca4`.
Set `MACHINE_ENDPOINT_DOMAIN=anvilstack.dev`. Each allocation creates one
host subdomain beneath that domain; existing website records are retained.
Account and zone IDs are identifiers, not authentication credentials, but the
deployment wrapper deliberately accepts them through the protected secret
source alongside the API token.

The dispatch updates backend configuration and supplies credentials to the
backend deployment. It does not enable a host process. Separately opt in the
selected staging daemon with both endpoint flags and point it at
a trusted `cloudflared` binary installed through the host's normal software
process. The resolver does not download the binary or verify its file owner.
Without the controlled domain, scoped tunnel token, and trusted connector,
leave allocation off. The isolated staging desktop preview embeds the flags
and discovers normal macOS Homebrew installations. See [host connections](host-connections.md) for host
setup and acceptance limits.

Do not put the tunnel token or other credentials in Worker variables, command
arguments, generated source, or this repository. Backend secret source
options are documented in [secret-inputs.md](secret-inputs.md).

## Verify staging

The workflow checks the deployed descriptor after applying the Worker. It
must advertise `anvil-backend/1`, `sync/2`, and `mesh/2`, along with the
current staging `workos-device` identity. A successful workflow proves
deployment and descriptor shape only. Complete the live gates in
[staging-acceptance.md](staging-acceptance.md), including two physical hosts
on separate WANs.

Legacy Stripe configuration is not required for free Sync or Mesh. Keep
checkout disabled. Access decisions must not depend on subscription state or
Stripe availability; see [entitlement incidents](entitlement-incidents.md)
for the remaining legacy billing caveats.

## Production

Production deployment is outside this staging procedure. No production
resources, customer migration, or billing cutover are part of this release.
Do not fill the incomplete production target or run production commands from
this guide. A future production release needs its own reviewed target and
recorded evidence.
