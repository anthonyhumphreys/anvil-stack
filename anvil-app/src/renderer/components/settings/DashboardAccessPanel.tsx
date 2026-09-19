import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Globe, Loader2, MonitorSmartphone, ShieldCheck } from 'lucide-react';
import type { SyncDashboardRequest } from '../../../shared/sync-runtime';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SCOPE_LABELS: Record<string, string> = {
  'read-dashboard': 'Read dashboard',
  'submit-task': 'Submit tasks',
  'approve-action': 'Approve actions',
  'request-handoff': 'Request handoffs',
};

function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

function stateChipClass(state: SyncDashboardRequest['state']): string {
  switch (state) {
    case 'approved':
      return 'bg-success/15 text-success';
    case 'pending':
      return 'bg-warning/15 text-warning';
    case 'denied':
    case 'revoked':
      return 'bg-error/15 text-error';
    default:
      return 'bg-bg-tertiary text-text-tertiary';
  }
}

function stateLabel(state: SyncDashboardRequest['state']): string {
  switch (state) {
    case 'approved':
      return 'Active';
    case 'pending':
      return 'Waiting for approval';
    case 'denied':
      return 'Denied';
    case 'revoked':
      return 'Revoked';
    case 'expired':
      return 'Expired';
  }
}

/**
 * DASH-01: trusted-device side of browser dashboard authorization. Shows
 * what the browser claims (origin, user agent, scopes) and lets the user
 * approve a scope subset, deny, or revoke. The DSK never crosses IPC —
 * the sealed grant is built and delivered entirely in the main process.
 */
