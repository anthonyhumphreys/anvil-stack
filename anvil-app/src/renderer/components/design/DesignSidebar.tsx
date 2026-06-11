// src/renderer/components/design/DesignSidebar.tsx

import { useState } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  Paintbrush,
  Code,
} from 'lucide-react';
import { useDesign } from '../../contexts/DesignContext';
import type { DesignMode, FigmaFileRef } from '../../../shared/types';
import { useStoredPanelState } from '../../hooks/useStoredPanelState';

interface DesignSidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

const PERSONA_COLOUR = '#ec4899';

export function DesignSidebar({ collapsed, onToggleCollapse }: DesignSidebarProps) {
  const {
    mode,
    figmaFiles,
    activeFigmaFile,
    readiness,
    readinessLoading,
    switchMode,
    setActiveFigmaFile,
    resolveReadinessIssue,
  } = useDesign();

  const [installingFigma, setInstallingFigma] = useState(false);
  const [installingSkill, setInstallingSkill] = useState(false);
  const { width, setWidth } = useStoredPanelState({
    storageKey: 'chat:design-sidebar',
    defaultWidth: 280,
    minWidth: 240,
    maxWidth: 420,
  });

  const handleResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    if (collapsed) return;

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (moveEvent: MouseEvent) => {
      setWidth(startWidth - (moveEvent.clientX - startX));
    };

    const handleMouseUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-l border-border bg-bg-secondary py-2">
        <button
          onClick={onToggleCollapse}
          className="rounded p-1 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          <ChevronLeft size={14} />
        </button>
      </div>
    );
  }

  const handleInstallFigma = async () => {
    setInstallingFigma(true);
    await resolveReadinessIssue('figmaMcp');
    setInstallingFigma(false);
  };

  const handleInstallSkill = async () => {
    setInstallingSkill(true);
    await resolveReadinessIssue('frontendSkill');
    setInstallingSkill(false);
  };

  return (
    <div
      className="relative flex shrink-0 flex-col overflow-hidden border-l border-border bg-bg-secondary"
      style={{ width: Math.min(width, window.innerWidth * 0.4) }}
    >
      {/* Header with collapse */}
      <div className="flex items-center justify-between border-b border-border px-3 py-3">
        <span className="text-sm font-semibold text-text-primary">Design Companion</span>
        <button
          onClick={onToggleCollapse}
          className="rounded p-1 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 space-y-3 overflow-auto p-3">
        {/* Mode toggle */}
        <ModeToggle mode={mode} onSwitch={switchMode} />

        {/* Readiness banner */}
        {readiness && !readiness.allReady && (
          <ReadinessBanner
            readiness={readiness}
            loading={readinessLoading}
            installingFigma={installingFigma}
            installingSkill={installingSkill}
            onInstallFigma={handleInstallFigma}
            onInstallSkill={handleInstallSkill}
          />
        )}

        {/* Figma files */}
        {figmaFiles.length > 0 ? (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-text-secondary">Figma Files</h3>
            <div className="space-y-2">
              {figmaFiles.map((file) => (
                <FigmaFileCard
                  key={`${file.kind}:${file.fileKey}`}
                  file={file}
                  isActive={
                    activeFigmaFile?.kind === file.kind && activeFigmaFile?.fileKey === file.fileKey
                  }
                  onClick={() => setActiveFigmaFile(file)}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-bg-primary p-4 text-center">
            <ExternalLink size={24} className="mx-auto mb-2 text-text-tertiary" />
            <p className="text-sm text-text-secondary">
              Paste a Figma URL into the chat to get started.
            </p>
            <p className="mt-1 text-sm text-text-tertiary">
              The Design Companion will extract file context automatically.
            </p>
          </div>
        )}
      </div>

      <div
        onMouseDown={handleResizeStart}
        className="absolute -left-1 bottom-0 top-0 z-10 w-2 cursor-col-resize"
        aria-hidden="true"
      >
        <div className="mx-auto h-full w-px bg-border/50 transition-colors hover:bg-accent" />
      </div>
    </div>
  );
}

function ModeToggle({
  mode,
  onSwitch,
}: {
  mode: DesignMode;
  onSwitch: (mode: DesignMode) => void;
}) {
  return (
    <div className="flex rounded-lg border border-border bg-bg-primary p-1">
      <button
        onClick={() => onSwitch('design')}
        className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
          mode === 'design' ? 'text-white' : 'text-text-secondary hover:text-text-primary'
        }`}
        style={mode === 'design' ? { backgroundColor: PERSONA_COLOUR } : undefined}
      >
        <Paintbrush size={14} />
        Design
      </button>
      <button
        onClick={() => onSwitch('implement')}
        className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
          mode === 'implement' ? 'text-white' : 'text-text-secondary hover:text-text-primary'
        }`}
        style={mode === 'implement' ? { backgroundColor: PERSONA_COLOUR } : undefined}
      >
        <Code size={14} />
        Implement
      </button>
    </div>
  );
}

