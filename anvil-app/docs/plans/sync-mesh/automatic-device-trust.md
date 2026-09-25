# Automatic device trust: implementation and architecture

Implemented on `feature/sync-mesh--foundations`: account trust policy,
desktop setup and settings, recovery-code unlock, and headless security
commands. These changes require both an updated backend and updated clients;
local verification does not deploy them to a hosted environment.
The architecture review began at commit `131ed7d`.

The selected experience is **sign in, then unlock with a separately saved
recovery code**. The code is the client-held decryption secret for a new
device, so no existing peer needs to be online. WorkOS authentication proves
identity and enrollment; it does not decrypt account content by itself.

## Current enrollment and key delivery

`cloud/backend/src/session-coordinator.ts` verifies enrollment codes or OIDC
proofs in `handleEnroll`, resolves the account, and creates a device session.
Authentication does not deliver an account encryption key. WorkOS stays an
identity provider.

`src/main/services/sync-keyring.service.ts` owns client key generation,
storage, trust decisions, and delivery. `sync_device_trust` is a client-side
SQLite table, not an authoritative backend account membership table:

- `publishDeviceIdentity` marks the client's own enrollment trusted locally.
  That does not grant it the existing account's encryption keys.
- `handleCryptoBoundaryEntity` records newly observed peers as pending.
- `isKeyDeliverable` gates recipient key delivery on local trusted membership.
- Approval cannot override revoked membership. A revoked cryptographic
  identity needs an explicit new enrollment; reannouncement cannot restore it.
- `approveDeviceTrust` in `sync-runtime.service.ts` implements explicit local
  approval. Pairing supplies a separate proof of possession.

`wrapAccountKeyFor` encrypts the held account-key version bundle for a
recipient's public key. A client holding the account keys produces this
recipient-specific ciphertext. Merely changing a recipient's trust state
cannot produce it while that client is offline.

The final delivery path authenticates the wrap against the locally verified
issuer and pinned recipient identities. Manual approval requires both devices
to compare and confirm the same SAS before either side installs the key wrap;
upgraded clients reject unsigned legacy wraps, which must be resent after an
upgrade. Pairing receipts bind the account, backend, nonce, and recipient so a
receipt cannot be rebound to another enrollment.

`mintPairingPayload` creates a random 32-byte pairing secret and encrypts the
held account-key bundle with it. The backend stores the encrypted pairing
entity. The user transfers the secret inside the pairing string outside the
backend. The receiving client uses it to decrypt the bundle locally. This is
the existing reusable encryption construction, but the enrollment code is
short-lived and single-use: a pairing string is not a durable disaster
recovery facility.

The key bundles include historical key versions. The inspected path did not
yet have a durable recovery-code or encryption-passkey facility; the selected
recovery-code design below supplies the recovery facility, while the separate
encryption-passkey option remains out of scope.

## First device and account loss are different cases

`canProvisionAccountKey` currently permits local first-key creation only
after a pull, with no observed peer identity, pending pairing redemption, or
quarantined encrypted content. `provisionAccountKey` generates the key on the
client.

An account with no surviving trusted device may still contain encrypted data.
It must not be treated as a new account and assigned replacement keys. New
account initialization, recovery, and destructive encrypted-data reset must
be separate operations. Concurrent first-device initialization also needs
an account-scoped claim so two clients do not establish competing keys.

## The secret-delivery requirement

At the historical review point, the following combination could not be
implemented using the available parties:

1. Every existing key-holding device is offline or lost.
2. The new device supplies only WorkOS authentication.
3. Neither WorkOS authentication material nor the coordination backend can
   supply or derive a decryption secret.
4. The new device immediately decrypts existing account content.

The selected recovery-code flow resolves this by adding a separately saved
client-held secret. The combination above remains impossible when the new
device has only WorkOS authentication.

Storing an encrypted recovery bundle addresses availability of ciphertext,
not availability of the secret needed to decrypt it. A fresh device keypair
also cannot decrypt a bundle encrypted before that keypair existed.

Do not work around this by returning a plaintext key, storing the recovery
secret beside the bundle, deriving keys from WorkOS tokens, or asking trusted
clients to wrap keys for arbitrary recipients solely on a backend assertion.
That last approach would also make the backend's assertion sufficient to
request decryption capability for a backend-controlled recipient.

