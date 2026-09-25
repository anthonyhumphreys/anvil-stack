import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ComponentProps } from 'react';
import type { ExtractedFinding } from '../../utils/finding-parser';
import type { PreviewMode } from '../browser/BrowserPanel';
import { BrowserPanel } from '../browser/BrowserPanel';
import { DesignSidebar } from '../design/DesignSidebar';
import { ResizableSidebarPanel } from '../layout/ResizableSidebarPanel';
import { AgentActivitySidebar } from './ChatActivityPanel';
import { ChatCanvasSidebar } from './ChatCanvasPanel';
import { ChatFindingCard } from './ChatFindingCard';
import { DetachedCanvasWindow } from './DetachedCanvasWindow';
import { ItsmWorkbench } from './ItsmWorkbench';

/**
 * Right-side surface stack — extracted from ChatView (Phase 5 split).
 * Renders whichever side panel is active: findings (BA), design sidebar,
 * ITSM workbench, preview, activity, canvas, plus the expanded/detached
 * canvas presentations.
 */

type CanvasProps = Omit<
  ComponentProps<typeof ChatCanvasSidebar>,
  'presentation' | 'onExpand' | 'onDetach'
>;

export function ChatSidePanels({
  previewMode,
  previewInitialUrl,
  onClosePreview,
  isBaPersona,
  hasFindings,
  openFindings,
  showFindings,
  onToggleFindings,
  onFindingFollowUp,
  onDismissFinding,
  isDesignPersona,
  designSidebarCollapsed,
  onToggleDesignSidebar,
  showItsmWorkbench,
  workspaceId,
  onItsmPrompt,
  showActivitySidebar,
  activity,
  showCanvasSidebar,
  canvas,
  canvasExpanded,
  canvasDetached,
  onExpandCanvas,
  onCollapseCanvas,
  onDetachCanvas,
  onDetachedCanvasClose,
  canvasOverlayAvailable,
}: {
  previewMode: PreviewMode | null;
  previewInitialUrl: string;
  onClosePreview: () => void;
  isBaPersona: boolean;
  /** Any findings exist — keeps the panel open even when all are dismissed. */
  hasFindings: boolean;
  openFindings: (ExtractedFinding & { idx: number })[];
  showFindings: boolean;
  onToggleFindings: () => void;
  onFindingFollowUp: (finding: ExtractedFinding & { idx: number }) => void;
  onDismissFinding: (idx: number) => void;
  isDesignPersona: boolean;
  designSidebarCollapsed: boolean;
  onToggleDesignSidebar: () => void;
  showItsmWorkbench: boolean;
  workspaceId: string | null;
  onItsmPrompt: (prompt: string) => void;
  showActivitySidebar: boolean;
  activity: ComponentProps<typeof AgentActivitySidebar>;
  showCanvasSidebar: boolean;
  canvas: CanvasProps;
  canvasExpanded: boolean;
  canvasDetached: boolean;
  onExpandCanvas: () => void;
  onCollapseCanvas: () => void;
  onDetachCanvas: () => void;
  onDetachedCanvasClose: () => void;
  /** Whether the expanded/detached overlays have content to show. */
  canvasOverlayAvailable: boolean;
}) {
  const totalFindingCount = openFindings.length;

  return (
    <>
      {/* Findings sidebar - BA persona only */}
      {!previewMode && isBaPersona && hasFindings && (
        <ResizableSidebarPanel
          storageKey="chat:findings"
          side="right"
          title="Findings"
          defaultWidth={380}
          minWidth={300}
          maxWidth={560}
          className="border-l border-border/60 bg-bg-secondary/50"
        >
          <div className="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
            <div className="min-w-0">
              <button
                onClick={onToggleFindings}
                className="flex items-center gap-1.5 text-sm font-medium text-text-primary"
              >
                {showFindings ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Findings
                <span className="rounded-full bg-warning/20 px-2 py-0.5 text-xs font-medium text-warning">
                  {totalFindingCount}
                </span>
              </button>
              <p className="mt-1 text-xs text-text-tertiary">
                Scrollable. Use follow-up to drop a targeted prompt into the composer.
              </p>
            </div>
          </div>

          {showFindings && (
            <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
              <div className="space-y-2">
                {openFindings.map((f) => (
                  <ChatFindingCard
                    key={f.idx}
                    finding={f}
                    onFollowUp={() => onFindingFollowUp(f)}
                    onDismiss={() => onDismissFinding(f.idx)}
                  />
                ))}
                {openFindings.length === 0 && (
                  <p className="p-2 text-center text-sm text-text-tertiary">
                    All findings dismissed.
                  </p>
                )}
              </div>
            </div>
          )}
        </ResizableSidebarPanel>
      )}

      {/* Design sidebar */}
      {!previewMode && isDesignPersona && (
        <DesignSidebar
          collapsed={designSidebarCollapsed}
          onToggleCollapse={onToggleDesignSidebar}
        />
      )}

      {showItsmWorkbench && (
        <ResizableSidebarPanel
          storageKey="chat:itsm-workbench"
          side="right"
          title="ITSM workbench"
          defaultWidth={380}
          minWidth={320}
          maxWidth={560}
          collapsedWidth={0}
          className="border-l border-border/60 bg-bg-secondary/50"
        >
          <ItsmWorkbench workspaceId={workspaceId} onPrompt={onItsmPrompt} />
        </ResizableSidebarPanel>
      )}

      {previewMode && (
        <ResizableSidebarPanel
          storageKey="chat:preview"
          side="right"
          title={previewMode === 'simulator' ? 'Simulator preview' : 'Browser preview'}
          defaultWidth={620}
          minWidth={420}
          maxWidth={1100}
          collapsedWidth={0}
          className="border-l border-border/60 bg-bg-secondary/50"
        >
          <BrowserPanel
            key={previewMode}
            initialMode={previewMode}
            initialUrl={previewInitialUrl}
            presentation="pane"
            onClose={onClosePreview}
          />
        </ResizableSidebarPanel>
      )}

      {showActivitySidebar && (
        <ResizableSidebarPanel
          storageKey="chat:activity"
          side="right"
          title="Activity"
          defaultWidth={420}
          minWidth={340}
          maxWidth={620}
          collapsedWidth={0}
          collapsible={false}
          className="border-l border-border/60 bg-bg-secondary/50"
        >
          <AgentActivitySidebar {...activity} />
        </ResizableSidebarPanel>
      )}

      {showCanvasSidebar && (
        <ResizableSidebarPanel
          storageKey="chat:canvas"
          side="right"
          title="Canvas"
          defaultWidth={460}
          minWidth={360}
          maxWidth={960}
          collapsedWidth={0}
          collapsible={false}
          className="border-l border-border/60 bg-bg-secondary/50"
        >
          <ChatCanvasSidebar
            {...canvas}
            presentation="sidebar"
            onExpand={onExpandCanvas}
            onDetach={onDetachCanvas}
          />
        </ResizableSidebarPanel>
      )}

      {canvasExpanded && !canvasDetached && canvasOverlayAvailable && (
        <div className="fixed inset-y-3 left-20 right-3 z-50 flex min-h-0 overflow-hidden rounded-xl border border-border bg-bg-primary shadow-2xl">
          <ChatCanvasSidebar
            {...canvas}
            presentation="expanded"
            onExpand={onCollapseCanvas}
            onDetach={onDetachCanvas}
          />
        </div>
      )}

      {canvasDetached && canvasOverlayAvailable && (
        <DetachedCanvasWindow title="Anvil Canvas" onClose={onDetachedCanvasClose}>
          <ChatCanvasSidebar
            {...canvas}
            presentation="detached"
            onExpand={onDetachedCanvasClose}
            onDetach={onDetachedCanvasClose}
          />
        </DetachedCanvasWindow>
      )}
    </>
  );
}
