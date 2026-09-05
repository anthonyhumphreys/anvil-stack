import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Download, Search, X } from 'lucide-react';
import type { DojoAnalytics, DojoOutcome, DojoPrice, DojoRun } from '../../../shared/dojo-types';
import { buttonClass, count, downloadText, duration, fieldClass, money } from './dojo-format';

const colors: Record<DojoOutcome, string> = {
  completed: 'var(--color-success)',
  failed: 'var(--color-error)',
  interrupted: 'var(--color-warning)',
  unfinished: 'var(--color-info)',
  unknown: 'var(--color-text-muted)',
};
const outcomeClass: Record<DojoOutcome, string> = {
  completed: 'text-success',
  failed: 'text-error',
  interrupted: 'text-warning',
  unfinished: 'text-info',
  unknown: 'text-text-tertiary',
};
function percent(value: number, total: number) {
  return total ? `${Math.round((value / total) * 100)}%` : 'No data';
}
function change(now: number | null, before: number | null, suffix = '') {
  if (now === null || before === null) return 'No comparable baseline';
  const diff = now - before;
  return `${diff > 0 ? '+' : ''}${diff.toFixed(1)}${suffix} vs previous period`;
}

export function DojoAnalyticsPanel({
  data,
  onRefresh,
}: {
  data: DojoAnalytics;
  onRefresh: () => void;
}) {
  const [tab, setTab] = useState<'overview' | 'runs' | 'usage'>('overview');
  const [search, setSearch] = useState('');
  const [outcome, setOutcome] = useState('all');
  const [provider, setProvider] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [trend, setTrend] = useState<'duration' | 'tokens' | 'cost' | 'corrections'>('duration');
  const [error, setError] = useState<string | null>(null);
  const p = data.current;
  const dateFormat = useMemo(
    () =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: data.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }),
    [data.timezone],
  );
  const filtered = useMemo(
    () =>
      data.runs.filter(
        (r) =>
          (outcome === 'all' || r.outcome === outcome) &&
          (provider === 'all' || r.provider === provider) &&
          (!day || dateFormat.format(new Date(r.startedAt)) === day) &&
          `${r.title} ${r.model} ${r.workItem ?? ''} ${r.role}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [data.runs, outcome, provider, day, search, dateFormat],
  );
  const active = data.runs.find((r) => r.id === selected);
  const failures = useMemo(() => {
    const groups = new Map<string, { label: string; count: number; run: string }>();
    for (const r of data.runs)
      for (const f of r.failures) {
        const g = groups.get(f.label) ?? { label: f.label, count: 0, run: r.id };
        g.count++;
        groups.set(f.label, g);
      }
    return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 5);
  }, [data.runs]);
  const roles = useMemo(() => {
    const groups = new Map<
      string,
      {
        name: string;
        runs: number;
        tokens: number;
        ms: number;
        cost: number | null;
        measured: number;
      }
    >();
    for (const r of data.runs) {
      const g = groups.get(r.role) ?? {
        name: r.role,
        runs: 0,
        tokens: 0,
        ms: 0,
        cost: null,
        measured: 0,
      };
      g.runs++;
      g.ms += r.durationMs ?? 0;
      if (r.usage) {
        g.tokens += r.usage.input + r.usage.output;
        g.measured++;
      }
      if (r.cost !== null) g.cost = (g.cost ?? 0) + r.cost;
      groups.set(r.role, g);
    }
    return [...groups.values()].sort((a, b) => b.tokens - a.tokens || b.ms - a.ms);
  }, [data.runs]);
  const jump = (id: string) => {
    setSelected(id);
    setTab('runs');
  };
  const filterOutcome = (value: string) => {
    setOutcome(value);
    setDay(null);
    setTab('runs');
  };
  return (
    <section className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex flex-wrap gap-1" aria-label="Analytics sections">
          {(['overview', 'runs', 'usage'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={`${buttonClass} ${tab === t ? 'bg-bg-elevated text-text-primary border-accent/50' : 'border-transparent'}`}
            >
              {t === 'overview' ? 'Overview' : t === 'runs' ? `Runs · ${p.runs}` : 'Usage & roles'}
            </button>
          ))}
        </div>
        <span className="text-xs text-text-tertiary">
          {new Date(data.windowStart).toLocaleDateString()} to{' '}
          {new Date(data.windowEnd).toLocaleDateString()} · {data.timezone}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      {tab === 'overview' && (
        <>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(250px,1fr)]">
            <div className="min-w-0 border-b border-border pb-5">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-lg font-semibold text-text-primary">Session outcomes</h2>
                <span className="text-xs text-text-tertiary">{p.runs} sessions</span>
              </div>
              <div
                className="my-5 flex h-10 overflow-hidden rounded-md bg-bg-tertiary"
                aria-label="Execution outcomes"
              >
                {(Object.keys(colors) as DojoOutcome[])
                  .filter((o) => p[o] > 0)
                  .map((o) => (
                    <button
                      key={o}
                      onClick={() => filterOutcome(o)}
                      style={{ width: `${(p[o] / p.runs) * 100}%`, backgroundColor: colors[o] }}
                      className="min-w-1 opacity-80 transition-opacity hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-text-primary"
                      title={`${p[o]} ${o}`}
                      aria-label={`Show ${p[o]} ${o} sessions`}
                    />
                  ))}
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {(Object.keys(colors) as DojoOutcome[]).map((o) => (
                  <button
                    key={o}
                    onClick={() => filterOutcome(o)}
                    className={`text-sm capitalize underline-offset-4 hover:underline ${outcomeClass[o]}`}
                  >
                    <span className="font-semibold tabular-nums">{p[o]}</span> {o}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-xs text-text-tertiary">
                Completion means the agent finished its turn. Delivery is tracked separately.
              </p>
              <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-border-subtle pt-5">
                <div>
                  <p className="text-xs text-text-tertiary">Typical session · median / p90</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums text-text-primary">
                    {p.medianMs === null ? 'No closed sessions' : duration(p.medianMs)}{' '}
                    <span className="text-sm font-normal text-text-tertiary">
                      / {p.p90Ms === null ? '—' : duration(p.p90Ms)}
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-text-tertiary">
                    {change(
                      p.medianMs === null ? null : p.medianMs / 60000,
                      data.previous.medianMs === null ? null : data.previous.medianMs / 60000,
                      'm',
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-text-tertiary">Corrections / 100 user messages</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums text-text-primary">
                    {p.correctionRate?.toFixed(1) ?? 'No messages'}
                  </p>
                  <p className="mt-1 text-xs text-text-tertiary">
                    {change(p.correctionRate, data.previous.correctionRate, ' points')}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-text-tertiary">Observed consumption</p>
                  <button
                    className="mt-1 text-xl font-semibold tabular-nums text-info hover:underline"
                    onClick={() => setTab('usage')}
                  >
                    {p.measuredRuns ? `${count(p.tokens)} tokens` : 'Unavailable'}
                  </button>
                  <p className="mt-1 text-xs text-text-tertiary">
                    {p.measuredRuns}/{p.runs} sessions report tokens
                  </p>
                </div>
                <div>
                  <p className="text-xs text-text-tertiary">Recorded cost · USD</p>
                  <button
                    className="mt-1 text-xl font-semibold tabular-nums text-info hover:underline"
                    onClick={() => setTab('usage')}
                  >
                    {money(p.cost)}
                  </button>
                  <p className="mt-1 text-xs text-text-tertiary">
                    {p.pricedRuns}/{p.runs} sessions have cost evidence
                  </p>
                </div>
              </div>
            </div>
            <div className="min-w-0 border-b border-border pb-5">
              <h2 className="text-sm font-semibold text-text-primary">Next moves</h2>
              <div className="mt-3 divide-y divide-border-subtle">
                {p.failed > 0 && (
                  <button
                    onClick={() => filterOutcome('failed')}
                    className="flex w-full items-center justify-between gap-3 py-3 text-left text-sm text-text-primary"
                  >
                    <span>
                      Inspect {p.failed} failed sessions
                      <span className="mt-1 block text-xs text-text-tertiary">
                        Find the blocker before another run.
                      </span>
                    </span>
                    <ArrowUpRight size={16} />
                  </button>
                )}
                {p.measuredRuns < p.runs && (
                  <button
                    onClick={() => setTab('usage')}
                    className="flex w-full items-center justify-between gap-3 py-3 text-left text-sm text-text-primary"
                  >
                    <span>
                      Check usage coverage
                      <span className="mt-1 block text-xs text-text-tertiary">
                        {p.runs - p.measuredRuns} sessions lack measured tokens.
                      </span>
                    </span>
                    <ArrowUpRight size={16} />
                  </button>
                )}
                <div className="py-3 text-sm text-text-primary">
                  {p.retries} command repeats after failure
                  <p className="mt-1 text-xs text-text-tertiary">
                    Same-command repeats are inferred retries.
                  </p>
                </div>
                <div className="py-3 text-sm text-text-primary">
                  Review health
                  <p className="mt-1 text-xs text-text-tertiary">
                    {data.reviews.completed} complete · {data.reviews.failed} failed ·{' '}
                    {data.reviews.running} running
                  </p>
                  {data.reviews.latestError && (
                    <p className="mt-2 break-words text-xs text-error">
                      {data.reviews.latestError}
                    </p>
                  )}
                </div>
              </div>
              <Link
                to="/diagnostics"
                className="mt-3 inline-flex items-center gap-1 text-xs text-info underline underline-offset-4"
              >
                Open diagnostics <ArrowUpRight size={12} />
              </Link>
            </div>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="min-w-0">
              <div className="flex justify-between gap-3">
                <h3 className="text-sm font-semibold text-text-primary">Daily activity</h3>
                <span className="text-xs text-text-tertiary">Select a day to inspect</span>
              </div>
              <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(22px,1fr))] gap-1.5">
                {data.days.map((d) => (
                  <button
                    key={d.date}
                    onClick={() => {
                      setDay(d.date);
                      setOutcome('all');
                      setTab('runs');
                    }}
                    aria-label={`${d.date}: ${d.runs} sessions, ${d.failed} failed, ${d.corrections} corrections`}
                    title={`${d.date} · ${d.runs} sessions · ${d.failed} failed`}
                    className={`aspect-square rounded-sm border focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${d.failed ? 'border-error/60 bg-error/25' : d.runs ? 'border-info/50 bg-info/25' : 'border-border-subtle bg-bg-secondary'}`}
                    style={{ opacity: d.runs ? Math.min(1, 0.45 + d.runs / 8) : 1 }}
                  />
                ))}
              </div>
              <div className="mt-3 flex justify-between text-xs text-text-tertiary">
                <span>{data.days[0]?.date}</span>
                <span>Red = failures · Blue = activity</span>
                <span>{data.days.at(-1)?.date}</span>
              </div>
            </section>
            <section className="min-w-0">
              <h3 className="text-sm font-semibold text-text-primary">Session trends</h3>
              <div className="mt-2 flex flex-wrap gap-3">
                {(['duration', 'tokens', 'cost', 'corrections'] as const).map((metric) => (
                  <button
                    key={metric}
                    onClick={() => setTrend(metric)}
                    aria-pressed={trend === metric}
                    className={`text-xs capitalize underline-offset-4 ${trend === metric ? 'text-info underline' : 'text-text-tertiary hover:text-text-primary'}`}
                  >
                    {metric}
                  </button>
                ))}
              </div>
              <DurationPlot runs={data.runs} onSelect={jump} metric={trend} />
              <p className="text-xs text-text-tertiary">
                Each point opens its session. Missing measurements are omitted; duration includes
                pauses.
              </p>
            </section>
          </div>
          <section>
            <h3 className="text-sm font-semibold text-text-primary">Recurring blockers</h3>
            {failures.length === 0 ? (
              <p className="mt-3 text-sm text-text-tertiary">No failures in the captured events.</p>
            ) : (
              <div className="mt-3 divide-y divide-border-subtle">
                {failures.map((f) => (
                  <button
                    key={f.label}
                    onClick={() => jump(f.run)}
                    className="flex w-full items-start justify-between gap-4 py-3 text-left text-sm text-text-secondary hover:text-text-primary"
                  >
                    <span className="min-w-0 break-words">{f.label}</span>
                    <span className="shrink-0 tabular-nums text-error">
                      {f.count}× <ArrowUpRight size={12} className="inline" />
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </>
      )}
      {tab === 'runs' && (
        <>
          <div className="flex flex-wrap gap-2">
            <label className="relative min-w-48 flex-1">
              <Search size={14} className="absolute left-3 top-3 text-text-tertiary" />
              <input
                aria-label="Search runs"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Find a task, model, or work item"
                className={`${fieldClass} w-full pl-9`}
              />
            </label>
            <select
              aria-label="Filter outcome"
              className={fieldClass}
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
            >
              <option value="all">All outcomes</option>
              {Object.keys(colors).map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
            <select
              aria-label="Filter provider"
              className={fieldClass}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="all">All providers</option>
              {[...new Set(data.runs.map((r) => r.provider))].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <button
              className={buttonClass}
              onClick={() =>
                downloadText(
                  'dojo-runs.json',
                  JSON.stringify(
                    { windowStart: data.windowStart, windowEnd: data.windowEnd, runs: filtered },
                    null,
                    2,
                  ),
                  'application/json',
                )
              }
            >
              <Download size={14} />
              Export
            </button>
          </div>
          {day && (
            <button className={buttonClass} onClick={() => setDay(null)}>
              {day}
              <X size={12} />
            </button>
          )}
          {active && <RunDetail run={active} onClose={() => setSelected(null)} />}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs text-text-tertiary">
                <tr>
                  {['Session', 'Outcome', 'Wall time', 'Tokens', 'Cost'].map((h) => (
                    <th className="px-3 py-3 font-medium" key={h}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {filtered.slice(0, 200).map((r) => (
                  <tr
                    key={r.id}
                    className={selected === r.id ? 'bg-bg-elevated' : 'hover:bg-bg-secondary'}
                  >
                    <td className="max-w-sm px-3 py-3">
                      <button
                        onClick={() => setSelected(r.id)}
                        className="block text-left text-text-primary hover:underline"
                      >
                        {r.title}
                      </button>
                      <span className="mt-1 block text-xs text-text-tertiary">
                        {r.provider} · {r.model} · {new Date(r.startedAt).toLocaleDateString()}
                      </span>
                    </td>
                    <td className={`px-3 py-3 text-xs capitalize ${outcomeClass[r.outcome]}`}>
                      {r.outcome}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 tabular-nums text-text-secondary">
                      {duration(r.durationMs)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 tabular-nums text-text-secondary">
                      {r.usage
                        ? count(r.usage.input + r.usage.output)
                        : `~${count(r.estimatedTokens)}`}
                      <span className="block text-xs text-text-tertiary">
                        {r.usage ? 'observed' : 'text estimate'}
                      </span>
                    </td>
                    <td className="px-3 py-3 tabular-nums text-text-secondary">{money(r.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-text-tertiary">
            {filtered.length > 200
              ? `Showing 200 of ${filtered.length}. Narrow the filters or export all matches.`
              : `${filtered.length} matching sessions`}
          </p>
        </>
      )}
      {tab === 'usage' && (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <h3 className="text-sm font-semibold text-text-primary">Coverage by provider</h3>
              <div className="mt-4 space-y-5">
                {[...new Set(data.runs.map((r) => r.provider))].map((provider) => {
                  const runs = data.runs.filter((r) => r.provider === provider);
                  const measured = runs.filter((r) => r.usage).length;
                  return (
                    <div key={provider}>
                      <div className="flex justify-between text-sm">
                        <span className="capitalize text-text-primary">{provider}</span>
                        <span className="text-text-tertiary">
                          {measured}/{runs.length} with tokens
                        </span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-sm bg-bg-tertiary">
                        <div
                          className="h-full bg-info"
                          style={{
                            width: runs.length ? `${(measured / runs.length) * 100}%` : '0%',
                          }}
                        />
                      </div>
                      <p className="mt-2 text-xs text-text-tertiary">
                        {
                          runs.filter((r) => r.outcome !== 'unknown' && r.outcome !== 'unfinished')
                            .length
                        }{' '}
                        known outcomes · {runs.filter((r) => r.cost !== null).length} with cost
                      </p>
                    </div>
                  );
                })}
              </div>
              <p className="mt-4 text-xs leading-relaxed text-text-tertiary">
                Provider-reported usage is counted once. Missing history remains unavailable. Text
                estimates exclude tool context and are never priced.
              </p>
            </section>
            <section>
              <h3 className="text-sm font-semibold text-text-primary">
                Consumption by session role
              </h3>
              <div className="mt-4 space-y-4">
                {roles.map((r) => (
                  <div key={r.name}>
                    <div className="flex justify-between gap-3 text-sm">
                      <span className="capitalize text-text-primary">{r.name}</span>
                      <span className="tabular-nums text-text-secondary">
                        {count(r.tokens)} tokens
                      </span>
                    </div>
                    <div className="mt-2 h-2 bg-bg-tertiary">
                      <div
                        className="h-full bg-accent/70"
                        style={{ width: p.tokens ? `${(r.tokens / p.tokens) * 100}%` : '0%' }}
                      />
                    </div>
                    <p className="mt-1 text-xs text-text-tertiary">
                      {r.runs} sessions · {duration(r.ms)} closed-session wall time ·{' '}
                      {money(r.cost)} · {r.measured}/{r.runs} measured
                    </p>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-xs text-text-tertiary">
                Child-agent activity appears in run details. Parent usage is not allocated to child
                roles without attribution.
              </p>
            </section>
          </div>
          <UsageTable data={data} onRefresh={onRefresh} onError={setError} />
          <PriceEditor
            prices={data.prices}
            runs={data.runs}
            onSaved={onRefresh}
            onError={setError}
          />
        </>
      )}
    </section>
  );
}
function DurationPlot({
  runs,
  onSelect,
  metric,
}: {
  runs: DojoRun[];
  onSelect: (id: string) => void;
  metric: 'duration' | 'tokens' | 'cost' | 'corrections';
}) {
  const value = (r: DojoRun) =>
    metric === 'duration'
      ? r.durationMs
      : metric === 'tokens'
        ? r.usage
          ? r.usage.input + r.usage.output
          : null
        : metric === 'cost'
          ? r.cost
          : r.corrections;
  const format = (n: number) =>
    metric === 'duration' ? duration(n) : metric === 'cost' ? money(n) : count(n);
  const points = runs
    .filter((r) => value(r) !== null)
    .slice()
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const max = Math.max(1, ...points.map((r) => value(r)!));
  return (
    <svg
      viewBox="0 0 520 150"
      role="group"
      aria-label={`${metric} by session, oldest to newest`}
      className="my-3 h-36 w-full overflow-visible"
    >
      {[0, 0.5, 1].map((t) => (
        <g key={t}>
          <line
            x1="45"
            x2="510"
            y1={125 - t * 105}
            y2={125 - t * 105}
            stroke="currentColor"
            className="text-border-subtle"
          />
          <text
            x="0"
            y={129 - t * 105}
            fill="currentColor"
            className="text-text-tertiary"
            fontSize="10"
          >
            {format(max * t)}
          </text>
        </g>
      ))}
      {points.map((r, i) => (
        <circle
          key={r.id}
          cx={55 + (i / Math.max(1, points.length - 1)) * 445}
          cy={125 - (value(r)! / max) * 105}
          r="4"
          fill={colors[r.outcome]}
          role="button"
          tabIndex={0}
          aria-label={`${r.title}, ${format(value(r)!)}, ${r.outcome}`}
          onClick={() => onSelect(r.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect(r.id);
            }
          }}
          className="cursor-pointer focus:outline focus:outline-2 focus:outline-accent"
        >
          <title>
            {r.title} · {format(value(r)!)}
          </title>
        </circle>
      ))}
    </svg>
  );
}
function RunDetail({ run: r, onClose }: { run: DojoRun; onClose: () => void }) {
  const max = Math.max(1, r.durationMs ?? Date.now() - Date.parse(r.startedAt));
  return (
    <section className="rounded-xl border border-border bg-bg-secondary p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-text-primary">{r.title}</h3>
          <p className="mt-1 text-xs text-text-tertiary">
            {r.provider} · {r.model} · {r.role} · {r.workItem ?? 'No linked work item'}
          </p>
        </div>
        <button className={buttonClass} onClick={onClose} aria-label="Close run details">
          <X size={14} />
        </button>
      </div>
      <Link
        to={`/chat?thread=${encodeURIComponent(r.threadId)}`}
        className="mt-3 inline-flex items-center gap-1 text-sm text-info underline underline-offset-4"
      >
        Open conversation <ArrowUpRight size={14} />
      </Link>
      <dl className="my-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          ['Tools', r.tools],
          ['Corrections', `${r.corrections}/${r.userMessages}`],
          ['Completed goals', r.goalsCompleted],
          ['Compactions', r.contextCompactions],
          ['Input tokens', r.usage ? count(r.usage.input) : 'Unavailable'],
          ['Cached input', r.usage ? count(r.usage.cachedInput) : 'Unavailable'],
          ['Output tokens', r.usage ? count(r.usage.output) : 'Unavailable'],
          [
            'Context used',
            r.contextPercent === null ? 'Unavailable' : `${r.contextPercent.toFixed(1)}%`,
          ],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-text-tertiary">{k}</dt>
            <dd className="mt-1 text-sm tabular-nums text-text-primary">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-text-tertiary">
        {r.usageCount} usage observations · {r.pricedUsageCount} priced snapshots. Recorded cost may
        cover only part of a session.
      </p>
      {r.agents.length > 0 && (
        <div className="mt-5">
          <h4 className="text-sm font-semibold text-text-primary">Observed agent activity</h4>
          <div className="mt-3 space-y-3">
            {r.agents.map((a) => {
              const offset = Math.max(
                0,
                ((Date.parse(a.startedAt) - Date.parse(r.startedAt)) / max) * 100,
              );
              const width = Math.max(
                1,
                ((Date.parse(a.endedAt ?? r.endedAt ?? a.startedAt) - Date.parse(a.startedAt)) /
                  max) *
                  100,
              );
              return (
                <div key={a.id}>
                  <div className="mb-1 flex justify-between gap-2 text-xs text-text-secondary">
                    <span>
                      {a.label} · {a.model}
                    </span>
                    <span>{a.status}</span>
                  </div>
                  <div className="h-3 overflow-hidden rounded-sm bg-bg-tertiary">
                    <div
                      className="h-full bg-info/65"
                      style={{
                        marginLeft: `${Math.min(99, offset)}%`,
                        width: `${Math.min(100 - offset, width)}%`,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-text-tertiary">
            First to last observed state, not CPU time. Unreported child tokens are not inferred.
          </p>
        </div>
      )}
      {r.failures.length > 0 && (
        <div className="mt-5">
          <h4 className="text-sm font-semibold text-error">Failure evidence</h4>
          {r.failures.map((f, i) => (
            <p key={i} className="mt-2 break-words text-xs text-text-secondary">
              {new Date(f.timestamp).toLocaleTimeString()} · {f.label}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
function UsageTable({
  data,
  onRefresh,
  onError,
}: {
  data: DojoAnalytics;
  onRefresh: () => void;
  onError: (error: string | null) => void;
}) {
  const [savingDelivery, setSavingDelivery] = useState<string | null>(null);
  const markDelivery = async (item: string, completed: boolean) => {
    setSavingDelivery(item);
    onError(null);
    try {
      await window.anvil.dojo.setDelivery(data.workspaceId, item, completed);
      onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not update delivery.');
    } finally {
      setSavingDelivery(null);
    }
  };
  const months = new Map<string, DojoRun[]>();
  for (const r of data.runs) {
    const key = new Intl.DateTimeFormat('en-CA', {
      timeZone: data.timezone,
      year: 'numeric',
      month: '2-digit',
    }).format(new Date(r.startedAt));
    const rs = months.get(key) ?? [];
    rs.push(r);
    months.set(key, rs);
  }
  const items = new Map<string, DojoRun[]>();
  for (const r of data.runs) {
    if (r.workItem) {
      const rs = items.get(r.workItem) ?? [];
      rs.push(r);
      items.set(r.workItem, rs);
    }
  }
  const completedItems = [...items].filter(([item]) =>
    data.deliveries.some((d) => d.workItem === item),
  );
  const pricedCompleted = completedItems.filter(([, rs]) => rs.every((r) => r.cost !== null));
  const costPerDelivery = pricedCompleted.length
    ? pricedCompleted.reduce((total, [, rs]) => total + rs.reduce((n, r) => n + r.cost!, 0), 0) /
      pricedCompleted.length
    : null;
  return (
    <>
      <section>
        <h3 className="text-sm font-semibold text-text-primary">Monthly accounting</h3>
        <p className="mt-1 text-xs text-text-tertiary">
          Grouped by session-start month in {data.timezone}, limited to the selected window.
        </p>
        <div className="mt-3 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs text-text-tertiary">
              <tr>
                {[
                  'Month',
                  'Observed tokens',
                  'Estimated text only',
                  'Cache share',
                  'Recorded cost',
                ].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...months].map(([month, rs]) => {
                const measured = rs.filter((r) => r.usage);
                const input = measured.reduce((n, r) => n + r.usage!.input, 0);
                const cached = measured.reduce((n, r) => n + r.usage!.cachedInput, 0);
                const costs = rs.filter((r) => r.cost !== null);
                return (
                  <tr key={month} className="border-b border-border-subtle text-text-secondary">
                    <td className="px-3 py-3">{month}</td>
                    <td className="px-3 py-3">
                      {count(measured.reduce((n, r) => n + r.usage!.input + r.usage!.output, 0))}
                      <span className="block text-xs text-text-tertiary">
                        {measured.length}/{rs.length} sessions
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      ~
                      {count(rs.filter((r) => !r.usage).reduce((n, r) => n + r.estimatedTokens, 0))}
                    </td>
                    <td className="px-3 py-3">{percent(cached, input)}</td>
                    <td className="px-3 py-3">
                      {money(costs.length ? costs.reduce((n, r) => n + r.cost!, 0) : null)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h3 className="text-sm font-semibold text-text-primary">Work-item spend</h3>
        <p className="mt-1 text-xs text-text-tertiary">
          Linked session costs, counted once. Mark delivered only after verifying the work item.
        </p>
        <p className="mt-3 text-sm text-text-secondary">
          {completedItems.length === 0
            ? 'Mark a completed work item to track cost per delivery.'
            : `${money(costPerDelivery)} per marked delivery with cost evidence`}{' '}
          {completedItems.length > 0 && (
            <span className="text-xs text-text-tertiary">
              · {pricedCompleted.length}/{completedItems.length} marked items have recorded cost in
              this window
            </span>
          )}
        </p>
        {items.size === 0 ? (
          <p className="mt-3 text-sm text-text-tertiary">
            Link conversations to work items to compare spend.
          </p>
        ) : (
          <div className="mt-3 divide-y divide-border-subtle">
            {[...items].map(([item, rs]) => {
              const costs = rs.filter((r) => r.cost !== null);
              return (
                <div
                  className="flex justify-between gap-3 py-3 text-sm text-text-secondary"
                  key={item}
                >
                  <span>
                    {item}
                    <span className="block text-xs text-text-tertiary">
                      {rs.length} sessions · {rs.reduce((n, r) => n + r.goalsCompleted, 0)}{' '}
                      completed goals
                    </span>
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="tabular-nums">
                      {money(costs.length ? costs.reduce((n, r) => n + r.cost!, 0) : null)}
                    </span>
                    <button
                      className={buttonClass}
                      disabled={savingDelivery === item}
                      onClick={() =>
                        void markDelivery(item, !data.deliveries.some((d) => d.workItem === item))
                      }
                    >
                      {data.deliveries.some((d) => d.workItem === item)
                        ? 'Delivered · undo'
                        : 'Mark delivered'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
function PriceEditor({
  prices,
  runs,
  onSaved,
  onError,
}: {
  prices: DojoPrice[];
  runs: DojoRun[];
  onSaved: () => void;
  onError: (e: string | null) => void;
}) {
  const [provider, setProvider] = useState('codex');
  const [model, setModel] = useState('');
  const [input, setInput] = useState('');
  const [cached, setCached] = useState('');
  const [output, setOutput] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    onError(null);
    try {
      await window.anvil.dojo.savePrice({
        provider,
        model,
        input: Number(input),
        cachedInput: Number(cached),
        output: Number(output),
      });
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not save pricing.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <details className="rounded-xl border border-border p-4">
      <summary className="cursor-pointer text-sm font-semibold text-text-primary">
        Model pricing · {prices.length} configured
      </summary>
      <p className="mt-3 max-w-[75ch] text-xs leading-relaxed text-text-tertiary">
        USD per million tokens. Rates apply to future usage observations and stay attached to that
        observation. Changing a rate never rewrites history. These are cost estimates, not invoices.
        Pricing is shared across workspaces.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {prices.map((p) => (
          <button
            key={`${p.provider}:${p.model}`}
            className={buttonClass}
            onClick={() => {
              setProvider(p.provider);
              setModel(p.model);
              setInput(String(p.input));
              setCached(String(p.cachedInput));
              setOutput(String(p.output));
            }}
          >
            {p.provider} / {p.model}
          </button>
        ))}
      </div>
      <form
        className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="text-xs text-text-tertiary">
          Provider
          <select
            className={`${fieldClass} mt-1 block w-full`}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            {['codex', 'cursor', 'openai', 'azure'].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-text-tertiary">
          Model
          <input
            required
            value={model}
            onChange={(e) => setModel(e.target.value)}
            list="dojo-models"
            className={`${fieldClass} mt-1 block w-full`}
          />
          <datalist id="dojo-models">
            {[
              ...new Set(
                runs
                  .filter((r) => r.provider === provider && r.model !== 'unknown')
                  .map((r) => r.model),
              ),
            ].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </datalist>
        </label>
        {(
          [
            ['Input', input, setInput],
            ['Cached input', cached, setCached],
            ['Output', output, setOutput],
          ] as const
        ).map(([label, value, set]) => (
          <label key={label} className="text-xs text-text-tertiary">
            {label}
            <input
              type="number"
              min="0"
              max="1000000"
              step="any"
              required
              className={`${fieldClass} mt-1 block w-full`}
              value={value}
              onChange={(e) => set(e.target.value)}
            />
          </label>
        ))}
        <button className={`${buttonClass} self-end`} disabled={saving}>
          {saving ? 'Saving…' : 'Save future rates'}
        </button>
      </form>
    </details>
  );
}
