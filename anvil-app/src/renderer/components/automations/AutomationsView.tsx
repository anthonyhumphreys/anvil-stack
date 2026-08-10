import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  GitBranch,
  Loader2,
  Play,
  RadioTower,
  RefreshCw,
  Save,
  Trash2,
  Wrench,
  Workflow,
} from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type {
  AutomationDaemonStatus,
  AutomationDefinition,
  AutomationDefinitionInput,
  AutomationLoopConfig,
  AutomationRun,
  AutomationRunEvent,
  AutomationTriageItem,
  CodexEvent,
  Persona,
  WatchtowerEventType,
} from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useStoredPanelState } from '../../hooks/useStoredPanelState';
import { ActivityGroupMessage, ChatEventRenderer } from '../chat/ChatMessage';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';
import {
  buildAutomationDisplayEntries,
  type AutomationDisplayEntry,
} from '../../utils/automation-run-events';

const DEFAULT_CRON = '0 9 * * 1-5';

const DEFAULT_LOOP_CONFIG: AutomationLoopConfig = {
  enabled: false,
  mode: 'sequence',
  memberPersonaIds: ['coder', 'reviewer'],
  separateThreads: true,
  maxIterations: 4,
  stopCondition:
    'Stop when the work is complete, blocked, reviewed cleanly, or ready for human approval.',
};

type AutomationRunDetailTab = 'transcript' | 'activity' | 'worktrees' | 'raw';

const RUN_DETAIL_TABS: Array<{ id: AutomationRunDetailTab; label: string }> = [
  { id: 'transcript', label: 'Transcript' },
  { id: 'activity', label: 'Activity' },
  { id: 'worktrees', label: 'Worktrees' },
  { id: 'raw', label: 'Raw Events' },
];

function emptyDraft(repoIds: string[]): AutomationDefinitionInput {
  return {
    name: '',
    personaId: 'coder',
    prompt: '',
    repoIds,
    triggerMode: 'schedule',
    watchEvent: 'workflow.completed',
    watchTarget: repoIds[0] ? { repoId: repoIds[0] } : undefined,
    scheduleCron: DEFAULT_CRON,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    enabled: true,
    allowRepoWrite: true,
    allowCommandRun: true,
    loopConfig: DEFAULT_LOOP_CONFIG,
  };
}

function automationToDraft(automation: AutomationDefinition): AutomationDefinitionInput {
  return {
    name: automation.name,
    personaId: automation.personaId,
    prompt: automation.prompt,
    repoIds: automation.repoIds,
    triggerMode: automation.triggerMode,
    watchEvent: automation.watchEvent ?? 'workflow.completed',
    watchTarget: automation.watchTarget,
    scheduleCron: automation.scheduleCron,
    timezone: automation.timezone,
    enabled: automation.enabled,
    allowRepoWrite: automation.allowRepoWrite,
    allowCommandRun: automation.allowCommandRun,
    loopConfig: automation.loopConfig ?? DEFAULT_LOOP_CONFIG,
  };
}

function statusTone(status?: string): string {
  switch (status) {
    case 'completed':
      return 'text-success';
    case 'failed':
      return 'text-error';
    case 'running':
    case 'queued':
      return 'text-accent';
    default:
      return 'text-text-secondary';
  }
}

