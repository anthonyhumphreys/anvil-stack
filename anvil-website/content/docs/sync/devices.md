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

- A hosted daemon can start with WorkOS Device Authorization. WorkOS returns a
  public user code and verification URI; the daemon keeps the private device
  code for polling and never prints it. There is no loopback redirect in this
  flow.
- An **enrollment code** is the compatible-backend bootstrap path. Codes are
  single-use and stored hashed at rest — the server never keeps the code itself.
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
2. For a hosted headless machine, run:

   ```sh
   anvil-daemon sign-in --api-url https://<backend>
   ```

   The command prints the WorkOS verification URI and public user code, then
   waits for approval. Add `--worker` only for a machine that should execute
   Mesh jobs. For a self-hosted enrollment-code bootstrap, issue the first code
   from that backend's operator `/account` page, then use normal device
   management afterward.
3. Desktop sign-in uses the WorkOS issuer and public client advertised by the
   backend; a compatible backend uses whatever issuer it declares.
4. The backend creates the enrollment; the device generates and publishes its
   X25519 identity.
5. The first sealed write mints ADK v1 locally. From that point, everything
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
4. In Sync & Mesh on both devices, open **Compare & verify** and confirm the
   same SAS. Both ends must authenticate and confirm the matching value before
   either client accepts the key delivery. Upgraded clients reject an
   unsigned legacy wrap; after upgrading, resend the pairing payload or use
   the manual verification flow.
5. Done — the new device can unseal everything the account has written.

Both devices can derive the same 9-digit SAS from their public keys for a
manual MITM check. The Devices list exposes this through **Compare & verify**;
both devices must show and confirm the same code before an authenticated wrap
is accepted.

### Recovery-code unlock

A website code starts enrollment but carries no key material. Configure
recovery on the first trusted device, then save the generated recovery code
separately. The new device can recover without an online peer:

1. On `/account` → devices, mint a pair/link code. It is a bare enrollment
   code; the website never sees the recovery code or ADK.
2. On the new device, sign in (or run the daemon's `sign-in` command) and
   redeem the enrollment code.
3. Use the device security recovery flow with the saved recovery code. The
   device decrypts the opaque recovery envelope locally and installs the ADK
   version bundle.

WorkOS authentication proves identity and creates the enrollment; it does not
decrypt account content. Recovery replacement issues a new code and replaces
the current backend envelope, so save the new code before discarding the old
one. A retained old bundle can open only the historical key versions it
contains. Future authenticated enrollments require manual approval by default;
`auto-trust-authenticated` is an explicit account policy and does not promote
existing pending devices. Manual approval compares the same 9-digit SAS on both
devices. Desktop exposes this as **Compare & verify** on both ends. A headless
daemon uses `anvil-daemon security verify <enrollmentId>` on each device, then
both devices run `anvil-daemon security approve`: the existing trusted device
approves the new enrollment and sends the authenticated key wrap, while the
new device approves the old enrollment locally to accept that wrap. The
website roster can show and revoke devices, but it cannot perform this
key-delivery approval by itself. Passkey-backed encryption unlock is not
implemented.

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
| Revoke from the website | Yes | Reconciled by a surviving trusted device before its next new write |

After an **app-initiated** revoke, anything sealed under the new key version
is unreadable to the revoked device even if it still holds the ciphertext.
After a **web-initiated** revoke, a surviving trusted device learns the
revocation during reconciliation and rotates before accepting new writes. If
all surviving devices are offline, that rotation waits until one reconnects;
the revoked device keeps any key material and plaintext it already received.

Neither path erases what the device already decrypted. Rotation limits
future access; it is not a remote wipe. Revoke from an enrolled device in the
app when you need the rotation to happen immediately; website revocation
rotates when a surviving trusted device next reconciles, as described in
[Status and limits](/docs/sync/status-and-limits).

## Current limits

- Web revocation depends on a surviving trusted device reconnecting to perform
  the client-side rotation; app revocation from an online trusted device can
  rotate immediately.
- Recovery-code unlock needs the separately saved client secret; there is no
  server-side key escrow to fall back on, so the code must remain separately
  saved by the user.
- Upgraded clients reject unsigned legacy key wraps. Re-pair or complete the
  two-device SAS confirmation after upgrading.
- A device revocation invalidates the local recovery refresh root; replace
  recovery and save the newly issued code before refreshing that envelope.
- Pairing-payload redemption is covered by lifecycle tests; the full
  two-device acceptance run on hardware is still pending.
