# Deploy and test Sync/Mesh from this branch

Use this checkout's Anvil Cloud CLI for both deployment modes:

| Mode | Backend configuration | Identity and billing |
| --- | --- | --- |
| `hosted` | `wrangler.hosted.jsonc`, including D1, billing enforcement and reconciliation cron | Website WorkOS sign-in, signed service channel, optional Stripe checkout |
| `self-hosted` | `wrangler.jsonc`, including the Sync/Mesh Durable Objects and R2 | Enrollment codes or your OIDC provider; no WorkOS, D1 or Stripe dependency |

The CLI now handles resource provisioning, D1 migrations, Worker deployment
and secret installation. Wrangler remains an internal deployment dependency;
you do not need to invoke it for the sequence below. The optional provisioner
commands deploy the Sandbox Worker and container image for cloud environments.

## Build this branch

Run from the monorepo root. Keep this terminal open for the helper functions
and variables used below.

```sh
export ANVIL_ROOT="$PWD"
cd "$ANVIL_ROOT/anvil-cloud"
pnpm install --frozen-lockfile
pnpm --filter '@anvilstack/cloud-cli...' build

cd "$ANVIL_ROOT/anvil-app/cloud/backend"
pnpm install --ignore-workspace --frozen-lockfile
pnpm typecheck
pnpm test
pnpm conformance:fixture
node scripts/verify-hosted-config.mjs --self-check

cd "$ANVIL_ROOT"
anvil_cloud() {
  node "$ANVIL_ROOT/anvil-cloud/packages/cli/dist/index.js" "$@"
}
```

The backend and provisioner are standalone packages inside the app directory.
`--ignore-workspace` installs their own lockfiles instead of the app workspace.
Use the built CLI above rather than a previously installed release.

The backend tests apply hosted migrations locally and stub Stripe and the
managed provisioner. Fixture conformance tests the in-memory reference
backend. These checks do not contact a deployed Worker.

`pnpm dev` in the backend starts the self-host development fixture. It does
not enable hosted billing. The hosted config validator is expected to reject
the checked-in placeholder D1 id until resources have been provisioned.

## Choose the test target

Use separate Worker names, R2 buckets and D1 databases for each deployment.
Set the Cloudflare account and API token in your shell through your normal
credential manager. The account needs Workers, R2 and Durable Objects; hosted
mode also needs D1. Cloud environments additionally need Containers and a
running Docker engine locally.

```sh
export CLOUDFLARE_ACCOUNT_ID='<test-account-id>'
# CLOUDFLARE_API_TOKEN must already be set, or Wrangler must be logged in.
export MESH_MODE=hosted
export MESH_NAME=anvil-sync-hosted-staging
# The hostname is the Worker name followed by the account's workers.dev
# subdomain. The bare account hostname (for example,
# https://<your-subdomain>.workers.dev) is not a Worker endpoint.
export MESH_ORIGIN='https://anvil-sync-hosted-staging.<your-subdomain>.workers.dev'
export MESH_BUCKET=anvil-sync-hosted-staging-artifacts
export MESH_DATABASE=anvil-sync-hosted-staging-billing
export MESH_STAGE=staging
export MESH_DIR="$ANVIL_ROOT/anvil-app/cloud/backend/.wrangler/mesh/$MESH_NAME"
mkdir -p "$MESH_DIR"
printf '{}\n' > "$MESH_DIR/vars.json"

# The desktop hosted tile uses this exact tested HTTPS origin.
export ANVIL_HOSTED_BACKEND_URL="$MESH_ORIGIN"
```

For self-hosted testing, set `MESH_MODE=self-hosted`, choose a different
`MESH_NAME`, matching `MESH_ORIGIN` and bucket, and recalculate `MESH_DIR`.
The helper ignores `MESH_DATABASE` in self-hosted mode. Keep an existing
`vars.json` on subsequent runs; the command above initializes a new target.

Define one helper so every command uses the same target and configuration:

```sh
mesh() {
  set -- "$@" \
    --backend "$ANVIL_ROOT/anvil-app/cloud/backend" \
    --mode "$MESH_MODE" --name "$MESH_NAME" --stage "$MESH_STAGE" \
    --account-id "$CLOUDFLARE_ACCOUNT_ID" --base-url "$MESH_ORIGIN" \
    --bucket "$MESH_BUCKET" --vars-file "$MESH_DIR/vars.json" \
    --config-out "$MESH_DIR/wrangler.jsonc" \
    --connection-out "$MESH_DIR/connection.json"
  if [ "$MESH_MODE" = hosted ]; then
    set -- "$@" --database "$MESH_DATABASE"
  fi
  if [ -n "${MESH_PROVISIONER_NAME:-}" ]; then
    set -- "$@" --managed-provisioner "$MESH_PROVISIONER_NAME"
  fi
  anvil_cloud mesh "$@"
}
```

