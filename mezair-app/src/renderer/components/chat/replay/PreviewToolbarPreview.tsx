import { useState } from 'react';
import { PreviewToolbar } from '../../browser/PreviewToolbar';
import type { PreviewMode } from '../../browser/BrowserPanel';

/** Offline fixture for the production preview toolbar at real split-pane widths. */
export function PreviewToolbarPreview() {
  const [mode, setMode] = useState<PreviewMode>('simulator');
  const [width, setWidth] = useState('380');
  const [url, setUrl] = useState('http://localhost:5173/settings');
  const [running, setRunning] = useState(true);
  const [annotating, setAnnotating] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [theme, setTheme] = useState('dark');
  return (
    <main data-theme={theme} className="flex h-screen flex-col bg-bg-primary text-text-primary">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 text-xs">
        <span className="mr-auto text-text-secondary">
          Preview toolbar · synthetic local fixture
        </span>
        <label>
          Width{' '}
          <select
            aria-label="Preview width"
            value={width}
            onChange={(event) => setWidth(event.target.value)}
            className="rounded bg-bg-secondary px-2 py-1"
          >
            <option>320</option>
            <option>380</option>
            <option>430</option>
            <option>960</option>
          </select>
        </label>
        <label>
          Theme{' '}
          <select
            aria-label="Preview theme"
            value={theme}
            onChange={(event) => setTheme(event.target.value)}
            className="rounded bg-bg-secondary px-2 py-1"
          >
            <option>dark</option>
            <option>light</option>
          </select>
        </label>
        <a href="/?interactions" className="text-text-secondary underline">
          Chat interactions
        </a>
      </header>
      <div
        className="mx-auto mt-8 flex min-h-0 max-w-full flex-1 flex-col border-x border-border"
        style={{ width: Number(width) }}
      >
        <PreviewToolbar
          mode={mode}
          onModeChange={setMode}
          url={url}
          onUrlChange={setUrl}
          onNavigate={(event) => event.preventDefault()}
          canGoBack={false}
          canGoForward={false}
          onBack={() => undefined}
          onForward={() => undefined}
          onReload={() => undefined}
          loading={false}
          hasUrl={running}
          targets={[]}
          onTargetSelect={(target) => setUrl(target.url)}
          onAddTarget={() => undefined}
          bridge={{ running: true, port: 60609 }}
          bridgeStarting={false}
          onStartBridge={() => undefined}
          mcpStatus={registered ? 'registered' : 'idle'}
          onRegisterMcp={() => setRegistered(true)}
          simulator={{ running, url: 'http://localhost:3200', metroUrl: 'http://localhost:8081' }}
          simulatorStarting={false}
          onStartSimulator={() => setRunning(true)}
          onStopSimulator={() => setRunning(false)}
          annotating={annotating}
          onToggleAnnotation={() => setAnnotating((open) => !open)}
          onSendToChat={() => undefined}
          onDetach={() => undefined}
          onClose={() => undefined}
        />
        {annotating && (
          <input
            aria-label="Preview note"
            placeholder="Annotate the current preview…"
            className="m-2 rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm"
          />
        )}
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-text-secondary">
          {mode === 'simulator' ? 'Simulator content' : 'Web preview content'}
        </div>
      </div>
    </main>
  );
}
