# Host connections for Sync and Mesh

Status: implementation is integrated at source checkpoint `47dd506`; automated
local project checks passed. Security review evidence and its remaining limits
are recorded in the [implementation review](../../plans/sync-mesh/host-local-implementation-review.md).
Current managed staging transport results are in the
[transport evidence](staging-transport-evidence.md). Physical WAN reachability
and commercial terms remain open. No provider bill has been verified. This guide describes
the operator-controlled rollout, not production availability.

## User flow

Anvil connects trusted devices that belong to the same personal account. An
organization, shared fleet or paid Sync plan is not required. Sync and Mesh are
free. Anvil Cloud Agents are a separate future paid feature and remain
default-off.

When a host has an active signed-in Sync scope, the Sync runtime discovers
trusted hosts on that account and maintains sessions over a valid route. Host
sessions and the managed connector are available by default in desktop and
daemon builds. Users and testers need no feature flags. Explicit runtime
`ANVIL_MESH_MACHINE_ENDPOINTS=false` or `ANVIL_MESH_MANAGED_ENDPOINTS=false`
remains an operator disable switch. The backend separately controls managed
allocation.

For a user, the normal setup is to sign in to the same account on each device,
enable Sync in **Settings → Sync & Mesh** on the devices that should share
state, and complete device trust approval. The host checks each source device's
current trust and policy before admitting it. The `observe`, `approve` and
`steer` tiers still control what a trusted source may do. Enabling Sync does
not opt a device into Mesh job execution. A daemon that should execute jobs
also needs its separate worker opt-in, such as `anvil-daemon worker on`.

The endpoint service runs alongside the companion listener, but the machine
session lifecycle does not use the companion preference or Mesh worker opt-in
as its enable switch. Staging acceptance must verify that private route
discovery continues to work when the companion preference is off.

## Connection and authorization path

The source device discovers the target's machine identity, endpoint
generation, capabilities and route metadata from the account backend. It tries
validated private routes before any managed HTTPS route. In hosted use, the
source sends its account bearer only to fixed HTTPS broker endpoints. It never
sends that bearer to a host route. Local development permits HTTP only for a
loopback backend.

The broker checks that both enrollments are active and trusted in the same
account, then issues a random opaque admission ticket. A ticket expires after
60 seconds and can be consumed once. The host redeems it with the host's own
account bearer. The ticket binds the requesting enrollment, target machine,
endpoint generation, requested operations, client key and bootstrap challenge.
The host checks its local device policy before admitting the session. Revoked
or denied devices fail closed.

The broker seals the admission proof key to the client's ephemeral X25519 public
key. The client sends an HMAC over the ticket claims and host challenge. After
consuming the one-use ticket, the host checks that HMAC and returns an HMAC over
the complete bootstrap response under the same proof key. The client verifies
that host proof before accepting the session token, which is also sealed to the
ephemeral client key. Dashboard sessions use the locally approved DSK for these
proofs. Both sides then encrypt socket frames with directional AES-256-GCM
keys. The broker handles discovery and ticket issuance; it does not proxy those
session frames.

Machine identity is separate from route identity. The host creates a new
endpoint generation when its session endpoint starts. Routes and admission
tickets bind to that generation, so a stale route or ticket cannot silently
attach to a later host session.

## Operator rollout

Desktop and daemon builds have host sessions available by default. Choose the
staging backend, sign in, enable Sync, and complete device trust approval:

```sh
cd anvil-app
ANVIL_DEPLOYMENT_ENV=staging \
ANVIL_HOSTED_BACKEND_URL="$MESH_ORIGIN" \
pnpm dev
```

For a daemon test, sign in or enroll against the staging backend, then run:

```sh
node dist-daemon/anvil-daemon.mjs run
```

No endpoint flag is required in launchd or systemd. This availability does not
enable Mesh job execution. Explicit `false` process settings remain operator
controls for temporarily disabling host sessions or the managed connector.

