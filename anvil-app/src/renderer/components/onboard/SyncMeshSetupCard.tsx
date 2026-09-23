import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Cloud,
  HardDrive,
  Loader2,
  Server,
  Zap,
} from 'lucide-react';
import { syncBackendModeLabel } from '../../../shared/sync-backend';
import { useSyncMeshSetup } from '../../hooks/useSyncMeshSetup';
import { CloudEnvironmentsPanel } from '../settings/CloudEnvironmentsPanel';
import { SettingsLink } from '../shared/SettingsLink';

const SETUP_MODES = ['hosted', 'cloudflare', 'compatible'] as const;

function modeDescription(mode: (typeof SETUP_MODES)[number]): string {
  switch (mode) {
    case 'hosted':
      return 'Sign in to Anvil-hosted sync.';
    case 'cloudflare':
      return 'Use a deployment in your Cloudflare account.';
    case 'compatible':
      return 'Connect any backend that implements the Anvil contract.';
  }
}

function modeIcon(mode: (typeof SETUP_MODES)[number]): ReactNode {
  return mode === 'hosted' ? (
    <Cloud size={14} aria-hidden="true" />
  ) : (
    <Server size={14} aria-hidden="true" />
  );
}

function setupStateLabel(
  backendPinned: boolean,
  signedIn: boolean,
  runtime: ReturnType<typeof useSyncMeshSetup>['runtime'],
): string {
  if (runtime?.sessionExpired === true) return 'Sign in again';
  if (runtime?.quotaExceeded === true) return 'Quota reached';
  if (runtime?.syncEnabled === true) {
    const suffix = runtime.meshWorker.enabled ? ' + Mesh' : '';
    if (runtime.connectionState === 'live') return `Sync${suffix} on`;
    if (runtime.connectionState === 'connecting') return `Sync${suffix} connecting`;
    return `Sync${suffix} offline`;
  }
  if (signedIn) return 'Signed in';
  if (backendPinned) return 'Ready to sign in';
  return 'Optional';
}

