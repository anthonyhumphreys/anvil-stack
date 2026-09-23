import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Globe, Loader2, MonitorSmartphone, ShieldCheck } from 'lucide-react';
import type {
  SyncDashboardGrantWorkspace,
  SyncDashboardRequest,
} from '../../../shared/sync-runtime';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SCOPE_LABELS: Record<string, string> = {
  'read-dashboard': 'Read dashboard',
  'workspace-read': 'Read workspace',
  'workspace-write': 'Edit workspace files',
  'submit-task': 'Submit tasks',
  'approve-action': 'Approve actions',
  'request-handoff': 'Request handoffs',
  terminal: 'Run shell commands',
  preview: 'Open development previews',
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

interface ScopeDraft {
  workspaceId: string;
  repoIds: string[];
  actionScopes: string[];
}

function emptyDraft(): ScopeDraft {
  return { workspaceId: '', repoIds: [], actionScopes: [] };
}

/**
 * DASH-01: trusted-device side of browser dashboard authorization. A grant
 * names one local workspace and an explicit repository subset. Action scopes
 * start empty, so approving enrollment alone never starts execution.
 */
export function DashboardAccessPanel(): ReactNode {
  const [requests, setRequests] = useState<SyncDashboardRequest[] | null>(null);
  const [workspaces, setWorkspaces] = useState<SyncDashboardGrantWorkspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ScopeDraft>>({});
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextRequests, nextWorkspaces] = await Promise.all([
        window.anvil.syncRuntime.listDashboardRequests(),
        window.anvil.syncRuntime.listDashboardWorkspaces(),
      ]);
      setRequests(nextRequests);
      setWorkspaces(nextWorkspaces);
      setDrafts((previous) => {
        const next = { ...previous };
        for (const request of nextRequests) {
          if (request.state === 'pending' && next[request.requestId] === undefined) {
            next[request.requestId] = emptyDraft();
          }
          if (request.state !== 'pending') delete next[request.requestId];
        }
        return next;
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

  const updateDraft = (requestId: string, update: Partial<ScopeDraft>): void => {
    setDrafts((previous) => ({
      ...previous,
      [requestId]: { ...(previous[requestId] ?? emptyDraft()), ...update },
    }));
  };

  const selectWorkspace = (requestId: string, workspaceId: string): void => {
    updateDraft(requestId, { workspaceId, repoIds: [] });
  };

  const toggleRepo = (requestId: string, repoId: string): void => {
    const draft = drafts[requestId] ?? emptyDraft();
    const repoIds = draft.repoIds.includes(repoId)
      ? draft.repoIds.filter((id) => id !== repoId)
      : [...draft.repoIds, repoId];
    updateDraft(requestId, { repoIds });
  };

  const toggleScope = (requestId: string, scope: string): void => {
    const draft = drafts[requestId] ?? emptyDraft();
    const actionScopes = draft.actionScopes.includes(scope)
      ? draft.actionScopes.filter((value) => value !== scope)
      : [...draft.actionScopes, scope];
    updateDraft(requestId, { actionScopes });
  };

  const handleDecide = async (
    request: SyncDashboardRequest,
    decision: 'approved' | 'denied',
  ): Promise<void> => {
    setBusyKey(`${decision}:${request.requestId}`);
    setError(null);
    try {
      const draft = drafts[request.requestId] ?? emptyDraft();
      await window.anvil.syncRuntime.decideDashboardRequest(
        request.requestId,
        decision,
        decision === 'approved'
          ? {
              workspaceId: draft.workspaceId,
              repoIds: draft.repoIds,
              actionScopes: draft.actionScopes,
            }
          : undefined,
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

  const workspaceById = useMemo(
    () => new Map((workspaces ?? []).map((workspace) => [workspace.workspaceId, workspace])),
    [workspaces],
  );
  const pending = (requests ?? []).filter((request) => request.state === 'pending');
  const active = (requests ?? []).filter((request) => request.state === 'approved');

  return (
    <div className="space-y-3">
      {requests === null && error === null && (
        <p className="flex items-center gap-2 text-sm text-text-tertiary">
          <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
          Checking for browser requests...
        </p>
      )}

      {requests !== null && pending.length === 0 && active.length === 0 && (
        <p className="text-sm text-text-tertiary">
          No browser sessions requested dashboard access. Open the web dashboard to create a
          request.
        </p>
      )}

      {pending.length > 0 && (
        <ul className="space-y-2">
          {pending.map((request) => {
            const draft = drafts[request.requestId] ?? emptyDraft();
            const selectedWorkspace = (workspaces ?? []).find(
              (workspace) => workspace.workspaceId === draft.workspaceId,
            );
            const canApprove = draft.workspaceId !== '' && draft.repoIds.length > 0;
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
                        {request.userAgent ?? 'Unknown browser'} · expires{' '}
                        {new Date(request.expiresAt).toLocaleString()}
                      </p>
                      {request.verificationCode !== undefined && (
                        <p className="mt-1 text-xs text-text-secondary">
                          Compare code with the requesting browser:{' '}
                          <span className="font-mono font-medium tracking-wider text-text-primary">
                            {request.verificationCode}
                          </span>
                        </p>
                      )}
                      <p className="mt-1 text-xs text-text-tertiary">
                        Origin and browser details are hints, not proof of browser identity.
                      </p>
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${stateChipClass(request.state)}`}
                  >
                    {stateLabel(request.state)}
                  </span>
                </div>

                <fieldset className="mt-3">
                  <legend className="text-xs font-medium text-text-secondary">
                    Desktop access
                  </legend>
                  <p className="mt-1 text-xs text-text-tertiary">
                    Choose exactly where this browser may work. Nothing is selected automatically.
                  </p>
                  <label className="mt-2 block text-xs text-text-secondary">
                    <span className="sr-only">Workspace</span>
                    <select
                      value={draft.workspaceId}
                      onChange={(event) => selectWorkspace(request.requestId, event.target.value)}
                      disabled={busyKey !== null}
                      className="w-full rounded-md border border-border bg-bg-primary px-2.5 py-2 text-xs text-text-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
                    >
                      <option value="">Select a workspace</option>
                      {(workspaces ?? []).map((workspace) => (
                        <option key={workspace.workspaceId} value={workspace.workspaceId}>
                          {workspace.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </fieldset>

                <fieldset className="mt-3">
                  <legend className="text-xs font-medium text-text-secondary">Repositories</legend>
                  {selectedWorkspace === undefined ? (
                    <p className="mt-1 text-xs text-text-tertiary">
                      Select a workspace to choose repositories.
                    </p>
                  ) : selectedWorkspace.repos.length === 0 ? (
                    <p className="mt-1 text-xs text-text-tertiary">
                      This workspace has no local repositories.
                    </p>
                  ) : (
                    <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                      {selectedWorkspace.repos.map((repo) => (
                        <label
                          key={repo.repoId}
                          className="flex min-w-0 items-center gap-2 text-xs text-text-secondary"
                        >
                          <input
                            type="checkbox"
                            checked={draft.repoIds.includes(repo.repoId)}
                            onChange={() => toggleRepo(request.requestId, repo.repoId)}
                            disabled={busyKey !== null}
                            className="accent-accent"
                          />
                          <span className="truncate">{repo.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </fieldset>

                <fieldset className="mt-3">
                  <legend className="text-xs font-medium text-text-secondary">
                    Action permissions
                  </legend>
                  <p className="mt-1 text-xs text-text-tertiary">
                    Dashboard snapshots stay read-only; workspace actions start unchecked.
                  </p>
                  <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                    {request.scopes
                      .filter((scope) => scope !== 'read-dashboard')
                      .map((scope) => (
                        <label
                          key={scope}
                          className="flex min-w-0 items-center gap-2 text-xs text-text-secondary"
                        >
                          <input
                            type="checkbox"
                            checked={draft.actionScopes.includes(scope)}
                            onChange={() => toggleScope(request.requestId, scope)}
                            disabled={busyKey !== null}
                            className="accent-accent"
                          />
                          <span>{scopeLabel(scope)}</span>
                        </label>
                      ))}
                  </div>
                </fieldset>

                <p className="mt-3 text-xs text-text-tertiary">
                  Approving binds a dashboard key to this browser, workspace, and repository
                  selection. Terminal access runs with this Desktop user's permissions.
                </p>
                <div className="mt-2 flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleDecide(request, 'approved')}
                    disabled={busyKey !== null || !canApprove}
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-50"
                  >
                    {busyKey === `approved:${request.requestId}`
                      ? 'Approving...'
                      : 'Approve access'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDecide(request, 'denied')}
                    disabled={busyKey !== null}
                    className="rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-error disabled:opacity-50"
                  >
                    {busyKey === `denied:${request.requestId}` ? 'Denying...' : 'Deny'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {active.length > 0 && (
        <ul className="space-y-2">
          {active.map((request) => {
            const workspace = request.workspace;
            const workspaceName =
              workspace === undefined
                ? 'Legacy dashboard grant'
                : (workspaceById.get(workspace.workspaceId)?.name ?? workspace.workspaceId);
            return (
              <li key={request.requestId} className="rounded-md border border-border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2">
                    <MonitorSmartphone size={15} className="mt-0.5 shrink-0 text-text-tertiary" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text-primary">
                        {request.origin ?? 'Browser session'}
                      </p>
                      <p className="mt-0.5 text-xs text-text-tertiary">
                        {workspaceName} · {workspace?.repoIds.length ?? 0} repositories · until{' '}
                        {new Date(request.expiresAt).toLocaleString()}
                      </p>
                      <p className="mt-1 truncate text-xs text-text-tertiary">
                        {request.scopes.map(scopeLabel).join(' · ') || 'Read-only dashboard'}
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
                      Revoke this browser session? It will stop receiving snapshots and commands.
                    </p>
                    <div className="mt-2 flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => void handleRevoke(request.requestId)}
                        disabled={busyKey !== null}
                        className="rounded-md border border-error/50 bg-error/10 px-3 py-1 text-xs font-medium text-error transition-colors hover:bg-error/20 disabled:opacity-50"
                      >
                        {busyKey === `revoke:${request.requestId}`
                          ? 'Revoking...'
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
            );
          })}
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
