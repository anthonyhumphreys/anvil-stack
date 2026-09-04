import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  Clipboard,
  Clock3,
  Flame,
  Gauge,
  Loader2,
  MessageSquareWarning,
  Play,
  Save,
  ShieldCheck,
  Target,
} from 'lucide-react';
import type {
  DojoConfig,
  DojoConfigInput,
  DojoReport,
  DojoSkillRecommendation,
} from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { copyTextToClipboard } from '../../utils/clipboard';
import { EmptyState, InlineNotice, ViewHeader } from '../layout/ViewScaffold';

const FREQUENCIES = [
  { label: 'Every day', cron: '0 9 * * *' },
  { label: 'Every week', cron: '0 9 * * 1' },
  { label: 'Every month', cron: '0 9 1 * *' },
] as const;

const LOOKBACK_OPTIONS = [7, 14, 30, 60, 90];
type DojoTab = 'overview' | 'prompts' | 'skills';

function formatCount(value: number): string {
  return Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? 'compact' : 'standard',
  }).format(value);
}

function formatDate(value?: string): string {
  if (!value) return 'Not scheduled';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatWindow(report: DojoReport): string {
  const start = new Date(report.windowStart).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  const end = new Date(report.windowEnd).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `${start} to ${end}`;
}

function frequencyValue(cron: string): string {
  return FREQUENCIES.some((frequency) => frequency.cron === cron) ? cron : 'custom';
}

function impactClass(impact: 'high' | 'medium' | 'low'): string {
  if (impact === 'high') return 'bg-error/10 text-error';
  if (impact === 'medium') return 'bg-warning/10 text-warning';
  return 'bg-info/10 text-info';
}

function SkillSource({ recommendation }: { recommendation: DojoSkillRecommendation }) {
  return (
    <a
      href={recommendation.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs font-medium text-info underline decoration-info/40 underline-offset-4 hover:text-info/80"
    >
      {recommendation.library}
      <ArrowUpRight size={12} aria-hidden="true" />
    </a>
  );
}

export function DojoView() {
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace?.id;
  const [config, setConfig] = useState<DojoConfig | null>(null);
  const [draft, setDraft] = useState<DojoConfigInput | null>(null);
  const [reports, setReports] = useState<DojoReport[]>([]);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DojoTab>('overview');
  const [error, setError] = useState<string | null>(null);

  const selectedReport = useMemo(
    () => reports.find((report) => report.id === selectedReportId) ?? reports[0] ?? null,
    [reports, selectedReportId],
  );

  const loadData = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const [nextConfig, nextReports] = await Promise.all([
        window.anvil.dojo.getConfig(workspaceId),
        window.anvil.dojo.listReports(workspaceId),
      ]);
      setConfig(nextConfig);
      setDraft((current) => current ?? nextConfig);
      setReports(nextReports);
      setSelectedReportId((current) =>
        current && nextReports.some((report) => report.id === current)
          ? current
          : (nextReports[0]?.id ?? null),
      );
      setRunning(nextReports.some((report) => report.status === 'running'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dojo could not load this workspace.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    setDraft(null);
    setLoading(true);
    setError(null);
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void loadData(), 2_500);
    return () => window.clearInterval(timer);
  }, [loadData, running]);

  const saveConfig = useCallback(async () => {
    if (!workspaceId || !draft) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await window.anvil.dojo.updateConfig(workspaceId, draft);
      setConfig(updated);
      setDraft(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dojo settings could not be saved.');
    } finally {
      setSaving(false);
    }
  }, [draft, workspaceId]);

  const runReview = useCallback(async () => {
    if (!workspaceId) return;
    setRunning(true);
    setError(null);
    try {
      const report = await window.anvil.dojo.runNow(workspaceId);
      setReports((current) => [report, ...current.filter((item) => item.id !== report.id)]);
      setSelectedReportId(report.id);
      if (report.status !== 'running') setRunning(false);
    } catch (err) {
      setRunning(false);
      setError(err instanceof Error ? err.message : 'Dojo could not start the review.');
    }
  }, [workspaceId]);

  const copyPrompt = useCallback(async (id: string, prompt: string) => {
    await copyTextToClipboard(prompt);
    setCopiedPrompt(id);
    window.setTimeout(() => setCopiedPrompt((current) => (current === id ? null : current)), 1_500);
  }, []);

  if (!workspaceId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-secondary">Select a workspace to open Dojo.</p>
      </div>
    );
  }

  if (loading || !draft || !config) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-text-secondary">
        <Loader2 size={16} className="animate-spin" />
        Opening Dojo
      </div>
    );
  }

  const metrics = selectedReport?.metrics;
  const hasUnsavedChanges =
    draft.enabled !== config.enabled ||
    draft.lookbackDays !== config.lookbackDays ||
    draft.scheduleCron !== config.scheduleCron ||
    draft.timezone !== config.timezone;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <ViewHeader
        icon={Target}
        title="Dojo"
        description="Review how you work with AI agents, then turn repeated friction into better prompts and skills. Conversation text stays in Anvil and is sent only to your configured model."
        meta={
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${config.enabled ? 'bg-success/10 text-success' : 'bg-bg-tertiary text-text-tertiary'}`}
          >
            {config.enabled ? 'Enabled' : 'Off'}
          </span>
        }
        actions={
          <button
            type="button"
            onClick={() => void runReview()}
            disabled={!config.enabled || running}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {running ? 'Reviewing' : 'Review now'}
          </button>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto grid max-w-[1500px] gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <main className="min-w-0 space-y-5">
            {error && (
              <InlineNotice icon={AlertTriangle} tone="error">
                {error}
              </InlineNotice>
            )}

            {!config.enabled && (
              <InlineNotice icon={ShieldCheck} tone="info">
                Dojo is off. Enable it in Review settings before Anvil reads conversation text for
                coaching.
              </InlineNotice>
            )}

            {!selectedReport ? (
              <section className="rounded-xl border border-border bg-bg-secondary">
                <EmptyState
                  icon={Target}
                  title="No training review yet"
                  description="Choose a review period, enable Dojo, and run the first review. It will measure agent usage across each enabled provider and look for repeated friction."
                />
              </section>
            ) : (
              <>
                <div
                  role="tablist"
                  aria-label="Dojo report sections"
                  className="flex gap-1 rounded-xl border border-border bg-bg-secondary p-1"
                >
                  {[
                    { id: 'overview' as const, label: 'Overview' },
                    {
                      id: 'prompts' as const,
                      label: `Prompts ${selectedReport.promptRecommendations.length}`,
                    },
                    {
                      id: 'skills' as const,
                      label: `Skills ${selectedReport.skillRecommendations.length}`,
                    },
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={activeTab === tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`min-w-0 flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                        activeTab === tab.id
                          ? 'bg-bg-elevated text-text-primary'
                          : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {activeTab === 'overview' && (
                  <>
                    <section className="overflow-hidden rounded-xl border border-border bg-bg-secondary">
                      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle px-4 py-3.5">
                        <div>
                          <h2 className="text-sm font-semibold text-text-primary">
                            {selectedReport.status === 'running'
                              ? 'Review in progress'
                              : selectedReport.status === 'failed'
                                ? 'Review interrupted'
                                : 'Training ledger'}
                          </h2>
                          <p className="mt-0.5 text-xs text-text-tertiary">
                            {formatWindow(selectedReport)} · {selectedReport.sampleMessageCount}{' '}
                            messages sampled for coaching
                          </p>
                        </div>
                        <span className="rounded-md bg-bg-tertiary px-2 py-1 text-xs text-text-secondary">
                          {selectedReport.trigger === 'schedule' ? 'Scheduled' : 'Manual'}
                        </span>
                      </div>

                      {metrics && (
                        <div className="grid grid-cols-2 divide-x divide-y divide-border-subtle md:grid-cols-3">
                          {[
                            { label: 'Sessions', value: metrics.sessionCount, icon: Gauge },
                            {
                              label: 'Input tokens',
                              value: `~${formatCount(metrics.estimatedInputTokens)}`,
                              icon: Flame,
                            },
                            {
                              label: 'Output tokens',
                              value: `~${formatCount(metrics.estimatedOutputTokens)}`,
                              icon: Flame,
                            },
                            {
                              label: 'Frustrated',
                              value: metrics.frustrationCount,
                              icon: MessageSquareWarning,
                            },
                            {
                              label: 'Swore',
                              value: metrics.profanityCount,
                              icon: MessageSquareWarning,
                            },
                            {
                              label: 'Corrections',
                              value: metrics.correctionCount,
                              icon: MessageSquareWarning,
                            },
                          ].map(({ label, value, icon: Icon }) => (
                            <div key={label} className="min-w-0 px-4 py-4">
                              <div className="flex items-center gap-2 text-text-tertiary">
                                <Icon size={13} aria-hidden="true" />
                                <span className="truncate text-xs font-medium uppercase tracking-[0.08em]">
                                  {label}
                                </span>
                              </div>
                              <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-text-primary">
                                {typeof value === 'number' ? formatCount(value) : value}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {metrics && (
                        <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-border-subtle px-4 py-3 text-xs">
                          {metrics.providers.map((provider) => (
                            <div key={provider.provider} className="flex items-center gap-2">
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${provider.status === 'covered' ? 'bg-success' : 'bg-text-muted'}`}
                              />
                              <span className="capitalize text-text-secondary">
                                {provider.provider}
                              </span>
                              <span className="text-text-tertiary">
                                {provider.status === 'covered'
                                  ? `${provider.sessionCount} sessions`
                                  : 'No activity'}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>

                    {selectedReport.status === 'running' && (
                      <InlineNotice icon={Loader2} tone="info">
                        The configured model is reading the bounded transcript sample. You can leave
                        this screen; the automation daemon will finish the report.
                      </InlineNotice>
                    )}

                    {selectedReport.status === 'failed' && (
                      <InlineNotice icon={AlertTriangle} tone="error">
                        {selectedReport.errorMessage ?? 'The model did not complete this review.'}
                      </InlineNotice>
                    )}

                    {selectedReport.summary && (
                      <section className="rounded-xl border border-border bg-bg-secondary px-5 py-4">
                        <h2 className="text-sm font-semibold text-text-primary">Coach's read</h2>
                        <p className="mt-2 max-w-[75ch] text-sm leading-relaxed text-text-secondary">
                          {selectedReport.summary}
                        </p>
                      </section>
                    )}

                    {selectedReport.observations.length > 0 && (
                      <section className="rounded-xl border border-border bg-bg-secondary">
                        <div className="border-b border-border-subtle px-5 py-3.5">
                          <h2 className="text-sm font-semibold text-text-primary">
                            What to change
                          </h2>
                        </div>
                        <div className="divide-y divide-border-subtle">
                          {selectedReport.observations.map((observation, index) => (
                            <article key={`${observation.title}-${index}`} className="px-5 py-4">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="text-sm font-medium text-text-primary">
                                  {observation.title}
                                </h3>
                                <span
                                  className={`rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-[0.08em] ${impactClass(observation.impact)}`}
                                >
                                  {observation.impact}
                                </span>
                                <span className="text-xs capitalize text-text-tertiary">
                                  {observation.category}
                                </span>
                              </div>
                              <p className="mt-1.5 max-w-[75ch] text-sm leading-relaxed text-text-secondary">
                                {observation.detail}
                              </p>
                            </article>
                          ))}
                        </div>
                      </section>
                    )}
                  </>
                )}

                {activeTab === 'prompts' && selectedReport.promptRecommendations.length > 0 && (
                  <section className="rounded-xl border border-border bg-bg-secondary">
                    <div className="border-b border-border-subtle px-5 py-3.5">
                      <h2 className="text-sm font-semibold text-text-primary">
                        Prompts worth keeping
                      </h2>
                      <p className="mt-0.5 text-xs text-text-tertiary">
                        Repeated corrections rewritten as ready-to-paste skill instructions.
                      </p>
                    </div>
                    <div className="divide-y divide-border-subtle">
                      {selectedReport.promptRecommendations.map((recommendation, index) => {
                        const promptId = `${selectedReport.id}-${index}`;
                        const copied = copiedPrompt === promptId;
                        return (
                          <article key={promptId} className="px-5 py-4">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <h3 className="text-sm font-medium text-text-primary">
                                  {recommendation.title}
                                </h3>
                                <p className="mt-1 text-xs text-text-tertiary">
                                  Seen {recommendation.evidenceCount} times ·{' '}
                                  {recommendation.reason}
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => void copyPrompt(promptId, recommendation.prompt)}
                                className="shrink-0 rounded-md border border-border p-2 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                                aria-label={`Copy ${recommendation.title}`}
                                title="Copy prompt"
                              >
                                {copied ? <Check size={14} /> : <Clipboard size={14} />}
                              </button>
                            </div>
                            <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-bg-primary px-3 py-2.5 font-mono text-xs leading-relaxed text-text-secondary">
                              {recommendation.prompt}
                            </pre>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                )}

                {activeTab === 'prompts' && selectedReport.promptRecommendations.length === 0 && (
                  <section className="rounded-xl border border-border bg-bg-secondary">
                    <EmptyState
                      compact
                      icon={Clipboard}
                      title="No repeated prompt yet"
                      description="Dojo only suggests a reusable instruction when the same correction appears more than once."
                    />
                  </section>
                )}

                {activeTab === 'skills' && selectedReport.skillRecommendations.length > 0 && (
                  <section className="rounded-xl border border-border bg-bg-secondary">
                    <div className="border-b border-border-subtle px-5 py-3.5">
                      <h2 className="text-sm font-semibold text-text-primary">Skill shortlist</h2>
                      <p className="mt-0.5 text-xs text-text-tertiary">
                        Ranked against this report from Matt Pocock's skills and poteto's pstack.
                      </p>
                    </div>
                    <ol className="divide-y divide-border-subtle">
                      {selectedReport.skillRecommendations.map((recommendation) => (
                        <li
                          key={`${recommendation.library}-${recommendation.skill}`}
                          className="flex gap-4 px-5 py-4"
                        >
                          <span className="w-6 shrink-0 font-mono text-lg tabular-nums text-text-muted">
                            {String(recommendation.rank).padStart(2, '0')}
                          </span>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                              <h3 className="font-mono text-sm font-medium text-text-primary">
                                {recommendation.skill}
                              </h3>
                              <SkillSource recommendation={recommendation} />
                            </div>
                            <p className="mt-1.5 max-w-[75ch] text-sm leading-relaxed text-text-secondary">
                              {recommendation.reason}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}

                {activeTab === 'skills' && selectedReport.skillRecommendations.length === 0 && (
                  <section className="rounded-xl border border-border bg-bg-secondary">
                    <EmptyState
                      compact
                      icon={Target}
                      title="No skill match yet"
                      description="The reviewed catalog did not contain a strong match for this report."
                    />
                  </section>
                )}
              </>
            )}

            <p className="px-1 text-xs leading-relaxed text-text-muted">
              Frustration, profanity, and correction totals count user messages that match local
              phrase rules. Token totals are estimates based on character count. Treat both as
              coaching signals, not sentiment or billing data.
            </p>
          </main>

          <aside className="space-y-5 xl:sticky xl:top-5 xl:self-start">
            <section className="rounded-xl border border-border bg-bg-secondary p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-text-primary">Review settings</h2>
                  <p className="mt-0.5 text-xs text-text-tertiary">
                    {draft.enabled
                      ? 'Runs only for this workspace.'
                      : 'Off until you choose otherwise.'}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={draft.enabled}
                  onClick={() =>
                    setDraft((current) => current && { ...current, enabled: !current.enabled })
                  }
                  className={`relative h-6 w-11 rounded-full transition-colors ${draft.enabled ? 'bg-accent' : 'bg-bg-elevated'}`}
                >
                  <span
                    className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${draft.enabled ? 'translate-x-6' : 'translate-x-1'}`}
                  />
                  <span className="sr-only">Enable Dojo</span>
                </button>
              </div>

              <div className="mt-4 space-y-4 border-t border-border-subtle pt-4">
                <label className="block">
                  <span className="text-xs font-medium text-text-secondary">Review period</span>
                  <select
                    value={draft.lookbackDays}
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? { ...current, lookbackDays: Number(event.target.value) }
                          : current,
                      )
                    }
                    className="mt-1.5 w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary"
                  >
                    {LOOKBACK_OPTIONS.map((days) => (
                      <option key={days} value={days}>
                        Last {days} days
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="text-xs font-medium text-text-secondary">Frequency</span>
                  <select
                    value={frequencyValue(draft.scheduleCron)}
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              scheduleCron:
                                event.target.value === 'custom'
                                  ? current.scheduleCron
                                  : event.target.value,
                            }
                          : current,
                      )
                    }
                    className="mt-1.5 w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary"
                  >
                    {FREQUENCIES.map((frequency) => (
                      <option key={frequency.cron} value={frequency.cron}>
                        {frequency.label} at 09:00
                      </option>
                    ))}
                    <option value="custom">Custom cron</option>
                  </select>
                </label>

                {frequencyValue(draft.scheduleCron) === 'custom' && (
                  <label className="block">
                    <span className="text-xs font-medium text-text-secondary">Cron expression</span>
                    <input
                      value={draft.scheduleCron}
                      onChange={(event) =>
                        setDraft((current) =>
                          current ? { ...current, scheduleCron: event.target.value } : current,
                        )
                      }
                      className="mt-1.5 w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 font-mono text-sm text-text-primary"
                      spellCheck={false}
                    />
                  </label>
                )}

                <div className="flex items-center gap-2 text-xs text-text-tertiary">
                  <Clock3 size={13} aria-hidden="true" />
                  <span>Next run: {draft.enabled ? formatDate(config.nextRunAt) : 'Off'}</span>
                </div>

                <button
                  type="button"
                  onClick={() => void saveConfig()}
                  disabled={!hasUnsavedChanges || saving}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  Save settings
                </button>
              </div>
            </section>

            {reports.length > 0 && (
              <section className="rounded-xl border border-border bg-bg-secondary">
                <div className="border-b border-border-subtle px-4 py-3">
                  <h2 className="text-sm font-semibold text-text-primary">Previous reviews</h2>
                </div>
                <div className="max-h-80 overflow-auto p-2">
                  {reports.map((report) => (
                    <button
                      key={report.id}
                      type="button"
                      onClick={() => setSelectedReportId(report.id)}
                      className={`w-full rounded-lg px-3 py-2.5 text-left transition-colors ${selectedReport?.id === report.id ? 'bg-accent/10 text-text-primary' : 'text-text-secondary hover:bg-bg-tertiary'}`}
                    >
                      <span className="block text-sm font-medium">{formatWindow(report)}</span>
                      <span className="mt-0.5 block text-xs capitalize text-text-tertiary">
                        {report.status} · {report.metrics.sessionCount} sessions
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