The `.wrangler` directory is ignored. Generated configs contain resource ids
and non-secret vars. Keep secrets in a separate protected file or stream.
Do not edit the generated config; update `vars.json` or the helper's inputs.
The CLI retains resolved D1 ids for the same target across re-plans.

## Optional cloud environment provisioner

Complete this section before the backend apply if testing cloud environments.
Sync, device enrollment and desktop-to-desktop Mesh work do not need it.
Both hosted managed capacity and BYO Cloudflare Sandbox use this provisioner.

```sh
cd "$ANVIL_ROOT/anvil-app"
pnpm install --frozen-lockfile
pnpm build:daemon
./cloud/images/anvil-worker/prepare.sh

cd "$ANVIL_ROOT/anvil-app/cloud/provisioner"
pnpm install --ignore-workspace --frozen-lockfile
pnpm typecheck
cd "$ANVIL_ROOT"

export MESH_PROVISIONER_NAME="$MESH_NAME-provisioner"
provisioner() {
  anvil_cloud mesh provisioner "$@" \
    --provisioner "$ANVIL_ROOT/anvil-app/cloud/provisioner" \
    --name "$MESH_PROVISIONER_NAME" --mode managed --stage "$MESH_STAGE" \
    --account-id "$CLOUDFLARE_ACCOUNT_ID" \
    --config-out "$MESH_DIR/provisioner.jsonc"
}

provisioner plan --write --json
provisioner apply --dry-run --json
provisioner apply --test-deployment --json
```

The dry-run builds the Linux container image locally. The real apply uploads
it and deploys the provisioner. Its API stays closed until the token is set.
The Cloudflare account must have Containers enabled and the Wrangler
credential must include the Containers permission. If apply fails at
`/accounts/<id>/containers/me` with `401 Unauthorized`, enable Containers (or
use an API token with that permission) before retrying. R2 account state can
also affect binding creation. A bucket may appear in `wrangler r2 bucket list`
while a Worker binding still fails (for example, Cloudflare error `10136`);
this runbook records the symptom only and does not infer its cause. Check the
account's current R2 service state, API-token permissions, selected account,
bucket name, and Wrangler version before retrying. A successful Worker upload
with Wrangler 4.135 is evidence for that deployment attempt only, not proof
that every R2 operation or account is ready.

Generate a token in a protected file and install it after the first apply:

```sh
umask 077
export MESH_TOKEN_FILE="$(mktemp)"
openssl rand -hex 32 > "$MESH_TOKEN_FILE"
provisioner secrets --from-file "$MESH_TOKEN_FILE" --test-deployment --json
```

Use that same value for the backend's `MANAGED_PROVISIONER_TOKEN` secret in
the next section. The `--managed-provisioner` backend option adds the service
binding; the CLI derives `ANVIL_PUBLIC_API_URL` from `MESH_ORIGIN` unless you
explicitly set it in `vars.json`.

For BYO cloud-environment testing, use `--mode byo` in the provisioner helper.
Configure the desktop's Cloudflare Sandbox provider connection with this
provisioner's public URL and token. If using that device-side provisioning
path alone, leave `MESH_PROVISIONER_NAME` unset in the backend helper so it
adds no managed service binding.

## Provision, migrate and deploy the backend

Run these through the `mesh()` helper above. The generated target is selected
by `--config-out`, `--vars-file` and the resource arguments; invoking a bare
`mesh apply` can fall back to the checked-in `wrangler.jsonc` and deploy the
`anvil-spike-*` resources instead.

```sh
mesh plan --write --json
mesh apply --dry-run --json
mesh provision --json
mesh migrate --json
mesh apply --test-deployment --json
```

Stop on a failed command. `provision` creates or reuses the selected R2 bucket
and hosted D1 database, and records its id. `migrate` applies the declared D1
migrations remotely; it has no D1 work in self-hosted mode. Billing migrations
`0001_init`, `0002_billing` and `0003_preview_flag` remain forward-only.

`--test-deployment` explicitly permits initial testing on a non-production
stage without claiming prior provider evidence. It is rejected for the
`production` stage. Normal production apply/remove still require
`--evidence <recorded-reference>`. This flag does not choose or isolate your
Cloudflare resources; the names and account above do that.

