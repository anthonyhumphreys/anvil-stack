import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FolderSearch, LayoutDashboard, Link2 } from 'lucide-react';
import type { WorkspaceRepoDefinition } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { ReposView } from '../repos/ReposView';
import { Button, cx } from '../ui';
import { InlineNotice, ViewHeader } from '../layout/ViewScaffold';
import {
  OverviewBoard,
  OverviewHeaderActions,
  overviewLayoutLabel,
} from '../overview/OverviewBoard';
import { plural } from '../overview/overview-format';
import { useOverviewBoard } from '../overview/useOverviewBoard';

type WorkspaceTab = 'overview' | 'repositories';

const TABS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'repositories', label: 'Repositories' },
];

/**
 * WS2: workspace home at `/workspace`.
 *
 * ANV-51: Overview (default) and Repositories are sibling tabs. The
 * repositories management surface (list, detail, readiness strip,
 * add/remove) keeps its behaviour under `?view=repositories`; a `repo`
 * query param also opens it so Activity links land on the right detail.
 * The workspace-scoped header carries the workspace name, the truthful
 * status label, and (WS3) a needs-checkout banner when synced repo
 * definitions haven't been mapped to local checkouts on this device.
 *
 * `/repos` keeps rendering `ReposView` standalone for compatibility.
 */
export function WorkspaceView() {
  const { activeWorkspace, featureAvailability, refreshWorkspaces, repos } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: WorkspaceTab =
    searchParams.get('view') === 'repositories' || searchParams.has('repo')
      ? 'repositories'
      : 'overview';

  const selectTab = (next: WorkspaceTab) => {
    if (next === tab) return;
    setSearchParams(next === 'repositories' ? { view: 'repositories' } : {});
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {tab === 'overview' && activeWorkspace ? (
        <WorkspaceOverview
          key={activeWorkspace.id}
          workspaceId={activeWorkspace.id}
          title={activeWorkspace.name}
          repoCount={repos.length}
          statusLabel={featureAvailability.statusLabel}
          tabs={<WorkspaceTabs tab={tab} onSelect={selectTab} />}
          onChanged={() => void refreshWorkspaces()}
        />
      ) : (
        <>
          <ViewHeader
            icon={LayoutDashboard}
            title={activeWorkspace?.name ?? 'Workspace'}
            meta={<StatusChip label={featureAvailability.statusLabel} />}
            className="border-b-0 pb-0"
          />
          <WorkspaceTabs tab={tab} onSelect={selectTab} />
          <NeedsCheckoutBanner onChanged={() => void refreshWorkspaces()} />
          {/* Repositories section — the workspace's management surface. */}
          <div className="min-h-0 flex-1">
            <ReposView />
          </div>
        </>
      )}
    </div>
  );
}

function WorkspaceOverview({
  workspaceId,
  title,
  repoCount,
  statusLabel,
  tabs,
  onChanged,
}: {
  workspaceId: string;
  title: string;
  repoCount: number;
  statusLabel: string;
  tabs: React.ReactNode;
  onChanged: () => void;
}) {
  const board = useOverviewBoard({ kind: 'workspace', workspaceId });
  return (
    <>
      <ViewHeader
        icon={LayoutDashboard}
        title={board.editing ? 'Customise overview' : title}
        meta={board.editing ? undefined : <StatusChip label={statusLabel} />}
        description={
          board.editing
            ? `${title} · ${overviewLayoutLabel(board)}`
            : `Overview of ${plural(repoCount, 'repository', 'repositories')} · ${overviewLayoutLabel(board)}`
        }
        actions={<OverviewHeaderActions board={board} />}
        className="border-b-0 pb-0"
      />
      {tabs}
      <NeedsCheckoutBanner onChanged={onChanged} />
      <OverviewBoard board={board} />
    </>
  );
}

function StatusChip({ label }: { label: string }) {
  return (
    <span className="rounded-md bg-bg-tertiary px-2 py-0.5 text-xs capitalize text-text-tertiary">
      {label.replace('-', ' ')}
    </span>
  );
}

function WorkspaceTabs({
  tab,
  onSelect,
}: {
  tab: WorkspaceTab;
  onSelect: (tab: WorkspaceTab) => void;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = TABS.findIndex((entry) => entry.id === tab);
    const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length];
    onSelect(next.id);
    requestAnimationFrame(() => document.getElementById(`workspace-tab-${next.id}`)?.focus());
  };
  return (
    <div className="shrink-0 border-b border-border bg-bg-secondary/45 px-5">
      <div
        role="tablist"
        aria-label="Workspace views"
        className="flex gap-5"
        onKeyDown={handleKeyDown}
      >
        {TABS.map((entry) => {
          const selected = entry.id === tab;
          return (
            <button
              key={entry.id}
              id={`workspace-tab-${entry.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(entry.id)}
              className={cx(
                'relative -mb-px border-b-2 pb-2.5 pt-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                selected
                  ? 'border-accent text-text-primary'
                  : 'border-transparent text-text-tertiary hover:text-text-primary',
              )}
            >
              {entry.label}
            </button>
          );
        })}
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
