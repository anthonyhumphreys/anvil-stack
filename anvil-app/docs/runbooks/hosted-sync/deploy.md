# Hosted sync deployment: staging and production

Current policy: Sync and Mesh are free. New Sync checkout and paid seat increases are disabled.
Stripe configuration is optional legacy billing support, not an access requirement. Keep
`ANVIL_CLOUD_AGENTS_ENABLED` false in the backend and provisioner for this release. Complete the
[free-service launch checklist](launch-checklist.md) before deploying these changes; the commands
below do not constitute approval to modify shared infrastructure or existing subscriptions.

Use the target manifest and wrapper below for every hosted deployment. The
manifest locks the Worker, D1, R2, provisioner, WorkOS clients and generated
config paths to one selected environment. Direct `anvil-cloud mesh` calls are
lower-level tooling; do not use them to choose a hosted target.
Run the commands from the `anvil-app/` repository root unless a command first
changes directory.

## Configure the two targets

The ignored generated staging config records the current staging resources and
is represented in `hosted-targets.example.json`. Copy that template to the
ignored operator file, then keep its staging values intact:

```sh
mkdir -p cloud/backend/.wrangler
cp -n cloud/backend/hosted-targets.example.json cloud/backend/.wrangler/hosted-targets.json
```

The production entry is intentionally incomplete. Before any production
resource operation, fill its Cloudflare account id, Worker name, HTTPS origin,
R2 bucket, D1 name, unique descriptor id/name, and production WorkOS desktop
and website client IDs. Keep `databaseId` null until `provision` creates the
production D1 database. Use separate resource names even when both targets
share one Cloudflare account. Never copy the staging D1 id, deployment id,
WorkOS client ids, or secrets into production.

The WorkOS issuer is the same public URL in both targets. Use a separate
production WorkOS environment from staging, with production website and
desktop clients configured in that same user environment so both resolve to
the same account. Production's `desktopClientId` and `hostedClientId` must
both differ from both staging client IDs. The website's `WORKOS_CLIENT_ID`
must match the selected target's `hostedClientId`; its `WORKOS_API_KEY` and
callback configuration must come from that WorkOS environment. Keep WorkOS
API keys in the website's protected environment settings, never in the target
manifest or Worker vars.

Generated Wrangler files and secret files live under `.wrangler/` and are
ignored by git. `vars.json` preserves existing optional non-secret settings
such as Stripe checkout URLs and quota overrides while locking deployment and
WorkOS identity vars to the selected manifest entry. Do not put secret values
in `vars.json`. The existing JSON secret file remains supported; for optional
dotenv and process-environment inputs, see
[hosted backend secret inputs](secret-inputs.md).

## Build and preflight

Build the current Anvil Cloud CLI from the sibling checkout, then verify the
hosted target wrapper:

```sh
cd ../anvil-cloud
pnpm --filter '@anvilstack/cloud-cli...' build
cd ../anvil-app/cloud/backend
pnpm install --ignore-workspace --frozen-lockfile
pnpm typecheck
pnpm test:hosted-deploy
node scripts/verify-hosted-config.mjs --self-check
cd ../..
```

The wrapper requires an explicit environment and does not accept resource or
config overrides. It passes the same `ANVIL_DEPLOYMENT_ENV` to the CLI, rejects
a conflicting shell value, and keeps each generated config under
`.wrangler/mesh/<worker-name>/`.

Staging plan writes only the local generated config; it makes no Cloudflare
provider calls:

```sh
pnpm --dir cloud/backend hosted:deploy -- --environment staging plan --json
```

Review that plan before choosing any provider operation. The existing staging
Worker, D1 id, R2 bucket, descriptor id, WorkOS clients and provisioner name
are already seeded from the generated staging metadata. The wrapper verifies
them again before it calls the CLI.

## Deploy staging

For cloud environments, deploy the staging provisioner first. Its `plan` is
local; `apply` contacts Cloudflare. Use one fresh
`MANAGED_PROVISIONER_TOKEN` value for both the backend and provisioner. In the
legacy JSON mode, set the token path in the staging manifest and use the same
value in the backend secrets file. With a dotenv or process source, the wrapper
uses `MANAGED_PROVISIONER_TOKEN` for both. See
[hosted backend secret inputs](secret-inputs.md) for the source choices.

```sh
pnpm --dir cloud/backend hosted:deploy -- --environment staging provisioner plan --json
pnpm --dir cloud/backend hosted:deploy -- --environment staging provisioner apply --dry-run --json
pnpm --dir cloud/backend hosted:deploy -- --environment staging provisioner apply --test-deployment --json
pnpm --dir cloud/backend hosted:deploy -- --environment staging provisioner secrets --test-deployment --json
```