Hosted checkout stays disabled while the first deployment and secrets land.
Keep `HOSTED_BILLING_ENFORCEMENT` set to `"true"`; it comes from the hosted
template. Never put the development spike bearer flag in a deployed config.

## Install backend secrets

Create a protected JSON file outside the repository, or pipe JSON from your
credential manager to `mesh secrets --from-stdin --json`. File input uses:

```sh
mesh secrets --from-file /secure/path/backend-secrets.json --json
```

Install secrets after the Worker exists. This avoids creating a secret-only
stub before the first real deploy. The CLI passes values on stdin and returns
secret names only.

Hosted secret file shape:

```json
{
  "HOSTED_SERVICE_KEYS": "{\"staging\":\"<fresh-secret-at-least-32-bytes>\"}",
  "STRIPE_SECRET_KEY": "<Stripe-test-mode-secret>",
  "STRIPE_WEBHOOK_SECRET": "<test-endpoint-signing-secret>",
  "MANAGED_PROVISIONER_TOKEN": "<same-value-as-provisioner-token>"
}
```

`HOSTED_SERVICE_KEYS` is required for the website channel. Its key id must
match `^[A-Za-z0-9_-]{1,64}$`. Omit the Stripe entries until testing billing,
and omit `MANAGED_PROVISIONER_TOKEN` if no managed provisioner is bound.
The webhook signing secret comes from the registration section below.

For self-hosted enrollment-code testing, install:

```json
{
  "ENROLLMENT_ADMIN_TOKEN": "<fresh-admin-secret>"
}
```

Self-hosted OIDC can instead use `OIDC_ISSUER`, `OIDC_CLIENT_ID` and optional
`OIDC_SCOPES` in `vars.json`, followed by another apply. The enrollment admin
credential is always a secret. Managed provisioning can also be bound to a
self-hosted backend with its matching token.

## Wire the hosted website

Skip this section for self-hosted deployment. Use a WorkOS development
application and Stripe test-mode resources for staging.

From the monorepo root:

```sh
cd anvil-website
pnpm install --ignore-scripts --frozen-lockfile
# For a new local environment only; preserve an existing .env.local.
cp -n .env.example .env.local
```

Set the exact names from [the environment example](../../../../anvil-website/.env.example):

- `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`.
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI`, e.g. `http://localhost:3000/callback`,
  registered with that WorkOS application. `/auth/callback` is also present as
  a compatibility alias; use one exact URI consistently in WorkOS and the
  local environment.
- `ANVIL_BACKEND_ORIGIN`, equal to `MESH_ORIGIN`.
- `ANVIL_HOSTED_KEY_ID`, e.g. `staging`, and `ANVIL_HOSTED_SERVICE_SECRET`,
  matching the backend's `HOSTED_SERVICE_KEYS` entry.
- `HOSTED_WORKOS_CLIENT_ID` in the Worker vars, set to the website's
  `WORKOS_CLIENT_ID` when the desktop public client id is separate.
- Worker vars `OIDC_ISSUER=https://api.workos.com/user_management`,
  `OIDC_CLIENT_ID=<desktop-public-client-id>`, and `OIDC_SCOPES="openid profile"`.

Run `pnpm dev` in `anvil-website`, open the printed local origin, and sign in
at `/account`. The website needs the WorkOS variables and the signed service
channel above; it does not reuse the desktop's loopback OIDC callback or
device credential. Website pairing uses that service channel and enrollment
codes. Backend OIDC vars are needed only when testing direct desktop OIDC
login. The desktop callback is the official loopback form
`http://127.0.0.1:<ephemeral-port>/callback`; configure the WorkOS application
with `http://127.0.0.1:*/callback` in its redirect URI list. WorkOS does not
allow a wildcard as the default redirect: first add
`http://127.0.0.1:3001/callback` as the default, then add the wildcard as a
second allowed URI. The desktop explicitly sends its actual ephemeral-port
redirect URI, so it does not use that fixed-port default. Do not substitute
the website callback or an `/account` route. For local account-page testing, an unpackaged desktop may use
`ANVIL_HOSTED_ACCOUNT_URL=http://localhost:3000/account`; deployed builds must
use the configured hosted account origin.

## Enable Stripe test checkout

Register a Stripe test-mode webhook endpoint at
`<MESH_ORIGIN>/v1/hosted/stripe-webhook` for these events:

