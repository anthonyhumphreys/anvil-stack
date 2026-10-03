import { useCallback, useEffect, useState } from 'react';
import { Smartphone, Trash2 } from 'lucide-react';
import type {
  CompanionEnrollmentPolicy,
  CompanionPolicyState,
  MobileCompanionDevice,
  MobileCompanionStatus,
  MobilePairingTicket,
  RaycastCompanionToken,
} from '../../../../shared/types';
import { Button } from '../../ui';
import { useSettingsContext } from '../SettingsContext';
import { Field, SettingsPanel } from '../settings-ui';

function formatCompanionClientType(type: MobileCompanionDevice['clientType']): string {
  switch (type) {
    case 'raycast':
      return 'Raycast';
    case 'watch':
      return 'Watch';
    case 'widget':
      return 'Widget';
    case 'menubar':
      return 'Menu bar';
    case 'mobile':
    default:
      return 'Mobile';
  }
}

export function DevicesCategory() {
  const { draft, reportError } = useSettingsContext();
  const { settings } = draft;

  const [mobileStatus, setMobileStatus] = useState<MobileCompanionStatus | null>(null);
  const [mobileDevices, setMobileDevices] = useState<MobileCompanionDevice[]>([]);
  const [enrollmentPolicies, setEnrollmentPolicies] = useState<CompanionEnrollmentPolicy[]>([]);
  const [pairingTicket, setPairingTicket] = useState<MobilePairingTicket | null>(null);
  const [raycastToken, setRaycastToken] = useState<RaycastCompanionToken | null>(null);
  const [mobileBusy, setMobileBusy] = useState(false);

  const refreshMobileCompanion = useCallback(async () => {
    const [status, devices, policies] = await Promise.all([
      window.anvil.mobileCompanion.getStatus(),
      window.anvil.mobileCompanion.listDevices(),
      window.anvil.mobileCompanion.listEnrollmentPolicies(),
    ]);
    setMobileStatus(status);
    setMobileDevices(devices);
    setEnrollmentPolicies(policies);
  }, []);

  useEffect(() => {
    refreshMobileCompanion().catch(console.error);
    return window.anvil.mobileCompanion.onEvent(() => {
      refreshMobileCompanion().catch(console.error);
    });
  }, [refreshMobileCompanion]);

  const toggleMobileCompanion = async () => {
    setMobileBusy(true);
    reportError(null);
    try {
      const status = await window.anvil.mobileCompanion.setEnabled(!mobileStatus?.enabled);
      setMobileStatus(status);
      if (!status.enabled) setPairingTicket(null);
      await refreshMobileCompanion();
    } catch (err) {
      reportError(err instanceof Error ? err.message : 'Failed to update mobile companion');
    } finally {
      setMobileBusy(false);
    }
  };

  const createPairingTicket = async () => {
    setMobileBusy(true);
    reportError(null);
    try {
      const ticket = await window.anvil.mobileCompanion.createPairingTicket();
      setPairingTicket(ticket);
      await refreshMobileCompanion();
    } catch (err) {
      reportError(err instanceof Error ? err.message : 'Failed to create pairing QR code');
    } finally {
      setMobileBusy(false);
    }
  };

  const createRaycastToken = async () => {
    setMobileBusy(true);
    reportError(null);
    try {
      const token = await window.anvil.mobileCompanion.createRaycastToken();
      setRaycastToken(token);
      await refreshMobileCompanion();
    } catch (err) {
      reportError(err instanceof Error ? err.message : 'Failed to create Raycast token');
    } finally {
      setMobileBusy(false);
    }
  };

  const revokeMobileDevice = async (deviceId: string) => {
    setMobileBusy(true);
    try {
      await window.anvil.mobileCompanion.revokeDevice(deviceId);
      await refreshMobileCompanion();
    } finally {
      setMobileBusy(false);
    }
  };

  const updateEnrollmentPolicy = async (enrollmentId: string, tier: CompanionPolicyState) => {
    setMobileBusy(true);
    reportError(null);
    try {
      await window.anvil.mobileCompanion.setEnrollmentPolicy(enrollmentId, tier);
      await refreshMobileCompanion();
    } catch (err) {
      reportError(err instanceof Error ? err.message : 'Failed to update device access');
    } finally {
      setMobileBusy(false);
    }
  };

  const removeEnrollmentPolicy = async (enrollmentId: string) => {
    setMobileBusy(true);
    reportError(null);
    try {
      await window.anvil.mobileCompanion.removeEnrollmentPolicy(enrollmentId);
      await refreshMobileCompanion();
    } catch (err) {
      reportError(err instanceof Error ? err.message : 'Failed to remove device access');
    } finally {
      setMobileBusy(false);
    }
  };

  return (
    <>
      <SettingsPanel
        panelId="general"
        title="General"
        description="Defaults used when the app needs a local repository location."
        saveKeys={['defaultRepoPath']}
        autosave
      >
        <Field
          label="Default Repo Path"
          value={settings.defaultRepoPath ?? ''}
          onChange={(v) => draft.update('defaultRepoPath', v)}
          placeholder="/Users/you/repos"
          saveKey="defaultRepoPath"
        />
      </SettingsPanel>

      <SettingsPanel
        panelId="mobile"
        title="Mobile Companion"
        description="Control this Anvil instance from phone, widgets, Raycast, watch, and the macOS menu bar over your local network or Tailscale."
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <Smartphone size={16} className="text-accent" />
              Control this Anvil instance from companion surfaces
            </div>
            <p className="text-sm text-text-secondary">
              Pair over your local network or Tailscale. Companion surfaces can resolve approvals,
              launch status sweeps, review changes, hunt missing tests, draft handoffs, publish live
              widget status, and interrupt active sessions without exposing a tiny remote shell.
            </p>
            {mobileStatus?.baseUrl && (
              <p className="truncate font-mono text-xs text-text-tertiary">
                {mobileStatus.baseUrl}
              </p>
            )}
          </div>
          <button
            onClick={toggleMobileCompanion}
            disabled={mobileBusy}
            className={`shrink-0 rounded-md border px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${
              mobileStatus?.enabled
                ? 'border-success/50 text-success hover:bg-success/10'
                : 'border-border text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
            }`}
          >
            {mobileStatus?.enabled ? 'Enabled' : 'Enable'}
          </button>
        </div>

        {mobileStatus?.enabled && (
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-bg-primary p-3">
              <p className="text-eyebrow uppercase text-text-tertiary">Command deck workflows</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {[
                  'Status sweep',
                  'Review current change',
                  'Find missing tests',
                  'Ship handoff',
                ].map((item) => (
                  <div
                    key={item}
                    className="rounded-md border border-border-subtle bg-bg-secondary px-3 py-2 text-sm font-medium text-text-primary"
                  >
                    {item}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-border bg-bg-primary p-3">
              <p className="text-eyebrow uppercase text-text-tertiary">Available addresses</p>
              <div className="mt-2 space-y-1">
                {mobileStatus.advertisedAddresses.map((address) => (
                  <div key={address.url} className="flex items-center justify-between gap-3">
                    <span className="text-sm text-text-secondary">{address.label}</span>
                    <span className="truncate font-mono text-xs text-text-tertiary">
                      {address.url}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-start gap-4">
              <Button size="sm" onClick={createPairingTicket} disabled={mobileBusy}>
                {pairingTicket ? 'Refresh QR code' : 'Create QR code'}
              </Button>
              {pairingTicket && (
                <div className="rounded-lg border border-border bg-white p-3">
                  <div
                    className="h-48 w-48"
                    dangerouslySetInnerHTML={{ __html: pairingTicket.qrSvg }}
                  />
                </div>
              )}
              {pairingTicket && (
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm text-text-secondary">
                    Scan this in the mobile app. Expires{' '}
                    {new Date(pairingTicket.expiresAt).toLocaleTimeString()}.
                  </p>
                  <p className="break-all font-mono text-xs text-text-tertiary">
                    {pairingTicket.pairingUrl}
                  </p>
                </div>
              )}
            </div>

            <div className="rounded-md border border-border bg-bg-primary p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium text-text-primary">Raycast access</p>
                  <p className="text-sm text-text-secondary">
                    Create a bearer token for the internal Raycast extension. The token is shown
                    once, because secrets should not become decorative UI.
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={createRaycastToken}
                  disabled={mobileBusy}
                >
                  Create Raycast token
                </Button>
              </div>
              {raycastToken && (
                <div className="mt-3 space-y-2 rounded-md border border-warning/30 bg-warning/5 p-3">
                  <p className="text-eyebrow uppercase text-text-tertiary">
                    Copy into Raycast extension preferences
                  </p>
                  <p className="break-all font-mono text-xs text-text-secondary">
                    Base URL: {raycastToken.baseUrl}
                  </p>
                  <p className="break-all font-mono text-xs text-text-secondary">
                    Token: {raycastToken.token}
                  </p>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-eyebrow uppercase text-text-tertiary">Paired devices</p>
              {mobileDevices.length === 0 ? (
                <p className="text-sm text-text-tertiary">No paired devices yet.</p>
              ) : (
                <div className="space-y-2">
                  {mobileDevices.map((device) => (
                    <div
                      key={device.id}
                      className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg-primary px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {device.name}
                        </p>
                        <p className="text-xs text-text-tertiary">
                          {formatCompanionClientType(device.clientType)} -{' '}
                          {device.revokedAt
                            ? `Revoked ${new Date(device.revokedAt).toLocaleString()}`
                            : device.lastSeenAt
                              ? `Last seen ${new Date(device.lastSeenAt).toLocaleString()}`
                              : `Paired ${new Date(device.createdAt).toLocaleString()}`}
                        </p>
                      </div>
                      {!device.revokedAt && (
                        <button
                          onClick={() => void revokeMobileDevice(device.id)}
                          disabled={mobileBusy}
                          className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-error/10 hover:text-error disabled:opacity-50"
                          title="Revoke device"
                          aria-label={`Revoke ${device.name}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-eyebrow uppercase text-text-tertiary">Account-connected devices</p>
              <p className="text-sm text-text-secondary">
                Devices signed in to your Anvil account must be approved here before they can
                observe, approve, or steer this machine.
              </p>
              {enrollmentPolicies.length === 0 ? (
                <p className="text-sm text-text-tertiary">No account devices have connected yet.</p>
              ) : (
                <div className="space-y-2">
                  {enrollmentPolicies.map((policy) => (
                    <div
                      key={policy.enrollmentId}
                      className="rounded-md border border-border bg-bg-primary px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-text-primary">
                            {policy.displayName ?? policy.enrollmentId}
                          </p>
                          <p className="text-xs text-text-tertiary">
                            {policy.tier === 'pending'
                              ? `Requested access ${new Date(policy.firstSeenAt).toLocaleString()}`
                              : policy.tier === 'denied'
                                ? 'Denied'
                                : `Can ${policy.tier}`}
                            {policy.decidedAt
                              ? ` - decided ${new Date(policy.decidedAt).toLocaleString()}`
                              : ''}
                          </p>
                        </div>
                        <button
                          onClick={() => void removeEnrollmentPolicy(policy.enrollmentId)}
                          disabled={mobileBusy}
                          className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-error/10 hover:text-error disabled:opacity-50"
                          title="Forget this device"
                          aria-label={`Forget ${policy.displayName ?? policy.enrollmentId}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {(['observe', 'approve', 'steer'] as const).map((tier) => (
                          <button
                            key={tier}
                            onClick={() => void updateEnrollmentPolicy(policy.enrollmentId, tier)}
                            disabled={mobileBusy || policy.tier === tier}
                            className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors disabled:opacity-50 ${
                              policy.tier === tier
                                ? 'bg-accent text-accent-foreground'
                                : 'border border-border text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                            }`}
                          >
                            {tier}
                          </button>
                        ))}
                        <button
                          onClick={() => void updateEnrollmentPolicy(policy.enrollmentId, 'denied')}
                          disabled={mobileBusy || policy.tier === 'denied'}
                          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                            policy.tier === 'denied'
                              ? 'bg-error/80 text-white'
                              : 'border border-border text-text-secondary hover:bg-error/10 hover:text-error'
                          }`}
                        >
                          Deny
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </SettingsPanel>
    </>
  );
}
