import { useEffect, useState } from 'react';
import type { CredentialStorageStatus, SecretVaultSetup } from '../../../shared/secret-storage';
import { Button } from '../ui';
import { useSettingsContext } from './SettingsContext';
import { SettingsPanel } from './settings-ui';

export function CredentialStoragePanel() {
  const { draft, onSettingsSaved } = useSettingsContext();
  const [status, setStatus] = useState<CredentialStorageStatus | null>(null);
  const [mode, setMode] = useState<SecretVaultSetup['mode']>('passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [keyFilePath, setKeyFilePath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    window.anvil.settings
      .getSecretStorageStatus()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => {
        if (active) setError('Could not read credential storage status.');
      });
    return () => {
      active = false;
    };
  }, []);

  const act = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
      onSettingsSaved?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not update credential storage.');
    } finally {
      setPassphrase('');
      setConfirmation('');
      try {
        const settings = await window.anvil.settings.get();
        draft.applyPersisted(settings);
        setStatus(settings.credentialStorage ?? null);
      } catch {
        setError('Could not refresh credential storage status.');
      }
      setBusy(false);
    }
  };

  const setup = (): void => {
    if (mode === 'passphrase' && passphrase !== confirmation) {
      setError('The passphrases do not match.');
      return;
    }
    void act(() =>
      window.anvil.settings.setupSecretVault(
        mode === 'passphrase' ? { mode, passphrase } : { mode, keyFilePath },
      ),
    );
  };
  const inputClass =
    'mt-1 w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';
  const blocked =
    status === null
      ? 0
      : Object.values(status.credentials).filter(
          (state) => !['available', 'not-configured'].includes(state),
        ).length;

  return (
    <SettingsPanel
      panelId="credential-storage"
      title="Credential storage"
      description="Choose where Anvil protects saved API keys and integration tokens on this device."
    >
      {status !== null && (
        <div className="space-y-1 text-sm text-text-secondary">
          <p>
            Selected storage: {status.provider === 'keychain' ? 'OS keychain' : 'Encrypted vault'} ·{' '}
            {status.state}
          </p>
          <p>OS keychain: {status.keychainAvailable ? 'available' : 'unavailable'}</p>
          {blocked > 0 && (
            <p>
              {blocked} saved credential {blocked === 1 ? 'value is' : 'values are'} locked or
              unavailable. The saved values are retained.
            </p>
          )}
        </div>
      )}
      {status !== null && !status.vault.configured && status.vault.state !== 'invalid' && (
        <div className="space-y-3">
          <label className="block text-sm text-text-secondary">
            Vault unlock method
            <select
              value={mode}
              disabled={busy}
              onChange={(event) => setMode(event.target.value as SecretVaultSetup['mode'])}
              className={inputClass}
            >
              <option value="passphrase">Passphrase for this app session</option>
              <option value="key-file" disabled={!status.keyFileSupported}>
                Protected key file for unattended use, macOS/Linux
              </option>
            </select>
          </label>
          {mode === 'passphrase' ? (
            <>
              <p className="text-sm text-text-secondary">
                Unlock once after each restart. Keep this passphrase safe; Anvil cannot reset it for
                you.
              </p>
              <label className="block text-sm text-text-secondary">
                New vault passphrase
                <input
                  type="password"
                  autoComplete="new-password"
                  value={passphrase}
                  disabled={busy}
                  onChange={(event) => setPassphrase(event.target.value)}
                  className={inputClass}
                />
              </label>
              <label className="block text-sm text-text-secondary">
                Confirm passphrase
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  disabled={busy}
                  onChange={(event) => setConfirmation(event.target.value)}
                  className={inputClass}
                />
              </label>
              <p className="text-xs text-text-tertiary">
                Use at least 12 characters. The passphrase is never saved.
              </p>
            </>
          ) : (
            <>
              <label className="block text-sm text-text-secondary">
                Key file path
                <input
                  value={keyFilePath}
                  disabled={busy}
                  placeholder="Absolute path outside Anvil's data directory"
                  onChange={(event) => setKeyFilePath(event.target.value)}
                  className={inputClass}
                />
              </label>
              <p className="text-sm text-text-secondary">
                Anvil creates a protected key file there, or uses an existing 32-byte key. Keep it
                separate from database backups. Anyone who can read both the key and database can
                read the credentials.
              </p>
            </>
          )}
          <Button
            onClick={setup}
            disabled={
              busy ||
              (mode === 'passphrase'
                ? passphrase.length < 12 || confirmation.length === 0
                : keyFilePath.length === 0)
            }
          >
            Create and use encrypted vault
          </Button>
        </div>
      )}
      {status?.vault.configured && (
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            Vault: {status.vault.state}
            {status.vault.mode === 'key-file'
              ? ' · key file unlocks automatically after restart'
              : ' · passphrase unlocks this session'}
          </p>
          {status.vault.keyFilePath && (
            <p className="break-all text-xs text-text-tertiary">
              Key file: {status.vault.keyFilePath}
            </p>
          )}
          {status.vault.state !== 'ready' && (
            <>
              {status.vault.mode === 'passphrase' && (
                <label className="block text-sm text-text-secondary">
                  Vault passphrase
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={passphrase}
                    disabled={busy}
                    onChange={(event) => setPassphrase(event.target.value)}
                    className={inputClass}
                  />
                </label>
              )}
              <Button
                disabled={busy || (status.vault.mode === 'passphrase' && passphrase.length === 0)}
                onClick={() =>
                  void act(() =>
                    window.anvil.settings.unlockSecretVault(
                      status.vault.mode === 'passphrase' ? passphrase : undefined,
                    ),
                  )
                }
              >
                Unlock vault
              </Button>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            {status.vault.state === 'ready' && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void act(() => window.anvil.settings.lockSecretVault())}
              >
                Lock vault
              </Button>
            )}
            {status.provider !== 'vault' && (
              <Button
                variant="secondary"
                disabled={busy || status.vault.state !== 'ready'}
                onClick={() =>
                  void act(() => window.anvil.settings.selectSecretStorageProvider('vault'))
                }
              >
                Use encrypted vault
              </Button>
            )}
            {status.provider !== 'keychain' && (
              <Button
                variant="secondary"
                disabled={busy || !status.keychainAvailable}
                onClick={() =>
                  void act(() => window.anvil.settings.selectSecretStorageProvider('keychain'))
                }
              >
                Use OS keychain
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={busy || status.state !== 'ready'}
              onClick={() =>
                void act(async () => {
                  const result = await window.anvil.settings.migrateSavedCredentials();
                  setNotice(
                    `Migrated ${result.migrated} saved values. Retained ${result.retained} unavailable values unchanged.`,
                  );
                })
              }
            >
              Migrate readable saved keys
            </Button>
          </div>
        </div>
      )}
      <p className="text-xs leading-relaxed text-text-tertiary">
        Changing storage moves readable integration credentials to the selected provider. Old
        keychain values remain recoverable if the keychain is unavailable. Locking the vault
        prevents new credential reads; it does not revoke already running authenticated work.
      </p>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-text-secondary">
          {notice}
        </p>
      )}
      {busy && (
        <p role="status" className="text-sm text-text-secondary">
          Updating credential storage…
        </p>
      )}
    </SettingsPanel>
  );
}
