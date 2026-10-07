# Credential storage fallback

Implemented on 2 October 2026. Provider/API keys, integration PATs, encrypted
work item connections, Cloud execution tokens and cloud-provider connection
secrets use the shared credential storage service. New sync credentials and
key custody use the same selected provider. Existing values keep their own
provider binding and remain readable without silently changing providers.

## Desktop

OS keychain storage remains the default. Onboarding and Sync settings check
credential storage before browser sign-in. When the keychain is unavailable,
the same screen offers a passphrase vault and then continues sign-in. An existing
vault can be unlocked there. Electron's Linux `basic_text` backend is treated
as unavailable; credentials never fall back to plaintext.

API-provider setup offers the same inline vault setup. A failed settings save
stops connection tests and keeps onboarding on the current step, preserving the
entered values. CLI agents use their own authentication and do not require a vault.
Settings > Privacy > Credential storage retains the full provider, key-file and
migration controls.

- Passphrase vaults unlock once per app session. Use at least 12 characters.
  Anvil derives the encryption key with scrypt and never saves the passphrase
  or derived key. Wrong-passphrase attempts preserve both credentials and an
  existing session unlock.
- Key-file vaults on macOS/Linux can restart unattended. Choose an absolute
  path outside Anvil's data directory, in a directory owned by you that other
  users cannot modify. Anvil generates a random 32-byte key with owner-only
  permissions, or uses an existing protected key. Symlinks, broad permissions,
  missing keys and replacement keys are refused. Missing keys are never
  regenerated during reads.
- Windows supports the OS keychain and passphrase vault. Key-file mode is
  unavailable until Windows ACL protection is implemented.

The panel supports unlock, lock, explicit provider selection and migration.
Saved values remain visibly configured when locked, unavailable or damaged.
Unavailable work item connection bundles cannot be overwritten by an empty
settings form. Lock prevents new vault reads and clears the cached LLM client;
it does not revoke authenticated work that was already running. A refresh
already in flight retains a short-lived encryption key copy only to persist
its rotated session tokens, then clears it. A locked/unavailable saved refresh
credential does not delete the session or contact the backend.
After unlock, Anvil resumes a saved Sync session and its refresh timer without
re-enrolling the device or replacing its account key. Damaged configuration and
missing key files require restoration; onboarding never resets an existing vault.

## Headless daemon

New daemon profiles must explicitly configure storage before saving credentials.
For unattended use on macOS/Linux:

```sh
anvil-daemon vault setup --key-file /absolute/private-directory/anvil-vault.key
anvil-daemon vault status
anvil-daemon run
```

The parent directory must already exist and be owned by you. Keep the key out
of database backups. Existing daemon profiles with `.daemon-key` retain their
legacy file provider until an explicit vault selection. Migration does not
delete the old key because unmigrated sync credentials may still need it.

For a passphrase vault, supply the secret through stdin, never as a command
argument. Use input redirection from a protected passphrase file or a secret
manager's stdout:

```sh
anvil-daemon vault setup --passphrase-stdin < /protected/passphrase-file
anvil-daemon run --vault-passphrase-stdin < /protected/passphrase-file
anvil-daemon vault migrate --vault-passphrase-stdin < /protected/passphrase-file
```

The unlock belongs to the process that runs the command. There is no standalone
unlock command whose key would disappear at process exit. Interactive echoed
stdin and oversized input are refused. Passphrase files must be protected by
the operator; no passphrase file path is retained by Anvil.

## Persistence and recovery

Values use a versioned provider prefix. Vault values use AES-256-GCM with a
random nonce and authenticated vault identity. `secret-storage.json` beside
the database contains only provider selection, vault identity, salt, encrypted
key verifier and optional key-file path. The metadata is written atomically
with owner-only permissions. Competing setups cannot replace an existing vault.

Back up the database and `secret-storage.json` together. Keep the key file
separate, and restore it at its configured path. Losing the passphrase or key
and having no recovery copy makes vault values unrecoverable. A copied database
alone does not contain the unlock key. A key file does not protect against a
compromise of the running user's account.

Readable integration credentials migrate on desktop setup/unlock/provider
selection, or through the explicit daemon migrate command. Replacement is
transactional and verified before commit. An interruption rolls back all
replacements. Unavailable legacy keychain ciphertext stays byte-for-byte intact
and can migrate after keychain access returns. Secrets are never written as a
plaintext fallback. Future/unknown envelope versions and failed authentication
are never decoded as legacy plaintext. Historical plaintext can be migrated
only when the selected encrypted storage is usable. Recovery-key custody never
accepts plaintext.

Local coverage exercises keychain/vault coexistence, actual encrypted restart
and unlock, wrong passphrases, competing setup, interrupted migration, protected
file checks, locked settings preservation and saved-session retention.

First-run regression coverage includes unavailable-storage refusal before
discovery, locking during discovery, inline vault/unlock/restore states, failed
settings saves, and saved-session restart recovery with unchanged account key
material. Separate CLI-process checks cover vault setup, key-file restart, locked
passphrase restart, stdin unlock and refusal of a wrong passphrase. Physical
Linux and multi-device acceptance remains on the
[staging checklist](../../runbooks/hosted-sync/staging-acceptance.md).

API references: [Node 22 crypto](https://nodejs.org/download/release/v22.12.0/docs/api/crypto.html),
[Electron 39 safeStorage](https://github.com/electron/electron/blob/v39.8.10/docs/api/safe-storage.md).
