import { useEffect, useMemo, useState } from 'react';
import { FolderOpen, Loader2, Search } from 'lucide-react';
import type { RemoteRepo } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { RepoScanner } from './RepoScanner';
import { Button, Dialog, SegmentedControl, cx } from '../ui';
import { SettingsLink } from './SettingsLink';

/**
 * Unified "add repositories" surface (RM1): Local · Clone · Scaffold.
 *
 * Used by the Workspace/Repos view ("Add repositories") and by the workspace
 * creator. The panel subcomponents are exported so the creator can render the
 * same pickers inline before the workspace exists.
 */

// ---------------------------------------------------------------------------
// Local tab — folder scan + selection
// ---------------------------------------------------------------------------

export function LocalRepoPicker({
  onSelectionChange,
}: {
  onSelectionChange: (paths: Set<string>) => void;
}) {
  const { repos } = useWorkspace();
  const existingPaths = useMemo(() => new Set(repos.map((repo) => repo.path)), [repos]);
  return <RepoScanner existingPaths={existingPaths} onSelectionChange={onSelectionChange} />;
}

// ---------------------------------------------------------------------------
// Clone tab — remote provider picker + repo list
// ---------------------------------------------------------------------------

export interface RemoteSelection {
  cloneUrl: string;
  name: string;
  provider: 'github' | 'ado';
}

