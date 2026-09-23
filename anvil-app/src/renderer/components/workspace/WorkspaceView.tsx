import { useCallback, useEffect, useState } from 'react';
import { FolderSearch, LayoutDashboard, Link2 } from 'lucide-react';
import type { WorkspaceRepoDefinition } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { ReposView } from '../repos/ReposView';
import { Button } from '../ui';
import { InlineNotice, ViewHeader } from '../layout/ViewScaffold';

/**
 * WS2: workspace home at `/workspace`.
 *
 * The repositories management surface (list, detail, readiness strip,
 * add/remove) is the primary section of the workspace — it renders below a
 * workspace-scoped header that carries the workspace name, the truthful
 * status label, and (WS3) a needs-checkout banner when synced repo
 * definitions haven't been mapped to local checkouts on this device.
 *
 * `/repos` keeps rendering `ReposView` standalone for compatibility.
 */
export function WorkspaceView() {
  const { activeWorkspace, featureAvailability, refreshWorkspaces } = useWorkspace();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader
        icon={LayoutDashboard}
        title={activeWorkspace?.name ?? 'Workspace'}
        meta={
          <span className="rounded-md bg-bg-tertiary px-2 py-0.5 text-xs capitalize text-text-tertiary">
            {featureAvailability.statusLabel.replace('-', ' ')}
          </span>
        }
      />
      <NeedsCheckoutBanner onChanged={() => void refreshWorkspaces()} />
      {/* Repositories section — the workspace's primary management surface. */}
      <div className="min-h-0 flex-1">
        <ReposView />
      </div>
    </div>
  );
}

/**
 * WS3: shown when the workspace has portable repo definitions that aren't
 * mapped to a local checkout on this device. Each entry offers "Link existing
 * folder" (workspace:link-repo) and, when a remote URL exists, "Clone to…"
 * (workspace:startClone, journalled).
 */
function NeedsCheckoutBanner({ onChanged }: { onChanged: () => void }) {
  const { activeWorkspace } = useWorkspace();
  const [unmapped, setUnmapped] = useState<WorkspaceRepoDefinition[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!activeWorkspace) {
      setUnmapped([]);
      return;
    }
    try {
      const definitions = await window.anvil.workspace.repoDefinitions(activeWorkspace.id);
      setUnmapped(definitions.filter((def) => def.mappedRepoId === null));
    } catch {
      setUnmapped([]);
    }
  }, [activeWorkspace]);

  useEffect(() => {
    void refresh();
  }, [refresh, activeWorkspace?.definitionState]);

  if (unmapped.length === 0) return null;

  const linkFolder = async (def: WorkspaceRepoDefinition) => {
    if (!activeWorkspace) return;
    const path = await window.anvil.repo.selectDirectory();
    if (!path) return;
    setBusy(def.portableId);
    setError(null);
    try {
      const result = await window.anvil.workspace.linkRepo(
        activeWorkspace.id,
        def.portableId,
        path,
      );
      if (result.status === 'divergence') {
        setError(
          `"${def.name}" — the folder's remote (${result.actualRemoteUrl ?? 'unknown'}) differs from the definition (${result.expectedRemoteUrl ?? 'unknown'}).`,
        );
      } else if (result.status === 'failed') {
        setError(`"${def.name}" — ${result.error ?? 'link failed'}`);
      }
      await refresh();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Link failed');
    } finally {
      setBusy(null);
    }
  };

  const cloneTo = async (def: WorkspaceRepoDefinition) => {
    if (!activeWorkspace) return;
    const destinationRoot = await window.anvil.repo.selectDirectory();
    if (!destinationRoot) return;
    setBusy(def.portableId);
    setError(null);
    try {
      const result = await window.anvil.workspace.startClone({
        workspaceId: activeWorkspace.id,
        destinationRoot,
        repos: [{ portableId: def.portableId, ref: def.defaultBranch }],
      });
      const outcome = result.repos.find((entry) => entry.portableId === def.portableId);
      if (result.status !== 'completed' && outcome?.reason) {
        setError(`"${def.name}" — clone ${outcome.stage}: ${outcome.reason}`);
      }
      await refresh();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clone failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="border-b border-warning/25 bg-warning/5 px-4 py-3">
      <InlineNotice tone="warning" className="border-0 bg-transparent p-0">
        <div>
          <p className="font-medium text-text-primary">This workspace needs checkouts</p>
          <p className="mt-0.5">
            {unmapped.length === 1
              ? 'One repository from the synced definition has no local checkout yet.'
              : `${unmapped.length} repositories from the synced definition have no local checkout yet.`}{' '}
            Link an existing folder or clone to a new one.
          </p>
          <ul className="mt-2 space-y-1.5">
            {unmapped.map((def) => (
              <li key={def.portableId} className="flex items-center gap-2">
                <FolderSearch size={13} className="shrink-0 text-warning" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-medium text-text-primary">
                  {def.name}
                  {def.defaultBranch && (
                    <span className="ml-1.5 font-normal text-text-tertiary">
                      {def.defaultBranch}
                    </span>
                  )}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void linkFolder(def)}
                >
                  <Link2 size={12} aria-hidden="true" />
                  Link folder
                </Button>
                {def.remoteUrl && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void cloneTo(def)}
                  >
                    {busy === def.portableId ? 'Working…' : 'Clone to…'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {error && <p className="mt-2 text-error">{error}</p>}
        </div>
      </InlineNotice>
    </div>
  );
}
