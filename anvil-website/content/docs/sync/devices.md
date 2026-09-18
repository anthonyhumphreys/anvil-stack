---
title: Devices and pairing
navTitle: Devices and pairing
description: Enroll devices with single-use codes, pair a second device in-app or from the web, manage the roster, and understand exactly what revocation does.
product: Anvil Sync & Mesh
section: Guides
journey: build
order: 50
---

# Devices and pairing

Every device on an account is an independent enrollment. There is no
"logged-in account" shared between machines — each device holds its own
credential, its own X25519 identity, and its own copy of the key material,
and each can be revoked without touching the others.

## The enrollment model

- An **enrollment code** starts every enrollment. Codes are single-use and
  stored hashed at rest — the server never keeps the code itself.
- Codes come from two places: **in-app** (minted by a signed-in device,
  carrying a pairing payload) or **the website** (a bare code minted on
  `/account`, no key material inside).
- Redeeming a code produces a device-scoped credential: an access token plus
  a refresh token bound to that enrollment. The refresh token rotates on use;
  revocation severs the session immediately.
- Each enrollment mints a fresh **X25519 device identity** and publishes the
  public half as a device-identity entity — the crypto boundary other devices
  wrap keys to. See [Encryption and keys](/docs/sync/encryption).

## First device: sign in

1. Settings → Sync & Mesh → pick a backend mode (anything but Local only).
2. Sign in with the account identity — WorkOS on the hosted backend, whatever
   issuer a compatible backend declares.
3. The backend creates the enrollment; the device generates and publishes its
   X25519 identity.
4. The first sealed write mints ADK v1 locally. From that point, everything
   the device syncs is sealed.

## Pair a second device

Two flows. The difference is how the ADK reaches the new device.

### In-app pairing payload

The signed-in device packages the ADK for the new device before the new
device exists.

1. On the enrolled device: **Connect a device**. The backend mints an
   enrollment code; the app seals the ADK inside a pairing blob under a fresh
   one-time secret and queues the blob for the redeemer.
2. Carry the payload to the new device. It looks like
   `anvil-pair-{code}.{nonce}.{secret}` — type it or scan it. The secret in
   the tail is what protects the ADK; it travels only in this string, never
   through the server.
3. On the new device: enter the payload. It redeems the code (the server sees
   only the code), registers the pairing secret locally, pulls the sealed
   pairing blob, and unwraps the ADK.
4. Done — the new device can unseal everything the account has written.

Both devices can derive the same 9-digit SAS from their public keys for a
manual MITM check; the derivation exists but no UI exposes it yet.

### Website bare code

The website cannot see your ADK, so a web-minted code delivers nothing by
itself — key delivery falls to the automatic keyring wrap.

1. On `/account` → devices: mint a pair/link code. It is a bare code — no
   secret, no key material.
2. On the new device: enter the bare code. The device enrolls and publishes
   its device-identity entity.
3. Wait for a trusted device. The next time any already-enrolled device pulls
   and observes the new device identity, it wraps the ADK to the new public
   key; the wrap syncs as a normal sealed entity.
4. The new device unwraps on its next pull. Any outbox rows that deferred for
   want of the ADK seal and go.

Requirement: **at least one trusted device must be online** between steps 2
and 4. If your only enrolled device is off, the new device waits — enrolled
but unable to unseal — until a trusted device next pulls.

## Manage the roster

The Devices section (Settings → Sync & Mesh, and mirrored on `/account`)
lists every enrollment: name, enrollment id, age, status.

- **Rename** sets the display name. Submitting an empty name clears it back
  to the default.
- **Revoke** ends the enrollment. See below — where you revoke from changes
  what happens.
- The current device cannot be revoked from its own UI — that would strand
  the session mid-operation. Revoke it from another enrolled device or from
  the website.
- Revocation is idempotent: revoking an already-revoked device is a no-op.

## What revocation does — and does not do

Both paths sever the device's session immediately and account-wide. They
differ on keys:

| | Session severed | ADK rotated |
| --- | --- | --- |
| Revoke from the app | Yes | Yes — ADK v(N+1) wraps to all surviving devices |
| Revoke from the website | Yes | No — the revoked device keeps its key version |

After an **app-initiated** revoke, anything sealed under the new key version
is unreadable to the revoked device even if it still holds the ciphertext.
After a **web-initiated** revoke, the device cannot pull new ciphertext — but
if it somehow obtains it (a copied file, a forwarded blob), its old key still
opens it.

Neither path erases what the device already decrypted. Rotation limits
future access; it is not a remote wipe. If the device is lost and you want
the full guarantee, revoke from another enrolled device in the app — the web
gap is documented in [Status and limits](/docs/sync/status-and-limits).

## Current limits

- The web-revoke / no-rotation gap above is the sharpest edge in this
  surface.
- The auto-wrap path needs a trusted device online; there is no server-side
  key escrow to fall back on (by design — the server cannot hold what it
  cannot read).
- Pairing-payload redemption is covered by lifecycle tests; the full
  two-device acceptance run on hardware is still pending.
