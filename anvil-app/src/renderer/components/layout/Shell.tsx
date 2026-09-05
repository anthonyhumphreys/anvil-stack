import { lazy, Suspense, useState, useEffect, useCallback } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { CommandPalette } from './CommandPalette';
import { WorkspaceCreator } from '../workspace/WorkspaceCreator';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import type { UserRole } from '../../../shared/types';
import { ROLE_FEATURES } from '../../../shared/types';
import { TerminalPanel } from '../terminal/TerminalPanel';

import { isEditableShortcutTarget, isShellShortcutOptInTarget } from '../../utils/keyboard';
import { SidebarActivityProvider } from './SidebarActivityCenter';
import { PictureInPicture2 } from 'lucide-react';

const EditorView = lazy(() =>
  import('../editor/EditorView').then((module) => ({ default: module.EditorView })),
);

interface ShellProps {
  connectionStatus: {
    foundry: boolean | null;
    ado: boolean | null;
    confluence: boolean | null;
  };
  userRole: UserRole;
  cloudFeaturesEnabled: boolean;
}

export function Shell({ connectionStatus, userRole, cloudFeaturesEnabled }: ShellProps) {
  const { activeScaffoldSession, switchWorkspace, refreshWorkspaces } = useWorkspace();
  const [showCreator, setShowCreator] = useState(false);
  const [editorMounted, setEditorMounted] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [windowChromeState, setWindowChromeState] = useState({ isFullScreen: false });
  const location = useLocation();
  const navigate = useNavigate();
  const editorFeatureEnabled = ROLE_FEATURES[userRole].includes('editor');
  const showingEditor = editorFeatureEnabled && location.pathname === '/editor';
  useEffect(() => {
    if (showingEditor) setEditorMounted(true);
  }, [showingEditor]);
  const reserveTitlebarSpace = !windowChromeState.isFullScreen;
  const isToolWindow = new URLSearchParams(location.search).get('toolWindow') === '1';

  const toggleTerminal = useCallback(() => setTerminalOpen((prev) => !prev), []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (shouldIgnoreShellShortcut(e.target)) return;

      if (e.key === '`' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggleTerminal();
      }
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      }
      if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        navigate('/settings');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate, toggleTerminal]);

  useEffect(() => {
    if (!activeScaffoldSession) return;
    if (
      activeScaffoldSession.status === 'completed' ||
      activeScaffoldSession.status === 'cancelled'
    ) {
      return;
    }

    const allowedPaths = new Set(['/chat', '/settings']);
    if (!allowedPaths.has(location.pathname)) {
      navigate('/chat', { replace: true });
    }
  }, [activeScaffoldSession, location.pathname, navigate]);

  useEffect(() => {
    let cancelled = false;
    const cleanup = window.anvil.appWindow.onNavigateToChat(
      async ({ workspaceId, threadId, personaId }) => {
        try {
          await switchWorkspace(workspaceId);
          if (!cancelled) {
            const params = new URLSearchParams({ thread: threadId, persona: personaId });
            navigate(`/chat?${params.toString()}`);
          }
        } catch (err) {
          console.error('[Notification] Failed to open chat thread:', err);
        }
      },
    );

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [navigate, switchWorkspace]);

  useEffect(() => {
    let cancelled = false;

    window.anvil.appWindow
      .getChromeState()
      .then((state) => {
        if (!cancelled) setWindowChromeState(state);
      })
      .catch(() => {});

    const cleanup = window.anvil.appWindow.onChromeStateChanged((state) => {
      setWindowChromeState(state);
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  if (isToolWindow) {
    return (
      <SidebarActivityProvider>
        <div className="flex h-screen min-h-0 flex-col bg-bg-primary">
          <header className="titlebar-drag flex h-11 shrink-0 items-center border-b border-border/60 bg-bg-secondary pl-20 pr-4">
            <PictureInPicture2 size={13} className="mr-2 text-accent" />
            <span className="truncate text-xs font-medium text-text-secondary">
              {getToolWindowTitle(location.pathname)}
            </span>
            <span className="ml-2 text-xs text-text-tertiary">Detached</span>
          </header>
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {showingEditor ? (
              <Suspense fallback={null}>
                <EditorView />
              </Suspense>
            ) : (
              <Suspense
                fallback={
                  <div role="status" className="p-6 text-sm text-text-secondary">
                    Loading view…
                  </div>
                }
              >
                <Outlet />
              </Suspense>
            )}
          </main>
        </div>
      </SidebarActivityProvider>
    );
  }

  return (
    <SidebarActivityProvider>
      <div className="flex h-screen flex-col">
        <div className="flex flex-1 overflow-hidden">
          <Sidebar
            userRole={userRole}
            cloudFeaturesEnabled={cloudFeaturesEnabled}
            reserveTitlebarSpace={reserveTitlebarSpace}
            onCreateWorkspace={() => setShowCreator(true)}
          />
          <main className="relative flex flex-1 flex-col overflow-hidden bg-bg-primary">
            {reserveTitlebarSpace && (
              <div className="titlebar-drag absolute inset-x-0 top-0 z-10 h-3 shrink-0" />
            )}
            <div className="relative flex min-h-0 flex-1 flex-col">
              {editorFeatureEnabled && (editorMounted || showingEditor) && (
                <div className={showingEditor ? 'flex min-h-0 min-w-0 flex-1 w-full' : 'hidden'}>
                  <Suspense fallback={null}>
                    <EditorView />
                  </Suspense>
                </div>
              )}
              <div className={showingEditor ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
                <Suspense
                  fallback={
                    <div role="status" className="p-6 text-sm text-text-secondary">
                      Loading view…
                    </div>
                  }
                >
                  <Outlet />
                </Suspense>
              </div>
            </div>
            <TerminalPanel isOpen={terminalOpen} onClose={() => setTerminalOpen(false)} />
          </main>
        </div>
        <StatusBar
          connectionStatus={connectionStatus}
          onToggleTerminal={() => setTerminalOpen((prev) => !prev)}
          terminalOpen={terminalOpen}
        />
        {showCreator && (
          <WorkspaceCreator
            onCreated={async () => {
              setShowCreator(false);
              await refreshWorkspaces();
            }}
            onCancel={() => setShowCreator(false)}
          />
        )}
        <CommandPalette
          open={commandPaletteOpen}
          onClose={() => setCommandPaletteOpen(false)}
          userRole={userRole}
          onToggleTerminal={toggleTerminal}
          onCreateWorkspace={() => setShowCreator(true)}
        />
      </div>
    </SidebarActivityProvider>
  );
}

export function shouldIgnoreShellShortcut(target: EventTarget | null): boolean {
  return isEditableShortcutTarget(target) && !isShellShortcutOptInTarget(target);
}

export function getToolWindowTitle(pathname: string): string {
  const segment = pathname.split('/').filter(Boolean)[0] ?? 'tool';
  return segment
    .split('-')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
