import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Loader2, LockKeyhole } from 'lucide-react';
import type { CredentialStorageController } from '../../hooks/useCredentialStorage';
import { presentSetupError } from '../../utils/setup-error';

/** Minimal local vault setup for machines without an available OS keyring. */
export function CredentialStorageSetup({
  storage,
  actionLabel,
  onReady,
  disabled = false,
}: {
  storage: CredentialStorageController;
  actionLabel: string;
  onReady: () => Promise<void> | void;
  disabled?: boolean;
}): ReactNode {
  const id = useId();
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const submitting = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  if (storage.isReady) return null;
  if (storage.loading)
    return (
      <p className="text-sm text-text-secondary" role="status">
        Checking secure credential storage…
      </p>
    );

  const status = storage.status;
  const invalid = status?.state === 'invalid' || status?.vault.state === 'invalid';
  const create = status !== null && !status.vault.configured && !invalid;
  const keyFile = status?.vault.mode === 'key-file';
  const canUnlock = status?.vault.configured === true && !invalid;
  const actionable = create || canUnlock;
  const busy = storage.busy || disabled;
  const submit = async (): Promise<void> => {
    if (busy || submitting.current) return;
    if (create && passphrase !== confirmation) {
      setError('The passphrases do not match.');
      return;
    }
    setError(null);
    submitting.current = true;
    try {
      const next = create
        ? await storage.setupVault(passphrase)
        : canUnlock
          ? await storage.unlockVault(keyFile ? undefined : passphrase)
          : await storage.refresh();
      if (!active.current) return;
      setPassphrase('');
      setConfirmation('');
      if (next?.state === 'ready') await onReady();
      else setError('Credential storage is still unavailable. Try again.');
    } catch (failure) {
      if (active.current) {
        setPassphrase('');
        setConfirmation('');
        setError(presentSetupError(failure, 'Could not unlock credential storage. Try again.'));
      }
    } finally {
      submitting.current = false;
    }
  };
  const inputClass =
    'mt-1 w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="space-y-3 border-t border-border pt-3"
      aria-labelledby={`${id}-title`}
    >
      <div>
        <h3
          id={`${id}-title`}
          className="flex items-center gap-2 text-sm font-semibold text-text-primary"
        >
          <LockKeyhole size={15} aria-hidden="true" />
          {create
            ? 'Protect your credentials'
            : canUnlock
              ? 'Unlock your credentials'
              : 'Credential storage needs attention'}
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-text-secondary">
          {create
            ? 'Anvil needs a secure place for sign-in tokens and API keys. Set a passphrase to encrypt them on this device.'
            : invalid
              ? 'Anvil could not read the saved storage configuration. Your existing credentials have been kept; restore the configuration before continuing.'
              : canUnlock
                ? keyFile
                  ? 'Restore the existing vault key file, then retry. Your saved credentials have been kept.'
                  : 'Enter your vault passphrase to continue. Your saved credentials are still on this device.'
                : 'Anvil could not check credential storage. Retry before continuing.'}
        </p>
      </div>
      {actionable && !keyFile && (
        <>
          <label htmlFor={`${id}-passphrase`} className="block text-sm text-text-secondary">
            {create ? 'New vault passphrase' : 'Vault passphrase'}
            <input
              id={`${id}-passphrase`}
              type="password"
              autoComplete={create ? 'new-password' : 'current-password'}
              value={passphrase}
              disabled={busy}
              onChange={(event) => setPassphrase(event.target.value)}
              className={inputClass}
              aria-describedby={create ? `${id}-hint` : undefined}
            />
          </label>
          {create && (
            <>
              <label htmlFor={`${id}-confirmation`} className="block text-sm text-text-secondary">
                Confirm passphrase
                <input
                  id={`${id}-confirmation`}
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  disabled={busy}
                  onChange={(event) => setConfirmation(event.target.value)}
                  className={inputClass}
                />
              </label>
              <p id={`${id}-hint`} className="text-xs leading-relaxed text-text-secondary">
                Use at least 12 characters. You’ll unlock the vault once after each restart. Keep
                the passphrase safe; Anvil cannot reset it.
              </p>
            </>
          )}
        </>
      )}
      {keyFile && status?.vault.keyFilePath && (
        <p className="break-all text-xs text-text-secondary">
          Key file: {status.vault.keyFilePath}
        </p>
      )}
      {(error || storage.error) && (
        <p role="alert" className="text-sm text-error">
          {error || storage.error}
        </p>
      )}
      <button
        type="submit"
        disabled={
          busy ||
          (actionable &&
            !keyFile &&
            (create ? passphrase.length < 12 || !confirmation : !passphrase))
        }
        className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
      >
        {storage.busy && (
          <Loader2
            size={14}
            className="animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        )}
        {storage.busy
          ? 'Unlocking credential storage…'
          : create
            ? `Create vault and ${actionLabel}`
            : canUnlock
              ? `Unlock and ${actionLabel}`
              : 'Retry storage check'}
      </button>
    </form>
  );
}