The current backend descriptor uses the `anvil-backend/1` envelope and the
required `sync/2` and `mesh/2` profiles. The host protocol has its own
`machine.session/1` and `machine.stream/1` capabilities. Confirm the selected
backend advertises the current profiles before signing in. See [deployment](deploy.md)
and [staging acceptance](staging-acceptance.md) for environment selection and
the backend checks.

Use two physical devices enrolled to one disposable staging account. Verify
that both are trusted, Sync is active, the target advertises a current machine
generation, and the source reaches it through a private route. Exercise device
revocation, a target restart, route loss and reconnect. A second profile or
data directory on the same computer is not physical-device evidence.

## Managed endpoint setup

Managed connectors are available by default on the host. Provisioning requires
`ANVIL_MESH_MANAGED_ENDPOINTS=true` in the backend Worker, a configured domain
and provider credentials. The backend needs:

- `MACHINE_ENDPOINT_DOMAIN` as a Worker variable for an operator-controlled
  hostname domain.
- `CLOUDFLARE_TUNNEL_ACCOUNT_ID`, `CLOUDFLARE_TUNNEL_ZONE_ID` and
  `CLOUDFLARE_TUNNEL_API_TOKEN` as Worker secrets.

The backend allocates a generation-fenced Cloudflare Tunnel and publishes its
HTTPS hostname only when allocation is ready. The host starts a separate
loopback listener on `127.0.0.1` and gives that origin to the tunnel
provisioner. Managed ingress forwards to that loopback listener. It does not
make the ordinary companion listener public. The connector token is returned
to the host over the authenticated broker route, written to a private
temporary file with mode `0600`, passed with `--token-file`, then removed when
the connector stops. It is not stored in daemon config, argv or status output.

The host process also needs a trusted `cloudflared` executable. The current
resolver checks `ANVIL_CLOUDFLARED_PATH`, then the packaged resource, then
the conventional macOS Homebrew paths, then `PATH`, and requires execute
permission. It starts the process without a shell,
passes `--no-autoupdate`, and does not download or install the binary. The
resolver does not check file ownership or parent-directory permissions.
Operators must point it at a binary installed through their trusted software
process, in a path writable only by the intended administrator. The runtime
does not enforce that ownership requirement.

Set `ANVIL_MESH_MANAGED_ENDPOINTS=true` and `MACHINE_ENDPOINT_DOMAIN` in the
selected staging target's generated Worker vars. Put the three Cloudflare
values in that target's configured backend secret source, then use the
selected-target deployment wrapper to install them. With the feature flag
enabled, its secret validation requires all three values. The Cloudflare
account and zone IDs may be shared by staging and production; keep the API
token distinct between those environments. Keep the API token out of generated
vars, command history and this repository. Account and zone IDs are identifiers;
the wrapper still accepts them through its protected secret source. See [hosted backend secret inputs](secret-inputs.md)
for the accepted secret sources.

Before a managed rollout, confirm the provider's current account limits,
hostname and DNS capacity, allowed traffic, price and billing behavior for
this workload. Those commercial limits have not been verified. Public account
quotas do not establish Anvil's contracted capacity or cost.

## Acceptance still required

Local tests establish protocol and process behavior only. They do not prove
that one user's machines can reach each other over the public internet, that
NAT and ISP filtering permit the connection, that reconnect survives sleep,
or that managed tunnels are available at the needed price and capacity.

Before enabling this path beyond a staging cohort, record results from
physical hosts on separate WANs. Include first connection, idle reconnect,
host sleep and resume, route change, revocation, managed allocation failure,
and recovery through the existing hosted operation path where supported.
Keep managed backend provisioning off in production until those results and
the managed provider terms have an owner and approval.

For the worker lifecycle, trust tiers and daemon controls, see
[the headless daemon guide](headless-daemon.md). For the staged service
checklist, see [launch checklist](launch-checklist.md).
