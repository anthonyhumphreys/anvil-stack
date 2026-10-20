# Anvil Sync & Mesh — feature breakdown and user journeys

State: feature/sync-mesh--foundations (commit 3a089b1). Hosted mode is
alpha; everything below reflects implemented behavior, not aspiration.

## Feature breakdown

### 1. Account & device enrollment
- Hosted account keyed to a WorkOS identity; self-host backend supported
  by pointing the app at a custom API URL.
- Enrollment codes minted in-app (with pairing payload) or on the
  website (bare code). Codes are single-use, hashed at rest.
- Each enrollment mints an X25519 device identity, published as a
  crypto-boundary entity. Access + refresh tokens per enrollment;
  refresh rotates, revocation severs immediately.

### 2. End-to-end encrypted entity sync
- Domain entities sync as sealed envelopes (AES-256-GCM, versioned ADK).
  Backend validates envelope shape and journals ciphertext opaquely;
  dedupe rides the hash of the sealed envelope.
- Seal happens at dispatch into sync_outbox.sealed_json — replays reuse
  identical ciphertext. Missing ADK defers the row; plaintext never
  ships as a fallback.
- Pull unseals at the wire→domain boundary. Unseal failure quarantines
  the raw envelope on the binding and retries automatically when the
  missing key version arrives.
- Visible to the backend: ids, types, revisions, sizes, timestamps,
  roster — never content.

### 3. Key distribution & rotation
- First device mints ADK v1 at first seal. New devices receive it via
  (a) the pairing payload sealed under an out-of-band secret, or
  (b) an automatic keyring-wrap once any trusted device observes the
  new device-identity entity.
- Revoking a device from the app mints ADK v(N+1) and wraps it to all
  surviving devices. Post-rotation writes are unreadable to the revoked
  device; it keeps what it already decrypted.
- SAS (9-digit code from both device pubkeys) is derivable for manual
  MITM verification; not yet surfaced in UI.

### 4. Mesh job execution
- Jobs (start-session, diagnostic, prepare-workspace) are created
  against an account, claimed by advertised workers, executed on the
  customer's own hardware with pinned workspace definition revisions.
- Manifest pins repository commits; workers verify Git state before
  spawn. Attempt journals stream as entity changes.
- Provider-neutral: codex/claude/cursor-style providers; compute and
  credentials never leave the user's machines.

### 5. Session handoff
- Durable backend state machine: requested → target-prepared →
  source-quiescing → source-relinquished-and-checkpointed →
  ownership-transferred → target-activating → completed (or cancelled).
- Checkpoint body sealed under ADK (AAD binds the handoff id); the two
  CAS fields stay clear. Target unseals before rendering the
  continuation prompt; missing key or tamper aborts activation.
- Ownership generation increments prevent split-brain session control.

### 6. Artifact storage & sealed share links
- Worker artifacts upload sealed (reserve → PUT ciphertext → finalize);
  manifests carry sealed/keyVersion/plaintextBytes. Download verifies
  ciphertext sha256 before unsealing; plaintextBytes checked after.
- Share links: fresh per-share key in the URL fragment; website
  /artifacts/{id} fetches ciphertext via the signed service channel and
  decrypts in-browser (WebCrypto AES-GCM, sha256 verified first).
- Revocation removes server-side access; expiry lapses via sweep.

### 7. Device & account management (web + app)
- App Settings → Sync & Mesh: pair, list, rename, revoke, export,
  import, delete-account-data, backend selection.
- Website /account: entitlement + limits, device roster + revoke,
  pair/link codes, billing + Stripe portal, deletion status.
- Web revoke severs access but does not trigger ADK rotation (client-
  initiated revokes do). Web pair codes deliver keys via the auto-wrap
  path — needs one trusted device online.

### 8. Data portability & deletion
- data.export.begin/page → client writes a portable JSON document;
  data.import.preview/commit round-trips entities with conflict
  detection. Exported payloads are currently sealed ciphertext —
  round-trips correctly but is not human-readable (unseal-at-export
  is a known follow-up).
- Account deletion disables enrollments first, then purges hosted data
  in bounded passes; status visible on /account/data.

