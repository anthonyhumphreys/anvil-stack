# Staging website

The staging site is `https://staging.anvilstack.dev` in the existing Vercel
`anvil-stack` project, rooted at `anvil-website/`. The `develop` branch owns
the staging hostname. Pull requests receive Vercel Preview deployments; use
the preview for the exact candidate SHA under test.

## Match the website candidate

Before signed-in acceptance, record the Vercel deployment URL and its full
source SHA. It must match the backend and desktop candidate. A successful
website deployment on another branch or commit is not evidence for this
candidate.

The WorkOS staging website is configured with the callback
`https://staging.anvilstack.dev/auth/callback`. A PR preview may redirect back
to that staging hostname. Confirm the callback lands on the exact candidate
build before signing in. If it returns to a different commit, mark website
acceptance `BLOCKED` until the staging alias or approved callback setup serves
the candidate. Do not use a production WorkOS application to bypass this
check.

Use the staging-only `ANVIL_STAGING_*` variables from the protected Vercel
Preview environment. The website needs:

- `ANVIL_STAGING_WORKOS_API_KEY`
- `ANVIL_STAGING_WORKOS_CLIENT_ID`
- `ANVIL_STAGING_WORKOS_COOKIE_PASSWORD`
- `ANVIL_STAGING_BACKEND_ORIGIN`
- `ANVIL_STAGING_HOSTED_KEY_ID`
- `ANVIL_STAGING_HOSTED_SERVICE_SECRET`
- `ANVIL_STAGING_WORKOS_REDIRECT_URI`

The WorkOS client and backend origin must match the selected staging target.
Keep staging credentials out of production and never copy backend secrets to
Vercel. Secret values must not appear in logs, command output, or the
acceptance record. Redeploy the Preview after changing its environment.

## Signed-in smoke check

Use a newly created disposable staging identity. Confirm the staging callback
completes and that `/account`, `/account/devices`, `/account/billing`, and
`/account/data` load under the same identity used by the two desktop devices.
An unauthenticated redirect or a rendered page does not prove the signed-in
account flow. Record the result in
[staging acceptance](staging-acceptance.md).

Sync and Mesh do not require Stripe configuration. Do not enable checkout or
add payment steps to the staging website acceptance.
