---
title: Status and limits
navTitle: Status and limits
description: Supported clients, connection requirements, data-handling limits and hosted availability.
product: Mezair Sync & Mesh
section: Reference
journey: reference
order: 120
---

# Status and limits

Sync & Mesh, including LAN-first Mesh routing, is in beta through
30 November 2026.

## Availability and connections

- **Mezair-hosted access is invite-only.** Invited testers receive a time-limited beta code. Paid signup is not open yet. You can [self-host the backend](/docs/sync/self-deploy) without a Mezair subscription; your infrastructure provider bills you directly.
- **Live output needs a reachable host.** The account service coordinates jobs, but the machine running a job must be reachable for live traffic. Managed HTTPS routes require separate setup and use a provider proxy.
- **Routing depends on the client.** Desktop, the daemon and native mobile prefer LAN addresses, then other private routes, HTTPS and managed ingress. The browser workspace uses HTTPS. See [LAN-first Mesh routes](/docs/sync/lan-first-routes).
- **Mesh requires a backend connection.** LAN routing still uses backend admission and authorization. It does not provide offline Mesh.

## Known gaps

These limitations affect how the current implementation behaves:

- **Website revocation rotates on survivor reconciliation.** Revoking a
  device from `/account` severs its session immediately. A surviving trusted
  device learns the revocation and rotates the ADK before accepting its next
  new write; an offline survivor waits until it reconnects. Revoking from an
  online enrolled device can rotate immediately. Details: [Devices and
  pairing](/docs/sync/devices).
- **Exports are ciphertext.** The portable export document carries sealed
  envelopes. It round-trips correctly into an account holding the ADK but is
  not human-readable. Details:
  [Data portability](/docs/sync/data-portability).
- **Pairing requires mutual SAS confirmation in upgraded clients.** The
  9-digit MITM verification code is available through Compare & approve in
  the Devices list. Unsigned legacy wraps are rejected; resend the pairing or
  complete manual verification after upgrading. Details: [Encryption and
  keys](/docs/sync/encryption).

## Functional limits

These limits apply to connected devices and their data:

- **Job history lists the most recent 100 executions.** Older jobs drop out
  of the Remote executions list. Details: [Mesh jobs](/docs/sync/mesh-jobs).
- **Worker opt-in is per-device and never syncs.** There is no account-level
  "run jobs everywhere" switch. Enable the worker on each machine you want
  claiming jobs.
- **Sync is selected per workspace.** Local is the default for new workspaces;
  repository files, provider credentials, machine paths, and chat transcripts
  stay on their machines.
- **Conflicts never auto-resolve.** Divergent entities surface as explicit
  conflicts and wait for you; there is no last-writer-wins pass. Details:
  [How sync works](/docs/sync/sync-engine).
- **Handoff blocks on readiness.** A dirty tree or unpushed commits stop the
  handoff with remediation. There is no forced path. Details: [Session
  handoff](/docs/sync/session-handoff).
- **Revocation does not erase.** A revoked device keeps whatever plaintext it
  already decrypted; rotation limits future access only. Same for share-link
  revocation, downloaded bytes stay downloaded.
- **Share links are bearer credentials.** Anyone with the full link,
  fragment included, can decrypt until the share is revoked or expires.
  Details: [Artifacts and share links](/docs/sync/artifacts-and-shares).
- **Backend metadata is readable.** The server sees ids, types, revisions,
  sequences, sizes, timestamps, envelope hashes, the roster, and job/handoff
  coordination records. E2E protects content, not metadata. Full list:
  [Encryption and keys](/docs/sync/encryption).

## Companion surfaces

Account-connected companion surfaces exist but are early:

- **Mobile companion.** Supports account enrollment and direct dial to
  devices, with LAN-first route selection and live session migration in
  account mode. See [Companion surfaces](/docs/desktop/companion-surfaces).
- **Raycast extension.** Has an account-connected mode. It gets the improved
  route selection but not live session migration.
- **Headless daemon.** Supports host mode for always-on mesh
  workers.

All three are early surfaces on beta infrastructure; expect the edges
described above to show through them.

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
| Hosted availability and legacy billing records | [Mezair-hosted](/docs/sync/hosted) |

Found an edge not listed here? That is a docs bug.
[contributing](/docs/project/contributing) covers how to file it.
