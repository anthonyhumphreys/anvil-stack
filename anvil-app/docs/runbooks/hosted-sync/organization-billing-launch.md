# Hosted waitlist, team billing, and paid launch

This runbook configures invite-only hosted access and shared-billing organisations in
separate WorkOS, Cloudflare, and Stripe staging and production environments. It does
not create shared workspaces: team membership pays for each developer's own private
Anvil account. Members do not gain access to one another's repositories, sync data,
devices, or workers.

The first paid offer is:

| Plan                  |                     Price | Billing unit             | Hosted device allowance                 |
| --------------------- | ------------------------: | ------------------------ | --------------------------------------- |
| Personal              |      £8/month or £80/year | One developer            | Up to five devices for that developer   |
| Small Team            |    £35/month or £350/year | Five developer seats     | Up to five devices per seated developer |
| Additional team seats | £7/month or £70/year each | One named developer seat | Up to five devices for that developer   |

The team minimum is five seats. An organisation with fewer than five assigned
developers still buys five seats. Membership alone does not use a seat: each
developer consumes one only while a seat is explicitly assigned. An owner who
only manages billing uses no seat; assign one if they also need team-funded
hosted access. Buying capacity does not invite users or make their personal data
visible to the payer. Personal and team funding do not stack the five-device
limit.

Use a five-seat minimum and 50-seat self-serve maximum. Invitation reservations
count against capacity; only an assigned seat funds a person's hosted account.
The owner can create and manage billing without assigning themselves a seat.

For seat-capacity changes, keep the Anvil organisation page as the control
surface and disable quantity changes in Stripe's customer portal. An increase
must first show an invoice-preview quote, including amount due and tax, and
require explicit owner confirmation. Confirmation rechecks the quote at its
original `proration_date` against the same customer, subscription, item,
quantity, and current period. Stripe applies `proration_behavior=always_invoice`
with `payment_behavior=error_if_incomplete`; additional capacity is granted only
after the resulting subscription and invoice are confirmed paid. If the preview
amount or subscription version changed, return a replacement quote and require a
new confirmation. This quote-and-confirm path is implemented and covered by
backend tests; complete its Staging rehearsal before enabling paid Production.

Schedule reductions for the next current-period boundary with no immediate
proration. Once Stripe confirms the schedule, clamp available capacity for new
assignments to the requested lower count immediately; reject a reduction below
assigned plus reserved seats. Existing assignments remain in place through the
current period while Stripe retains the old quantity. At renewal, Stripe must
confirm the reduced quantity and paid invoice before the scheduled clamp is
cleared. If renewal is delayed or unpaid, keep the conservative lower capacity;
the usual payment and grace rules govern hosted access. Show the scheduled
capacity and effective date. In Staging, test a five-to-six quote and paid
confirmation, a changed amount that requires reconfirmation, a failed increase
payment, a six-to-five scheduled reduction, and delayed/unpaid renewal behavior
before enabling paid Production.

All admitted users keep free hosted access through Halloween. The preview ends at
`2026-11-01T00:00:00Z`; no existing user is charged automatically. Normal hosted
access after that time requires a personal subscription or a team-funded seat.
Waitlist admission remains required until Anvil explicitly opens registration.

### Desktop client rollout gate

Deploy the desktop client that understands the new entitlement response before
rolling the changed hosted backend schema into Production. `HostedEntitlement`
now includes required `fundedBy` and `organizationId` fields, and hosted storage
limits may be `null`. A strict older client may reject that response and fail to
start a hosted session; do not assume old clients remain compatible.

In Staging, test both the last released desktop build and the updated build
against the candidate backend. Record whether the old build rejects the response,
confirm its normal update/download path can install the new build, then verify
the updated build starts a hosted session and displays personal/team funding
correctly. Before the Production backend rollout, publish the updated client and
verify that existing preview users have updated using the app's available
release/adoption signal or a direct rollout check. Keep Production on the current
backend contract if that check is inconclusive. Complete this migration during
the free preview, before `2026-11-01T00:00:00Z`.

## Safety rules for both environments

- WorkOS Staging and Production are separate identity environments. Users,
  invitations, organisations, webhook endpoints, and API keys do not transfer
  between them. Do not use WorkOS Staging for real customer traffic.