function ReadinessBanner({
  readiness,
  loading,
  installingFigma,
  installingSkill,
  onInstallFigma,
  onInstallSkill,
}: {
  readiness: { figmaMcpRegistered: boolean; frontendSkillInstalled: boolean };
  loading: boolean;
  installingFigma: boolean;
  installingSkill: boolean;
  onInstallFigma: () => void;
  onInstallSkill: () => void;
}) {
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/10 p-3">
      <div className="mb-2 flex items-center gap-2">
        <AlertTriangle size={14} className="text-warning" />
        <span className="text-sm font-medium text-warning">Setup Required</span>
      </div>
      <div className="space-y-2">
        {!readiness.figmaMcpRegistered && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-text-secondary">Figma MCP remote server</span>
            <button
              onClick={onInstallFigma}
              disabled={installingFigma || loading}
              className="rounded-md bg-accent px-2 py-1 text-sm text-white hover:bg-accent/80 disabled:opacity-40"
            >
              {installingFigma ? <Loader2 size={12} className="animate-spin" /> : 'Set up'}
            </button>
          </div>
        )}
        {!readiness.frontendSkillInstalled && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-text-secondary">Frontend Design skill</span>
            <button
              onClick={onInstallSkill}
              disabled={installingSkill || loading}
              className="rounded-md bg-accent px-2 py-1 text-sm text-white hover:bg-accent/80 disabled:opacity-40"
            >
              {installingSkill ? <Loader2 size={12} className="animate-spin" /> : 'Install'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FigmaFileCard({
  file,
  isActive,
  onClick,
}: {
  file: FigmaFileRef;
  isActive: boolean;
  onClick: () => void;
}) {
  const displayName = file.fileName || `${file.fileKey.slice(0, 12)}...`;
  const label = file.kind === 'make' ? 'Make' : file.kind === 'board' ? 'FigJam' : 'Design';
  const addedDate = new Date(file.addedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <button
      onClick={onClick}
      className={`w-full rounded-lg border p-3 text-left transition-colors hover:bg-bg-tertiary ${
        isActive ? 'border-[#ec4899]/50 bg-[#ec4899]/5' : 'border-border bg-bg-primary'
      }`}
    >
      <div className="flex items-center gap-2">
        <ExternalLink size={14} className="shrink-0 text-text-secondary" />
        <span className="truncate text-sm font-medium text-text-primary">{displayName}</span>
        <span className="ml-auto rounded bg-bg-tertiary px-1.5 py-0.5 text-sm text-text-tertiary">
          {label}
        </span>
      </div>
      {file.nodeId && (
        <p className="mt-1 font-mono text-sm text-text-tertiary">Node: {file.nodeId}</p>
      )}
      <p className="mt-1 text-sm text-text-tertiary">Added {addedDate}</p>
    </button>
  );
}
