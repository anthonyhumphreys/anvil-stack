import { useEffect, useId, useState, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type {
  AutomationDefinition,
  AutomationRunStatus,
  ChatThreadAttentionState,
} from '../../../shared/types';
import {
  createOverviewModuleId,
  isSafeOverviewLinkTarget,
  OVERVIEW_MAX_LINKS,
  OVERVIEW_MAX_ROWS,
  OVERVIEW_MIN_ROWS,
  OVERVIEW_MODULES,
  OVERVIEW_WIDTHS,
  type OverviewActivityEventType,
  type OverviewFindingSource,
  type OverviewIdeaContentType,
  type OverviewModuleConfig,
  type OverviewModuleInstance,
  type OverviewModuleWidth,
  type OverviewPinnedLink,
  type OverviewPullRequestState,
  type OverviewScope,
  type OverviewSources,
} from '../../../shared/overview';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { Button, Dialog, IconButton, SegmentedControl } from '../ui';

const FIELD_CLASS =
  'w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/30';

const ROW_OPTIONS = [3, 4, 5, 6, 8, 10, 12, 15, 20, 25].filter(
  (rows) => rows >= OVERVIEW_MIN_ROWS && rows <= OVERVIEW_MAX_ROWS,
);

const EVENT_OPTIONS: Array<{ value: OverviewActivityEventType; label: string }> = [
  { value: 'pull-request', label: 'Pull requests' },
  { value: 'session', label: 'Sessions' },
  { value: 'automation', label: 'Automation runs' },
  { value: 'finding', label: 'Checks' },
  { value: 'note', label: 'Notes' },
];
const PR_STATE_OPTIONS: Array<{ value: OverviewPullRequestState; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'merged', label: 'Merged' },
  { value: 'closed', label: 'Closed, unmerged' },
];
const FINDING_SOURCE_OPTIONS: Array<{ value: OverviewFindingSource; label: string }> = [
  { value: 'security', label: 'Security audits' },
  { value: 'code-review', label: 'Code reviews' },
];
const IDEA_OPTIONS: Array<{ value: OverviewIdeaContentType; label: string }> = [
  { value: 'notes', label: 'Workspace notes' },
  { value: 'decisions', label: 'Decision records' },
];
const SESSION_OPTIONS: Array<{ value: ChatThreadAttentionState; label: string }> = [
  { value: 'working', label: 'Running' },
  { value: 'approval', label: 'Needs approval' },
  { value: 'input', label: 'Needs input' },
  { value: 'failed', label: 'Failed' },
  { value: 'complete', label: 'Finished' },
  { value: 'idle', label: 'Idle' },
];
const RUN_OPTIONS: Array<{ value: AutomationRunStatus; label: string }> = [
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'running', label: 'Running' },
  { value: 'queued', label: 'Queued' },
  { value: 'cancelled', label: 'Cancelled' },
];

interface OverviewModuleConfigDialogProps {
  module: OverviewModuleInstance | null;
  scope: OverviewScope;
  sources: OverviewSources | null;
  onClose: () => void;
  onApply: (patch: Pick<OverviewModuleInstance, 'title' | 'width' | 'rows' | 'config'>) => void;
}

export function OverviewModuleConfigDialog({
  module,
  scope,
  sources,
  onClose,
  onApply,
}: OverviewModuleConfigDialogProps) {
  return (
    <Dialog
      open={module !== null}
      onClose={onClose}
      size="xl"
      title={module ? `Configure ${OVERVIEW_MODULES[module.type].label.toLowerCase()}` : undefined}
      description={module ? OVERVIEW_MODULES[module.type].description : undefined}
    >
      {module && (
        <ConfigForm
          key={module.id}
          module={module}
          scope={scope}
          sources={sources}
          onClose={onClose}
          onApply={onApply}
        />
      )}
    </Dialog>
  );
}

