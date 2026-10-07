import { useCallback, useEffect, useRef, useState } from 'react';
import { useCredentialStorage, type CredentialStorageController } from './useCredentialStorage';
import { presentSetupError } from '../utils/setup-error';
import type { SyncDeviceSecurityStatus } from '../../shared/sync-device-security';
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
  | 'cancelling'
  | 'enrolling'
  | 'enabling'
  | 'mesh'
  | null;

const RUNTIME_POLL_INTERVAL_MS = 5_000;
const SECURITY_REFRESH_INTERVAL_MS = 60_000;

export interface SyncMeshSetupController {
  credentialStorage: CredentialStorageController;
  mode: SyncSetupMode;
  setMode: (mode: SyncSetupMode) => void;
  endpoint: string;
  setEndpoint: (endpoint: string) => void;
  enrollmentCode: string;
  setEnrollmentCode: (code: string) => void;
  status: SyncBackendStatus | null;
  statusLoading: boolean;
  runtime: SyncRuntimeStatus | null;
  security: SyncDeviceSecurityStatus | null;
  recoveryCodePending: boolean;
  setRecoveryCodePending: (pending: boolean) => void;
  adoptionPreview: SyncAdoptionPreviewItem[];
  adoptionPreviewAvailable: boolean;
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
  handleConnectHosted: () => Promise<void>;
  handleCancelSignIn: () => Promise<void>;
  handleEnrollWithCode: () => Promise<void>;
  handleEnableSync: () => Promise<void>;
  handleMeshChange: () => Promise<void>;
  refreshHostedEntitlement: () => Promise<void>;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return presentSetupError(error, fallback);
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
  const credentialStorage = useCredentialStorage({ preview });
  const refreshCredentialStorage = credentialStorage.refresh;
  const [mode, setModeState] = useState<SyncSetupMode>(initialMode);
  const [endpoint, setEndpointState] = useState('');
  const [enrollmentCode, setEnrollmentCode] = useState('');
  const [status, setStatus] = useState<SyncBackendStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(!preview);
  const [runtime, setRuntime] = useState<SyncRuntimeStatus | null>(null);
  const [security, setSecurity] = useState<SyncDeviceSecurityStatus | null>(null);
  const [recoveryCodePending, setRecoveryCodePending] = useState(false);
  const [adoptionPreview, setAdoptionPreview] = useState<SyncAdoptionPreviewItem[]>([]);
  const [adoptionPreviewAvailable, setAdoptionPreviewAvailable] = useState(false);
  const [conflicts, setConflicts] = useState<SyncConflictView[]>([]);
  const [devices, setDevices] = useState<SyncDevice[]>([]);
  const [discovery, setDiscovery] = useState<SyncBackendDiscovery | null>(null);
  const [busy, setBusy] = useState<SyncSetupBusy>(null);
  const [error, setError] = useState<string | null>(null);
  const runtimeRefreshSequence = useRef(0);
  const fullRefreshSequence = useRef(0);
  const securityReady = useRef(false);
  const lastSecurityRefresh = useRef(0);
  const signInSequence = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    if (preview) return;
    const sequence = ++fullRefreshSequence.current;
    runtimeRefreshSequence.current += 1;
    setStatusLoading(true);
    setError(null);
    setBusy((current) => (current === null ? 'loading' : current));
    try {
      const [statusNext, runtimeNext, previewNext, conflictsNext] = await Promise.all([
        window.anvil.syncBackend.status(),
        window.anvil.syncRuntime.status(),
        window.anvil.syncRuntime.preview().catch(() => null),
        window.anvil.syncRuntime.conflicts().catch(() => []),
        refreshCredentialStorage(),
      ]);
      const hosted =
        runtimeNext.auth.state === 'signed-in'
          ? await window.anvil.syncRuntime
              .refreshHostedEntitlement()
              .catch(() => runtimeNext.hosted)
          : runtimeNext.hosted;
      const runtimeWithHosted = { ...runtimeNext, hosted };
      if (sequence !== fullRefreshSequence.current) return;
      setStatus(statusNext);
      setRuntime(runtimeWithHosted);
      setSecurity(null);
      setAdoptionPreview(previewNext ?? []);
      setAdoptionPreviewAvailable(previewNext !== null);
      setConflicts(conflictsNext);
      if (runtimeNext.auth.state === 'signed-in') {
        const [devicesNext, securityNext] = await Promise.all([
          window.anvil.syncRuntime.listDevices().catch(() => []),
          window.anvil.syncRuntime.getDeviceSecurityStatus().catch(() => null),
        ]);
        if (sequence !== fullRefreshSequence.current) return;
        setDevices(devicesNext);
        setSecurity(securityNext);
        securityReady.current = securityNext?.hasAccountKey === true;
        lastSecurityRefresh.current = Date.now();
      } else {
        setDevices([]);
        securityReady.current = false;
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
      if (sequence === fullRefreshSequence.current) {
        setStatusLoading(false);
        setBusy((current) => (current === 'loading' ? null : current));
      }
    }
  }, [preview, refreshCredentialStorage]);

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
      const readSecurity =
        !securityReady.current ||
        Date.now() - lastSecurityRefresh.current >= SECURITY_REFRESH_INTERVAL_MS;
      const [next, securityNext] = await Promise.all([
        window.anvil.syncRuntime.status(),
        readSecurity
          ? window.anvil.syncRuntime.getDeviceSecurityStatus().catch(() => null)
          : Promise.resolve(undefined),
      ]);
      if (sequence !== runtimeRefreshSequence.current) return;
      setRuntime((current) =>
        current === null ? next : { ...next, hosted: current.hosted ?? next.hosted },
      );
      if (next.auth.state !== 'signed-in') {
        setSecurity(null);
        securityReady.current = false;
      } else if (securityNext !== undefined) {
        const sameAccount = securityNext?.accountId === next.auth.accountId;
        setSecurity(sameAccount ? securityNext : null);
        securityReady.current = sameAccount && securityNext?.hasAccountKey === true;
        lastSecurityRefresh.current = Date.now();
      }
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
    const attempt = ++signInSequence.current;
    setBusy('signing-in');
    setError(null);
    try {
      await window.anvil.syncRuntime.signIn();
      if (attempt !== signInSequence.current) return;
      await refresh();
    } catch (err) {
      if (attempt !== signInSequence.current) return;
      await refreshCredentialStorage();
      setError(toErrorMessage(err, 'Sign-in did not complete.'));
    } finally {
      if (attempt === signInSequence.current) setBusy(null);
    }
  }, [refresh, refreshCredentialStorage]);

  const handleConnectHosted = useCallback(async (): Promise<void> => {
    if (preview) return;
    const attempt = ++signInSequence.current;
    setBusy('signing-in');
    setError(null);
    try {
      await window.anvil.syncRuntime.connectHosted();
      if (attempt !== signInSequence.current) return;
      await refresh();
    } catch (err) {
      if (attempt !== signInSequence.current) return;
      setError(toErrorMessage(err, 'Sign-in did not complete. Try again.'));
      // A changed service identity must be visible even when sign-in stops.
      await refresh().catch(() => undefined);
      if (attempt !== signInSequence.current) return;
      setError(toErrorMessage(err, 'Sign-in did not complete. Try again.'));
    } finally {
      if (attempt === signInSequence.current) setBusy(null);
    }
  }, [preview, refresh]);

  const handleCancelSignIn = useCallback(async (): Promise<void> => {
    signInSequence.current += 1;
    setBusy('cancelling');
    setError(null);
    try {
      await window.anvil.syncRuntime.cancelSignIn();
      await refresh();
    } catch (failure) {
      setError(toErrorMessage(failure, 'Could not cancel sign-in. Try again.'));
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
    credentialStorage.isReady &&
    backendPinned === true &&
    signedIn &&
    adoptionPreviewAvailable &&
    status?.identityReviewRequired !== true &&
    runtime?.sessionExpired !== true;

  return {
    credentialStorage,
    mode,
    setMode,
    endpoint,
    setEndpoint,
    enrollmentCode,
    setEnrollmentCode,
    status,
    statusLoading,
    runtime,
    security,
    recoveryCodePending,
    setRecoveryCodePending,
    adoptionPreview,
    adoptionPreviewAvailable,
    conflicts,
    devices,
    discovery,
    busy,
    error,
    isBusy: credentialStorage.busy || (busy !== null && busy !== 'loading'),
    backendPinned,
    signedIn,
    authModes,
    canEnableSync,
    refresh,
    handleDiscover,
    handlePin,
    handleResolveIdentityReview,
    handleSignIn,
    handleConnectHosted,
    handleCancelSignIn,
    handleEnrollWithCode,
    handleEnableSync,
    handleMeshChange,
    refreshHostedEntitlement,
  };
}
