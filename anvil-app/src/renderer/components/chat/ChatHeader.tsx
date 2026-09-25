import { useEffect, useRef, useState, type Ref } from 'react';
import {
  Bot,
  CircleHelp,
  Globe,
  LifeBuoy,
  PanelRightOpen,
  PictureInPicture2,
  X,
} from 'lucide-react';
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
            <h2
              title={title}
              className="truncate text-sm font-semibold tracking-tight text-text-primary"
            >
              {title}
            </h2>
          </div>
          <p title={workspaceName} className="truncate text-xs text-text-tertiary">
            {workspaceName}
          </p>
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
          <span
            title={
              scaffoldStatus === 'indexing'
                ? 'Indexing repos'
                : scaffoldStatus === 'syncing'
                  ? 'Syncing repos'
                  : scaffoldStatus === 'failed'
                    ? 'Scaffold needs attention'
                    : 'Scaffolding'
            }
            className="max-w-40 truncate rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent"
          >
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
            aria-label={itsmWorkbenchActive ? 'Hide ITSM workbench' : 'Show ITSM workbench'}
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
                      <span className="hidden min-[900px]:inline">Activity</span>
                      {activityRunningCount > 0 && (
                        <span className="rounded-full bg-bg-primary px-1.5 py-0.5 text-eyebrow font-semibold text-text-primary">
                          {activityRunningCount}
                        </span>
                      )}
                    </>
                  ),
                  icon: Bot,
                  title: 'Activity panel',
                  ariaLabel:
                    activityRunningCount > 0
                      ? `Activity panel, ${activityRunningCount} running`
                      : 'Activity panel',
                },
                {
                  value: 'canvas',
                  label: (
                    <>
                      <span className="hidden min-[900px]:inline">
                        {canvasDetached ? 'Canvas (detached)' : 'Canvas'}
                      </span>
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
                  label: <span className="hidden min-[900px]:inline">Preview</span>,
                  icon: Globe,
                  title: 'Preview panel',
                  disabled: !previewAvailable,
                  ariaLabel: 'Preview panel',
                },
              ]}
            />
          </div>
        )}
        <ChatShortcutHelp />
      </div>
    </div>
  );
}

const CHAT_NAVIGATION_SHORTCUTS = [
  { keys: '/', action: 'Focus the message composer' },
  { keys: '⌘K / Ctrl+K', action: 'Open the command palette' },
  { keys: '⌘` / Ctrl+`', action: 'Toggle the terminal' },
  { keys: '⌘, / Ctrl+,', action: 'Open settings' },
] as const;

function ChatShortcutHelp() {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const closeOnPointerDown = (event: MouseEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('mousedown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnKeyDown);
    return () => {
      document.removeEventListener('mousedown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnKeyDown);
    };
  }, [open]);

  return (
    <div ref={popoverRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        aria-label="Keyboard shortcuts"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="chat-shortcut-help"
        title="Keyboard shortcuts"
      >
        <CircleHelp size={15} />
      </button>
      {open && (
        <div
          id="chat-shortcut-help"
          role="dialog"
          aria-label="Keyboard shortcuts"
          className="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border border-border bg-bg-elevated p-3 shadow-2xl ring-1 ring-overlay"
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold text-text-primary">Keyboard shortcuts</h3>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
              className="rounded-md p-1 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              aria-label="Close keyboard shortcuts"
            >
              <X size={13} />
            </button>
          </div>
          <dl className="mt-2 space-y-2 text-xs">
            {CHAT_NAVIGATION_SHORTCUTS.map((shortcut) => (
              <div key={shortcut.keys} className="flex items-start justify-between gap-3">
                <dt className="font-mono text-text-primary">{shortcut.keys}</dt>
                <dd className="text-right leading-4 text-text-secondary">{shortcut.action}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 border-t border-border/70 pt-2 text-xs leading-4 text-text-tertiary">
            App shortcuts are ignored while you type in a field.
          </p>
        </div>
      )}
    </div>
  );
}
