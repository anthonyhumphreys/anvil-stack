# Staging website deployment

The staging website is https://staging.anvilstack.dev. It belongs to the existing
Vercel `anvil-stack` project, with root directory `anvil-website`.

## Branch routing

- `main` remains the Vercel production branch for `anvilstack.dev`.
- `develop` is the Preview branch assigned to `staging.anvilstack.dev`.
- PR #91 targets `develop`. The branch was created from `main` at
  `54b55e7d84ee4c7a0156f16a71e99f1eb6fc3b42` on 30 September 2026.
- During setup, the staging domain was assigned to the existing READY Preview
  deployment of `feature/sync-mesh--foundations`, commit
  `eb8b47547f5e0075f9542f372a0917a7eb03d787`. Its domain branch was then changed to
  `develop`. The current feature deployment remains served until a subsequent
  successful `develop` deployment replaces it.

After merging PR #91, Vercel's Git integration builds `develop` and assigns its
successful Preview deployment to the staging domain. Subsequent pushes to
`develop` follow the same path. Website CI also runs on pushes to `develop`.
Other feature branches retain their separate Preview URLs.

Cloudflare currently proxies the staging hostname. HTTPS returned 200 during
setup. Vercel reports "Proxy Detected" rather than a direct DNS configuration.
No DNS records or Cloudflare security settings were changed.

## Hosted account configuration

On 2 October 2026, the website's staging credentials were installed in Vercel
Preview settings, scoped to `develop` and `feature/sync-mesh--foundations`.
The API key, cookie password, and hosted service secret are marked sensitive.
The staging HTTPS callback was registered in WorkOS while preserving localhost.
Serving the website does not verify account signup or billing. A fresh deployment
and signed-in acceptance are still required. Do not import the combined backend environment.

Use `ANVIL_DEPLOYMENT_ENV=staging` and these website variables from the
`Anvil hosted staging` 1Password Environment:

- `ANVIL_STAGING_WORKOS_API_KEY`
- `ANVIL_STAGING_WORKOS_CLIENT_ID`
- `ANVIL_STAGING_WORKOS_COOKIE_PASSWORD`
- `ANVIL_STAGING_BACKEND_ORIGIN`
- `ANVIL_STAGING_HOSTED_KEY_ID`
- `ANVIL_STAGING_HOSTED_SERVICE_SECRET`

Set `ANVIL_STAGING_WORKOS_REDIRECT_URI` on Vercel to
`https://staging.anvilstack.dev/auth/callback`. Retain the localhost redirect in
the local development environment. Register the HTTPS callback with the WorkOS
staging website application and configure its invitation URL as
`https://staging.anvilstack.dev/invite`.

Redeploy after changing environment variables. Verify signed-out `/account`
redirects to the staging WorkOS client with the staging HTTPS callback, then
rehearse waitlist approval, signup and account creation. Stripe webhook secret
installation and checkout acceptance remain separate pending work.
