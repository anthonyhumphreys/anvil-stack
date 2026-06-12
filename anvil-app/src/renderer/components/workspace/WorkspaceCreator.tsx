import { useState, useEffect } from 'react';
import { FolderOpen, Loader2, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { RepoScanner } from '../shared/RepoScanner';
import type { RemoteRepo, WorkspaceCreationMode } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WorkspaceCreatorProps {
  onCreated: (workspace: { id: string; name: string }) => void;
  onCancel?: () => void; // undefined when used in onboarding (can't cancel)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WorkspaceCreator({ onCreated, onCancel }: WorkspaceCreatorProps) {
  const navigate = useNavigate();
  const { createWorkspace, refreshWorkspaces } = useWorkspace();
  const [name, setName] = useState('');
  const [creationMode, setCreationMode] = useState<WorkspaceCreationMode>('existing');
  const [activeTab, setActiveTab] = useState<'local' | 'remote'>('local');
  const [exportVSCode, setExportVSCode] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedLocalPaths, setSelectedLocalPaths] = useState<Set<string>>(new Set());
  const [scaffoldParentPath, setScaffoldParentPath] = useState('');
  const [scaffoldFolderName, setScaffoldFolderName] = useState('');
  const [scaffoldFolderNameDirty, setScaffoldFolderNameDirty] = useState(false);

  const [remoteProvider, setRemoteProvider] = useState<'github' | 'ado' | null>(null);
  const [availableProviders, setAvailableProviders] = useState<Array<'github' | 'ado'>>([]);
  const [remoteRepos, setRemoteRepos] = useState<RemoteRepo[]>([]);
  const [loadingRemote, setLoadingRemote] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [remoteSearch, setRemoteSearch] = useState('');
  const [selectedRemoteRepos, setSelectedRemoteRepos] = useState<Set<string>>(new Set());
  const [cloneStatuses, setCloneStatuses] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      const providers: Array<'github' | 'ado'> = [];

      // Check gh CLI auth for GitHub
      const ghStatus = await window.anvil.repo.ghAuthStatus();
      if (ghStatus.authenticated) providers.push('github');

      // Check ADO PAT
      const s = await window.anvil.settings.get();
      const hasAdo = !!s.adoPat && !!s.adoOrganizationUrl && !!s.adoProject;
      if (hasAdo) providers.push('ado');

      setAvailableProviders(providers);
      if (providers.length > 0) setRemoteProvider(providers[0]);
    })();
  }, []);

  useEffect(() => {
    if (creationMode === 'scaffold' && exportVSCode) {
      setExportVSCode(false);
    }
  }, [creationMode, exportVSCode]);

  useEffect(() => {
    if (scaffoldFolderNameDirty) return;
    const suggestedName = toFolderName(name);
    setScaffoldFolderName(suggestedName);
  }, [name, scaffoldFolderNameDirty]);

  useEffect(() => {
    if (!remoteProvider || activeTab !== 'remote') return;

    let cancelled = false;
    (async () => {
      setLoadingRemote(true);
      setRemoteError(null);
      setRemoteRepos([]);
      setSelectedRemoteRepos(new Set());
      try {
        const repos =
          remoteProvider === 'github'
            ? await window.anvil.repo.listGithubRepos()
            : await window.anvil.repo.listAdoRepos();
        if (!cancelled) setRemoteRepos(repos);
      } catch (err) {
        if (!cancelled)
          setRemoteError(err instanceof Error ? err.message : 'Failed to fetch repositories');
      } finally {
        if (!cancelled) setLoadingRemote(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [remoteProvider, activeTab]);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const filteredRemoteRepos = remoteRepos.filter(
    (r) =>
      r.name.toLowerCase().includes(remoteSearch.toLowerCase()) ||
      (r.description ?? '').toLowerCase().includes(remoteSearch.toLowerCase()),
  );

  const hasExistingRepos =
    activeTab === 'local' ? selectedLocalPaths.size > 0 : selectedRemoteRepos.size > 0;
  const scaffoldFolderNameError = validateFolderName(scaffoldFolderName);
  const scaffoldRootPath = joinPaths(scaffoldParentPath, scaffoldFolderName);
  const canCreate =
    name.trim().length > 0 &&
    !creating &&
    (creationMode === 'empty' ||
      (creationMode === 'existing' && hasExistingRepos) ||
      (creationMode === 'scaffold' &&
        scaffoldParentPath.trim().length > 0 &&
        scaffoldFolderName.trim().length > 0 &&
        !scaffoldFolderNameError));

  const handleChooseScaffoldRoot = async () => {
    const selected = await window.anvil.repo.selectDirectory();
    if (selected) {
      setScaffoldParentPath(selected);
    }
  };

  const handleCreate = async () => {
    if (!canCreate) return;

    setCreating(true);
    setError(null);

    try {
      let workspace;

      if (creationMode === 'empty') {
        workspace = await createWorkspace({ name: name.trim() });
      } else if (creationMode === 'scaffold') {
        workspace = await createWorkspace({ name: name.trim() });
        await window.anvil.workspaceScaffold.start(workspace.id, scaffoldRootPath);
        await refreshWorkspaces();
        navigate('/chat');
      } else {
        const repoIds: string[] = [];

        if (activeTab === 'local') {
          for (const p of selectedLocalPaths) {
            const repoInfo = await window.anvil.repo.connect(p);
            repoIds.push(repoInfo.id);
          }
        } else {
          const settings = await window.anvil.settings.get();
          let targetDir: string | undefined = settings.defaultRepoPath;
          if (!targetDir) {
            const picked = await window.anvil.repo.selectDirectory();
            if (!picked) {
              setCreating(false);
              return;
            }
            targetDir = picked;
          }
          const cloneDir = targetDir;

          for (const cloneUrl of selectedRemoteRepos) {
            const repo = remoteRepos.find((r) => r.cloneUrl === cloneUrl);
            setCloneStatuses((prev) => ({ ...prev, [cloneUrl]: 'Cloning...' }));
            try {
              const localPath = await window.anvil.repo.clone(
                cloneUrl,
                cloneDir,
                repo?.provider ?? 'github',
              );
              const repoInfo = await window.anvil.repo.connect(localPath);
              repoIds.push(repoInfo.id);
              setCloneStatuses((prev) => ({ ...prev, [cloneUrl]: 'Done' }));
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'Clone failed';
              setCloneStatuses((prev) => ({ ...prev, [cloneUrl]: `Error: ${msg}` }));
            }
          }

          if (repoIds.length === 0) {
            setError('No repositories were cloned successfully.');
            setCreating(false);
            return;
          }
        }

        workspace = await createWorkspace({ name: name.trim(), repoIds });
      }

      if (exportVSCode && creationMode !== 'scaffold') {
        await window.anvil.workspace.exportVSCodeWorkspace(workspace.id);
      }

      onCreated({ id: workspace.id, name: workspace.name });
    } catch (err) {
      console.error('[WorkspaceCreator] Create failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to create workspace.');
    } finally {
      setCreating(false);
    }
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-xl rounded-xl border border-border bg-bg-secondary p-6 shadow-2xl">
        {/* Title */}
        <h2 className="text-lg font-semibold text-text-primary">
          {!onCancel ? 'Create Your First Workspace' : 'Create Workspace'}
        </h2>

        {/* Name field */}
        <div className="mt-4">
          <label className="mb-1 block text-sm font-medium text-text-secondary">
            Workspace name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. My Project"
            autoFocus
            className="w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
          />
        </div>

        <div className="mt-5 grid gap-2 sm:grid-cols-3">
          {(
            [
              {
                id: 'empty',
                title: 'Empty workspace',
                description: 'Create the workspace now and add repositories later.',
              },
              {
                id: 'existing',
                title: 'Existing repos',
                description: 'Connect local or remote repositories during setup.',
              },
              {
                id: 'scaffold',
                title: 'New repos with coder',
                description: 'Open Chat in scaffold mode and let Anvil create the repositories.',
              },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setCreationMode(option.id)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                creationMode === option.id
                  ? 'border-accent bg-accent/10 text-text-primary'
                  : 'border-border text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
              }`}
            >
              <div className="text-sm font-medium">{option.title}</div>
              <div className="mt-1 text-xs leading-relaxed text-text-tertiary">
                {option.description}
              </div>
            </button>
          ))}
        </div>

        {creationMode === 'existing' && (
          <>
            <div className="mt-5 flex gap-4 border-b border-border">
              {(['local', 'remote'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={`pb-2 text-sm font-medium transition-colors ${
                    activeTab === tab
                      ? 'border-b-2 border-accent text-accent'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {tab === 'local' ? 'Local' : 'Remote'}
                </button>
              ))}
            </div>

            <div className="mt-4">
              {activeTab === 'local' && <RepoScanner onSelectionChange={setSelectedLocalPaths} />}

              {activeTab === 'remote' && (
                <div className="space-y-3">
                  {availableProviders.length === 0 ? (
                    <p className="text-sm text-text-tertiary">
                      Configure GitHub or Azure DevOps credentials in Settings to browse remote
                      repositories.
                    </p>
                  ) : (
                    <>
                      {availableProviders.length > 1 && (
                        <div className="flex gap-2">
                          {availableProviders.map((p) => (
                            <button
                              key={p}
                              type="button"
                              onClick={() => setRemoteProvider(p)}
                              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                                remoteProvider === p
                                  ? 'bg-accent text-white'
                                  : 'border border-border text-text-secondary hover:bg-bg-tertiary'
                              }`}
                            >
                              {p === 'github' ? 'GitHub' : 'Azure DevOps'}
                            </button>
                          ))}
                        </div>
                      )}

                      <div className="relative">
                        <Search
                          size={14}
                          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
                        />
                        <input
                          type="text"
                          value={remoteSearch}
                          onChange={(e) => setRemoteSearch(e.target.value)}
                          placeholder="Filter repositories..."
                          className="w-full rounded-md border border-border bg-bg-primary pl-8 pr-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                        />
                      </div>

                      {loadingRemote && (
                        <div className="flex items-center gap-2 py-4 text-sm text-text-tertiary">
                          <Loader2 size={16} className="animate-spin text-accent" />
                          Fetching repositories...
                        </div>
                      )}

                      {remoteError && <p className="text-sm text-red-400">{remoteError}</p>}

                      {!loadingRemote && remoteRepos.length > 0 && (
                        <>
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-text-tertiary">
                              {remoteRepos.length} repos &middot; {selectedRemoteRepos.size}{' '}
                              selected
                            </span>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  setSelectedRemoteRepos(
                                    new Set(filteredRemoteRepos.map((r) => r.cloneUrl)),
                                  )
                                }
                                className="text-xs text-accent hover:underline"
                              >
                                Select All
                              </button>
                              <button
                                type="button"
                                onClick={() => setSelectedRemoteRepos(new Set())}
                                className="text-xs text-accent hover:underline"
                              >
                                Deselect All
                              </button>
                            </div>
                          </div>

                          <div className="max-h-60 overflow-y-auto space-y-1">
                            {filteredRemoteRepos.map((repo) => (
                              <label
                                key={repo.cloneUrl}
                                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-bg-tertiary"
                              >
                                <input
                                  type="checkbox"
                                  checked={selectedRemoteRepos.has(repo.cloneUrl)}
                                  onChange={() => {
                                    const next = new Set(selectedRemoteRepos);
                                    if (next.has(repo.cloneUrl)) next.delete(repo.cloneUrl);
                                    else next.add(repo.cloneUrl);
                                    setSelectedRemoteRepos(next);
                                  }}
                                  className="accent-accent"
                                />
                                <span className="flex min-w-0 flex-1 items-center gap-2">
                                  <span className="font-medium text-text-primary">{repo.name}</span>
                                  {repo.visibility && (
                                    <span
                                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                        repo.visibility === 'private'
                                          ? 'bg-amber-500/20 text-amber-400'
                                          : 'bg-emerald-500/20 text-emerald-400'
                                      }`}
                                    >
                                      {repo.visibility}
                                    </span>
                                  )}
                                  {repo.defaultBranch && (
                                    <span className="shrink-0 text-[10px] text-text-tertiary">
                                      {repo.defaultBranch}
                                    </span>
                                  )}
                                  {repo.updatedAt && (
                                    <span className="shrink-0 text-[10px] text-text-tertiary">
                                      {new Date(repo.updatedAt).toLocaleDateString()}
                                    </span>
                                  )}
                                  {repo.description && (
                                    <span className="truncate text-xs text-text-tertiary">
                                      {repo.description}
                                    </span>
                                  )}
                                  {cloneStatuses[repo.cloneUrl] && (
                                    <span
                                      className={`shrink-0 text-xs ${
                                        cloneStatuses[repo.cloneUrl] === 'Done'
                                          ? 'text-success'
                                          : cloneStatuses[repo.cloneUrl].startsWith('Error')
                                            ? 'text-error'
                                            : 'text-info'
                                      }`}
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

                      {!loadingRemote && !remoteError && remoteRepos.length === 0 && (
                        <p className="text-sm text-text-tertiary">No repositories found.</p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {creationMode === 'empty' && (
          <div className="mt-4 rounded-lg border border-border bg-bg-primary p-4 text-sm text-text-secondary">
            Create the workspace now and add repositories later from the Repositories view.
            Repo-powered features will stay visible and unlock once repositories are added and
            indexed.
          </div>
        )}

        {creationMode === 'scaffold' && (
          <div className="mt-4 space-y-4 rounded-lg border border-border bg-bg-primary p-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-text-secondary">
                Parent folder
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleChooseScaffoldRoot}
                  className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                >
                  <FolderOpen size={14} />
                  Choose Folder
                </button>
                <div className="flex-1 rounded-md border border-border-subtle bg-bg-secondary px-3 py-2 font-mono text-xs text-text-tertiary">
                  {scaffoldParentPath || 'No parent folder selected yet'}
                </div>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-text-secondary">
                New folder name
              </label>
              <input
                type="text"
                value={scaffoldFolderName}
                onChange={(e) => {
                  setScaffoldFolderName(e.target.value);
                  setScaffoldFolderNameDirty(true);
                }}
                placeholder="e.g. acme-platform"
                className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
              />
              {scaffoldFolderNameError && (
                <p className="mt-2 text-xs text-red-400">{scaffoldFolderNameError}</p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-text-secondary">
                Scaffold folder that will be created
              </label>
              <div className="rounded-md border border-border-subtle bg-bg-secondary px-3 py-2 font-mono text-xs text-text-tertiary">
                {scaffoldRootPath || 'Choose a parent folder and enter a new folder name'}
              </div>
            </div>
            <div className="rounded-md border border-info/20 bg-info/5 p-3 text-sm text-text-secondary">
              Anvil will create this scaffold folder, open Chat with the coder persona already
              loaded, and ask you to name the repositories it should create inside it. Once
              scaffolding is done, Anvil will connect and index those repos before other
              repo-powered features unlock.
            </div>
          </div>
        )}

        {/* Indexing note */}
        {creationMode === 'existing' &&
          (selectedLocalPaths.size > 0 || selectedRemoteRepos.size > 0) && (
            <p className="mt-4 text-xs text-text-tertiary">
              Repos will be connected to your workspace. You can index them from the Repositories
              page to enable AI features like chat, security audits, and code review.
            </p>
          )}

        {/* VS Code checkbox */}
        <label className="mt-3 flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={exportVSCode}
            onChange={(e) => setExportVSCode(e.target.checked)}
            className="accent-accent"
            disabled={creationMode === 'scaffold'}
          />
          <span className="text-sm text-text-secondary">
            {creationMode === 'scaffold'
              ? 'VS Code workspace export unlocks after scaffolded repos are connected'
              : 'Also create VS Code workspace file'}
          </span>
        </label>

        {/* Error message */}
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

        {/* Action buttons */}
        <div className="mt-6 flex justify-end gap-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-border px-4 py-2 text-sm text-text-secondary hover:bg-bg-tertiary"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={handleCreate}
            disabled={!canCreate}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {creating ? 'Creating...' : 'Create Workspace'}
          </button>
        </div>
      </div>
    </div>
  );
}

function toFolderName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function validateFolderName(value: string): string | null {
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

function joinPaths(parentPath: string, folderName: string): string {
  const parent = parentPath.trim().replace(/[\\/]+$/, '');
  const child = folderName.trim().replace(/^[\\/]+/, '');
  if (!parent || !child) return '';
  return `${parent}/${child}`;
}
