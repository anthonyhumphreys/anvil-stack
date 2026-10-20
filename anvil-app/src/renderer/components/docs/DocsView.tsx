import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileText,
  RefreshCw,
  Loader2,
  AlertTriangle,
  ExternalLink,
  Clock,
  Check,
  AlertCircle,
  Plus,
  Wifi,
  X,
  ChevronRight,
  Tag,
} from 'lucide-react';
import type { DocPage, AppSettings, DocsRequestContext } from '../../../shared/types';
import { repoIsMapped, useWorkspace } from '../../contexts/WorkspaceContext';
import { ViewHeader } from '../layout/ViewScaffold';
import { SettingsLink } from '../shared/SettingsLink';

export function DocsView() {
  const { repos, activeWorkspace, updatePreferences } = useWorkspace();
  const [pages, setPages] = useState<DocPage[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [linearProjects, setLinearProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [linearProjectId, setLinearProjectId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hierarchical browsing state
  const [rootPageId, setRootPageId] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ id: string; title: string }>>([]);

  // Label filter state
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const skipSaveRef = useRef(true);

  // Create page state
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createRepoId, setCreateRepoId] = useState('');
  const [createProjectId, setCreateProjectId] = useState('');
  const [creating, setCreating] = useState(false);

  // Update state
  const [updatingPageId, setUpdatingPageId] = useState<string | null>(null);
  const [updatePreview, setUpdatePreview] = useState<string>('');
  const [generatingUpdate, setGeneratingUpdate] = useState(false);
  const [savingUpdate, setSavingUpdate] = useState(false);
  const pagesRequestId = useRef(0);
  const updateRequestId = useRef(0);
  const createRequestId = useRef(0);
  const saveRequestId = useRef(0);
  const staleRequestId = useRef(0);
  const scopeRequestId = useRef(0);
  const settingsWorkspaceId = useRef<string | undefined>(activeWorkspace?.id);

  const docsContext = useMemo<DocsRequestContext | null>(() => {
    if (
      !settings ||
      settings.docsProvider === 'none' ||
      settingsWorkspaceId.current !== activeWorkspace?.id
    )
      return null;
    return {
      provider: settings.docsProvider,
      workspaceId: activeWorkspace?.id,
      connectionId: settings.activeWorkItemConnectionId,
    };
  }, [settings, activeWorkspace?.id]);

  useEffect(() => {
    let cancelled = false;
    const workspaceId = activeWorkspace?.id;
    window.anvil.settings.get().then((nextSettings) => {
      if (!cancelled) {
        settingsWorkspaceId.current = workspaceId;
        setSettings(nextSettings);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspace?.id]);

  useEffect(() => {
    const indexedRepos = repos.filter((repo) => repoIsMapped(repo));
    if (!indexedRepos.some((repo) => repo.id === createRepoId)) {
      setCreateRepoId(indexedRepos[0]?.id ?? '');
    }
  }, [repos, createRepoId]);

  useEffect(() => {
    const docsPrefs = activeWorkspace?.preferences?.docs;
    const nextRootPageId = docsPrefs?.parentPageId ?? null;
    const nextRootTitle = docsPrefs?.parentPageTitle ?? null;
    const nextLabel = docsPrefs?.label ?? null;

    setRootPageId(nextRootPageId);
    setBreadcrumbs(
      nextRootPageId && nextRootTitle ? [{ id: nextRootPageId, title: nextRootTitle }] : [],
    );
    setLabelFilter(nextLabel);
  }, [
    activeWorkspace?.id,
    activeWorkspace?.preferences?.docs.parentPageId,
    activeWorkspace?.preferences?.docs.parentPageTitle,
    activeWorkspace?.preferences?.docs.label,
  ]);

  useEffect(() => {
    if (settings?.docsProvider === 'linear') {
      setRootPageId(null);
      setBreadcrumbs([]);
    }
  }, [settings?.docsProvider]);

  useEffect(() => {
    scopeRequestId.current += 1;
    pagesRequestId.current += 1;
    updateRequestId.current += 1;
    createRequestId.current += 1;
    saveRequestId.current += 1;
    staleRequestId.current += 1;
    setPages([]);
    setLinearProjects([]);
    setLinearProjectId('');
    setCreateProjectId('');
    setShowCreate(false);
    setCreateTitle('');
    setCreateRepoId('');
    setCreating(false);
    setUpdatingPageId(null);
    setUpdatePreview('');
    setGeneratingUpdate(false);
    setSavingUpdate(false);
    setLoading(false);
    setError(null);
  }, [activeWorkspace?.id, settings?.docsProvider, settings?.activeWorkItemConnectionId]);

  useEffect(() => {
    if (!activeWorkspace) return;

    if (skipSaveRef.current) {
      skipSaveRef.current = false;
      return;
    }

    const currentDocs = activeWorkspace.preferences?.docs ?? {};
    const currentRootTitle = breadcrumbs[breadcrumbs.length - 1]?.title;

    if (
      currentDocs.parentPageId === (rootPageId ?? undefined) &&
      currentDocs.parentPageTitle === (currentRootTitle ?? undefined) &&
      currentDocs.label === (labelFilter ?? undefined)
    ) {
      return;
    }

    void updatePreferences({
      docs: {
        parentPageId: rootPageId ?? undefined,
        parentPageTitle: currentRootTitle,
        label: labelFilter ?? undefined,
      },
    });
  }, [activeWorkspace, breadcrumbs, labelFilter, rootPageId, updatePreferences]);

  const loadPages = useCallback(async () => {
    if (
      !settings ||
      settings.docsProvider === 'none' ||
      settingsWorkspaceId.current !== activeWorkspace?.id ||
      !docsContext
    )
      return;
    const requestId = ++pagesRequestId.current;
    const scopeId = scopeRequestId.current;
    setLoading(true);
    setError(null);
    try {
      const spaceKey =
        settings.docsProvider === 'confluence' ? settings.confluenceSpaceKey : undefined;
      const result =
        settings.docsProvider !== 'linear' && rootPageId
          ? await window.anvil.docs.listChildren(rootPageId, docsContext)
          : await window.anvil.docs.listPages(
              settings.docsProvider === 'linear' ? linearProjectId || undefined : spaceKey,
              docsContext,
            );
      if (requestId === pagesRequestId.current && scopeId === scopeRequestId.current)
        setPages(result);
    } catch (err) {
      if (requestId === pagesRequestId.current && scopeId === scopeRequestId.current)
        setError(err instanceof Error ? err.message : 'Failed to load pages');
    } finally {
      if (requestId === pagesRequestId.current && scopeId === scopeRequestId.current)
        setLoading(false);
    }
  }, [settings, rootPageId, linearProjectId, activeWorkspace?.id, docsContext]);

  useEffect(() => {
    if (settings?.docsProvider !== 'linear' || !settings.linearApiKey || !docsContext) {
      setLinearProjects([]);
      return;
    }
    let cancelled = false;
    const scopeId = scopeRequestId.current;
    window.anvil.docs
      .listProjects(docsContext)
      .then((projects) => {
        if (!cancelled && scopeId === scopeRequestId.current) setLinearProjects(projects);
      })
      .catch((err) => {
        if (!cancelled && scopeId === scopeRequestId.current)
          setError(err instanceof Error ? err.message : 'Failed to load Linear projects');
      });
    return () => {
      cancelled = true;
    };
  }, [settings?.docsProvider, settings?.linearApiKey, activeWorkspace?.id, settings?.activeWorkItemConnectionId, docsContext]);

  useEffect(() => {
    if (settings && settings.docsProvider !== 'none') {
      const isConfluenceConfigured =
        settings.docsProvider === 'confluence' &&
        settings.confluenceBaseUrl &&
        settings.confluencePat;
      const isNotionConfigured = settings.docsProvider === 'notion' && settings.notionOauthToken;
      const isLinearConfigured = settings.docsProvider === 'linear' && settings.linearApiKey;

      if (
        (settings.docsProvider === 'confluence' && isConfluenceConfigured) ||
        (settings.docsProvider === 'notion' && isNotionConfigured) ||
        (settings.docsProvider === 'linear' && isLinearConfigured)
      ) {
        loadPages();
      }
    }
  }, [settings, loadPages]);

  const allLabels = useMemo(() => {
    const labels = new Set<string>();
    pages.forEach((p) => p.labels?.forEach((l) => labels.add(l)));
    return [...labels].sort();
  }, [pages]);

  const filteredPages = useMemo(() => {
    if (!labelFilter) return pages;
    return pages.filter((p) => p.labels?.includes(labelFilter));
  }, [pages, labelFilter]);

  const handleCheckStaleness = useCallback(
    async (pageId: string) => {
      const indexed = repos.find((r) => repoIsMapped(r));
      if (!indexed || !docsContext) return;
      const requestId = ++staleRequestId.current;
      const scopeId = scopeRequestId.current;

      try {
        const staleness = await window.anvil.docs.checkStaleness(pageId, indexed.id, docsContext);
        if (requestId !== staleRequestId.current || scopeId !== scopeRequestId.current) return;
        setPages((prev) => prev.map((p) => (p.id === pageId ? { ...p, staleness } : p)));
      } catch {
        // silently fail staleness check
      }
    },
    [repos, docsContext],
  );

  const handleGenerateUpdate = useCallback(
    async (pageId: string) => {
      const indexed = repos.find((r) => repoIsMapped(r));
      if (!indexed || !docsContext) return;

      setUpdatingPageId(pageId);
      setUpdatePreview('');
      const requestId = ++updateRequestId.current;
      const scopeId = scopeRequestId.current;
      setGeneratingUpdate(true);
      try {
        const content = await window.anvil.docs.generateUpdate(pageId, indexed.id, docsContext);
        if (requestId === updateRequestId.current && scopeId === scopeRequestId.current)
          setUpdatePreview(content);
      } catch (err) {
        if (requestId === updateRequestId.current && scopeId === scopeRequestId.current)
          setUpdatePreview(`Error: ${err instanceof Error ? err.message : 'Generation failed'}`);
      } finally {
        if (requestId === updateRequestId.current && scopeId === scopeRequestId.current)
          setGeneratingUpdate(false);
      }
    },
    [repos, docsContext],
  );

  const handleCreatePage = useCallback(async () => {
    if (
      !settings ||
      settings.docsProvider === 'none' ||
      !docsContext ||
      !createTitle ||
      !createRepoId ||
      !repos.some((repo) => repo.id === createRepoId && repoIsMapped(repo)) ||
      (settings.docsProvider === 'linear' && !createProjectId)
    )
      return;
    const requestId = ++createRequestId.current;
    const scopeId = scopeRequestId.current;
    setCreating(true);
    setError(null);
    try {
      const scope =
        settings.docsProvider === 'confluence'
          ? settings.confluenceSpaceKey
          : settings.docsProvider === 'linear'
            ? createProjectId
            : (settings.notionDatabaseId ?? '');
      await window.anvil.docs.createPage(scope, createTitle, createRepoId, docsContext);
      if (requestId !== createRequestId.current || scopeId !== scopeRequestId.current) return;
      setShowCreate(false);
      setCreateTitle('');
      // Refresh pages
      void loadPages();
    } catch (err) {
      if (requestId === createRequestId.current && scopeId === scopeRequestId.current)
        setError(err instanceof Error ? err.message : 'Failed to create page');
    } finally {
      if (requestId === createRequestId.current && scopeId === scopeRequestId.current)
        setCreating(false);
    }
  }, [settings, docsContext, createTitle, createRepoId, createProjectId, repos, loadPages]);

  const handleSaveUpdate = useCallback(async () => {
    const page = pages.find((candidate) => candidate.id === updatingPageId);
    if (
      !settings ||
      settings.docsProvider === 'none' ||
      !docsContext ||
      !page ||
      settingsWorkspaceId.current !== activeWorkspace?.id ||
      updatePreview.startsWith('Error:')
    )
      return;
    const requestId = ++saveRequestId.current;
    const scopeId = scopeRequestId.current;
    setSavingUpdate(true);
    setError(null);
    try {
      await window.anvil.docs.updatePage(
        page.id,
        page.title,
        updatePreview,
        docsContext,
      );
      if (requestId !== saveRequestId.current || scopeId !== scopeRequestId.current) return;
      setUpdatingPageId(null);
      setUpdatePreview('');
      await loadPages();
    } catch (err) {
      if (requestId === saveRequestId.current && scopeId === scopeRequestId.current)
        setError(err instanceof Error ? err.message : 'Failed to update page');
    } finally {
      if (requestId === saveRequestId.current && scopeId === scopeRequestId.current)
        setSavingUpdate(false);
    }
  }, [pages, updatingPageId, updatePreview, settings, docsContext, loadPages, activeWorkspace?.id]);

  const isConfigured =
    !!settings &&
    settings.docsProvider !== 'none' &&
    ((settings.docsProvider === 'confluence' &&
      settings.confluenceBaseUrl &&
      settings.confluencePat) ||
      (settings.docsProvider === 'notion' && settings.notionOauthToken) ||
      (settings.docsProvider === 'linear' && settings.linearApiKey));
  const providerLabel =
    settings?.docsProvider === 'confluence'
      ? settings.confluenceSpaceKey
      : settings?.docsProvider === 'notion'
        ? 'Notion'
        : settings?.docsProvider === 'linear'
          ? 'Linear'
          : null;
  const indexedRepos = repos.filter((r) => repoIsMapped(r));

  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        icon={FileText}
        title="Documentation"
        description="Browse connected knowledge and create repository-grounded pages."
        meta={
          providerLabel ? (
            <span className="rounded-md bg-bg-tertiary px-2 py-0.5 text-xs text-text-tertiary">
              {providerLabel}
            </span>
          ) : undefined
        }
        actions={
          <>
            <button
              onClick={() => {
                setCreateProjectId(linearProjectId);
                setShowCreate(true);
              }}
              disabled={!isConfigured || indexedRepos.length === 0}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm text-text-secondary hover:text-text-primary disabled:opacity-40"
            >
              <Plus size={12} />
              New Page
            </button>
            <button
              onClick={loadPages}
              disabled={loading || !isConfigured}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm text-text-secondary hover:text-text-primary disabled:opacity-40"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </>
        }
      />

      {/* Breadcrumb + filter toolbar */}
      <div className="flex items-center gap-3 border-b border-border-subtle bg-bg-secondary px-4 py-1.5">
        {/* Breadcrumbs */}
        <div className="flex items-center gap-1 text-sm">
          <button
            onClick={() => {
              setRootPageId(null);
              setBreadcrumbs([]);
              setLabelFilter(null);
            }}
            className={`hover:text-text-primary ${!rootPageId ? 'font-medium text-text-primary' : 'text-text-secondary'}`}
          >
            {providerLabel || 'Docs'}
          </button>
          {breadcrumbs.map((crumb, i) => (
            <Fragment key={crumb.id}>
              <ChevronRight size={10} className="text-text-secondary" />
              <button
                onClick={() => {
                  setRootPageId(crumb.id);
                  setBreadcrumbs((prev) => prev.slice(0, i + 1));
                  setLabelFilter(null);
                }}
                className={`hover:text-text-primary ${
                  i === breadcrumbs.length - 1
                    ? 'font-medium text-text-primary'
                    : 'text-text-secondary'
                }`}
              >
                {crumb.title}
              </button>
            </Fragment>
          ))}
        </div>

        <div className="flex-1" />

        {/* Label filter */}
        {settings?.docsProvider === 'linear' && (
          <select
            value={linearProjectId}
            onChange={(event) => setLinearProjectId(event.target.value)}
            aria-label="Filter documents by Linear project"
            className="rounded border border-border bg-bg-primary px-2 py-0.5 text-sm text-text-primary"
          >
            <option value="">All Linear documents</option>
            {linearProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        )}
        {allLabels.length > 0 && (
          <div className="flex items-center gap-1.5">
            <Tag size={12} className="text-text-tertiary" />
            <select
              value={labelFilter || ''}
              onChange={(e) => setLabelFilter(e.target.value || null)}
              className="rounded border border-border bg-bg-primary px-2 py-0.5 text-sm text-text-primary"
            >
              <option value="">All labels</option>
              {allLabels.map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Pages list */}
        <div className="flex-1 overflow-auto p-4">
          {!isConfigured ? (
            <div className="flex h-64 items-center justify-center">
              <div className="text-center">
                <Wifi size={32} className="mx-auto mb-3 text-text-tertiary" />
                <p className="text-sm text-text-secondary">
                  {settings?.docsProvider === 'linear' ? (
                    <>
                      Connect a Linear work-item connection in{' '}
                      <SettingsLink to="delivery#work-items">Work Items settings</SettingsLink>,
                      then choose Linear in{' '}
                      <SettingsLink to="delivery#docs">Documentation settings</SettingsLink>.
                    </>
                  ) : (
                    <>
                      Documentation not configured.{' '}
                      <SettingsLink to="delivery#docs">Set up a provider in Settings</SettingsLink>.
                    </>
                  )}
                </p>
              </div>
            </div>
          ) : error ? (
            <div className="flex items-start gap-2 rounded-md border border-error/30 bg-error/10 px-3 py-2">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-error" />
              <p className="text-sm text-error">{error}</p>
            </div>
          ) : loading ? (
            <div className="flex h-64 items-center justify-center">
              <Loader2 size={24} className="animate-spin text-accent" />
            </div>
          ) : filteredPages.length === 0 ? (
            <div className="flex h-64 items-center justify-center">
              <div className="text-center">
                <FileText size={32} className="mx-auto mb-3 text-text-tertiary" />
                <p className="text-sm text-text-secondary">
                  {settings?.docsProvider === 'linear'
                    ? 'No Linear documents found for this project.'
                    : 'No pages found in this space.'}
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredPages.map((page) => (
                <div key={page.id} className="rounded-md border border-border bg-bg-tertiary p-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        {page.provider === 'linear' && page.url ? (
                          <a
                            href={page.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm font-medium text-text-primary hover:text-accent"
                          >
                            {page.title}
                          </a>
                        ) : page.provider === 'linear' ? (
                          <span className="text-sm font-medium text-text-primary">
                            {page.title}
                          </span>
                        ) : (
                          <button
                            onClick={() => {
                              setRootPageId(page.id);
                              setBreadcrumbs((prev) => [
                                ...prev,
                                { id: page.id, title: page.title },
                              ]);
                              setLabelFilter(null);
                            }}
                            className="text-sm font-medium text-text-primary hover:text-accent"
                          >
                            {page.title}
                          </button>
                        )}
                        <StalenessIndicator staleness={page.staleness} />
                      </div>
                      <div className="mt-1 flex items-center gap-3 text-xs text-text-secondary">
                        <span className="flex items-center gap-1">
                          <Clock size={10} />
                          {page.lastUpdated
                            ? new Date(page.lastUpdated).toLocaleDateString()
                            : 'Unknown'}
                        </span>
                        {page.lastUpdatedBy && <span>by {page.lastUpdatedBy}</span>}
                        {page.provider === 'linear' && page.projectName && (
                          <span>{page.projectName}</span>
                        )}
                      </div>
                      {page.labels && page.labels.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {page.labels.map((label) => (
                            <button
                              key={label}
                              onClick={() => setLabelFilter(label)}
                              className="cursor-pointer rounded bg-bg-elevated px-1.5 py-0.5 text-xs text-text-secondary hover:text-accent"
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleCheckStaleness(page.id)}
                        className="rounded px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
                        title="Check staleness"
                        aria-label="Check staleness"
                      >
                        <AlertCircle size={12} />
                      </button>
                      {page.staleness === 'stale' && (
                        <button
                          onClick={() => handleGenerateUpdate(page.id)}
                          className="rounded px-2 py-1 text-xs text-info hover:bg-info/10"
                          title="Generate update"
                          aria-label="Generate update"
                        >
                          <RefreshCw size={12} />
                        </button>
                      )}
                      {page.url && (
                        <a
                          href={page.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
                          title={`Open in ${page.provider === 'linear' ? 'Linear' : page.provider === 'notion' ? 'Notion' : 'Confluence'}`}
                          aria-label={`Open in ${page.provider === 'linear' ? 'Linear' : page.provider === 'notion' ? 'Notion' : 'Confluence'}`}
                        >
                          <ExternalLink size={12} />
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Update preview panel */}
        {updatingPageId && (
          <div className="w-[420px] shrink-0 border-l border-border bg-bg-secondary">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-sm font-medium text-text-primary">Update Preview</span>
              <button
                onClick={() => {
                  setUpdatingPageId(null);
                  setUpdatePreview('');
                }}
                className="rounded p-0.5 text-text-tertiary hover:text-text-primary"
                aria-label="Close preview panel"
              >
                <X size={14} />
              </button>
            </div>
            <div className="overflow-auto p-3">
              {generatingUpdate ? (
                <div className="flex h-48 items-center justify-center">
                  <div className="text-center">
                    <Loader2 size={20} className="mx-auto mb-2 animate-spin text-accent" />
                    <p className="text-sm text-text-secondary">Generating update...</p>
                  </div>
                </div>
              ) : (
                <>
                  <pre className="whitespace-pre-wrap rounded-md border border-border bg-bg-primary p-3 text-xs text-text-primary">
                    {updatePreview}
                  </pre>
                  <button
                    onClick={handleSaveUpdate}
                    disabled={!updatePreview || updatePreview.startsWith('Error:') || savingUpdate}
                    className="mt-3 flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:bg-accent/90 disabled:opacity-40"
                  >
                    {savingUpdate && <Loader2 size={12} className="animate-spin" />}
                    Save update
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Create page modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-96 rounded-lg border border-border bg-bg-elevated p-4 shadow-lg">
            <h3 className="text-base font-semibold text-text-primary">Create New Page</h3>

            <div className="mt-3 space-y-3">
              <div>
                <label className="mb-1 block text-sm text-text-secondary">Page Title</label>
                <input
                  type="text"
                  value={createTitle}
                  onChange={(e) => setCreateTitle(e.target.value)}
                  placeholder="e.g. API Reference"
                  className="w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm text-text-secondary">Source Repository</label>
                <select
                  value={createRepoId}
                  onChange={(e) => setCreateRepoId(e.target.value)}
                  className="w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
                >
                  {indexedRepos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
              {settings?.docsProvider === 'linear' && (
                <div>
                  <label className="mb-1 block text-sm text-text-secondary">Linear project</label>
                  <select
                    value={createProjectId}
                    onChange={(event) => setCreateProjectId(event.target.value)}
                    required
                    className="w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
                  >
                    <option value="">Choose a project</option>
                    {linearProjects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowCreate(false)}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                onClick={handleCreatePage}
                disabled={
                  !createTitle ||
                  creating ||
                  (settings?.docsProvider === 'linear' && !createProjectId)
                }
                className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:bg-accent/90 disabled:opacity-40"
              >
                {creating && <Loader2 size={12} className="animate-spin" />}
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StalenessIndicator({ staleness }: { staleness?: DocPage['staleness'] }) {
  if (!staleness || staleness === 'unknown') return null;

  return staleness === 'stale' ? (
    <span className="flex items-center gap-1 rounded-full border border-warning/50 px-1.5 py-0.5 text-xs text-warning">
      <AlertTriangle size={8} />
      Stale
    </span>
  ) : (
    <span className="flex items-center gap-1 rounded-full border border-success/50 px-1.5 py-0.5 text-xs text-success">
      <Check size={8} />
      Current
    </span>
  );
}
