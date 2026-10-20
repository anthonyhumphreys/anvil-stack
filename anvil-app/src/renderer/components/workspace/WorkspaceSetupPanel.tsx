import { useCallback, useEffect, useState } from 'react';
import { FolderGit2, FolderSearch, Loader2, X } from 'lucide-react';
import type {
  WorkspaceMaterializationOpSummary,
  WorkspaceRepoDefinition,
} from '../../../shared/types';

interface WorkspaceSetupPanelProps {
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
  onChanged?: () => void;
}

/**
 * WS-02 setup surface: for each unmapped repo definition, clone fresh into
 * a chosen root or link an existing local checkout. Materialisation is
 * journaled main-side; this panel just drives it and reports stages.
 */
export function WorkspaceSetupPanel({
  workspaceId,
  workspaceName,
  onClose,
  onChanged,
}: WorkspaceSetupPanelProps) {
  const [definitions, setDefinitions] = useState<WorkspaceRepoDefinition[] | null>(null);
  const [ops, setOps] = useState<WorkspaceMaterializationOpSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [defs, materialization] = await Promise.all([
        window.anvil.workspace.repoDefinitions(workspaceId),
        window.anvil.workspace.materializationOps(workspaceId),
      ]);
      setDefinitions(defs);
      setOps(materialization);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!ops.some((op) => op.state === 'running')) return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [ops, refresh]);

  const unmapped = (definitions ?? []).filter((def) => def.mappedRepoId === null);
  const latestOp = ops[0] ?? null;

  const cloneAll = async () => {
    const destinationRoot = await window.anvil.repo.selectDirectory();
    if (destinationRoot === null) return;
    setBusy('clone');
    try {
      const result = await window.anvil.workspace.startClone({ workspaceId, destinationRoot });
      if (result.status === 'failed') {
        setError(
          result.repos.find((repo) => repo.reason)?.reason ?? 'Clone failed for every repository.',
        );
      }
      await refresh();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const linkCheckout = async (portableId: string) => {
    const checkoutPath = await window.anvil.repo.selectDirectory();
    if (checkoutPath === null) return;
    setBusy(`link:${portableId}`);
    try {
      const result = await window.anvil.workspace.linkRepo(workspaceId, portableId, checkoutPath);
      if (result.status === 'divergence') {
        setError(
          `Linked with a remote divergence: expected ${result.expectedRemoteUrl ?? 'unknown'}, ` +
            `checkout uses ${result.actualRemoteUrl ?? 'unknown'}.`,
        );
      } else if (result.status === 'failed') {
        setError(result.error ?? 'Link failed.');
      }
      await refresh();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={`Set up ${workspaceName}`}
        className="mx-4 max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border-subtle bg-bg-secondary p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Workspace setup</h2>
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

        {definitions === null ? (
          <div className="flex items-center gap-2 text-sm text-text-tertiary">
            <Loader2 size={15} className="animate-spin" /> Loading repository definitions…
          </div>
        ) : unmapped.length === 0 ? (
          <p className="text-sm text-text-secondary">
            Every repository in this workspace is mapped to a local checkout.
          </p>
        ) : (
          <>
            <p className="mb-3 text-sm text-text-secondary">
              {unmapped.length} {unmapped.length === 1 ? 'repository needs' : 'repositories need'} a
              local checkout. Clone fresh into a folder, or link an existing checkout.
            </p>
            <ul className="mb-4 space-y-2">
              {unmapped.map((def) => (
                <li
                  key={def.portableId}
                  className="flex items-center gap-3 rounded-lg border border-border-subtle px-3 py-2.5"
                >
                  <FolderGit2 size={16} className="shrink-0 text-text-tertiary" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-text-primary">{def.name}</div>
                    {def.remoteUrl !== undefined && (
                      <div className="truncate font-mono text-xs text-text-tertiary">
                        {def.remoteUrl}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void linkCheckout(def.portableId)}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border-subtle px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
                  >
                    {busy === `link:${def.portableId}` ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <FolderSearch size={12} />
                    )}
                    Link checkout…
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void cloneAll()}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-bg-primary transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              {busy === 'clone' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <FolderGit2 size={14} />
              )}
              Clone all into a folder…
            </button>
          </>
        )}

        {latestOp !== null && (
          <div className="mt-5">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              Latest materialisation · {latestOp.state}
            </h3>
            <ul className="space-y-1">
              {latestOp.repos.map((repo) => (
                <li
                  key={repo.portableId}
                  className="flex items-center justify-between rounded-lg bg-bg-tertiary/50 px-3 py-1.5 text-xs"
                >
                  <span className="font-mono text-text-secondary">{repo.portableId}</span>
                  <span
                    className={
                      repo.stage === 'failed' || repo.stage === 'unsupported'
                        ? 'text-error'
                        : repo.stage === 'mapping-published'
                          ? 'text-success'
                          : 'text-text-tertiary'
                    }
                  >
                    {repo.stage}
                    {repo.reason !== undefined ? ` — ${repo.reason}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
