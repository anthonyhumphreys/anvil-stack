import { useEffect, useState } from 'react';
import type { RepoInfo, WorkspaceScaffoldSession } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useRepoIndex } from '../../contexts/RepoIndexContext';
import { ConfirmDialog } from '../ui';

/**
 * Pure seam for the removal flow (§5 edge cases): repos cannot be removed
 * while a scaffold session is active, syncing, or indexing.
 */
export function isRepoRemovalBlocked(
  session: WorkspaceScaffoldSession | null | undefined,
): boolean {
  return session != null && ['active', 'syncing', 'indexing'].includes(session.status);
}

/**
 * True when `repoId` is still referenced by a workspace other than
 * `excludeWorkspaceId`. `repo:forget` refuses while references remain, so the
 * dialog only offers "also forget" when this returns false.
 */
export function repoUsedOutsideWorkspace(
  repoId: string,
  workspaceRepoIds: ReadonlyMap<string, readonly string[]>,
  excludeWorkspaceId?: string | null,
): boolean {
  for (const [workspaceId, repoIds] of workspaceRepoIds) {
    if (workspaceId === excludeWorkspaceId) continue;
    if (repoIds.includes(repoId)) return true;
  }
  return false;
}

/**
 * Remove-from-workspace confirmation (X1, plan §5).
 *
 * Default path calls `workspace:remove-repos` — files stay on disk, index data
 * is kept, and any queued/running index job is cancelled server-side. When the
 * repo isn't referenced by any other workspace, an optional "also forget the
 * index" checkbox additionally calls `repo:forget` (X2); reviews and audits
 * are kept orphaned by design.
 *
 * Removal is disabled while a scaffold session is active, syncing or
 * indexing (edge case per plan §5).
 */
export function RemoveRepoDialog({
  repo,
  open,
  onClose,
  onRemoved,
}: {
  repo: RepoInfo | null;
  open: boolean;
  onClose: () => void;
  onRemoved?: () => void;
}) {
  const { activeWorkspace, activeScaffoldSession, removeRepos, workspaces } = useWorkspace();
  const repoIndex = useRepoIndex();
  const [alsoForget, setAlsoForget] = useState(false);
  const [usedElsewhere, setUsedElsewhere] = useState<boolean | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const removalBlocked = isRepoRemovalBlocked(activeScaffoldSession);

  // Determine whether another workspace still references this repo so the
  // "also forget" option only shows when `repo:forget` can succeed (§5).
  useEffect(() => {
    if (!open || !repo) return;
    let cancelled = false;
    setUsedElsewhere(null);
    setAlsoForget(false);
    setError(null);
    (async () => {
      try {
        const repoIdsByWorkspace = new Map<string, readonly string[]>();
        const others = workspaces.filter((ws) => ws.id !== activeWorkspace?.id);
        for (const ws of others) {
          const detail = await window.anvil.workspace.get(ws.id);
          repoIdsByWorkspace.set(
            ws.id,
            detail.repos.map((r) => r.id),
          );
        }
        if (!cancelled) {
          setUsedElsewhere(repoUsedOutsideWorkspace(repo.id, repoIdsByWorkspace));
        }
      } catch {
        if (!cancelled) setUsedElsewhere(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, repo, workspaces, activeWorkspace?.id]);

  if (!repo) return null;

  const handleConfirm = async () => {
    if (removalBlocked) return;
    setWorking(true);
    setError(null);
    try {
      // Cancel any queued/running job up-front so the card can't get stuck
      // in "indexing" even if the server-side cancel is skipped.
      await repoIndex.cancelIndex(repo.id).catch(() => undefined);
      await removeRepos([repo.id]);
      if (alsoForget) {
        try {
          await window.anvil.repo.forget(repo.id);
        } catch (err) {
          // Forget is best-effort — the removal already succeeded.
          setError(
            err instanceof Error
              ? `Removed, but forgetting the index failed: ${err.message}`
              : 'Removed, but forgetting the index failed.',
          );
          setWorking(false);
          onRemoved?.();
          return;
        }
      }
      await repoIndex.refresh();
      setWorking(false);
      onRemoved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove the repository.');
      setWorking(false);
    }
  };

  return (
    <ConfirmDialog
      open={open}
      tone="danger"
      title={`Remove ${repo.name} from "${activeWorkspace?.name ?? 'this workspace'}"?`}
      description={
        <div className="space-y-3">
          <p>
            {removalBlocked
              ? 'This workspace is being scaffolded right now — repositories can be removed once setup finishes.'
              : 'The folder on disk won’t be touched. Chat threads and reviews in this workspace keep their history but won’t be able to read this repo’s code.'}
          </p>
          {!removalBlocked && usedElsewhere === false && (
            <label className="flex items-start gap-2 text-sm text-text-secondary">
              <input
                type="checkbox"
                className="accent-accent mt-0.5"
                checked={alsoForget}
                onChange={(event) => setAlsoForget(event.target.checked)}
              />
              <span>
                Also forget this repository’s index{' '}
                <span className="text-text-tertiary">
                  (it isn’t used by any other workspace; reviews keep orphaned history)
                </span>
              </span>
            </label>
          )}
          {error && <p className="text-sm text-error">{error}</p>}
        </div>
      }
      confirmLabel="Remove"
      loading={working}
      onConfirm={() => void handleConfirm()}
      onCancel={onClose}
    />
  );
}