## Selected design and alternatives

### Recovery code — selected

During setup, a trusted client generates a high-entropy recovery secret and
encrypts its account-key version bundle locally. The user saves the recovery
code separately. The backend stores only the encrypted bundle and public
version/binding metadata.

A new device authenticates, receives the account trust policy and encrypted
bundle, and asks the user for the recovery code. Decryption and local key
installation occur on that device. No existing device needs to be online.
This also supplies the all-devices-lost recovery path.

This is the selected implementation. The client generates a high-entropy
secret, seals the complete account-key version bundle locally with AES-GCM,
and retains only the secret wrapped by authenticated local storage. The
backend stores the opaque recovery envelope and public verifier metadata; it
does not receive the code or an account key. A new device signs in, obtains
the current envelope, and unlocks it locally with the saved recovery code.
The headless daemon accepts that code only through stdin or an owner-only
file. Setup and replacement print a new code once for the user to save.

Recovery replacement advances the account security revision and replaces the
backend envelope. The current recovery flow therefore requires the newly
issued code; old challenges are invalidated. A previously downloaded opaque
envelope remains ciphertext and is not a backend authorization path; if an
old code and bundle are retained, they can open only the historical key
versions present in that bundle.

### Separate encryption passkey

An independently held encryption passkey could provide the client-side
secret, with a saved recovery code as fallback. This requires an explicit
passkey enrollment/unlock flow, supported clients and authenticators, and a
way to make that credential available on the new device. A generic WorkOS
OIDC response is not that mechanism. This option needs further integration
design before implementation.

## Requirements retained in the selected design

- Existing accounts default to manual approval with membership unchanged.
- Account policy is durable and shared; existing pending devices are not
  promoted by changing the policy.
- Returning to manual mode leaves existing trusted devices trusted.
- Authenticated membership and possession of decryption keys remain distinct.
- Revoked sessions, enrollments, and identities cannot be resurrected by
  policy evaluation, refresh, or identity announcement.
- Recovery bundle updates must follow key rotation without giving revoked
  holders access to future keys. Recovery-secret replacement and previously
  downloaded ciphertext need explicit treatment in the threat model.
- A remote revocation invalidates the local recovery refresh root; the
  surviving device must replace recovery and save a new code before publishing
  another envelope.
- Account reset must fence old sessions and data generations and remove old
  recovery/policy state. It must clearly discard access to old encrypted data.
- Ephemeral execution workers remain task-key-only. Device trust does not
  enable a worker or change observe/approve/steer permissions.
- Policy/trust/recovery activity records contain metadata only.

The separate encryption-passkey option and any authentication-only decrypt
path remain out of scope. The default policy remains
`require-approval`; `auto-trust-authenticated` is an explicit account policy
for future authenticated enrollments. Policy changes do not promote existing
pending devices or resurrect revoked ones. Trust membership and possession of
decryption keys remain separate, and neither trust nor recovery setup
automatically opts a host into mesh execution. Recovery reset still requires
the separate destructive account-reset path and its exact confirmation.

## State transitions and key delivery

| Situation | Enrollment trust | How encrypted data is unlocked |
| --- | --- | --- |
| Original first durable enrollment | `trusted`, source `first-device` | Original client generates account keys after bootstrap checks. |
| New device, manual policy | `pending` | Mutual code comparison and approval, pairing, or the saved recovery code. |
| New OIDC device, automatic policy | `trusted`, source `automatic-auth` | User enters the saved recovery code locally; no online peer is needed. |
| Policy changed in either direction | Existing states unchanged | Existing keys remain available; only future enrollments use the new policy. |
| Revoked enrollment | `revoked` permanently | Old sessions fail; a genuinely new enrollment must complete its own unlock. |

Server enrollment trust is separate from the local verification of a peer's
cryptographic identity. A roster response never causes a client to send keys
to an arbitrary public key. Mesh worker participation and action permissions
remain separate from both kinds of trust.

## Migration and operational notes

