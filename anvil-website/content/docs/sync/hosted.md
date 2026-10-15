---
title: Anvil-hosted sync
navTitle: Anvil-hosted sync
description: Availability and planned pricing for hosted Sync & Mesh, plus sign-in, account controls and current billing behaviour.
product: Anvil Sync & Mesh
section: Reference
journey: reference
order: 110
---

# Anvil-hosted sync

With Anvil-hosted Sync & Mesh, we run the backend for you. The planned price is
£6 a month for one person or £12 per member for teams. Hosted access is invite-only.
Join the [waitlist](/waitlist); invited beta testers receive a code to redeem without
a payment method. See [pricing](/pricing) for the proposed plans.

You can also run the same backend yourself, from `anvil-app/cloud/backend`,
without paying Anvil. Your infrastructure provider bills you for the resources
you use. A self-deployed backend handles its own identity and account controls.

The desktop has a hosted mode when `ANVIL_HOSTED_BACKEND_URL` is configured
with an HTTPS backend origin. The development spike is a separate fixture and
is enabled only for an unpackaged build with `ANVIL_ENABLE_SYNC_SPIKE=1`.
Neither setting is evidence that a production hosted service is available;
production provisioning and its operational credentials remain pending.

## Identity

The website `/account` area uses a WorkOS browser session. It calls the
backend through the separately configured, signed hosted service channel.
Desktop enrollment follows the issuer and auth mode advertised by the
validated backend, then completes browser sign-in. New hosted accounts use
automatic connection by default; a trusted device must be online to deliver
the account key. Hosted OIDC uses issuer
`https://api.workos.com/user_management`, the desktop public `OIDC_CLIENT_ID`,
and scopes `openid profile`. The website's `WORKOS_CLIENT_ID` is also supplied
to the hosted Worker as `HOSTED_WORKOS_CLIENT_ID` when those clients differ.
The WorkOS website cookie is not a desktop credential, and the desktop's
device key is not sent to the website. Self-hosted backends declare their own
issuer (`--oidc-issuer` at plan time) or use enrollment-code bootstrap; they
do not use the hosted WorkOS service channel.

Headless daemons use WorkOS Device Authorization when the backend advertises
`workos-device`:

```sh
anvil-daemon sign-in --api-url https://<backend>
```

