# Cloudflare Sync/Mesh deployment recipe

The recipe deploys the existing Anvil backend Worker from its source project.
It does not compile the backend as an Anvil Cell. The generic Cell Cloudflare
adapter remains plan-only; these commands operate on the Sync/Mesh backend
and its optional Sandbox provisioner.

For a complete branch-testing sequence, including website, Stripe, device
pairing and cloud environment checks, use the
[deployment runbook](../../../anvil-app/docs/runbooks/hosted-sync/deploy.md).

## Backend modes and inputs

```sh
anvil-cloud mesh plan --backend <path> --name <worker> \
  --mode hosted --stage staging --account-id <id> \
  --base-url <https-origin> --bucket <dedicated-bucket> \
  --database <dedicated-billing-db> --vars-file <json> \
  --config-out <generated-config> --write --json
```

`--mode self-hosted` is the default and reads `wrangler.jsonc` or
`wrangler.json`. `--mode hosted` strictly reads `wrangler.hosted.jsonc` or
`wrangler.hosted.json`; it never falls back to the self-host configuration.

Both modes retain the backend's Durable Object bindings and complete
migration history, entrypoint, compatibility date and R2 bindings. Hosted
mode also retains D1 bindings, cron triggers, source vars and service
bindings. It requires `HOSTED_DB` and `HOSTED_BILLING_ENFORCEMENT="true"`.
The self-host template has no hosted billing or WorkOS dependency.

Additional inputs:

- `--vars-file` merges a JSON map of string values into the source vars.
  Secrets are rejected in vars; install them with `mesh secrets`.
- `--oidc-issuer`, `--oidc-client-id`, `--oidc-scopes` configure direct OIDC
  enrollment. Both issuer and client id are needed to advertise `oidc-pkce`.
- `--managed-provisioner <worker>` adds the `MANAGED_PROVISIONER` binding.
  `ANVIL_PUBLIC_API_URL` defaults to the supplied backend origin. Install
  `MANAGED_PROVISIONER_TOKEN` separately.
- `--enrollment-admin` adds `ENROLLMENT_ADMIN_TOKEN` to the plan. A mutating
  apply then requires `ANVIL_MESH_ADMIN_TOKEN` in the process environment and
  installs it after the Worker deploys. Dry-runs do not need the value.
- `--database` overrides the hosted database name; `--bucket` overrides the
  artifact bucket. Use dedicated names for staging.
- `--env` emits and selects a named Wrangler environment. All deployment,
  migration, resource and secret commands pass that same environment.
- `--subdomain` can derive a workers.dev origin in place of `--base-url`.
- `--connection-out` writes a pinnable connection record after apply.
- `--first-deploy` records first-deploy intent. All migration tags are always
  emitted, including on upgrades; the provider skips already-applied tags.

The default generated file is `wrangler.mesh.jsonc` for self-hosted mode and
`wrangler.mesh.hosted.jsonc` for hosted mode. Prefer an explicit output path
per target. Entrypoint and D1 migration paths are resolved against the source
project and rewritten relative to that output path. Generated output cannot
overwrite the source Wrangler configuration.

Planning makes no provider calls. `--write` writes the generated config.
Plans include the mode, bindings, vars, diagnostics, lifecycle gates, required
secret metadata and connection preview. They never accept secret values.

## Resource and deployment lifecycle

Repeat the same target options on each command. The runbook provides a shell
helper to keep them consistent.

```sh
anvil-cloud mesh provision <target-options> --json
anvil-cloud mesh migrate <target-options> --json
anvil-cloud mesh apply <target-options> --dry-run --json
anvil-cloud mesh apply <target-options> --test-deployment --json
anvil-cloud mesh secrets <target-options> --from-file <secret-json> --json
```

`provision` writes the selected config before contacting Cloudflare. It lists
D1 databases to recover an existing database by name, creates missing
resources and persists each resolved D1 id before moving on. Re-planning
recovers a cached id only for the same explicit account, Worker, environment
and database name. An explicit source id takes precedence. A D1 failure stops
before provisioning R2.

`migrate` rejects unresolved D1 ids and applies declared migrations remotely.
It has no database work for the self-host template. `apply` also rejects
unresolved D1 ids for a real deployment; a local dry-run can compile the
unprovisioned template.

