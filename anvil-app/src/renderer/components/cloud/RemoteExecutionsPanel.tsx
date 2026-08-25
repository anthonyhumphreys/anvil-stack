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
  AnvilCloudExecutionLease,
  RepoInfo,
} from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'expired']);

export function RemoteExecutionsPanel({ repo }: { repo: RepoInfo | undefined }) {
  const { activeWorkspace } = useWorkspace();
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
  const [steering, setSteering] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const eventExecutionId = useRef<string | null>(null);
  const eventCursor = useRef<string | undefined>(undefined);

  const refreshExecutions = useCallback(async (selectId?: string) => {
    const leases = await window.anvil.anvilCloud.listExecutions();
    setExecutions(leases);
    setSelected((current) => {
      const targetId = selectId ?? current?.id;
      return targetId ? (leases.find((lease) => lease.id === targetId) ?? current) : current;
    });
  }, []);

  const loadExecution = useCallback(async (executionId: string, resetEvents = false) => {
    const continuing = !resetEvents && eventExecutionId.current === executionId;
    const batch = await window.anvil.anvilCloud.executionEvents(
      executionId,
      continuing ? eventCursor.current : undefined,
    );
    const lease = await window.anvil.anvilCloud.getExecution(executionId);
    setSelected(lease);
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
  }, []);

  useEffect(() => {
    void window.anvil.anvilCloud
      .executionConnection()
      .then((value) => {
        setConnection(value);
        setEndpoint(value.endpoint);
        if (value.configured) return refreshExecutions();
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not read Cloud connection.'),
      );
  }, [refreshExecutions]);

  useEffect(() => {
    if (!selected || TERMINAL_STATUSES.has(selected.status)) return;
    const timer = window.setInterval(() => {
      void loadExecution(selected.id).catch(() => undefined);
    }, 4_000);

    return () => window.clearInterval(timer);
  }, [loadExecution, selected]);

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
      setNotice(`Connected. ${result.executionCount ?? 0} execution(s) visible.`);
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
      setExecutions([]);
      setSelected(null);
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
      setSelected(result.execution);
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function resolveApproval(requestId: string, decision: 'approved' | 'rejected') {
    if (!selected) return;
    setBusy(`approval:${requestId}`);
    setError(null);
    try {
      const lease = await window.anvil.anvilCloud.resolveExecutionApproval({
        executionId: selected.id,
        requestId,
        decision,
      });
      setSelected(lease);
      await loadExecution(selected.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function steerExecution() {
    if (!selected || !steering.trim()) return;
    setBusy('steer');
    setError(null);
    try {
      const lease = await window.anvil.anvilCloud.steerExecution(selected.id, steering);
      setSelected(lease);
      setSteering('');
      await loadExecution(selected.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function terminateExecution() {
    if (!selected) return;
    setBusy('terminate');
    setError(null);
    try {
      const lease = await window.anvil.anvilCloud.terminateExecution(selected.id);
      setSelected(lease);
      await refreshExecutions(lease.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function collectExecution() {
    if (!selected) return;
    setBusy('collect');
    setError(null);
    try {
      const lease = await window.anvil.anvilCloud.collectExecution(selected.id);
      setSelected(lease);
      await loadExecution(lease.id);
      await refreshExecutions(lease.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-border bg-bg-secondary">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <div className="flex items-center gap-2 text-base font-semibold text-text-primary">
            <CloudCog size={18} className="text-accent" />
            Remote executions
            <span className="rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
              Optional
            </span>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-text-secondary">
            Send a committed, secret-filtered snapshot to an Anvil Cloud control plane. Remote
            agents are read-only here; local chat and the existing CLI workbench stay unchanged.
          </p>
        </div>
        <button
          onClick={() => void refreshExecutions()}
          disabled={!connection?.configured || busy !== null}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      <div className="grid gap-0 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="space-y-4 border-b border-border p-5 lg:border-b-0 lg:border-r">
          <div className="rounded-lg border border-border bg-bg-primary p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <ShieldCheck size={15} className="text-success" /> Control plane
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem]">
              <input
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                aria-label="Execution control plane endpoint"
                className="rounded-md border border-border bg-bg-secondary px-3 py-2 text-xs text-text-primary"
                placeholder="https://cloud.example.com"
              />
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                type="password"
                aria-label="Execution control plane bearer token"
                className="rounded-md border border-border bg-bg-secondary px-3 py-2 text-xs text-text-primary"
                placeholder={connection?.tokenConfigured ? 'Token saved' : 'Bearer token'}
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => void saveConnection()}
                disabled={busy !== null}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {busy === 'connection' ? 'Saving…' : 'Save connection'}
              </button>
              <button
                onClick={() => void testConnection()}
                disabled={!connection?.configured || busy !== null}
                className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary disabled:opacity-50"
              >
                {busy === 'test' ? 'Testing…' : 'Test'}
              </button>
              {connection?.configured && (
                <button
                  onClick={() => void clearConnection()}
                  disabled={busy !== null}
                  className="rounded-md border border-error/30 px-3 py-1.5 text-xs text-error disabled:opacity-50"
                >
                  {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
                </button>
              )}
              <span className="text-[11px] text-text-tertiary">
                {connection?.configured ? 'Configured' : 'Not configured'}
              </span>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-text-secondary" htmlFor="remote-task">
              Remote task
            </label>
            <textarea
              id="remote-task"
              value={task}
              onChange={(event) => setTask(event.target.value)}
              rows={4}
              className="mt-2 w-full resize-y rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm leading-relaxed text-text-primary"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <select
                value={provider}
                onChange={(event) =>
                  setProvider(event.target.value as 'auto' | 'aws-lambda-microvm')
                }
                className="rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary"
              >
                <option value="auto">Provider: automatic</option>
                <option value="aws-lambda-microvm">Provider: AWS MicroVM</option>
              </select>
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
                className="rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary"
              >
                <option value="codex-subscription">Agent: my Codex subscription</option>
                <option value="cursor-subscription">Agent: my Cursor subscription</option>
                <option value="cloud-managed">Agent: cloud-managed credential</option>
              </select>
              <button
                onClick={() => void startExecution()}
                disabled={
                  !connection?.configured ||
                  !repo ||
                  !activeWorkspace ||
                  busy !== null ||
                  !task.trim()
                }
                className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
              >
                {busy === 'start' ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Play size={13} />
                )}
                Run read-only inspection
              </button>
            </div>
            {agentRuntime !== 'cloud-managed' && (
              <p className="mt-2 text-[11px] leading-relaxed text-text-tertiary">
                No model API key is sent. This requests an interactive, execution-scoped{' '}
                {agentRuntime === 'codex-subscription' ? 'Codex device login' : 'Cursor login'}; the
                selected worker must support that flow and discard its cached session during
                cleanup.
              </p>
            )}
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
            <div className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
              Executions
            </div>
            <div className="mt-2 max-h-56 space-y-2 overflow-y-auto">
              {executions.length === 0 ? (
                <p className="text-xs text-text-tertiary">No remote executions yet.</p>
              ) : (
                executions.map((execution) => (
                  <button
                    key={execution.id}
                    onClick={() => void loadExecution(execution.id, true)}
                    className={`w-full rounded-md border px-3 py-2 text-left ${
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
                    <div className="mt-1 font-mono text-[10px] text-text-tertiary">
                      {execution.id}
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
              Select an execution to inspect its evidence stream.
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
                  <p className="mt-1 font-mono text-[10px] text-text-tertiary">{selected.id}</p>
                </div>
                <div className="flex items-center gap-2">
                  {selected.status === 'completed' && !selected.result && (
                    <button
                      onClick={() => void collectExecution()}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1 rounded-md border border-success/30 px-2.5 py-1.5 text-xs text-success disabled:opacity-50"
                    >
                      {busy === 'collect' && <Loader2 size={11} className="animate-spin" />}
                      Collect result
                    </button>
                  )}
                  {!TERMINAL_STATUSES.has(selected.status) && (
                    <button
                      onClick={() => void terminateExecution()}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1 rounded-md border border-error/30 px-2.5 py-1.5 text-xs text-error disabled:opacity-50"
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
                      Approval needed: {String(approval.data.action ?? 'protected action')}
                    </div>
                    <p className="mt-1 text-text-secondary">{String(approval.data.reason ?? '')}</p>
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => void resolveApproval(requestId, 'approved')}
                        disabled={busy !== null}
                        className="rounded bg-success px-2 py-1 text-white disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => void resolveApproval(requestId, 'rejected')}
                        disabled={busy !== null}
                        className="rounded border border-error/30 px-2 py-1 text-error disabled:opacity-50"
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
                    className="min-w-0 flex-1 rounded-md border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary"
                    placeholder="Steer this execution…"
                  />
                  <button
                    onClick={() => void steerExecution()}
                    disabled={!steering.trim() || busy !== null}
                    aria-label="Send steering message"
                    className="rounded-md border border-border px-3 text-accent disabled:opacity-50"
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
                    <p className="text-xs text-text-tertiary">No events received yet.</p>
                  ) : (
                    events.map((event) => (
                      <div
                        key={event.id}
                        className="border-b border-border-subtle pb-2 last:border-0"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[11px] text-accent">{event.type}</span>
                          <span className="text-[10px] text-text-tertiary">
                            {new Date(event.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-text-secondary">
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
  const terminal = TERMINAL_STATUSES.has(status);
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
        status === 'failed' || status === 'expired'
          ? 'border-error/30 bg-error/10 text-error'
          : terminal
            ? 'border-success/30 bg-success/10 text-success'
            : 'border-warning/30 bg-warning/10 text-warning'
      }`}
    >
      {status}
    </span>
  );
}