- Keep the WorkOS website and desktop clients in the same WorkOS environment so
  they refer to the same user records. Production client IDs must differ from both
  staging IDs.
- WorkOS's waitlist gates self-service signup. Invitations and verified-domain or
  SSO JIT can create other signup paths, so disable automatic membership from
  verified email domains and SSO JIT in both environments. The backend admission
  check is also required for first-time users; a dashboard toggle alone is not the
  entire access control.
- New users must finish signup with the exact verified email address on their
  approved waitlist entry. Keep an approved entry until the user's first Anvil
  account is linked. Do not delete approved entries as routine cleanup.
- Existing WorkOS users without an Anvil billing row can use the same approved
  waitlist path as anyone else. If a reviewed migration exception is required
  for an existing user without an approved entry, use the environment's
  `HOSTED_ADMITTED_WORKOS_USER_IDS` Worker var and remove that ID after its
  first billing row is created. The backend re-fetches the WorkOS user and
  requires a verified email; never put email addresses in this list.
- A team invitation must only target an existing admitted Anvil user. The server
  rechecks the exact WorkOS user on acceptance. Do not use WorkOS dashboard or
  application-wide invitations as a shortcut around waitlist approval.
- Do not delete an organisation directly in the WorkOS Dashboard as an
  offboarding action. The `organization.deleted` webhook closes local access,
  marks non-owner memberships inactive, releases seats, and revokes invitations;
  it retains an active owner for billing recovery. It does not cancel the Stripe
  subscription or its schedule. The retained owner can use Anvil's closed-
  organisation recovery panel to open the Stripe Customer Portal and cancel the
  subscription. Anvil's normal organisation-close flow also rejects closure
  while paid team billing, its grace period, or an open checkout remains. If the
  owner was explicitly removed or cannot use that recovery path, notify the
  payer and billing operator, locate the Stripe subscription using its
  `organization_id` metadata or the selected environment's billing records, and
  resolve/cancel it in Stripe with the payer's intended effective date. Check
  outstanding invoices and any remaining schedule; do not change D1 rows by
  hand. Restoring access after provider-side deletion requires operator
  recovery.
- Keep Worker secrets in the selected target's ignored `backend-secrets.json`
  file and install them only through `hosted:deploy ... secrets`. Never put
  secret values in a Wrangler `vars.json`, manifest, source file, Vercel browser
  variable, or shell argument.
- Do not copy WorkOS, Stripe, HMAC, D1, R2, or Worker credentials between
  environments. The deployment wrapper rejects reused WorkOS clients and
  secrets, Stripe mode/secrets/price IDs, website/operator HMAC keys, and
  provisioner tokens.

When a migration exception is required, put a JSON string of up to 1,000 unique
WorkOS `user_...` IDs in `HOSTED_ADMITTED_WORKOS_USER_IDS` in that target's
`cloud/backend/.wrangler/mesh/<worker-name>/vars.json`. Staging and Production
must use independently reviewed IDs; preflight rejects any ID present in both.
Remove each ID after the first Anvil billing row is created.

## Staging setup and rehearsal

Do all staging work first. Use disposable WorkOS identities and Stripe test mode.
The staging resources already recorded in `cloud/backend/hosted-targets.example.json`
are for acceptance testing; production remains incomplete in the ignored operator
manifest.

### 1. Configure WorkOS Staging

In the WorkOS Dashboard, select the **Staging** environment.

1. Open the Anvil website and desktop applications. Record the staging client IDs;
   the website client must match `staging.workos.hostedClientId`, and the desktop
   client must match `staging.workos.desktopClientId` in the local hosted-target
   manifest.
2. Register the staging website callback URL from
   `ANVIL_STAGING_WORKOS_REDIRECT_URI` and the appropriate local/deployed return
   URLs. Use the exact callback configured by the current website build. Keep
   local `http://localhost` callbacks in Staging only.
3. In **Authentication → Features**, enable the **Waitlist** for Staging. Existing
   users can still sign in; new self-service attempts should land on the waitlist.
4. Disable verified-domain automatic membership and SSO JIT provisioning. Verify
   no verified domain or connection can silently create a member outside the
   approved waitlist flow.
