import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { RemoteRepo, WorkItemConnection } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { Button, SegmentedControl } from '../ui';
import {
  LocalRepoPicker,
  RemoteRepoPicker,
  ScaffoldPanel,
  joinPaths,
  validateFolderName,
} from '../shared/AddRepositoriesDialog';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WorkspaceCreatorProps {
  onCreated: (workspace: { id: string; name: string }) => void;
  onCancel?: () => void; // undefined when used in onboarding (can't cancel)
}

type CreatorTab = 'local' | 'clone';
type SecondaryMode = 'repos' | 'empty' | 'scaffold';
type Phase = 'form' | 'working' | 'done';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * J8 / plan §3.4: the workspace is created first, then repositories are
 * connected/cloned/scaffolded into it with per-repo status inline — a
 * partial failure leaves a usable workspace. The local-folder picker is
 * primary, Clone is a tab, and Scaffold/Empty are secondary options. The
 * workspace name auto-fills from the first selected repo.
 */
export function WorkspaceCreator({ onCreated, onCancel }: WorkspaceCreatorProps) {
  const navigate = useNavigate();
  const { createWorkspace, refreshWorkspaces } = useWorkspace();
  const [name, setName] = useState('');
  const [nameDirty, setNameDirty] = useState(false);
  const [mode, setMode] = useState<SecondaryMode>('repos');
  const [activeTab, setActiveTab] = useState<CreatorTab>('local');
  const [exportVSCode, setExportVSCode] = useState(false);
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState<string | null>(null);
  const [createdWorkspace, setCreatedWorkspace] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const [selectedLocalPaths, setSelectedLocalPaths] = useState<Set<string>>(new Set());
  const [selectedRemoteRepos, setSelectedRemoteRepos] = useState<Set<string>>(new Set());
  const [remoteReposByUrl, setRemoteReposByUrl] = useState<Map<string, RemoteRepo>>(new Map());
  const [repoStatuses, setRepoStatuses] = useState<Record<string, string>>({});
  const [scaffoldParentPath, setScaffoldParentPath] = useState('');
  const [scaffoldFolderName, setScaffoldFolderName] = useState('');
  const [scaffoldFolderNameDirty, setScaffoldFolderNameDirty] = useState(false);

  const [workItemConnections, setWorkItemConnections] = useState<WorkItemConnection[]>([]);
  const [workItemConnectionId, setWorkItemConnectionId] = useState('');
  const [workItemConnectionsLoaded, setWorkItemConnectionsLoaded] = useState(false);
  const [isItsmRole, setIsItsmRole] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const s = await window.anvil.settings.get();
        setWorkItemConnections(s.workItemConnections);
        setWorkItemConnectionId(
          s.workItemConnections.length === 1 ? s.workItemConnections[0].id : '',
        );
        const itsmRole = s.userRole === 'itsm';
        setIsItsmRole(itsmRole);
        if (itsmRole) setMode('empty');
      } catch (err) {
        console.warn('[WorkspaceCreator] Failed to load settings:', err);
      } finally {
        setWorkItemConnectionsLoaded(true);
      }
    })();
  }, []);

  // 3.4: name auto-fills from the first selected repo until the user edits it.
  useEffect(() => {
    if (nameDirty) return;
    const firstLocal = selectedLocalPaths.values().next().value;
    const firstRemote = remoteReposByUrl.get(selectedRemoteRepos.values().next().value ?? '')?.name;
    const suggested = firstRemote ?? (firstLocal ? baseName(firstLocal) : '');
    if (suggested) setName(toTitleCase(suggested));
  }, [selectedLocalPaths, selectedRemoteRepos, remoteReposByUrl, nameDirty]);

  // Scaffold folder name follows the workspace name until edited.
  useEffect(() => {
    if (scaffoldFolderNameDirty) return;
    setScaffoldFolderName(toFolderName(name));
  }, [name, scaffoldFolderNameDirty]);

  const hasExistingRepos =
    activeTab === 'local' ? selectedLocalPaths.size > 0 : selectedRemoteRepos.size > 0;
  const scaffoldFolderNameError = validateFolderName(scaffoldFolderName);
  const scaffoldRootPath = joinPaths(scaffoldParentPath, scaffoldFolderName);
  const canCreate =
    name.trim().length > 0 &&
    phase === 'form' &&
    workItemConnectionsLoaded &&
    (workItemConnections.length <= 1 || Boolean(workItemConnectionId)) &&
    (mode === 'empty' ||
      (mode === 'repos' && hasExistingRepos) ||
      (mode === 'scaffold' &&
        scaffoldParentPath.trim().length > 0 &&
        scaffoldFolderName.trim().length > 0 &&
        !scaffoldFolderNameError));

  const setRepoStatus = (key: string, status: string) =>
    setRepoStatuses((prev) => ({ ...prev, [key]: status }));

  const handleCreate = async () => {
    if (!canCreate) return;
    setPhase('working');
    setError(null);

    // Create the workspace FIRST (§3.4) so a partial connect/clone failure
    // still leaves a usable workspace.
    let workspace;
    try {
      workspace = await createWorkspace({
        name: name.trim(),
        workItemConnectionId: workItemConnectionId || undefined,
      });
      setCreatedWorkspace({ id: workspace.id, name: workspace.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace.');
      setPhase('form');
      return;
    }

    if (mode === 'empty') {
      finish(workspace.id, workspace.name);
      return;
    }

    if (mode === 'scaffold') {
      try {
        await window.anvil.workspaceScaffold.start(workspace.id, scaffoldRootPath);
        await refreshWorkspaces();
        onCreated({ id: workspace.id, name: workspace.name });
        navigate('/chat');
      } catch (err) {
        // Workspace exists and is usable — surface the scaffold failure.
        setError(
          `Workspace created, but scaffolding failed to start: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
        setPhase('done');
      }
      return;
    }

    // Connect / clone into the created workspace with per-repo status.
    const repoIds: string[] = [];
    if (activeTab === 'local') {
      for (const path of selectedLocalPaths) {
        setRepoStatus(path, 'Connecting…');
        try {
          const repoInfo = await window.anvil.repo.connect(path);
          repoIds.push(repoInfo.id);
          setRepoStatus(path, 'Done — indexing in the background');
        } catch (err) {
          setRepoStatus(path, `Error: ${err instanceof Error ? err.message : 'connect failed'}`);
        }
      }
    } else {
      const settings = await window.anvil.settings.get();
      let targetDir: string | undefined = settings.defaultRepoPath;
      if (!targetDir) {
        const picked = await window.anvil.repo.selectDirectory();
        if (!picked) {
          setError('Workspace created. No clone destination chosen — repos were not added.');
          setPhase('done');
          return;
        }
        targetDir = picked;
      }

      for (const cloneUrl of selectedRemoteRepos) {
        const repoMeta = remoteReposByUrl.get(cloneUrl);
        setRepoStatus(cloneUrl, 'Cloning…');
        try {
          const localPath = await window.anvil.repo.clone(
            cloneUrl,
            targetDir,
            repoMeta?.provider ?? 'github',
          );
          const repoInfo = await window.anvil.repo.connect(localPath);
          repoIds.push(repoInfo.id);
          setRepoStatus(cloneUrl, 'Done — indexing in the background');
        } catch (err) {
          setRepoStatus(cloneUrl, `Error: ${err instanceof Error ? err.message : 'clone failed'}`);
        }
      }
    }

    if (repoIds.length > 0) {
      try {
        // Call the IPC directly — the context's addRepos closes over the
        // *previous* activeWorkspace, which hasn't updated yet.
        await window.anvil.workspace.addRepos(workspace.id, repoIds);
        await refreshWorkspaces();
      } catch (err) {
        setError(
          `Workspace created, but adding repositories failed: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
      }
    }

    if (exportVSCode) {
      await window.anvil.workspace.exportVSCodeWorkspace(workspace.id).catch(() => undefined);
    }

    const failures = Object.values(repoStatuses).filter((s) => s.startsWith('Error'));
    if (repoIds.length === 0 && failures.length > 0) {
      setError(
        'Workspace created, but no repositories could be added. You can retry from the workspace.',
      );
    }
    setPhase('done');
  };

  const finish = (id: string, workspaceName: string) => {
    onCreated({ id, name: workspaceName });
  };

  const closeDone = () => {
    if (createdWorkspace) finish(createdWorkspace.id, createdWorkspace.name);
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const statusEntries = Object.entries(repoStatuses);
  const hasFailures = statusEntries.some(([, s]) => s.startsWith('Error'));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-xl rounded-xl border border-border bg-bg-secondary p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-text-primary">
          {!onCancel ? 'Create your first workspace' : 'Create workspace'}
        </h2>

        {phase === 'done' ? (
          <div className="mt-4 space-y-3">
            <div className="flex items-center gap-2 text-sm text-text-primary">
              <CheckCircle2 size={16} className="text-success" aria-hidden="true" />
              Workspace “{createdWorkspace?.name}” is ready.
            </div>
            {statusEntries.length > 0 && (
              <ul className="space-y-1 rounded-lg border border-border bg-bg-primary p-3 text-sm">
                {statusEntries.map(([key, status]) => (
                  <li key={key} className="flex items-center gap-2">
                    {status.startsWith('Error') ? (
                      <XCircle size={13} className="shrink-0 text-error" aria-hidden="true" />
                    ) : status === 'Done — indexing in the background' ? (
                      <CheckCircle2
                        size={13}
                        className="shrink-0 text-success"
                        aria-hidden="true"
                      />
                    ) : (
                      <Loader2
                        size={13}
                        className="shrink-0 animate-spin text-info"
                        aria-hidden="true"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate text-text-secondary">
                      {remoteReposByUrl.get(key)?.name ?? baseName(key)}
                    </span>
                    <span
                      className={status.startsWith('Error') ? 'text-error' : 'text-text-tertiary'}
                    >
                      {status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-sm text-text-secondary">
              Anvil indexes repositories in the background — you can chat while it works, and
              repo-powered features unlock as the structural map finishes.
            </p>
            {error && <p className="text-sm text-error">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="primary" onClick={closeDone}>
                Open workspace
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* Name field — auto-fills from the first selected repo */}
            <div className="mt-4">
              <label className="mb-1 block text-sm font-medium text-text-secondary">
                Workspace name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameDirty(true);
                }}
                placeholder="e.g. My Project"
                autoFocus
                className="w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
              />
            </div>

            {workItemConnections.length > 1 && (
              <div className="mt-4">
                <label className="mb-1 block text-sm font-medium text-text-secondary">
                  Work item connection
                </label>
                <select
                  value={workItemConnectionId}
                  onChange={(event) => setWorkItemConnectionId(event.target.value)}
                  className="w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
                >
                  <option value="">Choose a connection…</option>
                  {workItemConnections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name} · {connection.provider.toUpperCase()}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-text-tertiary">
                  Work items and agent planning in this workspace will use this connection.
                </p>
              </div>
            )}

            {/* Primary path: add repositories now (Local first, Clone second) */}
            {mode === 'repos' && (
              <>
                <div className="mt-5">
                  <SegmentedControl<CreatorTab>
                    label="Repository source"
                    value={activeTab}
                    onChange={setActiveTab}
                    options={[
                      { value: 'local', label: 'Local folder' },
                      { value: 'clone', label: 'Clone from provider' },
                    ]}
                  />
                </div>
                <div className="mt-4">
                  {activeTab === 'local' ? (
                    <LocalRepoPicker onSelectionChange={setSelectedLocalPaths} />
                  ) : (
                    <RemoteRepoPicker
                      selected={selectedRemoteRepos}
                      onSelectionChange={setSelectedRemoteRepos}
                      cloneStatuses={phase === 'working' ? repoStatuses : undefined}
                      onReposLoaded={(repos) =>
                        setRemoteReposByUrl(new Map(repos.map((r) => [r.cloneUrl, r])))
                      }
                    />
                  )}
                </div>
                <p className="mt-3 text-xs text-text-tertiary">
                  Anvil indexes repositories in the background once they’re added — no manual step
                  needed.
                </p>
              </>
            )}

            {mode === 'empty' && (
              <div className="mt-4 rounded-lg border border-border bg-bg-primary p-4 text-sm text-text-secondary">
                Create the workspace now and add repositories later. Repo-powered features stay
                visible and unlock as soon as a repository finishes its structural index.
              </div>
            )}

            {mode === 'scaffold' && (
              <div className="mt-4">
                <ScaffoldPanel
                  parentPath={scaffoldParentPath}
                  folderName={scaffoldFolderName}
                  onParentPathChange={setScaffoldParentPath}
                  onFolderNameChange={(value) => {
                    setScaffoldFolderName(value);
                    setScaffoldFolderNameDirty(true);
                  }}
                />
              </div>
            )}

            {/* Secondary options — Empty / Scaffold stay out of the way */}
            <div className="mt-4 flex items-center gap-3 text-xs text-text-tertiary">
              {mode !== 'repos' && (
                <button
                  type="button"
                  onClick={() => setMode('repos')}
                  className="text-accent hover:underline"
                >
                  Add repositories instead
                </button>
              )}
              {mode !== 'empty' && (
                <button
                  type="button"
                  onClick={() => setMode('empty')}
                  className="hover:text-text-primary"
                >
                  Start empty{isItsmRole ? ' (recommended)' : ''}
                </button>
              )}
              {mode !== 'scaffold' && (
                <button
                  type="button"
                  onClick={() => setMode('scaffold')}
                  className="hover:text-text-primary"
                >
                  Scaffold a new project with the coder
                </button>
              )}
            </div>

            {/* Per-repo status while working */}
            {statusEntries.length > 0 && (
              <ul className="mt-3 space-y-1 rounded-lg border border-border bg-bg-primary p-3 text-sm">
                {statusEntries.map(([key, status]) => (
                  <li key={key} className="flex items-center gap-2">
                    {status.startsWith('Error') ? (
                      <XCircle size={13} className="shrink-0 text-error" aria-hidden="true" />
                    ) : status === 'Done — indexing in the background' ? (
                      <CheckCircle2
                        size={13}
                        className="shrink-0 text-success"
                        aria-hidden="true"
                      />
                    ) : (
                      <Loader2
                        size={13}
                        className="shrink-0 animate-spin text-info"
                        aria-hidden="true"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate text-text-secondary">
                      {remoteReposByUrl.get(key)?.name ?? baseName(key)}
                    </span>
                    <span
                      className={status.startsWith('Error') ? 'text-error' : 'text-text-tertiary'}
                    >
                      {status}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {/* VS Code checkbox */}
            <label className="mt-3 flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={exportVSCode}
                onChange={(e) => setExportVSCode(e.target.checked)}
                className="accent-accent"
                disabled={mode === 'scaffold'}
              />
              <span className="text-sm text-text-secondary">
                {mode === 'scaffold'
                  ? 'VS Code workspace export unlocks after scaffolded repos are connected'
                  : 'Also create VS Code workspace file'}
              </span>
            </label>

            {error && <p className="mt-3 text-sm text-error">{error}</p>}

            <div className="mt-6 flex justify-end gap-2">
              {onCancel && (
                <Button variant="secondary" onClick={onCancel} disabled={phase === 'working'}>
                  Cancel
                </Button>
              )}
              <Button variant="primary" onClick={() => void handleCreate()} disabled={!canCreate}>
                {phase === 'working' ? 'Setting up…' : hasFailures ? 'Finish' : 'Create workspace'}
              </Button>
            </div>
          </>
        )}
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

function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function toTitleCase(value: string): string {
  return value
    .split(/[-_\s.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
