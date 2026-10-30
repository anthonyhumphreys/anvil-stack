---
title: Artifacts, thread snapshots and share links
navTitle: Artifacts and share links
description: Publish encrypted artifact or thread snapshots, choose guest or organisation access, update links manually and revoke future reads.
product: Mezair Sync & Mesh
section: Guides
journey: build
order: 70
---

# Artifacts, thread snapshots and share links

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

- **The viewer backend does not receive the key.** Browsers omit URL
  fragments from HTTP requests to the viewer. The backend holds ciphertext
  addressed by an id it can revoke. Pasting the full link into a ticket or
  another external service gives that service a copy of the key.
- **The full link carries the decryption key.** For a link-audience share,
  guests can open it without a Mezair account. For an organisation-audience
  share, the server also checks current membership before serving any bytes
  or content metadata. Treat either full URL as a secret.

## Choose an audience

The sender chooses an audience before publishing:

- **Anyone with the link**: a guest can view without logging in.
- **Organisation members**: the reader must sign in as a current member of
  the selected organisation and hold the full link. Viewing does not require
  a paid seat. Membership is checked on every page and download request;
  the sender's own account is not a substitute for membership.

Audience is fixed when the link is created. Updating its snapshot cannot
change the organisation or switch the link to guest access; publish a new
link for a different audience. Older shares without an audience retain guest
access.

For an organisation share, **Sign in to view** keeps the fragment key in
this browser tab's session storage, removes it from that tab's URL during
sign-in, and restores it once if you return within ten minutes. The saved
entry is removed when you return or the tab is closed. The OAuth
return path contains only `/artifacts/{id}`. No key is sent in OAuth state,
query strings, cookies, or the request body. If tab storage is blocked,
sign-in stops and leaves the full link intact. Open the full link again if
the tab was closed or the temporary key expired.

Sign-in proves membership; it does not unlock account encryption keys.
The backend still stores only the share ciphertext. Access denied, expired,
revoked, and damaged or missing key states appear separately where the
server can safely disclose the lifecycle state. An unauthorised reader
receives no title, snapshot, or download metadata.

## What gets shared

The desktop app decides what a link carries before anything is sealed:

| Shared item | What the link carries |
|---|---|
| PDF, Word, PowerPoint, Excel artifacts | The file's raw bytes under its own media type |
| Markdown, CSV, code, text, JSON artifacts | The raw text under its own media type |
| HTML artifacts and kept sketches | A **share bundle** with a static snapshot and the interactive page |
| Mermaid / diagram artifacts | A share bundle whose snapshot embeds the diagram as SVG (the source if no render was available) |
| Native surfaces (reviews, findings, …) that opt in | A share bundle with a read-only snapshot and the redacted data |
| Threads | A read-only snapshot of the selected thread content, with only the attachments and artifacts the sender explicitly includes |

Sketches are never shared directly: sharing a sketch keeps it first, and the
link points at the resulting HTML artifact. Third-party app surfaces are not
shareable.

### Share bundles

A bundle is a JSON document with the media type
`application/vnd.mezair.share+json`, sealed and uploaded exactly like any other
share. It holds:

- `title`, `kind`, `version`, `sharedAt`;
- `digest` — a plain-text summary, shown on the page and used as the frame's
  accessible description;
- `snapshot` — static HTML and CSS, made by the desktop app, never containing
  script. HTML artifacts are loaded once in an offscreen, sandboxed renderer
  and their settled DOM is serialised (scripts stripped);
- `interactive` — for HTML artifacts and kept sketches only: the full,
  self-contained page, with Mezair's light and dark theme tokens inlined so it
  needs no network;
- `payload` — the redacted surface data, for opening the share in Mezair;
- `continuation` — for newer thread shares, structured conversation entries
  and selected context, redacted and encrypted together with the snapshot.

### Thread snapshots and tickets

Thread shares use the same encrypted share bundle and browser viewer. They
are snapshots captured at publication, not a live transcript or an account
sync grant. Review the selected messages, native surface snapshots, artifact
content and attachments before publishing. Binary files cannot be secret
scanned; included files are offered as downloads only after the reader
chooses them. Thread bundles cannot run interactive code.

Thread publication allows at most 16 included files and 8 MiB of decoded
file bytes within a 12 MiB JSON bundle limit. Desktop also limits the
**combined UTF-8 size of snapshot HTML and CSS to 4 MiB**. The viewer validates
each snapshot field separately, with a ceiling of 4,194,304 characters per
field and the same overall bundle and file limits. These limits do not mean
that every source file can be published.

Attach a published snapshot from the share dialog:

1. Under **Attach to ticket**, choose the configured Work Item connection
   and enter the ticket ID. A thread's linked ticket can supply a suggestion.
2. Choose **Preview comment**. Check the resolved ticket title, connection,
   share title, audience and publication date. The preview shows a link label;
   it does not expose the fragment key.
3. Select **I reviewed the ticket and comment preview**, then choose
   **Attach to ticket**. The main process adds the full share link to the
   selected Linear, Jira or Azure DevOps ticket.
4. Check the publication result. A successful local receipt prevents posting
   the same share to the same ticket twice. If publication is pending or its
   outcome is uncertain, inspect the ticket before taking further action;
   Mezair does not automatically retry an ambiguous post.

