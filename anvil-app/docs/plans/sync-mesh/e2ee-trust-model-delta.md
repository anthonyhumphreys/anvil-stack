# Sync & Mesh — E2EE trust-model delta and web dashboard

Branch: `feature/sync-mesh--foundations` · PR #91
Reviewed head: `49a79a2950534412ecc2236fd1abda5e5bc74d54` (current worktree head at time of writing)
Companion docs: `anvil-sync-mesh-spec-v2.md`, `cloud-environments.md`, `anvil-backend-integration-contract.md`

This is the architecture delta the implementation in this change set follows. It records the verified findings against the current head, the simplification that removes their shared cause, the dashboard construction, and the migration implications.

## 1. Verified findings at the reviewed head

| ID | Evidence at `49a79a2` | Resolution in this delta |
| --- | --- | --- |
| **A** — env bootstrap carries ADK material | `issueEnrollmentCode({enrollmentClass:'ephemeral'})` calls `mintPairingPayload`, which seals the current ADK under a pairing secret and embeds that secret in the `anvil-pair-…` string. For `anvil-managed`, the full payload is staged through `environment.bootstrap` (`environment_bootstrap` table), which the backend's internal claimer reads — i.e. the coordinator can unwrap the account data key from the `keyring-pairing` entity it already stores. BYO provisioners also mint full pairings on the claiming device. | Environments enroll with an **ephemeral-class enrollment code only**. `environment.bootstrap` carries `{ enrollmentCode }`; `anvil-pair-…` payloads are rejected there. The bootstrap document is `{ kind:'anvil.mesh-environment', schemaVersion:'0.2', enrollmentCode, … }`; `boot.mjs` runs `anvil-daemon enroll --code`. Envs get task-scoped keys via `taskkey.*` wraps, never ADKs. |
| **B** — plaintext prompts in `inputManifest.inputs` | `createStartSessionJob`/`createCodeTaskJob`/`createWorkflowNodeJob` put `prompt`, `verification`, `sandbox`, `handoffId`, `dispatchId`… verbatim in the manifest the account object persists (`jobs.input_manifest`). | `job.create` gains `sealedInputs`: an AES-256-GCM envelope under a random **task content key (TCK)**, bound by AD to `backendId|accountId|requestId`. `manifest.inputs` is restricted to a public allowlist. TCK is delivered per-job to the resolved target and designated result recipients via `taskkey.deliver`/`taskkey.pull` wraps sealed to the recipient X25519 identity — same construction as credential grants, job-scoped rather than attempt-scoped. |
| **C** — revocation excludes only the just-revoked enrollment | `rotateAccountKey(scope, [enrollmentId])` excludes only that call's argument; `handleCryptoBoundaryEntity` auto-wraps the current ADK to **any** device-identity announcement, including previously-revoked and ephemeral enrollments. | Durable per-device **trust membership** (`sync_device_trust`: `pending`/`trusted`/`revoked`). Every ADK delivery path — identity-sighting wraps, rotation fan-out, pairing, recovery, repair — consults it. Enrollments arrive `pending`; pairing redemption, recovery-code unlock, explicit user approval after mutual SAS confirmation, or the explicit automatic-auth policy promotes to `trusted`. Revoked is sticky and survives re-announcement. |
| **D** — only the current ADK version is delivered | `KeyringWrapPayload`/`PairingKeyringInner` carry a single version; a fresh trusted device cannot read pre-rotation ciphertext. | All deliveries carry a **version bundle** (`KeyringWrapPayload` v2, `PairingKeyringInner` v2: `keys: [{keyVersion, adk}]`). Every trusted delivery sends every held version, so missed-rotation recovery is the same path as first delivery. |
| **E** — remote effect before durable dispatch | `dispatchWorkflowNode` calls `createWorkflowNodeJob` (job.create RPC) *before* inserting `mesh_node_dispatches`. The comment already claimed the opposite. | The immutable request (params incl. sealedInputs + TCK wraps) is persisted in `request_json` **before** the first RPC; reconcile resubmits the persisted bytes, never a recomputed manifest. |
| **F** — persisted cancel intent is never replayed | `reconcileDispatchesOnBoot` → `refreshActiveDispatches` only does `job.get`; a `cancel_requested=1` row whose `job.cancel` RPC failed is never re-driven. | Boot/refresh reconciliation re-issues `job.cancel` for cancel-requested dispatches whose job is still non-terminal. |