function formatTimestamp(value?: string): string {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function isLoopAutomation(automation: AutomationDefinition): boolean {
  return automation.loopConfig?.enabled === true;
}

function watchEventLabel(event: AutomationDefinition['watchEvent']): string {
  const labels: Record<WatchtowerEventType, string> = {
    'workflow.completed': 'Workflow completed',
    'workflow.failed': 'Workflow failed',
    'pull_request.merged': 'Pull request merged',
    'pull_request.closed': 'Pull request closed',
    'pipeline.completed': 'Pipeline completed',
    'pipeline.failed': 'Pipeline failed',
  };
  return event ? labels[event] : 'Choose an event';
}

function isPullRequestWatch(event: WatchtowerEventType | undefined): boolean {
  return event === 'pull_request.merged' || event === 'pull_request.closed';
}

function isPipelineWatch(event: WatchtowerEventType | undefined): boolean {
  return event === 'pipeline.completed' || event === 'pipeline.failed';
}

function isExternalWatch(event: WatchtowerEventType | undefined): boolean {
  return isPullRequestWatch(event) || isPipelineWatch(event);
}

function runTriggerLabel(trigger: AutomationRun['trigger']): string {
  if (trigger === 'manual') return 'Manual';
  if (trigger === 'watchtower') return 'Watchtower';
  return 'Scheduled';
}

export function AutomationsView() {
  const navigate = useNavigate();
  const [initialSearchParams, setSearchParams] = useSearchParams();
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace?.id;
  const repos = activeWorkspace?.repos ?? [];

  const [personas, setPersonas] = useState<Persona[]>([]);
  const [automations, setAutomations] = useState<AutomationDefinition[]>([]);
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(() =>
    initialSearchParams.get('automation'),
  );
  const [draft, setDraft] = useState<AutomationDefinitionInput>(() => emptyDraft([]));
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [triageItems, setTriageItems] = useState<AutomationTriageItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() =>
    initialSearchParams.get('run'),
  );
  const [runEvents, setRunEvents] = useState<AutomationRunEvent[]>([]);
  const [runDetailTab, setRunDetailTab] = useState<AutomationRunDetailTab>('transcript');
  const [daemonStatus, setDaemonStatus] = useState<AutomationDaemonStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { collapsed: automationsCollapsed, toggleCollapsed: toggleAutomationsCollapsed } =
    useStoredPanelState({
      storageKey: 'layout:automations-saved-panel',
      defaultWidth: 280,
      minWidth: 240,
      maxWidth: 360,
      defaultCollapsed: false,
    });

  const selectedAutomation = useMemo(
    () => automations.find((automation) => automation.id === selectedAutomationId) ?? null,
    [automations, selectedAutomationId],
  );
  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );
  const displayEntries = useMemo(() => buildAutomationDisplayEntries(runEvents), [runEvents]);

  const loadRuns = useCallback(
    async (automationId: string | null) => {
      if (!automationId) {
        setRuns([]);
        setSelectedRunId(null);
        setRunEvents([]);
        return;
      }

      const nextRuns = await window.anvil.automations.listRuns(automationId);
      setRuns(nextRuns);
      const fallbackRunId =
        selectedRunId && nextRuns.some((run) => run.id === selectedRunId)
          ? selectedRunId
          : (nextRuns[0]?.id ?? null);
      setSelectedRunId(fallbackRunId);
    },
    [selectedRunId],
  );

  const loadEvents = useCallback(async (runId: string | null) => {
    if (!runId) {
      setRunEvents([]);
      return;
    }
    const nextEvents = await window.anvil.automations.listRunEvents(runId);
    setRunEvents(nextEvents);
  }, []);

  const loadData = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const [nextAutomations, nextPersonas, nextDaemonStatus, nextTriageItems] = await Promise.all([
        window.anvil.automations.list(workspaceId),
        window.anvil.chat.getPersonas(),
        window.anvil.automations.getDaemonStatus(),
        window.anvil.automations.triage(workspaceId),
      ]);

      setAutomations(nextAutomations);
      setPersonas(nextPersonas);
      setDaemonStatus(nextDaemonStatus);
      setTriageItems(nextTriageItems);

      const nextSelectedAutomationId =
        selectedAutomationId &&
        nextAutomations.some((automation) => automation.id === selectedAutomationId)
          ? selectedAutomationId
          : (nextAutomations[0]?.id ?? null);
      setSelectedAutomationId(nextSelectedAutomationId);

      if (!nextSelectedAutomationId) {
        setDraft(emptyDraft(repos.map((repo) => repo.id)));
        setRuns([]);
        setSelectedRunId(null);
        setRunEvents([]);
      } else {
        const automation = nextAutomations.find((item) => item.id === nextSelectedAutomationId)!;
        setDraft(automationToDraft(automation));
        await loadRuns(nextSelectedAutomationId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load automations.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, selectedAutomationId, repos, loadRuns]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    void loadEvents(selectedRunId);
  }, [selectedRunId, loadEvents]);

  useEffect(() => {
    if (!selectedAutomationId) return;
    const hasActiveRun = runs.some((run) => run.status === 'running' || run.status === 'queued');
    if (!hasActiveRun) return;
    const interval = window.setInterval(() => {
      void loadRuns(selectedAutomationId);
      if (selectedRunId) {
        void loadEvents(selectedRunId);
      }
    }, 5000);
    return () => window.clearInterval(interval);
  }, [runs, selectedAutomationId, selectedRunId, loadRuns, loadEvents]);

  const handleSelectAutomation = (automation: AutomationDefinition) => {
    setSelectedAutomationId(automation.id);
    setDraft(automationToDraft(automation));
    setSearchParams({ automation: automation.id }, { replace: true });
  };

  const handleNewAutomation = () => {
    setSelectedAutomationId(null);
    setSelectedRunId(null);
    setRunEvents([]);
    setRuns([]);
    setDraft(emptyDraft(repos.map((repo) => repo.id)));
    setSearchParams({}, { replace: true });
  };

  const handleSave = async () => {
    if (!workspaceId) return;
    setSaving(true);
    setError(null);
    try {
      if (selectedAutomationId) {
        await window.anvil.automations.update(selectedAutomationId, draft);
      } else {
        const created = await window.anvil.automations.create(workspaceId, draft);
        setSelectedAutomationId(created.id);
        setSearchParams({ automation: created.id }, { replace: true });
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save automation.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedAutomationId) return;
    if (!window.confirm('Delete this automation and its run history?')) return;
    setSaving(true);
    setError(null);
    try {
      await window.anvil.automations.remove(selectedAutomationId);
      handleNewAutomation();
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete automation.');
    } finally {
      setSaving(false);
    }
  };

  const handleRunNow = async () => {
    if (!selectedAutomationId) return;
    setRunning(true);
    setError(null);
    try {
      const run = await window.anvil.automations.runNow(selectedAutomationId);
      setSelectedRunId(run.id);
      setSearchParams({ automation: selectedAutomationId, run: run.id }, { replace: true });
      await loadRuns(selectedAutomationId);
      await loadEvents(run.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start automation.');
    } finally {
      setRunning(false);
    }
  };

  const handleReconcileDaemon = async () => {
    try {
      const status = await window.anvil.automations.reconcileDaemon();
      setDaemonStatus(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reconcile daemon.');
    }
  };

  const handleSelectTriageItem = async (item: AutomationTriageItem) => {
    const automation = automations.find((candidate) => candidate.id === item.automationId);
    if (automation) {
      setSelectedAutomationId(automation.id);
      setDraft(automationToDraft(automation));
    }
    setSelectedRunId(item.id);
    setSearchParams({ automation: item.automationId, run: item.id }, { replace: true });
    await loadRuns(item.automationId);
    setSelectedRunId(item.id);
    await loadEvents(item.id);
  };

  const handleSelectRun = (runId: string) => {
    setSelectedRunId(runId);
    if (selectedAutomationId) {
      setSearchParams({ automation: selectedAutomationId, run: runId }, { replace: true });
    }
  };

  if (!workspaceId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-secondary">Select a workspace to manage automations.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border bg-bg-secondary px-4 py-3">
        <div className="flex items-center gap-3">
          <RadioTower size={20} className="text-accent" />
          <div>
            <h2 className="text-xl font-semibold text-text-primary">Automate</h2>
            <p className="text-sm text-text-secondary">
              Schedule work or let Watchtower babysit workflows, pull requests, and pipelines.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {daemonStatus && (
            <span className="rounded-full border border-border px-2.5 py-1 text-xs text-text-secondary">
              {daemonStatus.mode === 'daemon'
                ? 'Daemon mode'
                : daemonStatus.supported
                  ? daemonStatus.loaded
                    ? 'Daemon loaded'
                    : daemonStatus.installed
                      ? 'Daemon installed'
                      : 'Daemon not installed'
                  : 'Daemon unsupported'}
            </span>
          )}
          <button
            onClick={handleReconcileDaemon}
            className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
          >
            <RefreshCw size={14} />
            Reconcile daemon
          </button>
          <button
            type="button"
            onClick={() => navigate('/workflows')}
            className="flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
          >
            <Workflow size={14} />
            Workflows
          </button>
          <button
            onClick={handleNewAutomation}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
          >
            New automation
          </button>
        </div>
      </div>

      {error && (
        <div className="border-b border-error/30 bg-error/10 px-4 py-2 text-sm text-error">
          {error}
        </div>
      )}

      {triageItems.length > 0 && (
        <div className="border-b border-border-subtle bg-bg-primary px-4 py-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <AlertTriangle size={15} className="text-warning" />
              Triage
              <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs text-warning">
                {triageItems.length}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void loadData()}
              className="text-xs text-text-tertiary hover:text-text-primary"
            >
              Refresh
            </button>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {triageItems.slice(0, 12).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => void handleSelectTriageItem(item)}
                className={`min-w-[260px] rounded-lg border px-3 py-2 text-left transition-colors hover:bg-bg-tertiary ${
                  item.attention === 'blocked'
                    ? 'border-error/30 bg-error/5'
                    : item.attention === 'running'
                      ? 'border-accent/30 bg-accent/5'
                      : 'border-warning/30 bg-warning/5'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-text-primary">
                    {item.automationName}
                  </span>
                  <span className={`text-xs ${statusTone(item.status)}`}>{item.status}</span>
                </div>
                <div className="mt-1 text-xs text-text-secondary">
                  {item.changedFileCount} file{item.changedFileCount === 1 ? '' : 's'} ·{' '}
                  {item.retainedWorktreeCount} worktree
                  {item.retainedWorktreeCount === 1 ? '' : 's'}
                </div>
                <div className="mt-1 truncate text-xs text-text-tertiary">
                  {item.errorMessage ?? item.summary ?? formatTimestamp(item.startedAt)}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          className="flex shrink-0 flex-col border-r border-border bg-bg-secondary transition-[width] duration-200"
          style={{ width: automationsCollapsed ? 52 : 280 }}
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
            {!automationsCollapsed && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                  Saved automations
                </div>
                <div className="mt-1 text-xs text-text-secondary">{automations.length} saved</div>
              </div>
            )}
            <button
              type="button"
              title={
                automationsCollapsed ? 'Expand saved automations' : 'Collapse saved automations'
              }
              onClick={toggleAutomationsCollapsed}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            >
              {automationsCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </button>
          </div>

          {automationsCollapsed ? (
            <div className="flex flex-1 flex-col items-center gap-2 px-2 py-3">
              {automations.slice(0, 8).map((automation) => (
                <button
                  key={automation.id}
                  type="button"
                  title={automation.name}
                  onClick={() => {
                    handleSelectAutomation(automation);
                    toggleAutomationsCollapsed();
                  }}
                  className={`flex h-9 w-9 items-center justify-center rounded-lg border text-[11px] font-semibold transition-colors ${
                    selectedAutomationId === automation.id
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border-subtle bg-bg-primary text-text-secondary hover:border-border hover:text-text-primary'
                  }`}
                >
                  {automation.name.slice(0, 2).toUpperCase()}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-3">
              {loading ? (
                <div className="flex items-center gap-2 rounded-md border border-border-subtle px-3 py-2 text-sm text-text-secondary">
                  <Loader2 size={14} className="animate-spin" />
                  Loading automations…
                </div>
              ) : automations.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-text-secondary">
                  No automations yet.
                </div>
              ) : (
                automations.map((automation) => (
                  <button
                    key={automation.id}
                    onClick={() => handleSelectAutomation(automation)}
                    className={`mb-2 w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                      selectedAutomationId === automation.id
                        ? 'border-accent bg-accent/10'
                        : 'border-border-subtle bg-bg-primary hover:border-border'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-sm font-medium text-text-primary">
                        {automation.name}
                      </div>
                      <span className={`text-xs ${statusTone(automation.lastRunStatus)}`}>
                        {automation.lastRunStatus ?? (automation.enabled ? 'ready' : 'disabled')}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-text-secondary">
                      {automation.triggerMode === 'watchtower'
                        ? watchEventLabel(automation.watchEvent)
                        : automation.scheduleCron}
                    </div>
                    {automation.triggerMode === 'watchtower' && (
                      <div className="mt-2 inline-flex items-center gap-1 rounded-full border border-info/30 bg-info/10 px-2 py-0.5 text-xs text-info">
                        <RadioTower size={11} />
                        Watchtower
                      </div>
                    )}
                    {isLoopAutomation(automation) && (
                      <div className="mt-2 inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs text-accent">
                        <GitBranch size={11} />
                        Loop: {automation.loopConfig?.mode}
                      </div>
                    )}
                    <div className="mt-2 text-xs text-text-tertiary">
                      {automation.triggerMode === 'watchtower'
                        ? automation.enabled
                          ? 'Listening for matching events'
                          : 'Listener disabled'
                        : `Next: ${formatTimestamp(automation.nextRunAt)}`}
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </aside>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,0.78fr)_minmax(440px,1.22fr)] overflow-hidden">
          <section className="min-h-0 overflow-y-auto px-5 py-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-text-primary">
                {selectedAutomation ? 'Edit automation' : 'Create automation'}
              </h3>
              {selectedAutomation && (
                <div className="text-xs text-text-tertiary">
                  Updated {formatTimestamp(selectedAutomation.updatedAt)}
                </div>
              )}
            </div>

            <div className="mt-4 grid gap-4">
              <label className="grid gap-1">
                <span className="text-sm font-medium text-text-secondary">Name</span>
                <input
                  value={draft.name}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, name: event.target.value }))
                  }
                  className="rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                  placeholder="Weekday repo triage"
                />
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="grid gap-1">
                  <span className="text-sm font-medium text-text-secondary">Persona</span>
                  <select
                    value={draft.personaId}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, personaId: event.target.value }))
                    }
                    className="rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                  >
                    {personas.map((persona) => (
                      <option key={persona.id} value={persona.id}>
                        {persona.name}
                      </option>
                    ))}
                  </select>
                </label>

                {(draft.triggerMode ?? 'schedule') === 'schedule' ? (
                  <label className="grid gap-1">
                    <span className="text-sm font-medium text-text-secondary">Timezone</span>
                    <input
                      value={draft.timezone}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, timezone: event.target.value }))
                      }
                      className="rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                      placeholder="Europe/London"
                    />
                  </label>
                ) : (
                  <div className="grid gap-1">
                    <span className="text-sm font-medium text-text-secondary">Delivery</span>
                    <div className="flex items-center gap-2 rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
                      <RadioTower size={14} className="text-info" />
                      Background listener · every 30 seconds
                    </div>
                  </div>
                )}
              </div>

              <div>
                <div className="text-sm font-medium text-text-secondary">Trigger</div>
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  {[
                    {
                      mode: 'schedule' as const,
                      label: 'Schedule',
                      description: 'Run from the existing cron scheduler.',
                      icon: <Clock3 size={15} />,
                    },
                    {
                      mode: 'watchtower' as const,
                      label: 'Watchtower',
                      description: 'Wait for workflows, pull requests, or pipelines.',
                      icon: <RadioTower size={15} />,
                    },
                  ].map((option) => (
                    <button
                      key={option.mode}
                      type="button"
                      onClick={() =>
                        setDraft((current) => ({ ...current, triggerMode: option.mode }))
                      }
                      className={`rounded-lg border px-3 py-3 text-left transition-colors ${
                        (draft.triggerMode ?? 'schedule') === option.mode
                          ? 'border-accent bg-accent/10'
                          : 'border-border-subtle bg-bg-primary hover:border-border'
                      }`}
                    >
                      <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
                        {option.icon}
                        {option.label}
                      </span>
                      <span className="mt-1 block text-xs text-text-secondary">
                        {option.description}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-border-subtle bg-bg-primary p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                      <GitBranch size={15} className="text-accent" />
                      Loop
                    </div>
                    <p className="mt-1 text-xs text-text-secondary">
                      Run persona threads from a heartbeat, with handoff context between turns.
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-text-primary">
                    <input
                      type="checkbox"
                      checked={draft.loopConfig?.enabled === true}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          loopConfig: {
                            ...(current.loopConfig ?? DEFAULT_LOOP_CONFIG),
                            enabled: event.target.checked,
                          },
                        }))
                      }
                    />
                    Enabled
                  </label>
                </div>

                {draft.loopConfig?.enabled && (
                  <div className="mt-4 grid gap-4">
                    <div className="grid gap-2 md:grid-cols-2">
                      <div>
                        <div className="text-sm font-medium text-text-secondary">Routing</div>
                        <div className="mt-2 grid grid-cols-2 rounded-md border border-border-subtle bg-bg-secondary p-1">
                          {(['sequence', 'dynamic'] as const).map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              onClick={() =>
                                setDraft((current) => ({
                                  ...current,
                                  loopConfig: {
                                    ...(current.loopConfig ?? DEFAULT_LOOP_CONFIG),
                                    mode,
                                  },
                                }))
                              }
                              className={`rounded px-3 py-1.5 text-sm capitalize transition-colors ${
                                draft.loopConfig?.mode === mode
                                  ? 'bg-accent text-white'
                                  : 'text-text-secondary hover:text-text-primary'
                              }`}
                            >
                              {mode}
                            </button>
                          ))}
                        </div>
                      </div>

                      <label className="grid gap-1">
                        <span className="text-sm font-medium text-text-secondary">
                          Max thread turns
                        </span>
                        <input
                          type="number"
                          min={1}
                          max={8}
                          value={
                            draft.loopConfig?.maxIterations ?? DEFAULT_LOOP_CONFIG.maxIterations
                          }
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              loopConfig: {
                                ...(current.loopConfig ?? DEFAULT_LOOP_CONFIG),
                                maxIterations: Number(event.target.value),
                              },
                            }))
                          }
                          className="rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                        />
                      </label>
                    </div>

                    <div>
                      <div className="text-sm font-medium text-text-secondary">
                        {draft.loopConfig?.mode === 'dynamic'
                          ? 'Eligible specialist personas'
                          : 'Sequence members'}
                      </div>
                      {draft.loopConfig?.mode === 'dynamic' && (
                        <p className="mt-1 text-xs text-text-tertiary">
                          The primary persona starts as orchestrator, then specialist threads use
                          its plan.
                        </p>
                      )}
                      <div className="mt-2 grid gap-2 md:grid-cols-2">
                        {personas.map((persona) => {
                          const selected =
                            draft.loopConfig?.memberPersonaIds.includes(persona.id) ?? false;
                          return (
                            <button
                              key={persona.id}
                              type="button"
                              onClick={() =>
                                setDraft((current) => {
                                  const loopConfig = current.loopConfig ?? DEFAULT_LOOP_CONFIG;
                                  const memberPersonaIds = selected
                                    ? loopConfig.memberPersonaIds.filter((id) => id !== persona.id)
                                    : [...loopConfig.memberPersonaIds, persona.id];
                                  return {
                                    ...current,
                                    loopConfig: {
                                      ...loopConfig,
                                      memberPersonaIds,
                                    },
                                  };
                                })
                              }
                              className={`flex items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors ${
                                selected
                                  ? 'border-accent bg-accent/10'
                                  : 'border-border-subtle bg-bg-secondary hover:border-border'
                              }`}
                            >
                              <span
                                className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                                style={{ backgroundColor: persona.colour }}
                              />
                              <span className="min-w-0">
                                <span className="block text-sm font-medium text-text-primary">
                                  {persona.name}
                                </span>
                                <span className="line-clamp-2 text-xs text-text-secondary">
                                  {persona.description}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <label className="grid gap-1">
                      <span className="text-sm font-medium text-text-secondary">
                        Stop condition
                      </span>
                      <input
                        value={draft.loopConfig?.stopCondition ?? ''}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            loopConfig: {
                              ...(current.loopConfig ?? DEFAULT_LOOP_CONFIG),
                              stopCondition: event.target.value,
                            },
                          }))
                        }
                        className="rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                        placeholder="Stop when review is clean or a blocker needs a human."
                      />
                    </label>
                  </div>
                )}
              </div>

              {(draft.triggerMode ?? 'schedule') === 'schedule' ? (
                <label className="grid gap-1">
                  <span className="text-sm font-medium text-text-secondary">Schedule (cron)</span>
                  <input
                    value={draft.scheduleCron}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, scheduleCron: event.target.value }))
                    }
                    className="rounded-md border border-border bg-bg-primary px-3 py-2 font-mono text-sm text-text-primary"
                    placeholder="0 9 * * 1-5"
                  />
                  <span className="text-xs text-text-tertiary">
                    Examples: `0 9 * * 1-5` weekdays at 09:00, `*/30 * * * *` every 30 minutes.
                  </span>
                </label>
              ) : (
                <div className="grid gap-3 rounded-lg border border-border-subtle bg-bg-primary p-4">
                  <label className="grid gap-1">
                    <span className="text-sm font-medium text-text-secondary">Watch event</span>
                    <select
                      value={draft.watchEvent ?? 'workflow.completed'}
                      onChange={(event) => {
                        const watchEvent = event.target.value as WatchtowerEventType;
                        setDraft((current) => ({
                          ...current,
                          watchEvent,
                          watchTarget: isExternalWatch(watchEvent)
                            ? (current.watchTarget ?? {
                                repoId: current.repoIds[0] ?? repos[0]?.id ?? '',
                              })
                            : undefined,
                        }));
                      }}
                      className="rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                    >
                      <optgroup label="Anvil workflows">
                        <option value="workflow.completed">Workflow completed</option>
                        <option value="workflow.failed">Workflow failed</option>
                      </optgroup>
                      <optgroup label="Pull requests">
                        <option value="pull_request.merged">Pull request merged</option>
                        <option value="pull_request.closed">
                          Pull request closed without merge
                        </option>
                      </optgroup>
                      <optgroup label="Pipelines">
                        <option value="pipeline.completed">Pipeline completed</option>
                        <option value="pipeline.failed">Pipeline failed</option>
                      </optgroup>
                    </select>
                    <span className="text-xs text-text-tertiary">
                      Existing workflows remain reusable and unchanged.
                    </span>
                  </label>

                  {isExternalWatch(draft.watchEvent) && (
                    <>
                      <label className="grid gap-1">
                        <span className="text-sm font-medium text-text-secondary">
                          Repository to watch
                        </span>
                        <select
                          value={draft.watchTarget?.repoId ?? ''}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              watchTarget: {
                                ...current.watchTarget,
                                repoId: event.target.value,
                              },
                            }))
                          }
                          className="rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                        >
                          <option value="" disabled>
                            Select a repository
                          </option>
                          {repos
                            .filter((repo) => draft.repoIds.includes(repo.id))
                            .map((repo) => (
                              <option key={repo.id} value={repo.id}>
                                {repo.name}
                              </option>
                            ))}
                        </select>
                      </label>

                      {isPullRequestWatch(draft.watchEvent) ? (
                        <label className="grid gap-1">
                          <span className="text-sm font-medium text-text-secondary">
                            Pull request number
                          </span>
                          <input
                            type="number"
                            min={1}
                            value={draft.watchTarget?.pullRequestNumber ?? ''}
                            onChange={(event) =>
                              setDraft((current) => ({
                                ...current,
                                watchTarget: {
                                  ...current.watchTarget,
                                  repoId: current.watchTarget?.repoId ?? current.repoIds[0] ?? '',
                                  pullRequestNumber: event.target.value
                                    ? Number(event.target.value)
                                    : undefined,
                                },
                              }))
                            }
                            className="rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                            placeholder="123"
                          />
                        </label>
                      ) : (
                        <div className="grid gap-3 md:grid-cols-2">
                          <label className="grid gap-1">
                            <span className="text-sm font-medium text-text-secondary">
                              Pipeline or run
                            </span>
                            <input
                              value={draft.watchTarget?.pipelineIdentifier ?? ''}
                              onChange={(event) =>
                                setDraft((current) => ({
                                  ...current,
                                  watchTarget: {
                                    ...current.watchTarget,
                                    repoId: current.watchTarget?.repoId ?? current.repoIds[0] ?? '',
                                    pipelineIdentifier: event.target.value,
                                  },
                                }))
                              }
                              className="rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                              placeholder="CI, ci.yml, or run ID"
                            />
                          </label>
                          <label className="grid gap-1">
                            <span className="text-sm font-medium text-text-secondary">
                              Branch filter <span className="text-text-tertiary">(optional)</span>
                            </span>
                            <input
                              value={draft.watchTarget?.branch ?? ''}
                              onChange={(event) =>
                                setDraft((current) => ({
                                  ...current,
                                  watchTarget: {
                                    ...current.watchTarget,
                                    repoId: current.watchTarget?.repoId ?? current.repoIds[0] ?? '',
                                    branch: event.target.value,
                                  },
                                }))
                              }
                              className="rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                              placeholder="main"
                            />
                          </label>
                        </div>
                      )}

                      <p className="text-xs leading-relaxed text-text-tertiary">
                        GitHub uses your authenticated <code>gh</code> session. Azure DevOps uses
                        the configured PAT. The first check establishes a baseline; later matching
                        transitions trigger exactly once.
                      </p>

                      {selectedAutomation?.watchState && (
                        <div
                          className={`rounded-md px-3 py-2 text-xs ${
                            selectedAutomation.watchState.lastError
                              ? 'bg-error/10 text-error'
                              : 'bg-bg-secondary text-text-secondary'
                          }`}
                        >
                          {selectedAutomation.watchState.lastError
                            ? `Last check failed: ${selectedAutomation.watchState.lastError}`
                            : `Watching ${selectedAutomation.watchState.sourceLabel ?? 'source'} · ${selectedAutomation.watchState.status ?? 'unknown'} · checked ${formatTimestamp(selectedAutomation.watchState.observedAt)}`}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              <label className="grid gap-1">
                <span className="text-sm font-medium text-text-secondary">Prompt</span>
                <textarea
                  value={draft.prompt}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, prompt: event.target.value }))
                  }
                  className="min-h-[200px] rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
                  placeholder="Review the attached repos for failed builds, TODOs, and risky changes. Summarise the top actions."
                />
              </label>

              <div>
                <div className="text-sm font-medium text-text-secondary">Repositories</div>
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  {repos.map((repo) => (
                    <label
                      key={repo.id}
                      className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-primary px-3 py-2 text-sm text-text-primary"
                    >
                      <input
                        type="checkbox"
                        checked={draft.repoIds.includes(repo.id)}
                        onChange={(event) =>
                          setDraft((current) => {
                            const repoIds = event.target.checked
                              ? [...current.repoIds, repo.id]
                              : current.repoIds.filter((candidate) => candidate !== repo.id);
                            const watchTarget = current.watchTarget
                              ? {
                                  ...current.watchTarget,
                                  repoId: repoIds.includes(current.watchTarget.repoId)
                                    ? current.watchTarget.repoId
                                    : (repoIds[0] ?? ''),
                                }
                              : undefined;
                            return { ...current, repoIds, watchTarget };
                          })
                        }
                      />
                      <span>{repo.name}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid gap-2 md:grid-cols-3">
                <label className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-primary px-3 py-2 text-sm text-text-primary">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, enabled: event.target.checked }))
                    }
                  />
                  Enabled
                </label>
                <label className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-primary px-3 py-2 text-sm text-text-primary">
                  <input
                    type="checkbox"
                    checked={draft.allowRepoWrite}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, allowRepoWrite: event.target.checked }))
                    }
                  />
                  Allow repo writes
                </label>
                <label className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-primary px-3 py-2 text-sm text-text-primary">
                  <input
                    type="checkbox"
                    checked={draft.allowCommandRun}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, allowCommandRun: event.target.checked }))
                    }
                  />
                  Allow shell commands
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={handleSave}
                  disabled={saving || repos.length === 0}
                  className="flex items-center gap-1 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-60"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  Save
                </button>
                {selectedAutomation && (
                  <>
                    <button
                      onClick={handleRunNow}
                      disabled={running}
                      className="flex items-center gap-1 rounded-md border border-border px-3 py-2 text-sm text-text-secondary hover:text-text-primary disabled:opacity-60"
                    >
                      {running ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Play size={14} />
                      )}
                      Run now
                    </button>
                    <button
                      onClick={handleDelete}
                      disabled={saving}
                      className="flex items-center gap-1 rounded-md border border-error/40 px-3 py-2 text-sm text-error hover:bg-error/10 disabled:opacity-60"
                    >
                      <Trash2 size={14} />
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>
          </section>

          <section className="flex min-h-0 flex-col border-l border-border bg-bg-secondary">
            <div className="border-b border-border px-4 py-3">
              <h3 className="text-lg font-semibold text-text-primary">Recent runs</h3>
              <p className="text-sm text-text-secondary">
                Inspect retained worktrees, summaries, and streamed run events.
              </p>
            </div>

            <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]">
              <div className="max-h-44 overflow-y-auto border-b border-border px-4 py-3">
                {runs.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-text-secondary">
                    No runs yet for this automation.
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {runs.map((run) => (
                      <RunPickerItem
                        key={run.id}
                        run={run}
                        selected={selectedRunId === run.id}
                        onSelect={() => handleSelectRun(run.id)}
                      />
                    ))}
                  </div>
                )}
              </div>

              <AutomationRunDetail
                selectedRun={selectedRun}
                displayEntries={displayEntries}
                runEvents={runEvents}
                activeTab={runDetailTab}
                onTabChange={setRunDetailTab}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function RunPickerItem({
  run,
  selected,
  onSelect,
}: {
  run: AutomationRun;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
        selected
          ? 'border-accent bg-accent/10'
          : 'border-border-subtle bg-bg-primary hover:border-border'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-text-primary">
          {run.status === 'completed' ? (
            <CheckCircle2 size={14} className="shrink-0 text-success" />
          ) : run.status === 'failed' ? (
            <AlertTriangle size={14} className="shrink-0 text-error" />
          ) : (
            <Loader2 size={14} className="shrink-0 animate-spin text-accent" />
          )}
          <span className="truncate">{runTriggerLabel(run.trigger)} run</span>
        </div>
        <span className={`shrink-0 text-xs ${statusTone(run.status)}`}>{run.status}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-3 text-xs text-text-tertiary">
        <span className="truncate">{formatCompactTimestamp(run.startedAt)}</span>
        <span className="shrink-0">{run.changedFileCount} files</span>
      </div>
    </button>
  );
}