export function DashboardAccessPanel(): ReactNode {
  const [requests, setRequests] = useState<SyncDashboardRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [scopeDrafts, setScopeDrafts] = useState<Record<string, string[]>>({});
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.anvil.syncRuntime.listDashboardRequests();
      setRequests(next);
      setScopeDrafts((prev) => {
        const drafts = { ...prev };
        for (const request of next) {
          // Seed each pending request's draft once — user edits survive
          // polls, and decided rows drop out of the map entirely.
          if (request.state === 'pending' && drafts[request.requestId] === undefined) {
            drafts[request.requestId] = [...request.scopes];
          }
          if (request.state !== 'pending') {
            delete drafts[request.requestId];
          }
        }
        return drafts;
      });
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const handleDecide = async (
    request: SyncDashboardRequest,
    decision: 'approved' | 'denied',
  ): Promise<void> => {
    setBusyKey(`${decision}:${request.requestId}`);
    setError(null);
    try {
      const scopes = scopeDrafts[request.requestId] ?? request.scopes;
      await window.anvil.syncRuntime.decideDashboardRequest(
        request.requestId,
        decision,
        decision === 'approved' ? scopes : undefined,
      );
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleRevoke = async (requestId: string): Promise<void> => {
    setBusyKey(`revoke:${requestId}`);
    setError(null);
    try {
      await window.anvil.syncRuntime.revokeDashboardAccess(requestId);
      setConfirmingRevokeId(null);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  };

  const toggleScope = (requestId: string, scope: string): void => {
    setScopeDrafts((prev) => {
      const current = prev[requestId] ?? [];
      const next = current.includes(scope)
        ? current.filter((s) => s !== scope)
        : [...current, scope];
      return { ...prev, [requestId]: next };
    });
  };

  const pending = (requests ?? []).filter((r) => r.state === 'pending');
  const active = (requests ?? []).filter((r) => r.state === 'approved');

  return (
    <div className="space-y-3">
      {requests === null && error === null && (
        <p className="flex items-center gap-2 text-sm text-text-tertiary">
          <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
          Checking for browser requests…
        </p>
      )}

      {requests !== null && pending.length === 0 && active.length === 0 && (
        <p className="text-sm text-text-tertiary">
          No browser sessions requested dashboard access. When you open the web dashboard, its
          request appears here for approval.
        </p>
      )}

      {pending.length > 0 && (
        <ul className="space-y-2">
          {pending.map((request) => {
            const draft = scopeDrafts[request.requestId] ?? request.scopes;
            return (
              <li
                key={request.requestId}
                className="rounded-md border border-warning/40 bg-warning/5 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2">
                    <Globe size={15} className="mt-0.5 shrink-0 text-text-tertiary" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text-primary">
                        {request.origin ?? 'Browser session'}
                      </p>
                      <p className="mt-0.5 text-xs text-text-tertiary">
                        {request.userAgent ?? 'unknown browser'} · expires{' '}
                        {new Date(request.expiresAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${stateChipClass(request.state)}`}
                  >
                    {stateLabel(request.state)}
                  </span>
                </div>
                <fieldset className="mt-2">
                  <legend className="text-xs text-text-tertiary">
                    This browser is asking for:
                  </legend>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
                    {request.scopes.map((scope) => (
                      <label
                        key={scope}
                        className="flex items-center gap-1.5 text-xs text-text-secondary"
                      >
                        <input
                          type="checkbox"
                          checked={draft.includes(scope)}
                          onChange={() => toggleScope(request.requestId, scope)}
                          disabled={busyKey !== null}
                          className="accent-accent"
                        />
                        {scopeLabel(scope)}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <p className="mt-2 text-xs text-text-tertiary">
                  Approving mints a dashboard key sealed to this browser only — uncheck any
                  capability you do not want it to have. Denying ends the request.
                </p>
                <div className="mt-2 flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleDecide(request, 'approved')}
                    disabled={busyKey !== null || draft.length === 0}
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
                  >
                    {busyKey === `approved:${request.requestId}`
                      ? 'Approving…'
                      : `Approve${draft.length === request.scopes.length ? '' : ` ${draft.length} scope${draft.length === 1 ? '' : 's'}`}`}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDecide(request, 'denied')}
                    disabled={busyKey !== null}
                    className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-error disabled:opacity-50"
                  >
                    {busyKey === `denied:${request.requestId}` ? 'Denying…' : 'Deny'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {active.length > 0 && (
        <ul className="space-y-2">
          {active.map((request) => (
            <li key={request.requestId} className="rounded-md border border-border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2">
                  <MonitorSmartphone size={15} className="mt-0.5 shrink-0 text-text-tertiary" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {request.origin ?? 'Browser session'}
                    </p>
                    <p className="mt-0.5 text-xs text-text-tertiary">
                      {request.scopes.map(scopeLabel).join(' · ')} — until{' '}
                      {new Date(request.expiresAt).toLocaleString()}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span
                    className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${stateChipClass(request.state)}`}
                  >
                    <ShieldCheck size={11} />
                    {stateLabel(request.state)}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setConfirmingRevokeId(
                        confirmingRevokeId === request.requestId ? null : request.requestId,
                      )
                    }
                    aria-expanded={confirmingRevokeId === request.requestId}
                    disabled={busyKey !== null}
                    className="rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-error disabled:opacity-50"
                  >
                    Revoke
                  </button>
                </div>
              </div>
              {confirmingRevokeId === request.requestId && (
                <div className="mt-2 rounded-md border border-error/30 bg-error/5 p-2">
                  <p className="text-xs text-text-secondary">
                    Revoke this browser session? Its dashboard goes locked immediately and it must
                    request access again.
                  </p>
                  <div className="mt-2 flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => void handleRevoke(request.requestId)}
                      disabled={busyKey !== null}
                      className="rounded-md border border-error/50 bg-error/10 px-3 py-1 text-xs font-medium text-error transition-colors hover:bg-error/20 disabled:opacity-50"
                    >
                      {busyKey === `revoke:${request.requestId}`
                        ? 'Revoking…'
                        : 'Revoke session'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingRevokeId(null)}
                      className="rounded-md border border-border px-3 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {error !== null && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
    </div>
  );
}
