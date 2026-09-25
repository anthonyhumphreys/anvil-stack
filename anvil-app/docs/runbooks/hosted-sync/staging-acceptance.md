# Hosted Sync staging acceptance

Run this against the deployed staging backend and the exact desktop/website
release candidate under review. It covers shared identity, two physical
desktops, device lifecycle, browser approval/reconnection, managed capacity,
Stripe test mode, and deletion. For the deeper manual trust, recovery, and
iPhone companion scenarios, continue with the [four-device test plan](four-device-test-plan.md).

Do not use a production WorkOS account, production Stripe key, existing
customer account, or valuable sync data. Account deletion at the end of this
run is intentionally destructive: use a disposable staging WorkOS identity
created only for this test. The website does not delete local desktop data.

## Result labels and prerequisites

Record `PASS`, `FAIL`, or `BLOCKED` for each gate. A skipped test, local mock,
fixture, screenshot, or successful Worker upload is not a pass for deployed
acceptance. Record the blocker when access or hardware is unavailable.

Required for the gates below:

- **Cloudflare access:** Wrangler account access to the staging Worker, D1,
  R2, and provisioner. If missing, deployment, log, D1, and managed-capacity
  gates are **BLOCKED**.
- **WorkOS access:** staging website and desktop client configuration plus a
  disposable staging user. Without it, signed-in website/device gates are
  **BLOCKED**. Never substitute a production user.
- **Two physical desktop devices:** install/run the same candidate on Device
  A and Device B. Two profiles or data directories on one host do not pass
  the device gate. Without a second physical machine, device-to-device
  behavior is **BLOCKED**.
- **Stripe test-mode access:** staging Price IDs, test-mode key, webhook
  signing secret, and an operator able to view Stripe test deliveries.
  Without them, checkout/webhook gates are **BLOCKED**; keep checkout
  disabled.
- **Managed capacity:** the staging provisioner, container image, token, and
  Cloudflare Containers access. Without these, environment provisioning is
  **BLOCKED**.

No one needs to share credentials in the test record. Record variable names,
account/environment labels, test result, and masked resource IDs only.

## Capture the release candidate

Start at the monorepo root and save a small sanitized record in the existing
change or acceptance ticket:

```sh
git rev-parse HEAD
git status --short
```

For the website, also record the Vercel preview deployment URL and commit
SHA, or the local website commit and that `pnpm dev` was used. For the
backend, record the Cloudflare Worker name, the version shown by
`wrangler deployments list`, and the migration list. Do not paste `.env`,
`vars.json`, secret files, session tokens, device codes, or full logs into the
record.

Check the deployed descriptor before signing in:

```sh
export MESH_ORIGIN='https://anvil-sync-hosted-staging.still-glitter-7d20.workers.dev'
export DESCRIPTOR_FILE="$(mktemp)"
curl -fsS "$MESH_ORIGIN/.well-known/anvil-backend" > "$DESCRIPTOR_FILE"
jq -e '
  .descriptorVersion == "anvil-backend/1" and
  (.profiles | index("sync/1")) and
  (.profiles | index("mesh/1")) and
  (.authModes | index("workos-device")) and
  .auth.issuer == "https://api.workos.com/user_management" and
  .auth.publicClientId == "client_01M2XPX4PF98H2P7HCNRBZATTE"
' "$DESCRIPTOR_FILE"
```

Stop the WorkOS-device test if the check fails. `enrollment-code` by itself
does not prove the WorkOS identity path required here. Record only the
descriptor fields, not enrollment or session secrets.

For a local staging website and desktop, load the staging-only settings from
the protected local environment file, then run:

```sh
cd anvil-website
ANVIL_DEPLOYMENT_ENV=staging pnpm dev
```

In another terminal:

```sh
cd anvil-app
ANVIL_DEPLOYMENT_ENV=staging ANVIL_HOSTED_BACKEND_URL="$MESH_ORIGIN" pnpm dev
```

Keep `ANVIL_DEPLOYMENT_ENV=staging` explicit. Website local sign-in needs its
staging `ANVIL_STAGING_*` variables; desktop device sign-in uses the staging
public client advertised by discovery. Do not print these variable values.
For a deployed candidate, use the GitHub `anvil-staging` build and website
preview configured for staging instead of these local commands.