### 9. Billing & entitlement (hosted only)
- Stripe checkout/portal/webhooks; entitlement cached on the account
  object; enforcement denies writes when restricted. Metrics emitted
  for webhook backlog, entitlement decisions, reconcile freshness;
  hourly cron reconciles billing drift.

## User journeys

### A. First device — create a hosted account
1. Anvil → Settings → Sync & Mesh → sign in with WorkOS identity.
2. Backend creates the account + enrollment; device generates its
   X25519 identity and publishes it.
3. First synced write mints ADK v1 locally; everything after is sealed.
4. /account shows entitlement and one active device.
   Verified: engine + keyring unit/integration suites.

### B. Second device — in-app pairing payload
1. Device 1: "Connect a device" → backend mints enrollment code; app
   seals ADK under a fresh pairing secret and queues keyring-pairing.
2. User carries `anvil-pair-{code}.{nonce}.{secret}` to device 2
   (QR or typed).
3. Device 2 redeems the code (server sees only the code), registers
   the pairing secret, pulls the sealed blob, unwraps ADK locally.
4. Both devices derive the same SAS for optional eyeball check.
   Verified: pairing lifecycle unit tests; two-profile acceptance is
   backend-gated and needs a live rehearsal.

### C. Second device — website pair code
1. /account/devices → mint code → enter bare code on the new device.
2. New device publishes device-identity. When device 1 next pulls, it
   auto-wraps the ADK to the new pubkey (keyring-wrap entity).
3. Device 2 unwraps on its next pull; deferred outbox rows seal and go.
   Verified: auto-wrap covered in keyring tests; end-to-end timing
   depends on device 1 being online — document in UX.

### D. Daily sync loop
Edits queue in sync_outbox → seal at dispatch → push → backend journals
ciphertext → peers pull → unseal → domain apply. Conflicts surface on
the binding with local/remote payloads; quarantined entities self-heal
when keys arrive. Offline edits queue and seal when the ADK exists.

### E. Remote job on another machine
1. User creates a job (start session / diagnostic) targeting a device
   or auto requirements; manifest pins workspace revision + commits.
2. An advertised worker claims it, verifies Git state, spawns the
   provider locally, streams attempt journal as sealed entities.
3. Requester watches progress live; artifacts upload sealed to R2.
   Verified: mesh worker + artifact suites; physical multi-device
   demo still pending (the market-readiness gate).

### F. Handoff a running session
1. "Send to device" on the source → backend handoff record.
2. Target prepares (materializes repos at pinned commits), source
   quiesces, seals the checkpoint, relinquishes; ownership transfers.
3. Target unseals the checkpoint, builds the continuation prompt,
   activates under the new generation. Any tamper or missing key
   aborts before a provider call.
   Verified: backend state machine + sealed checkpoint tests.

### G. Share an artifact link
1. Share a chat artifact → per-share key minted client-side; bytes
   sealed, uploaded, finalized; URL = /artifacts/{id}#k={key}.
2. Recipient's browser fetches ciphertext + headers, verifies sha256,
   decrypts with the fragment key, renders/downloads.
3. Revoking the share deletes server-side access; the fragment key
   never touched a server.
   Verified: share lifecycle + browser decrypt path typechecked/built;
   manual browser click-through still worth doing on staging.

### H. Lost device
1. Revoke from any paired device (app) → session severed AND ADK
   rotates; surviving devices get wraps of v(N+1).
   Revoke from the website → session severed; rotation does NOT fire
   (gap — initiate from the app for the full guarantee).
2. Revoked device keeps pre-rotation plaintext it already decrypted.

### I. Leave / take data
Export (app) → sealed-entity JSON; import elsewhere restores account
state for anyone holding the ADK. Delete hosted data (app or web)
→ enrollments disabled, purge passes, status on /account/data.

## Known gaps before marketing
- Web revoke doesn't rotate the ADK.
- Export file is ciphertext — unseal client-side for real portability.
- SAS verification exists in the keyring but has no UI surface.
- No physical multi-device rehearsal yet; hosted mode still needs
  production provisioning (WorkOS app, Stripe live keys, D1 id, secrets).