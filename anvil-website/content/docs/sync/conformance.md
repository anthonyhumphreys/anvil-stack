---
title: Backend conformance
navTitle: Backend conformance
description: The frozen Sync v1 wire contract, the shipped conformance suite that proves a backend speaks it, and what a passing backend can be a drop-in target for.
product: Anvil Sync & Mesh
section: Guides
journey: build
order: 100
---

# Backend conformance

The desktop does not talk to "the Anvil backend" — it talks to a frozen wire
contract. Any implementation that speaks it correctly is a valid target for
Compatible backend mode, whether that is the official Cloudflare worker or
something you wrote yourself. The conformance suite is how a claim of
compatibility gets checked rather than believed.

## The frozen contract

The contract is the `sync/1` profile of `anvil-backend/1`: discovery,
enrollment, sessions, push/pull, devices, data portability, mesh jobs, and
handoff — the exact surface the desktop's network stack exercises. "Frozen"
means the wire shape does not move under you: a backend that conforms keeps
conforming as the desktop updates.

The contract is provider-neutral by construction — nothing in it requires
Durable Objects, R2, or Workers. The suite ships a plain `node:http`
in-memory fixture that passes it, which exists precisely to prove the
contract is implementable without Cloudflare primitives. It is a conformance
fixture, not a production backend.

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
- **Device lifecycle** — roster reads, rename, revoke.
- **Data portability** — `data.export.*`, `data.import.*`,
  `data.operationStatus`.
- **Account lifecycle** — `account.delete`, `account.deletionStatus`.
- **Mesh jobs** — job creation, claim, attempt, journal.
- **Handoff** — the handoff state machine surface.

These are the same checks the unmodified desktop client's real network stack
is exercised against — the suite runs against the fixture with the desktop's
own client code in `byob-conformance` tests, so "passes the suite" and "works
with the app" are the same claim.

## What a pass buys you

A backend that passes every check is a **drop-in target for Compatible
backend mode**: point the desktop at its URL, sign in with whatever identity
it declares, and enroll, sync, and manage devices against it — no desktop
build changes.

A pass is evidence about the wire contract, not about your deployment's
quality. The suite proves the backend speaks `sync/1` correctly enough for
the desktop to work; it does not prove your durability story, your backup
story, or your operational security. Those are still on you.

## Building a compatible backend

1. Stand up an HTTP service implementing the `sync/1` profile.
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
