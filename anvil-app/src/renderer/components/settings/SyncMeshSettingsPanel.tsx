import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  Check,
  Cloud,
  Copy,
  HardDrive,
  Loader2,
  Server,
  Unplug,
} from 'lucide-react';
import {
  syncBackendModeLabel,
  type SyncBackendConnectionMode,
  type SyncBackendDiscovery,
  type SyncBackendStatus,
} from '../../../shared/sync-backend';
import type {
  SyncAdoptionPreviewItem,
  SyncConflictView,
  SyncIssuedEnrollmentCode,
  SyncRuntimeStatus,
} from '../../../shared/sync-runtime';
import { copyTextToClipboard } from '../../utils/clipboard';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modeDescription(mode: SyncBackendConnectionMode): string {
  switch (mode) {
    case 'local':
      return 'All data stays on this device.';
    case 'hosted':
      return 'Sign in with an Anvil-hosted account.';
    case 'cloudflare':
      return 'Point Anvil at your own Cloudflare deployment of the official backend.';
    case 'compatible':
      return 'Point Anvil at any backend implementing the frozen v1 contract.';
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

const MODE_ORDER: SyncBackendConnectionMode[] = ['local', 'hosted', 'cloudflare', 'compatible'];

export function SyncMeshSettingsPanel(): ReactNode {
  const [mode, setMode] = useState<SyncBackendConnectionMode>('local');
  const [status, setStatus] = useState<SyncBackendStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [url, setUrl] = useState('');
  const [discovery, setDiscovery] = useState<SyncBackendDiscovery | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [runtime, setRuntime] = useState<SyncRuntimeStatus | null>(null);
  const [preview, setPreview] = useState<SyncAdoptionPreviewItem[]>([]);
  const [conflicts, setConflicts] = useState<SyncConflictView[]>([]);
  const [accountId, setAccountId] = useState('account-1');
  const [enrollmentCode, setEnrollmentCode] = useState('');
  const [issuedCode, setIssuedCode] = useState<SyncIssuedEnrollmentCode | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  const refreshStatus = async (): Promise<void> => {
    setStatusLoading(true);
    try {
      const next = await window.anvil.syncBackend.status();
      setStatus(next);
      if (next.state === 'active' && next.connectionMode !== 'local') {
        setMode(next.connectionMode);
      }
      const [runtimeNext, previewNext, conflictNext] = await Promise.all([
        window.anvil.syncRuntime.status(),
        window.anvil.syncRuntime.preview(),
        window.anvil.syncRuntime.conflicts(),
      ]);
      setRuntime(runtimeNext);
      setPreview(previewNext);
      setConflicts(conflictNext);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setStatusLoading(false);
    }
  };

  useEffect(() => {
    void refreshStatus();
  }, []);

  const handleDiscover = async (): Promise<void> => {
    setDiscovering(true);
    setError(null);
    setDiscovery(null);
    try {
      const result = await window.anvil.syncBackend.discover(url);
      setDiscovery(result);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setDiscovering(false);
    }
  };

  const handlePin = async (): Promise<void> => {
    if (!discovery) {
      return;
    }
    setPinning(true);
    setError(null);
    try {
      const next = await window.anvil.syncBackend.pin({
        baseUrl: discovery.baseUrl,
        descriptor: discovery.descriptor,
      });
      setStatus(next);
      setMode('compatible');
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setPinning(false);
    }
  };

  const handleDisconnect = async (): Promise<void> => {
    setDisconnecting(true);
    setError(null);
    try {
      const next = await window.anvil.syncBackend.disconnect();
      setStatus(next);
      await refreshStatus();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setDisconnecting(false);
    }
  };

  const handleSpikeEnroll = async (): Promise<void> => {
    setEnrolling(true);
    setError(null);
    try {
      await window.anvil.syncRuntime.spikeEnroll({ accountId });
      await refreshStatus();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setEnrolling(false);
    }
  };

  const handleSignIn = async (): Promise<void> => {
    setSigningIn(true);
    setError(null);
    try {
      await window.anvil.syncRuntime.signIn();
      await refreshStatus();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setSigningIn(false);
    }
  };

  const handleEnrollWithCode = async (): Promise<void> => {
    setEnrolling(true);
    setError(null);
    try {
      await window.anvil.syncRuntime.enrollWithCode(enrollmentCode.trim());
      setEnrollmentCode('');
      await refreshStatus();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setEnrolling(false);
    }
  };

  const handleIssueCode = async (): Promise<void> => {
    setError(null);
    try {
      const issued = await window.anvil.syncRuntime.issueEnrollmentCode();
      setIssuedCode(issued);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  const handleEnableSync = async (): Promise<void> => {
    setEnabling(true);
    setError(null);
    try {
      await window.anvil.syncRuntime.enable();
      await refreshStatus();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setEnabling(false);
    }
  };

  const handleSignOut = async (): Promise<void> => {
    setError(null);
    try {
      await window.anvil.syncRuntime.signOut();
      await refreshStatus();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  const handleResolve = async (
    conflictId: string,
    resolution: 'keep-local' | 'use-remote',
  ): Promise<void> => {
    setError(null);
    try {
      await window.anvil.syncRuntime.resolveConflict(conflictId, resolution);
      await refreshStatus();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  const handleResolveReview = async (): Promise<void> => {
    if (!status?.backendId) {
      return;
    }
    setError(null);
    try {
      await window.anvil.syncBackend.resolveReview(status.backendId);
      await refreshStatus();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  const handleCopyPrompt = async (): Promise<void> => {
    setPromptLoading(true);
    setError(null);
    try {
      const text = prompt ?? (await window.anvil.syncBackend.integrationPrompt());
      setPrompt(text);
      await copyTextToClipboard(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setPromptLoading(false);
    }
  };

  const showEndpointFlow = mode === 'compatible' || mode === 'cloudflare';

  return (
    <div className="space-y-3">
      <Panel
        title="Connection mode"
        description="The same built app connects to any compatible backend. Switching pauses the old connection; cursors are never moved between backends."
      >
        {statusLoading ? (
          <p className="flex items-center gap-2 text-sm text-text-tertiary">
            <Loader2 size={14} className="animate-spin" /> Loading connection status…
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {MODE_ORDER.map((option) => {
              const disabled = option === 'hosted';
              const selected = mode === option;
              return (
                <button
                  key={option}
                  type="button"
                  disabled={disabled}
                  onClick={() => setMode(option)}
                  className={`rounded-md border p-3 text-left transition-colors ${
                    selected
                      ? 'border-accent/60 bg-accent/5'
                      : 'border-border bg-bg-primary hover:bg-bg-tertiary'
                  } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
                    {option === 'local' ? (
                      <HardDrive size={15} className="text-accent" />
                    ) : option === 'hosted' ? (
                      <Cloud size={15} className="text-accent" />
                    ) : (
                      <Server size={15} className="text-accent" />
                    )}
                    {syncBackendModeLabel(option)}
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-text-secondary">
                    {disabled ? 'Not shipping in this packet.' : modeDescription(option)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Panel>

      {mode === 'local' && (
        <Panel
          title="Local only"
          description="Sync and Mesh stay off. Everything remains on this device."
        >
          <p className="text-sm text-text-secondary">
            {status?.backendId
              ? `A ${status.displayName ?? 'backend'} association is remembered but paused. Pick a backend mode above to review it.`
              : 'No backend is associated with this device.'}
          </p>
        </Panel>
      )}

      {showEndpointFlow && (
        <Panel
          title={mode === 'cloudflare' ? 'My Cloudflare deployment' : 'Compatible backend'}
          description={
            mode === 'cloudflare'
              ? 'Deploy the official backend to your own Cloudflare account, then paste its base URL below.'
              : 'Paste the base URL of a backend implementing the frozen v1 contract.'
          }
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://anvil.example.com/"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-md border border-border bg-bg-primary px-3 py-1.5 font-mono text-sm text-text-primary placeholder:text-text-tertiary"
            />
            <button
              type="button"
              onClick={() => void handleDiscover()}
              disabled={discovering || url.trim().length === 0}
              className="flex shrink-0 items-center justify-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              {discovering && <Loader2 size={14} className="animate-spin" />}
              Discover
            </button>
          </div>

          {discovery && (
            <div className="space-y-2 rounded-md border border-border bg-bg-primary p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
                Review before pinning
              </p>
              <dl className="space-y-1 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-text-tertiary">Endpoint</dt>
                  <dd className="truncate font-mono text-xs text-text-primary">
                    {discovery.baseUrl}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-tertiary">Deployment</dt>
                  <dd className="truncate text-xs text-text-primary">
                    {discovery.descriptor.displayName} ·{' '}
                    <span className="font-mono">{discovery.descriptor.deploymentId}</span>
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-tertiary">Identity issuer</dt>
                  <dd className="truncate font-mono text-xs text-text-primary">
                    {discovery.descriptor.auth.issuer}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-tertiary">Capabilities</dt>
                  <dd className="text-xs text-text-primary">
                    {discovery.descriptor.profiles.join(', ')}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-tertiary">Sign-in</dt>
                  <dd className="text-xs text-text-primary">
                    {discovery.descriptor.authModes.join(', ')}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-tertiary">Limits</dt>
                  <dd className="font-mono text-xs text-text-primary">
                    {discovery.limits.entityBytes}/{discovery.limits.pageBytes}B ·{' '}
                    {discovery.limits.batchChanges} changes · {discovery.limits.liveFrameBytes}B
                    frames
                  </dd>
                </div>
              </dl>
              <p className="text-xs leading-relaxed text-text-tertiary">
                Pinning stores a paused association for review. It does not enable upload.
              </p>
              <button
                type="button"
                onClick={() => void handlePin()}
                disabled={pinning}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
              >
                {pinning ? 'Pinning…' : 'Pin association'}
              </button>
            </div>
          )}
        </Panel>
      )}

      <Panel title="Backend status" description="Public connection metadata. Never shows tokens.">
        {!status || status.backendId === null ? (
          <p className="text-sm text-text-tertiary">No backend associated yet.</p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text-primary">
                  {status.displayName ?? status.backendId}
                </p>
                <p className="truncate font-mono text-xs text-text-tertiary">{status.baseUrl}</p>
                <p className="mt-1 text-xs text-text-secondary">
                  {status.profiles.join(', ') || 'no profiles'} ·{' '}
                  {status.authModes.join(', ') || 'no sign-in modes'} ·{' '}
                  {status.state === 'active'
                    ? 'Connected'
                    : status.state === 'paused'
                      ? 'Paused — upload disabled'
                      : 'Disconnected'}
                </p>
                {status.identityReviewRequired && (
                  <div className="mt-2 rounded-md border border-warning/50 bg-warning/10 p-2">
                    <p className="flex items-start gap-2 text-xs text-text-secondary">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
                      This backend's endpoint or sign-in issuer changed. Sync stays paused and no
                      credentials are sent until you confirm the new identity.
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleResolveReview()}
                      className="mt-2 rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                    >
                      I reviewed {status.baseUrl} — trust it
                    </button>
                  </div>
                )}
              </div>
              {status.state === 'active' && (
                <button
                  type="button"
                  onClick={() => void handleDisconnect()}
                  disabled={disconnecting}
                  className="flex shrink-0 items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
                >
                  <Unplug size={14} />
                  {disconnecting ? 'Pausing…' : 'Disconnect'}
                </button>
              )}
            </div>
          </div>
        )}
      </Panel>

      <Panel
        title="Device enrollment"
        description="Sign in through the backend's advertised methods. Codes are single-use and expire quickly."
      >
        {runtime?.auth.state === 'signed-in' ? (
          <div className="space-y-2">
            <p className="text-sm text-text-secondary">
              Signed in as {runtime.auth.accountId} · enrollment {runtime.auth.enrollmentId}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleIssueCode()}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
              >
                Create pairing code
              </button>
              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
              >
                Sign out
              </button>
            </div>
            {issuedCode && (
              <div className="rounded-md border border-border bg-bg-primary p-2">
                <p className="font-mono text-sm text-text-primary">{issuedCode.code}</p>
                <p className="text-xs text-text-tertiary">
                  Single-use · expires {new Date(issuedCode.expiresAt).toLocaleTimeString()}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {(status?.authModes ?? []).includes('oidc-pkce') && (
              <button
                type="button"
                onClick={() => void handleSignIn()}
                disabled={signingIn}
                className="flex items-center justify-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
              >
                {signingIn && <Loader2 size={14} className="animate-spin" />}
                {signingIn ? 'Waiting for browser sign-in…' : 'Sign in with browser'}
              </button>
            )}
            {(status?.authModes ?? []).includes('enrollment-code') && (
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  value={enrollmentCode}
                  onChange={(event) => setEnrollmentCode(event.target.value)}
                  placeholder="anvil-ec-XXXXX-XXXXX-…"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-md border border-border bg-bg-primary px-3 py-1.5 font-mono text-sm text-text-primary placeholder:text-text-tertiary"
                />
                <button
                  type="button"
                  onClick={() => void handleEnrollWithCode()}
                  disabled={enrolling || enrollmentCode.trim().length === 0}
                  className="flex shrink-0 items-center justify-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
                >
                  {enrolling && <Loader2 size={14} className="animate-spin" />}
                  Redeem code
                </button>
              </div>
            )}
            {runtime?.devSpikeAvailable === true && (
              <div className="rounded-md border border-dashed border-border p-2">
                <p className="mb-2 text-xs text-text-tertiary">
                  Development fixture only — not available in packaged builds.
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    value={accountId}
                    onChange={(event) => setAccountId(event.target.value)}
                    placeholder="account-1"
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded-md border border-border bg-bg-primary px-3 py-1.5 font-mono text-sm text-text-primary placeholder:text-text-tertiary"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSpikeEnroll()}
                    disabled={enrolling || accountId.trim().length === 0}
                    className="flex shrink-0 items-center justify-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
                  >
                    Spike enroll
                  </button>
                </div>
              </div>
            )}
            {status !== null && status.authModes.length === 0 && (
              <p className="text-sm text-text-tertiary">
                The pinned backend advertises no supported sign-in methods.
              </p>
            )}
          </div>
        )}
      </Panel>

      <Panel
        title="Enable Sync"
        description="Pinning does not upload. Enable Sync binds local workflow templates and starts the push/pull loop. Mesh stays off."
      >
        {preview.length === 0 ? (
          <p className="text-sm text-text-tertiary">No workflow templates on this device yet.</p>
        ) : (
          <ul className="list-inside list-disc text-sm text-text-secondary">
            {preview.map((item) => (
              <li key={item.entityId}>{item.name}</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-text-tertiary">
          {runtime?.syncEnabled
            ? `Sync is on. ${runtime.pendingCount} pending · last pull ${runtime.lastPullAt ?? 'never'}`
            : 'Sync is off until you enable it.'}
        </p>
        {runtime?.lastError && <p className="text-xs text-error">{runtime.lastError}</p>}
        <button
          type="button"
          onClick={() => void handleEnableSync()}
          disabled={enabling || runtime?.syncEnabled === true}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
        >
          {enabling ? 'Enabling…' : runtime?.syncEnabled ? 'Sync enabled' : 'Enable Sync'}
        </button>
      </Panel>

      {conflicts.length > 0 && (
        <Panel title="Conflicts" description="Both devices edited the same template. Pick a side.">
          <ul className="space-y-3">
            {conflicts.map((conflict) => (
              <li key={conflict.id} className="rounded-md border border-border p-3">
                <p className="text-sm text-text-primary">
                  {conflict.localLabel ?? conflict.entityId}
                </p>
                <p className="text-xs text-text-tertiary">
                  Local: {conflict.localLabel ?? 'unknown'} · Remote:{' '}
                  {conflict.remoteLabel ?? 'unknown'}
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => void handleResolve(conflict.id, 'keep-local')}
                    className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                  >
                    Keep local
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleResolve(conflict.id, 'use-remote')}
                    className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                  >
                    Use remote
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel
        title="Integration prompt"
        description="Hand this to an agent implementing a compatible backend, with this build's protocol pinned."
      >
        <button
          type="button"
          onClick={() => void handleCopyPrompt()}
          disabled={promptLoading}
          className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {promptLoading ? 'Loading…' : copied ? 'Copied' : 'Copy integration prompt'}
        </button>
        <textarea
          readOnly
          value={prompt ?? ''}
          placeholder="The filled prompt appears here so it can be copied manually."
          rows={10}
          spellCheck={false}
          className="w-full rounded-md border border-border bg-bg-primary p-3 font-mono text-xs leading-relaxed text-text-secondary placeholder:text-text-tertiary"
        />
      </Panel>

      {error && (
        <p className="flex items-start gap-2 rounded-md border border-error/30 bg-error/5 p-3 text-sm text-error">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}
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