`secrets` accepts exactly one of `--from-file <json>` and `--from-stdin`.
It validates the input, sends it to Wrangler over stdin and reports names
only. Secret operation failures suppress provider output because a provider
or wrapper may echo rejected values. For the planned enrollment admin secret,
`apply` deploys first and installs the value from `ANVIL_MESH_ADMIN_TOKEN`
through the same protected stdin path. Use `mesh secrets` to install or rotate
other secrets. Reapply preserves the Worker's existing secrets.

Commands resolve the backend-local Wrangler installation first. Install the
standalone backend with `pnpm install --ignore-workspace --frozen-lockfile`.
All provider subprocesses receive explicit config paths; stdin closes even
when no payload is supplied so noninteractive commands cannot wait forever.

## Production evidence and initial test deployments

The normal apply path requires `--evidence <reference>` identifying recorded
provider lifecycle evidence. Remove takes `--evidence <path>` to a live JSON
artifact produced by `scripts/verify-mesh-rehearsal.mjs`. The artifact must
record a successful deployment for the same Worker and stage, and its SHA-256
must match the exact generated Wrangler configuration. Missing, stale or
unrelated evidence fails closed before Wrangler runs. A local
`apply --dry-run` needs no evidence and makes no provider mutation.

An initial staging test can use an explicit `--test-deployment` with a
non-production `--stage`. This option applies the selected target without
pretending a provider smoke test has already passed. It is rejected for the
default `production` stage, even when an evidence reference is also supplied.
It does not select safe resource names; the caller must supply the intended
test account, Worker, bucket and database.

`ANVIL_DEV_SPIKE` is blocked in non-dev plans. The Desktop's local spike
fixture is separately gated by an unpackaged build and
`ANVIL_ENABLE_SYNC_SPIKE=1`; neither gate enables a hosted deployment. The
`ENROLLMENT_ADMIN_TOKEN` is a valid production secret for self-hosted
enrollment-code bootstrap, never a var. Temporary Accounts remain unsupported
because the Mesh backend needs R2.

## Sandbox provisioner

```sh
anvil-cloud mesh provisioner plan --provisioner <path> --name <worker> \
  --mode managed --stage staging --account-id <id> --write --json
anvil-cloud mesh provisioner apply <provisioner-options> --dry-run --json
anvil-cloud mesh provisioner apply <provisioner-options> --test-deployment --json
anvil-cloud mesh provisioner secrets <provisioner-options> \
  --from-file <token-text-file> --test-deployment --json
```

`managed` and `byo` deploy the same bearer-authenticated provisioner. Managed
mode uses a backend service binding; BYO clients use its public URL. The
provisioner config preserves Sandbox Durable Objects, migration history and
container settings, and rewrites its source paths for the generated output.
Missing image/daemon staging, invalid bindings, Temporary Accounts and
`ALLOW_UNAUTHENTICATED` values other than `"false"` block deployment.

Build the app daemon and run `cloud/images/anvil-worker/prepare.sh` before
planning. The provisioner dry-run compiles the Worker and builds the container
image through Docker. The image includes the native build dependencies for
`better-sqlite3` and `node-pty`.

Provisioner secrets input is a single raw token, unlike backend secrets JSON.
It is sent on stdin, bounded to 64 KiB and redacted from captured output.
Use the same token as the backend's `MANAGED_PROVISIONER_TOKEN`.

Apply, token installation and remove use the same production evidence gate
and explicit non-production test option as the backend.

## Connection and removal

Connection records contain `schemaVersion`, `kind`, `workerName`, `stage`,
`baseUrl` and `descriptorUrl`. The descriptor URL is always
`<base>/.well-known/anvil-backend`. HTTPS is required except for explicit
loopback development with `--allow-insecure`.

```sh
anvil-cloud mesh connection --name <worker> --base-url <https-origin> --out <path> --json
anvil-cloud mesh remove <target-options> --evidence <live-evidence.json> --json
anvil-cloud mesh remove <target-options> --stage staging --test-deployment --json
anvil-cloud mesh provisioner remove <provisioner-options> --test-deployment --json
```

Removal deletes the selected Worker. It is not a complete D1/R2 cleanup
workflow; review dedicated storage separately after recovering any needed
data. Terminate cloud environments before deleting their provisioner.

All recipe APIs remain Promise-based with injectable Wrangler runners for
verification. Provider SDKs are not exposed to Cell code.
