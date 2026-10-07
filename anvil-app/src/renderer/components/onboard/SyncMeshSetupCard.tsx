import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useSyncMeshSetup } from '../../hooks/useSyncMeshSetup';
import { SyncConnectionSetup } from './SyncConnectionSetup';

interface SyncMeshSetupCardProps {
  preview?: boolean;
  onUseOnDevice?: () => void;
  onContinue?: () => void;
  onRecoveryCodePendingChange?: (pending: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}

/** Optional first-run Sync setup with a clear local-only path. */
export function SyncMeshSetupCard({
  preview = false,
  onUseOnDevice,
  onContinue,
  onRecoveryCodePendingChange,
  onBusyChange,
}: SyncMeshSetupCardProps): ReactNode {
  const setup = useSyncMeshSetup({ initialMode: 'hosted', preview });
  const recoveryCodePending = setup.recoveryCodePending;
  const syncReady =
    setup.credentialStorage.isReady &&
    setup.runtime?.syncEnabled === true &&
    setup.security?.hasAccountKey === true &&
    setup.security.configured &&
    !recoveryCodePending;

  useEffect(() => {
    onRecoveryCodePendingChange?.(recoveryCodePending);
  }, [onRecoveryCodePendingChange, recoveryCodePending]);

  useEffect(() => {
    onBusyChange?.(setup.isBusy);
  }, [onBusyChange, setup.isBusy]);

  return (
    <div className="space-y-3">
      <SyncConnectionSetup setup={setup} preview={preview} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onUseOnDevice && setup.runtime?.syncEnabled !== true && (
          <button
            type="button"
            onClick={onUseOnDevice}
            disabled={recoveryCodePending || setup.isBusy}
            className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            Continue without Sync
          </button>
        )}
        {syncReady && onContinue && (
          <button
            type="button"
            onClick={onContinue}
            className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary"
          >
            Continue
          </button>
        )}
      </div>
    </div>
  );
}