function AutomationRunDetail({
  selectedRun,
  displayEntries,
  runEvents,
  activeTab,
  onTabChange,
}: {
  selectedRun: AutomationRun | null;
  displayEntries: AutomationDisplayEntry[];
  runEvents: AutomationRunEvent[];
  activeTab: AutomationRunDetailTab;
  onTabChange: (tab: AutomationRunDetailTab) => void;
}) {
  const hasRetainedWorktree =
    selectedRun?.worktrees.some((worktree) => worktree.kept && worktree.path) ?? false;
  const transcriptEntries = displayEntries.filter(isTranscriptEntry);
  const activityEntries = displayEntries.filter(isActivityEntry);
  const hasEventTranscript = transcriptEntries.length > 0;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold text-text-primary">
                {selectedRun ? 'Run detail' : 'Select a run'}
              </div>
              {selectedRun && (
                <span className={`text-xs ${statusTone(selectedRun.status)}`}>
                  {selectedRun.status}
                </span>
              )}
            </div>
            {selectedRun && (
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-secondary">
                <span>Started {formatCompactTimestamp(selectedRun.startedAt)}</span>
                {selectedRun.completedAt && (
                  <span>Completed {formatCompactTimestamp(selectedRun.completedAt)}</span>
                )}
                <span>{runTriggerLabel(selectedRun.trigger)}</span>
                {selectedRun.triggerContext && (
                  <span>From {selectedRun.triggerContext.sourceLabel}</span>
                )}
                <span>{runEvents.length} events</span>
              </div>
            )}
          </div>
          {hasRetainedWorktree && (
            <span className="shrink-0 rounded-full border border-border px-2 py-1 text-xs text-text-secondary">
              Worktree retained
            </span>
          )}
        </div>

        {selectedRun && (
          <div className="mt-3 flex gap-1 rounded-lg border border-border-subtle bg-bg-primary p-1">
            {RUN_DETAIL_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => onTabChange(tab.id)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'bg-bg-tertiary text-text-primary shadow-sm'
                    : 'text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!selectedRun ? (
          <EmptyRunDetail />
        ) : activeTab === 'transcript' ? (
          <TranscriptTab
            selectedRun={selectedRun}
            transcriptEntries={transcriptEntries}
            hasEventTranscript={hasEventTranscript}
          />
        ) : activeTab === 'activity' ? (
          <ActivityTab activityEntries={activityEntries} />
        ) : activeTab === 'worktrees' ? (
          <WorktreesTab selectedRun={selectedRun} />
        ) : (
          <RawEventsTab runEvents={runEvents} />
        )}
      </div>
    </div>
  );
}

