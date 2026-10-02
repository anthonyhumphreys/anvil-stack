# Credential storage fallback proposal

Proposed on 2 October 2026. Not implemented by the node permission change.

Keep the operating-system keychain as the default. When it is unavailable,
offer an explicit encrypted vault instead of silently writing plaintext or
presenting existing credentials as unset.

Desktop users unlock the vault once per app session with a passphrase. Derive
its encryption key with a password KDF and store only the salt and encrypted
credentials, never the passphrase or derived key beside the database. Show
locked/unavailable separately from not configured, and retain the original
credential bytes when unlocking fails.

Headless users can explicitly select a protected key file outside the database
and ordinary backups, or supply the unlock secret through stdin. Reuse the
existing daemon's encrypted file-storage model where appropriate, with
owner-only permissions. Desktop installations that need unattended restart can
explicitly select the same key-file option. Passphrase mode intentionally needs
an unlock after restart. Document that a file key protects against other local
users and a copied database, not compromise of the running user's account.

Record the storage provider in the encrypted value format. Never switch providers
silently. Migrate existing plaintext or keychain values only after successful
reading and encrypting with the selected provider; replace each value atomically
and preserve the original on failure. Unavailable legacy keychain ciphertext
must remain recoverable when that keychain becomes available again.

The first implementation should cover provider/API keys and integration PATs
through the shared secret-storage service, then use the same backend for other
local credentials. Test restart/unlock, locked-state reporting, interrupted
migration, permissions, and the absence of secret values in diagnostics.
