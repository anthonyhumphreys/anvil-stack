import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  BookOpenText,
  Copy,
  ExternalLink,
  FileCode2,
  FolderOpen,
  Loader2,
  MessageSquare,
  MonitorSmartphone,
  RefreshCw,
  Search,
  SquareTerminal,
  Waypoints,
  XCircle,
} from 'lucide-react';
import type {
  ChatFileMentionSearchResult,
  EmbeddedEditorFileSnapshot,
  EmbeddedEditorStatus,
  EmbeddedEditorTarget,
  RepoInfo,
} from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { buildEditorUrl, parseEditorSearchParams } from '../../utils/editor-link';
import { copyTextToClipboard } from '../../utils/clipboard';
import { isEditableShortcutTarget } from '../../utils/keyboard';
import { slugForDomId } from '../../utils/dom-id';
import { getNextListboxIndex } from '../../utils/list-navigation';
import { extToLang } from '../chat/shiki';
import { ResizableSidebarPanel } from '../layout/ResizableSidebarPanel';
import { WorkspaceGitActions } from '../shared/WorkspaceGitActions';

const DEFAULT_STATUS: EmbeddedEditorStatus = {
  availability: 'unavailable',
  mode: 'inspect',
  running: false,
};
const EDITOR_FILE_SEARCH_RESULTS_ID = 'editor-file-search-results';

interface EditorFileSearchState {
  query: string;
  loading: boolean;
  error: string | null;
  resultCount: number;
}

