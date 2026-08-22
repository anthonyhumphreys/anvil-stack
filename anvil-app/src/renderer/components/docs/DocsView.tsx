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
import type { DocPage, AppSettings } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { ViewHeader } from '../layout/ViewScaffold';

export function DocsView() {
  const { repos, activeWorkspace, updatePreferences } = useWorkspace();
  const [pages, setPages] = useState<DocPage[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
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
  const [creating, setCreating] = useState(false);

  // Update state
  const [updatingPageId, setUpdatingPageId] = useState<string | null>(null);
  const [updatePreview, setUpdatePreview] = useState<string>('');
  const [generatingUpdate, setGeneratingUpdate] = useState(false);

  useEffect(() => {
    window.anvil.settings.get().then(setSettings);
  }, []);

  useEffect(() => {
    const indexed = repos.find((repo) => repo.status === 'indexed');
    if (indexed && !createRepoId) setCreateRepoId(indexed.id);
  }, [repos]);

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
    if (!settings || settings.docsProvider === 'none') return;
    setLoading(true);
    setError(null);
    try {
      const spaceKey =
        settings.docsProvider === 'confluence' ? settings.confluenceSpaceKey : undefined;
      const result = rootPageId
        ? await window.anvil.docs.listChildren(rootPageId)
        : await window.anvil.docs.listPages(spaceKey);
      setPages(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pages');
    } finally {
      setLoading(false);
    }
  }, [settings, rootPageId]);

  useEffect(() => {
    if (settings && settings.docsProvider !== 'none') {
      const isConfluenceConfigured =
        settings.docsProvider === 'confluence' &&
        settings.confluenceBaseUrl &&
        settings.confluencePat;
      const isNotionConfigured = settings.docsProvider === 'notion' && settings.notionOauthToken;

      if (
        (settings.docsProvider === 'confluence' && isConfluenceConfigured) ||
        (settings.docsProvider === 'notion' && isNotionConfigured)
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
      const indexed = repos.find((r) => r.status === 'indexed');
      if (!indexed) return;

      try {
        const staleness = await window.anvil.docs.checkStaleness(pageId, indexed.id);
        setPages((prev) => prev.map((p) => (p.id === pageId ? { ...p, staleness } : p)));
      } catch {
        // silently fail staleness check
      }
    },
    [repos],
  );

  const handleGenerateUpdate = useCallback(
    async (pageId: string) => {
      const indexed = repos.find((r) => r.status === 'indexed');
      if (!indexed) return;

      setUpdatingPageId(pageId);
      setUpdatePreview('');
      setGeneratingUpdate(true);
      try {
        const content = await window.anvil.docs.generateUpdate(pageId, indexed.id);
        setUpdatePreview(content);
      } catch (err) {
        setUpdatePreview(`Error: ${err instanceof Error ? err.message : 'Generation failed'}`);
      } finally {
        setGeneratingUpdate(false);
      }
    },
    [repos],
  );

  const handleCreatePage = useCallback(async () => {
    if (!settings || settings.docsProvider === 'none' || !createTitle || !createRepoId) return;
    setCreating(true);
    setError(null);
    try {
      const spaceKey =
        settings.docsProvider === 'confluence'
          ? settings.confluenceSpaceKey
          : (settings.notionDatabaseId ?? '');
      await window.anvil.docs.createPage(spaceKey, createTitle, createRepoId);
      setShowCreate(false);
      setCreateTitle('');
      // Refresh pages
      loadPages();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create page');
    } finally {
      setCreating(false);
    }
  }, [settings, createTitle, createRepoId, loadPages]);

  const isConfigured =
    !!settings &&
    settings.docsProvider !== 'none' &&
    ((settings.docsProvider === 'confluence' &&
      settings.confluenceBaseUrl &&
      settings.confluencePat) ||
      (settings.docsProvider === 'notion' && settings.notionOauthToken));
  const providerLabel =
    settings?.docsProvider === 'confluence'
      ? settings.confluenceSpaceKey
      : settings?.docsProvider === 'notion'
        ? 'Notion'
        : null;
  const indexedRepos = repos.filter((r) => r.status === 'indexed');

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
              onClick={() => setShowCreate(true)}
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
                  Documentation not configured. Set up a provider in Settings.
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
                <p className="text-sm text-text-secondary">No pages found in this space.</p>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredPages.map((page) => (
                <div key={page.id} className="rounded-md border border-border bg-bg-tertiary p-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            setRootPageId(page.id);
                            setBreadcrumbs((prev) => [...prev, { id: page.id, title: page.title }]);
                            setLabelFilter(null);
                          }}
                          className="text-sm font-medium text-text-primary hover:text-accent"
                        >
                          {page.title}
                        </button>
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
                          title="Open in Confluence"
                          aria-label="Open in Confluence"
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
                <pre className="whitespace-pre-wrap rounded-md border border-border bg-bg-primary p-3 text-xs text-text-primary">
                  {updatePreview}
                </pre>
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
                disabled={!createTitle || creating}
                className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-40"
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