5. Configure the Staging invitation link/template to land at
   `https://<staging-website-origin>/invite?invitation_token=...`. This is the
   invite landing route, separate from the AuthKit OAuth callback above. The
   website preserves the token through sign-in so acceptance is checked against
   the same WorkOS identity.
6. Add a disposable staging email to the waitlist, approve it from **Users →
   Waitlist**, and finish signup using that same verified address. Keep the
   approved entry until its first Anvil account exists. Denying a request does
   not remove the address from the waitlist; revoke an issued invitation if
   approval must be withdrawn.
7. In **Authorization → Roles**, keep the seeded environment-level `member`
   role as the default. Create an environment-level role with the exact slug
   `admin` if one does not exist. The hosted backend maps local organization
   owners to `admin` and ordinary members to `member`. This is distinct from
   your WorkOS Dashboard team admin role and from organization-scoped custom
   roles; do not create an organization-scoped role for this mapping.

WorkOS waitlist entries are environment-scoped. Staging approval does not admit
the same person in Production.

### 2. Configure staging billing resources in Cloudflare

From `anvil-app/`, prepare the ignored operator manifest if it does not exist:

```sh
mkdir -p cloud/backend/.wrangler
cp -n cloud/backend/hosted-targets.example.json cloud/backend/.wrangler/hosted-targets.json
```

Keep the supplied staging account, Worker, URL, bucket, D1 ID, descriptor, and
WorkOS IDs. Before invoking provider operations, build the matching Anvil Cloud
CLI and validate the local staging plan:

```sh
cd ../anvil-cloud
pnpm --filter '@anvilstack/cloud-cli...' build
cd ../anvil-app/cloud/backend
pnpm install --ignore-workspace --frozen-lockfile
pnpm typecheck
pnpm test:hosted-deploy
node scripts/verify-hosted-config.mjs --self-check
cd ../..
pnpm --dir cloud/backend hosted:deploy -- --environment staging plan --json
```

The plan writes local generated configuration only. Review the selected Worker,
D1, R2, provisioner, WorkOS clients, and `HOSTED_BILLING_ENVIRONMENT=staging`
before continuing. All deployment commands below select the target through the
wrapper; do not choose a resource with a direct `wrangler` override.

The staging `baseUrl` is already known from the manifest. Before backend
provisioning, create the WorkOS webhook endpoint at that origin so its signing
secret is available to the deployment preflight. The Worker will begin handling
events after it is deployed and its secrets are installed.

```text
https://<staging-worker-host>/v1/hosted/workos-webhook
```

Subscribe to the membership and invitation lifecycle events:

```text
organization_membership.updated
organization_membership.deleted
invitation.accepted
invitation.revoked
organization.deleted
```

The handler verifies `WorkOS-Signature` against the raw request body before
processing. Keep delivery enabled; hourly reconciliation repairs missed or
reordered events. If the Dashboard offers a test delivery, send it after the
Worker has been deployed and its webhook secret installed.

Store the WorkOS Staging API key as `WORKOS_API_KEY` and that webhook endpoint's
`whsec_...` value as `WORKOS_WEBHOOK_SECRET` in the staging backend secret file.
The server uses its WorkOS key for organization, membership, invitation, and
waitlist admission checks. Do not use the website's WorkOS key as the operator
HMAC key.

