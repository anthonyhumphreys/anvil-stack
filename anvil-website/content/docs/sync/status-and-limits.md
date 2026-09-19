---
title: Status and limits
navTitle: Status and limits
description: Every known gap, hard limit, and unfinished edge in Sync & Mesh — alpha status, unproven surfaces, functional limits, and tracked follow-ups, in one place.
product: Anvil Sync & Mesh
section: Reference
journey: reference
order: 120
---

# Status and limits

Everything on this page is stated plainly because it is the page the rest of
the docs point at when they say "alpha." If a claim anywhere else in
[Sync & Mesh](/docs/sync) sounds better than what is written here, here wins.

## Maturity

- **This is alpha infrastructure.** The architecture, wire contract, and
  lifecycle are implemented and tested. That means the mechanisms described
  across these docs exist in code and pass their suites — not that the
  product is finished.
- **Rehearsed on real deployments, not demoed on hardware.** The full
  lifecycle — deploy, conformance, upgrade, restore, remove — has been
  rehearsed against real Cloudflare deployments via
  `anvil-cloud/scripts/verify-mesh-rehearsal.mjs`. A physical multi-device
  demo — two real machines pairing, syncing, and handing off — **has not
  happened yet**. Cross-device timing and UX are the least proven surfaces.
  Treat them accordingly.

## Hosted mode status

- **Hosted staging/QA is an explicit path in the desktop and runbook.** Set
  `ANVIL_HOSTED_BACKEND_URL` to the tested HTTPS origin and configure the
  website service channel and WorkOS clients. The development spike requires
  an unpackaged build plus `ANVIL_ENABLE_SYNC_SPIKE=1`; the source tree alone
  does not make hosted connectivity live.
- **Production provisioning is pending**: the production WorkOS app, Stripe
  live keys, D1 database id, secrets bundle, and live-account verification are
  not recorded here.
- **Preview terms are policy values, not deployment evidence**: the current
  policy date is free through 31 October 2026, with paid enforcement from
  `2026-11-01T00:00:00Z`. Pricing is not approved — no price exists to quote.
  See [Anvil-hosted sync](/docs/sync/hosted).

## Known gaps

These are the sharp edges. Each is a real behavior difference, not a wording
choice:

- **Website revocation does not rotate the ADK.** Revoking a device from
  `/account` severs its session but leaves its key version alive — the
  revoked device can still decrypt anything sealed under that version if it
  obtains the ciphertext. Revoking from the app mints ADK v(N+1) and wraps it
  to survivors. **For the full guarantee, revoke from an enrolled device in
  the app.** Details: [Devices and pairing](/docs/sync/devices).
- **Exports are ciphertext.** The portable export document carries sealed
  envelopes — it round-trips correctly into an account holding the ADK but is
  not human-readable. Unsealing at export is a tracked follow-up. Details:
  [Data portability](/docs/sync/data-portability).
- **SAS has no UI.** The 9-digit MITM verification code is derivable in the
  keyring but nothing surfaces it — pairing today relies on the out-of-band
  secret path. Details: [Encryption and keys](/docs/sync/encryption).

## Functional limits

Hard numbers and boundaries that are real behavior, not planned work:

- **Job history lists the most recent 100 executions.** Older jobs drop out
  of the Remote executions list. Details: [Mesh jobs](/docs/sync/mesh-jobs).
- **Worker opt-in is per-device and never syncs.** There is no account-level
  "run jobs everywhere" switch — enable the worker on each machine you want
  claiming jobs.
- **Conflicts never auto-resolve.** Divergent entities surface as explicit
  conflicts and wait for you; there is no last-writer-wins pass. Details:
  [How sync works](/docs/sync/sync-engine).
- **Handoff blocks on readiness.** A dirty tree or unpushed commits stop the
  handoff with remediation — there is no forced path. Details: [Session
  handoff](/docs/sync/session-handoff).
- **Revocation does not erase.** A revoked device keeps whatever plaintext it
  already decrypted; rotation limits future access only. Same for share-link
  revocation — downloaded bytes stay downloaded.
- **Share links are bearer credentials.** Anyone with the full link —
  fragment included — can decrypt until the share is revoked or expires.
  Details: [Artifacts and share links](/docs/sync/artifacts-and-shares).
- **Backend metadata is readable.** The server sees ids, types, revisions,
  sequences, sizes, timestamps, envelope hashes, the roster, and job/handoff
  coordination records. E2E protects content, not metadata. Full list:
  [Encryption and keys](/docs/sync/encryption).

## Companion surfaces

Account-connected companion surfaces exist but are early:

- **Mobile app (Expo)** — supports account enrollment and direct dial to
  devices. See [Companion surfaces](/docs/desktop/companion-surfaces).
- **Raycast extension** — has an account-connected mode.
- **Headless daemon host mode (DAEMON-01)** — exists for always-on mesh
  workers.

All three are alpha surfaces on top of alpha infrastructure; expect the
edges described above to show through them.

## Tracked follow-ups

Work that is known, named, and not yet done:

- Unseal-at-export for human-readable portability documents.
- SAS verification UI for manual pairing checks.
- Physical multi-device acceptance demo — the market-readiness gate.
- Production provisioning for hosted mode (WorkOS, Stripe live keys, D1,
  secrets).

## Where each topic lives

| Topic | Page |
| --- | --- |
| Modes, what syncs, mental model | [Overview](/docs/sync/overview) |
| Crypto, ADK, what the server sees | [Encryption and keys](/docs/sync/encryption) |
| The sync loop | [How sync works](/docs/sync/sync-engine) |
| Handoff state machine | [Session handoff](/docs/sync/session-handoff) |
| Enrollment, pairing, roster | [Devices and pairing](/docs/sync/devices) |
| Remote execution | [Mesh jobs](/docs/sync/mesh-jobs) |
| Uploads, shares, browser decrypt | [Artifacts and share links](/docs/sync/artifacts-and-shares) |
| Export, import, delete | [Data portability](/docs/sync/data-portability) |
| Deploy your own | [Self-deploy](/docs/sync/self-deploy) |
| Prove compatibility | [Conformance](/docs/sync/conformance) |
| Billing, /account, provisioning | [Anvil-hosted](/docs/sync/hosted) |

Found an edge not listed here? That is a docs bug —
[contributing](/docs/project/contributing) covers how to file it.
