import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Copy, KeyRound, Loader2, LockKeyhole, ShieldCheck, Trash2 } from 'lucide-react';
import type {
  SyncDeviceRecoveryResult,
  SyncDeviceSecurityStatus,
  SyncDeviceTrustPolicy,
  SyncEncryptedSyncAccountResetConfirmation,
} from '../../../shared/sync-device-security';
import { copyTextToClipboard } from '../../utils/clipboard';
import {
  deviceTrustSourceLabel,
  deviceTrustStateLabel,
  securityEventLabel,
} from './device-security-labels';

const RESET_CONFIRMATION: SyncEncryptedSyncAccountResetConfirmation = 'RESET ENCRYPTED DATA';

const AUTO_TRUST_CONFIRMATION =
  'Encryption remains enabled; Anvil cannot read your data. New signed-in devices can unlock using your recovery code without another device approving them. An account compromise alone does not decrypt your data; if both the account and recovery code are exposed, a new device can unlock it. Protect them separately.';

interface DeviceSecurityPanelProps {
  onRefresh: () => Promise<void>;
  onError: (error: unknown) => void;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function policyLabel(policy: SyncDeviceTrustPolicy): string {
  return policy === 'auto-trust-authenticated'
    ? 'Trust authenticated devices automatically'
    : 'Require approval from an existing trusted device';
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** Device trust, recovery-code setup/unlock, and the explicit encrypted-data reset surface. */
export function DeviceSecurityPanel({ onRefresh, onError }: DeviceSecurityPanelProps): ReactNode {
  const [security, setSecurity] = useState<SyncDeviceSecurityStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetComplete, setResetComplete] = useState(false);
  const [manualSetupSkipped, setManualSetupSkipped] = useState(false);
  const [policyChoice, setPolicyChoice] = useState<SyncDeviceTrustPolicy>('require-approval');
  const [autoTrustAcknowledged, setAutoTrustAcknowledged] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [recoverySaved, setRecoverySaved] = useState(false);
  const [recoveryCopied, setRecoveryCopied] = useState(false);
  const [unlockCode, setUnlockCode] = useState('');
  const [resetConfirmation, setResetConfirmation] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const next = await window.anvil.syncRuntime.getDeviceSecurityStatus();
      setSecurity(next);
      setPolicyChoice(next.policy);
      setLoadError(null);
      onError(null);
    } catch (error) {
      setLoadError(toErrorMessage(error));
      onError(error);
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAction = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    onError(null);
    try {
      await action();
      await refresh();
      await onRefresh();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const showRecoveryCode = (result: SyncDeviceRecoveryResult): void => {
    setRecoveryCode(result.recoveryCode);
    setRecoverySaved(false);
    setRecoveryCopied(false);
  };

  const handleSetupRecovery = async (): Promise<void> => {
    if (policyChoice === 'auto-trust-authenticated' && !autoTrustAcknowledged) return;
    setBusy(true);
    onError(null);
    try {
      const result = await window.anvil.syncRuntime.setupDeviceRecovery(policyChoice);
      showRecoveryCode(result);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleConfigureManualPolicy = async (): Promise<void> => {
    await runAction(async () => {
      await window.anvil.syncRuntime.setNewDeviceTrustPolicy('require-approval');
    });
  };

  const handleSkipInitialRecovery = (): void => {
    // No recovery proof exists yet, so this optional local skip has no backend
    // policy mutation to make here.
    setManualSetupSkipped(true);
    setPolicyChoice('require-approval');
    onError(null);
  };

  const handleConfigureAutoPolicy = async (): Promise<void> => {
    if (!autoTrustAcknowledged) return;
    await runAction(async () => {
      await window.anvil.syncRuntime.setNewDeviceTrustPolicy('auto-trust-authenticated');
    });
  };

  const handleUnlock = async (): Promise<void> => {
    if (unlockCode.trim() === '') return;
    await runAction(async () => {
      await window.anvil.syncRuntime.unlockDeviceRecovery(unlockCode.trim());
      setUnlockCode('');
    });
  };

  const handleReplaceRecovery = async (): Promise<void> => {
    setBusy(true);
    onError(null);
    try {
      const result = await window.anvil.syncRuntime.replaceDeviceRecovery();
      showRecoveryCode(result);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async (): Promise<void> => {
    if (resetConfirmation !== RESET_CONFIRMATION) return;
    setBusy(true);
    onError(null);
    try {
      await window.anvil.syncRuntime.resetEncryptedSyncAccount(RESET_CONFIRMATION);
      setResetConfirmation('');
      setSecurity(null);
      setLoadError(null);
      setResetComplete(true);
      await onRefresh();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  if (resetComplete) {
    return (
      <Panel title="Device security" description="Encryption access and new-device policy.">
        <p className="text-sm text-text-secondary">
          Encrypted account data and its recovery state were reset. Sign in again to configure a new
          encrypted account.
        </p>
      </Panel>
    );
  }

  if (loading && security === null) {
    return (
      <Panel title="Device security" description="Loading encryption access and new-device policy.">
        <p className="flex items-center gap-2 text-sm text-text-tertiary">
          <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> Loading
        </p>
      </Panel>
    );
  }

  if (security === null) {
    return (
      <Panel title="Device security" description="Encryption access and new-device policy.">
        <p className="text-sm text-error">
          {loadError ?? 'Device security status is unavailable.'}
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
        >
          {loading ? 'Retrying…' : 'Retry'}
        </button>
      </Panel>
    );
  }

  // Older backends used `configured` for recovery-envelope setup; keep the
  // first setup card limited to an untouched bootstrap response.
  const isUnconfigured =
    !manualSetupSkipped && !security.configured && security.canConfigure && security.revision <= 1;
  const trusted = security.trustState === 'trusted';
  const recoveryNeedsReplacement =
    security.requiresRecoveryReplacement === true || security.recoveryInvalidated === true;
  const canUseRecovery =
    security.configured &&
    !recoveryNeedsReplacement &&
    (security.trustState === 'pending' || security.trustState === 'trusted');
  const needsUnlock =
    canUseRecovery && trusted && security.requiresRecovery && !security.hasAccountKey;
  const needsRecoverySecret =
    canUseRecovery &&
    trusted &&
    security.hasAccountKey &&
    !isUnconfigured &&
    !manualSetupSkipped &&
    !security.hasRecoverySecret;
  const needsPendingRecovery = canUseRecovery && security.trustState === 'pending';

  return (
    <Panel
      title="Device security"
      description="Encryption stays enabled on every device. Authentication proves account membership; a trusted device or recovery code unlocks encrypted data."
    >
      <div className="space-y-4">
        {security.accountId !== null && (
          <p className="text-xs text-text-tertiary">
            Account <span className="font-mono text-text-secondary">{security.accountId}</span>
          </p>
        )}

        {isUnconfigured ? (
          <div className="space-y-3 rounded-md border border-warning/30 bg-warning/5 p-3">
            <div>
              <p className="text-sm font-medium text-text-primary">Choose new-device access</p>
              <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                This choice applies to future enrollments after this account is configured. It does
                not promote devices that are already waiting for approval.
              </p>
            </div>
            <PolicyChoice value={policyChoice} onChange={setPolicyChoice} />
            {policyChoice === 'auto-trust-authenticated' && (
              <label className="flex items-start gap-2 text-xs leading-relaxed text-text-secondary">
                <input
                  type="checkbox"
                  checked={autoTrustAcknowledged}
                  onChange={(event) => setAutoTrustAcknowledged(event.target.checked)}
                  className="mt-0.5 accent-accent"
                />
                <span>{AUTO_TRUST_CONFIRMATION}</span>
              </label>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleSetupRecovery()}
                disabled={
                  busy || (policyChoice === 'auto-trust-authenticated' && !autoTrustAcknowledged)
                }
                className="flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                <KeyRound size={14} />
                {busy ? 'Setting up…' : 'Set up recovery code'}
              </button>
              {policyChoice === 'require-approval' && (
                <button
                  type="button"
                  onClick={handleSkipInitialRecovery}
                  disabled={busy}
                  className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
                >
                  Continue without recovery code
                </button>
              )}
            </div>
            <p className="text-xs text-text-tertiary">
              A recovery code is recommended. You can add one later if you continue with manual
              approval.
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-bg-tertiary px-2 py-1 text-xs font-medium text-text-primary">
                {deviceTrustStateLabel(security.trustState)}
              </span>
              <span className="rounded bg-bg-tertiary px-2 py-1 text-xs text-text-secondary">
                {deviceTrustSourceLabel(security.trustSource)}
              </span>
              <span className="text-xs text-text-tertiary">
                Policy: {policyLabel(security.policy)}
              </span>
            </div>

            {security.trustState === 'pending' && (
              <div className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-text-secondary">
                This signed-in device is waiting for trust approval. Authentication alone does not
                unlock encrypted data; compare the verification code with an existing trusted device
                and confirm the matching code from the Devices list.
              </div>
            )}

            {security.trustState === 'revoked' && (
              <div className="rounded-md border border-error/30 bg-error/5 p-3 text-sm text-text-secondary">
                This device enrollment has been revoked. Re-enroll it before requesting trust;
                revoked enrollments cannot be approved again from this screen.
              </div>
            )}

            {(needsUnlock || needsRecoverySecret || needsPendingRecovery) && (
              <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3">
                <p className="flex items-start gap-2 text-sm text-text-secondary">
                  <LockKeyhole size={15} className="mt-0.5 shrink-0 text-warning" />
                  {needsPendingRecovery
                    ? 'If no trusted device is available, enter the recovery code saved during setup to unlock this device and complete trust without another device approving it.'
                    : needsUnlock
                      ? 'This device is trusted, but its encrypted data is locked. Enter the recovery code saved during setup to unlock it.'
                      : 'This device has a local account key but no retained recovery secret. Enter the recovery code you saved to restore recovery access before changing security settings.'}
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="password"
                    value={unlockCode}
                    onChange={(event) => setUnlockCode(event.target.value)}
                    placeholder="Saved recovery code"
                    autoComplete="off"
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded-md border border-border bg-bg-primary px-3 py-1.5 font-mono text-sm text-text-primary placeholder:text-text-tertiary"
                  />
                  <button
                    type="button"
                    onClick={() => void handleUnlock()}
                    disabled={busy || unlockCode.trim() === ''}
                    className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {busy
                      ? 'Unlocking…'
                      : needsPendingRecovery
                        ? 'Use recovery code'
                        : needsUnlock
                          ? 'Unlock encrypted data'
                          : 'Restore recovery access'}
                  </button>
                </div>
                <p className="text-xs text-text-tertiary">
                  Signing in alone does not decrypt your data. The recovery code is used locally and
                  never sent to the sync backend.
                </p>
              </div>
            )}

            {recoveryNeedsReplacement && (
              <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3">
                <p className="flex items-start gap-2 text-sm text-text-secondary">
                  <LockKeyhole size={15} className="mt-0.5 shrink-0 text-warning" />
                  Your recovery bundle is stale after a device revocation or key rotation. Replace
                  the recovery code before relying on it for a new device.
                </p>
                <button
                  type="button"
                  onClick={() => void handleReplaceRecovery()}
                  disabled={busy || !security.hasAccountKey}
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
                >
                  <KeyRound size={14} /> Replace recovery code
                </button>
                {!security.hasAccountKey && (
                  <p className="text-xs text-text-tertiary">
                    Unlock this device first; Anvil cannot create a replacement without its local
                    account key.
                  </p>
                )}
              </div>
            )}

            <div className="space-y-3 rounded-md border border-border p-3">
              <p className="text-sm font-medium text-text-primary">Future new devices</p>
              <PolicyChoice value={policyChoice} onChange={setPolicyChoice} />
              {policyChoice === 'auto-trust-authenticated' && (
                <label className="flex items-start gap-2 text-xs leading-relaxed text-text-secondary">
                  <input
                    type="checkbox"
                    checked={autoTrustAcknowledged}
                    onChange={(event) => setAutoTrustAcknowledged(event.target.checked)}
                    className="mt-0.5 accent-accent"
                  />
                  <span>{AUTO_TRUST_CONFIRMATION}</span>
                </label>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    void (policyChoice === 'auto-trust-authenticated'
                      ? handleConfigureAutoPolicy()
                      : handleConfigureManualPolicy())
                  }
                  disabled={
                    busy ||
                    policyChoice === security.policy ||
                    (policyChoice === 'auto-trust-authenticated' && !autoTrustAcknowledged)
                  }
                  className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
                >
                  Save policy
                </button>
                {security.hasRecoverySecret || recoveryNeedsReplacement ? (
                  <button
                    type="button"
                    onClick={() => void handleReplaceRecovery()}
                    disabled={busy}
                    className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
                  >
                    <KeyRound size={14} /> Replace recovery code
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleSetupRecovery()}
                    disabled={busy}
                    className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
                  >
                    <KeyRound size={14} /> Set up recovery code
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {recoveryCode !== null && (
          <div className="space-y-3 rounded-md border border-accent/50 bg-accent/5 p-3">
            <div>
              <p className="flex items-center gap-2 text-sm font-medium text-text-primary">
                <ShieldCheck size={15} className="text-accent" /> Save your recovery code
              </p>
              <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                This code is shown once. Store it somewhere separate from your account password;
                anyone with both can unlock encrypted account data on a new device.
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-md border border-border bg-bg-primary p-2">
              <code className="min-w-0 flex-1 break-all font-mono text-sm text-text-primary">
                {recoveryCode}
              </code>
              <button
                type="button"
                title="Copy recovery code"
                aria-label="Copy recovery code"
                onClick={() =>
                  void copyTextToClipboard(recoveryCode).then(() => {
                    setRecoveryCopied(true);
                    window.setTimeout(() => setRecoveryCopied(false), 2000);
                  })
                }
                className="shrink-0 rounded p-1.5 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
              >
                {recoveryCopied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <label className="flex items-start gap-2 text-xs text-text-secondary">
              <input
                type="checkbox"
                checked={recoverySaved}
                onChange={(event) => setRecoverySaved(event.target.checked)}
                className="mt-0.5 accent-accent"
              />
              <span>I saved this recovery code and understand it will not be shown again.</span>
            </label>
            <button
              type="button"
              onClick={() => {
                setRecoveryCode(null);
                setRecoverySaved(false);
                setRecoveryCopied(false);
                void refresh();
              }}
              disabled={!recoverySaved}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              <Check size={14} className="mr-1.5 inline" />
              Done
            </button>
          </div>
        )}

        {security.recentEvents.length > 0 && (
          <details className="rounded-md border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium text-text-secondary">
              Recent security activity
            </summary>
            <ul className="mt-2 space-y-1 text-xs text-text-tertiary">
              {security.recentEvents.map((event) => (
                <li key={`${event.occurredAt}:${event.kind}`}>
                  {securityEventLabel(event.kind, event.outcome)} · {dateLabel(event.occurredAt)}
                </li>
              ))}
            </ul>
          </details>
        )}

        <details className="rounded-md border border-error/30 bg-error/5 p-3">
          <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-error">
            <Trash2 size={14} /> Reset encrypted account data
          </summary>
          <div className="mt-3 space-y-2">
            <p className="text-xs leading-relaxed text-text-secondary">
              This permanently discards encrypted account data and its recovery state. It does not
              happen automatically. Confirm the account identity below, then type the exact phrase
              to continue.
            </p>
            {security.accountId !== null && (
              <p className="text-xs text-text-secondary">
                Account: <span className="font-mono text-text-primary">{security.accountId}</span>
              </p>
            )}
            <input
              value={resetConfirmation}
              onChange={(event) => setResetConfirmation(event.target.value)}
              placeholder={RESET_CONFIRMATION}
              spellCheck={false}
              className="w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 font-mono text-sm text-text-primary placeholder:text-text-tertiary"
            />
            <button
              type="button"
              onClick={() => void handleReset()}
              disabled={busy || resetConfirmation !== RESET_CONFIRMATION}
              className="rounded-md border border-error/50 bg-error/10 px-3 py-1.5 text-sm font-medium text-error hover:bg-error/20 disabled:opacity-50"
            >
              Reset encrypted data
            </button>
          </div>
        </details>
      </div>
    </Panel>
  );
}

function PolicyChoice({
  value,
  onChange,
}: {
  value: SyncDeviceTrustPolicy;
  onChange: (value: SyncDeviceTrustPolicy) => void;
}): ReactNode {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {(['require-approval', 'auto-trust-authenticated'] as const).map((policy) => (
        <button
          key={policy}
          type="button"
          aria-pressed={value === policy}
          onClick={() => onChange(policy)}
          className={`rounded-md border p-2 text-left text-xs transition-colors ${
            value === policy
              ? 'border-accent/60 bg-accent/5 text-text-primary'
              : 'border-border text-text-secondary hover:bg-bg-tertiary'
          }`}
        >
          <span className="font-medium">{policyLabel(policy)}</span>
          <span className="mt-1 block leading-relaxed text-text-tertiary">
            {policy === 'auto-trust-authenticated'
              ? 'A signed-in device can use the recovery flow without another device approving it.'
              : 'An existing trusted device must compare a code and approve it.'}
          </span>
        </button>
      ))}
    </div>
  );
}

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="space-y-4 rounded-lg border border-border bg-bg-secondary p-5">
      <div>
        <h4 className="text-base font-semibold text-text-primary">{title}</h4>
        {description && <p className="mt-1 text-sm text-text-secondary">{description}</p>}
      </div>
      {children}
    </section>
  );
}