export function SyncMeshSetupCard({ preview = false }: { preview?: boolean }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const setup = useSyncMeshSetup({ initialMode: 'hosted', preview });
  const { runtime } = setup;

  return (
    <div
      className={`rounded-lg border bg-bg-secondary transition-colors ${expanded ? 'border-accent/50' : 'border-border'}`}
    >
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
        aria-expanded={expanded}
        aria-controls="sync-mesh-onboarding-content"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-bg-tertiary text-text-secondary">
          <Cloud size={16} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text-primary">Sync &amp; Mesh</span>
            {!preview && runtime?.syncEnabled === true && runtime.connectionState === 'live' && (
              <Check size={14} className="text-success" aria-hidden="true" />
            )}
            <span className="text-xs text-text-tertiary">
              {setupStateLabel(setup.backendPinned, setup.signedIn, runtime)}
            </span>
          </span>
          <span className="block text-xs text-text-tertiary">
            Keep Anvil state in step and optionally run work on this device
          </span>
        </span>
        {expanded ? (
          <ChevronUp size={16} className="text-text-tertiary" aria-hidden="true" />
        ) : (
          <ChevronDown size={16} className="text-text-tertiary" aria-hidden="true" />
        )}
      </button>

      {expanded && (
        <div id="sync-mesh-onboarding-content" className="border-t border-border px-4 pb-4 pt-3">
          {preview ? (
            <p className="text-xs leading-relaxed text-text-secondary">
              Optional. Connect a backend, sign in, then choose whether this device can run Mesh
              jobs. You can{' '}
              <SettingsLink to="sync#sync-mesh">finish setup later in Settings</SettingsLink>.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="rounded-md border border-accent/20 bg-accent/5 p-3">
                <p className="text-xs leading-relaxed text-text-secondary">
                  Sync is opt-in. Mesh is a separate device permission, so this computer only runs
                  jobs when you explicitly allow it.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {SETUP_MODES.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => {
                      setup.setMode(option);
                      if (option === 'hosted' && setup.status?.hostedBackendUrl) {
                        setup.setEndpoint(setup.status.hostedBackendUrl);
                      }
                    }}
                    disabled={setup.isBusy}
                    className={`flex items-start gap-2 rounded-md border p-2 text-left transition-colors disabled:opacity-60 ${
                      setup.mode === option
                        ? 'border-accent/60 bg-accent/5 text-text-primary'
                        : 'border-border bg-bg-primary text-text-secondary hover:bg-bg-tertiary'
                    }`}
                  >
                    <span className="mt-0.5 text-accent">{modeIcon(option)}</span>
                    <span className="min-w-0">
                      <span className="block text-xs font-medium">
                        {syncBackendModeLabel(option)}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-text-tertiary">
                        {modeDescription(option)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>

              {!setup.backendPinned && (
                <div className="space-y-2">
                  <label
                    className="block text-xs font-medium text-text-secondary"
                    htmlFor="sync-mesh-onboarding-endpoint"
                  >
                    Backend URL
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      id="sync-mesh-onboarding-endpoint"
                      value={setup.endpoint}
                      onChange={(event) => setup.setEndpoint(event.target.value)}
                      disabled={setup.isBusy}
                      placeholder="https://sync.example.com/"
                      spellCheck={false}
                      className="min-w-0 flex-1 rounded-md border border-border bg-bg-primary px-2.5 py-1.5 font-mono text-xs text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <button
                      type="button"
                      onClick={() => void setup.handleDiscover()}
                      disabled={setup.isBusy || setup.endpoint.trim() === ''}
                      className="flex shrink-0 items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-50"
                    >
                      {setup.busy === 'discovering' && (
                        <Loader2 size={12} className="animate-spin motion-reduce:animate-none" />
                      )}
                      Check backend
                    </button>
                  </div>
                  <p className="text-xs leading-relaxed text-text-tertiary">
                    The endpoint is inspected before Anvil saves it. Credentials are only sent after
                    you review the identity.
                  </p>
                </div>
              )}

              {setup.discovery !== null && (
                <div className="space-y-2 rounded-md border border-border bg-bg-primary p-3">
                  <div className="flex items-start gap-2">
                    <Check size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-text-primary">Backend details found</p>
                      <p className="truncate font-mono text-xs text-text-tertiary">
                        {setup.discovery.baseUrl}
                      </p>
                      <p className="mt-1 text-xs text-text-secondary">
                        {setup.discovery.descriptor.displayName} ·{' '}
                        {setup.discovery.descriptor.profiles.join(', ') || 'sync'}
                      </p>
                      <p
                        className="mt-1 truncate font-mono text-xs text-text-tertiary"
                        title={setup.discovery.descriptor.auth.issuer}
                      >
                        Sign-in issuer: {setup.discovery.descriptor.auth.issuer}
                      </p>
                    </div>
                  </div>
                  <p className="text-xs text-text-tertiary">
                    Review the endpoint and sign-in issuer before using this backend.
                  </p>
                  <button
                    type="button"
                    onClick={() => void setup.handlePin()}
                    disabled={setup.isBusy}
                    className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
                  >
                    {setup.busy === 'pinning' ? 'Saving…' : 'Use this backend'}
                  </button>
                </div>
              )}

              {setup.status?.identityReviewRequired === true && (
                <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3">
                  <div className="flex items-start gap-2">
                    <AlertTriangle
                      size={14}
                      className="mt-0.5 shrink-0 text-warning"
                      aria-hidden="true"
                    />
                    <p className="text-xs leading-relaxed text-text-secondary">
                      This backend&apos;s endpoint or sign-in issuer changed. Review{' '}
                      <span className="font-mono">{setup.status.baseUrl}</span> before Anvil sends
                      credentials or enables Sync.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void setup.handleResolveIdentityReview()}
                    disabled={setup.isBusy}
                    className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
                  >
                    {setup.busy === 'reviewing' ? 'Confirming…' : 'Trust this backend'}
                  </button>
                </div>
              )}

              {setup.backendPinned && !setup.signedIn && (
                <div className="space-y-2 rounded-md border border-border bg-bg-primary p-3">
                  <p className="text-xs text-text-secondary">
                    The backend is ready. Enroll this device before turning Sync on.
                  </p>
                  {setup.authModes.includes('oidc-pkce') && (
                    <button
                      type="button"
                      onClick={() => void setup.handleSignIn()}
                      disabled={setup.isBusy}
                      className="flex items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-50"
                    >
                      {setup.busy === 'signing-in' && (
                        <Loader2 size={12} className="animate-spin motion-reduce:animate-none" />
                      )}
                      {setup.busy === 'signing-in'
                        ? 'Waiting for browser sign-in…'
                        : 'Sign in with browser'}
                    </button>
                  )}
                  {setup.authModes.includes('enrollment-code') && (
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        value={setup.enrollmentCode}
                        onChange={(event) => setup.setEnrollmentCode(event.target.value)}
                        placeholder="Paste an enrollment code"
                        spellCheck={false}
                        aria-label="Enrollment code"
                        className="min-w-0 flex-1 rounded-md border border-border bg-bg-secondary px-2.5 py-1.5 font-mono text-xs text-text-primary placeholder:text-text-tertiary"
                      />
                      <button
                        type="button"
                        onClick={() => void setup.handleEnrollWithCode()}
                        disabled={setup.isBusy || setup.enrollmentCode.trim() === ''}
                        className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
                      >
                        {setup.busy === 'enrolling' ? 'Enrolling…' : 'Redeem code'}
                      </button>
                    </div>
                  )}
                  {setup.authModes.length === 0 && (
                    <p className="text-xs text-text-tertiary">
                      This backend does not advertise a sign-in method supported by Anvil.
                    </p>
                  )}
                </div>
              )}

              {setup.signedIn && runtime?.syncEnabled !== true && (
                <div className="space-y-2 rounded-md border border-border bg-bg-primary p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-text-primary">Review before Sync</p>
                      <p className="mt-0.5 text-xs text-text-tertiary">
                        {setup.adoptionPreview.length > 0
                          ? `${setup.adoptionPreview.length} local item${setup.adoptionPreview.length === 1 ? '' : 's'} will be associated with this account.`
                          : 'No local items are waiting to be associated.'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void setup.handleEnableSync()}
                      disabled={setup.isBusy || !setup.canEnableSync}
                      className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-50"
                    >
                      {setup.busy === 'enabling' ? 'Enabling…' : 'Turn on Sync'}
                    </button>
                  </div>
                  {setup.adoptionPreview.length > 0 && (
                    <ul className="list-inside list-disc text-xs text-text-secondary">
                      {setup.adoptionPreview.slice(0, 4).map((item) => (
                        <li key={`${item.entityType}:${item.entityId}`}>{item.name}</li>
                      ))}
                      {setup.adoptionPreview.length > 4 && (
                        <li className="text-text-tertiary">
                          <SettingsLink to="sync#sync-mesh">
                            {setup.adoptionPreview.length - 4} more in Settings
                          </SettingsLink>
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              )}

              {setup.signedIn && runtime?.syncEnabled === true && (
                <>
                  <div className="space-y-2 rounded-md border border-success/30 bg-success/5 p-3">
                    <div className="flex items-start gap-2">
                      <HardDrive
                        size={14}
                        className="mt-0.5 shrink-0 text-success"
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-text-primary">Sync is on</p>
                        <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
                          {runtime.connectionState === 'live'
                            ? 'Live connection established. Changes will arrive as they are made.'
                            : 'Anvil will keep retrying while the live connection comes online.'}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-pressed={runtime.meshWorker.enabled}
                      onClick={() => void setup.handleMeshChange()}
                      disabled={setup.isBusy}
                      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                        runtime.meshWorker.enabled
                          ? 'border-accent/60 bg-accent/10 text-accent'
                          : 'border-border text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                      }`}
                    >
                      <Zap size={12} aria-hidden="true" />
                      {setup.busy === 'mesh'
                        ? 'Updating…'
                        : runtime.meshWorker.enabled
                          ? 'Mesh jobs allowed on this device'
                          : 'Allow Mesh jobs on this device'}
                    </button>
                    {runtime.meshWorker.enabled && (
                      <p className="text-xs text-text-tertiary">
                        {runtime.meshWorker.connected ? (
                          <>
                            Ready — you can{' '}
                            <SettingsLink to="sync#sync-mesh">
                              change this permission in Settings
                            </SettingsLink>{' '}
                            any time.
                          </>
                        ) : (
                          'Connecting to the service. Anvil will retry automatically.'
                        )}
                      </p>
                    )}
                  </div>
                  <CloudEnvironmentsPanel compact />
                </>
              )}

              {setup.error !== null && (
                <p
                  className="flex items-start gap-2 rounded-md border border-error/30 bg-error/5 p-2 text-xs text-error"
                  role="alert"
                >
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>{setup.error}</span>
                </p>
              )}
            </div>
          )}
          <div className="mt-3 flex items-center justify-end gap-1.5 text-xs">
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="text-text-tertiary transition-colors hover:text-text-secondary"
            >
              {runtime?.syncEnabled === true ? 'Finish later' : 'Skip for now'}
            </button>
            {runtime?.syncEnabled !== true && (
              <>
                <span className="text-text-tertiary" aria-hidden="true">
                  ·
                </span>
                <SettingsLink to="sync#sync-mesh" className="font-normal">
                  set up in Settings
                </SettingsLink>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