The command prints WorkOS's public verification URI and user code. Open the
URI in a browser on another device, enter the user code, then let the daemon
poll until approval or the bounded authorization lifetime ends. It does not
open a browser and does not use a loopback redirect. Configure the
descriptor's `auth.publicClientId` as a WorkOS public client with Device
Authorization enabled. A client secret and WorkOS API key stay on the backend;
the daemon receives neither. See the [WorkOS CLI Auth documentation](https://workos.com/docs/authkit/cli-auth).

To sign in:

- **Desktop:** In a configured build, open onboarding or Settings → Sync & Mesh
  and choose **Sign in to Anvil**. Anvil discovers and validates the service
  before browser sign-in; a changed address or issuer needs review. The callback is
  `http://127.0.0.1:<ephemeral-port>/callback`; the desktop chooses an
  ephemeral port in the documented loopback range. Automatic connection is
  the default for new hosted accounts. You can choose **Verify each device
  with a code** in Sync & Mesh settings for a manual check — see
  [Devices and sign-in](/docs/sync/devices).
- **Headless daemon:** Run `anvil-daemon sign-in --api-url https://<backend>`
  on the host. Add `--worker` only for an explicit Mesh worker opt-in. After
  sign-in, run `anvil-daemon run` to start the long-running host services.
- **Web:** `/account` on the website. It requires the WorkOS environment and
  the signed backend service-channel environment; when either is absent the
  page shows a not-configured state rather than proving hosted connectivity.

For local website testing, an unpackaged desktop may override the account link
with `ANVIL_HOSTED_ACCOUNT_URL=http://localhost:3000/account`. This override
is accepted only for an unpackaged loopback target; deployed builds use the
configured hosted account origin.

## Cost and availability

Anvil Desktop stays free and open source. Hosted Sync & Mesh will be paid when
it launches; the proposed plans are on the [pricing page](/pricing). There is
no launch date yet. You can [join the waitlist](/waitlist) or
[deploy your own backend](/docs/sync/self-deploy).

Anvil-hosted writes require a paid subscription, an assigned paid team seat, or
an unexpired redeemed beta code. Paid signup stays disabled until the operator
opens checkout. Waitlist approval lets you sign in; the code grants access until
the date in your invitation.

## Hosted access states

Access state resolves on the backend for each hosted mutation.
Authentication, account lifecycle, security policy, and fair-use limits remain
enforced by the backend. Self-hosted deployments do not require Anvil billing.

| State | Meaning |
| --- | --- |
| `active` | A confirmed paid invoice covers the current period. A paid team seat can fund access instead of a personal subscription. |
| `preview` | A redeemed beta code grants time-limited access. The wire name remains `preview` for client compatibility. |
| `grace` | Access continues during bounded renewal or billing-outage grace. Renewal retries cannot restart the clock. |
| `restricted` | No current paid or beta access, or an account, device-limit, security or policy restriction. |
| `unknown` | The backend could not resolve the access state. The website preserves this result and does not assume access. |

The old global preview deadline and `preview_eligible` flag grant no access.
When access ends, local work, pulls, exports, revocation and account deletion
remain available. New hosted writes, Mesh job submissions and handoffs stop.

## Limits

Limits — device count, artifact bytes, history bytes — come from **backend
deployment config**, not a hardcoded product table. `/account` shows the
actual numbers your deployment enforces; this page does not quote them
because the defaults in the repo are provisional test fixtures, not
advertised product limits.

## Billing plumbing

During beta, `/account/billing` accepts invitation codes. Each code is single-use
across accounts, retryable by its redeemer, and has an operator-set access expiry.
The backend stores only a hash of the code. Codes can be revoked.

Paid checkout opens only with `HOSTED_CHECKOUT_ENABLED=true` and configured Stripe
prices and return URLs. Confirmed paid invoices grant access, not checkout redirects
or subscription status alone. Webhooks and reconciliation update the payment evidence.
The portal supports invoice review and cancellation. Team checkout requires an
organisation owner and at least five seats; unpaid seat increases do not grant access.

## The `/account` surface

The website's account area (requires WorkOS env on the site deployment):

| Surface | What it shows |
| --- | --- |
| `/account` | Current backend-reported access state and enforced fair-use limits. |
| `/account` devices | Full device roster — rename and revoke. |
| `/account/billing` | Beta-code redemption, personal checkout when open, subscription state, portal and refresh controls. |
| `/account/organizations` | Membership, invitations, roles and team billing. It does not share workspaces, devices or Sync & Mesh data. |
| `/account/data` | Export/deletion status — the deletion state machine's visible progress. |

New organisations have five allocated member seats, including the owner. Older
owner seat opt-outs remain in effect, so total membership can differ from the
number of allocated seats. Membership administration does not create a shared
workspace or Sync & Mesh fleet.

Web device revocation severs the session but does **not** rotate the ADK —
the app does. See [Devices and sign-in](/docs/sync/devices) for the table.

## Provisioning status

Honest status: the hosted backend and website integration are implemented and
covered by local tests and deployment rehearsal tooling. A production hosted
service is not claimed here: the production WorkOS app, D1 id, secrets bundle,
and live-account verification still need to be provisioned and recorded. A
staging deployment or successful Worker upload does not establish that
production status.

## Related

- The same backend on your own account: [Self-deploy the
  backend](/docs/sync/self-deploy).
- The contract it implements: [Backend conformance](/docs/sync/conformance).
- Known gaps: [Status and limits](/docs/sync/status-and-limits).
