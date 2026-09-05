import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Play, RefreshCw, Settings2, Target } from 'lucide-react';
import type { DojoConfig, DojoConfigInput, DojoReport } from '../../../shared/types';
import type { DojoAnalytics } from '../../../shared/dojo-types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { ViewHeader } from '../layout/ViewScaffold';
import { DojoAnalyticsPanel } from './DojoAnalyticsPanel';
import { DojoCoachingPanel } from './DojoCoachingPanel';
import { buttonClass, fieldClass } from './dojo-format';

export function DojoView() {
  const { activeWorkspace } = useWorkspace();
  if (!activeWorkspace)
    return <div className="p-8 text-sm text-text-secondary">Select a workspace to open Dojo.</div>;
  return <WorkspaceDojo key={activeWorkspace.id} workspaceId={activeWorkspace.id} />;
}
function WorkspaceDojo({ workspaceId }: { workspaceId: string }) {
  const [config, setConfig] = useState<DojoConfig | null>(null);
  const [draft, setDraft] = useState<DojoConfigInput | null>(null);
  const [reports, setReports] = useState<DojoReport[]>([]);
  const [data, setData] = useState<DojoAnalytics | null>(null);
  const [days, setDays] = useState(30);
  const [loadedDays, setLoadedDays] = useState<number | null>(null);
  const [actionError, setActionError] = useState<{
    action: 'save' | 'run';
    message: string;
  } | null>(null);
  const [tab, setTab] = useState<'analytics' | 'coaching'>('analytics');
  const [selected, setSelected] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [customSchedule, setCustomSchedule] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    const results = await Promise.allSettled([
      window.anvil.dojo.getConfig(workspaceId),
      window.anvil.dojo.listReports(workspaceId),
      window.anvil.dojo.getAnalytics(workspaceId, days),
    ]);
    if (id !== request.current) return;
    const [c, r, a] = results;
    if (c.status === 'fulfilled') {
      setConfig(c.value);
      setDraft((d) => d ?? c.value);
    }
    if (r.status === 'fulfilled') setReports(r.value);
    if (a.status === 'fulfilled') {
      setData(a.value);
      setLoadedDays(days);
    }
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [
            `${['Settings', 'Reviews', 'Performance'][index]}: ${result.reason instanceof Error ? result.reason.message : 'Could not load data.'}`,
          ]
        : [],
    );
    setError(failures.length ? failures.join(' ') : null);
    setLoading(false);
  }, [workspaceId, days]);
  useEffect(() => {
    setLoading(true);
    void load();
    return () => {
      request.current++;
    };
  }, [load]);
  const running = reports.some((r) => r.status === 'running');
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const nextReports = await window.anvil.dojo.listReports(workspaceId);
        if (cancelled) return;
        setReports(nextReports);
        if (!nextReports.some((r) => r.status === 'running')) void load();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not refresh the review.');
      }
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [running, load, workspaceId]);
  const report = reports.find((r) => r.id === selected) ?? reports[0] ?? null;
  const save = async () => {
    if (!draft) return;
    request.current++;
    setLoading(false);
    setBusy(true);
    setActionError(null);
    try {
      const c = await window.anvil.dojo.updateConfig(workspaceId, draft);
      setConfig(c);
      setDraft(c);
      await load();
    } catch (e) {
      setActionError({
        action: 'save',
        message: e instanceof Error ? e.message : 'Could not save settings.',
      });
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    request.current++;
    setLoading(false);
    setBusy(true);
    setActionError(null);
    try {
      const r = await window.anvil.dojo.runNow(workspaceId);
      setReports((rs) => [r, ...rs.filter((x) => x.id !== r.id)]);
      setSelected(r.id);
      setTab('coaching');
      await load();
    } catch (e) {
      setActionError({
        action: 'run',
        message: e instanceof Error ? e.message : 'Could not start review.',
      });
    } finally {
      setBusy(false);
    }
  };
  const dirty =
    !!config &&
    !!draft &&
    (config.enabled !== draft.enabled ||
      config.lookbackDays !== draft.lookbackDays ||
      config.scheduleCron !== draft.scheduleCron ||
      config.timezone !== draft.timezone);
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <ViewHeader
        icon={Target}
        title="Dojo"
        description="Turn execution evidence into better habits and skills."
        actions={
          <div className="flex gap-2">
            <button
              className={buttonClass}
              onClick={() => void load()}
              disabled={loading || busy}
              aria-label="Refresh Dojo"
            >
              <RefreshCw
                size={15}
                className={loading ? 'animate-spin motion-reduce:animate-none' : undefined}
              />
            </button>
            <button
              className={buttonClass}
              onClick={() => setSettingsOpen((v) => !v)}
              aria-expanded={settingsOpen}
            >
              <Settings2 size={15} />
              Review settings
            </button>
            <button
              className={`${buttonClass} border-accent/50 bg-accent/10 text-accent`}
              disabled={!config || running || busy || loading}
              onClick={() => void run()}
            >
              {running ? (
                <Loader2 size={15} className="animate-spin motion-reduce:animate-none" />
              ) : (
                <Play size={15} />
              )}{' '}
              {running ? 'Reviewing' : 'Review now'}
            </button>
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[1500px] space-y-6 p-5 lg:p-7">
          {error && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-lg border border-error/40 bg-error/10 p-4 text-sm text-error"
            >
              <span>{error}</span>
              <button
                className={buttonClass}
                disabled={loading || busy}
                onClick={() => void load()}
              >
                Reload Dojo
              </button>
            </div>
          )}
          {actionError && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-lg border border-error/40 bg-error/10 p-4 text-sm text-error"
            >
              <span>{actionError.message}</span>
              <button
                className={buttonClass}
                disabled={busy || loading || (actionError.action === 'run' && running)}
                onClick={() => void (actionError.action === 'save' ? save() : run())}
              >
                {actionError.action === 'save' ? 'Retry save' : 'Retry review'}
              </button>
            </div>
          )}
          <p className="text-xs text-text-tertiary">
            Review now sends conversation samples from the last {config?.lookbackDays ?? 30} days to
            your configured model. Scheduled reviews are {config?.enabled ? 'on' : 'off'}.
          </p>
          {settingsOpen && draft && (
            <fieldset
              disabled={busy}
              className="rounded-xl border border-border bg-bg-secondary p-5"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-text-primary">Scheduled coaching</h2>
                  <p className="mt-1 text-xs text-text-tertiary">
                    Choose whether reviews run automatically. You can always start a one-off review.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="Enable scheduled Dojo reviews"
                  aria-checked={draft.enabled}
                  onClick={() => setDraft((d) => d && { ...d, enabled: !d.enabled })}
                  className={`relative h-6 w-11 shrink-0 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${draft.enabled ? 'bg-accent' : 'bg-bg-elevated'}`}
                >
                  <span
                    className={`absolute left-0 top-1 h-4 w-4 rounded-full bg-white transition-transform motion-reduce:transition-none ${draft.enabled ? 'translate-x-6' : 'translate-x-1'}`}
                  />
                </button>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <label className="text-xs text-text-tertiary">
                  Review period
                  <select
                    className={`${fieldClass} mt-1 block w-full`}
                    value={draft.lookbackDays}
                    onChange={(e) => setDraft({ ...draft, lookbackDays: Number(e.target.value) })}
                  >
                    {[...new Set([7, 14, 30, 60, 90, draft.lookbackDays])]
                      .sort((a, b) => a - b)
                      .map((d) => (
                        <option key={d} value={d}>
                          Last {d} days
                        </option>
                      ))}
                  </select>
                </label>
                <label className="text-xs text-text-tertiary">
                  Schedule
                  <select
                    className={`${fieldClass} mt-1 block w-full`}
                    value={
                      customSchedule ||
                      !['0 9 * * *', '0 9 * * 1', '0 9 1 * *'].includes(draft.scheduleCron)
                        ? 'custom'
                        : draft.scheduleCron
                    }
                    onChange={(e) => {
                      setCustomSchedule(e.target.value === 'custom');
                      if (e.target.value !== 'custom')
                        setDraft({ ...draft, scheduleCron: e.target.value });
                    }}
                  >
                    <option value="0 9 * * *">Daily at 09:00</option>
                    <option value="0 9 * * 1">Mondays at 09:00</option>
                    <option value="0 9 1 * *">Monthly on the 1st at 09:00</option>
                    <option value="custom">Custom schedule</option>
                  </select>
                  {(customSchedule ||
                    !['0 9 * * *', '0 9 * * 1', '0 9 1 * *'].includes(draft.scheduleCron)) && (
                    <input
                      aria-label="Custom cron schedule"
                      className={`${fieldClass} mt-2 block w-full font-mono`}
                      value={draft.scheduleCron}
                      onChange={(e) => setDraft({ ...draft, scheduleCron: e.target.value })}
                      placeholder="minute hour day month weekday"
                    />
                  )}
                </label>
                <label className="text-xs text-text-tertiary">
                  Timezone
                  <input
                    className={`${fieldClass} mt-1 block w-full`}
                    value={draft.timezone}
                    onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
                  />
                </label>
                <button
                  className={`${buttonClass} self-start sm:mt-5`}
                  disabled={!dirty || busy}
                  onClick={() => void save()}
                >
                  {busy ? 'Saving…' : 'Save settings'}
                </button>
              </div>
              <p className="mt-3 text-xs text-text-tertiary">
                {dirty
                  ? 'Save to apply schedule changes.'
                  : config?.enabled
                    ? `Next review: ${config.nextRunAt ? `${new Date(config.nextRunAt).toLocaleString(undefined, { timeZone: config.timezone })} (${config.timezone})` : 'Not scheduled'}`
                    : 'Scheduled reviews are off.'}{' '}
                Keep Anvil open until a manual review finishes.
              </p>
            </fieldset>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-2" aria-label="Dojo sections">
              <button
                className={`${buttonClass} ${tab === 'analytics' ? 'border-accent/50 bg-accent/10 text-accent' : ''}`}
                aria-pressed={tab === 'analytics'}
                onClick={() => setTab('analytics')}
              >
                Performance
              </button>
              <button
                className={`${buttonClass} ${tab === 'coaching' ? 'border-accent/50 bg-accent/10 text-accent' : ''}`}
                aria-pressed={tab === 'coaching'}
                onClick={() => setTab('coaching')}
              >
                Coaching & skills
              </button>
            </div>
            {tab === 'analytics' ? (
              <label className="flex items-center gap-2 text-xs text-text-tertiary">
                Window
                <select
                  className={fieldClass}
                  value={days}
                  disabled={busy}
                  onChange={(e) => setDays(Number(e.target.value))}
                >
                  {[7, 14, 30, 60, 90, 180, 365].map((d) => (
                    <option key={d} value={d}>
                      Last {d} days
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <select
                aria-label="Previous reviews"
                className={`${fieldClass} max-w-full`}
                value={report?.id ?? ''}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="" disabled>
                  Select a review
                </option>
                {reports.map((r) => (
                  <option key={r.id} value={r.id}>
                    {new Date(r.windowStart).toLocaleDateString()} to{' '}
                    {new Date(r.windowEnd).toLocaleDateString()} · {r.status}
                  </option>
                ))}
              </select>
            )}
          </div>
          {loading && (
            <div role="status" className="flex items-center gap-2 text-sm text-text-tertiary">
              <Loader2 className="animate-spin motion-reduce:animate-none" size={16} />
              Refreshing workspace evidence…
            </div>
          )}
          {data && loadedDays !== days && (
            <p role="status" className="text-sm text-warning">
              Showing the last {loadedDays} days.{' '}
              {loading
                ? `Loading the requested ${days}-day window.`
                : `The requested ${days}-day window could not be loaded. Reload Dojo to retry.`}
            </p>
          )}
          <div hidden={tab !== 'analytics'} aria-busy={loading}>
            {data && <DojoAnalyticsPanel data={data} onRefresh={load} />}
          </div>
          <div hidden={tab !== 'coaching'}>
            <DojoCoachingPanel
              key={report?.id ?? 'empty'}
              report={report}
              data={data}
              onUpdate={load}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