function EmptyRunDetail() {
  return (
    <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-text-secondary">
      Select a run to read the transcript.
    </div>
  );
}

function TranscriptTab({
  selectedRun,
  transcriptEntries,
  hasEventTranscript,
}: {
  selectedRun: AutomationRun;
  transcriptEntries: AutomationDisplayEntry[];
  hasEventTranscript: boolean;
}) {
  const fallbackMessage =
    !hasEventTranscript && selectedRun.assistantMessage ? selectedRun.assistantMessage : null;

  return (
    <div className="space-y-3">
      {selectedRun.errorMessage && (
        <div className="rounded-xl border border-error/20 bg-error/5 px-4 py-3 text-sm text-error shadow-sm">
          <div className="font-medium">Run failed</div>
          <p className="mt-1 whitespace-pre-wrap leading-relaxed">{selectedRun.errorMessage}</p>
        </div>
      )}

      {fallbackMessage && (
        <TranscriptMessage
          label="Assistant"
          timestamp={selectedRun.completedAt ?? selectedRun.startedAt}
          content={fallbackMessage}
        />
      )}

      {transcriptEntries.length === 0 && !fallbackMessage ? (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-text-secondary">
          No transcript captured for this run yet.
        </div>
      ) : (
        transcriptEntries.map((entry, index) => (
          <TranscriptEntryRenderer key={`transcript-${index}`} entry={entry} />
        ))
      )}
    </div>
  );
}

