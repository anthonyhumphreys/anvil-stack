import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  GitBranch,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Trash2,
  Wrench,
} from 'lucide-react';
import type {
  AutomationDaemonStatus,
  AutomationDefinition,
  AutomationDefinitionInput,
  AutomationLoopConfig,
  AutomationRun,
  AutomationRunEvent,
  Persona,
} from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useStoredPanelState } from '../../hooks/useStoredPanelState';
import {
  ActivityGroupMessage,
  AssistantMessage,
  ChatEventRenderer,
  ThinkingMessage,
} from '../chat/ChatMessage';
import { buildAutomationDisplayEntries } from '../../utils/automation-run-events';

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

function emptyDraft(repoIds: string[]): AutomationDefinitionInput {
  return {
    name: '',
    personaId: 'coder',
    prompt: '',
    repoIds,
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

export function AutomationsView() {
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace?.id;
  const repos = activeWorkspace?.repos ?? [];

  const [personas, setPersonas] = useState<Persona[]>([]);
  const [automations, setAutomations] = useState<AutomationDefinition[]>([]);
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AutomationDefinitionInput>(() => emptyDraft([]));
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runEvents, setRunEvents] = useState<AutomationRunEvent[]>([]);
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
      const [nextAutomations, nextPersonas, nextDaemonStatus] = await Promise.all([
        window.anvil.automations.list(workspaceId),
        window.anvil.chat.getPersonas(),
        window.anvil.automations.getDaemonStatus(),
      ]);

      setAutomations(nextAutomations);
      setPersonas(nextPersonas);
      setDaemonStatus(nextDaemonStatus);

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
  };

  const handleNewAutomation = () => {
    setSelectedAutomationId(null);
    setSelectedRunId(null);
    setRunEvents([]);
    setRuns([]);
    setDraft(emptyDraft(repos.map((repo) => repo.id)));
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
          <Bot size={20} className="text-accent" />
          <div>
            <h2 className="text-xl font-semibold text-text-primary">Automations</h2>
            <p className="text-sm text-text-secondary">
              Schedule autonomous Codex runs in disposable worktrees.
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
                  Loading automations...
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
                      {automation.scheduleCron}
                    </div>
                    {isLoopAutomation(automation) && (
                      <div className="mt-2 inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs text-accent">
                        <GitBranch size={11} />
                        Loop: {automation.loopConfig?.mode}
                      </div>
                    )}
                    <div className="mt-2 text-xs text-text-tertiary">
                      Next: {formatTimestamp(automation.nextRunAt)}
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </aside>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)] overflow-hidden">
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
                          setDraft((current) => ({
                            ...current,
                            repoIds: event.target.checked
                              ? [...current.repoIds, repo.id]
                              : current.repoIds.filter((candidate) => candidate !== repo.id),
                          }))
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

            <div className="grid min-h-0 flex-1 grid-rows-[minmax(180px,0.9fr)_minmax(0,1.1fr)]">
              <div className="overflow-y-auto border-b border-border px-4 py-3">
                {runs.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-text-secondary">
                    No runs yet for this automation.
                  </div>
                ) : (
                  runs.map((run) => (
                    <button
                      key={run.id}
                      onClick={() => setSelectedRunId(run.id)}
                      className={`mb-2 w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                        selectedRunId === run.id
                          ? 'border-accent bg-accent/10'
                          : 'border-border-subtle bg-bg-primary hover:border-border'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                          {run.status === 'completed' ? (
                            <CheckCircle2 size={14} className="text-success" />
                          ) : run.status === 'failed' ? (
                            <AlertTriangle size={14} className="text-error" />
                          ) : (
                            <Loader2 size={14} className="animate-spin text-accent" />
                          )}
                          {run.trigger === 'manual' ? 'Manual run' : 'Scheduled run'}
                        </div>
                        <span className={`text-xs ${statusTone(run.status)}`}>{run.status}</span>
                      </div>
                      <div className="mt-1 text-xs text-text-secondary">
                        {formatTimestamp(run.startedAt)}
                      </div>
                      <div className="mt-2 text-xs text-text-tertiary">
                        Changed files: {run.changedFileCount}
                      </div>
                    </button>
                  ))
                )}
              </div>

              <div className="flex min-h-0 flex-col">
                <div className="shrink-0 border-b border-border px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-text-primary">
                        {selectedRun ? 'Run detail' : 'Select a run'}
                      </div>
                      {selectedRun && (
                        <div className="mt-1 text-xs text-text-secondary">
                          Completed {formatTimestamp(selectedRun.completedAt)}
                        </div>
                      )}
                    </div>
                    {selectedRun?.worktrees.some((worktree) => worktree.kept && worktree.path) && (
                      <span className="rounded-full border border-border px-2 py-1 text-xs text-text-secondary">
                        Worktree retained
                      </span>
                    )}
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                  {selectedRun?.assistantMessage && (
                    <div className="mb-3">
                      <AssistantMessage content={selectedRun.assistantMessage} />
                    </div>
                  )}
                  {selectedRun?.errorMessage && (
                    <div className="mb-3 rounded-xl border border-error/20 bg-error/5 px-4 py-3 text-sm text-error shadow-sm">
                      <div className="font-medium">Run failed</div>
                      <p className="mt-1 whitespace-pre-wrap leading-relaxed">
                        {selectedRun.errorMessage}
                      </p>
                    </div>
                  )}
                  {selectedRun && selectedRun.worktrees.length > 0 && (
                    <div className="mb-4">
                      <div className="mb-2 text-sm font-semibold text-text-primary">Worktrees</div>
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
                              <div className="truncate text-xs text-text-tertiary">
                                {worktree.branchName}
                              </div>
                            </div>
                            {worktree.path ? (
                              <button
                                onClick={() => window.anvil.repo.openInVSCode(worktree.path!)}
                                className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
                              >
                                <Wrench size={12} />
                                Open worktree
                              </button>
                            ) : (
                              <span className="shrink-0 text-xs text-text-tertiary">
                                Cleaned up
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
                    <Clock3 size={14} />
                    Run events
                  </div>
                  {displayEntries.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-text-secondary">
                      No captured events for this run yet.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {displayEntries.map((entry, index) => {
                        if (entry.kind === 'assistant') {
                          return (
                            <AssistantMessage key={`assistant-${index}`} content={entry.content} />
                          );
                        }
                        if (entry.kind === 'thinking') {
                          return (
                            <ThinkingMessage key={`thinking-${index}`} content={entry.content} />
                          );
                        }
                        if (entry.kind === 'system') {
                          return (
                            <SystemRunMessage key={`system-${index}`} content={entry.content} />
                          );
                        }
                        if (entry.kind === 'activity') {
                          return (
                            <ActivityGroupMessage key={`activity-${index}`} events={entry.events} />
                          );
                        }
                        return <ChatEventRenderer key={`event-${index}`} event={entry.event} />;
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function SystemRunMessage({ content }: { content: string }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-bg-primary px-4 py-3 shadow-sm">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
        System
      </div>
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-text-secondary">
        {content}
      </p>
    </div>
  );
}