Sync, device enrollment and desktop-to-desktop Mesh do not need the
provisioner. The Cloudflare account must have Containers enabled and Wrangler
must be logged in to the account selected in the manifest. Build the daemon
image with `cloud/images/anvil-worker/prepare.sh` before provisioner planning.

Then provision storage, migrate the hosted D1 database, and deploy the backend:

```sh
pnpm --dir cloud/backend hosted:deploy -- --environment staging plan --json
pnpm --dir cloud/backend hosted:deploy -- --environment staging provision --json
pnpm --dir cloud/backend hosted:deploy -- --environment staging migrate --json
pnpm --dir cloud/backend hosted:deploy -- --environment staging apply --test-deployment --json
pnpm --dir cloud/backend hosted:deploy -- --environment staging secrets --json
```

The wrapper reads backend secrets from the configured Staging source. The
required `HOSTED_SERVICE_KEYS` JSON map must contain a fresh key id and a secret
of at least 32 characters. When the managed provisioner is enabled, its token
must match `MANAGED_PROVISIONER_TOKEN`. Stripe values are optional and must be
supplied together. The wrapper does not print secret values.

`--test-deployment` is allowed only for non-production targets. Normal apply
and remove remain behind the CLI's provider-evidence gate. D1/R2 provisioning
and D1 migration still mutate the selected account, so run them only after
reviewing the target and plan.

## Configure production deployment

Production stays blocked until the production manifest entry is complete. The
wrapper rejects reused Worker, R2 bucket, D1 name/id, backend origin,
provisioner name, descriptor id, and either WorkOS client id. Production
provision, migrate, apply, and secret operations require a Production-only
backend secret source and an independently loadable, completed Staging source
for cross-environment isolation checks. If Staging uses only
`secrets.backendEnv: "process"`, the wrapper cannot compare the two sources and
must fail closed. The wrapper rejects reused WorkOS, Stripe, HMAC, operator,
and provisioner secrets. Stripe Price IDs are optional legacy billing metadata;
they are not required to launch free Sync and Mesh. If the
managed provisioner is enabled, its token must match the backend secret and
differ from Staging. Source options and the optional internal 1Password mount
are documented in [hosted backend secret inputs](secret-inputs.md).

Use the production target only after its WorkOS application and website
settings are ready:

```sh
export PRODUCTION_EVIDENCE='<recorded-provider-lifecycle-reference>'
pnpm --dir cloud/backend hosted:deploy -- --environment production plan --json
pnpm --dir cloud/backend hosted:deploy -- --environment production provisioner plan --json
pnpm --dir cloud/backend hosted:deploy -- --environment production provisioner apply --dry-run --json
pnpm --dir cloud/backend hosted:deploy -- --environment production provisioner apply --evidence "$PRODUCTION_EVIDENCE" --json
pnpm --dir cloud/backend hosted:deploy -- --environment production provisioner secrets --json
pnpm --dir cloud/backend hosted:deploy -- --environment production provision --json
pnpm --dir cloud/backend hosted:deploy -- --environment production migrate --json
pnpm --dir cloud/backend hosted:deploy -- --environment production apply --evidence "$PRODUCTION_EVIDENCE" --json
pnpm --dir cloud/backend hosted:deploy -- --environment production secrets --json
```

Set `PRODUCTION_EVIDENCE` to the provider lifecycle reference recorded for the
operation before each protected apply.
Production rejects `--test-deployment`. The wrapper never creates production
WorkOS clients or chooses production resource names on your behalf.

## Website and release environments

