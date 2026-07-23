import { useState, useRef, useCallback, useEffect } from 'react';
import {
  LEGACY_TERMINAL_STORAGE_KEY,
  PRIMARY_TERMINAL_STORAGE_KEY,
} from '../../../shared/app-identity';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { TerminalTabs } from './TerminalTabs';
import { TerminalInstance } from './TerminalInstance';
import {
  closeTerminalRepo,
  EMPTY_WORKSPACE_TERMINAL_STATE,
  selectTerminalRepo,
  type WorkspaceTerminalState,
} from './terminal-state';

const MIN_HEIGHT = 100;
const DEFAULT_HEIGHT = 300;

interface TerminalPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function TerminalPanel({ isOpen }: TerminalPanelProps) {
  const { activeWorkspace, repos } = useWorkspace();
  const [workspaceStates, setWorkspaceStates] = useState<Record<string, WorkspaceTerminalState>>(
    {},
  );
  const [terminalIds, setTerminalIds] = useState<Record<string, Record<string, string>>>({});
  const [height, setHeight] = useState(() => {
    const stored =
      localStorage.getItem(PRIMARY_TERMINAL_STORAGE_KEY) ??
      localStorage.getItem(LEGACY_TERMINAL_STORAGE_KEY);
    return stored ? Math.max(MIN_HEIGHT, parseInt(stored, 10)) : DEFAULT_HEIGHT;
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const workspaceId = activeWorkspace?.id ?? null;
  const workspaceState = workspaceId
    ? (workspaceStates[workspaceId] ?? EMPTY_WORKSPACE_TERMINAL_STATE)
    : EMPTY_WORKSPACE_TERMINAL_STATE;
  const createdRepoIds = new Set(workspaceState.createdRepoIds);
  const workspaceRepos = repos;
  const firstRepoId = workspaceRepos[0]?.id ?? null;

  const updateWorkspaceState = useCallback(
    (update: (current: WorkspaceTerminalState) => WorkspaceTerminalState) => {
      if (!workspaceId) return;
      setWorkspaceStates((current) => ({
        ...current,
        [workspaceId]: update(current[workspaceId] ?? EMPTY_WORKSPACE_TERMINAL_STATE),
      }));
    },
    [workspaceId],
  );

  // Recover terminals owned by the main process when entering a workspace or
  // opening it in another window. Workspace selection never tears them down.
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    const repoIds = new Set(workspaceRepos.map((repo) => repo.id));

    window.anvil.terminal
      .list(workspaceId)
      .then((sessions) => {
        if (cancelled) return;
        const availableSessions = sessions.filter((session) => repoIds.has(session.repoId));
        setTerminalIds((current) => ({
          ...current,
          [workspaceId]: Object.fromEntries(
            availableSessions.map((session) => [session.repoId, session.terminalId]),
          ),
        }));
        setWorkspaceStates((current) => {
          const previous = current[workspaceId] ?? EMPTY_WORKSPACE_TERMINAL_STATE;
          const sessionRepoIds = availableSessions.map((session) => session.repoId);
          const createdRepoIds = [
            ...new Set([...previous.createdRepoIds, ...sessionRepoIds]),
          ].filter((repoId) => repoIds.has(repoId));
          return {
            ...current,
            [workspaceId]: {
              activeRepoId:
                previous.activeRepoId && repoIds.has(previous.activeRepoId)
                  ? previous.activeRepoId
                  : (createdRepoIds[0] ?? null),
              createdRepoIds,
            },
          };
        });
      })
      .catch(console.error);

    return () => {
      cancelled = true;
    };
  }, [workspaceId, workspaceRepos]);

  // Open the first repository on first use. Closing a terminal leaves its tab
  // selected but stopped, so this does not immediately resurrect it.
  useEffect(() => {
    if (isOpen && !workspaceState.activeRepoId && firstRepoId) {
      updateWorkspaceState((current) => selectTerminalRepo(current, firstRepoId));
    }
  }, [isOpen, workspaceState.activeRepoId, firstRepoId, updateWorkspaceState]);

  const handleSelectTab = useCallback(
    (repoId: string) => {
      updateWorkspaceState((current) => selectTerminalRepo(current, repoId));
    },
    [updateWorkspaceState],
  );

  const removeLocalTerminal = useCallback(
    (repoId: string) => {
      if (!workspaceId) return;
      updateWorkspaceState((current) => closeTerminalRepo(current, repoId));
      setTerminalIds((current) => {
        const nextWorkspaceTerminals = { ...(current[workspaceId] ?? {}) };
        delete nextWorkspaceTerminals[repoId];
        return { ...current, [workspaceId]: nextWorkspaceTerminals };
      });
    },
    [updateWorkspaceState, workspaceId],
  );

  const handleCloseTab = useCallback(
    async (repoId: string) => {
      if (!workspaceId) return;
      const terminalId = terminalIds[workspaceId]?.[repoId] ?? `${workspaceId}-${repoId}`;
      await window.anvil.terminal.close(terminalId);
      removeLocalTerminal(repoId);
    },
    [removeLocalTerminal, terminalIds, workspaceId],
  );

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      const startY = e.clientY;
      const startHeight = height;

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!isDragging.current) return;
        const parentHeight = panelRef.current?.parentElement?.clientHeight ?? 600;
        const maxHeight = parentHeight * 0.7;
        const delta = startY - moveEvent.clientY;
        setHeight(Math.min(maxHeight, Math.max(MIN_HEIGHT, startHeight + delta)));
      };

      const onMouseUp = () => {
        isDragging.current = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [height],
  );

  useEffect(() => {
    localStorage.setItem(PRIMARY_TERMINAL_STORAGE_KEY, String(height));
  }, [height]);

  if (!isOpen || workspaceRepos.length === 0 || !workspaceId) return null;

  return (
    <div
      ref={panelRef}
      className="flex shrink-0 flex-col border-t border-border-subtle bg-bg-primary"
      style={{ height }}
    >
      <div
        className="h-1 cursor-row-resize bg-bg-secondary hover:bg-accent/30 transition-colors"
        onMouseDown={handleDragStart}
      />

      <TerminalTabs
        repos={workspaceRepos}
        activeRepoId={workspaceState.activeRepoId}
        openRepoIds={workspaceState.createdRepoIds}
        onSelectTab={handleSelectTab}
        onCloseTab={(repoId) => void handleCloseTab(repoId)}
      />

      <div className="relative flex-1 overflow-hidden">
        {workspaceRepos.map((repo) =>
          createdRepoIds.has(repo.id) ? (
            <TerminalInstance
              key={`${workspaceId}-${repo.id}`}
              workspaceId={workspaceId}
              repoId={repo.id}
              repoPath={repo.path}
              visible={workspaceState.activeRepoId === repo.id}
              onReady={(terminalId) =>
                setTerminalIds((current) => ({
                  ...current,
                  [workspaceId]: { ...(current[workspaceId] ?? {}), [repo.id]: terminalId },
                }))
              }
              onClosed={() => removeLocalTerminal(repo.id)}
            />
          ) : null,
        )}
        {workspaceState.activeRepoId && !createdRepoIds.has(workspaceState.activeRepoId) && (
          <div className="flex h-full items-center justify-center">
            <button
              type="button"
              onClick={() => handleSelectTab(workspaceState.activeRepoId!)}
              className="rounded-md border border-border-subtle bg-bg-secondary px-3 py-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary"
            >
              Start terminal
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
