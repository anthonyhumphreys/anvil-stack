# E2E encryption for hosted sync — implemented design

Status: implemented on feature/sync-mesh--foundations (commit 3a089b1).
Contract: anvil-app/cloud/contract/sealed.ts. Client keyring:
src/main/services/sync-keyring.service.ts.

## Threat model
Honest-but-curious backend: stores/journals ciphertext, validates
envelope structure only. Visible metadata: entity ids/types, revisions,
sequences, sizes, timestamps, device roster, job/session records.
Active-MITM at pairing is tamper-evident (AEAD failure); SAS comparison
available for manual verification.

## Primitives (Node crypto / WebCrypto only)
- AES-256-GCM, random 96-bit nonces — entities, artifacts, checkpoints,
  share blobs
- X25519 device identities + HKDF-SHA256 + AES-256-GCM key wraps
- SHA-256 for payload/artifact hashes and SAS derivation

## Key hierarchy
- ADK: versioned 256-bit account data key; first device mints v1 at
  first seal; a peered device without a key defers (never falls back to
  plaintext, never mints a divergent key)
- Per-device X25519 identity published as a device-identity entity
- ADK delivered via keyring-wrap entities (sealed to recipient pubkey)
  or keyring-pairing entities (sealed under an out-of-band secret in
  the anvil-pair-… payload; server sees only the enrollment code)
- Local persistence: sync_keyring/sync_device_keys/sync_pairing/
  sync_keyring_deliveries tables, secrets safeStorage-wrapped (plain-
  buffer fallback where safeStorage is unavailable — same model as
  existing credential storage)
- Revoke → trusted device mints ADK v(N+1), wraps to surviving devices;
  revoked device keeps pre-rotation reads (documented limit)

## Wire model
- Entity payload = {enc:'aes-256-gcm', keyVersion, nonce, ct};
  payloadHash covers the canonical sealed envelope (dedupe preserved)
- Entity AD binds backendId|accountId|entityType|entityId|keyVersion;
  operation/schemaVersion deliberately excluded (re-openable on
  quarantine retry; integrity already bound by payloadHash)
- seal at dispatch into sync_outbox.sealed_json — replays reuse the
  exact ciphertext; missing ADK defers the row
- pull unseals at the wire→domain boundary before bindings/conflicts/
  domain apply; UnsealError → quarantine raw envelope on the binding,
  retried on later key delivery
- crypto-boundary entities bypass domain sealing and are consumed by
  the keyring before domain handling

## Artifacts / shares / checkpoints
- Artifact bytes: nonce‖ct‖tag under ADK; manifest carries sealed,
  keyVersion, plaintextBytes; sha256 covers ciphertext
- AAD is media-type-bound (anvil/artifact-seal/v1|{mediaType},
  anvil/share-seal/v1|{mediaType}) — artifact/share ids cannot be bound
  because reserve/create needs the ciphertext hash before minting the
  id; the sha256-over-ciphertext check provides the binding instead
- Shares: fresh random per-share key in the URL fragment (#k=…);
  website fetches ciphertext via the signed channel and decrypts
  in-browser with WebCrypto; revocation removes the ciphertext
- Checkpoints: sessionId + sourceGeneration stay clear for backend CAS;
  body sealed under ADK bound to handoffId; target unseals before the
  continuation prompt and fails closed on missing key/tamper

## Backend
- Push rejects malformed envelopes (envelope-invalid)
- artifact.reserve/finalize + share.create/finalize record and
  consistency-check seal manifests (manifest-mismatch → 409)
- Additive columns via ensureColumn for existing DO SQLite tables
- Share read emits x-anvil-share-sealed/-sha256/-plaintext-bytes for
  the browser decryptor

## Test/verification state
- Backend: 279 tests — sealed push envelopes, artifact/share manifests,
  sealed checkpoint CAS
- App: 1258 tests — keyring (22), persistence sealed dispatch/replay/
  deferral (36), engine + failure-injection + integration green
- Typechecks: app (tsc -p tsconfig.node.json), backend, website; app
  and website builds pass
- Two-profile acceptance gate is backend-gated (skips without a live
  backend) — updated to unseal checkpoints via the keyring but still
  needs a real-deployment rehearsal