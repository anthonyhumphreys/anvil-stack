import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Cloud,
  Copy,
  HardDrive,
  Loader2,
  Server,
} from 'lucide-react';
import type { SyncDeviceSecurityStatus } from '../../../shared/sync-device-security';
import type { SyncBackendConnectionMode } from '../../../shared/sync-backend';
import type { SyncIssuedEnrollmentCode } from '../../../shared/sync-runtime';
import type { SyncMeshSetupController } from '../../hooks/useSyncMeshSetup';
import { SettingsLink } from '../shared/SettingsLink';
import { copyTextToClipboard } from '../../utils/clipboard';
import { DeviceSecurityPanel } from '../settings/DeviceSecurityPanel';

const ADVANCED_MODES: SyncBackendConnectionMode[] = ['local', 'cloudflare', 'compatible'];

function serviceModeLabel(mode: SyncBackendConnectionMode): string {
  switch (mode) {
    case 'local':
      return 'Keep this device local';
    case 'cloudflare':
      return 'My Cloudflare service';
    case 'compatible':
      return 'Other compatible service';
    case 'hosted':
      return 'Anvil-hosted Sync';
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

function securityMessage(security: SyncDeviceSecurityStatus): string {
  if (security.hasAccountKey) return 'This device can unlock encrypted account data.';
  if (
    security.configured &&
    security.policy === 'auto-trust-authenticated' &&
    security.trustState === 'trusted'
  ) {
    return 'This device is waiting for a connected device to share encrypted access.';
  }
  if (security.requiresRecovery) {
    return 'This device is signed in, but needs your recovery code before it can unlock account data.';
  }
  if (security.trustState === 'pending') {
    return 'This device is waiting for approval from another trusted device.';
  }
  if (security.trustState === 'trusted') {
    return 'This device is trusted, but its account key is not available yet.';
  }
  return 'Anvil is checking this device’s access to encrypted account data.';
}

function summarizeAdoption(items: SyncMeshSetupController['adoptionPreview']): string {
  if (items.length === 0) return 'No existing items will be added to your account.';
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.entityType, (counts.get(item.entityType) ?? 0) + 1);
  return `${items.length} local item${items.length === 1 ? '' : 's'} will be encrypted and synced${counts.size > 1 ? ` across ${counts.size} types` : ''}.`;
}

function isIdentityReviewRequired(setup: SyncMeshSetupController): boolean {
  return (
    setup.status?.identityReviewRequired === true ||
    setup.runtime?.backendIdentityReviewRequired === true
  );
}

function currentServiceName(setup: SyncMeshSetupController): string {
  return setup.status?.displayName ?? 'Anvil Sync';
}

function IdentityReview({ setup }: { setup: SyncMeshSetupController }): ReactNode {
  const identityChanged = isIdentityReviewRequired(setup);
  if (!identityChanged) return null;

  return (
    <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3" role="alert">
      <p className="flex items-start gap-2 text-sm text-text-secondary">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
        <span>
          This service changed its address or sign-in identity. Review it before Anvil connects.
          {setup.status?.baseUrl ? (
            <span className="mt-1 block break-all font-mono text-xs">{setup.status.baseUrl}</span>
          ) : null}
        </span>
      </p>
      <button
        type="button"
        onClick={() => void setup.handleResolveIdentityReview()}
        disabled={setup.isBusy}
        className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
      >
        {setup.busy === 'reviewing' ? 'Confirming…' : 'I reviewed this service'}
      </button>
    </div>
  );
}

function AdvancedConnectionSettings({
  setup,
  children,
}: {
  setup: SyncMeshSetupController;
  children?: ReactNode;
}): ReactNode {
  const [disconnecting, setDisconnecting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [spikeEnrolling, setSpikeEnrolling] = useState(false);
  const [advancedError, setAdvancedError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState('account-1');
  const [issuedCode, setIssuedCode] = useState<SyncIssuedEnrollmentCode | null>(null);
  const [pairingCopied, setPairingCopied] = useState(false);
  const discovering = setup.busy === 'discovering';
  const pinning = setup.busy === 'pinning';
  const signingIn = setup.busy === 'signing-in';
  const enrolling = setup.busy === 'enrolling';
  const hosted = setup.mode === 'local' || setup.mode === 'hosted';

  const selectMode = async (mode: SyncBackendConnectionMode): Promise<void> => {
    setup.setMode(mode);
    if (mode === 'local' && setup.status !== null && setup.status.state !== 'disconnected') {
      await disconnect();
      setup.setMode('local');
    }
  };

  const disconnect = async (): Promise<void> => {
    setDisconnecting(true);
    setAdvancedError(null);
    try {
      await window.anvil.syncBackend.disconnect();
      await setup.refresh();
    } catch (error) {
      setAdvancedError(error instanceof Error ? error.message : 'Could not disconnect service.');
    } finally {
      setDisconnecting(false);
    }
  };

  const signOut = async (): Promise<void> => {
    setSigningOut(true);
    setAdvancedError(null);
    try {
      await window.anvil.syncRuntime.signOut();
      await setup.refresh();
    } catch (error) {
      setAdvancedError(error instanceof Error ? error.message : 'Could not sign out.');
    } finally {
      setSigningOut(false);
    }
  };

  const spikeEnroll = async (): Promise<void> => {
    setSpikeEnrolling(true);
    setAdvancedError(null);
    try {
      await window.anvil.syncRuntime.spikeEnroll({ accountId: accountId.trim() });
      await setup.refresh();
    } catch (error) {
      setAdvancedError(error instanceof Error ? error.message : 'Development enrollment failed.');
    } finally {
      setSpikeEnrolling(false);
    }
  };

  const issuePairingCode = async (): Promise<void> => {
    setAdvancedError(null);
    try {
      setIssuedCode(await window.anvil.syncRuntime.issueEnrollmentCode());
      setPairingCopied(false);
    } catch (error) {
      setAdvancedError(error instanceof Error ? error.message : 'Could not create a pairing code.');
    }
  };

  return (
    <details className="border-t border-border pt-3">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium text-text-secondary [&::-webkit-details-marker]:hidden">
        <span>Advanced connection settings</span>
        <ChevronDown size={14} className="text-text-tertiary" aria-hidden="true" />
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs leading-relaxed text-text-tertiary">
          Connect a service you run, review its identity, or use an enrollment code.
        </p>
        {advancedError && (
          <p className="text-xs text-error" role="alert">
            {advancedError}
          </p>
        )}

        <div className="grid gap-2 sm:grid-cols-2">
          {ADVANCED_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => void selectMode(mode)}
              disabled={setup.isBusy}
              aria-pressed={setup.mode === mode}
              className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors disabled:opacity-50 ${
                setup.mode === mode
                  ? 'border-accent/60 bg-accent/5 text-text-primary'
                  : 'border-border text-text-secondary hover:bg-bg-tertiary'
              }`}
            >
              {mode === 'local' ? (
                <HardDrive size={14} aria-hidden="true" />
              ) : mode === 'cloudflare' ? (
                <Cloud size={14} aria-hidden="true" />
              ) : (
                <Server size={14} aria-hidden="true" />
              )}
              {serviceModeLabel(mode)}
            </button>
          ))}
        </div>

        {hosted ? (
          <p className="text-xs text-text-tertiary">
            {setup.mode === 'local'
              ? 'This device stays local until you sign in above to connect to Anvil-hosted Sync.'
              : 'Anvil’s hosted service is discovered automatically when you sign in.'}
            {setup.status?.hostedBackendUrl ? (
              <span className="mt-1 block break-all font-mono">
                {setup.status.hostedBackendUrl}
              </span>
            ) : null}
          </p>
        ) : (
          <div className="space-y-2">
            <label htmlFor="sync-advanced-endpoint" className="block text-xs text-text-secondary">
              Service URL
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="sync-advanced-endpoint"
                value={setup.endpoint}
                onChange={(event) => setup.setEndpoint(event.target.value)}
                disabled={setup.isBusy}
                placeholder="https://sync.example.com/"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-md border border-border bg-bg-primary px-3 py-1.5 font-mono text-xs text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-60"
              />
              <button
                type="button"
                onClick={() => void setup.handleDiscover()}
                disabled={setup.isBusy || setup.endpoint.trim() === ''}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
              >
                {discovering ? 'Checking…' : 'Check service'}
              </button>
            </div>
            <p className="text-xs text-text-tertiary">
              Anvil checks the service identity before saving it or sending credentials.
            </p>
          </div>
        )}

        {setup.discovery !== null && (
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-sm font-medium text-text-primary">
              {setup.discovery.descriptor.displayName}
            </p>
            <dl className="grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
              <dt className="text-text-tertiary">Address</dt>
              <dd className="break-all font-mono text-text-secondary">{setup.discovery.baseUrl}</dd>
              <dt className="text-text-tertiary">Sign-in identity</dt>
              <dd className="break-all font-mono text-text-secondary">
                {setup.discovery.descriptor.auth.issuer}
              </dd>
            </dl>
            <button
              type="button"
              onClick={() => void setup.handlePin()}
              disabled={setup.isBusy}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
            >
              {pinning ? 'Saving…' : 'Use this service'}
            </button>
          </div>
        )}

        {setup.authModes.includes('enrollment-code') && !setup.signedIn && (
          <div className="space-y-2 border-t border-border pt-3">
            <label htmlFor="sync-enrollment-code" className="block text-xs text-text-secondary">
              Enrollment code
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="sync-enrollment-code"
                value={setup.enrollmentCode}
                onChange={(event) => setup.setEnrollmentCode(event.target.value)}
                placeholder="Paste a one-time code"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-md border border-border bg-bg-primary px-3 py-1.5 font-mono text-xs text-text-primary placeholder:text-text-tertiary"
              />
              <button
                type="button"
                onClick={() => void setup.handleEnrollWithCode()}
                disabled={setup.isBusy || setup.enrollmentCode.trim() === ''}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
              >
                {enrolling ? 'Connecting…' : 'Use code'}
              </button>
            </div>
          </div>
        )}

        {setup.signedIn && (
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-xs text-text-tertiary">
              Add another device with a one-time pairing code.
            </p>
            <button
              type="button"
              onClick={() => void issuePairingCode()}
              disabled={setup.isBusy}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
            >
              Create pairing code
            </button>
            {issuedCode && (
              <div className="space-y-2">
                <div className="flex items-start gap-2">
                  <p className="min-w-0 break-all font-mono text-xs text-text-primary">
                    {issuedCode.pairingPayload ?? issuedCode.code}
                  </p>
                  {issuedCode.pairingPayload && (
                    <button
                      type="button"
                      onClick={() =>
                        void copyTextToClipboard(issuedCode.pairingPayload ?? '').then(() =>
                          setPairingCopied(true),
                        )
                      }
                      aria-label="Copy pairing code"
                      className="shrink-0 rounded p-1 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
                    >
                      {pairingCopied ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  )}
                </div>
                <p className="text-xs text-text-tertiary">
                  Single use · expires {new Date(issuedCode.expiresAt).toLocaleTimeString()}
                </p>
                <p className="text-xs leading-relaxed text-text-tertiary">
                  {issuedCode.pairingPayload
                    ? 'Enter this whole string on the new device. It carries the encryption key out of band so that device can unlock your synced data.'
                    : 'Enter this code on the new device. Its account key will arrive after Sync is enabled.'}
                </p>
              </div>
            )}
          </div>
        )}

        {setup.runtime?.devSpikeAvailable === true && (
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-xs text-text-tertiary">
              Development fixture only — not available in packaged builds.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                aria-label="Development account ID"
                placeholder="account-1"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-md border border-border bg-bg-primary px-3 py-1.5 font-mono text-xs text-text-primary placeholder:text-text-tertiary"
              />
              <button
                type="button"
                onClick={() => void spikeEnroll()}
                disabled={spikeEnrolling || accountId.trim() === '' || setup.isBusy}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
              >
                {spikeEnrolling ? 'Connecting…' : 'Spike enroll'}
              </button>
            </div>
          </div>
        )}

        {setup.status?.backendId && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <p className="min-w-0 text-xs text-text-tertiary">
              <span className="font-medium text-text-secondary">{currentServiceName(setup)}</span>
              {setup.status.baseUrl ? (
                <span className="ml-2 break-all font-mono">{setup.status.baseUrl}</span>
              ) : null}
            </p>
            <div className="flex shrink-0 gap-2">
              {setup.signedIn && (
                <button
                  type="button"
                  onClick={() => void signOut()}
                  disabled={signingOut || setup.isBusy || setup.recoveryCodePending}
                  className="rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
                >
                  {signingOut ? 'Signing out…' : 'Sign out'}
                </button>
              )}
              {setup.status.state === 'active' && (
                <button
                  type="button"
                  onClick={() => void disconnect()}
                  disabled={disconnecting || setup.isBusy}
                  className="rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
                >
                  {disconnecting ? 'Pausing…' : 'Disconnect'}
                </button>
              )}
            </div>
            {signingIn && (
              <p className="w-full text-xs text-text-tertiary">Waiting for browser sign-in…</p>
            )}
          </div>
        )}
        {children}
      </div>
    </details>
  );
}

/** Compact hosted Sync setup shared by first run and the Sync settings page. */
export function SyncConnectionSetup({
  setup,
  preview = false,
  securityCompact = true,
  advancedContent,
}: {
  setup: SyncMeshSetupController;
  preview?: boolean;
  securityCompact?: boolean;
  advancedContent?: ReactNode;
}): ReactNode {
  const [securityError, setSecurityError] = useState<string | null>(null);
  const handleSecurityError = useCallback((error: unknown): void => {
    setSecurityError(
      error === null ? null : error instanceof Error ? error.message : String(error),
    );
  }, []);

  const runtime = setup.runtime;
  const security = setup.security;
  const syncEnabled = runtime?.syncEnabled === true;
  const identityReviewRequired = isIdentityReviewRequired(setup);
  const hostedOrLocal = setup.mode === 'local' || setup.mode === 'hosted';
  const canStartSignIn =
    !identityReviewRequired &&
    !setup.statusLoading &&
    !setup.isBusy &&
    (hostedOrLocal || setup.authModes.includes('oidc-pkce'));
  const keyReady = security?.hasAccountKey === true;
  const connectionCopy =
    runtime?.connectionState === 'live'
      ? 'Sync is enabled and the live connection is up.'
      : runtime?.connectionState === 'connecting'
        ? 'Sync is enabled. Anvil is connecting; local changes will queue safely.'
        : 'Sync is enabled. Live updates are unavailable, and Anvil will keep retrying.';

  const startSignIn = (): void => {
    if (hostedOrLocal) void setup.handleConnectHosted();
    else void setup.handleSignIn();
  };

  return (
    <>
      <section
        className="space-y-3 rounded-lg border border-border bg-bg-secondary p-4"
        aria-labelledby="sync-connection-title"
      >
        <div>
          <h2 id="sync-connection-title" className="text-base font-semibold text-text-primary">
            Sync &amp; Mesh
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
            Sync and Mesh are free. Sync is optional and starts local for each workspace. Choose
            which workspaces to share; repository files and local checkout paths stay on this
            device.
          </p>
        </div>

        {preview ? (
          <div className="space-y-3 border-t border-border pt-3">
            <label className="flex items-start gap-2 text-sm text-text-secondary">
              <input type="checkbox" disabled className="mt-0.5 accent-accent" />
              <span>Each workspace starts local. Choose which ones to sync.</span>
            </label>
            <fieldset disabled className="space-y-2">
              <legend className="text-sm font-medium text-text-secondary">
                Choose how your devices connect
              </legend>
              <label className="flex items-start gap-2 text-sm text-text-secondary">
                <input
                  type="radio"
                  name="sync-preview-device-policy"
                  checked
                  readOnly
                  className="mt-0.5 accent-accent"
                />
                <span>
                  Automatic connection <span className="text-text-tertiary">(recommended)</span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-text-secondary">
                <input
                  type="radio"
                  name="sync-preview-device-policy"
                  className="mt-0.5 accent-accent"
                />
                <span>Verify each new device with a code</span>
              </label>
            </fieldset>
            <label className="flex items-start gap-2 text-sm text-text-secondary">
              <input type="checkbox" disabled className="mt-0.5 accent-accent" />
              <span>
                Allow this device to run Mesh jobs <span className="text-text-tertiary">(off)</span>
              </span>
            </label>
            <button
              type="button"
              disabled
              className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground opacity-50"
            >
              Sign in to Anvil
            </button>
          </div>
        ) : setup.statusLoading && runtime === null ? (
          <div
            className="space-y-2 border-t border-border pt-3"
            role="status"
            aria-label="Checking Sync status"
          >
            <div className="h-3 w-2/3 animate-pulse rounded bg-bg-tertiary" />
            <div className="h-8 w-40 animate-pulse rounded bg-bg-tertiary" />
          </div>
        ) : (
          <>
            <IdentityReview setup={setup} />

            {setup.error && (
              <p
                className="flex items-start gap-2 rounded-md border border-error/30 bg-error/5 p-2 text-sm text-error"
                role="alert"
              >
                <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>{setup.error}</span>
              </p>
            )}

            {!setup.signedIn ? (
              <div className="space-y-2 border-t border-border pt-3">
                <p className="text-sm text-text-secondary">
                  {setup.status?.backendId && setup.mode !== 'local'
                    ? `Continue with ${currentServiceName(setup)}.`
                    : 'Connect your Anvil account to use Sync on this device.'}
                </p>
                <button
                  type="button"
                  onClick={startSignIn}
                  disabled={preview || !canStartSignIn}
                  className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {(setup.busy === 'discovering' ||
                    setup.busy === 'pinning' ||
                    setup.busy === 'signing-in') && (
                    <Loader2
                      size={14}
                      className="animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  )}
                  {setup.busy === 'discovering'
                    ? 'Checking Anvil Sync…'
                    : setup.busy === 'pinning'
                      ? 'Connecting to Anvil…'
                      : setup.busy === 'signing-in'
                        ? hostedOrLocal
                          ? 'Connecting to Anvil Sync…'
                          : 'Waiting for browser sign-in…'
                        : setup.status?.backendId && setup.mode !== 'local'
                          ? 'Sign in with browser'
                          : 'Sign in to Anvil'}
                </button>
                {setup.status?.backendId && setup.status.state === 'active' && (
                  <p className="text-xs text-text-tertiary">
                    Connected to {currentServiceName(setup)}. Sign-in does not enable Sync or Mesh
                    jobs.
                  </p>
                )}
              </div>
            ) : security === null ? null : runtime?.sessionExpired === true ? (
              <div className="space-y-2 border-t border-border pt-3" role="status">
                <p className="text-sm text-error">
                  This device’s session expired. Sign in again to resume Sync.
                </p>
                <button
                  type="button"
                  onClick={startSignIn}
                  disabled={!canStartSignIn}
                  className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground hover:bg-accent/90 disabled:opacity-50"
                >
                  {setup.busy === 'signing-in' ? 'Waiting for browser sign-in…' : 'Sign in again'}
                </button>
                {runtime?.meshWorker.enabled === true && (
                  <label className="flex items-start gap-2 text-xs text-text-secondary">
                    <input
                      type="checkbox"
                      checked
                      onChange={() => void setup.handleMeshChange()}
                      disabled={setup.isBusy}
                      className="mt-0.5 accent-accent"
                    />
                    <span>Allow this device to run Mesh jobs. Uncheck to turn it off.</span>
                  </label>
                )}
              </div>
            ) : !security.configured ? null : syncEnabled && !keyReady ? (
              <div className="space-y-2 border-t border-border pt-3" role="status">
                <p className="text-sm text-text-secondary">
                  Sync is enabled, but this device cannot unlock the account data yet.{' '}
                  {securityMessage(security)}
                </p>
                {(security.requiresRecovery || security.trustState === 'pending') && (
                  <SettingsLink to="sync#sync-mesh" className="text-xs">
                    Review device security
                  </SettingsLink>
                )}
                {runtime?.meshWorker.enabled === true && (
                  <label className="flex items-start gap-2 text-sm text-text-secondary">
                    <input
                      type="checkbox"
                      checked
                      onChange={() => void setup.handleMeshChange()}
                      disabled={setup.isBusy}
                      className="mt-0.5 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    />
                    <span>
                      <span className="block font-medium text-text-primary">
                        Allow this device to run Mesh jobs
                      </span>
                      <span className="mt-0.5 block text-xs text-text-tertiary">
                        Turn off while this device is waiting for its account key.
                      </span>
                    </span>
                  </label>
                )}
              </div>
            ) : !keyReady ? null : syncEnabled ? (
              <div className="space-y-3 border-t border-border pt-3">
                <p className="flex items-start gap-2 text-sm text-text-secondary" role="status">
                  {runtime?.connectionState === 'live' ? (
                    <Check size={15} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
                  ) : (
                    <AlertTriangle
                      size={15}
                      className="mt-0.5 shrink-0 text-warning"
                      aria-hidden="true"
                    />
                  )}
                  <span>{connectionCopy}</span>
                </p>
                {runtime?.quotaExceeded === true && (
                  <p className="text-xs text-warning">
                    Sync writes are paused while the account history quota is full. Local work
                    remains here.
                  </p>
                )}
                <label className="flex items-start gap-2 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={runtime?.meshWorker.enabled === true}
                    onChange={() => void setup.handleMeshChange()}
                    disabled={setup.isBusy || runtime === null}
                    className="mt-0.5 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                  />
                  <span>
                    <span className="block font-medium text-text-primary">
                      Allow this device to run Mesh jobs
                    </span>
                    <span className="mt-0.5 block text-xs text-text-tertiary">
                      Off by default. This only allows this computer to run jobs; Cloud Agents stays
                      off.
                    </span>
                  </span>
                </label>
                {runtime?.meshWorker.enabled === true && (
                  <p className="ml-6 text-xs text-text-tertiary" role="status">
                    {runtime.meshWorker.connected
                      ? `Ready for Mesh jobs · ${runtime.meshWorker.activeAttempts} active`
                      : runtime.meshWorker.lastError
                        ? 'Mesh is allowed, but this device cannot connect yet. Anvil will retry.'
                        : 'Connecting this device to Mesh…'}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2 border-t border-border pt-3">
                {setup.adoptionPreviewAvailable ? (
                  <>
                    <p className="text-sm text-text-secondary">
                      {summarizeAdoption(setup.adoptionPreview)}
                    </p>
                    {setup.adoptionPreview.length > 0 && (
                      <details className="text-xs text-text-tertiary">
                        <summary className="cursor-pointer underline underline-offset-2">
                          Review local items
                        </summary>
                        <ul className="mt-1 list-inside list-disc space-y-0.5">
                          {setup.adoptionPreview.map((item) => (
                            <li key={`${item.entityType}:${item.entityId}`}>{item.name}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                    <p className="text-xs text-text-tertiary">
                      Repository files and local checkout paths stay on this device. Mesh jobs
                      remain off.
                    </p>
                  </>
                ) : (
                  <div className="space-y-2" role="alert">
                    <p className="text-sm text-warning">
                      Could not load the Sync preview. Retry before connecting this device.
                    </p>
                    <button
                      type="button"
                      onClick={() => void setup.refresh()}
                      disabled={setup.isBusy}
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
                    >
                      {setup.busy === 'loading' ? 'Retrying…' : 'Retry preview'}
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void setup.handleEnableSync()}
                  disabled={
                    setup.isBusy ||
                    !setup.canEnableSync ||
                    !security.configured ||
                    !keyReady ||
                    setup.recoveryCodePending
                  }
                  className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {setup.busy === 'enabling' && (
                    <Loader2
                      size={14}
                      className="animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  )}
                  {setup.busy === 'enabling' ? 'Connecting this device…' : 'Connect this device'}
                </button>
              </div>
            )}
          </>
        )}
      </section>
      {setup.signedIn && (
        <>
          {securityError && (
            <p
              className="rounded-md border border-error/30 bg-error/5 p-2 text-sm text-error"
              role="alert"
            >
              {securityError}
            </p>
          )}
          {securityCompact ? (
            <DeviceSecurityPanel
              onRefresh={setup.refresh}
              onError={handleSecurityError}
              onRecoveryCodePending={setup.setRecoveryCodePending}
              securityStatus={security}
              compact
            />
          ) : (
            <details
              className="space-y-3"
              open={
                security?.configured !== true ||
                security.hasAccountKey !== true ||
                security.trustState === 'pending' ||
                setup.recoveryCodePending
              }
            >
              <summary className="cursor-pointer text-sm font-medium text-text-secondary">
                Device security, recovery, and new-device access
              </summary>
              <DeviceSecurityPanel
                onRefresh={setup.refresh}
                onError={handleSecurityError}
                onRecoveryCodePending={setup.setRecoveryCodePending}
                securityStatus={security}
              />
            </details>
          )}
          <AdvancedConnectionSettings setup={setup}>{advancedContent}</AdvancedConnectionSettings>
        </>
      )}
      {!preview && !setup.signedIn && (
        <AdvancedConnectionSettings setup={setup}>{advancedContent}</AdvancedConnectionSettings>
      )}
    </>
  );
}