## 2. Actor model — three decryption scopes, one crypto stack

| Actor | Authority | Key material |
| --- | --- | --- |
| **Trusted Mesh Device** (desktop/daemon, pairing-, recovery-, SAS-, or policy-approved) | Full sync, job source, key delivery, dashboard grant issuer | ADK bundle (all held versions), own X25519 identity, task keys it sourced or received |
| **Dashboard Client** (browser) | Approved read scope + explicitly granted actions (`read-dashboard`, `submit-task`, `approve-action`, `request-handoff`) | Ephemeral browser X25519 keypair (non-exportable CryptoKey), a per-grant dashboard session key (DSK) wrapped to it, task keys it minted |
| **Execution Mesh Worker** (incl. ephemeral envs) | Claim + execute under local policy | Own X25519 identity, per-job TCK (job-scoped wrap), per-attempt credential grants |
| **Coordination backend** | Auth, routing, scheduling, presence, billing, opaque ciphertext storage | Nothing that opens protected content |

One envelope family covers all three scopes: AES-256-GCM content seals, X25519 + HKDF-SHA256 + AES-256-GCM recipient wraps, out-of-band pairing secrets. The differences are *authorisation rules*, not new cryptography.

## 3. What the coordinator can see

- Sync: entity types/ids/revisions/sizes, device roster, pairing/keyring ciphertext, rotation records.
- Mesh: job metadata (kind, states, fences, placement, deadlines, attempts), the **public allowlist** of `manifest.inputs`, sealed-input ciphertext, task-key wrap envelopes, credential-grant envelopes, artifact manifests + sealed bytes, environment lifecycle rows, dashboard request metadata (browser pubkey fingerprint, scopes, expiry — the grant itself is a sealed envelope).
- Never: ADK bytes or wraps it can open, pairing secrets (with A fixed, no `anvil-pair` payload ever transits backend storage), task plaintext, sealed results, dashboard snapshot plaintext.

Account-key deliveries authenticate the sender with a static X25519-derived
MAC and require a pinned, locally verified sender identity. Pairing receipts
authenticate the recipient identity with a MAC under the out-of-band pairing
secret. Forged deliveries and rebound receipts are rejected. The coordinator
can still withhold data or deny service; endpoint compromise remains outside
this confidentiality boundary.

## 4. Public-field allowlist for `manifest.inputs`

Fields the backend legitimately reads or that are pure routing metadata stay public:

`workspaceId` (opaque id — needed for the ready-replica placement check), `environmentId`, `provider`, `ttlSeconds`, `imageRef`, `networkPolicy`, `resources`, `connectionId`, `displayName` (provisioning routing/validation).

Everything else — `prompt`, `verification`, `personaId`, `reasoningEffort`, `sandbox`, `cliMinVersion`, `turnTimeoutMs`, `handoffId`, `dispatchId`, `runId`, `nodeId`, `refPolicy`, `resultTransfer`, any free text — moves into `sealedInputs`. The worker merges public + unsealed inputs at execution; validators read the merged view. `payloadHash` covers `{kind, requestedTarget, inputManifest, sealedInputs}` so retries replay identically.

Result direction: the attempt's rich result manifest, verification detail, and error text are sealed under the TCK into the evidence artifact (`keyKind: 'task'`); the public `attempt.report` result carries only commits, branches, artifact ids, exit codes, and a bounded error string.

## 5. Task key lifecycle

- TCK: 32 random bytes per job, minted by the source (device *or* browser).
- `taskkey.deliver` deposits wraps `{jobId, targetEnrollmentId, ephPub, nonce, ct}` — inner `{v:1, kind:'task-key', key}` sealed to the recipient identity, AD `anvil/task-key/v1|account|job|target`. Idempotent per (job, target); not fence-bound (the key is task-scoped, retries of identical input reuse it).
- `taskkey.pull {jobId}` returns the caller's wraps — used by the claiming worker and by designated `resultRecipients` (trusted devices that must read results later, e.g. after the submitting browser closed).
- A job whose target is resolved but has no wrap is surfaced as `keyDelivery: 'pending'` (`awaiting-key-delivery`) — honest waiting, never server-side unlocking. The source's dispatch reconcile watches `job.get` and delivers the wrap when a late-bound target (auto placement, env enrollment) appears.

## 6. Trust membership and rotation reconciliation

`sync_device_trust (backend, account, enrollment_id, state, decided_at)`:

