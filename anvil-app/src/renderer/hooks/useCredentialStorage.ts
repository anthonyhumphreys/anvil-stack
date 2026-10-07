import { useCallback, useEffect, useRef, useState } from 'react';
import type { CredentialStorageStatus } from '../../shared/secret-storage';
import { presentSetupError } from '../utils/setup-error';

export interface CredentialStorageController {
  status: CredentialStorageStatus | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  isReady: boolean;
  refresh: () => Promise<CredentialStorageStatus | null>;
  setupVault: (passphrase: string) => Promise<CredentialStorageStatus>;
  unlockVault: (passphrase?: string) => Promise<CredentialStorageStatus>;
}

/** Readiness is checked before any first-run action that saves a credential. */
export function useCredentialStorage({ preview = false } = {}): CredentialStorageController {
  const [status, setStatus] = useState<CredentialStorageStatus | null>(null);
  const [loading, setLoading] = useState(!preview);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const sequence = useRef(0);

  const refresh = useCallback(async (): Promise<CredentialStorageStatus | null> => {
    if (preview) return null;
    const request = ++sequence.current;
    try {
      const next = await window.anvil.settings.getSecretStorageStatus();
      if (active.current && request === sequence.current) {
        setStatus(next);
        setError(null);
      }
      return next;
    } catch (failure) {
      if (active.current && request === sequence.current) {
        setStatus(null);
        setError(presentSetupError(failure, 'Could not check credential storage. Try again.'));
      }
      return null;
    } finally {
      if (active.current && request === sequence.current) setLoading(false);
    }
  }, [preview]);

  useEffect(() => {
    active.current = true;
    void refresh();
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      active.current = false;
      sequence.current += 1;
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const updateVault = useCallback(
    async (operation: () => Promise<CredentialStorageStatus>): Promise<CredentialStorageStatus> => {
      setBusy(true);
      setError(null);
      // Supersede any readiness read started before this mutation.
      sequence.current += 1;
      try {
        const next = await operation();
        sequence.current += 1;
        if (active.current) setStatus(next);
        return next;
      } catch (failure) {
        if (active.current) {
          setError(presentSetupError(failure, 'Could not unlock credential storage. Try again.'));
        }
        await refresh();
        throw failure;
      } finally {
        if (active.current) setBusy(false);
      }
    },
    [refresh],
  );

  const setupVault = useCallback(
    (passphrase: string) =>
      updateVault(() => window.anvil.settings.setupSecretVault({ mode: 'passphrase', passphrase })),
    [updateVault],
  );
  const unlockVault = useCallback(
    (passphrase?: string) =>
      updateVault(async () => {
        const next = await window.anvil.settings.unlockSecretVault(passphrase);
        return next.provider !== 'vault' && next.vault.state === 'ready' && !next.keychainAvailable
          ? window.anvil.settings.selectSecretStorageProvider('vault')
          : next;
      }),
    [updateVault],
  );

  return {
    status,
    loading,
    busy,
    error,
    isReady: preview || status?.state === 'ready',
    refresh,
    setupVault,
    unlockVault,
  };
}