For automated staging backend deployment and the unsigned macOS candidate,
follow [staging-ci.md](staging-ci.md). Live acceptance is tracked in
[ANV-11](https://linear.app/anvil-stack/issue/ANV-11/run-hosted-sync-staging-acceptance-for-pr-91).

The website selects the same `ANVIL_DEPLOYMENT_ENV=staging|production` value as
the backend wrapper. Configure `ANVIL_STAGING_*` and
`ANVIL_PRODUCTION_*` values from `anvil-website/.env.example` in separate
Vercel environments. In particular, each website
`ANVIL_<ENV>_WORKOS_CLIENT_ID` must match the manifest target's `hostedClientId`,
and each `ANVIL_<ENV>_BACKEND_ORIGIN` must match its `baseUrl`; desktop direct
OIDC uses `desktopClientId`. Production must use its own WorkOS API key and
callback URL. The website's Vercel environment receives only website-specific
variables. Do not export all variables from a backend dotenv source to Vercel;
the `ANVIL_STAGING_*` and `ANVIL_PRODUCTION_*` prefixes do not make every value
website-safe. See [hosted backend secret inputs](secret-inputs.md).

The GitHub Actions environments `anvil-staging` and `anvil-production` have
been created. Staging has `ANVIL_STAGING_HOSTED_BACKEND_URL` set to its
verified Worker origin. Production is restricted to `main` and `app-v*` tags;
set `ANVIL_PRODUCTION_HOSTED_BACKEND_URL` after the production Worker origin is
known. Add a required production reviewer once its owner is chosen. Release
builds with no production backend URL intentionally leave hosted sync
unavailable; BYO/self-hosted backends remain available.

Before launching the free hosted service, complete the [launch checklist](launch-checklist.md).

## Legacy Stripe support

Keep `HOSTED_CHECKOUT_ENABLED` false. The backend rejects new Sync checkout and seat changes even
when a stale client requests them. Existing subscriptions can retain portal, cancellation,
webhook and reconciliation support with environment-specific credentials. The
[organization and billing launch runbook](organization-billing-launch.md) is archived history;
its price setup and preview cutoff are not launch instructions. Existing customer subscription
cancellation or refunds need a separate operational cutover. Inventory and expire existing open
checkout sessions as part of that cutover. Deploying free access does not stop Stripe renewals or
prevent completion of a previously issued checkout session. Continue processing signed late events.

## Verify the deployed branch

Start with the descriptor:

```sh
curl -fsS "$MESH_ORIGIN/.well-known/anvil-backend"
```

It must advertise `anvil-backend/1`, `sync/2`, `mesh/2` and `enrollment-code`.
Staging acceptance also requires WorkOS `workos-device` and the exact
staging client ID; see [staging acceptance](staging-acceptance.md).
There is no `/health` route on the backend Worker; use the descriptor request
above as the deployment healthcheck. A failure against the bare
`<subdomain>.workers.dev` hostname indicates an incorrectly constructed
`MESH_ORIGIN`, before the Worker is reached.

For signed-in staging acceptance, follow the executable sequence in
[staging-acceptance.md](staging-acceptance.md). It identifies which gates
require operator credentials or a second physical device and requires
unavailable gates to be recorded as blocked.

If legacy Stripe support is configured, verify webhook liveness after installing its secret:

```sh
curl -sS -X POST "$MESH_ORIGIN/v1/hosted/stripe-webhook" -d '{}'
```

An unsigned request should return `unauthenticated`. `not-found` means the
webhook secret or hosted binding is absent. Use the signing example in
[reconciliation](reconciliation.md) for authenticated internal calls; change
its path to `/internal/hosted/account` for an account lookup.

For self-hosted testing, run the deployed wire-contract suite against a
throwaway backend with the admin credential. The suite creates and deletes
its own test account:

```sh
node cloud/backend/conformance/suite.mjs \
  --url "$MESH_ORIGIN" --admin-token "$ENROLLMENT_ADMIN_TOKEN"
```

Then enroll two desktop/daemon devices against that same backend and test
sync and Mesh work. See [headless daemon](headless-daemon.md) for enrollment
and worker commands. Hosted website routes should remain unavailable on the
self-hosted backend.

For cloud environments, enroll a source daemon with worker enabled and run
it in a separate terminal. Request managed capacity with:

```sh
node dist-daemon/anvil-daemon.mjs env request anvil-managed --ttl 600
node dist-daemon/anvil-daemon.mjs env list
```

Confirm the environment enrolls, appears as an ephemeral Mesh worker, can
claim a permitted job and terminates when requested or when its TTL expires.
Use `env terminate <environmentId>` to finish the test. A successful Worker
upload alone does not prove container enrollment or job execution.

## Upgrade and cleanup

Keep the same selected manifest target, generated config and secret values for
an upgrade. Rebuild the CLI/backend image as needed, then run the target
wrapper's `migrate` and `apply` commands. Staging apply uses
`--test-deployment`; production apply requires evidence. Secret values are
installed separately; reapplying the Worker preserves them.

Terminate test environments before removing their provisioner. For a staging
Worker removal:

```sh
pnpm --dir cloud/backend hosted:deploy -- --environment staging remove --test-deployment --json
# If this test deployed a provisioner:
pnpm --dir cloud/backend hosted:deploy -- --environment staging provisioner remove --test-deployment --json
```

Worker removal does not provide a full storage cleanup workflow. Review and
remove the dedicated D1/R2 resources in Cloudflare when their test data is no
longer needed. Keep billing migrations intact for any retained database.
Delete operator-created temporary secret files when finished. The wrapper
removes its own temporary files; keep mounted 1Password paths in place.
