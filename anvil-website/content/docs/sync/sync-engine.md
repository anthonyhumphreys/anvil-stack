---
title: How sync works
navTitle: How sync works
description: The sync loop end to end — outbox, seal at dispatch, push, opaque journaling, pull, unseal, apply — plus live socket acceleration, offline queueing, quarantine, dedupe, and explicit conflicts.
product: Anvil Sync & Mesh
section: Concepts
journey: learn
order: 30
---

# How sync works

One loop, repeated forever:

```txt
edit -> sync_outbox -> seal at dispatch -> push
     -> backend journals ciphertext
     -> peers pull -> unseal -> domain apply
```

Every stage is implemented and covered by engine and keyring tests. This page
walks the loop and the failure behavior at each stage — the interesting part
of a sync engine is never the happy path.

## Stage by stage

### Queue

Local edits to synced entities — workspace definitions, workflow templates,
editable agents, approved settings — write a row into `sync_outbox` in the
app's SQLite store. The queue is durable: quitting mid-edit loses nothing.

### Seal at dispatch

Sealing happens when a row is dispatched, not when it is pushed: the plaintext
is encrypted under the current ADK version and stored in the row's
`sealed_json` column. Two consequences:

- **Replays are byte-identical.** A retry sends the same ciphertext, so the
  backend's dedupe-by-envelope-hash never sees a "new" entity for a redelivered
  edit.
- **Missing key means no send.** If the device has no ADK yet — a fresh
  enrollment waiting on a wrap — the row defers. There is no plaintext
  fallback path. The row seals and goes once a key arrives; see
  [Encryption and keys](/docs/sync/encryption) for how keys arrive.

### Push

Sealed envelopes push over the backend's API. The backend validates envelope
shape — malformed input is rejected — and journals each envelope opaquely:
stored, ordered, deduplicated by hash, never opened. What the journal records
about each envelope is the metadata list in
[What the server can read](/docs/sync/encryption).

### Pull

Peers pull on two rails:

- a **live socket** pushes changes down as they journal — the fast path;
- **fallback polling** runs when the socket is down or the network is
  hostile — slower, same result.

The socket is an accelerator, not a requirement. Convergence does not depend
on it.

### Unseal and apply

A pulled envelope is unsealed at the wire→domain boundary and applied to the
local domain store. Two failure modes, both handled:

- **Unseal failure** — typically an ADK version the device doesn't have yet.
  The raw envelope is quarantined on the binding (kept, not dropped) and
  retried automatically when the missing key version arrives. Quarantined
  entities self-heal; nothing is re-requested and nothing is lost.
- **Divergence** — the entity changed on two devices without a common
  resolution. It surfaces as an explicit conflict, described below.

## Offline edits

Edits made with no backend reachability queue in the outbox exactly like
online edits — the outbox is the same either way, which is why offline sync
isn't a separate mode. If the ADK exists they seal at dispatch time and sit
sealed until push succeeds; if it doesn't (new device, no wrap yet) they
defer. Either way, nothing readable leaves the device, ever.

## Conflicts

Conflicts never auto-overwrite. When a pulled entity diverges from local
state, the runtime records an explicit conflict on the binding carrying both
payloads — local and remote — and the entity waits for a decision. Resolving
is a user act, done per conflict; there is no last-writer-wins pass hiding in
the loop and no silent discard.

## Dedupe and ordering

- **Dedupe** rides the hash of the sealed envelope. Identical ciphertext is
  the same write; the backend journals it once. Replays are free.
- **Ordering** rides revisions and sequence positions in the journal — part of
  the readable metadata. The backend can order what it cannot read.

## Current limits

- The loop is proven in engine/keyring suites and rehearsed against real
  Cloudflare deployments; a physical multi-device demo is still pending.
  Cross-device timing — how fast a wrap or a pull actually lands on real
  hardware — is the least proven part.
- Conflict resolution is manual by design. If you expected three-way merge
  magic, there isn't any — by decision, not by omission.
- Fallback polling is a convergence path, not a performance path. Expect
  latency, not loss.
