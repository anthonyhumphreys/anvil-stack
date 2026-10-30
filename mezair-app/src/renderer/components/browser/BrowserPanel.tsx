import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Globe,
  Plug,
  Loader2,
  ExternalLink,
  MessageSquare,
  MonitorSmartphone,
  X,
} from 'lucide-react';
import { PreviewToolbar } from './PreviewToolbar';
import { IconButton } from '../ui';
import { chatPromptPath } from '../../utils/sidebar-navigation';
import type {
  BrowserAnnotation,
  DevServerTarget,
  BrowserBridgeStatus,
  SimulatorPreviewStatus,
} from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { RepoFeatureEmptyState } from '../shared/RepoFeatureEmptyState';

export type PreviewMode = 'browser' | 'simulator';

interface BrowserPanelProps {
  initialMode?: PreviewMode;
  initialUrl?: string;
  presentation?: 'route' | 'pane';
  onClose?: () => void;
}

export function BrowserPanel({
  initialMode = 'browser',
  initialUrl = '',
  presentation = 'route',
  onClose,
}: BrowserPanelProps = {}) {
  const routerNavigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { activeWorkspace, featureAvailability } = useWorkspace();
  const [webviewEl, setWebviewEl] = useState<Electron.WebviewTag | null>(null);
  const [previewMode, setPreviewMode] = useState<PreviewMode>(initialMode);

  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [urlInput, setUrlInput] = useState(initialUrl);
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [pageTitle, setPageTitle] = useState('');

  const [targets, setTargets] = useState<DevServerTarget[]>([]);
  const [bridgeStatus, setBridgeStatus] = useState<BrowserBridgeStatus>({ running: false });
  const [mcpStatus, setMcpStatus] = useState<'idle' | 'registering' | 'registered' | 'error'>(
    'idle',
  );
  const [bridgeStarting, setBridgeStarting] = useState(false);
  const [simStatus, setSimStatus] = useState<SimulatorPreviewStatus>({ running: false });
  const [simStarting, setSimStarting] = useState(false);
  const [annotationNote, setAnnotationNote] = useState('');
  const [annotating, setAnnotating] = useState(false);
  const isDetachedWindow = searchParams.get('toolWindow') === '1';

  // Poll for targets
  useEffect(() => {
    const refresh = () => {
      window.mezair.browser
        .listTargets()
        .then(setTargets)
        .catch(() => {});
      window.mezair.browser
        .getBridgeStatus()
        .then(setBridgeStatus)
        .catch(() => {});
      window.mezair.simulatorPreview
        .getStatus()
        .then(setSimStatus)
        .catch(() => {});
    };
    refresh();
    const interval = setInterval(refresh, 3000);

    const cleanup = window.mezair.browser.onTargetDetected((target) => {
      setTargets((prev) => {
        if (prev.find((t) => t.id === target.id)) return prev;
        return [target, ...prev];
      });
    });

    return () => {
      clearInterval(interval);
      cleanup();
    };
  }, []);

  // Attach webview event listeners when the element mounts
  const webviewRefCallback = useCallback((node: Electron.WebviewTag | null) => {
    setWebviewEl(node);
  }, []);

  useEffect(() => {
    if (!webviewEl) return;

    const onStartLoad = () => setIsLoading(true);
    const onStopLoad = () => {
      setIsLoading(false);
      setCanGoBack(webviewEl.canGoBack());
      setCanGoForward(webviewEl.canGoForward());
    };
    const onNavigate = (e: Electron.DidNavigateEvent) => {
      if (previewMode !== 'browser') return;
      setCurrentUrl(e.url);
      setUrlInput(e.url);
    };
    const onTitleUpdate = (e: Electron.PageTitleUpdatedEvent) => {
      setPageTitle(e.title);
    };
    let attachedId: number | undefined;
    const onDomReady = () => {
      if (!activeWorkspace) return;
      try {
        attachedId = webviewEl.getWebContentsId();
        void window.mezair.browser.attachDebugger(attachedId, activeWorkspace.id).catch(() => {});
      } catch {
        /* Wait for dom-ready. */
      }
    };
    onDomReady();

    webviewEl.addEventListener('did-start-loading', onStartLoad);
    webviewEl.addEventListener('did-stop-loading', onStopLoad);
    webviewEl.addEventListener('did-navigate', onNavigate as EventListener);
    webviewEl.addEventListener('did-navigate-in-page', onNavigate as EventListener);
    webviewEl.addEventListener('page-title-updated', onTitleUpdate as EventListener);
    webviewEl.addEventListener('dom-ready', onDomReady);

    return () => {
      if (attachedId !== undefined)
        void window.mezair.browser.detachDebugger(attachedId).catch(() => {});
      webviewEl.removeEventListener('did-start-loading', onStartLoad);
      webviewEl.removeEventListener('did-stop-loading', onStopLoad);
      webviewEl.removeEventListener('did-navigate', onNavigate as EventListener);
      webviewEl.removeEventListener('did-navigate-in-page', onNavigate as EventListener);
      webviewEl.removeEventListener('page-title-updated', onTitleUpdate as EventListener);
      webviewEl.removeEventListener('dom-ready', onDomReady);
    };
  }, [previewMode, webviewEl, activeWorkspace?.id]);

  useEffect(() => {
    const requestedMode = searchParams.get('mode');
    const requestedUrl = searchParams.get('url');
    if (requestedMode === 'browser' || requestedMode === 'simulator') {
      setPreviewMode(requestedMode);
    }
    if (requestedUrl) {
      setCurrentUrl(requestedUrl);
      setUrlInput(requestedUrl);
    }
    if (!requestedMode && !requestedUrl) return;
    const next = new URLSearchParams(searchParams);
    next.delete('mode');
    next.delete('url');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (presentation !== 'pane') return;
    setPreviewMode(initialMode);
    if (initialUrl) {
      setCurrentUrl(initialUrl);
      setUrlInput(initialUrl);
    }
  }, [initialMode, initialUrl, presentation]);

  const navigate = useCallback((url: string) => {
    let normalized = url.trim();
    if (!normalized.match(/^https?:\/\//)) {
      normalized = `http://${normalized}`;
    }

    setUrlInput(normalized);
    setCurrentUrl(normalized);
    setPreviewMode('browser');
  }, []);

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigate(urlInput);
  };

  const handleStartBridge = async () => {
    if (!webviewEl || !activeWorkspace) return;
    setBridgeStarting(true);
    try {
      const { port } = await window.mezair.browser.startBridge(
        webviewEl.getWebContentsId(),
        activeWorkspace.id,
      );
      setBridgeStatus({ running: true, port });
    } catch (err) {
      console.error('Failed to start bridge:', err);
    } finally {
      setBridgeStarting(false);
    }
  };

  const handleRegisterMcp = async () => {
    setMcpStatus('registering');
    try {
      const result = await window.mezair.browser.registerMcp();
      setMcpStatus(result.success ? 'registered' : 'error');
    } catch {
      setMcpStatus('error');
    }
  };

  const handleTargetSelect = (target: DevServerTarget) => {
    navigate(target.url);
  };

  const handleAddManualUrl = async () => {
    const url = urlInput.trim();
    if (!url) return;
    try {
      const target = await window.mezair.browser.addTarget(url);
      setTargets((prev) => [target, ...prev]);
    } catch {
      /* ignore */
    }
  };

  const handleSendToChat = async () => {
    const activeUrl = previewMode === 'simulator' ? simStatus.url : currentUrl;
    if (!activeUrl) return;
    const selectedText = await webviewEl
      ?.executeJavaScript<string>('window.getSelection()?.toString() ?? ""')
      .catch(() => '');

    const prompt = [
      previewMode === 'simulator'
        ? 'Use this iOS simulator preview context to investigate or fix the current mobile UI state.'
        : 'Use this browser context to investigate or fix the current UI state.',
      '',
      `URL: ${activeUrl}`,
      pageTitle ? `Title: ${pageTitle}` : null,
      `Viewport: ${webviewEl?.clientWidth ?? window.innerWidth}x${webviewEl?.clientHeight ?? window.innerHeight}`,
      selectedText?.trim() ? `Selected text:\n${selectedText.trim()}` : null,
      '',
      'Start by identifying the likely route/component files, then propose or make the smallest useful fix.',
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');

    routerNavigate(chatPromptPath(prompt));
  };

  const handleStartSimulator = async () => {
    setSimStarting(true);
    try {
      const nextStatus = await window.mezair.simulatorPreview.start();
      setSimStatus(nextStatus);
      setPreviewMode('simulator');
    } catch (err) {
      setSimStatus((current) => ({
        ...current,
        running: false,
        lastError: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setSimStarting(false);
    }
  };

  const handleStopSimulator = async () => {
    await window.mezair.simulatorPreview.stop();
    const nextStatus = await window.mezair.simulatorPreview.getStatus();
    setSimStatus(nextStatus);
  };

  const handleAnnotate = async () => {
    const note = annotationNote.trim();
    const activeUrl = previewMode === 'simulator' ? simStatus.url : currentUrl;
    if (!note || !activeUrl) return;
    const selectedText = await webviewEl
      ?.executeJavaScript<string>('window.getSelection()?.toString() ?? ""')
      .catch(() => '');
    const annotation: BrowserAnnotation = {
      id: `${Date.now()}`,
      url: activeUrl,
      title: pageTitle || undefined,
      note,
      selectedText: selectedText?.trim() || undefined,
      viewport: {
        width: webviewEl?.clientWidth ?? window.innerWidth,
        height: webviewEl?.clientHeight ?? window.innerHeight,
      },
      createdAt: new Date().toISOString(),
    };
    setAnnotationNote('');
    setAnnotating(false);

    const prompt = [
      previewMode === 'simulator'
        ? 'Investigate this annotated iOS simulator state.'
        : 'Investigate this annotated browser state.',
      '',
      `URL: ${annotation.url}`,
      annotation.title ? `Title: ${annotation.title}` : null,
      `Viewport: ${annotation.viewport.width}x${annotation.viewport.height}`,
      annotation.selectedText ? `Selected text:\n${annotation.selectedText}` : null,
      `Annotation:\n${annotation.note}`,
      '',
      'Identify the likely source files first, then make the smallest useful fix.',
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');

    routerNavigate(chatPromptPath(prompt));
  };

  const handleOpenAlongsideChat = () => {
    const params = new URLSearchParams({ preview: previewMode });
    if (previewMode === 'browser' && currentUrl) params.set('previewUrl', currentUrl);
    routerNavigate(`/chat?${params.toString()}`);
  };

  const handleDetach = () => {
    const params = new URLSearchParams({ mode: previewMode });
    if (previewMode === 'browser' && currentUrl) params.set('url', currentUrl);
    void window.mezair.appWindow.openToolWindow(
      `/browser?${params.toString()}`,
      activeWorkspace?.id,
    );
  };

  const webviewSrc = previewMode === 'simulator' ? (simStatus.url ?? '') : currentUrl;
  const hasUrl = !!webviewSrc;

  // The standalone /browser route is nav-gated on repo readiness; embedded
  // presentations (chat pane, detached tool windows) stay ungated.
  if (presentation === 'route' && !isDetachedWindow && !featureAvailability.repoFeaturesEnabled) {
    return (
      <RepoFeatureEmptyState
        icon={Globe}
        featureLabel="The preview browser"
        description="Web and simulator previews attach to a workspace repository."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <PreviewToolbar
        mode={previewMode}
        onModeChange={setPreviewMode}
        url={urlInput}
        onUrlChange={setUrlInput}
        onNavigate={handleUrlSubmit}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onBack={() => webviewEl?.goBack()}
        onForward={() => webviewEl?.goForward()}
        onReload={() => webviewEl?.reload()}
        loading={isLoading}
        hasUrl={hasUrl}
        targets={targets}
        onTargetSelect={handleTargetSelect}
        onAddTarget={() => void handleAddManualUrl()}
        bridge={bridgeStatus}
        bridgeStarting={bridgeStarting}
        onStartBridge={() => void handleStartBridge()}
        mcpStatus={mcpStatus}
        onRegisterMcp={() => void handleRegisterMcp()}
        simulator={simStatus}
        simulatorStarting={simStarting}
        onStartSimulator={() => void handleStartSimulator()}
        onStopSimulator={() => void handleStopSimulator()}
        annotating={annotating}
        onToggleAnnotation={() => setAnnotating((open) => !open)}
        onSendToChat={() => void handleSendToChat()}
        onOpenAlongsideChat={
          presentation === 'route' && !isDetachedWindow ? handleOpenAlongsideChat : undefined
        }
        onDetach={!isDetachedWindow ? handleDetach : undefined}
        onClose={presentation === 'pane' ? onClose : undefined}
      />

      {hasUrl && annotating && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleAnnotate();
          }}
          className="flex items-center gap-2 border-b border-border-subtle bg-bg-secondary/70 px-4 py-2"
        >
          <input
            aria-label="Preview note"
            autoFocus
            value={annotationNote}
            onChange={(event) => setAnnotationNote(event.target.value)}
            placeholder="Annotate the current preview..."
            className="min-w-0 flex-1 rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent/50 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!annotationNote.trim()}
            className="flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <MessageSquare size={14} />
            Send note
          </button>
          <IconButton
            icon={X}
            label="Close preview note"
            onClick={() => setAnnotating(false)}
            className="h-8 w-8"
          />
        </form>
      )}

      {/* Webview or empty state */}
      {hasUrl ? (
        <webview
          ref={webviewRefCallback as React.Ref<Electron.WebviewTag>}
          src={webviewSrc}
          className="min-h-0 min-w-0 flex-1"
          style={{ display: 'flex', flex: 1 }}
          allowpopups
        />
      ) : previewMode === 'simulator' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <div className="rounded-2xl border border-border-subtle bg-bg-secondary p-6">
            <MonitorSmartphone size={48} className="mx-auto mb-4 text-text-tertiary" />
            <h2 className="text-lg font-semibold text-text-primary">iOS Simulator Preview</h2>
            <p className="mt-2 max-w-md text-sm text-text-secondary">
              Start serve-sim to embed the simulator preview inside Mezair.
            </p>
            <button
              type="button"
              onClick={handleStartSimulator}
              disabled={simStarting}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {simStarting ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
              Start serve-sim
            </button>
            {simStatus.lastError && (
              <p className="mt-3 text-xs text-error">{simStatus.lastError}</p>
            )}
          </div>
          {simStatus.lastOutput && (
            <pre className="max-h-48 w-[min(760px,90vw)] overflow-auto rounded-lg border border-border bg-bg-primary p-3 text-left text-xs text-text-secondary">
              {simStatus.lastOutput}
            </pre>
          )}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
          <div className="rounded-2xl border border-border-subtle bg-bg-secondary p-6">
            <Globe size={48} className="mx-auto mb-4 text-text-tertiary" />
            <h2 className="text-lg font-semibold text-text-primary">Embedded Browser</h2>
            <p className="mt-2 max-w-md text-sm text-text-secondary">
              Preview your running app and let Codex interact with it via Chrome MCP. Enter a URL
              above or start a dev server in the terminal — it'll be auto-detected.
            </p>
          </div>

          {targets.length > 0 && (
            <div className="w-80 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                Detected Dev Servers
              </p>
              {targets.map((t) => (
                <button
                  key={t.id}
                  onClick={() => navigate(t.url)}
                  className="flex w-full items-center gap-3 rounded-lg border border-border bg-bg-secondary px-4 py-3 text-left transition-colors hover:border-accent/30 hover:bg-accent/5"
                >
                  <Globe size={18} className="shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-text-primary">{t.label}</div>
                    <div className="text-xs text-text-tertiary">{t.url}</div>
                  </div>
                  <ExternalLink size={14} className="text-text-tertiary" />
                </button>
              ))}
            </div>
          )}

          <div className="mt-4 space-y-3 text-sm text-text-tertiary">
            <p>How it works:</p>
            <ol className="list-inside list-decimal space-y-1 text-left">
              <li>Start a dev server in the Terminal tab</li>
              <li>The port is auto-detected and shown here</li>
              <li>Click to open it in the embedded browser</li>
              <li>Start the CDP bridge &amp; register Chrome MCP</li>
              <li>Codex can now navigate, screenshot, and interact with your app</li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
