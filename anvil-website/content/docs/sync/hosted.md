---
title: Anvil-hosted sync
navTitle: Anvil-hosted sync
description: The operated Sync & Mesh backend — WorkOS identity, free hosted sync and mesh access, account and device controls, legacy billing records, and the /account surface.
product: Anvil Sync & Mesh
section: Reference
journey: reference
order: 110
---

# Anvil-hosted sync

Anvil-hosted is the operated deployment of the same backend source you can run
yourself — the worker in `anvil-app/cloud/backend`, with managed identity and
account and device controls on top. Sync & Mesh are free. This
page also documents the compatibility path for old billing records; new Sync
& Mesh access does not require a subscription. A self-deployed backend does not
use the hosted billing database or website service channel.

The desktop has a hosted mode when `ANVIL_HOSTED_BACKEND_URL` is configured
with an HTTPS backend origin. The development spike is a separate fixture and
is enabled only for an unpackaged build with `ANVIL_ENABLE_SYNC_SPIKE=1`.
Neither setting is evidence that a production hosted service is available;
production provisioning and its operational credentials remain pending.

## Identity

The website `/account` area uses a WorkOS browser session. It calls the
backend through the separately configured, signed hosted service channel.
Desktop enrollment is a backend protocol: the desktop follows the issuer and
auth mode advertised by the backend, then redeems a device code from the
account page. Hosted OIDC uses issuer
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

The command prints WorkOS's public verification URI and user code, then polls
until the user approves the code or the bounded authorization lifetime ends.
It does not open a browser and does not use a loopback redirect. Configure the
descriptor's `auth.publicClientId` as a WorkOS public client with Device
Authorization enabled. A client secret and WorkOS API key stay on the backend;
the daemon receives neither. See the [WorkOS CLI Auth documentation](https://workos.com/docs/authkit/cli-auth).

To sign in:

- **Desktop:** Set `ANVIL_HOSTED_BACKEND_URL`, open Settings → Sync & Mesh →
  Anvil-hosted, review the discovered endpoint and issuer, then complete the
  advertised sign-in flow. The callback is
  `http://127.0.0.1:<ephemeral-port>/callback`; the desktop chooses an
  ephemeral port in the documented loopback range. Enrollment follows the
  normal device flow — see [Devices and pairing](/docs/sync/devices).
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

Sync & Mesh are free. An Anvil subscription or billing account is
not required for sync writes, mesh jobs, session handoff, device management,
or artifact sharing. Authentication, account lifecycle, backend security
rules, and fair-use limits still apply.

Free policy and service availability are separate. Production provisioning of
the Anvil-hosted backend is still in progress, so hosted access remains gated
while that work is completed. Local use, self-hosting, and conformant backends
remain available paths.

## Entitlement and write enforcement

Access state resolves on the backend and is cached on the account object.
Authentication, account lifecycle, security policy, and fair-use limits remain
enforced by the backend. Subscription or billing health does not grant or
remove Sync & Mesh access. States:

| State | Meaning |
| --- | --- |
| `active` | Sync & Mesh access is active. A subscription is not required. |
| `preview` | Legacy preview state retained for older account records. It does not set a free-period end date. |
| `grace` | Legacy billing grace state. Billing health does not determine Sync & Mesh access. |
| `restricted` | The backend has restricted this account. The reason may be a security, lifecycle, or policy decision; it is not a subscription paywall. |
| `unknown` | The backend could not resolve the access state. The website preserves this result and does not assume access. |

Old renewal-grace and billing-outage records may remain visible for historical
accounts. They do not suspend free Sync & Mesh access. Local-only mode does
not use the hosted access state.

## Limits

Limits — device count, artifact bytes, history bytes — come from **backend
deployment config**, not a hardcoded product table. `/account` shows the
actual numbers your deployment enforces; this page does not quote them
because the defaults in the repo are provisional test fixtures, not
advertised product limits.

## Billing plumbing

New Sync & Mesh checkout is disabled. The account site keeps a portal link for
people with old subscription records so they can review invoices or cancel.
Webhooks and reconciliation keep those records in step with the payment
provider. They do not change Sync & Mesh access.

## The `/account` surface

The website's account area (requires WorkOS env on the site deployment):

| Surface | What it shows |
| --- | --- |
| `/account` | Current backend-reported access state and enforced fair-use limits. |
| `/account` devices | Full device roster — rename, revoke, mint pair/link codes. |
| `/account/billing` | Legacy subscription state, Stripe portal link, and reconcile status. |
| `/account/organizations` | Membership, invitations, roles, and legacy billing records. It does not share workspaces, devices, or Sync & Mesh data; each person's access stays independent. |
| `/account/data` | Export/deletion status — the deletion state machine's visible progress. |

New organisations have five allocated member seats, including the owner. Older
owner seat opt-outs remain in effect, so total membership can differ from the
number of allocated seats. Membership administration does not create a shared
workspace or Sync & Mesh fleet.

Web device revocation severs the session but does **not** rotate the ADK —
the app does. See [Devices and pairing](/docs/sync/devices) for the table.

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
- The full honesty list: [Status and limits](/docs/sync/status-and-limits).