- `checkout.session.completed`, `checkout.session.expired`
- `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`
- `invoice.paid`, `invoice.payment_failed`

Install its signing secret through `mesh secrets`. Configure Stripe's test
customer portal if testing **Manage billing**. Add the following non-secret
vars to `$MESH_DIR/vars.json`, using prices from the same Stripe test account:

```json
{
  "HOSTED_CHECKOUT_ENABLED": "true",
  "HOSTED_CHECKOUT_SUCCESS_URL": "http://localhost:3000/account/billing?checkout=success",
  "HOSTED_CHECKOUT_CANCEL_URL": "http://localhost:3000/account/billing?checkout=cancel",
  "HOSTED_PORTAL_RETURN_URL": "http://localhost:3000/account/billing",
  "STRIPE_PRICE_SYNC_MONTHLY": "price_test_monthly",
  "STRIPE_PRICE_SYNC_ANNUAL": "price_test_annual"
}
```

Use your website origin if testing a deployed website, then run
`mesh plan --json` and `mesh apply --test-deployment --json` again. The backend
uses these fixed return URLs. It ignores client-supplied redirect targets.

Production requires the [launch checklist](launch-checklist.md), live-mode
resources, approved prices and HTTPS return URLs. Do not reuse staging
billing data, WorkOS identities or secret values for a production launch.

## Verify the deployed branch

Start with the descriptor:

```sh
curl -fsS "$MESH_ORIGIN/.well-known/anvil-backend"
```

It must advertise `anvil-backend/1`, `sync/1` and `enrollment-code`.
There is no `/health` route on the backend Worker; use the descriptor request
above as the deployment healthcheck. A failure against the bare
`<subdomain>.workers.dev` hostname indicates an incorrectly constructed
`MESH_ORIGIN`, before the Worker is reached.

For hosted testing:

1. Sign in at `/account`; account and billing pages should load without a
   not-configured or service-auth error.
2. At `/account/devices`, use **Connect a device** to mint a code. In this
   branch's desktop, open **Settings → Sync & Mesh → Pair this device**,
   select the staging backend URL and redeem it. Start the desktop with
   `pnpm dev` from `anvil-app`.
3. Pair a second test device. Verify sync, worker job execution and device
   revocation. A hosted account must map to the same sync account on both.
4. In `/account/billing`, complete test checkout. Confirm Stripe deliveries
   return 200 and the paid subscription grants `active` access. An eligible
   account without a paid subscription stays in preview until
   2026-11-01T00:00:00Z. Test cancellation and **Reconcile now**.
5. Verify the scoped browser dashboard requests device approval and loses
   access after revocation. The website receives sealed dashboard data.

Webhook liveness after installing its secret:

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
node "$ANVIL_ROOT/anvil-app/cloud/backend/conformance/suite.mjs" \
  --url "$MESH_ORIGIN" --admin-token "$ENROLLMENT_ADMIN_TOKEN"
```

Then enroll two desktop/daemon devices against that same backend and test
sync and Mesh work. See [headless daemon](headless-daemon.md) for enrollment
and worker commands. Hosted website routes should remain unavailable on the
self-hosted backend.

For cloud environments, enroll a source daemon with worker enabled and run
it in a separate terminal. Request managed capacity with:

```sh
node "$ANVIL_ROOT/anvil-app/dist-daemon/anvil-daemon.mjs" env request anvil-managed --ttl 600
node "$ANVIL_ROOT/anvil-app/dist-daemon/anvil-daemon.mjs" env list
```

Confirm the environment enrolls, appears as an ephemeral Mesh worker, can
claim a permitted job and terminates when requested or when its TTL expires.
Use `env terminate <environmentId>` to finish the test. A successful Worker
upload alone does not prove container enrollment or job execution.

## Upgrade and cleanup

Keep the same target variables, generated config and secret values for an
upgrade. Rebuild the branch CLI/backend image as needed, run `mesh migrate`,
then `mesh apply --test-deployment`. Secret values are installed separately;
reapplying the Worker must preserve them.

Terminate test environments before removing their provisioner. For a staging
Worker removal:

```sh
mesh remove --test-deployment --json
# If this test deployed a provisioner:
provisioner remove --test-deployment --json
```

Worker removal does not provide a full storage cleanup workflow. Review and
remove the dedicated D1/R2 resources in Cloudflare when their test data is no
longer needed. Keep billing migrations intact for any retained database.
Delete temporary secret files when finished, including `$MESH_TOKEN_FILE`.
