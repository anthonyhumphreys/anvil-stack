import { useState, useRef, useCallback, useEffect } from 'react';
import {
  LEGACY_TERMINAL_STORAGE_KEY,
  PRIMARY_TERMINAL_STORAGE_KEY,
} from '../../../shared/app-identity';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { TerminalTabs } from './TerminalTabs';
import { TerminalInstance } from './TerminalInstance';

const MIN_HEIGHT = 100;
const DEFAULT_HEIGHT = 300;

interface TerminalPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function TerminalPanel({ isOpen, onClose }: TerminalPanelProps) {
  const { activeWorkspace, repos } = useWorkspace();
  const [activeRepoId, setActiveRepoId] = useState<string | null>(null);
  const [createdTabs, setCreatedTabs] = useState<Set<string>>(new Set());
  const [height, setHeight] = useState(() => {
    const stored =
      localStorage.getItem(PRIMARY_TERMINAL_STORAGE_KEY) ??
      localStorage.getItem(LEGACY_TERMINAL_STORAGE_KEY);
    return stored ? Math.max(MIN_HEIGHT, parseInt(stored, 10)) : DEFAULT_HEIGHT;
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  // repos from useWorkspace() is already filtered to active workspace
  const workspaceRepos = repos;
  const firstRepoId = workspaceRepos[0]?.id ?? null;
  const repoCount = workspaceRepos.length;

  // Reset when workspace changes — close panel and kill all PTYs
  useEffect(() => {
    setActiveRepoId(null);
    setCreatedTabs(new Set());
    onClose();
    window.anvil.terminal.closeAll().catch(console.error);
  }, [activeWorkspace?.id]);

  // Auto-select first tab if none selected
  useEffect(() => {
    if (isOpen && !activeRepoId && firstRepoId) {
      setActiveRepoId(firstRepoId);
    }
  }, [isOpen, activeRepoId, firstRepoId]);

  // Mark tab as created (lazy spawn)
  useEffect(() => {
    if (activeRepoId) {
      setCreatedTabs((prev) => {
        if (prev.has(activeRepoId)) return prev;
        return new Set(prev).add(activeRepoId);
      });
    }
  }, [activeRepoId]);

  // Drag resize
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
        const newHeight = Math.min(maxHeight, Math.max(MIN_HEIGHT, startHeight + delta));
        setHeight(newHeight);
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

  // Persist height to localStorage
  useEffect(() => {
    localStorage.setItem(PRIMARY_TERMINAL_STORAGE_KEY, String(height));
  }, [height]);

  if (!isOpen || repoCount === 0) return null;

  return (
    <div
      ref={panelRef}
      className="flex shrink-0 flex-col border-t border-border-subtle bg-bg-primary"
      style={{ height }}
    >
      {/* Drag handle */}
      <div
        className="h-1 cursor-row-resize bg-bg-secondary hover:bg-accent/30 transition-colors"
        onMouseDown={handleDragStart}
      />

      {/* Tabs */}
      <TerminalTabs
        repos={workspaceRepos}
        activeRepoId={activeRepoId}
        onSelectTab={setActiveRepoId}
      />

      {/* Terminal instances */}
      <div className="relative flex-1 overflow-hidden">
        {workspaceRepos.map((repo) =>
          createdTabs.has(repo.id) ? (
            <TerminalInstance
              key={`${activeWorkspace?.id}-${repo.id}`}
              workspaceId={activeWorkspace?.id ?? ''}
              repoId={repo.id}
              repoPath={repo.path}
              visible={activeRepoId === repo.id}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}