## Website and two-device identity

1. On the website, sign in with the disposable staging WorkOS user and open
   `/account`, `/account/devices`, `/account/billing`, and `/account/data`.
   Each page must load without a not-configured or signed-service error.
2. On Device A, sign in to the hosted staging backend with the same WorkOS
   user. On Device B, use a second physical machine and sign in with that same
   user and WorkOS device client. Complete device trust approval if prompted.
   Do not use the website-generated enrollment code for this identity check;
   it would prove code enrollment but bypass the desktop WorkOS client.
3. Reload `/account/devices`. Both physical devices must appear under the
   website identity just used, with active status. Confirm harmless test data
   created on A syncs to B. Use a name such as `sync-acceptance-<date>` and
   delete it when the test ends.
4. From `/account/devices`, revoke B. Within the documented attestation
   cache window (up to 60 seconds), B must lose hosted access while local
   data remains available. Pair B again using a fresh code or the hosted
   WorkOS flow; confirm it returns as an active device and sync resumes.
   Never reuse the revoked session as proof of reconnection.

Pass only when the website and both physical devices show the same staging
account, the revoked device loses hosted access, and a fresh enrollment
reconnects.

## Browser dashboard approval and reconnection

1. In a fresh private browser profile, sign in to the same staging user and
   open `/account/dashboard`. It must stay locked until a device approves it.
2. On Device A, open **Settings → Sync & Mesh → Browser dashboard access**.
   Deny one pending request. The browser must remain locked.
3. Request access again and approve only **Read dashboard**. Confirm the
   browser displays the permitted sealed projection. Reload that same tab;
   it must reconnect without gaining broader scope.
4. Revoke the active browser grant from Device A. The browser must lock again
   and requests/actions must stop. Request and approve a new read-only grant
   once more to prove a fresh grant reconnects.

Record each state transition and the scope selected. Do not record dashboard
content or browser session material.

## Managed environment execution and teardown

On the source desktop, make sure the daemon or desktop Mesh worker is signed
into the same staging account and explicitly enabled as a worker. The
provisioner and image must already be deployed; see [deploy.md](deploy.md).
Build the daemon if needed, then request a short-lived environment:

```sh
cd anvil-app
TEST_SUFFIX="$(date -u +%Y%m%dT%H%M%SZ)"
pnpm run build:daemon
node dist-daemon/anvil-daemon.mjs env request anvil-managed --ttl 600 \
  --name "sync-acceptance-$TEST_SUFFIX"
node dist-daemon/anvil-daemon.mjs env list
```

Save the returned `environmentId` and `jobId` in the test record. The
`provision-environment` job must complete, the environment must report
`enrolled`, and the container must show as a live ephemeral Mesh worker. Then
dispatch a harmless, bounded remote job targeted to that environment and
confirm its completed result. Do not use a real repository secret or an
untrusted manifest command.

The current cloud-environment plan marks environment request/observe UI as
unfinished. If the candidate exposes no way to target a harmless job to the
environment, record **managed job execution: BLOCKED (no supported target
UI)**. The provision job reaching `enrolled` is only provisioning evidence,
not proof that a user job ran.

Terminate the environment even after a failed job:

```sh
node dist-daemon/anvil-daemon.mjs env terminate '<environmentId>'
node dist-daemon/anvil-daemon.mjs env list
node dist-daemon/anvil-daemon.mjs env list --all
```

The result must be `terminated`/`reaped: true`; `terminating` means teardown
has only been requested. Keep the worker online and recheck `env list --all`
until the backend reports terminal state. Verify the corresponding Cloudflare
Sandbox/container resource is gone in the Cloudflare dashboard. Record the
verified final state and resource ID, then stop the daemon. Do not remove the
provisioner while this environment remains active or terminating.

## Stripe test-mode checkout

