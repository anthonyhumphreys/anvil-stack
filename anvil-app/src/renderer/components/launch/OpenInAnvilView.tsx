import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, FolderOpen, Loader2, Rocket, XCircle } from 'lucide-react';
import type { OpenInAnvilLaunchIntent } from '../../../shared/types';
import { useBrand } from '../../contexts/BrandContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';

export function OpenInAnvilView() {
  const navigate = useNavigate();
  const brand = useBrand();
  const { createWorkspace, refreshWorkspaces, workspaces } = useWorkspace();
  const [intent, setIntent] = useState<OpenInAnvilLaunchIntent | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [targetFolder, setTargetFolder] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [cloneStatuses, setCloneStatuses] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;

    window.anvil.launch
      .getPendingIntent()
      .then((pendingIntent) => {
        if (cancelled || !pendingIntent) return;
        setIntent(pendingIntent);
        setWorkspaceName(pendingIntent.workspaceName ?? deriveWorkspaceName(pendingIntent));
        setTargetFolder('');
      })
      .catch(() => {});

    const cleanup = window.anvil.launch.onIntent((nextIntent) => {
      if (cancelled) return;
      setIntent(nextIntent);
      setWorkspaceName(nextIntent.workspaceName ?? deriveWorkspaceName(nextIntent));
      setTargetFolder('');
      setError(null);
      setCurrentStep(null);
      setCloneStatuses({});
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  useEffect(() => {
    return window.anvil.repo.onCloneProgress(({ cloneUrl, message }) => {
      setCloneStatuses((prev) => ({ ...prev, [cloneUrl]: message }));
    });
  }, []);

  const handleChooseFolder = useCallback(async () => {
    const selected = await window.anvil.repo.selectDirectory();
    if (selected) setTargetFolder(selected);
  }, []);

  const handleCancel = useCallback(async () => {
    await window.anvil.launch.clearPendingIntent();
    setIntent(null);
    setWorkspaceName('');
    setTargetFolder('');
    setError(null);
    setCurrentStep(null);
    setCloneStatuses({});
    if (workspaces.length > 0) {
      navigate('/repos', { replace: true });
    }
  }, [navigate, workspaces.length]);

  const handleConfirm = useCallback(async () => {
    if (!intent) return;
    if (!workspaceName.trim()) {
      setError('Please enter a workspace name.');
      return;
    }
    if (!targetFolder) {
      setError('Please choose a folder for the cloned repositories.');
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const repoIds: string[] = [];

      for (let index = 0; index < intent.repos.length; index += 1) {
        const repo = intent.repos[index];
        setCurrentStep(
          `Cloning ${repo.name ?? repo.cloneUrl} (${index + 1} of ${intent.repos.length})...`,
        );
        setCloneStatuses((prev) => ({ ...prev, [repo.cloneUrl]: 'Queued...' }));
        try {
          const localPath = await window.anvil.repo.clone(
            repo.cloneUrl,
            targetFolder,
            repo.provider,
          );
          setCurrentStep(`Connecting ${repo.name ?? repo.cloneUrl}...`);
          const repoInfo = await window.anvil.repo.connect(localPath);
          repoIds.push(repoInfo.id);
          setCloneStatuses((prev) => ({ ...prev, [repo.cloneUrl]: 'Connected' }));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Clone failed';
          setCloneStatuses((prev) => ({ ...prev, [repo.cloneUrl]: `Error: ${message}` }));
          throw err;
        }
      }

      setCurrentStep('Creating workspace...');
      const workspace = await createWorkspace({ name: workspaceName.trim(), repoIds });
      setCurrentStep('Saving workspace preferences...');
      await window.anvil.workspace.updatePreferences(workspace.id, {
        workitems: intent.iterationId
          ? {
              iterationIds: [intent.iterationId],
              iterationNames: intent.iterationName ? [intent.iterationName] : [],
            }
          : {},
        docs: {
          parentPageId: intent.docsParentId,
          parentPageTitle: intent.docsParentTitle,
        },
        launch: {
          source: 'deeplink',
          sourceUrl: intent.sourceUrl,
          requestedAt: intent.receivedAt,
        },
      });

      setCurrentStep('Switching to the new workspace...');
      await window.anvil.launch.clearPendingIntent();
      await refreshWorkspaces();

      if (intent.iterationId) {
        navigate('/workitems', { replace: true });
      } else if (intent.docsParentId) {
        navigate('/docs', { replace: true });
      } else {
        navigate('/repos', { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace from deep link.');
    } finally {
      setCurrentStep(null);
      setCreating(false);
    }
  }, [createWorkspace, intent, navigate, refreshWorkspaces, targetFolder, workspaceName]);

  const summaryRows = useMemo(() => {
    if (!intent) return [];
    return [
      intent.iterationName ? `Work items will be filtered to ${intent.iterationName}.` : null,
      intent.docsParentTitle ? `Documentation will be scoped to ${intent.docsParentTitle}.` : null,
    ].filter((value): value is string => Boolean(value));
  }, [intent]);

  if (!intent) {
    return (
      <div className="mx-auto flex h-full max-w-3xl items-center justify-center p-6">
        <div className="w-full rounded-xl border border-border bg-bg-secondary p-8 text-center">
          <XCircle size={28} className="mx-auto text-text-tertiary" />
          <h2 className="mt-4 text-xl font-semibold text-text-primary">
            No pending {brand.appName} link
          </h2>
          <p className="mt-2 text-sm text-text-secondary">
            Open a deep link from your documentation to start this setup flow.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl items-center justify-center p-6">
      <div className="w-full rounded-xl border border-border bg-bg-secondary p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <Rocket size={20} className="text-accent" />
          <div>
            <h2 className="text-xl font-semibold text-text-primary">Open in {brand.appName}</h2>
            <p className="text-sm text-text-secondary">
              Review the requested setup before {brand.appName} clones repositories and creates the
              workspace.
            </p>
          </div>
        </div>

        <div className="mt-6">
          <label className="mb-1 block text-sm font-medium text-text-secondary">
            Workspace name
          </label>
          <input
            type="text"
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
            className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
          />
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-text-secondary">
              Destination folder
            </label>
            <button
              type="button"
              onClick={handleChooseFolder}
              className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-sm text-text-secondary hover:text-text-primary"
            >
              <FolderOpen size={14} />
              Choose Folder
            </button>
          </div>
          <p className="mt-2 rounded-md border border-border-subtle bg-bg-primary px-3 py-2 font-mono text-xs text-text-secondary">
            {targetFolder || 'No folder selected yet'}
          </p>
        </div>

        <div className="mt-5">
          <h3 className="text-sm font-medium text-text-secondary">Repositories</h3>
          <div className="mt-2 space-y-2">
            {intent.repos.map((repo) => (
              <div
                key={repo.cloneUrl}
                className="rounded-md border border-border-subtle bg-bg-primary px-3 py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary">
                      {repo.name ?? repo.cloneUrl}
                    </p>
                    <p className="truncate text-xs text-text-secondary">{repo.cloneUrl}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs uppercase tracking-wide text-text-tertiary">
                      {repo.provider}
                    </p>
                    {cloneStatuses[repo.cloneUrl] && (
                      <p className="mt-1 text-xs text-text-secondary">
                        {cloneStatuses[repo.cloneUrl]}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {summaryRows.length > 0 && (
          <div className="mt-5 rounded-md border border-border-subtle bg-bg-primary p-3">
            <h3 className="text-sm font-medium text-text-secondary">Requested filters</h3>
            <div className="mt-2 space-y-1 text-sm text-text-secondary">
              {summaryRows.map((row) => (
                <p key={row}>{row}</p>
              ))}
            </div>
          </div>
        )}

        <div className="mt-5 rounded-md border border-info/20 bg-info/5 p-3">
          <div className="flex items-start gap-2">
            <ExternalLink size={14} className="mt-0.5 shrink-0 text-info" />
            <p className="text-sm text-text-secondary">
              The deep link only bootstraps setup. After confirmation, sprint and documentation
              scope will be saved as workspace preferences.
            </p>
          </div>
        </div>

        {error && <p className="mt-4 text-sm text-error">{error}</p>}

        {creating && currentStep && (
          <div className="mt-4 rounded-md border border-accent/20 bg-accent/5 px-3 py-2">
            <p className="text-sm text-text-primary">{currentStep}</p>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={handleCancel}
            disabled={creating}
            className="rounded-md border border-border px-4 py-2 text-sm text-text-secondary hover:bg-bg-tertiary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={creating}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {creating ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" />
                Creating Workspace...
              </span>
            ) : (
              'Create Workspace'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function deriveWorkspaceName(intent: OpenInAnvilLaunchIntent): string {
  if (intent.repos.length === 1) {
    return intent.repos[0].name ?? 'New Workspace';
  }

  if (intent.docsParentTitle) {
    return intent.docsParentTitle;
  }

  return 'New Workspace';
}
