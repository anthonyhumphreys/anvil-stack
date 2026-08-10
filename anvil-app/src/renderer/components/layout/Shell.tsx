import { useState, useEffect, useCallback } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { CommandPalette } from './CommandPalette';
import { WorkspaceRail } from '../workspace/WorkspaceRail';
import { WorkspaceCreator } from '../workspace/WorkspaceCreator';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import type { UserRole } from '../../../shared/types';
import { ROLE_FEATURES } from '../../../shared/types';
import { TerminalPanel } from '../terminal/TerminalPanel';
import { EditorView } from '../editor/EditorView';
import { isEditableShortcutTarget, isShellShortcutOptInTarget } from '../../utils/keyboard';
import { SidebarActivityProvider } from './SidebarActivityCenter';

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
  const {
    workspaces,
    activeWorkspace,
    activeScaffoldSession,
    switchWorkspace,
    deleteWorkspace,
    updateWorkspace,
    refreshWorkspaces,
  } = useWorkspace();
  const [showCreator, setShowCreator] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [windowChromeState, setWindowChromeState] = useState({ isFullScreen: false });
  const location = useLocation();
  const navigate = useNavigate();
  const editorFeatureEnabled = ROLE_FEATURES[userRole].includes('editor');
  const showingEditor = editorFeatureEnabled && location.pathname === '/editor';
  const reserveTitlebarSpace = !windowChromeState.isFullScreen;

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

  return (
    <SidebarActivityProvider>
      <div className="flex h-screen flex-col">
        <div className="flex flex-1 overflow-hidden">
          <WorkspaceRail
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspace?.id ?? null}
            reserveTitlebarSpace={reserveTitlebarSpace}
            onSwitch={(id: string) => switchWorkspace(id)}
            onCreateNew={() => setShowCreator(true)}
            onRename={async (id: string) => {
              const ws = workspaces.find((w) => w.id === id);
              const newName = window.prompt('Rename workspace:', ws?.name ?? '');
              if (newName && newName !== ws?.name) {
                await updateWorkspace(id, { name: newName });
              }
            }}
            onManageRepos={() => {}}
            onOpenInNewWindow={async (id: string) => {
              await window.anvil.workspace.openInNewWindow(id);
            }}
            onExportVSCode={async (id: string) => {
              await window.anvil.workspace.exportVSCodeWorkspace(id);
            }}
            onDelete={async (id: string) => {
              if (window.confirm('Delete this workspace? Repos will not be removed.')) {
                await deleteWorkspace(id);
              }
            }}
          />
          <Sidebar
            connectionStatus={connectionStatus}
            userRole={userRole}
            cloudFeaturesEnabled={cloudFeaturesEnabled}
            reserveTitlebarSpace={reserveTitlebarSpace}
          />
          <main className="relative flex flex-1 flex-col overflow-hidden bg-bg-primary">
            {reserveTitlebarSpace && (
              <div className="titlebar-drag absolute inset-x-0 top-0 z-10 h-3 shrink-0" />
            )}
            <div className="relative flex min-h-0 flex-1 flex-col">
              {editorFeatureEnabled && (
                <div className={showingEditor ? 'flex min-h-0 min-w-0 flex-1 w-full' : 'hidden'}>
                  <EditorView />
                </div>
              )}
              <div className={showingEditor ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
                <Outlet />
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
