import { useCallback, useEffect, useState } from 'react';
import { Loader2, Play, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import type { WorkspaceBootstrapStatus } from '../../../shared/types';

interface WorkspaceBootstrapPanelProps {
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
}

/**
 * WS-03 approval surface: explains the synced bootstrap recipe, requires an
 * explicit local approval pinned to recipe + commits + policy, then starts a
 * journaled run. Approvals are device-local — they never sync.
 */
export function WorkspaceBootstrapPanel({
  workspaceId,
  workspaceName,
  onClose,
}: WorkspaceBootstrapPanelProps) {
  const [status, setStatus] = useState<WorkspaceBootstrapStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shellConsent, setShellConsent] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.anvil.workspace.bootstrapStatus(workspaceId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while a run is in-flight so step progress stays live.
  useEffect(() => {
    if (!status?.runs.some((run) => run.state === 'running')) return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [status, refresh]);

  const approveAndRun = async () => {
    setBusy(true);
    try {
      await window.anvil.workspace.bootstrapApprove(workspaceId, {
        shellApproved: shellConsent,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const latestRun = status?.runs[0] ?? null;
  const needsShell = status?.explanation?.usesShell === true;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={`Bootstrap ${workspaceName}`}
        className="mx-4 max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border-subtle bg-bg-secondary p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Workspace bootstrap</h2>
            <p className="text-sm text-text-tertiary">{workspaceName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </div>

        {error !== null && (
          <div className="mb-4 rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">
            {error}
          </div>
        )}

        {status === null ? (
          <div className="flex items-center gap-2 text-sm text-text-tertiary">
            <Loader2 size={15} className="animate-spin" /> Loading bootstrap status…
          </div>
        ) : status.recipe === null ? (
          <p className="text-sm text-text-secondary">
            This workspace definition has no bootstrap recipe.
          </p>
        ) : (
          <>
            {status.explanation !== null && (
              <div className="mb-4 space-y-2">
                <h3 className="text-sm font-medium text-text-primary">
                  {status.explanation.stepCount}{' '}
                  {status.explanation.stepCount === 1 ? 'step' : 'steps'}
                  {status.explanation.installsPackages && ' · installs packages'}
                  {status.explanation.envNames.length > 0 &&
                    ` · needs ${status.explanation.envNames.join(', ')}`}
                </h3>
                <ol className="space-y-1.5">
                  {status.explanation.steps.map((step) => (
                    <li
                      key={step.id}
                      className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-tertiary/50 px-3 py-2 text-sm"
                    >
                      <span className="shrink-0 rounded bg-bg-tertiary px-1.5 py-0.5 text-eyebrow font-semibold uppercase tracking-wide text-text-tertiary">
                        {step.kind}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">
                        {step.summary}
                      </span>
                      {step.shell && (
                        <span className="shrink-0 text-eyebrow font-semibold uppercase text-warning">
                          shell
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            )}

            <div className="mb-4 rounded-lg border border-border-subtle bg-bg-tertiary/40 px-3 py-2.5 text-xs text-text-secondary">
              {status.approved ? (
                <span className="flex items-center gap-1.5 text-success">
                  <ShieldCheck size={13} /> Approved on this device for the current recipe, commits,
                  and policy.
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <TriangleAlert size={13} className="text-warning" />
                  Approval is pinned to this exact recipe, your current commits, and the execution
                  policy. It stays on this device and never syncs.
                </span>
              )}
            </div>

            {needsShell && !status.approved && (
              <label className="mb-4 flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={shellConsent}
                  onChange={(event) => setShellConsent(event.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  This recipe uses shell interpretation. I understand shell steps can run arbitrary
                  commands and approve them for this device.
                </span>
              </label>
            )}

            <div className="mb-5 flex items-center gap-2">
              {!status.approved && (
                <button
                  type="button"
                  disabled={busy || (needsShell && !shellConsent)}
                  onClick={() => void approveAndRun()}
                  className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-bg-primary transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                  Approve and run
                </button>
              )}
              {status.approved && latestRun?.state !== 'running' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await window.anvil.workspace.bootstrapRun(workspaceId);
                      await refresh();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setBusy(false);
                    }
                  }}
                  className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-bg-primary transition-colors hover:bg-accent/90 disabled:opacity-50"
                >
                  <Play size={14} /> Run again
                </button>
              )}
            </div>

            {status.runs.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                  Runs
                </h3>
                <ul className="space-y-1.5">
                  {status.runs.slice(0, 5).map((run) => (
                    <li
                      key={run.id}
                      className="rounded-lg border border-border-subtle px-3 py-2 text-sm"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs text-text-tertiary">
                          {run.id.slice(0, 13)}…
                        </span>
                        <span
                          className={`text-xs font-semibold ${
                            run.state === 'verified'
                              ? 'text-success'
                              : run.state === 'running'
                                ? 'text-accent'
                                : run.state === 'awaiting-approval'
                                  ? 'text-warning'
                                  : 'text-error'
                          }`}
                        >
                          {run.state}
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {run.steps.map((step) => (
                          <span
                            key={step.stepId}
                            title={`${step.stepId}: ${step.state}`}
                            className={`rounded px-1.5 py-0.5 text-eyebrow font-medium ${
                              step.state === 'verified'
                                ? 'bg-success/15 text-success'
                                : step.state === 'running'
                                  ? 'bg-accent/15 text-accent'
                                  : step.state === 'failed' || step.state === 'unknown-outcome'
                                    ? 'bg-error/15 text-error'
                                    : 'bg-bg-tertiary text-text-tertiary'
                            }`}
                          >
                            {step.stepId}
                          </span>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