export function RemoteRepoPicker({
  selected,
  onSelectionChange,
  cloneStatuses,
  onReposLoaded,
}: {
  selected: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  /** Per-clone-url status line shown beside each row (e.g. "Cloning…", "Done"). */
  cloneStatuses?: Record<string, string>;
  /** Reports the fetched repo list so callers can resolve cloneUrl → provider. */
  onReposLoaded?: (repos: RemoteRepo[]) => void;
}) {
  const [provider, setProvider] = useState<'github' | 'ado' | null>(null);
  const [availableProviders, setAvailableProviders] = useState<Array<'github' | 'ado'>>([]);
  const [remoteRepos, setRemoteRepos] = useState<RemoteRepo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const providers: Array<'github' | 'ado'> = [];
      try {
        const ghStatus = await window.anvil.repo.ghAuthStatus();
        if (ghStatus.authenticated) providers.push('github');
      } catch {
        /* gh CLI optional */
      }
      try {
        const settings = await window.anvil.settings.get();
        if (settings.adoPat && settings.adoOrganizationUrl && settings.adoProject) {
          providers.push('ado');
        }
      } catch {
        /* settings optional */
      }
      if (cancelled) return;
      setAvailableProviders(providers);
      if (providers.length > 0) setProvider((current) => current ?? providers[0]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setRemoteRepos([]);
      try {
        const repos =
          provider === 'github'
            ? await window.anvil.repo.listGithubRepos()
            : await window.anvil.repo.listAdoRepos();
        if (!cancelled) {
          setRemoteRepos(repos);
          onReposLoaded?.(repos);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to fetch repositories');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider]);

  if (availableProviders.length === 0) {
    // Point-of-need prompt (O2/3.2): the Git provider connection lives in
    // Settings → Delivery and is asked for here, not during onboarding.
    return (
      <div className="rounded-lg border border-border bg-bg-primary p-4 text-sm text-text-secondary">
        <p>
          Connect a Git provider to browse and clone remote repositories —{' '}
          <SettingsLink to="delivery#git">set it up in Settings</SettingsLink>.
        </p>
      </div>
    );
  }

  const filtered = remoteRepos.filter(
    (repo) =>
      repo.name.toLowerCase().includes(search.toLowerCase()) ||
      (repo.description ?? '').toLowerCase().includes(search.toLowerCase()),
  );

  const toggle = (cloneUrl: string) => {
    const next = new Set(selected);
    if (next.has(cloneUrl)) next.delete(cloneUrl);
    else next.add(cloneUrl);
    onSelectionChange(next);
  };

  return (
    <div className="space-y-3">
      {availableProviders.length > 1 && (
        <div className="flex gap-2">
          {availableProviders.map((p) => (
            <Button
              key={p}
              variant={provider === p ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setProvider(p)}
            >
              {p === 'github' ? 'GitHub' : 'Azure DevOps'}
            </Button>
          ))}
        </div>
      )}

      <div className="relative">
        <Search
          size={14}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
          aria-hidden="true"
        />
        <input
          type="text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter repositories…"
          className="w-full rounded-md border border-border bg-bg-primary py-1.5 pl-8 pr-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
        />
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-4 text-sm text-text-tertiary">
          <Loader2 size={16} className="animate-spin text-accent" aria-hidden="true" />
          Fetching repositories…
        </div>
      )}

      {error && <p className="text-sm text-error">{error}</p>}

      {!loading && !error && remoteRepos.length === 0 && (
        <p className="text-sm text-text-tertiary">No repositories found.</p>
      )}

      {!loading && filtered.length > 0 && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-tertiary">
              {filtered.length} repos · {selected.size} selected
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onSelectionChange(new Set(filtered.map((r) => r.cloneUrl)))}
                className="text-xs text-accent hover:underline"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => onSelectionChange(new Set())}
                className="text-xs text-accent hover:underline"
              >
                Deselect all
              </button>
            </div>
          </div>
          <div className="max-h-60 space-y-1 overflow-y-auto">
            {filtered.map((repo) => (
              <label
                key={repo.cloneUrl}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-bg-tertiary"
              >
                <input
                  type="checkbox"
                  checked={selected.has(repo.cloneUrl)}
                  onChange={() => toggle(repo.cloneUrl)}
                  className="accent-accent"
                />
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="font-medium text-text-primary">{repo.name}</span>
                  {repo.visibility && (
                    <span
                      className={cx(
                        'shrink-0 rounded px-1.5 py-0.5 text-eyebrow font-medium',
                        repo.visibility === 'private'
                          ? 'bg-warning/20 text-warning'
                          : 'bg-success/20 text-success',
                      )}
                    >
                      {repo.visibility}
                    </span>
                  )}
                  {repo.defaultBranch && (
                    <span className="shrink-0 text-eyebrow text-text-tertiary">
                      {repo.defaultBranch}
                    </span>
                  )}
                  {repo.description && (
                    <span className="truncate text-xs text-text-tertiary">{repo.description}</span>
                  )}
                  {cloneStatuses?.[repo.cloneUrl] && (
                    <span
                      className={cx(
                        'shrink-0 text-xs',
                        cloneStatuses[repo.cloneUrl] === 'Done'
                          ? 'text-success'
                          : cloneStatuses[repo.cloneUrl].startsWith('Error')
                            ? 'text-error'
                            : 'text-info',
                      )}
                    >
                      {cloneStatuses[repo.cloneUrl]}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scaffold panel — parent folder + new folder name
// ---------------------------------------------------------------------------

export function ScaffoldPanel({
  parentPath,
  folderName,
  onParentPathChange,
  onFolderNameChange,
}: {
  parentPath: string;
  folderName: string;
  onParentPathChange: (path: string) => void;
  onFolderNameChange: (name: string) => void;
}) {
  const folderNameError = validateFolderName(folderName);
  const rootPath = joinPaths(parentPath, folderName);

  return (
    <div className="space-y-4 rounded-lg border border-border bg-bg-primary p-4">
      <div>
        <label className="mb-1 block text-sm font-medium text-text-secondary">Parent folder</label>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              const selected = await window.anvil.repo.selectDirectory();
              if (selected) onParentPathChange(selected);
            }}
          >
            <FolderOpen size={14} aria-hidden="true" /> Choose folder
          </Button>
          <div className="flex-1 rounded-md border border-border-subtle bg-bg-secondary px-3 py-2 font-mono text-xs text-text-tertiary">
            {parentPath || 'No parent folder selected yet'}
          </div>
        </div>
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium text-text-secondary">
          New folder name
        </label>
        <input
          type="text"
          value={folderName}
          onChange={(event) => onFolderNameChange(event.target.value)}
          placeholder="e.g. acme-platform"
          className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
        />
        {folderNameError && <p className="mt-2 text-xs text-error">{folderNameError}</p>}
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium text-text-secondary">
          Scaffold folder that will be created
        </label>
        <div className="rounded-md border border-border-subtle bg-bg-secondary px-3 py-2 font-mono text-xs text-text-tertiary">
          {rootPath || 'Choose a parent folder and enter a new folder name'}
        </div>
      </div>
      <div className="rounded-md border border-info/20 bg-info/5 p-3 text-sm text-text-secondary">
        Anvil creates this folder, opens Chat with the coder persona loaded, and asks you to name
        the repositories it should create. Repos become usable as soon as their structural map
        finishes — summaries keep running in the background.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

type AddTab = 'local' | 'clone' | 'scaffold';

export interface AddRepositoriesDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after selected repos are connected and added to the workspace. */
  onReposAdded?: (repoIds: string[]) => void;
}

export function AddRepositoriesDialog({ open, onClose, onReposAdded }: AddRepositoriesDialogProps) {
  const { addRepos, activeWorkspace, refreshWorkspaces } = useWorkspace();
  const [tab, setTab] = useState<AddTab>('local');
  const [localPaths, setLocalPaths] = useState<Set<string>>(new Set());
  const [remoteSelection, setRemoteSelection] = useState<Set<string>>(new Set());
  const [remoteRepos, setRemoteRepos] = useState<Map<string, RemoteRepo>>(new Map());
  const [scaffoldParent, setScaffoldParent] = useState('');
  const [scaffoldName, setScaffoldName] = useState('');
  const [working, setWorking] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    !working &&
    ((tab === 'local' && localPaths.size > 0) ||
      (tab === 'clone' && remoteSelection.size > 0) ||
      (tab === 'scaffold' &&
        scaffoldParent.trim().length > 0 &&
        scaffoldName.trim().length > 0 &&
        !validateFolderName(scaffoldName)));

  const handleSubmit = async () => {
    setWorking(true);
    setError(null);
    try {
      if (tab === 'scaffold') {
        if (!activeWorkspace) return;
        const root = joinPaths(scaffoldParent, scaffoldName);
        await window.anvil.workspaceScaffold.start(activeWorkspace.id, root);
        await refreshWorkspaces();
        onClose();
        return;
      }

      const repoIds: string[] = [];
      if (tab === 'local') {
        for (const path of localPaths) {
          setStatuses((prev) => ({ ...prev, [path]: 'Connecting…' }));
          try {
            const repo = await window.anvil.repo.connect(path);
            repoIds.push(repo.id);
            setStatuses((prev) => ({ ...prev, [path]: 'Done' }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Connect failed';
            setStatuses((prev) => ({ ...prev, [path]: `Error: ${msg}` }));
          }
        }
      } else {
        const settings = await window.anvil.settings.get();
        let targetDir = settings.defaultRepoPath;
        if (!targetDir) {
          const picked = await window.anvil.repo.selectDirectory();
          if (!picked) {
            setWorking(false);
            return;
          }
          targetDir = picked;
        }
        for (const cloneUrl of remoteSelection) {
          setStatuses((prev) => ({ ...prev, [cloneUrl]: 'Cloning…' }));
          try {
            const meta = remoteRepos.get(cloneUrl);
            const localPath = await window.anvil.repo.clone(
              cloneUrl,
              targetDir,
              meta?.provider ?? 'github',
            );
            const repo = await window.anvil.repo.connect(localPath);
            repoIds.push(repo.id);
            setStatuses((prev) => ({ ...prev, [cloneUrl]: 'Done' }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Clone failed';
            setStatuses((prev) => ({ ...prev, [cloneUrl]: `Error: ${msg}` }));
          }
        }
      }

      // Partial failures leave the workspace usable — add what succeeded.
      if (repoIds.length > 0) {
        await addRepos(repoIds);
        await refreshWorkspaces();
        onReposAdded?.(repoIds);
      }
      const failures = Object.values(statuses).filter((s) => s.startsWith('Error'));
      if (repoIds.length === 0 && failures.length > 0) {
        setError('No repositories could be added. See per-repo errors above.');
        return;
      }
      if (failures.length === 0) onClose();
      else
        setError(
          `${failures.length} ${failures.length === 1 ? 'repo' : 'repos'} failed — the rest were added.`,
        );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add repositories');
    } finally {
      setWorking(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add repositories"
      description="Connect local folders, clone from a Git provider, or scaffold a fresh project. Indexing runs automatically in the background."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={working}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {working ? 'Working…' : tab === 'scaffold' ? 'Start scaffold' : 'Add to workspace'}
          </Button>
        </>
      }
    >
      <div className="mt-4">
        <SegmentedControl<AddTab>
          label="Add repositories source"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'local', label: 'Local folder' },
            { value: 'clone', label: 'Clone' },
            { value: 'scaffold', label: 'Scaffold' },
          ]}
          aria-label="Add repositories source"
        />
      </div>

      <div className="mt-4 min-h-40">
        {tab === 'local' && <LocalRepoPicker onSelectionChange={setLocalPaths} />}
        {tab === 'clone' && (
          <RemoteRepoPicker
            selected={remoteSelection}
            onSelectionChange={setRemoteSelection}
            cloneStatuses={statuses}
            onReposLoaded={(repos) =>
              setRemoteRepos(new Map(repos.map((repo) => [repo.cloneUrl, repo])))
            }
          />
        )}
        {tab === 'scaffold' && (
          <ScaffoldPanel
            parentPath={scaffoldParent}
            folderName={scaffoldName}
            onParentPathChange={setScaffoldParent}
            onFolderNameChange={setScaffoldName}
          />
        )}
      </div>

      {error && <p className="mt-3 text-sm text-error">{error}</p>}
    </Dialog>
  );
}

export function validateFolderName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '.' || trimmed === '..') {
    return 'Choose a real folder name.';
  }
  if (/[\\/]/.test(trimmed)) {
    return 'Folder name cannot include path separators.';
  }
  return null;
}

export function joinPaths(parentPath: string, folderName: string): string {
  const parent = parentPath.trim().replace(/[\\/]+$/, '');
  const child = folderName.trim().replace(/^[\\/]+/, '');
  if (!parent || !child) return '';
  return `${parent}/${child}`;
}
