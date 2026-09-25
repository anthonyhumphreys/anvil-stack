import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Cloud,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import type {
  CloudEnvironmentProviderConnection,
  CloudEnvironmentRecord,
  EnvironmentProviderId,
  LocalCloudEnvironment,
  SyncRuntimeStatus,
} from '../../../shared/sync-runtime';
import { ConfirmDialog } from '../ui';

const PROVIDERS: Array<{
  id: EnvironmentProviderId;
  label: string;
  detail: string;
  requiresConnection: boolean;
}> = [
  {
    id: 'anvil-managed',
    label: 'Anvil managed',
    detail: 'Anvil runs the worker for you when hosted environments are available on your account.',
    requiresConnection: false,
  },
  {
    id: 'aws-lambda-microvm',
    label: 'AWS Lambda MicroVM',
    detail: 'Use an AWS account and an Anvil worker image.',
    requiresConnection: true,
  },
  {
    id: 'cloudflare-sandbox',
    label: 'Cloudflare Sandbox',
    detail: 'Point Anvil at your deployed provisioner Worker.',
    requiresConnection: true,
  },
  {
    id: 'vercel-sandbox',
    label: 'Vercel Sandbox',
    detail: 'Use a Vercel Sandbox image and project.',
    requiresConnection: true,
  },
];

type ConnectionDraft = {
  provider: EnvironmentProviderId;
  displayName: string;
  region: string;
  image: string;
  imageIdentifier: string;
  url: string;
  teamId: string;
  projectId: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  token: string;
};

type PendingEnvironmentRequest = {
  environmentId: string;
  requestKey: string;
  provider: EnvironmentProviderId;
  jobId: string | null;
  jobState: string | null;
  phase: 'submitting' | 'queued' | 'starting' | 'ready' | 'failed' | 'unknown' | 'timed-out';
  environmentState: CloudEnvironmentRecord['state'] | null;
  error: string | null;
};

const EMPTY_DRAFT: ConnectionDraft = {
  provider: 'aws-lambda-microvm',
  displayName: '',
  region: 'us-east-1',
  image: '',
  imageIdentifier: '',
  url: '',
  teamId: '',
  projectId: '',
  accessKeyId: '',
  secretAccessKey: '',
  sessionToken: '',
  token: '',
};

const fieldClass =
  'w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none';

function providerMeta(provider: EnvironmentProviderId) {
  return PROVIDERS.find((item) => item.id === provider) ?? PROVIDERS[0];
}

