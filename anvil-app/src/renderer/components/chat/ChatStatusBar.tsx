import { useMemo } from 'react';
import { FileText, ListChecks, Loader2, Sparkles, Target, Terminal, Wrench } from 'lucide-react';
import type { CodexEvent } from '../../../shared/types';

interface ChatStatusBarProps {
  events: CodexEvent[];
  isBusy: boolean;
}

export function ChatStatusBar({ events, isBusy }: ChatStatusBarProps) {
  const activity = useMemo(() => summarizeActivity(events), [events]);
  const visiblePills = useMemo(() => getVisibleActivityPills(activity), [activity]);

  if (!isBusy) return null;

  const latestActivity = activity.latest;
  const activityAnnouncement = getActivityAnnouncement(latestActivity);

  return (
    <div
      className="border-t border-border/40 bg-bg-secondary/70"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="flex items-center gap-2.5 px-4 py-2">
        <div className="relative flex h-5 w-5 shrink-0 items-center justify-center">
          <Loader2 size={14} className="animate-spin text-accent" />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 text-xs text-text-tertiary">
          {latestActivity ? (
            <>
              {latestActivity.icon}
              <span className="truncate font-medium text-text-secondary">
                {latestActivity.label}
              </span>
            </>
          ) : (
            <>
              <Sparkles size={10} />
              <span className="font-medium text-text-secondary">Processing...</span>
            </>
          )}
          <span className="sr-only">{activityAnnouncement}</span>
        </div>

        {visiblePills.length > 0 && (
          <span className="hidden shrink-0 text-[11px] text-text-tertiary sm:inline">
            {visiblePills.map((pill) => `${pill.value} ${pill.label.toLowerCase()}`).join(' · ')}
          </span>
        )}
      </div>
    </div>
  );
}

interface ActivityInfo {
  label: string;
  icon: React.ReactNode;
}

interface ActivitySummary {
  latest: ActivityInfo | null;
  recent: ActivityInfo[];
  files: number;
  edits: number;
  commands: number;
  tools: number;
}

export function summarizeActivity(events: CodexEvent[]): ActivitySummary {
  const all = events.map(getActivityInfo).filter((item): item is ActivityInfo => Boolean(item));
  return {
    latest: all.at(-1) ?? null,
    recent: all.slice(-3).reverse(),
    files: events.filter((event) => event.type === 'file_read').length,
    edits: events.filter((event) => event.type === 'file_edit').length,
    commands: events.filter((event) => event.type === 'command_exec').length,
    tools: events.filter((event) => event.type === 'tool_call').length,
  };
}

export function getVisibleActivityPills(
  activity: ActivitySummary,
): Array<{ label: string; value: number; tone: 'info' | 'success' | 'warning' | 'muted' }> {
  return [
    { label: 'Files', value: activity.files, tone: 'info' as const },
    { label: 'Edits', value: activity.edits, tone: 'success' as const },
    { label: 'Commands', value: activity.commands, tone: 'warning' as const },
    { label: 'Tools', value: activity.tools, tone: 'muted' as const },
  ].filter((pill) => pill.value > 0);
}

export function getActivityAnnouncement(latestActivity: ActivityInfo | null): string {
  return latestActivity ? latestActivity.label : 'Processing';
}

function getActivityInfo(event: CodexEvent): ActivityInfo | null {
  switch (event.type) {
    case 'thinking':
      return { label: 'Thinking...', icon: <Sparkles size={10} className="text-warning" /> };
    case 'file_read':
      return {
        label: `Reading ${event.filePath ?? 'file'}`,
        icon: <FileText size={10} className="text-info" />,
      };
    case 'file_edit':
      return {
        label: `Editing ${event.filePath ?? 'file'}`,
        icon: <FileText size={10} className="text-success" />,
      };
    case 'command_exec':
      return {
        label: `Running ${event.command ?? 'command'}`,
        icon: <Terminal size={10} className="text-warning" />,
      };
    case 'tool_call':
      return {
        label: `Using ${event.toolName ?? 'tool'}`,
        icon: <Wrench size={10} className="text-text-tertiary" />,
      };
    case 'plan_update':
      return {
        label: 'Updating plan',
        icon: <ListChecks size={10} className="text-info" />,
      };
    case 'goal_update':
    case 'goal_cleared':
      return {
        label: 'Updating goal',
        icon: <Target size={10} className="text-success" />,
      };
    case 'status':
      if (event.status === 'thinking') {
        return { label: 'Thinking...', icon: <Sparkles size={10} className="text-warning" /> };
      }
      if (event.status === 'executing') {
        return {
          label: 'Executing...',
          icon: <Loader2 size={10} className="animate-spin text-text-tertiary" />,
        };
      }
      break;
  }

  return null;
}
