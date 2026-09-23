import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SyncBackendConnectionMode,
  SyncBackendDiscovery,
  SyncBackendStatus,
} from '../../shared/sync-backend';
import type {
  SyncAdoptionPreviewItem,
  SyncConflictView,
  SyncDevice,
  SyncRuntimeStatus,
} from '../../shared/sync-runtime';

// Settings also exposes local-only mode; onboarding simply renders the hosted
// and self-managed modes that can be configured during first run.
export type SyncSetupMode = SyncBackendConnectionMode;
export type SyncSetupBusy =
  | 'loading'
  | 'discovering'
  | 'pinning'
  | 'reviewing'
  | 'signing-in'
  | 'enrolling'
  | 'enabling'
  | 'mesh'
  | null;

const RUNTIME_POLL_INTERVAL_MS = 5_000;

export interface SyncMeshSetupController {
  mode: SyncSetupMode;
  setMode: (mode: SyncSetupMode) => void;
  endpoint: string;
  setEndpoint: (endpoint: string) => void;
  enrollmentCode: string;
  setEnrollmentCode: (code: string) => void;
  status: SyncBackendStatus | null;
  statusLoading: boolean;
  runtime: SyncRuntimeStatus | null;
  adoptionPreview: SyncAdoptionPreviewItem[];
  conflicts: SyncConflictView[];
  devices: SyncDevice[];
  discovery: SyncBackendDiscovery | null;
  busy: SyncSetupBusy;
  error: string | null;
  isBusy: boolean;
  backendPinned: boolean;
  signedIn: boolean;
  authModes: string[];
  canEnableSync: boolean;
  refresh: () => Promise<void>;
  handleDiscover: () => Promise<void>;
  handlePin: () => Promise<void>;
  handleResolveIdentityReview: () => Promise<void>;
  handleSignIn: () => Promise<void>;
  handleEnrollWithCode: () => Promise<void>;
  handleEnableSync: () => Promise<void>;
  handleMeshChange: () => Promise<void>;
  refreshHostedEntitlement: () => Promise<void>;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Shared first-run setup controller. It keeps the onboarding card and any
 * compact settings entry point on the same ordering and security boundaries:
 * discover, pin, enroll, enable Sync, then opt this device into Mesh.
 */
export function useSyncMeshSetup({
  preview = false,
  initialMode = 'local',
}: { preview?: boolean; initialMode?: SyncSetupMode } = {}): SyncMeshSetupController {
  const [mode, setModeState] = useState<SyncSetupMode>(initialMode);
  const [endpoint, setEndpointState] = useState('');
  const [enrollmentCode, setEnrollmentCode] = useState('');
  const [status, setStatus] = useState<SyncBackendStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(!preview);
  const [runtime, setRuntime] = useState<SyncRuntimeStatus | null>(null);
  const [adoptionPreview, setAdoptionPreview] = useState<SyncAdoptionPreviewItem[]>([]);
  const [conflicts, setConflicts] = useState<SyncConflictView[]>([]);
  const [devices, setDevices] = useState<SyncDevice[]>([]);
  const [discovery, setDiscovery] = useState<SyncBackendDiscovery | null>(null);
  const [busy, setBusy] = useState<SyncSetupBusy>(null);
  const [error, setError] = useState<string | null>(null);
  const runtimeRefreshSequence = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    if (preview) return;
    setStatusLoading(true);
    setError(null);
    setBusy((current) => (current === null ? 'loading' : current));
    try {
      const [statusNext, runtimeNext, previewNext, conflictsNext] = await Promise.all([
        window.anvil.syncBackend.status(),
        window.anvil.syncRuntime.status(),
        window.anvil.syncRuntime.preview(),
        window.anvil.syncRuntime.conflicts(),
      ]);
      const hosted =
        runtimeNext.auth.state === 'signed-in'
          ? await window.anvil.syncRuntime
              .refreshHostedEntitlement()
              .catch(() => runtimeNext.hosted)
          : runtimeNext.hosted;
      const runtimeWithHosted = { ...runtimeNext, hosted };
      setStatus(statusNext);
      setRuntime(runtimeWithHosted);
      setAdoptionPreview(previewNext);
      setConflicts(conflictsNext);
      if (runtimeNext.auth.state === 'signed-in') {
        try {
          setDevices(await window.anvil.syncRuntime.listDevices());
        } catch {
          // Device management is supplementary; retain the last successful list.
        }
      } else {
        setDevices([]);
      }
      if (statusNext.connectionMode !== 'local') setModeState(statusNext.connectionMode);
      setEndpointState((current) => {
        if (statusNext.baseUrl !== null) return statusNext.baseUrl;
        return statusNext.hostedBackendUrl !== null && current.trim() === ''
          ? statusNext.hostedBackendUrl
          : current;
      });
    } catch (err) {
      setError(toErrorMessage(err, 'Could not read Sync & Mesh status.'));
    } finally {
      setStatusLoading(false);
      setBusy((current) => (current === 'loading' ? null : current));
    }
  }, [preview]);

  const setMode = useCallback((next: SyncSetupMode): void => {
    setModeState(next);
    setDiscovery(null);
  }, []);

  const setEndpoint = useCallback((next: string): void => {
    setEndpointState(next);
    setDiscovery(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep connection and worker badges current without re-running the heavier
  // status/preview/entitlement/device load. This is deliberately visibility-
  // aware and best-effort: a stale badge is preferable to turning a transient
  // IPC failure into an onboarding error.
  const refreshRuntime = useCallback(async (): Promise<void> => {
    const sequence = ++runtimeRefreshSequence.current;
    try {
      const next = await window.anvil.syncRuntime.status();
      if (sequence !== runtimeRefreshSequence.current) return;
      setRuntime((current) =>
        current === null ? next : { ...next, hosted: current.hosted ?? next.hosted },
      );
    } catch {
      // Full refreshes and the next poll remain authoritative.
    }
  }, []);

  useEffect(() => {
    const shouldPoll =
      !preview &&
      busy === null &&
      runtime !== null &&
      (runtime.syncEnabled || runtime.auth.state === 'signed-in');
    if (!shouldPoll) return undefined;

    let active = true;
    let timer: number | null = null;
    const clearTimer = (): void => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    const poll = async (): Promise<void> => {
      if (!active || document.hidden) return;
      await refreshRuntime();
      if (active && !document.hidden) {
        timer = window.setTimeout(() => void poll(), RUNTIME_POLL_INTERVAL_MS);
      }
    };
    const onVisibilityChange = (): void => {
      clearTimer();
      if (!document.hidden) void poll();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    void poll();
    return () => {
      active = false;
      runtimeRefreshSequence.current += 1;
      clearTimer();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [busy, preview, refreshRuntime, runtime?.auth.state, runtime?.syncEnabled]);

  const handleDiscover = useCallback(async (): Promise<void> => {
    if (endpoint.trim() === '') return;
    setBusy('discovering');
    setError(null);
    setDiscovery(null);
    try {
      setDiscovery(await window.anvil.syncBackend.discover(endpoint.trim()));
    } catch (err) {
      setError(toErrorMessage(err, 'That backend could not be reached.'));
    } finally {
      setBusy(null);
    }
  }, [endpoint]);

  const handlePin = useCallback(async (): Promise<void> => {
    if (discovery === null) return;
    setBusy('pinning');
    setError(null);
    try {
      await window.anvil.syncBackend.pin({
        baseUrl: discovery.baseUrl,
        descriptor: discovery.descriptor,
        connectionMode: mode,
      });
      setDiscovery(null);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err, 'Could not save this backend.'));
    } finally {
      setBusy(null);
    }
  }, [discovery, mode, refresh]);

  const handleResolveIdentityReview = useCallback(async (): Promise<void> => {
    if (!status?.backendId) return;
    setBusy('reviewing');
    setError(null);
    try {
      await window.anvil.syncBackend.resolveReview(status.backendId);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err, 'Could not confirm this backend identity.'));
    } finally {
      setBusy(null);
    }
  }, [refresh, status?.backendId]);

  const handleSignIn = useCallback(async (): Promise<void> => {
    setBusy('signing-in');
    setError(null);
    try {
      await window.anvil.syncRuntime.signIn();
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err, 'Sign-in did not complete.'));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const handleEnrollWithCode = useCallback(async (): Promise<void> => {
    if (enrollmentCode.trim() === '') return;
    setBusy('enrolling');
    setError(null);
    try {
      await window.anvil.syncRuntime.enrollWithCode(enrollmentCode.trim());
      setEnrollmentCode('');
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err, 'That enrollment code could not be redeemed.'));
    } finally {
      setBusy(null);
    }
  }, [enrollmentCode, refresh]);

  const handleEnableSync = useCallback(async (): Promise<void> => {
    setBusy('enabling');
    setError(null);
    try {
      await window.anvil.syncRuntime.enable();
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err, 'Sync could not be enabled.'));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const handleMeshChange = useCallback(async (): Promise<void> => {
    if (runtime?.syncEnabled !== true) return;
    setBusy('mesh');
    setError(null);
    try {
      await window.anvil.syncRuntime.setMeshWorker(!runtime.meshWorker.enabled);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err, 'Mesh could not be updated.'));
    } finally {
      setBusy(null);
    }
  }, [refresh, runtime]);

  const refreshHostedEntitlement = useCallback(async (): Promise<void> => {
    try {
      const hosted = await window.anvil.syncRuntime.refreshHostedEntitlement();
      setRuntime((current) => (current === null ? current : { ...current, hosted }));
    } catch {
      // Focus refresh is best-effort; the next full refresh remains authoritative.
    }
  }, []);

  const backendPinned =
    status?.backendId !== null &&
    status?.backendId !== undefined &&
    status.state !== 'disconnected';
  const signedIn = runtime?.auth.state === 'signed-in';
  const authModes = status?.authModes ?? discovery?.descriptor.authModes ?? [];
  const canEnableSync =
    backendPinned === true &&
    signedIn &&
    status?.identityReviewRequired !== true &&
    runtime?.sessionExpired !== true;

  return {
    mode,
    setMode,
    endpoint,
    setEndpoint,
    enrollmentCode,
    setEnrollmentCode,
    status,
    statusLoading,
    runtime,
    adoptionPreview,
    conflicts,
    devices,
    discovery,
    busy,
    error,
    isBusy: busy !== null && busy !== 'loading',
    backendPinned,
    signedIn,
    authModes,
    canEnableSync,
    refresh,
    handleDiscover,
    handlePin,
    handleResolveIdentityReview,
    handleSignIn,
    handleEnrollWithCode,
    handleEnableSync,
    handleMeshChange,
    refreshHostedEntitlement,
  };
}