function providerLabel(provider: EnvironmentProviderId): string {
  return providerMeta(provider).label;
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 12)}…${value.slice(-4)}` : value;
}

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function stateLabel(state: string): string {
  return state.replaceAll('-', ' ');
}

function stateClass(state: string): string {
  if (state === 'running' || state === 'enrolled') return 'bg-success/15 text-success';
  if (state === 'failed' || state === 'expired') return 'bg-error/15 text-error';
  if (state === 'terminating' || state === 'reap-requested') return 'bg-warning/15 text-warning';
  return 'bg-bg-tertiary text-text-secondary';
}

function connectionHasActiveEnvironment(
  connectionId: string,
  environments: LocalCloudEnvironment[],
): boolean {
  return environments.some(
    (environment) =>
      environment.connectionId === connectionId &&
      environment.state !== 'terminated' &&
      (environment.state !== 'failed' || environment.handle !== null),
  );
}

function buildConnectionPayload(draft: ConnectionDraft): {
  config: Record<string, unknown>;
  secret?: string;
} {
  const config: Record<string, unknown> = {};
  const secret: Record<string, string> = {};
  const putConfig = (key: string, value: string): void => {
    if (value.trim()) config[key] = value.trim();
  };
  const putSecret = (key: string, value: string): void => {
    if (value.trim()) secret[key] = value.trim();
  };

  if (draft.provider === 'aws-lambda-microvm') {
    putConfig('region', draft.region);
    putConfig('imageIdentifier', draft.imageIdentifier);
    putSecret('accessKeyId', draft.accessKeyId);
    putSecret('secretAccessKey', draft.secretAccessKey);
    putSecret('sessionToken', draft.sessionToken);
  } else if (draft.provider === 'cloudflare-sandbox') {
    putConfig('url', draft.url);
    putSecret('token', draft.token);
  } else if (draft.provider === 'vercel-sandbox') {
    putConfig('image', draft.image);
    putConfig('region', draft.region);
    putConfig('teamId', draft.teamId);
    putConfig('projectId', draft.projectId);
    putSecret('token', draft.token);
  }

  return {
    config,
    ...(Object.keys(secret).length ? { secret: JSON.stringify(secret) } : {}),
  };
}

function ConnectionField({
  label,
  name,
  value,
  onChange,
  type = 'text',
  placeholder,
  required = false,
}: {
  label: string;
  name?: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password';
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="block text-xs font-medium text-text-secondary">
      {label}
      {required && <span className="ml-1 text-warning">Required</span>}
      <input
        name={name ?? label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}
        className={`${fieldClass} mt-1`}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        required={required}
      />
    </label>
  );
}

function EnvironmentRow({
  environment,
  busy,
  onReap,
}: {
  environment: CloudEnvironmentRecord;
  busy: boolean;
  onReap: (environmentId: string) => void;
}) {
  const terminal = environment.state === 'terminated';
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-border py-3 last:border-b-0">
      <Cloud aria-hidden="true" size={16} className="shrink-0 text-text-tertiary" />
      <div className="min-w-0 flex-1">
        <p
          className="truncate font-mono text-sm text-text-primary"
          title={environment.environmentId}
        >
          {shortId(environment.environmentId)}
        </p>
        <p className="mt-0.5 text-xs text-text-tertiary">
          {providerLabel(environment.provider)}
          {formatDate(environment.expiresAt)
            ? ` · expires ${formatDate(environment.expiresAt)}`
            : ''}
        </p>
      </div>
      <span
        className={`rounded px-2 py-1 text-xs font-medium capitalize ${stateClass(environment.state)}`}
      >
        {stateLabel(environment.state)}
      </span>
      {!terminal &&
        environment.state !== 'terminating' &&
        environment.state !== 'reap-requested' && (
          <button
            type="button"
            onClick={() => onReap(environment.environmentId)}
            disabled={busy}
            className="rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
          >
            {busy ? 'Stopping…' : 'Stop'}
          </button>
        )}
    </li>
  );
}

export function CloudEnvironmentsPanel({
  compact = false,
  onError,
}: {
  /** Use the tighter layout when this panel is embedded in onboarding. */
  compact?: boolean;
  onError?: (message: string | null) => void;
}) {
  const [runtime, setRuntime] = useState<SyncRuntimeStatus | null>(null);
  const [connections, setConnections] = useState<CloudEnvironmentProviderConnection[]>([]);
  const [environments, setEnvironments] = useState<CloudEnvironmentRecord[]>([]);
  const [localEnvironments, setLocalEnvironments] = useState<LocalCloudEnvironment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showConnectionForm, setShowConnectionForm] = useState(false);
  const [draft, setDraft] = useState<ConnectionDraft>(EMPTY_DRAFT);
  const [savingConnection, setSavingConnection] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [reapingId, setReapingId] = useState<string | null>(null);
  const [requestProvider, setRequestProvider] = useState<EnvironmentProviderId>('anvil-managed');
  const [requestTtl, setRequestTtl] = useState('1800');
  const [requestConnectionId, setRequestConnectionId] = useState('');
  const [pendingRequest, setPendingRequest] = useState<PendingEnvironmentRequest | null>(null);
  const [connectionPendingRemoval, setConnectionPendingRemoval] =
    useState<CloudEnvironmentProviderConnection | null>(null);
  const [pollGeneration, setPollGeneration] = useState(0);
  const requestEnvironmentIdRef = useRef<string | null>(null);
  const requestJobIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reportError = useCallback(
    (next: unknown): void => {
      const message = next instanceof Error ? next.message : String(next);
      setError(message);
      onError?.(message);
    },
    [onError],
  );

  const refresh = useCallback(
    async (initial = false): Promise<void> => {
      if (initial) setLoading(true);
      else setRefreshing(true);
      try {
        const nextRuntime = await window.anvil.syncRuntime.status();
        setRuntime(nextRuntime);
        if (nextRuntime.auth.state !== 'signed-in') {
          setConnections([]);
          setEnvironments([]);
          setLocalEnvironments([]);
          return;
        }
        const [connectionsResult, environmentsResult, localResult] = await Promise.allSettled([
          window.anvil.syncRuntime.listCloudProviderConnections(),
          window.anvil.syncRuntime.listCloudEnvironments(false),
          window.anvil.syncRuntime.listLocalCloudEnvironments(),
        ]);
        if (connectionsResult.status === 'fulfilled') setConnections(connectionsResult.value);
        if (environmentsResult.status === 'fulfilled') {
          setEnvironments(environmentsResult.value.environments);
        }
        if (localResult.status === 'fulfilled') setLocalEnvironments(localResult.value);
        const rejected = [connectionsResult, environmentsResult, localResult].find(
          (result) => result.status === 'rejected',
        );
        if (rejected?.status === 'rejected') {
          reportError(rejected.reason);
        } else {
          setError(null);
          onError?.(null);
        }
      } catch (next) {
        reportError(next);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [onError, reportError],
  );

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  // A request creates a durable backend job before its environment is
  // visible in the list. Keep the returned id in view and poll that one row
  // so “Start” never leaves the user guessing whether anything happened.
  const pendingEnvironmentId = pendingRequest?.environmentId;
  useEffect(() => {
    if (!pendingEnvironmentId || runtime?.auth.state !== 'signed-in') return;
    const requestId = pendingEnvironmentId;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const poll = async (): Promise<void> => {
      const [environmentResult, jobResult] = await Promise.allSettled([
        window.anvil.syncRuntime.listCloudEnvironments(true),
        requestJobIdRef.current
          ? window.anvil.syncRuntime
              .getMeshJob(requestJobIdRef.current)
              .then((result) => result.job)
          : window.anvil.syncRuntime
              .listMeshJobs()
              .then((jobs) => jobs.find((job) => job.requestId === `env-${requestId}`)),
      ]);
      if (cancelled) return;

      let stopPolling = false;
      let preserveRequestId = false;
      if (environmentResult.status === 'fulfilled') {
        const found = environmentResult.value.environments.find(
          (environment) => environment.environmentId === requestId,
        );
        if (found) {
          setEnvironments((current) => {
            const next = current.filter(
              (environment) => environment.environmentId !== found.environmentId,
            );
            return found.state === 'terminated' ? next : [...next, found];
          });
          const needsInspection =
            (found.state === 'failed' || found.state === 'expired') && found.handle !== undefined;
          const isFailed =
            found.state === 'failed' || found.state === 'expired' || found.state === 'terminated';
          const isReady = found.state === 'enrolled' || found.state === 'running';
          preserveRequestId = needsInspection;
          setPendingRequest((current) =>
            current?.environmentId !== requestId
              ? current
              : {
                  ...current,
                  phase: needsInspection
                    ? 'unknown'
                    : isFailed
                      ? 'failed'
                      : isReady
                        ? 'ready'
                        : 'starting',
                  environmentState: found.state,
                  error: needsInspection
                    ? 'The provider reported failure while retaining a handle. Inspect or stop this environment before creating another.'
                    : isFailed
                      ? 'The provider reported that this environment failed.'
                      : null,
                },
          );
          if (isFailed || isReady || found.state === 'terminated') {
            stopPolling = true;
          }
        }
      }

      if (jobResult.status === 'fulfilled' && jobResult.value !== undefined) {
        const job = jobResult.value;
        const jobUnknown = job.state === 'unknown-outcome';
        const jobFailed = job.state === 'failed' || job.state === 'cancelled' || jobUnknown;
        const jobNeedsInspection = jobUnknown || preserveRequestId;
        setPendingRequest((current) =>
          current?.environmentId !== requestId
            ? current
            : {
                ...current,
                jobId: job.id,
                jobState: job.state,
                ...(jobFailed
                  ? {
                      phase: jobNeedsInspection ? ('unknown' as const) : ('failed' as const),
                      error: jobNeedsInspection
                        ? 'The provisioning job has an unknown outcome. Inspect the existing job or environment before creating another.'
                        : `The provisioning job ${stateLabel(job.state)} before the worker enrolled.`,
                    }
                  : {}),
              },
        );
        requestJobIdRef.current = job.id;
        if (jobFailed) {
          stopPolling = true;
          preserveRequestId = jobNeedsInspection;
        }
      }

      if (stopPolling) {
        if (!preserveRequestId) requestEnvironmentIdRef.current = null;
        requestJobIdRef.current = null;
        return;
      }
      if (Date.now() - startedAt >= 120_000) {
        setPendingRequest((current) =>
          current?.environmentId !== requestId
            ? current
            : {
                ...current,
                phase: 'timed-out',
                error:
                  'The request is still queued. Refresh or retry when the provider is available.',
              },
        );
        return;
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 1_500);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [pendingEnvironmentId, pollGeneration, runtime?.auth.state]);

  const matchingConnections = useMemo(
    () => connections.filter((connection) => connection.provider === requestProvider),
    [connections, requestProvider],
  );
  const saveConnection = async (): Promise<void> => {
    const provider = providerMeta(draft.provider);
    if (!provider.requiresConnection) return;
    const payload = buildConnectionPayload(draft);
    if (!draft.displayName.trim()) {
      reportError('Give this provider connection a name so you can recognize it later.');
      return;
    }
    if (draft.provider === 'aws-lambda-microvm' && !draft.imageIdentifier.trim()) {
      reportError('AWS needs a worker image identifier.');
      return;
    }
    if (draft.provider === 'cloudflare-sandbox' && !draft.url.trim()) {
      reportError('Cloudflare needs the URL of your deployed provisioner Worker.');
      return;
    }
    if (draft.provider === 'vercel-sandbox' && (!draft.image.trim() || !draft.token.trim())) {
      reportError('Vercel needs an image reference and access token.');
      return;
    }
    setSavingConnection(true);
    setError(null);
    try {
      await window.anvil.syncRuntime.addCloudProviderConnection({
        provider: draft.provider,
        displayName: draft.displayName.trim(),
        config: payload.config,
        ...(payload.secret === undefined ? {} : { secret: payload.secret }),
      });
      setDraft(EMPTY_DRAFT);
      setShowConnectionForm(false);
      await refresh();
    } catch (next) {
      reportError(next);
    } finally {
      setSavingConnection(false);
    }
  };

  const requestEnvironment = async (): Promise<void> => {
    const ttlSeconds = Number(requestTtl);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 60) {
      reportError('Choose an environment lifetime of at least 1 minute.');
      return;
    }
    if (providerMeta(requestProvider).requiresConnection && !requestConnectionId) {
      reportError('Choose the provider connection that should create this environment.');
      return;
    }
    const currentPhase = pendingRequest?.phase;
    if (currentPhase === 'submitting' || currentPhase === 'queued' || currentPhase === 'starting') {
      return;
    }
    const requestKey = JSON.stringify({
      provider: requestProvider,
      ttlSeconds,
      connectionId: requestConnectionId,
    });
    const environmentId =
      pendingRequest?.requestKey === requestKey
        ? (requestEnvironmentIdRef.current ??
          `env_${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`)
        : `env_${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
    if (pendingRequest?.requestKey !== requestKey) {
      setPendingRequest(null);
    }
    requestEnvironmentIdRef.current = environmentId;
    requestJobIdRef.current = null;
    setPollGeneration((current) => current + 1);
    setPendingRequest({
      environmentId,
      requestKey,
      provider: requestProvider,
      jobId: null,
      jobState: null,
      phase: 'submitting',
      environmentState: null,
      error: null,
    });
    setRequesting(true);
    setError(null);
    try {
      const result = await window.anvil.syncRuntime.requestCloudEnvironment({
        provider: requestProvider,
        ttlSeconds,
        environmentId,
        ...(requestConnectionId ? { connectionId: requestConnectionId } : {}),
      });
      requestJobIdRef.current = result.job.id;
      setPendingRequest((current) =>
        current?.environmentId !== environmentId
          ? current
          : {
              ...current,
              phase: 'queued',
              jobId: result.job.id,
              jobState: result.job.state,
            },
      );
      await refresh();
    } catch (next) {
      const message = next instanceof Error ? next.message : String(next);
      setPendingRequest((current) =>
        current?.environmentId !== environmentId
          ? current
          : { ...current, phase: 'unknown', error: message },
      );
      reportError(`${message} Retry is safe; this request keeps ${shortId(environmentId)}.`);
    } finally {
      setRequesting(false);
    }
  };

  const reapEnvironment = async (environmentId: string): Promise<void> => {
    setReapingId(environmentId);
    setError(null);
    try {
      await window.anvil.syncRuntime.reapCloudEnvironment(environmentId);
      await refresh();
    } catch (next) {
      reportError(next);
    } finally {
      setReapingId(null);
    }
  };

  const removeConnection = (connection: CloudEnvironmentProviderConnection): void => {
    const inUse = connectionHasActiveEnvironment(connection.id, localEnvironments);
    if (inUse) {
      reportError('Stop this connection’s active environments before removing its credentials.');
      return;
    }
    setConnectionPendingRemoval(connection);
  };

  const confirmRemoveConnection = async (): Promise<void> => {
    const connection = connectionPendingRemoval;
    setConnectionPendingRemoval(null);
    if (!connection) return;
    try {
      await window.anvil.syncRuntime.removeCloudProviderConnection(connection.id);
      await refresh();
    } catch (next) {
      reportError(next);
    }
  };

  const updateDraft = (patch: Partial<ConnectionDraft>): void =>
    setDraft((current) => ({ ...current, ...patch }));

  if (loading) {
    return (
      <section className="space-y-3 rounded-lg border border-border bg-bg-secondary p-5">
        <p className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2
            aria-hidden="true"
            size={15}
            className="animate-spin motion-reduce:animate-none"
          />
          Loading cloud environments…
        </p>
      </section>
    );
  }

  const signedIn = runtime?.auth.state === 'signed-in';
  const remoteEnvironments = environments.filter(
    (environment) => environment.state !== 'terminated',
  );
  const localOnlyCount = localEnvironments.filter(
    (local) =>
      !remoteEnvironments.some((environment) => environment.environmentId === local.environmentId),
  ).length;

  return (
    <section
      className={`space-y-5 rounded-lg border border-border bg-bg-secondary ${compact ? 'p-4' : 'p-5'}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-base font-semibold text-text-primary">Cloud environments</h4>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
            Start a temporary worker for jobs that should run away from this computer. Use
            Anvil-hosted capacity or a provider connection on this device.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
        >
          <RefreshCw
            aria-hidden="true"
            size={13}
            className={refreshing ? 'animate-spin motion-reduce:animate-none' : ''}
          />
          Refresh
        </button>
      </div>

      {!signedIn ? (
        <div className="rounded-md border border-warning/30 bg-warning/5 p-3">
          <p className="flex items-start gap-2 text-sm text-text-secondary">
            <ShieldCheck aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-warning" />
            Sign in to Sync before you create or manage cloud environments. Provider credentials
            stay on this device and are not synced.
          </p>
        </div>
      ) : (
        <>
          <div
            className={`grid gap-4 ${compact ? '' : 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'}`}
          >
            <div
              className={`pb-5 ${compact ? 'border-b border-border' : 'border-b border-border lg:border-b-0 lg:border-r lg:pb-0 lg:pr-6'}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-text-primary">Create an environment</p>
                  <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                    Start it here, then choose it as a workflow target when its worker is ready.
                  </p>
                </div>
                <Server aria-hidden="true" size={17} className="shrink-0 text-accent" />
              </div>
              <div className="mt-4 space-y-3">
                <label className="block text-xs font-medium text-text-secondary">
                  Provider
                  <select
                    name="environment-provider"
                    className={`${fieldClass} mt-1`}
                    value={requestProvider}
                    required
                    onChange={(event) => {
                      const next = event.target.value as EnvironmentProviderId;
                      setRequestProvider(next);
                      setRequestConnectionId('');
                    }}
                  >
                    {PROVIDERS.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block font-normal text-text-tertiary">
                    {providerMeta(requestProvider).detail}
                  </span>
                </label>
                {providerMeta(requestProvider).requiresConnection && (
                  <>
                    <label className="block text-xs font-medium text-text-secondary">
                      Provider connection
                      <select
                        name="environment-connection"
                        className={`${fieldClass} mt-1`}
                        value={requestConnectionId}
                        required
                        onChange={(event) => setRequestConnectionId(event.target.value)}
                      >
                        <option value="">Choose a saved connection</option>
                        {matchingConnections.map((connection) => (
                          <option key={connection.id} value={connection.id}>
                            {connection.displayName ?? providerLabel(connection.provider)}
                          </option>
                        ))}
                      </select>
                      {!matchingConnections.length && (
                        <span className="mt-1 block font-normal text-warning">
                          Save a {providerLabel(requestProvider)} connection below first.
                        </span>
                      )}
                    </label>
                    {runtime && !runtime.meshWorker.enabled && (
                      <p className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs leading-relaxed text-warning">
                        BYO provider requests use this device&apos;s Mesh worker and its local
                        credentials. Enable Mesh jobs for this device before starting one.
                      </p>
                    )}
                    {runtime?.meshWorker.enabled && !runtime.meshWorker.connected && (
                      <p className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs leading-relaxed text-warning">
                        Mesh is enabled but this device is offline. A BYO request will stay queued
                        until the worker reconnects.
                      </p>
                    )}
                  </>
                )}
                <div
                  className={`grid gap-3 ${compact ? '' : 'sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'}`}
                >
                  <label className="block text-xs font-medium text-text-secondary">
                    Lifetime
                    <select
                      name="environment-lifetime"
                      className={`${fieldClass} mt-1`}
                      value={requestTtl}
                      required
                      onChange={(event) => setRequestTtl(event.target.value)}
                    >
                      <option value="1800">30 minutes</option>
                      <option value="3600">1 hour</option>
                      <option value="14400">4 hours</option>
                      <option value="28800">8 hours</option>
                    </select>
                  </label>
                  <p className="self-end pb-2 text-xs leading-relaxed text-text-tertiary">
                    The environment ID and provider state stay visible below while it starts.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void requestEnvironment()}
                  disabled={
                    requesting ||
                    pendingRequest?.phase === 'submitting' ||
                    pendingRequest?.phase === 'queued' ||
                    pendingRequest?.phase === 'starting' ||
                    (providerMeta(requestProvider).requiresConnection &&
                      (!matchingConnections.length || !runtime?.meshWorker.enabled))
                  }
                  className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground hover:bg-accent/90 disabled:opacity-50"
                >
                  {requesting && (
                    <Loader2
                      aria-hidden="true"
                      size={14}
                      className="animate-spin motion-reduce:animate-none"
                    />
                  )}
                  {requesting
                    ? 'Starting…'
                    : pendingRequest?.phase === 'unknown' || pendingRequest?.phase === 'timed-out'
                      ? 'Retry request'
                      : 'Start environment'}
                </button>
                {pendingRequest && (
                  <div
                    className="rounded-md border border-accent/30 bg-accent/5 p-3 text-xs text-text-secondary"
                    role="status"
                    aria-live="polite"
                  >
                    <div className="flex items-start gap-2">
                      {(pendingRequest.phase === 'submitting' ||
                        pendingRequest.phase === 'queued' ||
                        pendingRequest.phase === 'starting') && (
                        <Loader2
                          aria-hidden="true"
                          size={14}
                          className="mt-0.5 shrink-0 animate-spin text-accent motion-reduce:animate-none"
                        />
                      )}
                      <div className="min-w-0">
                        <p className="font-medium text-text-primary">
                          {pendingRequest.phase === 'ready'
                            ? 'Environment ready for workflow jobs.'
                            : pendingRequest.phase === 'failed'
                              ? 'Environment provisioning failed.'
                              : pendingRequest.phase === 'timed-out'
                                ? 'Environment is still queued.'
                                : pendingRequest.phase === 'unknown'
                                  ? 'We are still checking this environment request.'
                                  : 'Starting environment…'}
                        </p>
                        <p className="mt-1">
                          {pendingRequest.phase === 'ready'
                            ? 'Select it as a workflow target when you configure a run.'
                            : pendingRequest.phase === 'failed'
                              ? (pendingRequest.error ?? 'Check the provider connection and retry.')
                              : pendingRequest.phase === 'timed-out'
                                ? pendingRequest.error
                                : pendingRequest.phase === 'unknown'
                                  ? `${pendingRequest.error ?? 'The request may still be processing.'} Retrying reuses this request.`
                                  : 'We’ll keep checking until the worker is ready.'}
                        </p>
                        <p className="mt-1 font-mono text-xs text-text-tertiary">
                          {shortId(pendingRequest.environmentId)}
                          {pendingRequest.jobId ? ` · job ${shortId(pendingRequest.jobId)}` : ''}
                          {pendingRequest.environmentState
                            ? ` · ${stateLabel(pendingRequest.environmentState)}`
                            : pendingRequest.jobState
                              ? ` · ${stateLabel(pendingRequest.jobState)}`
                              : ''}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="pt-1">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-text-primary">
                    Saved provider connections
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                    Credentials stay encrypted on this device and are used only to start its
                    environments.
                  </p>
                </div>
                <KeyRound aria-hidden="true" size={17} className="shrink-0 text-accent" />
              </div>
              {connections.length ? (
                <ul className="mt-3 divide-y divide-border">
                  {connections.map((connection) => (
                    <li
                      key={connection.id}
                      className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-text-primary">
                          {connection.displayName ?? providerLabel(connection.provider)}
                        </p>
                        <p className="mt-0.5 text-xs text-text-tertiary">
                          {providerLabel(connection.provider)} ·{' '}
                          {connection.hasSecret ? 'credentials saved' : 'no credentials saved'}
                        </p>
                      </div>
                      <button
                        type="button"
                        title="Remove connection"
                        aria-label={`Remove ${connection.displayName ?? providerLabel(connection.provider)} connection`}
                        disabled={connectionHasActiveEnvironment(connection.id, localEnvironments)}
                        onClick={() => void removeConnection(connection)}
                        className="rounded p-1.5 text-text-tertiary hover:bg-error/10 hover:text-error disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Trash2 aria-hidden="true" size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-text-tertiary">
                  No provider connections saved on this device.
                </p>
              )}
              <button
                type="button"
                onClick={() => setShowConnectionForm((open) => !open)}
                className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent/80"
              >
                {showConnectionForm ? (
                  <X aria-hidden="true" size={14} />
                ) : (
                  <Plus aria-hidden="true" size={14} />
                )}
                {showConnectionForm ? 'Close connection form' : 'Add provider connection'}
              </button>
            </div>
          </div>

          {showConnectionForm && (
            <div className="border-t border-border pt-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-text-primary">
                    Add a provider connection
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                    Credentials stay on this device and are not synced to other devices.
                  </p>
                </div>
              </div>
              <div className={`mt-4 grid gap-3 ${compact ? '' : 'sm:grid-cols-2'}`}>
                <label className="block text-xs font-medium text-text-secondary sm:col-span-2">
                  Provider
                  <select
                    className={`${fieldClass} mt-1`}
                    value={draft.provider}
                    required
                    onChange={(event) => {
                      const provider = event.target.value as EnvironmentProviderId;
                      updateDraft({
                        provider,
                        region: provider === 'aws-lambda-microvm' ? 'us-east-1' : '',
                      });
                    }}
                  >
                    {PROVIDERS.filter((provider) => provider.requiresConnection).map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </label>
                <ConnectionField
                  label="Connection name"
                  value={draft.displayName}
                  onChange={(value) => updateDraft({ displayName: value })}
                  placeholder="Production AWS"
                  required
                />
                {draft.provider === 'aws-lambda-microvm' && (
                  <>
                    <ConnectionField
                      label="Region"
                      value={draft.region}
                      onChange={(value) => updateDraft({ region: value })}
                      placeholder="us-east-1"
                      required
                    />
                    <ConnectionField
                      label="Worker image identifier"
                      value={draft.imageIdentifier}
                      onChange={(value) => updateDraft({ imageIdentifier: value })}
                      placeholder="arn:aws:lambda:…"
                      required
                    />
                    <ConnectionField
                      label="AWS access key ID"
                      value={draft.accessKeyId}
                      onChange={(value) => updateDraft({ accessKeyId: value })}
                    />
                    <ConnectionField
                      label="AWS secret access key"
                      value={draft.secretAccessKey}
                      onChange={(value) => updateDraft({ secretAccessKey: value })}
                      type="password"
                    />
                    <ConnectionField
                      label="Session token"
                      value={draft.sessionToken}
                      onChange={(value) => updateDraft({ sessionToken: value })}
                      type="password"
                    />
                    <p className="text-xs text-text-tertiary sm:col-span-2">
                      Leave the AWS fields empty to use credentials already available to this
                      device.
                    </p>
                  </>
                )}
                {draft.provider === 'cloudflare-sandbox' && (
                  <>
                    <ConnectionField
                      label="Provisioner Worker URL"
                      value={draft.url}
                      onChange={(value) => updateDraft({ url: value })}
                      placeholder="https://…workers.dev"
                      required
                    />
                    <ConnectionField
                      label="Provisioner token"
                      value={draft.token}
                      onChange={(value) => updateDraft({ token: value })}
                      type="password"
                    />
                  </>
                )}
                {draft.provider === 'vercel-sandbox' && (
                  <>
                    <ConnectionField
                      label="Worker image"
                      value={draft.image}
                      onChange={(value) => updateDraft({ image: value })}
                      placeholder="vcr.vercel.com/…"
                      required
                    />
                    <ConnectionField
                      label="Vercel token"
                      value={draft.token}
                      onChange={(value) => updateDraft({ token: value })}
                      type="password"
                      required
                    />
                    <ConnectionField
                      label="Team ID"
                      value={draft.teamId}
                      onChange={(value) => updateDraft({ teamId: value })}
                    />
                    <ConnectionField
                      label="Project ID"
                      value={draft.projectId}
                      onChange={(value) => updateDraft({ projectId: value })}
                    />
                    <ConnectionField
                      label="Region"
                      value={draft.region}
                      onChange={(value) => updateDraft({ region: value })}
                      placeholder="iad1"
                    />
                  </>
                )}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void saveConnection()}
                  disabled={savingConnection}
                  className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground hover:bg-accent/90 disabled:opacity-50"
                >
                  {savingConnection && (
                    <Loader2
                      aria-hidden="true"
                      size={14}
                      className="animate-spin motion-reduce:animate-none"
                    />
                  )}
                  {savingConnection ? 'Saving…' : 'Save connection'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(EMPTY_DRAFT);
                    setShowConnectionForm(false);
                  }}
                  className="rounded-md border border-border px-3 py-2 text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                >
                  Cancel
                </button>
                <span className="text-xs text-text-tertiary">
                  Secrets are encrypted before they touch local storage.
                </span>
              </div>
            </div>
          )}

          <div className="border-t border-border pt-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
              <div>
                <p className="text-sm font-semibold text-text-primary">Active environments</p>
                <p className="mt-1 text-xs text-text-secondary">
                  {remoteEnvironments.length} active record
                  {remoteEnvironments.length === 1 ? '' : 's'}
                  {localOnlyCount
                    ? ` · ${localOnlyCount} local record${localOnlyCount === 1 ? '' : 's'} not shown online`
                    : ''}
                </p>
              </div>
              <span className="text-xs text-text-tertiary">
                Stop starts cleanup; the status updates when it finishes.
              </span>
            </div>
            {remoteEnvironments.length ? (
              <ul>
                {remoteEnvironments.map((environment) => (
                  <EnvironmentRow
                    key={environment.environmentId}
                    environment={environment}
                    busy={reapingId === environment.environmentId}
                    onReap={(id) => void reapEnvironment(id)}
                  />
                ))}
              </ul>
            ) : (
              <div className="py-5 text-center">
                <p className="text-sm text-text-secondary">No active environments yet.</p>
                <p className="mt-1 text-xs text-text-tertiary">
                  Start one above when a workflow needs a temporary worker.
                </p>
              </div>
            )}
          </div>
        </>
      )}

      {error && (
        <p
          className="rounded-md border border-error/30 bg-error/5 p-3 text-sm text-error"
          role="alert"
          aria-live="polite"
        >
          {error}
        </p>
      )}

      <ConfirmDialog
        open={connectionPendingRemoval !== null}
        title={`Remove the ${connectionPendingRemoval?.displayName ?? (connectionPendingRemoval ? providerLabel(connectionPendingRemoval.provider) : '')} connection?`}
        description="Existing environments keep running. The stored credentials are removed."
        confirmLabel="Remove connection"
        tone="danger"
        onConfirm={() => void confirmRemoveConnection()}
        onCancel={() => setConnectionPendingRemoval(null)}
      />
    </section>
  );
}
