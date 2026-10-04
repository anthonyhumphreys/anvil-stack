---
title: Backend conformance
navTitle: Backend conformance
description: The frozen Sync v2 wire profile, the conformance suite that tests it, and the limits of what a passing backend proves.
product: Anvil Sync & Mesh
section: Guides
journey: build
order: 100
---

# Backend conformance

The desktop does not talk to "the Anvil backend" — it talks to a frozen wire
contract. A compatible backend must implement the profiles needed by the
surfaces you use. The conformance suite checks Sync compatibility against the
official Cloudflare worker or an implementation you wrote yourself; Mesh
compatibility is not yet covered here.

## The frozen contract

The conformance suite exercises the `sync/2` profile inside the
`anvil-backend/1` RPC envelope: discovery, enrollment, sessions, push/pull,
devices, account lifecycle, data portability, and compact snapshots. The envelope remains
version 1; Sync and Mesh capabilities are negotiated as version 2 profiles.
This suite checks Sync. It does not yet validate Mesh job, handoff, or direct
host-session operations.

The contract is provider-neutral by construction — nothing in it requires
Durable Objects, R2, or Workers. The suite ships a plain `node:http`
in-memory fixture that passes all 12 checks, including compact snapshot
publication and verification. This proves the contract is implementable
without Cloudflare primitives. It is a conformance fixture, not a production
backend.

## Run the suite

From `anvil-app/cloud/backend` (or the equivalent path in your checkout):

```sh
pnpm conformance -- --url <backend> --admin-token <token>
```

Or directly:

```sh
node conformance/suite.mjs --url http://127.0.0.1:8787 --admin-token dev-admin-token
```

Against the bundled fixture — spawns it, waits for readiness, tears it down:

```sh
node conformance/suite.mjs --fixture
# or
pnpm conformance:fixture
```

Exit code is non-zero on any failed check — CI-friendly, no output parsing
required.

## What it covers

- **Discovery** — the descriptor the desktop reads: endpoints, protocols,
  auth issuer, limits.
- **Enrollment** — code redemption, single-use semantics, hashed-at-rest
  behavior.
- **Sessions** — refresh rotation and revocation severing immediately.
- **Push/pull** — `sync.push`, `sync.pull`, `sync.scan.*`; canonical-JSON and
  SHA-256 payload hashing are re-implemented inside the suite so
  canonicalization agreement is verified over the wire, not assumed.
- **Compact snapshots** — encrypted chunks, manifest verification, and
  competing-publication fencing.
- **Device lifecycle** — roster reads, rename, revoke.
- **Data portability** — `data.export.*`, `data.import.*`,
  `data.operationStatus`.
- **Account lifecycle** — `account.delete`, `account.deletionStatus`.
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
   `anvil-backend/1` envelope.
2. Run the suite against it: `pnpm conformance -- --url <you> --admin-token
   <token>`.
3. Fix what fails; the suite names the check.
4. Point a desktop at it via Settings → Sync & Mesh → **Compatible backend**.

The reference for what "correct" looks like is the official worker at
`anvil-app/cloud/backend` — deployable to your own Cloudflare account with
[`anvil-cloud mesh`](/docs/sync/self-deploy) if you want a known-good target
to diff against.

## Current limits

- The suite covers the wire contract. It does not load-test, soak-test, or
  adversarially probe your implementation — a conformant backend can still
  fall over in production-shaped ways the suite never sees.
- Conformance is checked against the fixture and the official worker. A
  third-party implementation that passes is contract-correct; whether it
  stays correct as the contract's frozen surface evolves is on its
  maintainer's CI, not this repo's.
