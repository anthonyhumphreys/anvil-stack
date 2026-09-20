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
New devices receive it through one of these paths:

1. **Pairing payload (in-app code).** A signed-in device seals the ADK inside
   a pairing blob under a fresh one-time secret. The secret travels in the
   pairing payload itself —
   `anvil-pair-{code}.{nonce}.{secret}` — carried out-of-band (typed or
   scanned), never through the server. The server sees the enrollment code
   redemption; the secret that protects the ADK is in the string you carried.
2. **Recovery-code unlock.** A trusted first device configures recovery and
   saves the separately generated code. The client seals the complete ADK
   version bundle locally, while the backend stores only the opaque envelope
   and public verifier metadata. A new device signs in, receives the current
   envelope, and unlocks it locally with the saved code; no existing device
   needs to be online. WorkOS authentication establishes identity and
   enrollment but is not an encryption key.

   Recovery replacement advances the account security revision and publishes
   a new envelope and code. The old code is not a substitute for the current
   recovery flow; a retained old bundle can open only the historical key
   versions it contains. Passkey-backed encryption unlock is not implemented.

Walkthroughs for both flows are in [Devices and pairing](/docs/sync/devices).

## Rotation on revoke — and the app/web difference

Revoking a device does two different things depending on where you do it:

- **From the app:** a trusted online device mints **ADK v(N+1)** and wraps it
  to every surviving device. Anything sealed after rotation is unreadable to
  the revoked device, even if it still holds ciphertext. Rotation limits
  future access — it does not reach back and erase plaintext the device
  already decrypted.
- **From the website:** the session is severed immediately and account-wide.
  A surviving trusted device learns the revocation during reconciliation and
  rotates before accepting its next new write. If all survivors are offline,
  rotation waits until one reconnects; the revoked device keeps key material
  and plaintext it already received.

## SAS verification

Both devices in a pairing can derive the same **9-digit SAS** (short
authentication string) from the two device public keys — the standard MITM
eyeball check for pairing ceremonies. Sync & Mesh exposes this in the Devices
list through **Compare & approve**. Both devices must show and confirm the
same code before either upgraded client accepts an authenticated key wrap; the
code is a human verification step and is not an encryption key. Legacy
unsigned wraps are rejected by upgraded clients, so resend the pairing or
complete manual verification after upgrading.

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
path in the normal reference flow. This describes the current storage and
client boundary; active key-substitution and replay resistance remain part of
the crypto review.

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

## Trust, unlock, and workers are separate

An enrollment can be authenticated and trusted while it still lacks the ADK;
the recovery-code unlock installs the key locally. Trust policy does not grant
mesh permissions, companion observe/approve/steer permissions, or enable a
worker. The worker remains an explicit device-local opt-in.

## Where keys rest locally

On each device, key material — the ADK versions and the device identity's
private half — lives in the app's local SQLite store, wrapped by the OS
credential store via Electron `safeStorage`. There is no plaintext key file
and nothing key-shaped leaves the device except wraps addressed to a specific
enrolled device's public key.

## Current limits

- Website revocation severs the session immediately. A surviving trusted
  device reconciles the revocation and rotates the ADK before it accepts new
  writes; an offline survivor cannot perform that rotation until it reconnects.
- Recovery-code setup and unlock are separate from WorkOS authentication; an
  authenticated session alone cannot decrypt existing content.
- SAS verification is available from the Devices list for manual approval.
- Rotation cannot erase what a revoked device already decrypted.
- A revocation invalidates the local recovery refresh root; replace recovery
  and save the newly issued code before refreshing the envelope.
- Everything under "What the server can read" is readable. E2E protects
  content, not metadata.
