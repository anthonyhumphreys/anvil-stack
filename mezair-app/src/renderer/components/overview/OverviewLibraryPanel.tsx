import { useMemo, useState } from 'react';
import {
  Activity,
  BookOpen,
  Bot,
  ChevronDown,
  FolderGit2,
  GitPullRequest,
  Layers,
  Lightbulb,
  Link2,
  MessageSquare,
  Search,
  ShieldAlert,
  TicketCheck,
  type LucideIcon,
} from 'lucide-react';
import {
  moduleAllowedInScope,
  moduleTitle,
  OVERVIEW_MAX_MODULES,
  OVERVIEW_MODULE_ORDER,
  OVERVIEW_MODULES,
  sourceAvailable,
  type OverviewModuleType,
} from '../../../shared/overview';
import { SettingsLink } from '../shared/SettingsLink';
import { Button, cx } from '../ui';
import type { OverviewBoardController } from './useOverviewBoard';
import { LIBRARY_DRAG_TYPE } from './OverviewModulePanel';

export const MODULE_ICONS: Record<OverviewModuleType, LucideIcon> = {
  activity: Activity,
  'pull-requests': GitPullRequest,
  findings: ShieldAlert,
  workspaces: Layers,
  repositories: FolderGit2,
  tickets: TicketCheck,
  ideas: Lightbulb,
  sessions: MessageSquare,
  'automation-runs': Bot,
  documentation: BookOpen,
  'pinned-links': Link2,
};

const SETUP_TARGET = { tickets: 'delivery#work-items', docs: 'delivery#docs' } as const;