- `pending` — seen via device-identity; no key delivery. Default for OIDC/enrollment-code devices and ephemeral envs.
- `trusted` — a peer identity verified locally by the user (SAS comparison in
  Sync & Mesh settings) or an authenticated pairing. The client's own identity
  is locally trusted but has no account key until bootstrap or key delivery.
  The account's automatic policy changes server enrollment membership, not
  this local permission to send keys to a peer.
- `revoked` — sticky; set on local `device.revoke` and on remote revocation learned via `device.list` reconcile each sync cycle. Never deliverable again, even on identity re-announcement.

Rotation:

- `rotateAccountKey` mints v(N+1), delivers the **full bundle** to every `trusted` non-revoked device, and publishes a `keyring-rotation` entity `{rotationId, rotorEnrollmentId, fromVersion→toVersion, revokedEnrollmentIds, at}`.
- Concurrent rotations on the same version resolve deterministically: lowest `rotationId` wins. The loser supersedes — drops its key row, installs the winner's wrap, re-seals pending outbox rows under the winning key, and re-pushes entities it wrote under the orphaned key.
- Web-initiated revoke: `device.revoke` cuts sessions immediately; the account object records `keyring_rotations.pending`. A trusted device learns the revocation on its next `device.list` reconcile, rotates, and reports `keyring.report` — the dashboard distinguishes *access revoked* from *rotation pending/completed* honestly.
- A revocation also invalidates the local recovery refresh root. After the
  surviving device rotates, recovery must be replaced with a newly saved code
  before another envelope refresh; a cached old bundle remains limited to the
  historical versions it contains.

### 6.1 Device-trust policy modes

The account policy controls how a newly authenticated device becomes a
trusted enrollment. It does not rewrite existing membership, resurrect a
revoked enrollment, enable a worker, or grant companion observe/approve/steer
permissions.

- **`require-approval` (default):** an enrollment authenticated by OIDC or an
  enrollment code remains `pending` until the user compares the displayed SAS
  in Sync & Mesh on both devices and both ends authenticate and confirm it.
  Neither side installs the authenticated key wrap before that mutual check.
  The pending device may complete the recovery-code flow instead when the user
  has saved the account recovery code; the code unlocks the ADK bundle locally
  and the backend records the recovery proof.
- **`auto-trust-authenticated` (explicit):** a new eligible authenticated
  enrollment can become `trusted` from the account policy. It is still an
  enrollment decision, not key delivery: when the device has no local ADK,
  it must use the current recovery envelope and saved recovery code. WorkOS
  authentication is never used as a decryption secret.
- **`revoked`:** sticky across refresh, identity re-announcement, and policy
  changes. A new enrollment is required after revocation; an old identity
  cannot be promoted by automatic policy evaluation.

### 6.2 Threat-model boundaries for manual and automatic trust

Manual approval limits the set of devices that become eligible for ADK
delivery, at the cost of requiring an enrolled device or saved recovery code
for each new device. Automatic trust removes the approval round trip for
eligible authentication proofs, so an identity-provider or session compromise
can create a trusted membership sooner. It still does not provide the ADK or
the client-held recovery secret.

Recovery is a separate client secret. The client seals the ADK version bundle
and the backend stores the opaque envelope plus revision and verifier
metadata. A new device must possess the saved recovery code to decrypt the
bundle. Recovery replacement publishes a new envelope and advances the
revision; a cached old bundle, if retained with its code, is limited to the
historical key versions it contains.

Recovery signatures bind the action, account, backend, enrollment, device
identity, recovery root, revision, one-use challenge, and mutable request hash.
The verifier is pinned in durable account state. Sender-authenticated account
wraps and pairing receipts also bind their recipients; server roster metadata
cannot replace local identity verification. Compromised clients and workers
can expose plaintext available to those authorized endpoints regardless of
the trust policy.

## 7. Dashboard construction (chosen approach)

Scoped encrypted projection — **not** a browser ADK, not a second sync engine:

```text
trusted device decrypts authorised state
    -> selects dashboard-visible fields (bounded snapshot)
    -> seals under a per-grant dashboard session key (DSK)
    -> backend stores ciphertext + minimum public grant metadata
    -> browser unwraps DSK to its ephemeral keypair and decrypts locally
```

