import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Globe,
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Plug,
  PlugZap,
  Loader2,
  ChevronDown,
  Plus,
  Wifi,
  WifiOff,
  ExternalLink,
  MessageSquare,
  MonitorSmartphone,
  Square,
} from 'lucide-react';
import type {
  BrowserAnnotation,
  DevServerTarget,
  BrowserBridgeStatus,
  SimulatorPreviewStatus,
} from '../../../shared/types';

type PreviewMode = 'browser' | 'simulator';

export function BrowserPanel() {
  const routerNavigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [webviewEl, setWebviewEl] = useState<Electron.WebviewTag | null>(null);
  const [previewMode, setPreviewMode] = useState<PreviewMode>('browser');

  const [currentUrl, setCurrentUrl] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [pageTitle, setPageTitle] = useState('');

  const [targets, setTargets] = useState<DevServerTarget[]>([]);
  const [showTargets, setShowTargets] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState<BrowserBridgeStatus>({ running: false });
  const [mcpStatus, setMcpStatus] = useState<'idle' | 'registering' | 'registered' | 'error'>(
    'idle',
  );
  const [bridgeStarting, setBridgeStarting] = useState(false);
  const [simStatus, setSimStatus] = useState<SimulatorPreviewStatus>({ running: false });
  const [simStarting, setSimStarting] = useState(false);
  const [annotationNote, setAnnotationNote] = useState('');
  const [annotations, setAnnotations] = useState<BrowserAnnotation[]>([]);

  // Poll for targets
  useEffect(() => {
    const refresh = () => {
      window.anvil.browser
        .listTargets()
        .then(setTargets)
        .catch(() => {});
      window.anvil.browser
        .getBridgeStatus()
        .then(setBridgeStatus)
        .catch(() => {});
      window.anvil.simulatorPreview
        .getStatus()
        .then(setSimStatus)
        .catch(() => {});
    };
    refresh();
    const interval = setInterval(refresh, 3000);

    const cleanup = window.anvil.browser.onTargetDetected((target) => {
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
      window.anvil.browser.setUrl(e.url).catch(() => {});
    };
    const onTitleUpdate = (e: Electron.PageTitleUpdatedEvent) => {
      setPageTitle(e.title);
    };
    const onDomReady = () => {
      window.anvil.browser.attachDebugger().catch(() => {});
    };

    webviewEl.addEventListener('did-start-loading', onStartLoad);
    webviewEl.addEventListener('did-stop-loading', onStopLoad);
    webviewEl.addEventListener('did-navigate', onNavigate as EventListener);
    webviewEl.addEventListener('did-navigate-in-page', onNavigate as EventListener);
    webviewEl.addEventListener('page-title-updated', onTitleUpdate as EventListener);
    webviewEl.addEventListener('dom-ready', onDomReady);

    return () => {
      webviewEl.removeEventListener('did-start-loading', onStartLoad);
      webviewEl.removeEventListener('did-stop-loading', onStopLoad);
      webviewEl.removeEventListener('did-navigate', onNavigate as EventListener);
      webviewEl.removeEventListener('did-navigate-in-page', onNavigate as EventListener);
      webviewEl.removeEventListener('page-title-updated', onTitleUpdate as EventListener);
      webviewEl.removeEventListener('dom-ready', onDomReady);
    };
  }, [previewMode, webviewEl]);

  useEffect(() => {
    if (searchParams.get('mode') !== 'simulator') return;

    setPreviewMode('simulator');
    const next = new URLSearchParams(searchParams);
    next.delete('mode');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const navigate = useCallback((url: string) => {
    let normalized = url.trim();
    if (!normalized.match(/^https?:\/\//)) {
      normalized = `http://${normalized}`;
    }

    setUrlInput(normalized);
    setCurrentUrl(normalized);
    setPreviewMode('browser');
    window.anvil.browser.setUrl(normalized).catch(() => {});
  }, []);

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigate(urlInput);
  };

  const handleStartBridge = async () => {
    setBridgeStarting(true);
    try {
      const { port } = await window.anvil.browser.startBridge();
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
      const result = await window.anvil.browser.registerMcp();
      setMcpStatus(result.success ? 'registered' : 'error');
    } catch {
      setMcpStatus('error');
    }
  };

  const handleTargetSelect = (target: DevServerTarget) => {
    navigate(target.url);
    setShowTargets(false);
  };

  const handleAddManualUrl = async () => {
    const url = urlInput.trim();
    if (!url) return;
    try {
      const target = await window.anvil.browser.addTarget(url);
      setTargets((prev) => [target, ...prev]);
    } catch {
      /* ignore */
    }
  };

  const handleSendToChat = async () => {
    const activeUrl = previewMode === 'simulator' ? simStatus.url : currentUrl;
    if (!activeUrl) return;
    const selectedText = await webviewEl
      ?.executeJavaScript('window.getSelection()?.toString() ?? ""')
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

    routerNavigate(`/chat?prompt=${encodeURIComponent(prompt)}`);
  };

  const handleStartSimulator = async () => {
    setSimStarting(true);
    try {
      const nextStatus = await window.anvil.simulatorPreview.start();
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
    await window.anvil.simulatorPreview.stop();
    const nextStatus = await window.anvil.simulatorPreview.getStatus();
    setSimStatus(nextStatus);
  };

  const handleAnnotate = async () => {
    const note = annotationNote.trim();
    const activeUrl = previewMode === 'simulator' ? simStatus.url : currentUrl;
    if (!note || !activeUrl) return;
    const selectedText = await webviewEl
      ?.executeJavaScript('window.getSelection()?.toString() ?? ""')
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
    setAnnotations((prev) => [annotation, ...prev].slice(0, 8));
    setAnnotationNote('');

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

    routerNavigate(`/chat?prompt=${encodeURIComponent(prompt)}`);
  };

  const webviewSrc = previewMode === 'simulator' ? (simStatus.url ?? '') : currentUrl;
  const hasUrl = !!webviewSrc;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border bg-bg-secondary px-4 py-2">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-primary p-0.5">
          <button
            type="button"
            onClick={() => setPreviewMode('browser')}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              previewMode === 'browser'
                ? 'bg-accent/15 text-accent'
                : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary'
            }`}
          >
            <Globe size={13} />
            Web
          </button>
          <button
            type="button"
            onClick={() => setPreviewMode('simulator')}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              previewMode === 'simulator'
                ? 'bg-info/15 text-info'
                : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary'
            }`}
          >
            <MonitorSmartphone size={13} />
            Sim
          </button>
        </div>

        {/* Nav buttons */}
        <button
          onClick={() => webviewEl?.goBack()}
          disabled={!canGoBack || previewMode === 'simulator'}
          className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-30"
          title="Back"
        >
          <ArrowLeft size={16} />
        </button>
        <button
          onClick={() => webviewEl?.goForward()}
          disabled={!canGoForward || previewMode === 'simulator'}
          className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-30"
          title="Forward"
        >
          <ArrowRight size={16} />
        </button>
        <button
          onClick={() => webviewEl?.reload()}
          disabled={!hasUrl}
          className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-30"
          title="Reload"
        >
          {isLoading ? <Loader2 size={16} className="animate-spin" /> : <RotateCw size={16} />}
        </button>
        <button
          onClick={() => void handleSendToChat()}
          disabled={!hasUrl}
          className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-30"
          title="Send browser context to chat"
          aria-label="Send browser context to chat"
        >
          <MessageSquare size={16} />
        </button>

        {/* URL bar */}
        <form onSubmit={handleUrlSubmit} className="flex flex-1 items-center gap-2">
          <div className="relative flex flex-1 items-center">
            <Globe size={14} className="absolute left-3 text-text-tertiary" />
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              disabled={previewMode === 'simulator'}
              placeholder="Enter URL or select a detected dev server..."
              className="w-full rounded-lg border border-border bg-bg-primary py-1.5 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent/50 focus:outline-none disabled:opacity-50"
            />
          </div>
        </form>

        {/* Detected targets dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowTargets(!showTargets)}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
              targets.length > 0
                ? 'border-success/30 bg-success/10 text-success hover:bg-success/20'
                : 'border-border text-text-secondary hover:bg-bg-tertiary'
            }`}
            title={`${targets.length} detected dev server${targets.length !== 1 ? 's' : ''}`}
          >
            {targets.length > 0 ? <Wifi size={14} /> : <WifiOff size={14} />}
            {targets.length}
            <ChevronDown size={12} />
          </button>

          {showTargets && (
            <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-bg-secondary shadow-xl">
              <div className="border-b border-border-subtle px-3 py-2 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                Detected Dev Servers
              </div>
              {targets.length === 0 ? (
                <div className="px-3 py-4 text-center text-sm text-text-tertiary">
                  No dev servers detected yet.
                  <br />
                  <span className="text-xs">
                    Start a dev server in the terminal to auto-detect it.
                  </span>
                </div>
              ) : (
                <div className="max-h-48 overflow-y-auto">
                  {targets.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => handleTargetSelect(t)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text-primary transition-colors hover:bg-bg-tertiary"
                    >
                      <Globe size={14} className="shrink-0 text-accent" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{t.label}</div>
                        <div className="truncate text-xs text-text-tertiary">{t.url}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              <div className="border-t border-border-subtle p-2">
                <button
                  onClick={handleAddManualUrl}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                >
                  <Plus size={12} />
                  Add current URL as target
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* CDP bridge status bar */}
      <div className="flex items-center gap-3 border-b border-border-subtle bg-bg-primary px-4 py-1.5 text-xs">
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-block h-2 w-2 rounded-full ${bridgeStatus.running ? 'bg-success' : 'bg-text-tertiary'}`}
          />
          <span className="text-text-secondary">
            CDP Bridge: {bridgeStatus.running ? `Port ${bridgeStatus.port}` : 'Off'}
          </span>
        </div>

        {!bridgeStatus.running && (
          <button
            onClick={handleStartBridge}
            disabled={bridgeStarting}
            className="flex items-center gap-1 rounded border border-accent/30 bg-accent/10 px-2 py-0.5 text-accent transition-colors hover:bg-accent/20"
          >
            {bridgeStarting ? <Loader2 size={10} className="animate-spin" /> : <Plug size={10} />}
            Start Bridge
          </button>
        )}

        {bridgeStatus.running && mcpStatus !== 'registered' && (
          <button
            onClick={handleRegisterMcp}
            disabled={mcpStatus === 'registering'}
            className="flex items-center gap-1 rounded border border-accent/30 bg-accent/10 px-2 py-0.5 text-accent transition-colors hover:bg-accent/20"
          >
            {mcpStatus === 'registering' ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <PlugZap size={10} />
            )}
            Register Chrome MCP
          </button>
        )}

        {mcpStatus === 'registered' && (
          <span className="flex items-center gap-1 text-success">
            <PlugZap size={10} />
            Chrome MCP registered with Codex
          </span>
        )}

        {mcpStatus === 'error' && <span className="text-error">MCP registration failed</span>}

        {pageTitle && (
          <span className="ml-auto truncate text-text-tertiary" title={pageTitle}>
            {pageTitle}
          </span>
        )}
      </div>

      {previewMode === 'simulator' && (
        <div className="flex items-center gap-2 border-b border-border-subtle bg-bg-primary px-4 py-1.5 text-xs">
          <span
            className={`inline-block h-2 w-2 rounded-full ${simStatus.running ? 'bg-success' : 'bg-text-tertiary'}`}
          />
          <span className="text-text-secondary">
            serve-sim: {simStatus.running ? simStatus.url : 'Off'}
          </span>
          {!simStatus.running ? (
            <button
              type="button"
              onClick={handleStartSimulator}
              disabled={simStarting}
              className="flex items-center gap-1 rounded border border-info/30 bg-info/10 px-2 py-0.5 text-info transition-colors hover:bg-info/20 disabled:opacity-50"
            >
              {simStarting ? <Loader2 size={10} className="animate-spin" /> : <Plug size={10} />}
              Start serve-sim
            </button>
          ) : (
            <button
              type="button"
              onClick={handleStopSimulator}
              className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            >
              <Square size={10} />
              Stop
            </button>
          )}
          {simStatus.metroUrl && (
            <span className="ml-auto truncate text-text-tertiary">
              Metro mount: {simStatus.metroUrl}
            </span>
          )}
        </div>
      )}

      {hasUrl && (
        <div className="flex items-center gap-2 border-b border-border-subtle bg-bg-secondary/70 px-4 py-2">
          <input
            value={annotationNote}
            onChange={(event) => setAnnotationNote(event.target.value)}
            placeholder="Annotate the current preview..."
            className="min-w-0 flex-1 rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent/50 focus:outline-none"
          />
          <button
            type="button"
            onClick={handleAnnotate}
            disabled={!annotationNote.trim()}
            className="flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <MessageSquare size={14} />
            Send note
          </button>
          {annotations.length > 0 && (
            <span className="text-xs text-text-tertiary">{annotations.length} recent</span>
          )}
        </div>
      )}

      {/* Webview or empty state */}
      {hasUrl ? (
        <webview
          ref={webviewRefCallback as React.Ref<Electron.WebviewTag>}
          src={webviewSrc}
          className="flex-1"
          style={{ display: 'flex', flex: 1 }}
          allowpopups
        />
      ) : previewMode === 'simulator' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <div className="rounded-2xl border border-border-subtle bg-bg-secondary p-6">
            <MonitorSmartphone size={48} className="mx-auto mb-4 text-text-tertiary" />
            <h2 className="text-lg font-semibold text-text-primary">iOS Simulator Preview</h2>
            <p className="mt-2 max-w-md text-sm text-text-secondary">
              Start serve-sim to embed the simulator preview inside Anvil.
            </p>
            <button
              type="button"
              onClick={handleStartSimulator}
              disabled={simStarting}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
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

      {/* Click-away backdrop for targets dropdown */}
      {showTargets && <div className="fixed inset-0 z-40" onClick={() => setShowTargets(false)} />}
    </div>
  );
}
