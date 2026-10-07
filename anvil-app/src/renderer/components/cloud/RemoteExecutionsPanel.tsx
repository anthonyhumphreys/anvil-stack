import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CloudCog,
  Loader2,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Square,
} from 'lucide-react';
import type {
  AnvilCloudExecutionConnection,
  AnvilCloudExecutionEvent,
  AnvilCloudExecutionEventBatch,
  AnvilCloudExecutionLease,
  AnvilCloudExecutionProviderDescriptor,
  RepoInfo,
} from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'expired']);

export function RemoteExecutionsPanel({ repo }: { repo: RepoInfo | undefined }) {
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace?.id;
  const repoId = repo?.id;
  const repoName = repo?.name;
  const repoRemoteUrl = repo?.remoteUrl;
  const scopeKey = JSON.stringify([
    workspaceId ?? '',
    repoId ?? '',
    repoName ?? '',
    repoRemoteUrl ?? '',
  ]);
  const [connection, setConnection] = useState<AnvilCloudExecutionConnection | null>(null);
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:4764');
  const [token, setToken] = useState('');
  const [executions, setExecutions] = useState<AnvilCloudExecutionLease[]>([]);
  const [selected, setSelected] = useState<AnvilCloudExecutionLease | null>(null);
  const [events, setEvents] = useState<AnvilCloudExecutionEvent[]>([]);
  const [task, setTask] = useState('Inspect this repository and report the highest-impact risks.');
  const [provider, setProvider] = useState<'auto' | 'aws-lambda-microvm'>('auto');
  const [agentRuntime, setAgentRuntime] = useState<
    'codex-subscription' | 'cursor-subscription' | 'cloud-managed'
  >('codex-subscription');
  const [providerCatalog, setProviderCatalog] = useState<
    AnvilCloudExecutionProviderDescriptor[] | null
  >(null);
  const [steering, setSteering] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionChecked, setConnectionChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const eventExecutionId = useRef<string | null>(null);
  const eventCursor = useRef<string | undefined>(undefined);
  const currentScopeKeyRef = useRef(scopeKey);
  const scopeGenerationRef = useRef(0);
  const selectedExecutionIdRef = useRef<string | null>(null);
  const selectionGenerationRef = useRef(0);
  const refreshGenerationRef = useRef(0);
  const loadGenerationRef = useRef(0);

  if (currentScopeKeyRef.current !== scopeKey) {
    currentScopeKeyRef.current = scopeKey;
    scopeGenerationRef.current += 1;
    refreshGenerationRef.current += 1;
    loadGenerationRef.current += 1;
    selectedExecutionIdRef.current = null;
    selectionGenerationRef.current += 1;
    eventExecutionId.current = null;
    eventCursor.current = undefined;
  }

  const refreshExecutions = useCallback(
    async (selectId?: string) => {
      const requestScopeKey = scopeKey;
      const requestScopeGeneration = scopeGenerationRef.current;
      const requestGeneration = ++refreshGenerationRef.current;
      const requestSelectionGeneration = selectionGenerationRef.current;
      let leases: AnvilCloudExecutionLease[];
      try {
        leases = await window.anvil.anvilCloud.listExecutions();
      } catch (error) {
        if (!isCurrentScope(requestScopeKey, requestScopeGeneration)) return;
        throw error;
      }
      if (
        currentScopeKeyRef.current !== requestScopeKey ||
        scopeGenerationRef.current !== requestScopeGeneration ||
        refreshGenerationRef.current !== requestGeneration
      ) {
        return;
      }
      setExecutions(leases);
      setSelected((current) => {
        if (
          selectId !== undefined &&
          selectionGenerationRef.current !== requestSelectionGeneration
        ) {
          return current;
        }
        const targetId = selectId ?? selectedExecutionIdRef.current ?? current?.id;
        const match = targetId ? leases.find((lease) => lease.id === targetId) : undefined;
        if (match && executionIsInScope(match, workspaceId, repoName, repoRemoteUrl)) {
          selectedExecutionIdRef.current = match.id;
          return match;
        }
        selectedExecutionIdRef.current = null;
        return null;
      });
    },
    [repoName, repoRemoteUrl, scopeKey, workspaceId],
  );

  const loadExecution = useCallback(
    async (executionId: string, resetEvents = false) => {
      if (resetEvents) {
        selectedExecutionIdRef.current = executionId;
        selectionGenerationRef.current += 1;
      }
      const requestScopeKey = scopeKey;
      const requestScopeGeneration = scopeGenerationRef.current;
      const requestGeneration = ++loadGenerationRef.current;
      const continuing = !resetEvents && eventExecutionId.current === executionId;
      let batch: AnvilCloudExecutionEventBatch;
      try {
        batch = await window.anvil.anvilCloud.executionEvents(
          executionId,
          continuing ? eventCursor.current : undefined,
        );
      } catch (error) {
        if (
          !isCurrentScope(requestScopeKey, requestScopeGeneration) ||
          loadGenerationRef.current !== requestGeneration ||
          selectedExecutionIdRef.current !== executionId
        ) {
          return;
        }
        throw error;
      }
      if (
        currentScopeKeyRef.current !== requestScopeKey ||
        scopeGenerationRef.current !== requestScopeGeneration ||
        loadGenerationRef.current !== requestGeneration ||
        selectedExecutionIdRef.current !== executionId
      ) {
        return;
      }
      let lease: AnvilCloudExecutionLease;
      try {
        lease = await window.anvil.anvilCloud.getExecution(executionId);
      } catch (error) {
        if (
          !isCurrentScope(requestScopeKey, requestScopeGeneration) ||
          loadGenerationRef.current !== requestGeneration ||
          selectedExecutionIdRef.current !== executionId
        ) {
          return;
        }
        throw error;
      }
      if (
        currentScopeKeyRef.current !== requestScopeKey ||
        scopeGenerationRef.current !== requestScopeGeneration ||
        loadGenerationRef.current !== requestGeneration ||
        selectedExecutionIdRef.current !== executionId
      ) {
        return;
      }
      if (!executionIsInScope(lease, workspaceId, repoName, repoRemoteUrl)) {
        throw new Error('This execution is outside the selected workspace or repository.');
      }
      selectExecution(lease);
      setEvents((current) => {
        if (!continuing) return batch.events;
        const existing = new Set(current.map((event) => event.id));
        return [...current, ...batch.events.filter((event) => !existing.has(event.id))];
      });
      eventExecutionId.current = executionId;
      eventCursor.current = batch.cursor;
      setExecutions((current) =>
        current.map((candidate) => (candidate.id === lease.id ? lease : candidate)),
      );
    },
    [repoName, repoRemoteUrl, scopeKey, workspaceId],
  );

  const scopedExecutions = useMemo(
    () =>
      executions.filter((execution) =>
        executionIsInScope(execution, workspaceId, repoName, repoRemoteUrl),
      ),
    [executions, repoName, repoRemoteUrl, workspaceId],
  );

  const connectionNeedsSave =
    connection?.configured === true &&
    (endpoint !== connection.endpoint || token.trim().length > 0);

  const selectedProviderDescriptors = useMemo(() => {
    if (providerCatalog === null) return null;
    const configured = providerCatalog.filter((descriptor) => descriptor.availability.configured);
    return provider === 'auto'
      ? configured
      : configured.filter((descriptor) => descriptor.id === provider);
  }, [provider, providerCatalog]);

  const selectedProviderAvailable =
    selectedProviderDescriptors === null || selectedProviderDescriptors.length > 0;
  const selectedRuntimeAvailable =
    selectedProviderDescriptors === null ||
    selectedProviderDescriptors.some((descriptor) => supportsRuntime(descriptor, agentRuntime));
  const providerCatalogReady = connectionChecked && providerCatalog !== null;

  useEffect(() => {
    if (selected && !executionIsInScope(selected, workspaceId, repoName, repoRemoteUrl)) {
      selectExecution(null);
      setEvents([]);
      eventExecutionId.current = null;
      eventCursor.current = undefined;
    }
  }, [repoName, repoRemoteUrl, selected, workspaceId]);

  useEffect(() => {
    selectedExecutionIdRef.current = selected?.id ?? null;
  }, [selected?.id]);

  useEffect(() => {
    setBusy(null);
    setError(null);
    setNotice(null);
  }, [scopeKey]);

  useEffect(() => {
    setConnectionLoading(true);
    void window.anvil.anvilCloud
      .executionConnection()
      .then((value) => {
        setConnection(value);
        setEndpoint(value.endpoint);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not read Cloud connection.'),
      )
      .finally(() => setConnectionLoading(false));
  }, []);

  useEffect(() => {
    if (!connection?.configured) return;
    void refreshExecutions().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [connection?.configured, refreshExecutions]);

  useEffect(() => {
    if (!selected || TERMINAL_STATUSES.has(selected.status)) return;
    const timer = window.setInterval(() => {
      void loadExecution(selected.id).catch(() => undefined);
    }, 4_000);

    return () => window.clearInterval(timer);
  }, [loadExecution, selected]);

  function selectExecution(lease: AnvilCloudExecutionLease | null) {
    selectedExecutionIdRef.current = lease?.id ?? null;
    selectionGenerationRef.current += 1;
    setSelected(lease);
  }

  function isCurrentScope(requestScopeKey: string, requestScopeGeneration: number): boolean {
    return (
      currentScopeKeyRef.current === requestScopeKey &&
      scopeGenerationRef.current === requestScopeGeneration
    );
  }

  const pendingApprovals = useMemo(() => {
    const resolved = new Set(
      events
        .filter((event) => event.type === 'approval.resolved')
        .map((event) => String(event.data.requestId)),
    );
    return events.filter(
      (event) => event.type === 'approval.requested' && !resolved.has(String(event.data.requestId)),
    );
  }, [events]);

  async function saveConnection() {
    setBusy('connection');
    setError(null);
    setNotice(null);
    setConnectionChecked(false);
    setProviderCatalog(null);
    try {
      const value = await window.anvil.anvilCloud.saveExecutionConnection({
        endpoint,
        ...(token.trim() === '' ? {} : { token: token.trim() }),
      });
      setConnection(value);
      setEndpoint(value.endpoint);
      setToken('');
      await refreshExecutions();
      setNotice('Execution connection saved. The bearer token remains in the main process.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function testConnection() {
    setBusy('test');
    setError(null);
    setNotice(null);
    try {
      const result = await window.anvil.anvilCloud.testExecutionConnection();
      if (!result.ok) throw new Error(result.error ?? 'Connection failed.');
      setConnectionChecked(true);
      setProviderCatalog(result.providers ?? []);
      setNotice(`Connection checked. ${result.executionCount ?? 0} run(s) visible to this token.`);
    } catch (err) {
      setConnectionChecked(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function refreshRuns() {
    setBusy('refresh');
    setError(null);
    setNotice(null);
    try {
      await refreshExecutions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function clearConnection() {
    setBusy('disconnect');
    setError(null);
    setNotice(null);
    try {
      const value = await window.anvil.anvilCloud.clearExecutionConnection();
      setConnection(value);
      setEndpoint(value.endpoint);
      setToken('');
      setConnectionChecked(false);
      setProviderCatalog(null);
      setExecutions([]);
      selectExecution(null);
      setEvents([]);
      eventExecutionId.current = null;
      eventCursor.current = undefined;
      setNotice('Execution connection removed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function startExecution() {
    if (!repo || !activeWorkspace) return;
    const requestScopeKey = scopeKey;
    const requestScopeGeneration = scopeGenerationRef.current;
    const requestSelectionGeneration = selectionGenerationRef.current;
    setBusy('start');
    setError(null);
    setNotice(null);
    try {
      const result = await window.anvil.anvilCloud.startExecution({
        workspaceId: activeWorkspace.id,
        repoId: repo.id,
        task,
        provider,
        agentRuntime,
      });
      if (
        !isCurrentScope(requestScopeKey, requestScopeGeneration) ||
        selectionGenerationRef.current !== requestSelectionGeneration
      ) {
        return;
      }
      selectExecution(result.execution);
      setEvents([]);
      eventExecutionId.current = result.execution.id;
      eventCursor.current = undefined;
      await refreshExecutions(result.execution.id);
      setNotice(
        result.source.excludedWorkingTreeChanges
          ? `Started from commit ${result.source.commit.slice(0, 8)}. Local working-tree changes were deliberately excluded.`
          : `Started from immutable commit ${result.source.commit.slice(0, 8)}.`,
      );
    } catch (err) {
      if (isCurrentScope(requestScopeKey, requestScopeGeneration)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (isCurrentScope(requestScopeKey, requestScopeGeneration)) setBusy(null);
    }
  }

  async function resolveApproval(requestId: string, decision: 'approved' | 'rejected') {
    if (!selected) return;
    const requestScopeKey = scopeKey;
    const requestScopeGeneration = scopeGenerationRef.current;
    const requestSelectionGeneration = selectionGenerationRef.current;
    const executionId = selected.id;
    setBusy(`approval:${requestId}`);
    setError(null);
    try {
      const lease = await window.anvil.anvilCloud.resolveExecutionApproval({
        executionId,
        requestId,
        decision,
      });
      if (
        !isCurrentScope(requestScopeKey, requestScopeGeneration) ||
        selectionGenerationRef.current !== requestSelectionGeneration ||
        selectedExecutionIdRef.current !== executionId
      ) {
        return;
      }
      selectExecution(lease);
      await loadExecution(executionId);
    } catch (err) {
      if (
        isCurrentScope(requestScopeKey, requestScopeGeneration) &&
        selectedExecutionIdRef.current === executionId
      ) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (isCurrentScope(requestScopeKey, requestScopeGeneration)) setBusy(null);
    }
  }

  async function steerExecution() {
    if (!selected || !steering.trim()) return;
    const requestScopeKey = scopeKey;
    const requestScopeGeneration = scopeGenerationRef.current;
    const requestSelectionGeneration = selectionGenerationRef.current;
    const executionId = selected.id;
    setBusy('steer');
    setError(null);
    try {
      const lease = await window.anvil.anvilCloud.steerExecution(executionId, steering);
      if (
        !isCurrentScope(requestScopeKey, requestScopeGeneration) ||
        selectionGenerationRef.current !== requestSelectionGeneration ||
        selectedExecutionIdRef.current !== executionId
      ) {
        return;
      }
      selectExecution(lease);
      setSteering('');
      await loadExecution(executionId);
    } catch (err) {
      if (
        isCurrentScope(requestScopeKey, requestScopeGeneration) &&
        selectedExecutionIdRef.current === executionId
      ) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (isCurrentScope(requestScopeKey, requestScopeGeneration)) setBusy(null);
    }
  }

  async function terminateExecution() {
    if (!selected) return;
    const requestScopeKey = scopeKey;
    const requestScopeGeneration = scopeGenerationRef.current;
    const requestSelectionGeneration = selectionGenerationRef.current;
    const executionId = selected.id;
    setBusy('terminate');
    setError(null);
    try {
      const lease = await window.anvil.anvilCloud.terminateExecution(executionId);
      if (
        !isCurrentScope(requestScopeKey, requestScopeGeneration) ||
        selectionGenerationRef.current !== requestSelectionGeneration ||
        selectedExecutionIdRef.current !== executionId
      ) {
        return;
      }
      selectExecution(lease);
      await refreshExecutions(lease.id);
    } catch (err) {
      if (
        isCurrentScope(requestScopeKey, requestScopeGeneration) &&
        selectedExecutionIdRef.current === executionId
      ) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (isCurrentScope(requestScopeKey, requestScopeGeneration)) setBusy(null);
    }
  }

  async function collectExecution() {
    if (!selected) return;
    const requestScopeKey = scopeKey;
    const requestScopeGeneration = scopeGenerationRef.current;
    const requestSelectionGeneration = selectionGenerationRef.current;
    const executionId = selected.id;
    setBusy('collect');
    setError(null);
    try {
      const lease = await window.anvil.anvilCloud.collectExecution(executionId);
      if (
        !isCurrentScope(requestScopeKey, requestScopeGeneration) ||
        selectionGenerationRef.current !== requestSelectionGeneration ||
        selectedExecutionIdRef.current !== executionId
      ) {
        return;
      }
      selectExecution(lease);
      await loadExecution(lease.id);
      await refreshExecutions(lease.id);
    } catch (err) {
      if (
        isCurrentScope(requestScopeKey, requestScopeGeneration) &&
        selectedExecutionIdRef.current === executionId
      ) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (isCurrentScope(requestScopeKey, requestScopeGeneration)) setBusy(null);
    }
  }

  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-border bg-bg-secondary">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <div className="flex items-center gap-2 text-base font-semibold text-text-primary">
            <CloudCog size={18} className="text-accent" />
            Remote runs
            <span className="rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-accent">
              Read-only
            </span>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-text-secondary">
            Run an agent against a committed, secret-filtered snapshot. Your working tree stays on
            this computer, and the selected worker cannot write back to the repository.
          </p>
        </div>
        <button
          onClick={() => void refreshRuns()}
          disabled={!connection?.configured || busy !== null}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-text-secondary hover:bg-bg-tertiary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
        >
          <RefreshCw size={13} className={busy === 'refresh' ? 'animate-spin' : undefined} />{' '}
          Refresh
        </button>
      </div>

      <div className="grid gap-0 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="space-y-4 border-b border-border p-5 lg:border-b-0 lg:border-r">
          <div className="rounded-lg border border-border bg-bg-primary p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                <ShieldCheck size={15} className="text-success" /> Control plane
              </div>
              <span className="text-xs text-text-tertiary">
                {connectionLoading
                  ? 'Checking…'
                  : connection?.configured
                    ? connectionChecked
                      ? 'Reachable'
                      : 'Saved'
                    : 'Not connected'}
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-text-secondary">
              Connect Desktop to the control plane that owns your remote workers. Saved tokens are
              encrypted and are never returned to this view.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
              <label className="min-w-0 text-xs font-medium text-text-secondary">
                Control-plane URL
                <input
                  value={endpoint}
                  onChange={(event) => {
                    setEndpoint(event.target.value);
                    setConnectionChecked(false);
                    setProviderCatalog(null);
                  }}
                  aria-label="Execution control plane endpoint"
                  className="mt-1 w-full rounded-md border border-border bg-bg-secondary px-3 py-2 text-xs text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  placeholder="https://cloud.example.com"
                  autoComplete="url"
                />
              </label>
              <label className="min-w-0 text-xs font-medium text-text-secondary">
                Bearer token
                <input
                  value={token}
                  onChange={(event) => {
                    setToken(event.target.value);
                    setConnectionChecked(false);
                    setProviderCatalog(null);
                  }}
                  type="password"
                  aria-label="Execution control plane bearer token"
                  className="mt-1 w-full rounded-md border border-border bg-bg-secondary px-3 py-2 text-xs text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  placeholder={connection?.tokenConfigured ? 'Token saved' : 'Paste token'}
                  autoComplete="new-password"
                />
              </label>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-text-tertiary">
              Remote endpoints must use HTTPS. HTTP is allowed for a local 127.0.0.1 control plane.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => void saveConnection()}
                disabled={busy !== null}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
              >
                {busy === 'connection' ? 'Saving…' : 'Save connection'}
              </button>
              <button
                onClick={() => void testConnection()}
                disabled={!connection?.configured || connectionNeedsSave || busy !== null}
                className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
              >
                {busy === 'test'
                  ? 'Checking…'
                  : connectionNeedsSave
                    ? 'Save changes to check'
                    : 'Check connection'}
              </button>
              {connection?.configured && (
                <button
                  onClick={() => void clearConnection()}
                  disabled={busy !== null}
                  className="rounded-md border border-error/30 px-3 py-1.5 text-xs text-error focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
                >
                  {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
                </button>
              )}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-text-secondary" htmlFor="remote-task">
              What should the agent inspect?
            </label>
            <textarea
              id="remote-task"
              value={task}
              onChange={(event) => setTask(event.target.value)}
              rows={4}
              maxLength={20_000}
              aria-describedby="remote-task-help"
              className="mt-2 w-full resize-y rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm leading-relaxed text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            />
            <p id="remote-task-help" className="mt-2 text-xs leading-relaxed text-text-tertiary">
              Runs start from the latest commit. Uncommitted changes and secrets stay out of the
              snapshot.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium text-text-secondary">
                Worker provider
                <select
                  value={provider}
                  onChange={(event) =>
                    setProvider(event.target.value as 'auto' | 'aws-lambda-microvm')
                  }
                  className="mt-1 w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <option value="auto">Automatic (recommended)</option>
                  <option
                    value="aws-lambda-microvm"
                    disabled={
                      providerCatalog !== null &&
                      !providerCatalog.some(
                        (descriptor) =>
                          descriptor.id === 'aws-lambda-microvm' &&
                          descriptor.availability.configured,
                      )
                    }
                  >
                    AWS Lambda MicroVM (alpha)
                  </option>
                </select>
              </label>
              <label className="text-xs font-medium text-text-secondary">
                Model access
                <select
                  value={agentRuntime}
                  onChange={(event) =>
                    setAgentRuntime(
                      event.target.value as
                        | 'codex-subscription'
                        | 'cursor-subscription'
                        | 'cloud-managed',
                    )
                  }
                  className="mt-1 w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <option
                    value="codex-subscription"
                    disabled={
                      providerCatalog !== null &&
                      !selectedProviderDescriptors?.some((descriptor) =>
                        supportsRuntime(descriptor, 'codex-subscription'),
                      )
                    }
                  >
                    Codex subscription
                  </option>
                  <option
                    value="cursor-subscription"
                    disabled={
                      providerCatalog !== null &&
                      !selectedProviderDescriptors?.some((descriptor) =>
                        supportsRuntime(descriptor, 'cursor-subscription'),
                      )
                    }
                  >
                    Cursor subscription
                  </option>
                  <option
                    value="cloud-managed"
                    disabled={
                      providerCatalog !== null &&
                      !selectedProviderDescriptors?.some((descriptor) =>
                        supportsRuntime(descriptor, 'cloud-managed'),
                      )
                    }
                  >
                    Control-plane credential
                  </option>
                </select>
              </label>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-text-tertiary">
              {!providerCatalogReady
                ? 'Check connection to load the registered workers and model access this control plane supports.'
                : !selectedProviderAvailable
                  ? 'The selected worker is not configured on this control plane. Choose Automatic or another available worker.'
                  : !selectedRuntimeAvailable
                    ? 'The selected worker does not advertise this model access. Choose another option.'
                    : provider === 'auto'
                      ? 'Automatic chooses a configured worker that can satisfy this request.'
                      : 'The selected worker is configured on this control plane.'}{' '}
              {agentRuntime === 'cloud-managed'
                ? 'The control plane supplies the configured model credential.'
                : `Desktop does not send or store ${agentRuntime === 'codex-subscription' ? 'Codex' : 'Cursor'} credentials.`}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => void startExecution()}
                disabled={
                  !connection?.configured ||
                  !providerCatalogReady ||
                  !selectedProviderAvailable ||
                  !selectedRuntimeAvailable ||
                  !repo ||
                  !activeWorkspace ||
                  busy !== null ||
                  !task.trim()
                }
                className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-xs font-medium text-accent-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
              >
                {busy === 'start' ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Play size={13} />
                )}
                Start read-only run
              </button>
            </div>
          </div>

          {(error || notice) && (
            <div
              className={`flex gap-2 rounded-md border px-3 py-2 text-xs ${
                error
                  ? 'border-error/30 bg-error/10 text-error'
                  : 'border-success/30 bg-success/10 text-success'
              }`}
            >
              {error ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
              <span>{error ?? notice}</span>
            </div>
          )}

          <div>
            <div className="flex items-baseline justify-between gap-3">
              <div className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
                Recent runs
              </div>
              <span className="text-xs text-text-tertiary">
                {scopedExecutions.length} for {repo?.name ?? 'this repository'}
              </span>
            </div>
            <div className="mt-2 max-h-56 space-y-2 overflow-y-auto">
              {scopedExecutions.length === 0 ? (
                <p className="rounded-md border border-dashed border-border p-3 text-xs leading-relaxed text-text-tertiary">
                  {connection?.configured
                    ? `No read-only runs for ${repo?.name ?? 'this repository'} in this workspace yet.`
                    : 'Connect a control plane to see and start remote runs.'}
                </p>
              ) : (
                scopedExecutions.map((execution) => (
                  <button
                    key={execution.id}
                    onClick={() =>
                      void loadExecution(execution.id, true).catch((err: unknown) =>
                        setError(err instanceof Error ? err.message : String(err)),
                      )
                    }
                    title={execution.request.task}
                    className={`w-full rounded-md border px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                      selected?.id === execution.id
                        ? 'border-accent/50 bg-accent/10'
                        : 'border-border bg-bg-primary hover:bg-bg-tertiary'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium text-text-primary">
                        {execution.request.task}
                      </span>
                      <ExecutionStatus status={execution.status} />
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 font-mono text-xs text-text-tertiary">
                      <span className="truncate">{execution.id}</span>
                      <span className="shrink-0 font-sans">
                        {formatExecutionTime(execution.createdAt)}
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="min-w-0 p-5">
          {!selected ? (
            <div className="flex h-full min-h-64 items-center justify-center rounded-lg border border-dashed border-border p-8 text-center text-sm text-text-tertiary">
              Select a run to inspect its status, approvals, and evidence.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <ExecutionStatus status={selected.status} />
                    <span className="text-xs text-text-tertiary">{selected.provider}</span>
                  </div>
                  <h4 className="mt-2 text-sm font-medium text-text-primary">
                    {selected.request.task}
                  </h4>
                  <p className="mt-1 font-mono text-xs text-text-tertiary">{selected.id}</p>
                </div>
                <div className="flex items-center gap-2">
                  {selected.status === 'completed' && !selected.result && (
                    <button
                      onClick={() => void collectExecution()}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1 rounded-md border border-success/30 px-2.5 py-1.5 text-xs text-success focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
                    >
                      {busy === 'collect' && <Loader2 size={11} className="animate-spin" />}
                      Collect result
                    </button>
                  )}
                  {!TERMINAL_STATUSES.has(selected.status) && (
                    <button
                      onClick={() => void terminateExecution()}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1 rounded-md border border-error/30 px-2.5 py-1.5 text-xs text-error focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
                    >
                      <Square size={11} /> Terminate
                    </button>
                  )}
                </div>
              </div>

              {pendingApprovals.map((approval) => {
                const requestId = String(approval.data.requestId);
                return (
                  <div
                    key={requestId}
                    className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs"
                  >
                    <div className="font-medium text-warning">
                      Approval needed for {String(approval.data.action ?? 'a protected action')}
                    </div>
                    <p className="mt-1 text-text-secondary">{String(approval.data.reason ?? '')}</p>
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => void resolveApproval(requestId, 'approved')}
                        disabled={busy !== null}
                        className="rounded bg-success px-2 py-1 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => void resolveApproval(requestId, 'rejected')}
                        disabled={busy !== null}
                        className="rounded border border-error/30 px-2 py-1 text-error focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                );
              })}

              {!TERMINAL_STATUSES.has(selected.status) && (
                <div className="flex gap-2">
                  <input
                    value={steering}
                    onChange={(event) => setSteering(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void steerExecution();
                    }}
                    aria-label="Message for this run"
                    className="min-w-0 flex-1 rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                    placeholder="Send a message to this run…"
                  />
                  <button
                    onClick={() => void steerExecution()}
                    disabled={!steering.trim() || busy !== null}
                    aria-label="Send steering message"
                    className="rounded-md border border-border px-3 text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
                  >
                    <Send size={13} />
                  </button>
                </div>
              )}

              {selected.result && (
                <div className="rounded-lg border border-success/30 bg-success/10 p-3">
                  <div className="text-xs font-medium text-success">Result</div>
                  <p className="mt-1 text-sm leading-relaxed text-text-primary">
                    {selected.result.summary}
                  </p>
                </div>
              )}

              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
                  Evidence stream
                </div>
                <div className="mt-2 max-h-96 space-y-2 overflow-y-auto rounded-lg border border-border bg-bg-primary p-3">
                  {events.length === 0 ? (
                    <p className="text-xs text-text-tertiary">
                      Waiting for the worker to emit events.
                    </p>
                  ) : (
                    events.map((event) => (
                      <div
                        key={event.id}
                        className="border-b border-border-subtle pb-2 last:border-0"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs text-accent">{event.type}</span>
                          <span className="text-xs text-text-tertiary">
                            {new Date(event.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <pre className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-text-secondary">
                          {JSON.stringify(event.data, null, 2)}
                        </pre>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ExecutionStatus({ status }: { status: AnvilCloudExecutionLease['status'] }) {
  const tone =
    status === 'failed' || status === 'expired'
      ? 'border-error/30 bg-error/10 text-error'
      : status === 'completed'
        ? 'border-success/30 bg-success/10 text-success'
        : status === 'cancelled'
          ? 'border-border bg-bg-tertiary text-text-secondary'
          : status === 'queued' || status === 'starting'
            ? 'border-info/30 bg-info/10 text-info'
            : 'border-warning/30 bg-warning/10 text-warning';
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}>
      {status}
    </span>
  );
}

function executionIsInScope(
  execution: AnvilCloudExecutionLease,
  workspaceId: string | undefined,
  repoName: string | undefined,
  repoRemoteUrl: string | undefined,
): boolean {
  if (!workspaceId || execution.request.workspace !== workspaceId) return false;
  if (!repoName) return true;

  const sourceRepository = execution.request.source.repository;
  if (sourceRepository && repoRemoteUrl) {
    return normalizeRepositoryUrl(sourceRepository) === normalizeRepositoryUrl(repoRemoteUrl);
  }

  return execution.request.cell === repoName;
}

function normalizeRepositoryUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .toLowerCase();
}

function supportsRuntime(
  descriptor: AnvilCloudExecutionProviderDescriptor,
  runtime: 'codex-subscription' | 'cursor-subscription' | 'cloud-managed',
): boolean {
  if (runtime === 'cloud-managed') {
    return descriptor.capabilities.modelAuth.includes('control-plane');
  }

  const provider = runtime === 'codex-subscription' ? 'codex' : 'cursor';
  return (
    descriptor.capabilities.modelAuth.includes('provider-subscription') &&
    descriptor.capabilities.subscriptionProviders?.includes(provider) === true
  );
}

function formatExecutionTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Unknown time'
    : date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}
