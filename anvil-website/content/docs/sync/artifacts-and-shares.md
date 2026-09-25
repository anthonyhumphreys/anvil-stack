---
title: Artifacts and share links
navTitle: Artifacts and share links
description: Sealed artifact upload and download, share links whose keys live in the URL fragment, in-browser decryption, and revocation semantics.
product: Anvil Sync & Mesh
section: Guides
journey: build
order: 70
---

# Artifacts and share links

Mesh jobs produce artifacts — files, outputs, captures. Like everything else
in sync, the bytes are sealed on-device before upload; storage holds
ciphertext. Share links add a deliberately different key model on top.

## Upload: reserve, PUT, finalize

Artifact upload is a three-step sealed flow:

1. **Reserve** — the worker asks the backend for an upload slot for the
   artifact.
2. **PUT ciphertext** — the artifact bytes, sealed under the ADK, go straight
   to object storage (R2 on the official backend). The server stores the
   ciphertext; it does not get a decryption path.
3. **Finalize** — the manifest commits. The manifest records `sealed`, the
   `keyVersion` used, and `plaintextBytes` — enough for a downloader to pick
   the right key and check the result, never enough to read the bytes.

## Download and verification

Download reverses it with checks in a fixed order:

1. Fetch the ciphertext and verify its **SHA-256** against the manifest —
   integrity of what arrived, before any decryption attempt.
2. Unseal with the manifest's `keyVersion` — a missing version fails here, not
   later.
3. Check the result against `plaintextBytes` — the decrypted size must match
   what the uploader recorded.

A mismatch at any stage aborts; a corrupt artifact never renders as if it
succeeded.

## Share links

Sharing an artifact mints a **fresh random key per share**, client-side. The
bytes are sealed under that share key, uploaded, and finalized; the URL the
recipient gets carries the key in its fragment:

```txt
https://<site>/artifacts/{id}#k={key}
```

Two properties follow from the fragment:

- **The key never reaches a server.** Browsers do not send URL fragments in
  HTTP requests; the `#k=…` tail stays in the recipient's machine. The server
  holds ciphertext it cannot open, addressed by an id it can revoke.
- **Anyone holding the full link can decrypt.** The link *is* the credential —
  there is no account check on the decrypt path. Treat a share URL like a
  password: paste it where you would paste a password, not in a channel log.

## What the share page does

`/artifacts/{id}` on the website:

1. fetches the ciphertext through a **signed service channel** — the server
   authorizes delivery of the blob without ever seeing the share key;
2. verifies the ciphertext **SHA-256** before decrypting;
3. decrypts in the browser with **WebCrypto AES-GCM**;
4. renders or offers the plaintext for download.

Decryption happens entirely in the recipient's browser. The website never
proxies plaintext.

## Revocation and expiry

- **Revoking a share removes server-side access** — the ciphertext stops
  being servable. Anyone holding the link gets nothing; the fragment key has
  nothing to decrypt.
- **Expiry lapses via a sweep** — shares carry an expiry and a periodic sweep
  removes the ones that lapse. Expiry is enforced at fetch time, not by a
  countdown on your machine.
- Revocation cannot reach bytes already downloaded — as with device
  revocation, it limits future access, it does not recall what was
  legitimately decrypted before.

## Current limits

- The share lifecycle and browser-decrypt path are implemented and
  typechecked; a manual browser click-through on a live deployment is still
  worth doing — that path has the least exercised surface.
- Anyone with the full link can decrypt, forever, until the share is revoked
  or expires. There is no per-recipient access control inside a share link.
- Expiry depends on the sweep running; a share at its expiry boundary may
  serve until the next pass.