export function EditorView() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { activeWorkspace, switchWorkspace } = useWorkspace();
  const isEditorRoute = location.pathname === '/editor';
  const [status, setStatus] = useState<EmbeddedEditorStatus>(DEFAULT_STATUS);
  const [snapshot, setSnapshot] = useState<EmbeddedEditorFileSnapshot | null>(null);
  const [resolvedTarget, setResolvedTarget] = useState<EmbeddedEditorTarget | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [webviewEl, setWebviewEl] = useState<HTMLWebViewElement | null>(null);
  const [webviewLoading, setWebviewLoading] = useState(false);
  const [webviewError, setWebviewError] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [fileSearchResults, setFileSearchResults] = useState<ChatFileMentionSearchResult[]>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const [fileSearchError, setFileSearchError] = useState<string | null>(null);
  const [selectedFileSearchIndex, setSelectedFileSearchIndex] = useState(0);
  const [gitActionMessage, setGitActionMessage] = useState<string | null>(null);
  const fileSearchInputRef = useRef<HTMLInputElement>(null);
  const loadTargetRequestRef = useRef(0);
  const startRequestRef = useRef(0);
  const lastWorkspaceRepoKeyRef = useRef<string | null>(null);

  const requestedTarget = useMemo(() => parseEditorSearchParams(searchParams), [searchParams]);

  useEffect(() => {
    if (!isEditorRoute || !requestedTarget?.workspaceId) return;
    if (activeWorkspace?.id === requestedTarget.workspaceId) return;

    void switchWorkspace(requestedTarget.workspaceId).catch((error) => {
      setStatus((current) => ({
        ...current,
        availability: 'error',
        lastError:
          error instanceof Error ? error.message : 'Failed to switch to the requested workspace.',
      }));
    });
  }, [activeWorkspace?.id, isEditorRoute, requestedTarget?.workspaceId, switchWorkspace]);

  const effectiveTarget = useMemo<EmbeddedEditorTarget | null>(() => {
    if (requestedTarget) {
      if (
        requestedTarget.repoId &&
        !requestedTarget.absolutePath &&
        !requestedTarget.relativePath &&
        activeWorkspace
      ) {
        return {
          workspaceId: requestedTarget.workspaceId ?? activeWorkspace.id,
          source: requestedTarget.source ?? 'manual',
          title: `${activeWorkspace.name} code workspace`,
        };
      }

      return {
        ...requestedTarget,
        workspaceId: requestedTarget.workspaceId ?? activeWorkspace?.id,
      };
    }

    if (!activeWorkspace) {
      return null;
    }

    return {
      workspaceId: activeWorkspace.id,
      source: 'manual',
      title: `${activeWorkspace.name} code workspace`,
    };
  }, [activeWorkspace, requestedTarget]);

  const desiredWorkspaceId = effectiveTarget?.workspaceId ?? activeWorkspace?.id ?? null;
  const embeddedStatusMatchesDesiredWorkspace = isEmbeddedEditorStatusForWorkspace(
    status,
    desiredWorkspaceId,
  );
  const embeddedStatusNeedsWorkspaceSwitch = shouldRestartEmbeddedEditorForWorkspace(
    status,
    desiredWorkspaceId,
  );

  const refreshStatus = useCallback(async () => {
    try {
      const nextStatus = await window.anvil.editor.getStatus();
      setStatus(nextStatus);
    } catch (error) {
      setStatus((current) => ({
        ...current,
        availability: 'error',
        lastError: error instanceof Error ? error.message : 'Failed to load editor status.',
      }));
    }
  }, []);

  useEffect(() => {
    if (!isEditorRoute) return;

    void refreshStatus();
    const interval = window.setInterval(() => {
      void refreshStatus();
    }, 4000);
    return () => window.clearInterval(interval);
  }, [isEditorRoute, refreshStatus]);

  const loadTarget = useCallback(async (target: EmbeddedEditorTarget | null) => {
    const requestId = ++loadTargetRequestRef.current;
    if (!target) {
      setSnapshot(null);
      setResolvedTarget(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const result = await window.anvil.editor.focusTarget(target, {
        startServer: false,
      });
      if (requestId !== loadTargetRequestRef.current) return;
      setStatus(result.status);
      setSnapshot(result.snapshot);
      setResolvedTarget(result.resolvedTarget ?? target);
    } catch (error) {
      if (requestId !== loadTargetRequestRef.current) return;
      setStatus((current) => ({
        ...current,
        availability: 'error',
        lastError: error instanceof Error ? error.message : 'Failed to load editor target.',
      }));
    } finally {
      if (requestId === loadTargetRequestRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!isEditorRoute) return;
    void loadTarget(effectiveTarget);
  }, [effectiveTarget, isEditorRoute, loadTarget]);

  useEffect(() => {
    if (!webviewEl) return;

    const handleStart = () => {
      setWebviewError(null);
      setWebviewLoading(true);
    };
    const handleStop = () => setWebviewLoading(false);
    const handleDomReady = () => {
      setWebviewError(null);
      setWebviewLoading(false);
    };
    const handleFailure = (event: WebviewFailLoadEvent) => {
      if (event.errorCode === -3) return;
      if (event.isMainFrame === false) return;
      setWebviewLoading(false);
      const message = `Embedded IDE failed to load: ${
        event.errorDescription || `error ${event.errorCode}`
      }. Restart the embedded IDE.`;
      setWebviewError(message);
      setStatus((current) => ({
        ...current,
        availability: 'error',
        running: false,
        url: undefined,
        lastError: message,
      }));
      void window.anvil.editor.stop().catch(() => undefined);
    };
    const handleCrash = () => {
      setWebviewLoading(false);
      const message = 'Embedded IDE renderer crashed. Restart the embedded IDE.';
      setWebviewError(message);
      setStatus((current) => ({
        ...current,
        availability: 'error',
        running: false,
        lastError: message,
      }));
    };

    webviewEl.addEventListener('did-start-loading', handleStart);
    webviewEl.addEventListener('did-stop-loading', handleStop);
    webviewEl.addEventListener('dom-ready', handleDomReady);
    webviewEl.addEventListener('did-fail-load', handleFailure as EventListener);
    webviewEl.addEventListener('render-process-gone', handleCrash);
    webviewEl.addEventListener('crashed', handleCrash);

    return () => {
      webviewEl.removeEventListener('did-start-loading', handleStart);
      webviewEl.removeEventListener('did-stop-loading', handleStop);
      webviewEl.removeEventListener('dom-ready', handleDomReady);
      webviewEl.removeEventListener('did-fail-load', handleFailure as EventListener);
      webviewEl.removeEventListener('render-process-gone', handleCrash);
      webviewEl.removeEventListener('crashed', handleCrash);
    };
  }, [webviewEl]);

  const startEmbedded = useCallback(
    async (workspaceIdOverride?: string | null) => {
      const workspaceId = workspaceIdOverride ?? desiredWorkspaceId;
      if (!workspaceId) return;
      const requestId = ++startRequestRef.current;
      loadTargetRequestRef.current += 1;
      const target =
        effectiveTarget &&
        (!effectiveTarget.workspaceId || effectiveTarget.workspaceId === workspaceId)
          ? effectiveTarget
          : {
              workspaceId,
              source: 'manual' as const,
              title:
                activeWorkspace?.id === workspaceId
                  ? `${activeWorkspace.name} code workspace`
                  : 'Workspace code workspace',
            };

      setStarting(true);
      try {
        if (status.running) {
          await window.anvil.editor.stop();
        }
        if (requestId !== startRequestRef.current) return;
        const nextStatus = await window.anvil.editor.start(workspaceId);
        if (requestId !== startRequestRef.current) return;
        setStatus(nextStatus);
        if (target) {
          const result = await window.anvil.editor.focusTarget(target, {
            startServer: false,
          });
          if (requestId !== startRequestRef.current) return;
          setSnapshot(result.snapshot);
          setResolvedTarget(result.resolvedTarget ?? target);
          setStatus(result.status);
        }
      } catch (error) {
        if (requestId !== startRequestRef.current) return;
        setStatus((current) => ({
          ...current,
          availability: 'error',
          lastError:
            error instanceof Error ? error.message : 'Failed to start the embedded editor.',
        }));
      } finally {
        if (requestId === startRequestRef.current) {
          setStarting(false);
        }
      }
    },
    [
      activeWorkspace?.id,
      activeWorkspace?.name,
      desiredWorkspaceId,
      effectiveTarget,
      status.running,
    ],
  );

  useEffect(() => {
    if (!isEditorRoute || starting || !desiredWorkspaceId || !embeddedStatusNeedsWorkspaceSwitch) {
      return;
    }

    void startEmbedded(desiredWorkspaceId);
  }, [
    desiredWorkspaceId,
    embeddedStatusNeedsWorkspaceSwitch,
    isEditorRoute,
    startEmbedded,
    starting,
  ]);

  const stopEmbedded = useCallback(async () => {
    const requestId = ++startRequestRef.current;
    loadTargetRequestRef.current += 1;
    setStarting(true);
    try {
      await window.anvil.editor.stop();
      if (requestId !== startRequestRef.current) return;
      await refreshStatus();
    } finally {
      if (requestId === startRequestRef.current) {
        setStarting(false);
      }
    }
  }, [refreshStatus]);

  const openExternal = useCallback(async () => {
    const target =
      resolvedTarget ??
      effectiveTarget ??
      (activeWorkspace?.id
        ? {
            workspaceId: activeWorkspace.id,
            source: 'manual' as const,
            title: `${activeWorkspace.name} code workspace`,
          }
        : null);

    if (!target) return;
    await window.anvil.editor.openExternal(target);
  }, [activeWorkspace?.id, activeWorkspace?.name, effectiveTarget, resolvedTarget]);

  const copyPath = useCallback(async () => {
    const targetPath = snapshot?.absolutePath ?? resolvedTarget?.absolutePath;
    if (!targetPath) return;
    await copyTextToClipboard(targetPath);
    setCopiedPath(true);
    window.setTimeout(() => setCopiedPath(false), 1600);
  }, [resolvedTarget?.absolutePath, snapshot?.absolutePath]);

  const askChatAboutTarget = useCallback(() => {
    const targetPath =
      snapshot?.relativePath ??
      snapshot?.absolutePath ??
      resolvedTarget?.relativePath ??
      resolvedTarget?.absolutePath ??
      resolvedTarget?.repoName;
    if (!targetPath) return;

    navigate(`/chat?prompt=${encodeURIComponent(buildEditorChatPrompt(snapshot, resolvedTarget))}`);
  }, [
    navigate,
    resolvedTarget?.absolutePath,
    resolvedTarget?.repoId,
    resolvedTarget?.relativePath,
    resolvedTarget?.repoName,
    resolvedTarget?.source,
    snapshot?.absolutePath,
    snapshot?.content,
    snapshot?.displayEndLine,
    snapshot?.displayStartLine,
    snapshot?.fileName,
    snapshot?.focusLine,
    snapshot?.kind,
    snapshot?.relativePath,
    snapshot?.truncated,
  ]);

  const reloadEmbedded = useCallback(() => {
    setWebviewError(null);
    setWebviewLoading(true);
    webviewEl?.reload();
  }, [webviewEl]);

  const workspaceRepoIds = useMemo(
    () => activeWorkspace?.repos.map((repo) => repo.id) ?? [],
    [activeWorkspace?.repos],
  );
  const workspaceRepoKey = workspaceRepoIds.join('\0');

  useEffect(() => {
    const currentWorkspaceRepoKey = activeWorkspace
      ? `${activeWorkspace.id}:${workspaceRepoKey}`
      : null;
    const previousWorkspaceRepoKey = lastWorkspaceRepoKeyRef.current;
    lastWorkspaceRepoKeyRef.current = currentWorkspaceRepoKey;

    if (
      !isEditorRoute ||
      starting ||
      !activeWorkspace ||
      !previousWorkspaceRepoKey ||
      previousWorkspaceRepoKey === currentWorkspaceRepoKey ||
      !isEmbeddedEditorStatusForWorkspace(status, activeWorkspace.id)
    ) {
      return;
    }

    void startEmbedded(activeWorkspace.id);
  }, [activeWorkspace, isEditorRoute, startEmbedded, starting, status, workspaceRepoKey]);

  const trimmedFileSearchQuery = fileSearchQuery.trim();
  const showFileSearchEmptyState = shouldShowEditorFileSearchEmptyState({
    query: trimmedFileSearchQuery,
    loading: fileSearchLoading,
    error: fileSearchError,
    resultCount: fileSearchResults.length,
  });
  const selectedFileSearchResult = fileSearchResults[selectedFileSearchIndex];

  const handleFileSearchQueryChange = useCallback(
    (nextQuery: string) => {
      setFileSearchQuery(nextQuery);
      const shouldSearch =
        isEditorRoute &&
        !!activeWorkspace &&
        workspaceRepoIds.length > 0 &&
        nextQuery.trim().length >= 2;
      setFileSearchLoading(shouldSearch);
      setFileSearchError(null);
      if (!shouldSearch) setFileSearchResults([]);
    },
    [activeWorkspace, isEditorRoute, workspaceRepoIds.length],
  );

  useEffect(() => {
    const trimmedQuery = fileSearchQuery.trim();
    if (
      !isEditorRoute ||
      !activeWorkspace ||
      workspaceRepoIds.length === 0 ||
      trimmedQuery.length < 2
    ) {
      setFileSearchResults([]);
      setFileSearchLoading(false);
      setFileSearchError(null);
      return;
    }

    let cancelled = false;
    setFileSearchLoading(true);
    setFileSearchError(null);

    const timer = window.setTimeout(() => {
      window.anvil.chat
        .searchFileMentions({
          repoIds: workspaceRepoIds,
          query: trimmedQuery,
          limit: 8,
        })
        .then((results) => {
          if (!cancelled) {
            setFileSearchResults(results);
            setSelectedFileSearchIndex(0);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setFileSearchResults([]);
            setFileSearchError(error instanceof Error ? error.message : 'Failed to search files.');
          }
        })
        .finally(() => {
          if (!cancelled) setFileSearchLoading(false);
        });
    }, 160);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeWorkspace, fileSearchQuery, isEditorRoute, workspaceRepoIds, workspaceRepoKey]);

  useEffect(() => {
    if (selectedFileSearchIndex >= fileSearchResults.length) {
      setSelectedFileSearchIndex(Math.max(0, fileSearchResults.length - 1));
    }
  }, [fileSearchResults.length, selectedFileSearchIndex]);

  const openFileSearchResult = useCallback(
    (result: ChatFileMentionSearchResult) => {
      if (!activeWorkspace) return;
      setFileSearchQuery('');
      setFileSearchResults([]);
      navigate(
        buildEditorUrl({
          workspaceId: activeWorkspace.id,
          repoId: result.repoId,
          repoName: result.repoName,
          relativePath: result.relativePath,
          absolutePath: result.path,
          source: 'manual',
          title: result.name,
        }),
      );
    },
    [activeWorkspace, navigate],
  );

  const handleFileSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleFileSearchQueryChange('');
        fileSearchInputRef.current?.blur();
        return;
      }

      if (fileSearchResults.length === 0) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedFileSearchIndex(
          (index) => getNextListboxIndex(event.key, index, fileSearchResults.length) ?? index,
        );
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedFileSearchIndex(
          (index) => getNextListboxIndex(event.key, index, fileSearchResults.length) ?? index,
        );
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        setSelectedFileSearchIndex(
          (index) => getNextListboxIndex(event.key, index, fileSearchResults.length) ?? index,
        );
      } else if (event.key === 'Enter') {
        event.preventDefault();
        openFileSearchResult(fileSearchResults[selectedFileSearchIndex]);
      }
    },
    [fileSearchResults, handleFileSearchQueryChange, openFileSearchResult, selectedFileSearchIndex],
  );

  useEffect(() => {
    const handleQuickOpen = (event: KeyboardEvent) => {
      if (!isEditorRoute) return;
      if (!shouldFocusEditorFileSearchFromKey(event)) return;
      event.preventDefault();
      fileSearchInputRef.current?.focus();
      fileSearchInputRef.current?.select();
    };

    window.addEventListener('keydown', handleQuickOpen);
    return () => window.removeEventListener('keydown', handleQuickOpen);
  }, [isEditorRoute]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 w-full bg-bg-primary">
      <ResizableSidebarPanel
        storageKey="editor:left"
        side="left"
        title="Workspace Editor"
        defaultWidth={290}
        minWidth={240}
        maxWidth={420}
        className="border-r border-border bg-bg-secondary"
      >
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <SquareTerminal size={18} className="text-accent" />
            <h2 className="text-lg font-semibold text-text-primary">Editor</h2>
            <div className="ml-auto">
              <WorkspaceGitActions
                repos={activeWorkspace?.repos ?? []}
                compact
                onPullRequestCreated={(result) => {
                  setGitActionMessage(result.pullRequestUrl ?? `PR created for ${result.repoName}`);
                }}
                onError={setGitActionMessage}
              />
            </div>
          </div>
          {gitActionMessage && (
            <p className="mt-2 truncate text-xs text-text-tertiary">{gitActionMessage}</p>
          )}
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">
            Inspect the active workspace, then jump into an embedded IDE when a local VS Code server
            is available.
          </p>
        </div>

        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <StatusBadge status={status} />
            <span className="text-sm text-text-secondary">
              {status.running
                ? embeddedStatusMatchesDesiredWorkspace
                  ? 'Embedded IDE running'
                  : 'Embedded IDE running for another workspace'
                : status.availability === 'available'
                  ? 'Ready to launch'
                  : 'Inspection mode'}
            </span>
          </div>
          {status.command && (
            <p className="mt-2 truncate font-mono text-xs text-text-tertiary">{status.command}</p>
          )}
          {status.lastError && (
            <p className="mt-2 text-sm leading-relaxed text-warning">{status.lastError}</p>
          )}
        </div>

        <div className="border-b border-border px-4 py-4">
          <label className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
            Jump to file
          </label>
          <div className="relative mt-2">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
            />
            <input
              ref={fileSearchInputRef}
              value={fileSearchQuery}
              onChange={(event) => handleFileSearchQueryChange(event.target.value)}
              onKeyDown={handleFileSearchKeyDown}
              disabled={!activeWorkspace?.repos.length}
              placeholder={
                activeWorkspace?.repos.length ? 'Search files in workspace...' : 'Add repos first'
              }
              role="combobox"
              aria-label="Search workspace files"
              aria-autocomplete="list"
              aria-expanded={fileSearchResults.length > 0}
              aria-controls={EDITOR_FILE_SEARCH_RESULTS_ID}
              aria-activedescendant={
                selectedFileSearchResult
                  ? buildEditorFileSearchOptionId(selectedFileSearchResult)
                  : undefined
              }
              className="w-full rounded-lg border border-border bg-bg-primary py-2 pl-9 pr-9 text-sm text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-accent/45 disabled:cursor-not-allowed disabled:opacity-50"
            />
            {fileSearchLoading && (
              <Loader2
                size={14}
                className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-text-tertiary"
              />
            )}
          </div>
          <p className="mt-2 text-[11px] text-text-muted">Cmd/Ctrl+P focuses file search.</p>

          {fileSearchError && (
            <p className="mt-2 text-xs leading-relaxed text-warning">{fileSearchError}</p>
          )}

          {fileSearchResults.length > 0 && (
            <div
              id={EDITOR_FILE_SEARCH_RESULTS_ID}
              className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-border-subtle bg-bg-primary p-1.5"
              role="listbox"
              aria-label="Editor file search results"
            >
              {fileSearchResults.map((result, index) => (
                <button
                  id={buildEditorFileSearchOptionId(result)}
                  key={`${result.repoId}:${result.path}`}
                  onClick={() => openFileSearchResult(result)}
                  onMouseEnter={() => setSelectedFileSearchIndex(index)}
                  className={`flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    index === selectedFileSearchIndex ? 'bg-accent/10' : 'hover:bg-bg-tertiary'
                  }`}
                  role="option"
                  aria-selected={index === selectedFileSearchIndex}
                >
                  <FileCode2
                    size={14}
                    className={`shrink-0 ${
                      index === selectedFileSearchIndex ? 'text-accent' : 'text-text-tertiary'
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs text-text-primary">
                      {result.relativePath}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">
                      {result.repoName}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {showFileSearchEmptyState && (
            <div className="mt-2 rounded-xl border border-border-subtle bg-bg-primary px-3 py-2.5 text-sm text-text-secondary">
              <p>No files matched "{trimmedFileSearchQuery}".</p>
              <p className="mt-1 text-xs text-text-tertiary">
                Try a filename, folder, or extension like <span className="font-mono">tsx</span>.
              </p>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-text-tertiary">
              Workspace
            </h3>
            {activeWorkspace && (
              <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-tertiary">
                {activeWorkspace.repos.length}
              </span>
            )}
          </div>

          {activeWorkspace ? (
            <WorkspaceSummaryPanel
              repos={activeWorkspace.repos}
              workspaceName={activeWorkspace.name}
            />
          ) : (
            <div className="rounded-xl border border-border-subtle bg-bg-primary px-4 py-5 text-sm text-text-secondary">
              Add repositories to this workspace to use the editor.
            </div>
          )}
        </div>
      </ResizableSidebarPanel>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-border bg-bg-secondary px-5 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <BookOpenText size={15} className="text-accent" />
              <p className="truncate text-sm font-semibold text-text-primary">
                {resolvedTarget?.title ??
                  effectiveTarget?.title ??
                  (activeWorkspace ? `${activeWorkspace.name} code workspace` : 'Embedded editor')}
              </p>
            </div>
            <p className="mt-1 truncate text-sm text-text-secondary">
              {snapshot?.absolutePath ??
                resolvedTarget?.absolutePath ??
                resolvedTarget?.repoName ??
                'Choose a repo, file link, review item, or security finding to inspect.'}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => void startEmbedded(desiredWorkspaceId)}
              disabled={!desiredWorkspaceId || starting || status.availability === 'unavailable'}
              className="inline-flex items-center gap-2 rounded-lg border border-accent/35 bg-accent/10 px-3 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {starting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <MonitorSmartphone size={14} />
              )}
              {status.running
                ? embeddedStatusMatchesDesiredWorkspace
                  ? 'Restart IDE'
                  : 'Switch IDE'
                : 'Start IDE'}
            </button>
            {status.running && (
              <button
                onClick={() => void stopEmbedded()}
                disabled={starting}
                className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
              >
                <XCircle size={14} />
                Stop
              </button>
            )}
            <button
              onClick={askChatAboutTarget}
              disabled={
                !snapshot?.absolutePath &&
                !snapshot?.relativePath &&
                !resolvedTarget?.absolutePath &&
                !resolvedTarget?.relativePath &&
                !resolvedTarget?.repoName
              }
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
            >
              <MessageSquare size={14} />
              Ask Chat
            </button>
            <button
              onClick={() => void openExternal()}
              disabled={!effectiveTarget && !resolvedTarget}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
            >
              <ExternalLink size={14} />
              Open Externally
            </button>
            <button
              onClick={() => void copyPath()}
              disabled={!snapshot?.absolutePath && !resolvedTarget?.absolutePath}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
            >
              <Copy size={14} />
              {copiedPath ? 'Copied' : 'Copy Path'}
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1 border-r border-border bg-bg-primary">
            {embeddedStatusMatchesDesiredWorkspace && status.url ? (
              <>
                <EmbeddedTargetBar
                  snapshot={snapshot}
                  resolvedTarget={resolvedTarget}
                  loading={loading}
                  copiedPath={copiedPath}
                  onOpenExternal={() => void openExternal()}
                  onCopyPath={() => void copyPath()}
                  onReload={reloadEmbedded}
                />
                {webviewLoading && (
                  <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg-primary/70 backdrop-blur-sm">
                    <div className="flex items-center gap-2 rounded-full border border-border bg-bg-secondary px-4 py-2 text-sm text-text-secondary">
                      <Loader2 size={14} className="animate-spin" />
                      Loading embedded IDE...
                    </div>
                  </div>
                )}
                {webviewError && (
                  <div className="absolute inset-x-6 top-20 z-30 rounded-xl border border-warning/30 bg-bg-elevated/95 p-4 shadow-2xl backdrop-blur">
                    <div className="flex items-start gap-3">
                      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-text-primary">
                          Embedded IDE did not load
                        </p>
                        <p className="mt-1 text-sm leading-relaxed text-text-secondary">
                          {webviewError}
                        </p>
                      </div>
                      <button
                        onClick={reloadEmbedded}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                      >
                        <RefreshCw size={13} />
                        Retry
                      </button>
                    </div>
                  </div>
                )}
                <webview
                  ref={setWebviewEl}
                  key={`${status.workspaceId ?? 'workspace'}:${status.url}`}
                  src={status.url}
                  className="absolute inset-x-0 bottom-0 top-[58px] h-[calc(100%-58px)] w-full"
                />
              </>
            ) : (
              <EmptyEmbeddedState
                status={status}
                loading={loading || starting}
                onStart={() => void startEmbedded()}
              />
            )}
          </div>

          <ResizableSidebarPanel
            storageKey="editor:right"
            side="right"
            title="Focused Inspection"
            defaultWidth={420}
            minWidth={320}
            maxWidth={620}
            autoCollapseBelow={1200}
            className="bg-bg-secondary"
          >
            <div className="border-b border-border px-5 py-4">
              <div className="flex items-center gap-2">
                <FileCode2 size={16} className="text-accent" />
                <h3 className="text-sm font-semibold uppercase tracking-wide text-text-tertiary">
                  Focused Inspection
                </h3>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                This pane stays useful even when no browser IDE is installed. File links, code
                review findings, and security impacts land here with line context.
              </p>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading ? (
                <div className="flex h-full items-center justify-center">
                  <div className="flex items-center gap-2 rounded-full border border-border bg-bg-primary px-4 py-2 text-sm text-text-secondary">
                    <Loader2 size={14} className="animate-spin" />
                    Loading file context...
                  </div>
                </div>
              ) : snapshot ? (
                <FocusedFilePane snapshot={snapshot} source={resolvedTarget?.source} />
              ) : (
                <div className="px-5 py-6 text-sm leading-relaxed text-text-secondary">
                  Pick a repo to launch the IDE, or open a specific file from Chat, Code Review, or
                  Security to get a focused excerpt here.
                </div>
              )}
            </div>
          </ResizableSidebarPanel>
        </div>
      </section>
    </div>
  );
}

interface WebviewFailLoadEvent extends Event {
  errorCode: number;
  errorDescription?: string;
  isMainFrame?: boolean;
}

function StatusBadge({ status }: { status: EmbeddedEditorStatus }) {
  const label = status.running
    ? 'Live'
    : status.availability === 'available'
      ? 'Ready'
      : status.availability === 'error'
        ? 'Issue'
        : 'Inspect';
  const className = status.running
    ? 'border-success/30 bg-success/10 text-success'
    : status.availability === 'available'
      ? 'border-info/30 bg-info/10 text-info'
      : status.availability === 'error'
        ? 'border-warning/30 bg-warning/10 text-warning'
        : 'border-border bg-bg-tertiary text-text-secondary';

  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs font-semibold uppercase ${className}`}
    >
      {label}
    </span>
  );
}

function WorkspaceSummaryPanel({
  repos,
  workspaceName,
}: {
  repos: RepoInfo[];
  workspaceName: string;
}) {
  return (
    <div className="rounded-xl border border-accent/30 bg-accent/10 px-4 py-3">
      <div className="flex items-start gap-3">
        <FolderOpen size={16} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-text-primary">{workspaceName}</p>
          <p className="mt-1 text-xs text-text-secondary">
            {repos.length === 1 ? '1 repository' : `${repos.length} repositories`}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {repos.map((repo) => (
          <div
            key={repo.id}
            className="min-w-0 rounded-lg border border-border/70 bg-bg-primary px-3 py-2"
          >
            <p className="truncate text-xs font-semibold text-text-primary">{repo.name}</p>
            <p className="mt-1 truncate font-mono text-[11px] text-text-tertiary">{repo.path}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyEmbeddedState({
  status,
  loading,
  onStart,
}: {
  status: EmbeddedEditorStatus;
  loading: boolean;
  onStart: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center px-8">
      <div className="max-w-xl rounded-2xl border border-border bg-bg-secondary p-8 text-center">
        <Waypoints size={28} className="mx-auto text-accent" />
        <h3 className="mt-4 text-xl font-semibold text-text-primary">
          {status.availability === 'available'
            ? 'Launch the embedded IDE'
            : 'Inspection mode is ready'}
        </h3>
        <p className="mt-3 text-sm leading-relaxed text-text-secondary">
          {status.availability === 'available'
            ? 'Anvil can spin up a local browser IDE on loopback so you can browse the workspace without leaving the app.'
            : 'No embedded IDE binary is installed, so Anvil is staying in safe inspection mode. You can still inspect exact file excerpts here and jump out to your desktop editor when needed.'}
        </p>
        {status.lastError && (
          <p className="mt-3 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            {status.lastError}
          </p>
        )}
        {status.availability === 'available' && (
          <button
            onClick={onStart}
            disabled={loading}
            className="mt-5 inline-flex items-center gap-2 rounded-lg border border-accent/35 bg-accent/10 px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-accent/15 disabled:opacity-60"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {loading ? 'Starting...' : 'Start embedded IDE'}
          </button>
        )}
      </div>
    </div>
  );
}

function buildEditorChatPrompt(
  snapshot: EmbeddedEditorFileSnapshot | null,
  resolvedTarget: EmbeddedEditorTarget | null,
): string {
  const targetPath =
    snapshot?.relativePath ??
    snapshot?.absolutePath ??
    resolvedTarget?.relativePath ??
    resolvedTarget?.absolutePath ??
    resolvedTarget?.repoName ??
    'the selected editor target';
  const lineSuffix = snapshot?.focusLine ? `:${snapshot.focusLine}` : '';
  const lines = [
    `Help me understand and improve ${targetPath}${lineSuffix}.`,
    resolvedTarget?.repoName ? `Repository: ${resolvedTarget.repoName}.` : '',
    resolvedTarget?.source ? `Opened from: ${resolvedTarget.source}.` : '',
    snapshot?.absolutePath ? `Absolute path: ${snapshot.absolutePath}.` : '',
    snapshot?.focusLine ? `Focus line: ${snapshot.focusLine}.` : '',
    'Explain what this file is responsible for, how it fits into the codebase, and call out risks, confusing areas, and sensible improvements.',
    'If you find a small safe fix, make it and tell me exactly how to verify it.',
  ].filter(Boolean);

  if (snapshot?.kind === 'text' && snapshot.content.trim()) {
    const excerptLabel = snapshot.truncated
      ? `Focused excerpt, lines ${snapshot.displayStartLine}-${snapshot.displayEndLine}`
      : 'File contents';
    lines.push(`${excerptLabel}:\n\`\`\`\n${snapshot.content.trimEnd()}\n\`\`\``);
  } else if (snapshot?.message) {
    lines.push(`Editor context note: ${snapshot.message}`);
  }

  return lines.join('\n\n');
}

export function shouldShowEditorFileSearchEmptyState(state: EditorFileSearchState): boolean {
  return (
    state.query.trim().length >= 2 && !state.loading && !state.error && state.resultCount === 0
  );
}

export function shouldFocusEditorFileSearchFromKey(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'target'>,
): boolean {
  if (event.key.toLowerCase() !== 'p' || (!event.metaKey && !event.ctrlKey)) return false;
  return !isEditableShortcutTarget(event.target);
}

export function isEmbeddedEditorStatusForWorkspace(
  status: EmbeddedEditorStatus,
  workspaceId: string | null | undefined,
): boolean {
  return Boolean(status.running && status.url && workspaceId && status.workspaceId === workspaceId);
}

export function shouldRestartEmbeddedEditorForWorkspace(
  status: EmbeddedEditorStatus,
  workspaceId: string | null | undefined,
): boolean {
  return Boolean(status.running && workspaceId && status.workspaceId !== workspaceId);
}

export function buildEditorFileSearchOptionId(result: ChatFileMentionSearchResult): string {
  return `editor-file-search-option-${slugForDomId(result.repoId)}-${slugForDomId(result.path)}`;
}

export function buildEditorFileReference(snapshot: EmbeddedEditorFileSnapshot): string | null {
  return buildEditorLineReference(snapshot, snapshot.focusLine);
}

export function buildEditorLineReference(
  snapshot: EmbeddedEditorFileSnapshot,
  lineNumber?: number,
): string | null {
  const path = snapshot.relativePath ?? snapshot.absolutePath;
  if (!path) return null;
  return lineNumber ? `${path}:${lineNumber}` : path;
}

function EmbeddedTargetBar({
  snapshot,
  resolvedTarget,
  loading,
  copiedPath,
  onOpenExternal,
  onCopyPath,
  onReload,
}: {
  snapshot: EmbeddedEditorFileSnapshot | null;
  resolvedTarget: EmbeddedEditorTarget | null;
  loading: boolean;
  copiedPath: boolean;
  onOpenExternal: () => void;
  onCopyPath: () => void;
  onReload: () => void;
}) {
  const targetPath = snapshot?.relativePath ?? snapshot?.absolutePath ?? resolvedTarget?.repoName;
  const lineLabel = snapshot?.focusLine ? `:${snapshot.focusLine}` : '';

  return (
    <div className="absolute inset-x-0 top-0 z-10 flex h-[58px] items-center justify-between gap-3 border-b border-border bg-bg-secondary/95 px-4 backdrop-blur">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-bg-primary">
          {loading ? (
            <Loader2 size={15} className="animate-spin text-accent" />
          ) : (
            <FileCode2 size={15} className="text-accent" />
          )}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary">
            {snapshot?.fileName ?? resolvedTarget?.title ?? 'Workspace loaded'}
          </p>
          <p className="truncate font-mono text-xs text-text-tertiary">
            {targetPath ? `${targetPath}${lineLabel}` : 'Browse or search inside the embedded IDE'}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          onClick={onReload}
          className="rounded-lg p-2 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          title="Reload embedded IDE"
          aria-label="Reload embedded IDE"
        >
          <RefreshCw size={14} />
        </button>
        <button
          onClick={onOpenExternal}
          className="rounded-lg p-2 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          title="Open in desktop editor"
          aria-label="Open in desktop editor"
        >
          <ExternalLink size={14} />
        </button>
        <button
          onClick={onCopyPath}
          disabled={!snapshot?.absolutePath && !resolvedTarget?.absolutePath}
          className="rounded-lg p-2 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          title={copiedPath ? 'Copied path' : 'Copy path'}
          aria-label={copiedPath ? 'Copied path' : 'Copy path'}
        >
          <Copy size={14} className={copiedPath ? 'text-success' : undefined} />
        </button>
      </div>
    </div>
  );
}

function FocusedFilePane({
  snapshot,
  source,
}: {
  snapshot: EmbeddedEditorFileSnapshot;
  source?: EmbeddedEditorTarget['source'];
}) {
  const languageLabel = extToLang(snapshot.absolutePath ?? snapshot.relativePath ?? '');
  const [copiedReference, setCopiedReference] = useState(false);
  const [copiedLine, setCopiedLine] = useState<number | null>(null);
  const fileReference = buildEditorFileReference(snapshot);
  const copyReference = useCallback(async () => {
    if (!fileReference) return;
    await copyTextToClipboard(fileReference);
    setCopiedReference(true);
    window.setTimeout(() => setCopiedReference(false), 1600);
  }, [fileReference]);
  const copyLineReference = useCallback(
    async (lineNumber: number) => {
      const lineReference = buildEditorLineReference(snapshot, lineNumber);
      if (!lineReference) return;
      await copyTextToClipboard(lineReference);
      setCopiedLine(lineNumber);
      window.setTimeout(() => setCopiedLine(null), 1200);
    },
    [snapshot],
  );

  if (snapshot.kind === 'missing' || snapshot.kind === 'binary') {
    return (
      <div className="px-5 py-5">
        <div className="rounded-xl border border-border bg-bg-primary p-4">
          <p className="text-sm font-semibold text-text-primary">
            {snapshot.fileName ?? 'File context unavailable'}
          </p>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">{snapshot.message}</p>
        </div>
      </div>
    );
  }

  const lines = snapshot.content.split('\n');

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-border bg-bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
                {languageLabel}
              </span>
              {source && (
                <span className="rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                  {source}
                </span>
              )}
              {snapshot.truncated && (
                <span className="rounded-full border border-warning/25 bg-warning/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning">
                  excerpt
                </span>
              )}
            </div>
            <p className="mt-3 break-all font-mono text-xs text-text-secondary">
              {snapshot.absolutePath}
            </p>
            <p className="mt-2 text-sm text-text-tertiary">
              {snapshot.truncated
                ? `Showing lines ${snapshot.displayStartLine}-${snapshot.displayEndLine} of ${snapshot.totalLines}`
                : `${snapshot.totalLines} lines`}
            </p>
          </div>
          {fileReference && (
            <button
              type="button"
              onClick={() => void copyReference()}
              className="shrink-0 rounded-lg border border-border-subtle bg-bg-primary p-2 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
              title={copiedReference ? 'Copied reference' : 'Copy file reference'}
              aria-label={copiedReference ? 'Copied file reference' : 'Copy file reference'}
            >
              <Copy size={14} className={copiedReference ? 'text-success' : undefined} />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-bg-primary">
        <div className="min-w-full text-xs">
          {lines.map((line, index) => {
            const lineNumber = snapshot.displayStartLine + index;
            const isFocused = snapshot.focusLine === lineNumber;

            return (
              <div
                key={lineNumber}
                className={`grid grid-cols-[64px_minmax(0,1fr)] font-mono ${
                  isFocused
                    ? 'bg-accent/10'
                    : index % 2 === 0
                      ? 'bg-transparent'
                      : 'bg-bg-secondary/35'
                }`}
              >
                <div
                  className={`border-r border-border text-right ${
                    isFocused ? 'text-accent' : 'text-text-tertiary'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => void copyLineReference(lineNumber)}
                    className={`w-full px-3 py-1.5 text-right transition-colors hover:bg-bg-tertiary hover:text-accent ${
                      copiedLine === lineNumber ? 'text-success' : ''
                    }`}
                    title={`Copy ${buildEditorLineReference(snapshot, lineNumber) ?? 'line reference'}`}
                    aria-label={`Copy line ${lineNumber} reference`}
                  >
                    {lineNumber}
                  </button>
                </div>
                <pre
                  className={`overflow-x-auto px-3 py-1.5 whitespace-pre ${
                    isFocused ? 'text-text-primary' : 'text-text-secondary'
                  }`}
                >
                  {line || ' '}
                </pre>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
