# Hosted beta codes and paid signup

Anvil Desktop and self-hosted Sync & Mesh carry no Anvil subscription charge.
The Anvil-operated backend can enable
`HOSTED_BILLING_ENFORCEMENT=true`; hosted writes then require a confirmed paid
subscription or team seat, or an unexpired redeemed beta code. Staging keeps
checkout disabled and uses beta codes for testers.

## Invite a tester

1. Apply all `cloud/backend/migrations/hosted-billing` migrations, including
   `0006_beta_codes.sql`, through the selected-target deployment procedure.
2. Leave `HOSTED_CHECKOUT_ENABLED=false`. Stripe is optional for code-only beta.
3. Approve the tester's verified email on this environment's WorkOS waitlist.
   Admission permits sign-in but does not grant Sync or Mesh writes.
4. From `anvil-app/cloud/backend`, generate a code with explicit UTC deadlines:

   ```sh
   node scripts/create-beta-code.mjs --redeem-until <ISO-date> --access-until <ISO-date>
   ```

5. Apply the emitted SQL to the selected hosted D1 database using the existing
   operator deployment credentials. Only the hash goes in D1. Send the raw code
   to the tester privately, with its access expiry and the `/account/billing` URL.
   Do not commit codes, paste them into tickets, or save them in application logs.
6. The tester signs in and redeems the code. No payment method is required.

The code is bound atomically to its first redeemer. That account can retry without
extending access; another account cannot use it. Unredeemed codes expire at
`redeem_until`. Redeemed access ends at `access_until`, even if redemption closes
earlier. To revoke a code, set `revoked_at` to the current Unix time in milliseconds
for its `code_hash` in the selected database. The next write checks the new state.
Do not alter `preview_eligible`: the old global preview grants no access.

## Open paid signup later

This code change does not deploy anything or open checkout. Before launch, verify
Stripe webhooks, reconciliation, return URLs and cancellation in the selected
environment. Configure these nonsecret Worker variables:

- `STRIPE_PRICE_SYNC_MONTHLY` and `STRIPE_PRICE_SYNC_ANNUAL`, GBP £6 and £60.
- `STRIPE_PRICE_TEAM_MONTHLY` and `STRIPE_PRICE_TEAM_ANNUAL`, GBP £12 and £120 per seat.
- `HOSTED_CHECKOUT_SUCCESS_URL`, `HOSTED_CHECKOUT_CANCEL_URL` and
  `HOSTED_PORTAL_RETURN_URL`, all fixed HTTPS URLs returning to account billing.

Install matching-environment `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` as
secrets. Only then set `HOSTED_CHECKOUT_ENABLED=true` in the reviewed target vars.
Automatic staging CI deliberately keeps checkout off. Use a separate reviewed
test deployment for paid checkout acceptance. Never reuse staging credentials
or prices in production.

Checkout redirects do not grant access. Only a confirmed paid invoice advances
`paid_through` and paid seat quantity. Team checkout requires an active owner and
5 to 50 seats. Membership is not shared workspace access. Existing subscriptions
remain manageable through the portal; this rollout does not cancel or refund them.
