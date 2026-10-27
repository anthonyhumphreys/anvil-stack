---
title: Status and limits
navTitle: Status and limits
description: What works in Sync & Mesh, what still needs testing, current limits and planned hosted access.
product: Anvil Sync & Mesh
section: Reference
journey: reference
order: 120
---

# Status and limits

Sync & Mesh, including LAN-first Mesh routing, is in beta through
30 November 2026. This page lists its current limits and the testing still
pending during the beta.

## Maturity

- **This is a beta, running through 30 November 2026.** The architecture, wire
  contract, and lifecycle are implemented and tested. That means the
  mechanisms described across these docs exist in code and pass their suites —
  not that the product is finished.
- **Rehearsed on real deployments, not demoed on hardware.** The full
  lifecycle — deploy, conformance, upgrade, restore, remove — has been
  rehearsed against real Cloudflare deployments via
  `anvil-cloud/scripts/verify-mesh-rehearsal.mjs`. A physical multi-device
  demo — two real machines pairing, syncing, and handing off — **has not
  happened yet**. Cross-device timing and UX are the least proven surfaces.
  Treat them accordingly.

## Hosted and host-route status

- **Hosted staging/QA is an explicit path in the desktop and runbook.** Set
  `ANVIL_HOSTED_BACKEND_URL` to the tested HTTPS origin and configure the
  website service channel and WorkOS clients. The development spike requires
  an unpackaged build plus `ANVIL_ENABLE_SYNC_SPIKE=1`; the source tree alone
  does not make hosted connectivity live.
- **Live host routes are conditional.** Direct live traffic requires a
  compatible upgraded client and an enabled, reachable host endpoint. A
  managed route needs a provisioned, enabled endpoint, and availability
  depends on the deployment; choosing Sync does not provision one. A managed
  route uses a provider proxy, not a peer-to-peer connection. Without a usable
  route, the account service still handles durable coordination; host-local
  live output requires the host to be reachable.
- **LAN-first routing.** Desktop, the headless daemon and native mobile prefer
  validated host LAN-address candidates, then other private routes, explicit
  HTTPS and managed ingress. Bounded fallback and network-change refresh keep
  selection responsive. A replacement session must authenticate and catch up
  before it takes over; already-sent requests stay on their original
  connection and route changes never resend commands. If preparation fails,
  the working connection stays in use; a broken connection goes through
  ordinary reconnect and reports uncertain outcomes. The browser workspace
  keeps its HTTPS routing. Details: [LAN-first Mesh routes](/docs/sync/lan-first-routes).
- **LAN routing is not offline Mesh.** Backend admission and continuing
  authorization still apply on every route. A `Direct` label is a host
  address hint, not proof of a physical LAN path.
- **Production provisioning is pending**: the production WorkOS app, D1
  database id, secrets bundle, and live-account verification are not recorded
  here. Stripe is not required for code-only beta access.
- **Hosted plans are proposed, not available to buy.** Hosted Sync & Mesh will
  require a subscription or a redeemed beta code. Checkout stays closed during
  the invite-only beta; requesting beta access is not a purchase. Invited
  testers receive a code whose access expiry is set in the invitation. Running
  your own backend remains free of Anvil charges. See [pricing](/pricing) and
  [Anvil-hosted sync](/docs/sync/hosted).

## Known gaps

These limitations affect how the current implementation behaves:

- **Website revocation rotates on survivor reconciliation.** Revoking a
  device from `/account` severs its session immediately. A surviving trusted
  device learns the revocation and rotates the ADK before accepting its next
  new write; an offline survivor waits until it reconnects. Revoking from an
  online enrolled device can rotate immediately. Details: [Devices and
  pairing](/docs/sync/devices).
- **Exports are ciphertext.** The portable export document carries sealed
  envelopes — it round-trips correctly into an account holding the ADK but is
  not human-readable. Unsealing at export is a tracked follow-up. Details:
  [Data portability](/docs/sync/data-portability).
- **Pairing requires mutual SAS confirmation in upgraded clients.** The
  9-digit MITM verification code is available through Compare & approve in
  the Devices list. Unsigned legacy wraps are rejected; resend the pairing or
  complete manual verification after upgrading. Details: [Encryption and
  keys](/docs/sync/encryption).

## Functional limits

Hard numbers and boundaries that are real behavior, not planned work:

- **Job history lists the most recent 100 executions.** Older jobs drop out
  of the Remote executions list. Details: [Mesh jobs](/docs/sync/mesh-jobs).
- **Worker opt-in is per-device and never syncs.** There is no account-level
  "run jobs everywhere" switch — enable the worker on each machine you want
  claiming jobs.
- **Sync is selected per workspace.** Local is the default for new workspaces;
  repository files, provider credentials, machine paths, and chat transcripts
  stay on their machines.
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
  devices, with LAN-first route selection and live session migration in
  account mode. See [Companion surfaces](/docs/desktop/companion-surfaces).
- **Raycast extension** — has an account-connected mode. It gets the improved
  route selection but not live session migration.
- **Headless daemon host mode (DAEMON-01)** — exists for always-on mesh
  workers.

All three are early surfaces on beta infrastructure; expect the edges
described above to show through them.

## Tracked follow-ups

Work that is known, named, and not yet done:

- Unseal-at-export for human-readable portability documents.
- Active key-substitution and pairing-receipt audit, plus rollout of the
  upgraded wrap bindings and mutual SAS confirmation.
- Physical multi-device acceptance demo — the market-readiness gate.
- Physical LAN acceptance: MacBook and Mac mini route switching on a shared
  LAN, and local network permission and route switching on native iOS and
  Android release builds. Beta availability does not mean these have passed.
- Production provisioning for hosted mode (WorkOS, production D1, secrets,
  and live-account verification), plus billing and access enforcement for
  the proposed paid plans.

## Where each topic lives

| Topic | Page |
| --- | --- |
| Modes, what syncs, mental model | [Overview](/docs/sync/overview) |
| Crypto, ADK, what the server sees | [Encryption and keys](/docs/sync/encryption) |
| The sync loop | [How sync works](/docs/sync/sync-engine) |
| Handoff state machine | [Session handoff](/docs/sync/session-handoff) |
| Enrollment, pairing, roster | [Devices and sign-in](/docs/sync/devices) |
| Remote execution | [Mesh jobs](/docs/sync/mesh-jobs) |
| Route order, switching and labels | [LAN-first Mesh routes](/docs/sync/lan-first-routes) |
| Uploads, shares, browser decrypt | [Artifacts and share links](/docs/sync/artifacts-and-shares) |
| Export, import, delete | [Data portability](/docs/sync/data-portability) |
| Deploy your own | [Self-deploy](/docs/sync/self-deploy) |
| Prove compatibility | [Conformance](/docs/sync/conformance) |
| Hosted availability and legacy billing records | [Anvil-hosted](/docs/sync/hosted) |

Found an edge not listed here? That is a docs bug —
[contributing](/docs/project/contributing) covers how to file it.
