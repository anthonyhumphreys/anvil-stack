---
title: Anvil-hosted sync
navTitle: Anvil-hosted sync
description: The operated Sync & Mesh backend — WorkOS identity, preview and billing enforcement dates, entitlement and fail-closed writes, Stripe plumbing, and the /account surface.
product: Anvil Sync & Mesh
section: Reference
journey: reference
order: 110
---

# Anvil-hosted sync

Anvil-hosted is the operated deployment of the same backend you can run
yourself — the official worker at `anvil-app/cloud/backend`, run by the
project on Cloudflare, with managed identity and billing on top. Everything
on this page is hosted-only; a self-deployed backend has none of the billing
plumbing because there is nothing to bill.

**In this desktop build the Anvil-hosted option renders disabled** — "not
shipping in this packet." The option is visible in Settings → Sync & Mesh so
the mode picker shows the real shape, but you cannot select it yet.

## Identity

Sign-in is a **WorkOS identity** — the same account unlocks the desktop
enrollment and the `/account` area on the website. Self-hosted backends
declare their own issuer (`--oidc-issuer` at plan time) and do not use the
hosted identity.

To sign in:

- **Desktop:** Settings → Sync & Mesh → Anvil-hosted → sign in. Enrollment
  follows the normal device flow — see [Devices and
  pairing](/docs/sync/devices).
- **Web:** `/account` on the website. Requires the WorkOS env configured on
  the website deployment; without it the account area does not render.

## Preview window and enforcement dates

The hosted preview runs on a fixed clock:

- **Free through 31 October 2026** — during the preview window, entitled
  accounts get full sync-write and mesh-submit capability at no charge.
- **Paid enforcement starts `2026-11-01T00:00:00Z`** — the date is a constant
  in the backend (`PREVIEW_ENDS_AT`), not a slide in a deck.

Pricing is **not approved yet** — there is no price to quote, and this page
will not invent one. What is pinned is the enforcement mechanism and the
date.

## Entitlement and write enforcement

Entitlement resolves on the backend and is cached on the account object.
Enforcement is **fail-closed on writes**: when the entitlement says
restricted, mutating calls are denied — sync writes and mesh job submissions
stop, while reads continue. States:

| State | Meaning |
| --- | --- |
| `active` | Paid subscription current; full capability. |
| `preview` | Inside the preview window; full capability until `2026-11-01`. |
| `grace` | Bounded grace — a failed renewal inside its grace window, or a billing outage within the outage window. Capability continues until `graceUntil`. |
| `restricted` | No valid grant; writes denied, reads continue. |
| `unknown` | Entitlement could not be resolved; treated as no grant for writes. |

Two bounded grace mechanisms exist so a flaky renewal or a billing outage
does not brick your sync: **renewal grace** (a failed renewal on a paid
subscription keeps capability for a bounded window, capped at 7 days by
policy) and **billing-outage grace** (when the billing provider is
unreachable, active subscriptions keep capability for a bounded window,
capped at 24 hours). Both are backend policy constants, not negotiable per
account.

Reads and **Local only mode are never affected** by entitlement — the
enforcement gate sits on hosted writes only.

## Limits

Limits — device count, artifact bytes, history bytes — come from **backend
deployment config**, not a hardcoded product table. `/account` shows the
actual numbers your deployment enforces; this page does not quote them
because the defaults in the repo are provisional test fixtures, not
advertised product limits.

## Billing plumbing

Stripe, end to end:

- **Checkout** — subscribing starts a Stripe checkout session; the plan key
  is `sync_personal`.
- **Portal** — `/account` links to the Stripe customer portal for payment
  method, cancellation, invoices.
- **Webhooks** — subscription lifecycle events land as webhooks; entitlement
  state updates from verified Stripe truth.
- **Reconcile** — an **hourly cron reconciles billing drift** between Stripe
  and the account store, so a missed webhook self-corrects within the hour
  rather than at next sign-in.
- **Metrics** — emitted for webhook backlog, entitlement decisions, and
  reconcile freshness; an operator can see billing health without reading
  logs.

## The `/account` surface

The website's account area (requires WorkOS env on the site deployment):

| Surface | What it shows |
| --- | --- |
| `/account` | Entitlement state, plan, and the actual enforced limits. |
| `/account` devices | Full device roster — rename, revoke, mint pair/link codes. |
| `/account` billing | Subscription state, Stripe portal link, renewal status. |
| `/account/data` | Export/deletion status — the deletion state machine's visible progress. |

Web device revocation severs the session but does **not** rotate the ADK —
the app does. See [Devices and pairing](/docs/sync/devices) for the table.

## Provisioning status

Honest status: the hosted backend is implemented, tested, and rehearsed on
real Cloudflare deployments, but **production provisioning is pending** — the
WorkOS app, Stripe live keys, the production D1 id, and the secrets bundle
are not yet stood up. Until they are, "Anvil-hosted" is a mode you can see
but not select, which is exactly what the disabled option in the app is
telling you.

## Related

- The same backend on your own account: [Self-deploy the
  backend](/docs/sync/self-deploy).
- The contract it implements: [Backend conformance](/docs/sync/conformance).
- The full honesty list: [Status and limits](/docs/sync/status-and-limits).