function ConfigForm({
  module,
  scope,
  sources,
  onClose,
  onApply,
}: Omit<OverviewModuleConfigDialogProps, 'module'> & { module: OverviewModuleInstance }) {
  const { workspaces, repos } = useWorkspace();
  const definition = OVERVIEW_MODULES[module.type];
  const keys = new Set(definition.configKeys);
  const [title, setTitle] = useState(module.title ?? '');
  const [width, setWidth] = useState<OverviewModuleWidth>(module.width);
  const [rows, setRows] = useState(module.rows);
  const [config, setConfig] = useState<OverviewModuleConfig>(
    () => JSON.parse(JSON.stringify(module.config)) as OverviewModuleConfig,
  );
  const [automations, setAutomations] = useState<AutomationDefinition[]>([]);
  const set = <K extends keyof OverviewModuleConfig>(key: K, value: OverviewModuleConfig[K]) =>
    setConfig((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    if (!keys.has('automationIds') || scope.kind !== 'workspace') return;
    let cancelled = false;
    window.anvil.automations
      .list(scope.workspaceId)
      .then((list) => {
        if (!cancelled) setAutomations(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const links = config.links ?? [];
  const linkErrors = links.map((link) =>
    !link.label.trim()
      ? 'Add a label.'
      : !isSafeOverviewLinkTarget(link.target.trim())
        ? 'Use an in-app path such as /chat, or an http(s) address.'
        : null,
  );
  const invalid = linkErrors.some(Boolean);
  const optionalColumns = definition.columns.filter((column) => !column.required);
  const workspaceConnection =
    scope.kind === 'workspace' ? sources?.workspaceConnectionIds[scope.workspaceId] : undefined;
  const workspaceConnectionName = sources?.workItemConnections.find(
    (connection) => connection.id === workspaceConnection,
  )?.name;

  return (
    <form
      className="mt-5 space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (invalid) return;
        onApply({
          title: title.trim() || undefined,
          width,
          rows,
          config: {
            ...config,
            links: config.links?.map((link) => ({
              ...link,
              label: link.label.trim(),
              target: link.target.trim(),
            })),
          },
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <Labelled label="Display name">
          {(id) => (
            <input
              id={id}
              value={title}
              maxLength={60}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={definition.label}
              className={FIELD_CLASS}
              data-autofocus
            />
          )}
        </Labelled>
        <Labelled label="Rows">
          {(id) => (
            <select
              id={id}
              value={rows}
              onChange={(event) => setRows(Number(event.target.value))}
              className={FIELD_CLASS}
            >
              {ROW_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          )}
        </Labelled>
      </div>

      <Group label="Width">
        <SegmentedControl
          label="Width"
          value={width}
          onChange={setWidth}
          options={OVERVIEW_WIDTHS.map((option) => ({ value: option.value, label: option.label }))}
        />
      </Group>

      {keys.has('workspaceIds') && scope.kind === 'global' && workspaces.length > 1 && (
        <CheckboxGroup
          label="Workspaces"
          hint="None selected shows every workspace."
          options={workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))}
          value={config.workspaceIds ?? []}
          allowEmpty
          onChange={(value) => set('workspaceIds', value)}
        />
      )}

      {keys.has('repoIds') && scope.kind === 'workspace' && repos.length > 1 && (
        <CheckboxGroup
          label="Repositories"
          hint="None selected shows every repository in this workspace."
          options={repos.map((repo) => ({ value: repo.id, label: repo.name }))}
          value={config.repoIds ?? []}
          allowEmpty
          onChange={(value) => set('repoIds', value)}
        />
      )}

      {keys.has('eventTypes') && (
        <CheckboxGroup
          label="Event types"
          options={EVENT_OPTIONS}
          value={config.eventTypes ?? EVENT_OPTIONS.map((option) => option.value)}
          onChange={(value) => set('eventTypes', value)}
        />
      )}

      {keys.has('prStates') && (
        <CheckboxGroup
          label="States"
          hint="Merged and closed pull requests follow the time range; open ones always show."
          options={PR_STATE_OPTIONS}
          value={config.prStates ?? PR_STATE_OPTIONS.map((option) => option.value)}
          onChange={(value) => set('prStates', value)}
        />
      )}

      {keys.has('findingSources') && (
        <CheckboxGroup
          label="Sources"
          options={FINDING_SOURCE_OPTIONS}
          value={config.findingSources ?? FINDING_SOURCE_OPTIONS.map((option) => option.value)}
          onChange={(value) => set('findingSources', value)}
        />
      )}

      {keys.has('severity') && (
        <Group label="Severity">
          <SegmentedControl
            label="Severity"
            value={config.severity ?? 'medium'}
            onChange={(value) => set('severity', value)}
            options={[
              { value: 'high', label: 'High and above' },
              { value: 'medium', label: 'Medium and above' },
              { value: 'all', label: 'All' },
            ]}
          />
        </Group>
      )}

      {keys.has('findingStatus') && (
        <Group label="Review state">
          <SegmentedControl
            label="Review state"
            value={config.findingStatus ?? 'unlogged'}
            onChange={(value) => set('findingStatus', value)}
            options={[
              { value: 'unlogged', label: 'Not yet logged' },
              { value: 'all', label: 'Include logged' },
            ]}
          />
        </Group>
      )}

      {keys.has('connectionId') && (
        <Labelled
          label="Connection"
          hint="Uses the connection’s own permissions and team or project scope."
        >
          {(id) => (
            <select
              id={id}
              value={config.connectionId ?? ''}
              onChange={(event) => set('connectionId', event.target.value || undefined)}
              className={FIELD_CLASS}
            >
              {scope.kind === 'workspace' ? (
                <option value="">
                  {workspaceConnectionName
                    ? `This workspace’s connection (${workspaceConnectionName})`
                    : 'This workspace’s connection'}
                </option>
              ) : (
                <option value="" disabled>
                  Choose a connection
                </option>
              )}
              {(sources?.workItemConnections ?? []).map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name}
                </option>
              ))}
            </select>
          )}
        </Labelled>
      )}

      {keys.has('ticketState') && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Labelled label="State" hint="The source system’s own state name.">
            {(id) => (
              <input
                id={id}
                value={config.ticketState ?? ''}
                onChange={(event) => set('ticketState', event.target.value || undefined)}
                placeholder="Any state"
                className={FIELD_CLASS}
              />
            )}
          </Labelled>
          <Labelled label="Assignee">
            {(id) => (
              <input
                id={id}
                value={config.ticketAssignee ?? ''}
                onChange={(event) => set('ticketAssignee', event.target.value || undefined)}
                placeholder="Anyone"
                className={FIELD_CLASS}
              />
            )}
          </Labelled>
        </div>
      )}

      {keys.has('contentTypes') && (
        <CheckboxGroup
          label="Content"
          options={IDEA_OPTIONS}
          value={config.contentTypes ?? IDEA_OPTIONS.map((option) => option.value)}
          onChange={(value) => set('contentTypes', value)}
        />
      )}

      {keys.has('sessionStates') && (
        <CheckboxGroup
          label="Session states"
          hint="None selected shows every state."
          options={SESSION_OPTIONS}
          value={config.sessionStates ?? []}
          allowEmpty
          onChange={(value) => set('sessionStates', value)}
        />
      )}

      {keys.has('automationIds') && scope.kind === 'workspace' && automations.length > 1 && (
        <CheckboxGroup
          label="Automations"
          hint="None selected shows every automation."
          options={automations.map((automation) => ({
            value: automation.id,
            label: automation.name,
          }))}
          value={config.automationIds ?? []}
          allowEmpty
          onChange={(value) => set('automationIds', value)}
        />
      )}

      {keys.has('runOutcomes') && (
        <CheckboxGroup
          label="Outcomes"
          hint="None selected shows every outcome."
          options={RUN_OPTIONS}
          value={config.runOutcomes ?? []}
          allowEmpty
          onChange={(value) => set('runOutcomes', value)}
        />
      )}

      {keys.has('docsChange') && (
        <Group label="Show">
          <SegmentedControl
            label="Documentation pages"
            value={config.docsChange ?? 'all'}
            onChange={(value) => set('docsChange', value)}
            options={[
              { value: 'all', label: 'Changed or needs review' },
              { value: 'changed', label: 'Changed' },
              { value: 'needs-review', label: 'Needs review' },
            ]}
          />
        </Group>
      )}

      {keys.has('links') && (
        <Group label="Links">
          <ul className="space-y-2">
            {links.map((link, index) => (
              <li key={link.id}>
                <div className="flex items-start gap-2">
                  <input
                    aria-label={`Link ${index + 1} label`}
                    value={link.label}
                    maxLength={80}
                    onChange={(event) => updateLink(index, { label: event.target.value })}
                    placeholder="Label"
                    className={`${FIELD_CLASS} w-40 shrink-0`}
                  />
                  <input
                    aria-label={`Link ${index + 1} destination`}
                    aria-invalid={Boolean(linkErrors[index])}
                    value={link.target}
                    onChange={(event) => updateLink(index, { target: event.target.value })}
                    placeholder="/chat or https://…"
                    className={`${FIELD_CLASS} min-w-0 flex-1 font-mono text-xs`}
                  />
                  <IconButton
                    icon={Trash2}
                    label={`Remove link ${index + 1}`}
                    size="md"
                    className="mt-1"
                    onClick={() =>
                      set(
                        'links',
                        links.filter((_, position) => position !== index),
                      )
                    }
                  />
                </div>
                {linkErrors[index] && (link.label || link.target) && (
                  <p className="mt-1 text-xs text-error">{linkErrors[index]}</p>
                )}
              </li>
            ))}
          </ul>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            disabled={links.length >= OVERVIEW_MAX_LINKS}
            onClick={() =>
              set('links', [
                ...links,
                { id: createOverviewModuleId('pinned-links'), label: '', target: '' },
              ])
            }
          >
            <Plus size={12} aria-hidden="true" />
            Add link
          </Button>
        </Group>
      )}

      {keys.has('sort') && (
        <Labelled label="Sort">
          {(id) => (
            <select
              id={id}
              value={config.sort ?? definition.defaultConfig.sort ?? 'newest'}
              onChange={(event) => set('sort', event.target.value as OverviewModuleConfig['sort'])}
              className={`${FIELD_CLASS} sm:w-56`}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="name">Name</option>
            </select>
          )}
        </Labelled>
      )}

      {keys.has('columns') && optionalColumns.length > 0 && (
        <CheckboxGroup
          label="Columns"
          options={optionalColumns.map((column) => ({ value: column.id, label: column.label }))}
          value={config.columns ?? optionalColumns.map((column) => column.id)}
          allowEmpty
          onChange={(value) => set('columns', value)}
        />
      )}

      <div className="flex justify-end gap-2 border-t border-border-subtle pt-4">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={invalid}>
          Apply
        </Button>
      </div>
    </form>
  );

  function updateLink(index: number, patch: Partial<OverviewPinnedLink>) {
    set(
      'links',
      links.map((link, position) => (position === index ? { ...link, ...patch } : link)),
    );
  }
}

function Labelled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-text-secondary">
        {label}
      </label>
      {children(id)}
      {hint && <p className="mt-1 text-xs text-text-tertiary">{hint}</p>}
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-medium text-text-secondary">{label}</legend>
      {children}
    </fieldset>
  );
}

function CheckboxGroup<T extends string>({
  label,
  hint,
  options,
  value,
  allowEmpty = false,
  onChange,
}: {
  label: string;
  hint?: string;
  options: Array<{ value: T; label: string }>;
  value: T[];
  allowEmpty?: boolean;
  onChange: (value: T[]) => void;
}) {
  const selected = new Set(value);
  return (
    <fieldset>
      <legend className="mb-1.5 text-xs font-medium text-text-secondary">{label}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {options.map((option) => {
          const checked = selected.has(option.value);
          const lastChecked = checked && selected.size === 1 && !allowEmpty;
          return (
            <label
              key={option.value}
              className="inline-flex cursor-pointer items-center gap-2 text-sm text-text-secondary"
              title={lastChecked ? 'Keep at least one selected' : undefined}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={lastChecked}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? options
                          .map((entry) => entry.value)
                          .filter((entry) => entry === option.value || selected.has(entry))
                      : value.filter((entry) => entry !== option.value),
                  )
                }
                className="h-4 w-4 rounded border-border accent-[var(--color-accent)]"
              />
              {option.label}
            </label>
          );
        })}
      </div>
      {hint && <p className="mt-1.5 text-xs text-text-tertiary">{hint}</p>}
    </fieldset>
  );
}
