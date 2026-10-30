import { useId, type DragEvent, type KeyboardEvent } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  GripVertical,
  MoreHorizontal,
  PlugZap,
  RefreshCw,
  Settings2,
  Trash2,
  Unplug,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  moduleTitle,
  OVERVIEW_MODULES,
  OVERVIEW_WIDTHS,
  timeRangeLabel,
  type OverviewModuleInstance,
  type OverviewModuleType,
  type OverviewModuleWidth,
  type OverviewScope,
  type OverviewTarget,
  type OverviewTimeRange,
} from '../../../shared/overview';
import { SettingsLink } from '../shared/SettingsLink';
import { Button, IconButton, Menu, MenuItem, MenuLabel, MenuSeparator, cx } from '../ui';
import { OverviewModuleContent } from './OverviewModuleContent';
import { formatFreshness, WIDTH_SPAN_CLASSES } from './overview-format';
import { useOverviewModuleData } from './useOverviewModuleData';

export const MODULE_DRAG_TYPE = 'application/x-mezair-overview-module';
export const LIBRARY_DRAG_TYPE = 'application/x-mezair-overview-library';

interface OverviewModulePanelProps {
  module: OverviewModuleInstance;
  index: number;
  count: number;
  scope: OverviewScope;
  timeRange: OverviewTimeRange;
  refreshToken: number;
  now: number;
  editing: boolean;
  /** Insertion marker while something is dragged over this module. */
  dropSide: 'before' | 'after' | null;
  onOpen: (target: OverviewTarget) => void;
  onConfigure: () => void;
  onMove: (toIndex: number) => void;
  onResize: (width: OverviewModuleWidth) => void;
  onRemove: () => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}