Set up an independent staging provisioner when the release uses managed
environments. Then provision staging storage, apply the billing migration, and
deploy the Worker using the existing sequence in [deploy.md](deploy.md#deploy-staging).
Do not run these commands until the resulting plans name only staging resources.

After the staging Worker is deployed, use its manifest `baseUrl` as the staging
WorkOS and Stripe webhook origin. The WorkOS endpoint configured above can now
deliver to the deployed Worker.

The backend secret file named by `staging.secrets.backendFile` must contain these
keys when provisioning/applying the organisation-enabled backend:

```json
{
  "HOSTED_SERVICE_KEYS": "{\"website-staging\":\"<unique random secret of at least 32 bytes>\"}",
  "WORKOS_API_KEY": "<WorkOS Staging API key>",
  "WORKOS_WEBHOOK_SECRET": "<WorkOS Staging webhook signing secret>",
  "MANAGED_PROVISIONER_TOKEN": "<staging provisioner token, when provisioner is enabled>"
}
```

Keep the file under `.wrangler/`, restrict local access, and install it with:

```sh
pnpm --dir cloud/backend hosted:deploy -- --environment staging secrets --json
```

The operator-only `HOSTED_OPERATOR_KEYS` entry is optional until an operator
needs to set or clear a fair-use restriction. Its separate setup is below.

### 3. Create Stripe test prices and webhook

In Stripe Dashboard **test mode**, create these four recurring Prices. Use GBP;
amounts are in pence.

| Worker variable             | Product                   | Interval | Amount |
| --------------------------- | ------------------------- | -------- | -----: |
| `STRIPE_PRICE_SYNC_MONTHLY` | Anvil Personal            | Monthly  |    800 |
| `STRIPE_PRICE_SYNC_ANNUAL`  | Anvil Personal            | Yearly   |   8000 |
| `STRIPE_PRICE_TEAM_MONTHLY` | Anvil Team developer seat | Monthly  |    700 |
| `STRIPE_PRICE_TEAM_ANNUAL`  | Anvil Team developer seat | Yearly   |   7000 |

Copy each test-mode `price_...` ID into the staging Worker vars file at
`cloud/backend/.wrangler/mesh/<staging-worker-name>/vars.json`. Team checkout
must start at quantity five; Anvil owns the minimum-seat rule. Do not enable
customer-portal quantity changes that could reduce the subscription below the
assigned and reserved seat count. Manage seat capacity through Anvil.

Register a separate **test-mode** Stripe webhook endpoint:

```text
https://<staging-worker-host>/v1/hosted/stripe-webhook
```

Subscribe to the currently handled billing events:

```text
checkout.session.completed
checkout.session.expired
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.paid
invoice.payment_succeeded
invoice.payment_failed
```

Set the Stripe webhook endpoint API version to `2026-08-26.dahlia`, matching
`cloud/backend/src/hosted/stripe.ts`. The Stripe API calls and webhook payload
parsers are versioned together; do not use the account default if it differs.

Put the test secret key (`sk_test_...`) and this endpoint's signing secret as
`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in the staging backend secrets
file. The staging Worker must report `HOSTED_BILLING_ENVIRONMENT=staging` and
must receive only test-mode events (`livemode=false`). The deploy wrapper rejects
a live Stripe key in Staging and rejects Staging Price IDs reused in Production.

Use the staging website origin for the fixed Checkout success, cancel, and
portal-return URLs. In `vars.json`, set:

```json
{
  "HOSTED_CHECKOUT_ENABLED": "true",
  "HOSTED_ALLOW_EARLY_CHECKOUT": "true",
  "HOSTED_CHECKOUT_SUCCESS_URL": "https://<staging-website-origin>/account/billing?checkout=success",
  "HOSTED_CHECKOUT_CANCEL_URL": "https://<staging-website-origin>/account/billing?checkout=cancel",
  "HOSTED_PORTAL_RETURN_URL": "https://<staging-website-origin>/account/billing",
  "STRIPE_PRICE_SYNC_MONTHLY": "<staging-personal-monthly-price-id>",
  "STRIPE_PRICE_SYNC_ANNUAL": "<staging-personal-annual-price-id>",
  "STRIPE_PRICE_TEAM_MONTHLY": "<staging-team-monthly-price-id>",
  "STRIPE_PRICE_TEAM_ANNUAL": "<staging-team-annual-price-id>"
}
```

`HOSTED_ALLOW_EARLY_CHECKOUT=true` exists only to rehearse paid flows in
Staging before Halloween. It does not change preview access policy. The wrapper
rejects this key entirely in Production. Leave it out of production vars.

After adding the four Price IDs, test API key, and Stripe webhook secret to the
target vars and backend secret file, regenerate the config, install the secrets,
and deploy the staging checkout configuration:

```sh
pnpm --dir cloud/backend hosted:deploy -- --environment staging plan --json
pnpm --dir cloud/backend hosted:deploy -- --environment staging secrets --json
pnpm --dir cloud/backend hosted:deploy -- --environment staging apply --test-deployment --json
```

For the first staging test, create a Personal subscription with a Stripe test
card. Then create a staging organisation, purchase five developer seats, assign
one to an already-admitted user, and verify the receipt, active entitlement,
seat count, and five-device rule. Invite an existing admitted user using their
exact WorkOS identity; verify a new/unapproved address cannot join through an
organisation invitation. Verify removal releases a seat and removes sponsored
access while leaving the member's own account data intact.

Verify every Stripe webhook delivered to Staging has `livemode=false`; verify
WorkOS staging webhook events are signed with the Staging endpoint secret. Run
the [staging acceptance](staging-acceptance.md) suite. The backend reconciles
WorkOS changes hourly if delivery is missed, so WorkOS membership removal is not
a hard 60-second revocation guarantee. Do not claim a shorter propagation time
than the tested cache and reconciliation behavior.

## Production setup after staging passes

Do not promote staging identities or credentials. WorkOS cannot copy staging
users and organisations to Production; production users sign in again after
Production waitlist approval.

### 4. Configure WorkOS Production

In the WorkOS Dashboard, select **Production** and unlock the environment if
WorkOS requires production billing details. Configure a new Production website
client and desktop client. Do not reuse either staging client ID. Set the
Production website callback to the HTTPS callback configured by the production
website; set the invitation link/template to land at
`https://<production-website-origin>/invite?invitation_token=...`. This invite
landing route is separate from the OAuth callback, and the website must preserve
the token through AuthKit sign-in.

Enable the Production AuthKit waitlist. Disable verified-domain automatic
membership and SSO JIT. Do not issue standalone WorkOS invites to prospective
users; approve Production waitlist entries and require the invitee to use that
approved email address. Retain approved entries until each user's first Anvil
account has been linked. Keep team invitations limited to an existing admitted
WorkOS identity. In **Authorization → Roles**, keep the seeded environment-level
`member` role as the default and create an environment-level role with exact slug
`admin` if absent. The backend maps local owners to `admin` and members to
`member`. Do not substitute a WorkOS Dashboard team role or an
organization-scoped custom role.

Create the Production WorkOS API key and store it immediately in the protected
production secrets source; WorkOS displays it only once. Never copy the staging
waitlist entry, key, client, organisation, or webhook secret into Production.

For a deliberate migration exception for an existing WorkOS user who has no
Anvil billing-account row and no approved waitlist entry, add only that
environment's reviewed WorkOS `user_...` ID to
`HOSTED_ADMITTED_WORKOS_USER_IDS` in the generated Worker vars. For example:

```json
{
  "HOSTED_ADMITTED_WORKOS_USER_IDS": "[\"user_01...\",\"user_02...\"]"
}
```

This is an exact-ID backfill list, not a general signup bypass. The backend
re-reads each identity from Production WorkOS and requires `email_verified=true`;
it does not accept an email from the client or config. Review and approve each
exception before adding it. Once the user's first Anvil billing row exists,
remove that ID from the list and redeploy. Keep Staging and Production lists
separate. This gives existing identity holders a concrete path without
grandfathering every WorkOS user into preview access.

### 5. Configure the Production Cloudflare target

Edit only the ignored operator manifest
`cloud/backend/.wrangler/hosted-targets.json`. Complete the Production entry
with a unique Cloudflare Worker name and HTTPS URL, R2 bucket, D1 database name,
descriptor ID/name, WorkOS Production client IDs, and secret-file paths. Use a
separate Cloudflare account if available; otherwise keep every resource name and
ID unique within the account. Leave `databaseId` null until the Production
`provision` command creates it.

Prepare a production-only secret file with the Production WorkOS API and webhook
secrets, a new website HMAC secret, and the live Stripe secrets only after they
are created. Set `HOSTED_BILLING_ENVIRONMENT=production` through the generated
target vars. Keep checkout disabled until 1 November 2026. Never set
`HOSTED_ALLOW_EARLY_CHECKOUT` in Production.

If individually reviewed existing WorkOS users need a migration exception,
populate only their Production user IDs in the generated Production Worker vars:

```json
{
  "HOSTED_ADMITTED_WORKOS_USER_IDS": "[\"user_01...\",\"user_02...\"]"
}
```

Use a JSON string containing at most 1,000 unique `user_...` IDs. Do not put
emails or new waitlist applicants here. IDs are resolved against the selected
Production WorkOS API and must still be verified. Keep this list separate from
Staging; preflight rejects an ID present in both environments. Remove each ID
after the first Anvil billing-account row is created. An empty or absent list is
preferred when no migration exceptions are needed.

Review a production plan before any provider operation:

```sh
pnpm --dir cloud/backend hosted:deploy -- --environment production plan --json
```

After the plan confirms the Production `baseUrl`, create a WorkOS Production
webhook endpoint at:

```text
https://<production-worker-host>/v1/hosted/workos-webhook
```

Subscribe to the same five membership and invitation lifecycle events listed
for Staging. Store this endpoint's `whsec_...` value beside the Production
`WORKOS_API_KEY` in the protected backend secret file before running
`provision`, `migrate`, or `apply`; preflight requires both WorkOS secrets.

Production must remain blocked until its target, secret file, WorkOS clients,
staging-vs-production uniqueness checks, and release evidence are complete. Then
use the guarded production commands in
[deploy.md](deploy.md#configure-production-deployment), in this order:

1. Plan and provision the production provisioner if used.
2. Plan the backend and provision the Production D1/R2 resources.
3. Apply hosted billing migrations to the Production D1 database.
4. Apply the Production Worker and install only Production secrets.
5. Check the descriptor, login, waitlist admission, invitation acceptance,
   billing overview, and webhook deliveries before enabling checkout.

Never apply a staging D1 migration against the production database, and never
use a staging `wrangler.jsonc`, `vars.json`, WorkOS client, or Stripe endpoint
for a Production release.

### 6. Create Stripe live prices and webhook

In Stripe Dashboard **live mode**, recreate the same four GBP recurring Prices
and amounts from the staging table. Stripe test and live Prices have separate
IDs. Copy only the live `price_...` IDs to the Production Worker vars. The
deployment wrapper rejects copied staging IDs and requires staging prices to
exist for comparison before Production checkout can be enabled.

Create a live Stripe webhook at:

```text
https://<production-worker-host>/v1/hosted/stripe-webhook
```

Subscribe only to the billing events listed for staging. Store the live
`sk_live_...` key and this endpoint's `whsec_...` signing secret in the
Production backend secrets file. The wrapper rejects test keys and a configured
`STRIPE_API_BASE` override in Production. The backend must reject a webhook whose
event `livemode` does not match `HOSTED_BILLING_ENVIRONMENT`.
Set its API version to `2026-08-26.dahlia`, the same version as the Stripe API
requests and Staging endpoint.

Add the four Production Price IDs and fixed Production website return URLs to
the Production generated vars. Keep checkout explicitly disabled while
installing the live Stripe key and webhook secret:

```json
{
  "HOSTED_CHECKOUT_ENABLED": "false",
  "HOSTED_CHECKOUT_SUCCESS_URL": "https://<production-website-origin>/account/billing?checkout=success",
  "HOSTED_CHECKOUT_CANCEL_URL": "https://<production-website-origin>/account/billing?checkout=cancel",
  "HOSTED_PORTAL_RETURN_URL": "https://<production-website-origin>/account/billing",
  "STRIPE_PRICE_SYNC_MONTHLY": "<production-personal-monthly-price-id>",
  "STRIPE_PRICE_SYNC_ANNUAL": "<production-personal-annual-price-id>",
  "STRIPE_PRICE_TEAM_MONTHLY": "<production-team-monthly-price-id>",
  "STRIPE_PRICE_TEAM_ANNUAL": "<production-team-annual-price-id>"
}
```

Then regenerate the config, install Production secrets, and apply the vars with
the Production evidence reference:

```sh
pnpm --dir cloud/backend hosted:deploy -- --environment production plan --json
pnpm --dir cloud/backend hosted:deploy -- --environment production secrets --json
pnpm --dir cloud/backend hosted:deploy -- --environment production apply --evidence "$PRODUCTION_EVIDENCE" --json
```

Keep `HOSTED_CHECKOUT_ENABLED` false throughout the free preview. At
`2026-11-01T00:00:00Z`, after confirming staging acceptance and the Production
launch checklist, enable checkout for Production with the four live Price IDs
and Production-only return URLs. Run the same `plan`, `secrets`, and `apply`
sequence above after changing the flag to `true`. Users choose Personal or an
organisation owner buys seats; preview access never becomes a paid subscription
without an explicit Checkout action.

Set the configured tax behavior and customer-facing total before enabling live
checkout. The proposed prices are GBP base amounts; the displayed total must
make clear how applicable taxes are handled. Do not use a staging tax setting
as evidence for Production.

## Fair-use operator actions

The operator endpoint is independent of the website's billing service key. If
staff need to inspect or change a fair-use restriction, add a separate random
key of at least 32 bytes under `HOSTED_OPERATOR_KEYS` in the selected
environment's backend secret file:

```json
{
  "HOSTED_OPERATOR_KEYS": "{\"ops-staging\":\"<unique operator-only random secret of at least 32 bytes>\"}"
}
```

It must not reuse any value in `HOSTED_SERVICE_KEYS`, in the same environment
or across staging and Production. It is never placed in website/Vercel settings.
Install the secret through the selected deployment target:

```sh
pnpm --dir cloud/backend hosted:deploy -- --environment staging secrets --json
```

From `anvil-app/cloud/backend`, query status using the personal sync account ID
(not a WorkOS user ID, billing row ID, or organisation ID). Always supply both
the target environment and the local target manifest explicitly:

```sh
node scripts/hosted-fair-use.mjs --environment staging --manifest .wrangler/hosted-targets.json --account '<personal-sync-account-id>' --action status
```

For a normal notice, put the reason and message in a protected JSON file. Set
`restrictAt` at least seven days in the future, in canonical ISO UTC form:

```json
{
  "code": "storage-usage",
  "message": "Please reduce retained hosted data by the date shown.",
  "restrictAt": "2026-10-31T12:00:00.000Z"
}
```

Then explicitly select the environment and local file:

```sh
node scripts/hosted-fair-use.mjs --environment staging --manifest .wrangler/hosted-targets.json --account '<personal-sync-account-id>' --action set --body-file .wrangler/fair-use-notice.json
```

The CLI signs the request for the `anvil-hosted-operator` audience using only
`HOSTED_OPERATOR_KEYS`; it does not call email services. Use `--confirm-emergency`
only for an explicitly approved immediate service-protection restriction with
`"emergency": true` and a `restrictAt` within five minutes of now. To clear a
restriction after resolving the cause:

```sh
node scripts/hosted-fair-use.mjs --environment staging --manifest .wrangler/hosted-targets.json --account '<personal-sync-account-id>' --action clear
```

Record the action in the support case, including target environment and returned
status, without recording key values or private sync content. The service audits
the operator key ID and action; the notice message is not mailed to the user.

## Provider references

- [WorkOS Waitlist](https://workos.com/docs/authkit/waitlist) and
  [invite-only signup](https://workos.com/docs/authkit/invite-only-signup)
- [WorkOS invitations](https://workos.com/docs/authkit/invitations),
  [AuthKit application redirects](https://workos.com/docs/authkit/applications), and
  [Staging vs. Production environments](https://workos.com/docs/authkit/environments)
- [WorkOS webhook setup and signature verification](https://workos.com/docs/events/data-syncing/webhooks)
- [Cloudflare Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/),
  [D1 environments](https://developers.cloudflare.com/d1/configuration/environments/),
  and [D1 migrations](https://developers.cloudflare.com/workers/wrangler/commands/d1/)
- [WorkOS environment roles](https://workos.com/docs/rbac/configuration),
  [organization membership roles](https://workos.com/docs/fga/standalone-integration),
  and [Stripe webhook API versions](https://docs.stripe.com/api/webhook_endpoints)
- [Stripe subscription quantities and seats](https://docs.stripe.com/billing/subscriptions/metered-billing/thresholds),
  [subscription updates and proration](https://docs.stripe.com/api/subscriptions/update),
  [subscription schedules](https://docs.stripe.com/api/subscription_schedules), and
  [webhook endpoints](https://docs.stripe.com/webhooks)
