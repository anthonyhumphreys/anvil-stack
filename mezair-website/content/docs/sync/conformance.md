---
title: Backend conformance
navTitle: Backend conformance
description: Check whether your backend implements the Sync v2 protocol and understand which operations the compatibility suite covers.
product: Mezair Sync & Mesh
section: Guides
journey: build
order: 100
---

# Backend conformance

Mezair Desktop can connect to any backend that implements the required
protocols. Run the conformance suite to check Sync compatibility with the
official Cloudflare Worker or your own implementation. The suite does not
yet check Mesh jobs, session handoff or direct host sessions.

## The frozen contract

The conformance suite exercises the `sync/2` profile inside the
`mezair-backend/1` RPC envelope: discovery, enrollment, sessions, push/pull,
devices, account lifecycle, data portability, and compact snapshots. The envelope remains
version 1; Sync and Mesh capabilities are negotiated as version 2 profiles.
This suite checks Sync. It does not yet validate Mesh job, handoff, or direct
host-session operations.

The protocol does not require Cloudflare Workers, Durable Objects or R2.
The suite includes a small in-memory Node HTTP backend as a reference for
implementing another server. It is intended for development, not hosting
account data.

## Run the suite

From `mezair-app/cloud/backend` (or the equivalent path in your checkout):

```sh
pnpm conformance -- --url <backend> --admin-token <token>
```

Or directly:

```sh
node conformance/suite.mjs --url http://127.0.0.1:8787 --admin-token dev-admin-token
```

Against the bundled fixture, spawns it, waits for readiness, tears it down:

```sh
node conformance/suite.mjs --fixture
# or
pnpm conformance:fixture
```

Exit code is non-zero on any failed check, so CI needs no output parsing
required.

## What it covers

- **Discovery.** The descriptor the desktop reads: endpoints, protocols,
  auth issuer, limits.
- **Enrollment.** Code redemption, single-use semantics, hashed-at-rest
  behavior.
- **Sessions.** Refresh rotation and revocation severing immediately.
- **Push/pull.** `sync.push`, `sync.pull`, `sync.scan.*`; canonical-JSON and
  SHA-256 payload hashing are re-implemented inside the suite so
  canonicalization agreement is verified over the wire, not assumed.
- **Compact snapshots.** Encrypted chunks, manifest verification, and
  competing-publication fencing.
- **Device lifecycle.** Roster reads, rename, revoke.
- **Data portability.** `data.export.*`, `data.import.*`,
  `data.operationStatus`.
- **Account lifecycle.** `account.delete`, `account.deletionStatus`.
The desktop's Sync network stack is exercised against the fixture with the
client code in `byob-conformance` tests. The pass does not establish Mesh job,
handoff, or direct host-route compatibility.

## What a pass buys you

A backend that passes every check is a **conformant Sync target**: point a
compatible desktop at its URL, sign in with its declared identity, and use
the Sync surfaces covered by the suite. A pass alone does not establish Mesh
job or host-route compatibility.

A pass is evidence about the wire contract, not about your deployment's
quality. The suite proves the backend speaks the exercised `sync/2` surfaces;
it does not prove your durability story, your backup story, or your
operational security. Those are still on you.

## Building a compatible backend

1. Stand up an HTTP service implementing the `sync/2` profile in the
   `mezair-backend/1` envelope.
2. Run the suite against it: `pnpm conformance -- --url <you> --admin-token
   <token>`.
3. Fix what fails; the suite names the check.
4. Point a desktop at it via Settings → Sync & Mesh → **Compatible backend**.

The reference for what "correct" looks like is the official worker at
`mezair-app/cloud/backend`, deployable to your own Cloudflare account with
[`mezair-cloud mesh`](/docs/sync/self-deploy) if you want a known-good target
to diff against.

## Current limits

- The suite covers the wire contract. It does not load-test, soak-test, or
  adversarially probe your implementation. A conformant backend can still
  fall over in production-shaped ways the suite never sees.
- Conformance is checked against the fixture and the official worker. A
  third-party implementation that passes is contract-correct; whether it
  stays correct as the contract's frozen surface evolves is on its
  maintainer's CI, not this repo's.
