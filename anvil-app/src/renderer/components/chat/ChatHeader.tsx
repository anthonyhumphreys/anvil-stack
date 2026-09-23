import type { Ref } from 'react';
import { Bot, Globe, LifeBuoy, PanelRightOpen, PictureInPicture2 } from 'lucide-react';
import type { WorkspaceScaffoldStatus } from '../../../shared/types';
import { SegmentedControl } from '../ui';
import { ThreadPullRequests } from './ThreadPullRequests';
import type { ChatPanelId } from './useChatPanels';

/**
 * CH4 — low-density chat header: title + workspace, PR chip, one
 * mutually-exclusive Panels control (Activity · Canvas · Preview), and the
 * role-gated ITSM workbench toggle. The Chat/Tickets layout switch moved to
 * the thread rail header (ChatLayoutToggle).
 */
export function ChatHeader({
  title,
  workspaceName,
  scaffoldModeActive,
  scaffoldStatus,
  pullRequestThread,
  showPanels,
  activePanel,
  onSelectPanel,
  canvasAvailable,
  canvasCount,
  canvasDetached,
  previewAvailable,
  activityRunningCount,
  showItsmToggle,
  itsmWorkbenchActive,
  onToggleItsmWorkbench,
  panelsGroupRef,
}: {
  title: string;
  workspaceName: string;
  scaffoldModeActive: boolean;
  scaffoldStatus?: WorkspaceScaffoldStatus | null;
  pullRequestThread: {
    threadId: string;
    preferredRepoId?: string;
    repoIds: string[];
  } | null;
  /** Whether the Panels control renders at all (hidden for design/BA personas). */
  showPanels: boolean;
  activePanel: ChatPanelId | null;
  onSelectPanel: (panel: ChatPanelId | null) => void;
  canvasAvailable: boolean;
  canvasCount: number;
  canvasDetached: boolean;
  previewAvailable: boolean;
  activityRunningCount: number;
  showItsmToggle: boolean;
  itsmWorkbenchActive: boolean;
  onToggleItsmWorkbench: () => void;
  /** Lets the activity panel restore focus to the selected control on close. */
  panelsGroupRef?: Ref<HTMLDivElement>;
}) {
  type PanelSelection = ChatPanelId | 'none';
  const panelValue: PanelSelection = activePanel ?? 'none';

  return (
    <div className="relative z-40 flex min-h-14 items-center gap-2 border-b border-border/60 bg-bg-secondary px-3 py-2 lg:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-semibold tracking-tight text-text-primary">
              {title}
            </h2>
          </div>
          <p className="truncate text-xs text-text-tertiary">{workspaceName}</p>
        </div>

        {pullRequestThread && !scaffoldModeActive ? (
          <ThreadPullRequests
            key={pullRequestThread.threadId}
            threadId={pullRequestThread.threadId}
            preferredRepoId={pullRequestThread.preferredRepoId}
            repoIds={pullRequestThread.repoIds}
          />
        ) : null}

        {scaffoldModeActive && (
          <span className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
            {scaffoldStatus === 'indexing'
              ? 'Indexing repos'
              : scaffoldStatus === 'syncing'
                ? 'Syncing repos'
                : scaffoldStatus === 'failed'
                  ? 'Scaffold needs attention'
                  : 'Scaffolding'}
          </span>
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center justify-end gap-2">
        {showItsmToggle && (
          <button
            type="button"
            onClick={onToggleItsmWorkbench}
            className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            title={itsmWorkbenchActive ? 'Hide ITSM workbench' : 'Show ITSM workbench'}
            aria-pressed={itsmWorkbenchActive}
          >
            <LifeBuoy size={13} />
            <span className="hidden xl:inline">ITSM workbench</span>
          </button>
        )}

        {showPanels && (
          <div ref={panelsGroupRef}>
            <SegmentedControl<PanelSelection>
              label="Panels"
              value={panelValue}
              onChange={(panel) => onSelectPanel(panel === 'none' ? null : panel)}
              onReselect={(panel) => {
                // Clicking the open panel's option closes it (toggle behavior).
                if (panel !== 'none') onSelectPanel(null);
              }}
              options={[
                {
                  value: 'activity',
                  label: (
                    <>
                      Activity
                      {activityRunningCount > 0 && (
                        <span className="rounded-full bg-bg-primary px-1.5 py-0.5 text-eyebrow font-semibold text-text-primary">
                          {activityRunningCount}
                        </span>
                      )}
                    </>
                  ),
                  icon: Bot,
                  ariaLabel:
                    activityRunningCount > 0
                      ? `Activity panel, ${activityRunningCount} running`
                      : 'Activity panel',
                },
                {
                  value: 'canvas',
                  label: (
                    <>
                      {canvasDetached ? 'Canvas (detached)' : 'Canvas'}
                      {canvasCount > 0 && (
                        <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-eyebrow font-semibold text-accent">
                          {canvasCount}
                        </span>
                      )}
                    </>
                  ),
                  icon: canvasDetached ? PictureInPicture2 : PanelRightOpen,
                  disabled: !canvasAvailable,
                  ariaLabel: canvasDetached ? 'Reattach canvas' : 'Canvas panel',
                  title: canvasDetached ? 'Reattach canvas' : 'Canvas panel',
                },
                {
                  value: 'preview',
                  label: 'Preview',
                  icon: Globe,
                  disabled: !previewAvailable,
                  ariaLabel: 'Preview panel',
                },
              ]}
            />
          </div>
        )}
      </div>
    </div>
  );
}
