# Hosted sync deployment: staging and production

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
in `vars.json`.

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
local; `apply` contacts Cloudflare. Set the token path in the staging manifest
and use one fresh value in both the provisioner token file and backend secrets
file:

```sh
pnpm --dir cloud/backend hosted:deploy -- --environment staging provisioner plan --json
pnpm --dir cloud/backend hosted:deploy -- --environment staging provisioner apply --dry-run --json
pnpm --dir cloud/backend hosted:deploy -- --environment staging provisioner apply --test-deployment --json
pnpm --dir cloud/backend hosted:deploy -- --environment staging provisioner secrets --json
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

The wrapper reads backend secrets from the `staging.secrets.backendFile` path
in the manifest. The required `HOSTED_SERVICE_KEYS` JSON map must contain a
fresh key id and a secret of at least 32 characters. When the managed
provisioner is enabled, the backend's `MANAGED_PROVISIONER_TOKEN` must match
the provisioner token file. Stripe values are optional and must be supplied
together. Secret values are streamed from files to the CLI and are never
printed by the wrapper.

`--test-deployment` is allowed only for non-production targets. Normal apply
and remove remain behind the CLI's provider-evidence gate. D1/R2 provisioning
and D1 migration still mutate the selected account, so run them only after
reviewing the target and plan.

## Configure production deployment

Production stays blocked until the production manifest entry is complete. The
wrapper rejects reused Worker, R2 bucket, D1 name/id, backend origin,
provisioner name, descriptor id, and either WorkOS client id. Production
provision, migrate, apply, and secret operations require a production-only
backend secrets file. If the managed provisioner is enabled, its token must
match the backend secret and differ from any available staging token. Do not reuse staging
service keys or Stripe credentials; the wrapper checks values when staging
secret files are available.

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

The website selects the same `ANVIL_DEPLOYMENT_ENV=staging|production` value as
the backend wrapper. Configure `ANVIL_STAGING_*` and
`ANVIL_PRODUCTION_*` values from `anvil-website/.env.example` in separate
Vercel environments. In particular, each website
`ANVIL_<ENV>_WORKOS_CLIENT_ID` must match the manifest target's `hostedClientId`,
and each `ANVIL_<ENV>_BACKEND_ORIGIN` must match its `baseUrl`; desktop direct
OIDC uses `desktopClientId`. Production must use its own WorkOS API key and
callback URL.

The GitHub Actions environments `anvil-staging` and `anvil-production` have
been created. Staging has `ANVIL_STAGING_HOSTED_BACKEND_URL` set to its
verified Worker origin. Production is restricted to `main` and `app-v*` tags;
set `ANVIL_PRODUCTION_HOSTED_BACKEND_URL` after the production Worker origin is
known. Add a required production reviewer once its owner is chosen. Release
builds with no production backend URL intentionally leave hosted sync
unavailable; BYO/self-hosted backends remain available.

Before publishing paid checkout, complete the [launch checklist](launch-checklist.md).

## Enable Stripe checkout

Stripe configuration is optional and remains disabled until its secrets and
vars are set for a target. Use a Stripe test-mode account for staging. Keep
production checkout disabled until the launch checklist, real prices, and
business settings have been approved. Set `MESH_ORIGIN` to the selected
manifest entry's `baseUrl`.

In the Stripe Dashboard's **test mode**, create one monthly and one annual
recurring Price. Copy their exact `price_...` IDs. Register a test-mode
webhook endpoint at `$MESH_ORIGIN/v1/hosted/stripe-webhook` for these events:

- `checkout.session.completed`, `checkout.session.expired`
- `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`
- `invoice.paid`, `invoice.payment_failed`

Add `STRIPE_SECRET_KEY` and the endpoint's signing secret as
`STRIPE_WEBHOOK_SECRET` to the staging backend secret file recorded by
`staging.secrets.backendFile` in `.wrangler/hosted-targets.json`. Never put
these values in `vars.json`. Configure a test-mode Stripe customer portal if
testing **Manage billing**.

In `cloud/backend/.wrangler/mesh/<worker-name>/vars.json`, keep existing
unrelated vars and set the checkout flag, fixed return URLs, and Price IDs.
Use the same website origin for all three URLs. The backend ignores
client-supplied redirect targets.

```json
{
  "HOSTED_CHECKOUT_ENABLED": "true",
  "HOSTED_CHECKOUT_SUCCESS_URL": "http://localhost:3000/account/billing?checkout=success",
  "HOSTED_CHECKOUT_CANCEL_URL": "http://localhost:3000/account/billing?checkout=cancel",
  "HOSTED_PORTAL_RETURN_URL": "http://localhost:3000/account/billing",
  "STRIPE_PRICE_SYNC_MONTHLY": "<monthly-price-id-from-test-mode>",
  "STRIPE_PRICE_SYNC_ANNUAL": "<annual-price-id-from-test-mode>"
}
```

Install secrets, review the local plan, then apply staging:

```sh
pnpm --dir cloud/backend hosted:deploy -- --environment staging secrets --json
pnpm --dir cloud/backend hosted:deploy -- --environment staging plan --json
pnpm --dir cloud/backend hosted:deploy -- --environment staging apply --test-deployment --json
```

Open `/account/billing` from the staging website and complete a real Checkout
Session for the disposable staging account. For concrete purchase,
authentication, cancellation, duplicate-delivery, and account deletion steps,
follow [staging acceptance](staging-acceptance.md#stripe-test-mode-checkout).
Use the [Stripe test cards](https://docs.stripe.com/testing) only with test
mode. The monthly/yearly checkout flow creates its customer without a Stripe
Test Clock; clock-driven renewal, grace, unpaid, and recovery cases are
currently blocked pending a clock-bound test customer path. Do not mark those
cases passed using unmapped `stripe trigger` payloads.

Production requires the [launch checklist](launch-checklist.md), live-mode
resources, approved prices and HTTPS return URLs. Do not reuse staging
billing data, WorkOS identities or secret values for a production launch.

## Verify the deployed branch

Start with the descriptor:

```sh
curl -fsS "$MESH_ORIGIN/.well-known/anvil-backend"
```

It must advertise `anvil-backend/1`, `sync/1` and `enrollment-code`. Staging
acceptance also requires `mesh/1`, WorkOS `workos-device`, and the exact
staging client ID; see [staging acceptance](staging-acceptance.md).
There is no `/health` route on the backend Worker; use the descriptor request
above as the deployment healthcheck. A failure against the bare
`<subdomain>.workers.dev` hostname indicates an incorrectly constructed
`MESH_ORIGIN`, before the Worker is reached.

For signed-in staging acceptance, follow the executable sequence in
[staging-acceptance.md](staging-acceptance.md). It identifies which gates
require operator credentials or a second physical device and requires
unavailable gates to be recorded as blocked.

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
Delete temporary secret files when finished.
