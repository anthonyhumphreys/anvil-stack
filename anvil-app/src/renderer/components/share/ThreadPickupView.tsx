import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, FilePlus2, LoaderCircle, ShieldCheck } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Persona, RepoInfo, UserRole, WorkspaceWithRepos } from '../../../shared/types';
import type { ThreadPickupPreview } from '../../../shared/thread-pickup-ipc';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import {
  readThreadAccessStore,
  setThreadAccessLevel,
  writeThreadAccessStore,
} from '../chat/thread-access';
import { groupPersonasForRole } from '../../utils/persona-groups';
import { Button } from '../ui';

interface ThreadPickupViewProps {
  userRole: UserRole;
}

function safeError(): string {
  return 'Could not prepare this thread package. Choose a valid .anvil-thread file and try again.';
}

export function ThreadPickupView({ userRole }: ThreadPickupViewProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { workspaces, switchWorkspace } = useWorkspace();
  const [preview, setPreview] = useState<ThreadPickupPreview | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [workspaceRepos, setWorkspaceRepos] = useState<RepoInfo[]>([]);
  const [repoIds, setRepoIds] = useState<string[]>([]);
  const [personaId, setPersonaId] = useState('');
  const [operation, setOperation] = useState<'prepare' | 'confirm' | null>(null);
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const busy = operation ?? (loadingWorkspace ? 'workspace' : null);
  const [error, setError] = useState<string | null>(null);
  const [completedThreadId, setCompletedThreadId] = useState<string | null>(null);
  const preparedIdRef = useRef<string | null>(null);
  const activeRef = useRef(true);
  const operationRef = useRef(false);

  const availablePersonas = useMemo(
    () => groupPersonasForRole(personas, userRole).flatMap((group) => group.personas),
    [personas, userRole],
  );
  const missingRepoNames = useMemo(() => {
    if (!preview) return [];
    const localNames = new Set(
      workspaceRepos
        .filter((repo) => repoIds.includes(repo.id))
        .map((repo) => repo.name.toLocaleLowerCase()),
    );
    return preview.repoNames.filter((name) => !localNames.has(name.toLocaleLowerCase()));
  }, [preview, workspaceRepos, repoIds]);

  const loadPrepared = useCallback(async () => {
    if (operationRef.current) return;
    operationRef.current = true;
    setOperation('prepare');
    setError(null);
    try {
      const next = await window.anvil.shares.preparePickup();
      if (!activeRef.current) {
        if (next) void window.anvil.shares.cancelPickup(next.preparedId).catch(() => undefined);
        return;
      }
      if (!next) return;
      const previousId = preparedIdRef.current;
      preparedIdRef.current = next.preparedId;
      setPreview(next);
      setCompletedThreadId(null);
      if (previousId) void window.anvil.shares.cancelPickup(previousId).catch(() => undefined);
    } catch {
      if (activeRef.current) setError(safeError());
    } finally {
      operationRef.current = false;
      if (activeRef.current) setOperation(null);
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    let cancelled = false;
    void window.anvil.chat
      .getPersonas()
      .then((items) => {
        if (!cancelled) setPersonas(items);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the available personas.');
      });
    return () => {
      cancelled = true;
      activeRef.current = false;
      const preparedId = preparedIdRef.current;
      preparedIdRef.current = null;
      if (preparedId) void window.anvil.shares.cancelPickup(preparedId).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (busy || completedThreadId) return;
    let cancelled = false;
    void window.anvil.shares
      .pickupPending()
      .then((pending) => {
        if (!cancelled && pending) void loadPrepared();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [busy, completedThreadId, loadPrepared, location.key]);

  useEffect(() => {
    if (!workspaceId) {
      setWorkspaceRepos([]);
      setRepoIds([]);
      setLoadingWorkspace(false);
      return;
    }
    let cancelled = false;
    setLoadingWorkspace(true);
    setWorkspaceRepos([]);
    setRepoIds([]);
    void window.anvil.workspace
      .get(workspaceId)
      .then((workspace: WorkspaceWithRepos | null) => {
        if (cancelled) return;
        setWorkspaceRepos(workspace?.repos ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setWorkspaceRepos([]);
          setError('Could not load repositories for that workspace.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingWorkspace(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const discard = async () => {
    if (operationRef.current) return;
    const preparedId = preparedIdRef.current;
    preparedIdRef.current = null;
    setPreview(null);
    setCompletedThreadId(null);
    setError(null);
    if (preparedId) await window.anvil.shares.cancelPickup(preparedId).catch(() => undefined);
    if (activeRef.current) navigate('/chat');
  };

  const toggleRepo = (repoId: string) => {
    setRepoIds((selected) =>
      selected.includes(repoId) ? selected.filter((id) => id !== repoId) : [...selected, repoId],
    );
  };

  const confirm = async () => {
    if (
      busy ||
      operationRef.current ||
      completedThreadId ||
      !preview ||
      !workspaceId ||
      !personaId ||
      preparedIdRef.current !== preview.preparedId
    )
      return;
    operationRef.current = true;
    setOperation('confirm');
    setError(null);
    try {
      const thread = await window.anvil.shares.confirmPickup({
        preparedId: preview.preparedId,
        workspaceId,
        repoIds,
        personaId,
      });
      preparedIdRef.current = null;
      if (activeRef.current) setCompletedThreadId(thread.id);
      await openPickedUpThread(thread.id);
    } catch {
      if (activeRef.current)
        setError(
          'Could not finish this import. Retry, or choose the package again if its preview expired or was used.',
        );
    } finally {
      operationRef.current = false;
      if (activeRef.current) setOperation(null);
    }
  };

  const openPickedUpThread = async (threadId: string) => {
    if (!workspaceId) return;
    const store = readThreadAccessStore(workspaceId);
    writeThreadAccessStore(workspaceId, setThreadAccessLevel(store, threadId, 'on-request'));
    if (readThreadAccessStore(workspaceId).threads[threadId] !== 'on-request') {
      if (activeRef.current)
        setError(
          'The thread was created, but its access setting could not be saved. Free some local storage, then try opening it again.',
        );
      return;
    }
    if (!activeRef.current) return;
    try {
      await switchWorkspace(workspaceId);
      if (activeRef.current) navigate(`/chat?thread=${encodeURIComponent(threadId)}`);
    } catch {
      if (activeRef.current)
        setError(
          'The thread was created, but Anvil could not switch to the selected workspace. Try opening it again.',
        );
    }
  };

  return (
    <main className="mx-auto flex h-full w-full max-w-5xl flex-col gap-5 overflow-y-auto p-6 text-text-primary">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Pick up a shared thread</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            Review the frozen snapshot, then choose the workspace, repositories, and persona for a
            new private thread. Nothing is sent until you write and send your own message.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void discard()} disabled={busy !== null}>
          <ArrowLeft size={15} />
          Close
        </Button>
      </header>

      {!preview ? (
        <section className="rounded-xl border border-border bg-bg-secondary p-6">
          <div className="flex items-start gap-3">
            <FilePlus2 className="mt-0.5 text-accent" size={20} />
            <div className="min-w-0 flex-1">
              <h2 className="font-medium">Choose a .anvil-thread file</h2>
              <p className="mt-1 text-sm text-text-secondary">
                Anvil will show you what is inside before creating anything in your workspace.
              </p>
            </div>
            <Button onClick={() => void loadPrepared()} disabled={busy !== null}>
              {busy === 'prepare' ? <LoaderCircle className="animate-spin" size={15} /> : null}
              Choose file
            </Button>
          </div>
        </section>
      ) : (
        <>
          <section className="grid gap-4 rounded-xl border border-border bg-bg-secondary p-5 md:grid-cols-[minmax(0,1fr)_260px]">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
                Frozen snapshot
              </p>
              <h2 className="mt-1 break-words text-lg font-semibold">{preview.title}</h2>
              <p className="mt-1 text-sm text-text-secondary">
                Shared {new Date(preview.sharedAt).toLocaleString()} · {preview.messageCount}{' '}
                {preview.messageCount === 1 ? 'message' : 'messages'} · v{preview.source.version}
              </p>
              <p className="mt-1 text-xs text-text-tertiary">
                Source share {preview.source.shareId} · {(preview.byteLength / 1024).toFixed(1)} KB
              </p>
              {preview.ticket ? (
                <p className="mt-3 text-sm text-text-secondary">
                  Source ticket: <span className="font-medium">{preview.ticket.id}</span>
                  {preview.ticket.title ? ` · ${preview.ticket.title}` : ''} (
                  {preview.ticket.provider})
                </p>
              ) : null}
              {preview.repoNames.length ? (
                <div className="mt-3">
                  <p className="text-xs font-medium text-text-secondary">Source repositories</p>
                  <p className="mt-1 text-sm text-text-secondary">{preview.repoNames.join(', ')}</p>
                </div>
              ) : null}
              {preview.items.length ? (
                <div className="mt-3">
                  <p className="text-xs font-medium text-text-secondary">Included items</p>
                  <ul className="mt-1 space-y-1 text-sm text-text-secondary">
                    {preview.items.map((item, index) => (
                      <li key={`${item.kind}-${index}`}>
                        {item.title} <span className="text-text-tertiary">({item.kind})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            <div className="flex flex-col justify-between gap-4 rounded-lg border border-border bg-bg-primary p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="text-success" size={17} />
                New private thread
              </div>
              <p className="text-xs leading-relaxed text-text-secondary">
                The shared snapshot is copied into a new thread in your selected workspace. Its
                access level starts at Ask for extra access.
              </p>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-bg-secondary p-5">
            <h2 className="font-medium">Choose your context</h2>
            <p className="mt-1 text-sm text-text-secondary">
              These are your local settings and repositories. The source thread’s permissions,
              provider login, and repository paths are not carried over.
            </p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="space-y-1 text-sm font-medium text-text-secondary">
                Workspace
                <select
                  aria-label="Workspace"
                  className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-text-primary"
                  value={workspaceId}
                  disabled={busy !== null || completedThreadId !== null}
                  onChange={(event) => setWorkspaceId(event.target.value)}
                >
                  <option value="">Choose a workspace</option>
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-sm font-medium text-text-secondary">
                Persona
                <select
                  aria-label="Persona"
                  className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-text-primary"
                  value={personaId}
                  disabled={busy !== null || completedThreadId !== null}
                  onChange={(event) => setPersonaId(event.target.value)}
                >
                  <option value="">Choose a persona</option>
                  {availablePersonas.map((persona) => (
                    <option key={persona.id} value={persona.id}>
                      {persona.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-4">
              <p className="text-sm font-medium text-text-secondary">
                Repositories for this thread
              </p>
              {!workspaceId ? (
                <p className="mt-1 text-sm text-text-tertiary">Choose a workspace first.</p>
              ) : workspaceRepos.length === 0 ? (
                <p className="mt-1 text-sm text-text-tertiary">
                  This workspace has no connected repositories. You can continue without repository
                  context.
                </p>
              ) : (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {workspaceRepos.map((repo) => (
                    <label
                      key={repo.id}
                      className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={repoIds.includes(repo.id)}
                        disabled={busy !== null || completedThreadId !== null}
                        onChange={() => toggleRepo(repo.id)}
                      />
                      <span>{repo.name}</span>
                    </label>
                  ))}
                </div>
              )}
              {workspaceId && missingRepoNames.length > 0 ? (
                <p className="mt-2 text-xs text-text-tertiary">
                  Not selected locally: {missingRepoNames.join(', ')}. Select any repositories above
                  that you want to use instead.
                </p>
              ) : null}
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border border-border bg-bg-secondary">
            <div className="border-b border-border px-5 py-3">
              <h2 className="font-medium">Snapshot preview</h2>
              <p className="mt-1 text-xs text-text-secondary">
                This is a read-only preview. It does not execute scripts or embedded actions.
              </p>
            </div>
            <iframe
              title="Shared thread snapshot preview"
              sandbox=""
              srcDoc={preview.previewDocument}
              className="h-[420px] w-full bg-white"
            />
          </section>
        </>
      )}

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-error/30 bg-error/5 px-3 py-2 text-sm text-error"
        >
          {error}
        </p>
      ) : null}

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <Button variant="ghost" onClick={() => void discard()} disabled={busy !== null}>
          {completedThreadId ? 'Close' : 'Discard and close'}
        </Button>
        {preview && !completedThreadId ? (
          <Button variant="ghost" onClick={() => void loadPrepared()} disabled={busy !== null}>
            Choose another file
          </Button>
        ) : null}
        {completedThreadId ? (
          <Button
            onClick={() => void openPickedUpThread(completedThreadId)}
            disabled={busy !== null}
          >
            Open picked-up thread
          </Button>
        ) : (
          <Button
            onClick={() => void confirm()}
            disabled={!preview || !workspaceId || !personaId || busy !== null}
          >
            {busy === 'confirm' ? <LoaderCircle className="animate-spin" size={15} /> : null}
            Pick up the thread
          </Button>
        )}
      </footer>
    </main>
  );
}