Changing the connection, ticket or shared snapshot requires reviewing a
fresh comment preview.

When attaching a published thread share to an external ticket, the full URL
includes its key. People and systems with access to that ticket may retain
it. An organisation audience still requires current membership when someone
opens the ticket's link. Updating the existing share publishes a new snapshot
under the same URL; ticket content does not sync automatically. Revoking the
share blocks later server reads but cannot recall downloaded copies or
remove a URL already saved in a ticket.

### Pick up the thread

After a compatible thread share has been decrypted in your browser, choose
**Pick up the thread** to download a `.mezair-thread` continuation package.
Guest and organisation shares use the same download flow. Older snapshots
without structured continuation data ask the author to update the share.

The package contains the shared conversation, reference context, selected
artifacts and attachments, and the static snapshot. It also includes a
source share ID, version and optional viewer URL without a query or fragment.
It does not carry the share key, account credentials, provider session
handles, local source paths or permission grants. Continuation text has a
4 MiB aggregate limit; the package still fits within the overall 12 MiB and
16-file/8 MiB file limits, with a separate 4 MiB combined snapshot limit.

**The downloaded package is readable plaintext.** Anyone with the file can
read it. Organisation membership, share revocation and expiry cannot recall
this downloaded copy. Download only when you intend to keep a local copy.

Open the downloaded file in Mezair, or choose **Open Mezair** and then
**Pick up shared thread…** from the command palette to select it. The app link only opens the import
flow; it sends no share content, link or key. In Mezair, choose your local
workspace and agent, review the imported content, then create a new thread.
Imported context is reference material: it does not reconnect the sender's
repositories, resume their provider session, grant permissions, activate
their goal or plan, or start an agent run. The sender's account and account
encryption keys are not needed.

## Before anything uploads

Sharing from the desktop app opens a preview of the exact static document the
recipient will see first, with the expiry and the include options. Nothing is
uploaded until you publish.

- **Secret scan.** The final plaintext (bundle JSON or raw text) is scanned on
  your device for secret-looking assignments (`API_KEY=…`, `password: …`),
  common token formats (GitHub, AWS access key ids, Slack, OpenAI- and
  Anthropic-style keys, Stripe, Google API keys, JWTs), private key blocks,
  passwords in connection strings, and values you have saved in Mezair's
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
   checks the audience and authorizes delivery without seeing the share key;
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
> your Mezair account, this site's cookies, or the network.

Choosing **Load interactive version** runs the page in a frame with:

- `sandbox="allow-scripts"` and nothing else — no `allow-same-origin` (opaque
  origin: no cookies or storage), no top navigation, popups, forms or modals;
- a Content Security Policy injected ahead of the document:
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`;
- `referrerpolicy="no-referrer"`;
- height driven by `ui/notifications/size-changed` messages, accepted only
  from that frame's own window and clamped to 80–4000 px.

The audience check also applies to interactive shares. Choosing to run the
code remains the recipient's decision, behind that warning.

## Updating a link

Sharing an item again from Mezair offers two paths:

- **Update link** keeps the URL. The app re-seals the item's current version
  under the **same fragment key** (every seal uses a fresh random nonce) and
  calls `share.update`, which reserves replacement bytes for the published
  share. The bytes are PUT to the same upload route and `share.finalize`
  swaps them in with a single row update after verifying size and SHA-256 —
  readers see either the old or the new version, never a mix, and a failed
  verification leaves the published version untouched. The share keeps its
  id, expiry, media type and audience; the page then shows "Version N · updated
  <date>".
- **Share as new link** publishes a separate share with a fresh key, leaving
  the old link frozen at its version. Use it when you want to rotate the key.

Updates are always an explicit action; edits never flow to a link on their
own. An update can't change the media type (it is bound into the seal), so an
item whose format changed needs a new link.

## Where the link lives on your device

The full URL is a bearer credential. The desktop app keeps it only in
OS-backed credential storage (the keychain, or Mezair's encrypted vault); its
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
- Guest links are accessible to anyone with the full URL until revoked or
  expired. Organisation links additionally require current membership. There
  is no named-recipient allowlist inside a share.
- Expiry is checked on each fetch. The sweep removes expired stored bytes.
- Updating a link reuses its key. A holder who still meets the audience rule
  can read later versions until revocation or expiry; use **Share as new link**
  to rotate the key.
- Interactive pages run on the website's own origin, isolated only by the
  sandbox (opaque origin, no network). Serving them from a separate
  user-content origin is planned hardening, not done yet.
- The secret scan is pattern-based. It catches common formats and the
  credentials Mezair stores; it will miss secrets in unusual shapes and can
  flag harmless strings. Review the preview, not just the findings list.
- Snapshot frames can't size themselves to their content; long snapshots
  without a measured height scroll inside the frame.

## Self-hosted viewers

A self-hosted backend needs an explicitly configured, compatible share
viewer. Configure its viewer origin and signed service channel together;
do not send a self-hosted ciphertext id to the official viewer. Organisation
shares also need the matching WorkOS client and server-side membership
integration. A viewer without those capabilities must fail closed instead
of turning organisation shares into public guest links.