- **Request**: browser generates a non-exportable X25519 keypair (WebCrypto; unsupported browsers get an explicit `unsupported` state — no silent downgrade), posts `{requestId, browserPub, challenge, scopes, expiry, origin, userAgent}` through the signed hosted channel into `dashboard_requests` on the account object.
- **Approval**: a trusted device polls `dashboard.requests` inside its sync loop, shows the request (origin, scopes, expiry, fingerprint) in Sync & Mesh settings, and on approve seals `{dsk, scopes, expiresAt}` to the browser pub (AD binds account/request/pub/expiry) plus a first snapshot sealed under the DSK (`anvil/dashboard/v1|…|requestId|seq`). The coordinator stores both envelopes unreadable.
- **Updates**: `dashboard.publish` replaces the sealed snapshot at a monotonically increasing `seq`; the browser polls `dashboard-status`/`dashboard-snapshot` through the hosted channel. Stale/partial/live is explicit in the snapshot (`seq`, `producedAt`, `sourceOnline`).
- **Actions**: hosted job-create requires an approved grant containing `submit-task` (the `requestId` doubles as job `requestId` namespacing); `approval-decide` and `handoff-create` likewise gate on their scopes. `job.cancel`/`device.revoke` stay available under the account-owner policy while locked.
- **Browser jobs**: the browser mints the TCK, seals `sealedInputs`, wraps the TCK to the chosen target's pub + a durable result-recipient device pub, and submits the whole immutable request through `/internal/hosted/job-create` — plaintext never touches the website server (server actions relay ciphertext).

Snapshot contents (bounded, versioned): devices + trust state, environments, jobs (metadata + readable inputs where this device holds the TCK/ADK), approvals with action context, handoffs with readiness, recent activity. Capped at ~256KB / newest-N per section.

## 8. Migration and compatibility

- App DB: schema 85 adds `sync_device_trust`, `mesh_task_keys`, `mesh_dashboard_state`. Existing enrollments map: own enrollment → `trusted`; everything else → `pending` (re-approval required — deliberately fail-closed; pre-existing trusted devices re-pair or are SAS-approved once).
- `KeyringWrapPayload`/`PairingKeyringInner` v1 readers stay supported (single-key inner still installs).
- `environment.bootstrap` rejects `anvil-pair-…` outright — a pending managed provision created by an older client fails visibly rather than leaking a secret.
- `manifest.inputs` public allowlist is enforced client-side at create; older jobs with plaintext inputs remain readable to their workers (no retroactive secrecy is claimed).
- Sealing is **fail-closed**: a job request carrying private inputs without an active sync scope throws in `prepareSealedJob` rather than falling back to writing them into the public manifest. There is no code path that silently downgrades private inputs to coordinator-visible plaintext.
- Boot image `schemaVersion: '0.2'` accepts `enrollmentCode`; `0.1` docs with `pairing` still enroll but receive no ADK path — env images rebuild anyway.
- Key delivery hardening is an upgrade boundary: upgraded clients bind a wrap
  to the pinned/local device identities and require the two-device SAS
  confirmation before installing account keys. They reject unsigned legacy
  wraps; resend a pairing payload or complete the manual verification flow
  after upgrading. Pairing receipts likewise remain bound to the account,
  backend, nonce, and recipient.

## 9. Honest limits (threat-model statements)

- Compromised browser bundle/endpoint/worker: plaintext visible to that endpoint can be exposed; scope limits damage, E2EE does not protect a compromised authorised endpoint.
- `anvil-managed` runtime operator controls both coordination and executor code — managed execution is *not* confidential from the platform operator; only the task's ADK-exclusion is guaranteed.
- Revocation is prospective: received keys/plaintext cannot be withdrawn; offline clients learn revocations on reconnect.
- The dashboard website's code delivery is its trust anchor (CSP, no third-party scripts on unlocked surfaces); a party that can replace the delivered JS can capture post-unlock plaintext.
- Key-wrap injection and pairing-receipt rebinding are explicit active-server
  audit cases. The client-side bindings and mutual SAS confirmation are the
  required mitigation for upgraded clients; this delta does not claim that an
  unreviewed legacy client resists those attacks.

## 10. Code removed by this delta

- `mintEnvironmentPairing` dependency plumbing in `requestCloudEnvironment`, `executeProvisionEnvironment`, `requestEnvironment` — replaced by ephemeral enrollment codes.
- The `anvil-pair-…` staging path through `environment.bootstrap`/`environment_bootstrap` (payload column now holds an enrollment code only).
- Auto-wrap-on-identity-sighting (the conflation of *enrollment* with *decrypt permission*).