export function OverviewLibraryPanel({
  board,
  onAdd,
  onFocusModule,
}: {
  board: OverviewBoardController;
  onAdd: (type: OverviewModuleType) => void;
  onFocusModule: (moduleId: string) => void;
}) {
  const [query, setQuery] = useState('');
  // Below `lg` the library collapses so the board keeps most of the window.
  const [narrowOpen, setNarrowOpen] = useState(false);
  const modules = board.layout?.modules ?? [];
  const full = modules.length >= OVERVIEW_MAX_MODULES;

  const { available, needsConnection } = useMemo(() => {
    const term = query.trim().toLowerCase();
    const matches = (type: OverviewModuleType) => {
      const definition = OVERVIEW_MODULES[type];
      return !term || `${definition.label} ${definition.description}`.toLowerCase().includes(term);
    };
    const relevant = OVERVIEW_MODULE_ORDER.filter(
      (type) =>
        moduleAllowedInScope(type, board.scope) &&
        (!board.features ||
          !OVERVIEW_MODULES[type].features ||
          OVERVIEW_MODULES[type].features!.some((feature) => board.features!.has(feature))) &&
        matches(type),
    );
    const sources = board.sources;
    return {
      available: relevant.filter(
        (type) =>
          !sources || sourceAvailable(OVERVIEW_MODULES[type].requires, board.scope, sources),
      ),
      needsConnection: sources
        ? relevant.filter(
            (type) => !sourceAvailable(OVERVIEW_MODULES[type].requires, board.scope, sources),
          )
        : [],
    };
  }, [board.features, board.scope, board.sources, query]);

  const ticketSetup =
    board.scope.kind === 'workspace' && (board.sources?.workItemConnections.length ?? 0) > 0
      ? 'workspace#connections'
      : SETUP_TARGET.tickets;

  return (
    <aside
      aria-label="Add modules"
      className="flex min-h-0 flex-col border-border bg-bg-secondary/40 lg:w-80 lg:shrink-0 lg:border-l"
    >
      <div className="shrink-0 border-border px-4 pb-3 pt-4 max-lg:border-t max-lg:pt-3">
        <h2 className="text-sm font-semibold text-text-primary">
          <button
            type="button"
            onClick={() => setNarrowOpen((value) => !value)}
            aria-expanded={narrowOpen}
            className="flex w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 lg:pointer-events-none"
          >
            Add modules
            <ChevronDown
              size={14}
              aria-hidden="true"
              className={cx(
                'text-text-tertiary transition-transform lg:hidden',
                narrowOpen && 'rotate-180',
              )}
            />
          </button>
        </h2>
        <label className={cx('relative mt-3 block', !narrowOpen && 'max-lg:hidden')}>
          <span className="sr-only">Find a module</span>
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a module"
            className="w-full rounded-xl border border-border bg-bg-primary py-2 pl-8 pr-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
          />
        </label>
      </div>

      <div
        className={cx(
          'min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-5 max-lg:max-h-72',
          !narrowOpen && 'max-lg:hidden',
        )}
      >
        <section aria-labelledby="overview-library-available">
          <h3
            id="overview-library-available"
            className="mb-2 text-xs font-medium text-text-tertiary"
          >
            Available
          </h3>
          {available.length === 0 ? (
            <p className="text-xs text-text-tertiary">No modules match “{query}”.</p>
          ) : (
            <ul className="divide-y divide-border-subtle overflow-hidden rounded-lg border border-border-subtle">
              {available.map((type) => {
                const Icon = MODULE_ICONS[type];
                const definition = OVERVIEW_MODULES[type];
                return (
                  <li
                    key={type}
                    draggable={!full}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(LIBRARY_DRAG_TYPE, type);
                      event.dataTransfer.effectAllowed = 'copy';
                    }}
                    className={cx('flex items-center gap-3 px-3 py-2.5', !full && 'cursor-grab')}
                  >
                    <Icon size={16} className="shrink-0 text-text-tertiary" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text-primary">
                        {definition.label}
                      </span>
                      <span className="line-clamp-2 block text-xs text-text-tertiary">
                        {definition.description}
                      </span>
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={full}
                      onClick={() => onAdd(type)}
                      aria-label={`Add ${definition.label}`}
                    >
                      Add
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {full && (
            <p className="mt-2 text-xs text-text-tertiary">
              This overview has the maximum of {OVERVIEW_MAX_MODULES} modules. Remove one to add
              another.
            </p>
          )}
        </section>

        {modules.length > 0 && (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md text-xs font-medium text-text-tertiary hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 [&::-webkit-details-marker]:hidden">
              <ChevronDown
                size={12}
                aria-hidden="true"
                className="-rotate-90 transition-transform group-open:rotate-0"
              />
              On this overview ({modules.length})
            </summary>
            <ul className="mt-2 divide-y divide-border-subtle overflow-hidden rounded-lg border border-border-subtle">
              {modules.map((module) => {
                const Icon = MODULE_ICONS[module.type];
                return (
                  <li key={module.id}>
                    <button
                      type="button"
                      onClick={() => onFocusModule(module.id)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-bg-tertiary/50 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
                    >
                      <Icon size={15} className="shrink-0 text-text-tertiary" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{moduleTitle(module)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </details>
        )}

        {needsConnection.length > 0 && (
          <section aria-labelledby="overview-library-connection">
            <h3
              id="overview-library-connection"
              className="mb-2 text-xs font-medium text-text-tertiary"
            >
              Requires a connection
            </h3>
            <ul className="divide-y divide-border-subtle overflow-hidden rounded-lg border border-border-subtle">
              {needsConnection.map((type) => {
                const Icon = MODULE_ICONS[type];
                const definition = OVERVIEW_MODULES[type];
                const requirement = definition.requires!;
                return (
                  <li key={type} className="flex items-center gap-3 px-3 py-2.5">
                    <Icon size={16} className="shrink-0 text-text-tertiary" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text-primary">
                        {definition.label}
                      </span>
                      <span className="block text-xs text-text-tertiary">
                        {requirement === 'docs'
                          ? 'Connect documentation in Settings.'
                          : board.scope.kind === 'workspace' &&
                              ticketSetup === 'workspace#connections'
                            ? 'Choose a ticketing connection for this workspace.'
                            : 'Connect a ticketing system in Settings.'}
                      </span>
                    </span>
                    <SettingsLink
                      to={requirement === 'docs' ? SETUP_TARGET.docs : ticketSetup}
                      className="text-sm"
                    >
                      Set up
                    </SettingsLink>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <p className="text-xs text-text-tertiary">
          Available modules depend on workspace setup and your role. Removing a module only hides
          it; it never deletes records or disconnects a source.
        </p>
      </div>
    </aside>
  );
}
