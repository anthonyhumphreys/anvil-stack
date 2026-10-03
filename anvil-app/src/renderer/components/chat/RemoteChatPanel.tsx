import { useEffect, useRef, useState } from 'react';
import type { AgentProvider, CodexMode } from '../../../shared/types';
import type { RemoteChatRecord } from '../../../shared/remote-chat';
import type { ApprovalRecord, SyncAttemptActivity, SyncDevice } from '../../../shared/sync-runtime';
import { isAcpAgentProvider } from '../../../shared/agent-providers';
import { agentProviderLabel } from '../../utils/agent-display';
import { chatAccessLevelLabel } from './thread-access';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const LABELS: Record<string, string> = {
  preparing: 'Preparing workspace',
  starting: 'Starting',
  running: 'Working',
  'awaiting-approval': 'Needs approval',
  completed: 'Turn complete',
  failed: 'Failed',
  cancelled: 'Stopped',
  'cancel-requested': 'Stopping',
};
const fieldClass = 'rounded border border-border bg-surface px-2 py-1 text-sm';

export function RemoteChatPanel({
  workspaceId,
  provider,
  model,
  permissionMode,
  sourceSessionId,
}: {
  workspaceId: string;
  provider: AgentProvider;
  model: string;
  permissionMode: CodexMode;
  sourceSessionId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<RemoteChatRecord[]>([]);
  const [devices, setDevices] = useState<SyncDevice[]>([]);
  const [target, setTarget] = useState('');
  const [credentialChoice, setCredentialChoice] = useState<
    'target-local' | 'codex-account' | 'openai-api-key'
  >('target-local');
  const [selectedId, setSelectedId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [activity, setActivity] = useState<SyncAttemptActivity[]>([]);
  const pendingRequest = useRef<{ key: string; id: string } | null>(null);
  const selected = records.find((record) => record.id === selectedId);
  const cloudTarget =
    devices.find((device) => device.enrollmentId === target)?.enrollmentClass === 'ephemeral';
  const effectiveCredentialChoice =
    cloudTarget && credentialChoice === 'target-local' ? 'codex-account' : credentialChoice;
  const unsupportedAccess = isAcpAgentProvider(provider) && permissionMode === 'read-only';
  const active = selected !== undefined && !TERMINAL.has(selected.state);
  const retryHandoff = selected?.state === 'failed' && selected.handoffId !== undefined;
  const canSend = selected === undefined || selected.state === 'completed' || retryHandoff;

  useEffect(() => {
    let disposed = false;
    let fetching = false;
    setRecords([]);
    setSelectedId('');
    setPrompt('');
    setDevices([]);
    setTarget('');
    pendingRequest.current = null;
    setError(null);
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const rows = await window.anvil.syncRuntime.listRemoteChats(workspaceId);
        if (disposed) return;
        setRecords(rows);
        const handoff = rows.find(
          (row) => row.sourceSessionId === sourceSessionId && sourceSessionId,
        );
        if (handoff) setOpen(true);
        setSelectedId((current) =>
          rows.some((row) => row.id === current) ? current : (handoff?.id ?? ''),
        );
      } catch (cause) {
        if (!disposed) setError(String(cause));
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [workspaceId, sourceSessionId]);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    window.anvil.syncRuntime
      .listDevices()
      .then((rows) => {
        if (disposed) return;
        const available = rows.filter(
          (device) => !device.self && !device.revoked && device.trustState === 'trusted',
        );
        setDevices(available);
        setTarget((current) =>
          available.some((device) => device.enrollmentId === current)
            ? current
            : (available[0]?.enrollmentId ?? ''),
        );
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(String(cause));
      });
    return () => {
      disposed = true;
    };
  }, [open, workspaceId]);

  const jobId = selected?.jobId ?? selected?.prepareJobId;
  useEffect(() => {
    let disposed = false;
    let fetching = false;
    setApprovals([]);
    setAttemptId(null);
    if (!open || !jobId) return;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const [result, requests] = await Promise.all([
          window.anvil.syncRuntime.getMeshJob(jobId),
          window.anvil.syncRuntime.getMeshApprovals(jobId),
        ]);
        if (disposed) return;
        setAttemptId(result.attempts.at(-1)?.id ?? null);
        setApprovals(requests.filter((request) => request.state === 'pending'));
      } catch (cause) {
        if (!disposed) setError(String(cause));
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [open, jobId]);

  useEffect(() => {
    setActivity([]);
    if (!attemptId) return;
    return window.anvil.syncRuntime.observeAttemptActivity(attemptId, (item) => {
      setActivity((items) => [...items, item].slice(-80));
    });
  }, [attemptId]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setRecords(await window.anvil.syncRuntime.listRemoteChats(workspaceId));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const send = () =>
    act(async () => {
      const text = prompt.trim();
      if (!text) return;
      const key = JSON.stringify([
        selectedId,
        target,
        provider,
        model,
        permissionMode,
        effectiveCredentialChoice,
        text,
      ]);
      if (pendingRequest.current?.key !== key)
        pendingRequest.current = { key, id: crypto.randomUUID() };
      const requestId = pendingRequest.current.id;
      const record = selected
        ? await window.anvil.syncRuntime.sendRemoteChat({
            sessionId: selected.id,
            requestId,
            prompt: text,
          })
        : await window.anvil.syncRuntime.createRemoteChat({
            workspaceId,
            targetEnrollmentId: target,
            ...(provider === 'codex' ? { credentialChoice: effectiveCredentialChoice } : {}),
            provider,
            model,
            permissionMode,
            prompt: text,
            requestId,
          });
      setSelectedId(record.id);
      setPrompt('');
      pendingRequest.current = null;
    });

  return (
    <section className="border-b border-border px-4 py-2" aria-label="Remote chats">
      <button
        type="button"
        className="text-sm text-text-secondary hover:text-text-primary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? 'Hide remote chats' : 'Run on another device'}
        {records.length ? ` · ${records.length}` : ''}
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-text-secondary" htmlFor="remote-chat-session">
              Chat
            </label>
            <select
              id="remote-chat-session"
              className={fieldClass}
              value={selectedId}
              onChange={(event) => {
                setSelectedId(event.target.value);
                setPrompt('');
              }}
            >
              <option value="">New remote chat</option>
              {records.map((record) => (
                <option key={record.id} value={record.id}>
                  {record.turns[0]?.prompt.slice(0, 50) || 'Moved session'} ·{' '}
                  {LABELS[record.state] ?? record.state}
                </option>
              ))}
            </select>
            {!selected && provider === 'codex' && (
              <label className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                Authentication
                <select
                  className={fieldClass}
                  value={effectiveCredentialChoice}
                  onChange={(event) =>
                    setCredentialChoice(event.target.value as typeof credentialChoice)
                  }
                >
                  {!cloudTarget && (
                    <option value="target-local">Use destination's existing login</option>
                  )}
                  <option value="codex-account">Sign in to Codex on the destination</option>
                  <option value="openai-api-key">Use my saved OpenAI API key for this chat</option>
                </select>
                {credentialChoice === 'openai-api-key' && (
                  <span>
                    Uses separately billed API usage. Sends the key encrypted to this worker for
                    each turn.
                  </span>
                )}
              </label>
            )}
            {!selected && unsupportedAccess && (
              <p className="text-xs text-warning">
                {agentProviderLabel(provider)} cannot enforce read-only access remotely. Choose a
                supported access mode.
              </p>
            )}
            {!selected && cloudTarget && provider !== 'codex' && (
              <p className="text-xs text-warning">
                Cloud workers support Codex for launch. Select Codex in the chat header.
              </p>
            )}
            {!selected && (
              <>
                <label className="text-xs text-text-secondary" htmlFor="remote-chat-device">
                  Device
                </label>
                <select
                  id="remote-chat-device"
                  className={fieldClass}
                  value={target}
                  onChange={(event) => {
                    setTarget(event.target.value);
                    setCredentialChoice(
                      devices.find((device) => device.enrollmentId === event.target.value)
                        ?.enrollmentClass === 'ephemeral'
                        ? 'codex-account'
                        : 'target-local',
                    );
                  }}
                >
                  <option value="">Choose a device</option>
                  {devices.map((device) => (
                    <option key={device.enrollmentId} value={device.enrollmentId}>
                      {device.displayName ?? device.enrollmentId.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </>
            )}
            <span className="text-xs text-text-secondary">
              {agentProviderLabel(selected?.provider ?? provider)} · {selected?.model ?? model} ·{' '}
              {chatAccessLevelLabel(selected?.permissionMode ?? permissionMode)}
            </span>
            {active && (
              <button
                type="button"
                className={fieldClass}
                disabled={busy || selected.state === 'cancel-requested'}
                onClick={() =>
                  void act(() => window.anvil.syncRuntime.cancelRemoteChat(selected.id))
                }
              >
                Stop
              </button>
            )}
          </div>
          {!selected && devices.length === 0 && (
            <p className="text-xs text-text-secondary">
              Enroll a destination and approve it in Settings before starting remote work.
            </p>
          )}
          {!selected && (
            <p className="text-xs text-text-secondary">
              Uses the provider, model and access mode selected above. The destination needs that
              provider installed, with remote work enabled. Authentication runs on that device.
            </p>
          )}
          {selected && (
            <div className="max-h-64 space-y-3 overflow-y-auto text-sm" aria-live="polite">
              <p className="text-text-secondary">
                {LABELS[selected.state] ?? selected.state} on{' '}
                {devices.find((device) => device.enrollmentId === selected.targetEnrollmentId)
                  ?.displayName ?? selected.targetEnrollmentId.slice(0, 8)}
              </p>
              {selected.turns.map((turn) => (
                <div key={turn.id} className="space-y-1">
                  <p className="whitespace-pre-wrap font-medium">{turn.prompt}</p>
                  {turn.response && <p className="whitespace-pre-wrap">{turn.response}</p>}
                  {turn.error && <p className="text-error">{turn.error}</p>}
                </div>
              ))}
              {selected.error && <p className="text-error">{selected.error}</p>}
              {activity.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-text-secondary">Activity</summary>
                  <pre className="whitespace-pre-wrap text-xs">
                    {activity
                      .map(
                        (item) =>
                          `${item.gapBefore ? '[Earlier activity omitted]\n' : ''}${item.text}`,
                      )
                      .join('\n')}
                  </pre>
                </details>
              )}
            </div>
          )}
          {approvals.map((approval) => (
            <div key={approval.id} className="space-y-2 rounded border border-border p-2">
              <p className="text-sm">Approval requested</p>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-xs">
                {approval.details ??
                  'Action details unavailable. Open Mesh executions to inspect this request.'}
              </pre>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={fieldClass}
                  disabled={busy || !approval.details}
                  onClick={() =>
                    void act(() =>
                      window.anvil.syncRuntime.decideMeshApproval(approval.id, 'approved'),
                    )
                  }
                >
                  Approve
                </button>
                <button
                  type="button"
                  className={fieldClass}
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      window.anvil.syncRuntime.decideMeshApproval(approval.id, 'denied'),
                    )
                  }
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
          {retryHandoff && (
            <p className="text-xs text-text-secondary">
              The destination owns this session. Retry starts a new provider turn from the
              transferred checkpoint and keeps the destination's work.
            </p>
          )}
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <label className="sr-only" htmlFor="remote-chat-prompt">
              {retryHandoff ? 'Retry instructions' : selected ? 'Follow-up message' : 'Remote task'}
            </label>
            <textarea
              id="remote-chat-prompt"
              className={`${fieldClass} min-h-16 flex-1`}
              value={prompt}
              disabled={active || busy || !canSend}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={
                active
                  ? 'You can send a follow-up when this turn finishes.'
                  : retryHandoff
                    ? 'Instructions for a new turn on the destination…'
                    : selected
                      ? 'Send a follow-up on the same device…'
                      : 'What should the remote agent do?'
              }
            />
            <button
              type="submit"
              className={fieldClass}
              disabled={
                busy ||
                active ||
                !canSend ||
                !prompt.trim() ||
                (!selected &&
                  (!target || unsupportedAccess || (cloudTarget && provider !== 'codex')))
              }
            >
              {busy
                ? 'Sending…'
                : retryHandoff
                  ? 'Retry on destination'
                  : selected
                    ? 'Send follow-up'
                    : 'Start remotely'}
            </button>
          </form>
          {error && (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