Backend account policy is initialized to `require-approval`. Existing
membership is not promoted by migration. Desktop SQLite migrations add
recovery custody, bootstrap eligibility, invalidation, local rotation
completion, and pending encrypted deliveries. Recovery setup remains an
explicit user action.

Upgrade both sending and receiving clients. Unsigned legacy account-key
deliveries cannot unlock a new client; verify again and resend from an updated
client, create a fresh pairing, or use recovery. Existing locally stored
account keys remain usable.

Managed environment bootstrap now accepts enrollment codes only and rejects
old key-bearing pairing payloads at both staging and provisioning. If an
older deployment already staged a full pairing payload, treat the keys in
that payload as previously disclosed: upgrading cannot undo that disclosure.
Revoke the affected environment and rotate keys for future writes. Previously
exposed historical keys can still decrypt their historical ciphertext.

Losing all devices is recoverable using sign-in and the saved current code.
Losing both devices and that code requires **Reset encrypted data** with the
exact `RESET ENCRYPTED DATA` confirmation. Reset invalidates old sessions,
removes policy/recovery state, and fences the deleted data generation. It does
not recover old content or cancel hosted billing. See the
[reset runbook](../../runbooks/hosted-sync/account-deletion.md) for the different
OIDC and enrollment-code account recreation paths.

The daemon supports WorkOS Device Authorization through `sign-in`, alongside
enrollment-code bootstrap. It exposes recovery, policy, and mutual device
verification commands after enrollment; see the
[headless daemon runbook](../../runbooks/hosted-sync/headless-daemon.md).
WorkOS authenticates the account, while the separately saved recovery code
unlocks encrypted data without an online trusted device. An encryption
passkey remains out of scope.

## Verification

Unit and backend tests cover policy defaults and changes, signed OIDC
enrollment, bootstrap, sticky revocation, proof replay/tampering, recovery
history, invalid codes, reset, and mesh permission separation.

`sync-device-security-worker.integration.test.ts` exercises actual client
services against a local Worker with three independent client databases.
It covers recovery without the original client participating, policy changes,
revocation, key rotation, recovery-code replacement, rejection of the old
code, and decryption of both historical and new data. Request assertions
check that recovery secrets and plaintext account keys are absent.

Run the local Worker from `anvil-app/cloud/backend`:

```sh
pnpm exec wrangler dev --env dev --local --ip 127.0.0.1 --port 8799
```

Then run from `anvil-app` (the test accepts loopback origins only and uses the
public development fixture admin token):

```sh
ANVIL_SECURITY_TEST_ORIGIN=http://127.0.0.1:8799 pnpm exec vitest run \
  src/main/services/__tests__/sync-device-security-worker.integration.test.ts
```

These checks use local Worker storage and do not test a deployed WorkOS
application or perform a deployment.

Verification on 2026-09-20: desktop suite 1,378 passed / 11 skipped; backend
suite 330 passed; the gated local Worker integration passed separately.
Desktop lint, desktop build, daemon build, and backend typecheck passed.
The app's explicit Node/web TypeScript projects still report pre-existing
errors in provisioner test typing/project inclusion and automation/workflow
code; none originate in the device-security changes.

## Implementation map

- `cloud/backend/src/session-coordinator.ts` and `device-security.ts`:
  durable policy, enrollment decisions, proof verification, recovery and reset.
- `cloud/contract/device-security.ts` and `sealed.ts`: recovery and authenticated
  delivery wire formats.
- `src/main/services/sync-recovery.service.ts`,
  `sync-device-security.service.ts`, `sync-keyring.service.ts`, and
  `sync-runtime.service.ts`: local secrets, key delivery, policy orchestration,
  revocation, and bootstrap.
- `src/main/db/schema.ts`: forward-only local migrations.
- `src/shared/sync-device-security.ts`, main IPC, and preload: typed desktop API.
- `src/renderer/components/settings/DeviceSecurityPanel.tsx` and
  `SyncMeshSettingsPanel.tsx`: onboarding choice, recovery, settings, reset,
  trust labels, verification, and account activity.
- `src/daemon/security-cli.ts`: headless security commands.
- Service/backend tests, hosted-sync runbooks, and website sync docs cover the
  corresponding behavior and upgrade instructions.
