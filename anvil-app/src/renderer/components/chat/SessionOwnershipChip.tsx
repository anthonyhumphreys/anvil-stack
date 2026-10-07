import type { RemoteCodexAccountAuthChoice } from '../../../shared/remote-chat';
import type { AgentProvider } from '../../../shared/types';
import type { CloudAgentProviderStatus } from '../../../shared/cloud-agent';
import { SettingsLink } from '../shared/SettingsLink';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowRightLeft, Laptop, Loader2 } from 'lucide-react';
import type {
  HandoffRecord,
  HandoffState,
  SessionMeshState,
  SyncDevice,
  SyncHandoffBlocker,
} from '../../../shared/sync-runtime';

const HANDOFF_TERMINAL: ReadonlySet<HandoffState> = new Set(['completed', 'cancelled', 'failed']);

const POLL_MS = 10_000;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * §18 session view: which device owns this session's execution, plus the
 * Move control. A null ownership row means the session has never left this
 * device — shown as "this device", not guessed. Mid-flight handoffs render
 * their real state rather than a spinner.
 */
export function SessionOwnershipChip({
  sessionId,
  provider = 'codex',
}: {
  sessionId: string;
  provider?: AgentProvider;
}): ReactNode {
  const [meshState, setMeshState] = useState<SessionMeshState | null>(null);
  const [devices, setDevices] = useState<SyncDevice[] | null>(null);
  const [cloudProviders, setCloudProviders] = useState<CloudAgentProviderStatus[]>([]);
  const [cloudProvidersLoaded, setCloudProvidersLoaded] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [cloudAuthChoice, setCloudAuthChoice] =
    useState<RemoteCodexAccountAuthChoice>('codex-host-auth');
  const [moving, setMoving] = useState(false);
  const [blockers, setBlockers] = useState<SyncHandoffBlocker[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const state = await window.anvil.syncRuntime.getSessionMeshState(sessionId);
      if (mounted.current) setMeshState(state);
    } catch {
      // Local-only or signed-out: no mesh state — hide the chip entirely.
      if (mounted.current) setMeshState(null);
    }
    try {
      const list = await window.anvil.syncRuntime.listDevices();
      if (mounted.current) setDevices(list);
    } catch {
      // Device names degrade to enrollment ids; Move requires the list.
      if (mounted.current) setDevices(null);
    }
  }, [sessionId]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!moveOpen || !devices?.some((device) => device.enrollmentClass === 'ephemeral')) {
      setCloudProviders([]);
      setCloudProvidersLoaded(false);
      return;
    }
    let disposed = false;
    setCloudProvidersLoaded(false);
    void window.anvil.cloudAgentSettings
      .get()
      .then((snapshot) => {
        if (!disposed) {
          setCloudProviders(snapshot.providers);
          setCloudProvidersLoaded(true);
        }
      })
      .catch(() => {
        if (!disposed) {
          setCloudProviders([]);
          setCloudProvidersLoaded(true);
        }
      });
    return () => {
      disposed = true;
    };
  }, [moveOpen, devices, provider]);

  // The device roster is available only after sign-in. A local-only chat has
  // no destination to show and should not display a misleading Move control.
  if (meshState === null || devices === null) return null;

  const selfEnrollmentId = devices?.find((d) => d.self === true)?.enrollmentId;
  const latestHandoff: HandoffRecord | undefined = meshState.handoffs[0];
  const inFlight = latestHandoff !== undefined && !HANDOFF_TERMINAL.has(latestHandoff.state);

  const deviceName = (enrollmentId: string | undefined): string => {
    if (enrollmentId === undefined) return 'another device';
    const device = devices?.find((d) => d.enrollmentId === enrollmentId);
    const base = device?.displayName ?? `device ${enrollmentId.slice(0, 8)}`;
    return device?.self === true ? `${base} (this device)` : base;
  };

  const ownership = meshState.ownership;
  // Null row = never handed off = implicitly local. An 'owned' row only
  // counts when the owner resolves to this device — with the device list
  // unavailable we cannot verify, so claim nothing.
  const ownedHere =
    ownership === null ||
    (ownership.state === 'owned' &&
      selfEnrollmentId !== undefined &&
      ownership.ownerEnrollmentId === selfEnrollmentId);

  let ownerLabel: string;
  if (inFlight) {
    ownerLabel = `moving to ${deviceName(latestHandoff.targetEnrollmentId)}`;
  } else if (ownership === null) {
    ownerLabel = 'this device';
  } else if (ownership.state === 'owned') {
    ownerLabel = deviceName(ownership.ownerEnrollmentId);
  } else {
    // Relinquished — the mirror row keeps this device's id; the newest
    // completed handoff names the real owner.
    const completed = meshState.handoffs.find((h) => h.state === 'completed');
    ownerLabel =
      completed === undefined ? 'another device' : deviceName(completed.targetEnrollmentId);
  }

  const targets = (devices ?? []).filter(
    (d) => d.self !== true && d.revoked !== true && d.trustState === 'trusted',
  );
  const canMove = ownedHere && !inFlight && !moving && targets.length > 0;
  const cloudProviderStatus = cloudProviders.find((item) => item.provider === provider);
  const cloudProviderReady =
    cloudProviderStatus?.enabled === true &&
    (provider === 'codex' || cloudProviderStatus.connected);
  const hasCloudTargets = targets.some((device) => device.enrollmentClass === 'ephemeral');
  const needsCloudConnection = hasCloudTargets && cloudProvidersLoaded && !cloudProviderReady;

  const handleMove = async (targetEnrollmentId: string): Promise<void> => {
    setMoving(true);
    setBlockers(null);
    setError(null);
    try {
      const result = await window.anvil.syncRuntime.initiateSessionHandoff(
        sessionId,
        targetEnrollmentId,
        devices.find((device) => device.enrollmentId === targetEnrollmentId)?.enrollmentClass ===
          'ephemeral' && provider === 'codex'
          ? cloudAuthChoice
          : undefined,
      );
      if (result.ok) {
        setMoveOpen(false);
      } else {
        setBlockers(result.blockers);
      }
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setMoving(false);
    }
  };

  return (
    <div className="shrink-0 border-t border-border-subtle px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-text-tertiary">
          <Laptop size={11} className="shrink-0" />
          <span className="truncate">
            Session on <span className="text-text-secondary">{ownerLabel}</span>
            {inFlight && latestHandoff !== undefined
              ? ` — ${latestHandoff.state.replaceAll('-', ' ')}`
              : ''}
          </span>
          {(inFlight || moving) && (
            <Loader2 size={11} className="shrink-0 animate-spin motion-reduce:animate-none" />
          )}
        </p>
        {ownedHere && !inFlight && targets.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setBlockers(null);
              setError(null);
              setMoveOpen((open) => !open);
            }}
            aria-expanded={moveOpen}
            disabled={moving}
            className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
          >
            <ArrowRightLeft size={10} />
            Move session
          </button>
        )}
      </div>

      {ownedHere && !inFlight && targets.length === 0 && (
        <p className="mt-1 text-xs text-text-tertiary">
          Connect another device to move this session.
        </p>
      )}

      {moveOpen && canMove && (
        <div className="mt-1.5 space-y-1">
          {hasCloudTargets && provider !== 'codex' && (
            <p className="text-xs text-text-secondary">
              Cloud uses your configured {provider} connection.{' '}
              <SettingsLink to="sync#cloud-agents">Manage Cloud agent providers</SettingsLink>.
            </p>
          )}
          {targets.some((device) => device.enrollmentClass === 'ephemeral') &&
            provider === 'codex' && (
              <label className="flex flex-col gap-1 text-xs text-text-secondary">
                Cloud Codex login
                <select
                  value={cloudAuthChoice}
                  onChange={(event) =>
                    setCloudAuthChoice(event.target.value as RemoteCodexAccountAuthChoice)
                  }
                  disabled={moving}
                  className="rounded-md border border-border bg-bg-secondary px-2 py-1"
                >
                  <option value="codex-host-auth">Use my Codex login from this device</option>
                  <option value="codex-account">Sign in on the cloud worker</option>
                </select>
              </label>
            )}
          <ul className="space-y-1">
            {targets.map((device) => (
              <li key={device.enrollmentId}>
                <button
                  type="button"
                  onClick={() => void handleMove(device.enrollmentId)}
                  disabled={
                    moving || (device.enrollmentClass === 'ephemeral' && !cloudProviderReady)
                  }
                  className="w-full rounded-md border border-border px-2 py-1 text-left text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
                >
                  {device.displayName} · {device.enrollmentId.slice(0, 8)}…
                  {device.enrollmentClass === 'ephemeral' && !cloudProvidersLoaded
                    ? ' (checking access)'
                    : ''}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasCloudTargets && !cloudProvidersLoaded && moveOpen && (
        <p className="mt-1 text-xs text-text-secondary">Checking cloud provider access…</p>
      )}
      {needsCloudConnection && (
        <p className="mt-1 text-xs text-warning">
          {provider === 'codex'
            ? 'Allow Codex for cloud agents in Cloud agent settings.'
            : `${provider} needs to be enabled and connected for cloud handoff.`}{' '}
          <SettingsLink to="sync#cloud-agents">Open Cloud agent settings</SettingsLink>.
        </p>
      )}
      {blockers !== null && blockers.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {blockers.map((blocker, index) => (
            <li key={index} className="text-xs text-warning">
              {blocker.remediation}
              {blocker.repositoryId ? ` (${blocker.repositoryId.slice(0, 8)}…)` : ''}
            </li>
          ))}
        </ul>
      )}
      {error !== null && (
        <p role="alert" className="mt-1 text-xs text-error">
          {error}
        </p>
      )}
    </div>
  );
}
