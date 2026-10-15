# Hosted access incidents

Only Anvil-hosted Sync & Mesh requires paid or beta access. Self-hosted deployments
leave `HOSTED_BILLING_ENFORCEMENT` off and do not contact Anvil billing.

## Access decisions

Hosted writes require a confirmed paid invoice covering the current period,
an assigned paid team seat, or a redeemed unexpired beta code. The old global
preview deadline and `preview_eligible` flag do not grant access. Checkout
completion alone does not prove payment. A subscription without a paid invoice
does not grant access, even if Stripe reports it as active or trialing.

Failed renewals have at most seven days of grace, bounded by the paid period
and the first failure. Retry events cannot restart the clock. Provider-outage
grace needs recent stored payment evidence and lasts at most 24 hours. A D1
failure or missing billing binding fails closed; never manufacture free access.

The backend gates mutations before dispatch. Reads, exports, device revocation,
account deletion and recovery operations remain available. Local work is not
subject to hosted billing. Account deletion, device limits, session validity,
trust and operator fair-use restrictions remain separate checks.

## Investigate a denied write

1. Record versions, account scope, operation, HTTP status and denial reason.
   Do not collect tokens, beta codes, keys or payloads.
2. For `subscription-required`, inspect the stored paid period, paid invoice
   flag and assigned team seat, or the redeemed code's expiry and revocation.
   Waitlist approval is admission, not an entitlement. Send invited testers to
   `/account/billing` to redeem their code.
3. For `billing-unavailable`, restore D1 and verify migrations. Do not disable
   enforcement on a hosted deployment to work around an outage.
4. For `device-limit-exceeded`, revoke unused devices. Buying another
   subscription does not bypass the configured limit.
5. For lifecycle, session, trust or fair-use denials, follow that recovery path.
   Never undo a deliberate revocation or deletion as a billing repair.
6. Reconcile provider truth through the account controls and retry. Do not
   mark invoices paid manually or change timestamps to extend access.

See [beta access](beta-access.md) for issuing and revoking codes, and
[deploy](deploy.md) for target isolation. No live billing mutations, invitations,
cancellations or refunds are authorized merely by this code rollout.

Anvil-operated compute remains separately controlled by
`ANVIL_CLOUD_AGENTS_ENABLED`, default off. A Sync subscription does not supply
model credits or enable managed compute. BYO hosts still use their own provider
accounts; hosted Mesh coordination requires the same entitlement as hosted Sync.
