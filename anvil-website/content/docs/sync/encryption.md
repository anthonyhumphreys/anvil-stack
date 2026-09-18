---
title: Encryption and keys
navTitle: Encryption and keys
description: How Sync & Mesh seals entities — AES-256-GCM envelopes, the versioned account data key, X25519 device identities, key distribution, rotation, and exactly what the server can read.
product: Anvil Sync & Mesh
section: Concepts
journey: learn
order: 20
---

# Encryption and keys

Synced content is end-to-end encrypted. This page documents the implemented
mechanism — not the intent, the code path — including the part most encryption
marketing skips: the exact metadata the backend can still read.

## The sealing model

Every synced domain entity travels as a sealed envelope:

- Payloads are encrypted with **AES-256-GCM** under a versioned **account data
  key (ADK)** — one symmetric key per account, per version.
- Sealing happens at dispatch: the plaintext entity is sealed as it is written
  into the local `sync_outbox` (`sealed_json`), not at push time. A retry or
  replay reuses the identical ciphertext, which is what makes server-side
  dedupe by envelope hash safe.
- If no ADK exists on the device yet, the outbox row **defers**. Plaintext
  never ships as a fallback — the row waits for a key or never goes.
- The backend validates envelope shape (it can reject malformed input) and
  journals the ciphertext opaquely. It has no code path that opens it.
- On pull, a device unseals at the wire→domain boundary. An envelope that
  fails to unseal is quarantined raw on the binding — ciphertext kept, not
  dropped — and retried automatically when the missing key version arrives.
  See [How sync works](/docs/sync/sync-engine).

The same sealing covers entity payloads, artifact bytes, handoff checkpoints,
and shared-artifact bytes.

## Device identities

Each enrollment generates a fresh **X25519** keypair. The private key never
leaves the device; the public half is published as a device-identity entity —
a crypto-boundary record other devices use to wrap key material to it.

Enrollment also issues device-scoped access and refresh tokens. Refresh tokens
rotate on use; revoking an enrollment severs its session immediately. These
tokens authenticate API calls — they are not encryption keys and cannot open
an envelope.

## Key distribution: how a new device gets the ADK

The first device mints ADK v1 locally at the moment of the first sealed write.
New devices receive it through one of two paths:

1. **Pairing payload (in-app code).** A signed-in device seals the ADK inside
   a pairing blob under a fresh one-time secret. The secret travels in the
   pairing payload itself —
   `anvil-pair-{code}.{nonce}.{secret}` — carried out-of-band (typed or
   scanned), never through the server. The server sees the enrollment code
   redemption; the secret that protects the ADK is in the string you carried.
2. **Automatic keyring wrap (website bare code).** A bare code minted on
   `/account` carries no key material. The new device enrolls and publishes
   its device-identity entity; the next time any trusted device pulls and
   observes that identity, it wraps the ADK to the new public key and the
   wrap syncs as an ordinary sealed entity. The new device unwraps on its next
   pull. Consequence: at least one trusted device must be online for the wrap
   to happen.

Walkthroughs for both flows are in [Devices and pairing](/docs/sync/devices).

## Rotation on revoke — and the app/web difference

Revoking a device does two different things depending on where you do it:

- **From the app:** a trusted online device mints **ADK v(N+1)** and wraps it
  to every surviving device. Anything sealed after rotation is unreadable to
  the revoked device, even if it still holds ciphertext. Rotation limits
  future access — it does not reach back and erase plaintext the device
  already decrypted.
- **From the website:** the session is severed, immediately and account-wide —
  but **no ADK rotation fires**. The revoked device keeps the key version it
  had and can still read anything sealed under it if it later obtains the
  ciphertext. This is a documented gap, not an implementation detail: for the
  full guarantee, revoke from an enrolled device in the app.

## SAS verification

Both devices in a pairing can derive the same **9-digit SAS** (short
authentication string) from the two device public keys — the standard MITM
eyeball check for pairing ceremonies. The derivation exists in the keyring
today; **no UI surfaces it yet**. Until it does, the practical check is the
pairing secret's out-of-band path: the server never sees it, so a passive
server cannot mint a wrap to a device it controls.

## What the server can read

The backend needs enough metadata to replicate, dedupe, and coordinate. Treat
all of the following as readable by whoever operates the backend:

- entity ids and entity types
- revisions and sequence positions
- payload sizes
- timestamps
- envelope hashes (used for dedupe)
- the device roster — enrollment ids, names, device-identity public keys, status
- session, job, attempt, and handoff records — states, leases, placement

What it cannot read: entity payload content, artifact bytes, checkpoint
bodies, shared-artifact bytes, and any plaintext form of the ADK. If a claim
on this page drifts from that line, the line wins — the server has no unseal
path.

## Share-link keys

Share links deliberately do not use the ADK. Each share mints a fresh random
key client-side; the artifact bytes are sealed under that key and uploaded,
and the key rides in the URL fragment: `/artifacts/{id}#k={key}`.

URL fragments are never sent in HTTP requests, so the key never reaches a
server. The share page fetches ciphertext through a signed service channel,
verifies its SHA-256, and decrypts in the browser with WebCrypto AES-GCM.
Anyone holding the full link can decrypt — that is the design, so treat a
share URL like a credential. Details and revocation semantics are in
[Artifacts and share links](/docs/sync/artifacts-and-shares).

## Where keys rest locally

On each device, key material — the ADK versions and the device identity's
private half — lives in the app's local SQLite store, wrapped by the OS
credential store via Electron `safeStorage`. There is no plaintext key file
and nothing key-shaped leaves the device except wraps addressed to a specific
enrolled device's public key.

## Current limits

- Website revocation severs the session but does not rotate the ADK — use the
  app for the full guarantee.
- SAS verification is implemented but has no UI surface.
- Rotation cannot erase what a revoked device already decrypted.
- Everything under "What the server can read" is readable. E2E protects
  content, not metadata.
