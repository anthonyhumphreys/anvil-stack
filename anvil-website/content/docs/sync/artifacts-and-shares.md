---
title: Artifacts and share links
navTitle: Artifacts and share links
description: Upload encrypted files, create share links, preview shared content in a browser and revoke access.
product: Anvil Sync & Mesh
section: Guides
journey: build
order: 70
---

# Artifacts and share links

Mesh jobs can produce files, reports and captures. These artifacts are
encrypted on your device before upload. Share links use a separate key for
each share, so a recipient can open that item without access to your account.

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

## What gets shared

The desktop app decides what a link carries before anything is sealed:

| Shared item | What the link carries |
|---|---|
| PDF, Word, PowerPoint, Excel artifacts | The file's raw bytes under its own media type |
| Markdown, CSV, code, text, JSON artifacts | The raw text under its own media type |
| HTML artifacts and kept sketches | A **share bundle** with a static snapshot and the interactive page |
| Mermaid / diagram artifacts | A share bundle whose snapshot embeds the diagram as SVG (the source if no render was available) |
| Native surfaces (reviews, findings, …) that opt in | A share bundle with a read-only snapshot and the redacted data |

Sketches are never shared directly: sharing a sketch keeps it first, and the
link points at the resulting HTML artifact. Third-party app surfaces are not
shareable.

### Share bundles

A bundle is a JSON document with the media type
`application/vnd.anvil.share+json`, sealed and uploaded exactly like any other
share. It holds:

- `title`, `kind`, `version`, `sharedAt`;
- `digest` — a plain-text summary, shown on the page and used as the frame's
  accessible description;
- `snapshot` — static HTML and CSS, made by the desktop app, never containing
  script. HTML artifacts are loaded once in an offscreen, sandboxed renderer
  and their settled DOM is serialised (scripts stripped);
- `interactive` — for HTML artifacts and kept sketches only: the full,
  self-contained page, with Anvil's light and dark theme tokens inlined so it
  needs no network;
- `payload` — the redacted surface data, for opening the share in Anvil.

## Before anything uploads

Sharing from the desktop app opens a preview of the exact static document the
recipient will see first, with the expiry and the include options. Nothing is
uploaded until you publish.

- **Secret scan.** The final plaintext (bundle JSON or raw text) is scanned on
  your device for secret-looking assignments (`API_KEY=…`, `password: …`),
  common token formats (GitHub, AWS access key ids, Slack, OpenAI- and
  Anthropic-style keys, Stripe, Google API keys, JWTs), private key blocks,
  passwords in connection strings, and values you have saved in Anvil's
  credential storage. Hits are shown masked; each one is redacted (replaced
  with `[redacted]`) unless you explicitly confirm it is safe to publish.
  Binary files can't be scanned and the preview says so.
- **Agents can't share silently.** The `share_item` agent tool asks you to
  approve a summary (title, contents, secret findings, whether it's
  interactive) first, redacts every finding, and returns only the share id
  and expiry. The link goes to your clipboard; it never enters the model's
  context or the app's logs.

## What the share page does

`/artifacts/{id}` on the website:

1. fetches the ciphertext through a **signed service channel** — the server
   authorizes delivery of the blob without ever seeing the share key;
2. verifies the ciphertext **SHA-256** before decrypting;
3. decrypts in the browser with **WebCrypto AES-GCM**;
4. renders or offers the plaintext for download.

Decryption happens entirely in the recipient's browser. The website never
proxies plaintext.

Static content (markdown, HTML, bundle snapshots) renders in a `sandbox=""`
frame under a `script-src 'none'` policy, after DOMPurify sanitisation. The
frame has an opaque origin and no scripts, so the page can't measure it: it
uses the height the sharer's app measured when available, and can be resized
by hand.

### Interactive shares

When a bundle carries an interactive page, the share page first shows the
digest and the static snapshot behind a warning:

> **This share runs interactive code.** This page runs code that came with the
> link. Only continue if you trust the person who shared it. It can't access
> your Anvil account, this site's cookies, or the network.

Choosing **Load interactive version** runs the page in a frame with:

- `sandbox="allow-scripts"` and nothing else — no `allow-same-origin` (opaque
  origin: no cookies or storage), no top navigation, popups, forms or modals;
- a Content Security Policy injected ahead of the document:
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`;
- `referrerpolicy="no-referrer"`;
- height driven by `ui/notifications/size-changed` messages, accepted only
  from that frame's own window and clamped to 80–4000 px.

"Anyone with the link" is literal for interactive shares too: the decision to
run the code is the recipient's, behind that warning.

## Updating a link

Sharing an item again from Anvil offers two paths:

- **Update link** keeps the URL. The app re-seals the item's current version
  under the **same fragment key** (every seal uses a fresh random nonce) and
  calls `share.update`, which reserves replacement bytes for the published
  share. The bytes are PUT to the same upload route and `share.finalize`
  swaps them in with a single row update after verifying size and SHA-256 —
  readers see either the old or the new version, never a mix, and a failed
  verification leaves the published version untouched. The share keeps its
  id, expiry and media type; the page then shows "Version N · updated
  <date>".
- **Share as new link** publishes a separate share with a fresh key, leaving
  the old link frozen at its version. Use it when you want to rotate the key.

Updates are always an explicit action; edits never flow to a link on their
own. An update can't change the media type (it is bound into the seal), so an
item whose format changed needs a new link.

## Where the link lives on your device

The full URL is a bearer credential. The desktop app keeps it only in
OS-backed credential storage (the keychain, or Anvil's encrypted vault); its
local `shares` table records the share id, the version shared, the expiry and
revocation, never the key. Links created before this table existed are moved
out of the old SQLite column into credential storage on startup. If secure
storage isn't set up, publishing still works and copies the link once, but
the app can't copy or update that link later.

## Revocation and expiry

- **Revoking a share removes server-side access** — the ciphertext stops
  being servable. Anyone holding the link gets nothing; the fragment key has
  nothing to decrypt. A pending update is discarded with it.
- **Expiry lapses via a sweep** — shares carry an expiry and a periodic sweep
  removes the ones that lapse. Expiry is enforced at fetch time, not by a
  countdown on your machine. Abandoned update uploads are swept too.
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
- Updating a link reuses its key. Anyone who ever had the link can read every
  later version until it is revoked or expires; use **Share as new link** to
  rotate.
- Interactive pages run on the website's own origin, isolated only by the
  sandbox (opaque origin, no network). Serving them from a separate
  user-content origin is planned hardening, not done yet.
- The secret scan is pattern-based. It catches common formats and the
  credentials Anvil stores; it will miss secrets in unusual shapes and can
  flag harmless strings. Review the preview, not just the findings list.
- Snapshot frames can't size themselves to their content; long snapshots
  without a measured height scroll inside the frame.
