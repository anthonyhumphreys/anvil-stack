# Device connection and encryption access

Current implementation on `feature/sync-mesh--foundations`, 6 October 2026.
Both the backend and clients must contain this change. Local checks do not
establish hosted or physical-device acceptance.

## User flow

First-run onboarding offers Sync after primary-agent setup. **Use on this
device** completes onboarding locally. **Sign in to Anvil** discovers the
build's configured hosted service, validates and pins its identity, then opens
browser sign-in. Pinning and authentication do not enable uploads or job
execution. A changed service address or issuer requires visible review.
Custom services and enrollment codes remain in advanced settings.

The first device chooses how future devices connect:

- **Automatic connection (recommended):** an eligible device signed into the
  same account receives encrypted access from an online trusted device.
- **Verify each device with a code:** compare the device-verification code on
  both devices and approve the matching code on both ends.

Initial security setup creates a recovery code, shown once and saved
separately. Navigation and the Connect action remain blocked while that code
is awaiting acknowledgement. **Connect this device** separately authorizes
Sync adoption; the preview identifies local items about to be encrypted and
uploaded. Workspace creation still defaults to Local. Workspace Sync carries
portable definitions and repository references, not repository contents,
Git history, dirty changes, or local checkout paths.

**Allow this device to run Mesh jobs** remains a separate local opt-in. Account
sign-in, automatic device connection, and workspace Sync never enable it.

## Automatic delivery

A durable OIDC/WorkOS enrollment proves possession of its X25519 identity
through a short-lived, one-use challenge authenticated by its device session.
The backend binds that public key immutably to the enrollment. Rebinding,
duplicate keys, revoked or expired enrollments, ephemeral execution hosts, and
bare enrollment-code sessions cannot use this path.

Clients check the current account policy, enrollment class, authentication
proof, trust source, revocation state, and exact bound public key against the
synced identity before granting automatic local trust. Automatic admission
must also authenticate the issuing device before accepting its wrap. The
key-holding client encrypts the account-key version bundle to the recipient;
only that recipient unwraps it. The service stores public binding metadata
and recipient ciphertext, never the account key or recovery code.

Signing in is not a decryption secret. If every trusted device is offline,
the new device shows that it is waiting for a connected device. Pending setup
retries are bounded. Before the user enables Sync, they may publish only the
current device identity and pull encrypted account state; application data,
scans, and snapshots are not uploaded. The saved
recovery code provides the offline route: it decrypts the opaque recovery
bundle locally without a peer participating.

Policy changes apply to future enrollments. Existing pending devices still
need code verification or recovery. Returning to code verification does not
revoke devices already connected. Revoked identities remain revoked; a new
enrollment is required.

## Security trade-off

Automatic connection explicitly relies on the identity provider and the
pinned authenticated service to attest account membership and the enrollment's
bound key. Account or identity-provider compromise can admit an attacker's
device while a trusted device is online. A malicious coordination service
could fabricate that attestation. The possession challenge prevents key
substitution and replay within the honest service's protocol; it does not
make a malicious service an independent source of cryptographic identity.
Code verification preserves the independent out-of-band comparison for
users who do not want that automatic admission boundary.

Transport encryption, local secret storage, account-scoped fencing,
recipient-authenticated wraps, sticky revocation, recovery proof checks,
and separate worker permission remain required in both modes. Revocation
cannot erase plaintext or key versions a device has already received.

## Headless workflow

The daemon labels the browser's WorkOS code as a **sign-in code**, distinct
from the **device-verification code** and **recovery code**. Readable security
status and numbered/named devices guide the next action. See the
[headless daemon runbook](../../runbooks/hosted-sync/headless-daemon.md).
A headless device waiting for another device needs its runtime running;
one-shot sign-in cannot keep retrying after the command exits.

## Verification and acceptance

Focused tests cover hosted setup ordering, changed-identity blocking,
concurrent setup, onboarding transitions, challenge possession/tampering,
binding replay/rebind, automatic admission gates, and separate key readiness.
The full app/backend checks and local Worker security integration establish
local evidence. Hosted WorkOS sign-in, physical two-device automatic delivery,
manual verification, offline recovery, and revocation remain distinct staging
acceptance gates. Record the tested candidate and failures explicitly in
[staging acceptance](../../runbooks/hosted-sync/staging-acceptance.md).

The older [E2EE review](e2ee-trust-model-delta.md) is historical evidence for
its reviewed revision. Its recovery-only automatic policy description is
superseded by this document and the [decision record](decisions.md).
