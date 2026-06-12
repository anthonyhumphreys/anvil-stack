import { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  ListChecks,
  Loader2,
  Sparkles,
  Target,
  Terminal,
  Wrench,
} from 'lucide-react';
import type { CodexEvent } from '../../../shared/types';

interface ChatStatusBarProps {
  events: CodexEvent[];
  isBusy: boolean;
}

export function ChatStatusBar({ events, isBusy }: ChatStatusBarProps) {
  const [expanded, setExpanded] = useState(false);
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
      <div className="flex items-center gap-3 px-4 py-2.5">
        <div className="relative flex h-5 w-5 shrink-0 items-center justify-center">
          <Loader2 size={14} className="animate-spin text-accent" />
          <div className="absolute inset-0 animate-ping rounded-full bg-accent/10 opacity-30" />
        </div>
        <button
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-text-tertiary transition-colors hover:text-text-secondary"
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide chat activity details' : 'Show chat activity details'}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
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
        </button>

        {visiblePills.length > 0 && (
          <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
            {visiblePills.map((pill) => (
              <ActivityPill key={pill.label} {...pill} />
            ))}
          </div>
        )}
      </div>

      {expanded && activity.recent.length > 0 && (
        <div className="border-t border-border/30 px-4 py-2">
          <div className="grid gap-1.5 sm:grid-cols-3">
            {activity.recent.map((item, index) => (
              <div
                key={`${item.label}-${index}`}
                className="flex min-w-0 items-center gap-2 rounded-lg border border-border-subtle bg-bg-primary/60 px-2.5 py-2 text-xs"
              >
                {item.icon}
                <span className="truncate text-text-secondary">{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
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

function ActivityPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'info' | 'success' | 'warning' | 'muted';
}) {
  const className =
    tone === 'info'
      ? 'border-info/25 bg-info/10 text-info'
      : tone === 'success'
        ? 'border-success/25 bg-success/10 text-success'
        : tone === 'warning'
          ? 'border-warning/25 bg-warning/10 text-warning'
          : 'border-border-subtle bg-bg-primary text-text-tertiary';

  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${className}`}>
      {label} {value}
    </span>
  );
}