function TranscriptEntryRenderer({ entry }: { entry: AutomationDisplayEntry }) {
  if (entry.kind === 'assistant') {
    return (
      <TranscriptMessage label="Assistant" timestamp={entry.createdAt} content={entry.content} />
    );
  }

  if (entry.kind === 'thinking') {
    return <TranscriptThinking timestamp={entry.createdAt} content={entry.content} />;
  }

  if (entry.kind === 'system') {
    return (
      <TranscriptMessage label="System" timestamp={entry.createdAt} content={entry.content} muted />
    );
  }

  if (entry.kind === 'activity') {
    return <TranscriptActivityMarker timestamp={entry.createdAt} events={entry.events} />;
  }

  if (entry.event.type === 'error') {
    return <ChatEventRenderer event={entry.event} />;
  }

  return <TranscriptActivityMarker timestamp={entry.createdAt} events={[entry.event]} />;
}

function TranscriptMessage({
  label,
  timestamp,
  content,
  muted = false,
}: {
  label: string;
  timestamp: string;
  content: string;
  muted?: boolean;
}) {
  return (
    <article
      className={`rounded-xl border px-4 py-3 shadow-sm ${
        muted
          ? 'border-border-subtle bg-bg-primary text-text-secondary'
          : 'border-border-subtle bg-bg-tertiary/55 text-text-primary'
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
        <span className="font-semibold uppercase tracking-wide text-text-tertiary">{label}</span>
        <time className="shrink-0 text-text-tertiary">{formatCompactTimestamp(timestamp)}</time>
      </div>
      <MarkdownRenderer content={content} />
    </article>
  );
}

function TranscriptThinking({ timestamp, content }: { timestamp: string; content: string }) {
  return (
    <details className="rounded-xl border border-border-subtle bg-bg-primary shadow-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary/50">
        <span className="flex items-center gap-2">
          <Clock3 size={13} className="text-warning" />
          Reasoning
        </span>
        <time className="text-xs text-text-tertiary">{formatCompactTimestamp(timestamp)}</time>
      </summary>
      {content && (
        <p className="border-t border-border-subtle px-4 py-3 text-sm italic leading-relaxed text-text-tertiary whitespace-pre-wrap">
          {content}
        </p>
      )}
    </details>
  );
}

function TranscriptActivityMarker({
  timestamp,
  events,
}: {
  timestamp: string;
  events: CodexEvent[];
}) {
  return (
    <div className="flex items-center gap-3 py-1 text-xs text-text-tertiary">
      <div className="h-px flex-1 bg-border-subtle" />
      <span className="rounded-full border border-border-subtle bg-bg-primary px-2 py-1">
        {summarizeAutomationActivity(events)} · {formatCompactTimestamp(timestamp)}
      </span>
      <div className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}

function ActivityTab({ activityEntries }: { activityEntries: AutomationDisplayEntry[] }) {
  if (activityEntries.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-text-secondary">
        No activity events captured for this run yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {activityEntries.map((entry, index) => {
        if (entry.kind === 'activity') {
          return <ActivityGroupMessage key={`activity-${index}`} events={entry.events} />;
        }

        if (entry.kind === 'event') {
          return <ChatEventRenderer key={`event-${index}`} event={entry.event} />;
        }

        return null;
      })}
    </div>
  );
}

function WorktreesTab({ selectedRun }: { selectedRun: AutomationRun }) {
  if (selectedRun.worktrees.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-text-secondary">
        No worktrees were retained for this run.
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {selectedRun.worktrees.map((worktree) => (
        <div
          key={`${worktree.repoId}-${worktree.branchName}`}
          className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle bg-bg-primary px-3 py-2"
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-text-primary">
              {worktree.repoName}
            </div>
            <div className="truncate text-xs text-text-tertiary">{worktree.branchName}</div>
          </div>
          {worktree.path ? (
            <button
              type="button"
              onClick={() => window.anvil.repo.openInVSCode(worktree.path!)}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
            >
              <Wrench size={12} />
              Open worktree
            </button>
          ) : (
            <span className="shrink-0 text-xs text-text-tertiary">Cleaned up</span>
          )}
        </div>
      ))}
    </div>
  );
}

function RawEventsTab({ runEvents }: { runEvents: AutomationRunEvent[] }) {
  if (runEvents.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-text-secondary">
        No raw events captured for this run yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {runEvents.map((event) => (
        <div
          key={event.id}
          className="rounded-lg border border-border-subtle bg-bg-primary px-3 py-2"
        >
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="font-mono text-text-secondary">{event.type}</span>
            <time className="shrink-0 text-text-tertiary">
              {formatCompactTimestamp(event.createdAt)}
            </time>
          </div>
          {event.content && (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-secondary p-2 font-mono text-xs leading-relaxed text-text-secondary">
              {event.content}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

function isTranscriptEntry(entry: AutomationDisplayEntry): boolean {
  if (entry.kind === 'assistant' || entry.kind === 'thinking' || entry.kind === 'system')
    return true;
  if (entry.kind === 'activity') return true;
  if (entry.kind === 'event') return entry.event.type === 'error';
  return false;
}

function isActivityEntry(entry: AutomationDisplayEntry): boolean {
  return entry.kind === 'activity' || entry.kind === 'event';
}

function summarizeAutomationActivity(events: CodexEvent[]): string {
  const counts = events.reduce(
    (summary, event) => {
      if (event.type === 'command_exec') summary.commands += 1;
      else if (event.type === 'tool_call') summary.tools += 1;
      else if (event.type === 'file_edit') summary.edits += 1;
      else if (event.type === 'error') summary.errors += 1;
      else summary.other += 1;
      return summary;
    },
    { commands: 0, tools: 0, edits: 0, errors: 0, other: 0 },
  );

  const parts = [
    formatActivityCount(counts.commands, 'command'),
    formatActivityCount(counts.tools, 'tool'),
    formatActivityCount(counts.edits, 'edit'),
    formatActivityCount(counts.errors, 'error'),
    formatActivityCount(counts.other, 'event'),
  ].filter(Boolean);

  return parts.join(', ') || 'Activity';
}

function formatActivityCount(count: number, label: string): string | null {
  if (count === 0) return null;
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}

function formatCompactTimestamp(value?: string): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