Follow [deploy.md → Enable Stripe checkout](deploy.md#enable-stripe-checkout)
to configure test-mode prices, secret files, and the staging webhook. Use
[Stripe's test card reference](https://docs.stripe.com/testing) for supported
payment outcomes and the [Test Clock API](https://docs.stripe.com/api/test_clocks)
for clock-driven lifecycle coverage. Test actual Checkout Sessions opened
from `/account/billing`; synthetic
`stripe trigger` fixtures without the mapped customer do not prove that the
website account receives the right entitlement.

For each case, retain the Stripe test event ID, delivery HTTP status, and
website billing result. Never copy card information, checkout URLs, or secret
values into the evidence record.

1. **Successful monthly and annual purchase:** use Stripe's `4242 4242 4242
   4242` test card and a future expiry. Complete Checkout for each interval.
   Confirm webhook deliveries return 2xx and the same website account shows
   active access. The selected Price IDs must belong to the staging Stripe
   test account.
2. **Authentication-required payment:** use the Stripe 3DS-success card
   `4000 0000 0000 3220`. Complete the browser challenge, then verify the
   subscription and access state. A checkout abandoned before challenge
   completion must not grant paid access.
3. **Failed initial payment:** use Stripe's generic-decline card
   `4000 0000 0000 0002`. Confirm Checkout reports the decline and the
   website does not grant active access. A declined first Checkout attempt is
   not the renewal-failure/grace test.
4. **Cancel at period end and immediate cancel:** use **Manage billing** to
   exercise both cancellation choices. Confirm Stripe's subscription state,
   delivered event, and website billing state agree; click **Reconcile now**
   and confirm the result stays aligned.
5. **Duplicate delivery:** resend one completed event from Stripe Dashboard
   → Developers → Events. Expect a 2xx duplicate response and no duplicate
   subscription or entitlement. Abandon a separate Checkout Session and
   confirm it expires without granting paid access. To avoid the default
   wait for expiry, expire the still-open session with Stripe's
   [Checkout Session expire API](https://docs.stripe.com/api/checkout/sessions/expire)
   using the staging test key from the protected credential store; otherwise
   wait for its expiry event before recording this case as passed. Record the
   Session ID only, never its checkout URL.

The monthly/yearly checkout integration creates its Stripe customer itself
without a `test_clock` field. Stripe Test Clocks attach to new customers;
they cannot be added to the customer this checkout flow already created.
Therefore clock-driven renewal failure → grace → recovery, unpaid/paused
states, and fast renewal cadence cannot be proven end-to-end against the
website account with the current flow. Record those lifecycle cases as
**BLOCKED (requires a test-only clock-bound customer path)**; do not substitute
unmapped `stripe trigger` payloads or mark this checklist complete. This
limitation does not block the interactive payment, webhook, cancellation, or
reconciliation cases above.

If the unsigned webhook smoke check returns `404`, stop Stripe acceptance;
use the deployment guide to check target secrets and bindings. If deliveries
return 5xx, follow [webhook-failures.md](webhook-failures.md).

## Hosted account deletion

Use the disposable account created for this rehearsal only. First confirm
both test devices and browser session contain no data worth retaining. In
`/account/data`, type `delete my hosted data` and select **Delete hosted
data**. Confirm the page reports deletion scheduled/completed, then refresh
the data status until it reports `deleted`. The paired devices must lose
hosted access; local data on each desktop remains untouched. Late Stripe
events must not make the deleted account active again.

Verify backend lifecycle using a scoped D1 read. Set `CONFIG` and
`DATABASE_NAME` as in [rollback.md](rollback.md), and use the disposable
WorkOS user ID from the authorized test setup:

```sh
pnpm exec wrangler d1 execute "$DATABASE_NAME" --remote --config "$CONFIG" \
  --command "SELECT lifecycle FROM billing_accounts WHERE workos_client_id = 'client_01M27GDYFBX70F16V6ZQ74KSDE' AND workos_user_id = '<disposable-staging-user-id>';"
```

The result must be `deleted`. Repeating the delete/status request must not
resurrect the account; a late webhook must not restore access. Do not delete
the WorkOS test user or Stripe customer until the evidence has been recorded.
The Stripe subscription is a separate provider object: confirm its test
subscription is canceled, and record any follow-up manual cancellation if it
was not automatically canceled.

## Close-out

Record one result row per gate with the date, candidate commit/deployment,
operator, result, evidence link, and blocker/failure. Include the backend
Worker version and D1 migration list. Keep Stripe checkout disabled after
the test unless the separate launch approval is complete. Delete only the
disposable Stripe test data and test WorkOS identity when the record is
complete; preserve shared staging infrastructure and its migrations.