export function OverviewModulePanel({
  module,
  index,
  count,
  scope,
  timeRange,
  refreshToken,
  now,
  editing,
  dropSide,
  onOpen,
  onConfigure,
  onMove,
  onResize,
  onRemove,
  onDragEnd,
  onDragOver,
  onDrop,
}: OverviewModulePanelProps) {
  const navigate = useNavigate();
  const headingId = useId();
  const definition = OVERVIEW_MODULES[module.type];
  const title = moduleTitle(module);
  const data = useOverviewModuleData(scope, module, timeRange, refreshToken);
  const result = data.result;
  const freshness = formatFreshness(result?.observedAt, now);
  const widthLabel = OVERVIEW_WIDTHS.find((width) => width.value === module.width)?.label;

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const moves: Record<string, number> = {
      ArrowUp: index - 1,
      ArrowLeft: index - 1,
      ArrowDown: index + 1,
      ArrowRight: index + 1,
      Home: 0,
      End: count - 1,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const target = Math.max(0, Math.min(count - 1, moves[event.key]));
    if (target !== index) onMove(target);
  };

  const meta = [result?.source, freshness].filter(Boolean).join(' · ');

  return (
    <section
      aria-labelledby={headingId}
      data-overview-module={module.id}
      draggable={editing}
      onDragStart={(event) => {
        if (!editing) return;
        event.dataTransfer.setData(MODULE_DRAG_TYPE, module.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cx(
        'relative flex min-w-0 flex-col rounded-xl border bg-bg-secondary/55',
        WIDTH_SPAN_CLASSES[module.width],
        editing ? 'border-border' : 'border-border-subtle',
      )}
    >
      {dropSide && (
        <span
          aria-hidden="true"
          className={cx(
            'pointer-events-none absolute -bottom-px -top-px w-1 rounded-full bg-accent',
            dropSide === 'before' ? '-left-2.5' : '-right-2.5',
          )}
        />
      )}
      <header className="flex min-w-0 items-center gap-2 px-4 pb-2 pt-3">
        {editing && (
          <button
            type="button"
            onKeyDown={handleKeyDown}
            className="-ml-1.5 cursor-grab rounded-md p-1 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 active:cursor-grabbing"
            aria-label={`Reorder ${title}, position ${index + 1} of ${count}. Use arrow keys to move.`}
            title="Drag, or focus and use arrow keys"
          >
            <GripVertical size={15} aria-hidden="true" />
          </button>
        )}
        <h2
          id={headingId}
          className="min-w-[4.5rem] shrink truncate text-sm font-semibold text-text-primary"
        >
          {title}
        </h2>
        {meta && !editing && (
          <span className="min-w-0 shrink-[6] truncate text-xs text-text-tertiary" title={meta}>
            {meta}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {definition.timeScoped && !editing && (
            <span className="hidden whitespace-nowrap text-xs text-text-tertiary @xl:inline">
              {timeRangeLabel(timeRange)}
            </span>
          )}
          {editing && widthLabel && (
            <span className="whitespace-nowrap text-xs text-text-tertiary">{widthLabel}</span>
          )}
          {data.refreshing && result && (
            <RefreshCw
              size={12}
              className="text-text-tertiary motion-safe:animate-spin"
              aria-label="Refreshing"
            />
          )}
          <Menu
            label={`${title} actions`}
            trigger={(props) => (
              <IconButton {...props} icon={MoreHorizontal} label={`${title} actions`} size="md" />
            )}
          >
            {!editing && (
              <MenuItem icon={<RefreshCw size={14} aria-hidden="true" />} onSelect={data.refresh}>
                Refresh
              </MenuItem>
            )}
            <MenuItem icon={<Settings2 size={14} aria-hidden="true" />} onSelect={onConfigure}>
              Configure…
            </MenuItem>
            {!editing && result?.viewAllRoute && (
              <MenuItem
                icon={<ArrowRight size={14} aria-hidden="true" />}
                onSelect={() => navigate(result.viewAllRoute!)}
              >
                Open full view
              </MenuItem>
            )}
            {editing && (
              <>
                <MenuItem
                  icon={<ArrowUp size={14} aria-hidden="true" />}
                  disabled={index === 0}
                  onSelect={() => onMove(index - 1)}
                >
                  Move up
                </MenuItem>
                <MenuItem
                  icon={<ArrowDown size={14} aria-hidden="true" />}
                  disabled={index === count - 1}
                  onSelect={() => onMove(index + 1)}
                >
                  Move down
                </MenuItem>
                <MenuSeparator />
                <MenuLabel>Width</MenuLabel>
                {OVERVIEW_WIDTHS.map((width) => (
                  <MenuItem
                    key={width.value}
                    icon={
                      <Check
                        size={14}
                        aria-hidden="true"
                        className={module.width === width.value ? 'opacity-100' : 'opacity-0'}
                      />
                    }
                    onSelect={() => onResize(width.value)}
                  >
                    <span className="sr-only">
                      {module.width === width.value ? 'Current width: ' : ''}
                    </span>
                    {width.label}
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem
                  destructive
                  icon={<Trash2 size={14} aria-hidden="true" />}
                  onSelect={onRemove}
                >
                  Remove from overview
                </MenuItem>
              </>
            )}
          </Menu>
        </span>
      </header>

      <div className="min-h-0 flex-1 pb-2">
        <PanelBody
          data={data}
          module={module}
          scope={scope}
          now={now}
          timeRange={timeRange}
          onOpen={onOpen}
          onConfigure={onConfigure}
        />
      </div>

      {result && result.state !== 'needs-setup' && result.total > result.rows.length && (
        <footer className="border-t border-border-subtle px-4 py-2 text-xs text-text-tertiary">
          {result.viewAllRoute ? (
            <button
              type="button"
              onClick={() => navigate(result.viewAllRoute!)}
              className="font-medium text-text-secondary underline-offset-2 hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              Showing {result.rows.length} of {result.total} · Open full view
            </button>
          ) : (
            <span>
              Showing {result.rows.length} of {result.total}. Show more rows in Configure.
            </span>
          )}
        </footer>
      )}
    </section>
  );
}

function PanelBody({
  data,
  module,
  scope,
  now,
  timeRange,
  onOpen,
  onConfigure,
}: {
  data: ReturnType<typeof useOverviewModuleData>;
  module: OverviewModuleInstance;
  scope: OverviewScope;
  now: number;
  timeRange: OverviewTimeRange;
  onOpen: (target: OverviewTarget) => void;
  onConfigure: () => void;
}) {
  const { result } = data;

  if (data.loading) {
    return (
      <div className="space-y-2 px-4 pt-1" aria-busy="true" aria-label="Loading">
        {Array.from({ length: Math.min(module.rows, 4) }, (_, index) => (
          <div
            key={index}
            className="h-6 rounded-md bg-bg-tertiary/60 motion-safe:animate-pulse"
            style={{ width: `${92 - index * 9}%` }}
          />
        ))}
      </div>
    );
  }

  if (!result) {
    return (
      <PanelMessage
        icon={Unplug}
        title="Couldn’t load this module"
        detail={data.error ?? undefined}
        action={
          <Button variant="secondary" size="sm" onClick={data.refresh}>
            Try again
          </Button>
        }
      />
    );
  }

  if (result.state === 'needs-setup') {
    return (
      <PanelMessage
        icon={PlugZap}
        title="Needs a connection"
        detail={result.message}
        action={
          result.setupTarget && (
            <SettingsLink to={result.setupTarget} className="text-sm">
              Set up
            </SettingsLink>
          )
        }
      />
    );
  }

  const disconnected = result.state === 'disconnected';
  const lastSuccess = formatFreshness(result.lastSuccessAt, now);

  return (
    <>
      {(disconnected || result.message) && (
        <div
          role={disconnected ? 'alert' : 'status'}
          className={cx(
            'mx-4 mb-2 rounded-lg border px-3 py-2 text-xs leading-relaxed',
            disconnected
              ? 'border-warning/30 bg-warning/5 text-text-secondary'
              : 'border-border-subtle bg-bg-primary/40 text-text-tertiary',
          )}
        >
          <p className="min-w-0">
            {disconnected && (
              <span className="font-medium text-text-primary">
                Couldn’t refresh {result.source}.{' '}
              </span>
            )}
            {result.message}
            {disconnected &&
              (lastSuccess
                ? ` Showing the last successful update (${lastSuccess.replace('Updated ', '')}).`
                : ' No earlier results are available.')}
          </p>
          {(disconnected || result.setupTarget) && (
            <span className="mt-1.5 flex items-center gap-4">
              <button
                type="button"
                onClick={data.refresh}
                className="font-medium text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                Retry
              </button>
              {result.setupTarget && <SettingsLink to={result.setupTarget}>Reconnect</SettingsLink>}
            </span>
          )}
        </div>
      )}
      {result.rows.length === 0 && disconnected ? null : result.rows.length === 0 ? (
        <EmptyResult
          type={module.type}
          reason={result.emptyReason}
          timeScoped={OVERVIEW_MODULES[module.type].timeScoped}
          timeRange={timeRange}
          isLinks={module.type === 'pinned-links'}
          hideDetail={Boolean(result.message) && result.emptyReason === 'no-sources'}
          onConfigure={onConfigure}
        />
      ) : (
        <OverviewModuleContent
          module={module}
          result={result}
          scope={scope}
          now={now}
          onOpen={onOpen}
        />
      )}
    </>
  );
}

const EMPTY_COPY: Partial<Record<OverviewModuleType, { title: string; detail: string }>> = {
  findings: {
    title: 'No findings to review',
    detail: 'Unlogged findings from the latest security audits and code reviews appear here.',
  },
  'pull-requests': {
    title: 'No pull requests to show',
    detail: 'No open pull requests match, and none were merged or closed in this time range.',
  },
  tickets: {
    title: 'No matching tickets',
    detail: 'Nothing in this connection matches the module’s filters.',
  },
  ideas: {
    title: 'No open ideas or decisions',
    detail: 'Workspace notes and decision records in your repositories appear here.',
  },
  repositories: {
    title: 'No repositories yet',
    detail: 'Add a repository from the Repositories tab.',
  },
};

function EmptyResult({
  type,
  reason,
  timeScoped,
  timeRange,
  isLinks,
  hideDetail,
  onConfigure,
}: {
  type: OverviewModuleType;
  reason?: 'no-matches' | 'no-recent-activity' | 'no-sources';
  timeScoped: boolean;
  timeRange: OverviewTimeRange;
  isLinks: boolean;
  hideDetail: boolean;
  onConfigure: () => void;
}) {
  if (isLinks) {
    return (
      <PanelMessage
        title="No links yet"
        detail="Add the destinations you open most."
        action={
          <Button variant="secondary" size="sm" onClick={onConfigure}>
            Add links
          </Button>
        }
      />
    );
  }
  if (reason === 'no-sources') {
    return (
      <PanelMessage
        title="Nothing to show here"
        detail={hideDetail ? undefined : 'No sources are connected for this scope.'}
      />
    );
  }
  const copy = EMPTY_COPY[type];
  if (copy && reason !== 'no-recent-activity') {
    return <PanelMessage title={copy.title} detail={copy.detail} />;
  }
  if (reason === 'no-recent-activity' && timeScoped) {
    return (
      <PanelMessage
        title={`No activity in the ${timeRangeLabel(timeRange).toLowerCase()}`}
        detail="Widen the time range to see older history."
      />
    );
  }
  return (
    <PanelMessage
      title="No matching results"
      detail="Nothing matches this module’s filters right now."
      action={
        <Button variant="ghost" size="sm" onClick={onConfigure}>
          Adjust filters
        </Button>
      }
    />
  );
}

function PanelMessage({
  icon: Icon,
  title,
  detail,
  action,
}: {
  icon?: typeof PlugZap;
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      {Icon && <Icon size={16} className="mt-0.5 shrink-0 text-text-tertiary" aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-secondary">{title}</p>
        {detail && (
          <p className="mt-0.5 max-w-[60ch] text-xs leading-relaxed text-text-tertiary">{detail}</p>
        )}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  );
}
