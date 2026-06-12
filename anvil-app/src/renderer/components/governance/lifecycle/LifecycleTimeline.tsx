import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Loader2,
  Check,
  AlertTriangle,
  XCircle,
  Clock,
  Zap,
  Shield,
  FileSearch,
  Package,
} from 'lucide-react';
import type {
  LifecycleItem,
  LifecycleStageDefinition,
  GateId,
  GateDecision,
  GateDecisionOutcome,
  GateReadinessResult,
  GateTemplate,
  ImpactAnalysis,
  HandoverPack,
} from '../../../../shared/types';
import { buildGateLabelMap, GATE_ORDER } from '../gate-utils';
import { stageLabel } from './stage-utils';

interface Props {
  item: LifecycleItem;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DECISION_CONFIG: Record<
  GateDecisionOutcome,
  { icon: typeof Check; color: string; label: string }
> = {
  approved: { icon: Check, color: 'text-emerald-400', label: 'Approved' },
  approved_with_conditions: {
    icon: AlertTriangle,
    color: 'text-amber-400',
    label: 'Approved w/ Conditions',
  },
  deferred: { icon: Clock, color: 'text-blue-400', label: 'Deferred' },
  rejected: { icon: XCircle, color: 'text-red-400', label: 'Rejected' },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LifecycleTimeline({ item }: Props) {
  const [decisions, setDecisions] = useState<GateDecision[]>([]);
  const [readiness, setReadiness] = useState<Record<GateId, GateReadinessResult>>(
    {} as Record<GateId, GateReadinessResult>,
  );
  const [templates, setTemplates] = useState<GateTemplate[]>([]);
  const [stages, setStages] = useState<LifecycleStageDefinition[]>([]);
  const [analyses, setAnalyses] = useState<ImpactAnalysis[]>([]);
  const [packs, setPacks] = useState<HandoverPack[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [dec, ia, hp, gateTemplates, lifecycleStages] = await Promise.all([
        window.anvil.lifecycle.listGateDecisions(item.id),
        window.anvil.lifecycle.listImpactAnalyses(item.id),
        window.anvil.lifecycle.listHandoverPacks(item.id),
        window.anvil.lifecycle.getGateTemplates(item.workspaceId),
        window.anvil.lifecycle.listStages(item.workspaceId),
      ]);
      setDecisions(dec);
      setAnalyses(ia);
      setPacks(hp);
      setTemplates(gateTemplates);
      setStages(lifecycleStages);

      // Load readiness for each gate
      const readinessResults = await Promise.all(
        GATE_ORDER.map((g) => window.anvil.lifecycle.checkReadiness(item.id, g)),
      );
      const readinessMap: Record<string, GateReadinessResult> = {};
      for (const r of readinessResults) readinessMap[r.gate] = r;
      setReadiness(readinessMap as Record<GateId, GateReadinessResult>);
    } catch (err) {
      console.error('Failed to load timeline data:', err);
    } finally {
      setLoading(false);
    }
  }, [item.id, item.workspaceId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const gateLabels = useMemo(() => buildGateLabelMap(templates), [templates]);
  const timelineStages = useMemo(
    () =>
      (stages.length > 0
        ? stages
        : [{ id: item.stage, label: stageLabel(item.stage, []), order: 0 }]
      ).map((stage, index) => ({
        ...stage,
        gate: GATE_ORDER[index],
      })),
    [item.stage, stages],
  );
  const currentStageIdx = Math.max(
    0,
    timelineStages.findIndex((stage) => stage.id === item.stage),
  );

  // Build timeline events sorted by date
  const events = useMemo(() => {
    const evts: Array<{
      date: string;
      type: 'decision' | 'analysis' | 'handover' | 'created';
      icon: typeof Check;
      color: string;
      title: string;
      detail?: string;
      gate?: GateId;
    }> = [];

    // Item created
    evts.push({
      date: item.createdAt,
      type: 'created',
      icon: Zap,
      color: 'text-accent',
      title: 'Lifecycle item created',
      detail: item.title,
    });

    for (const d of decisions) {
      const cfg = DECISION_CONFIG[d.decision];
      evts.push({
        date: d.decidedAt,
        type: 'decision',
        icon: cfg.icon,
        color: cfg.color,
        title: `${gateLabels[d.gate]}: ${cfg.label}`,
        detail:
          d.conditions || d.rationale
            ? `${d.decidedBy}${d.conditions ? ` — ${d.conditions}` : ''}`
            : d.decidedBy,
        gate: d.gate,
      });
    }

    for (const a of analyses.filter((a) => a.status === 'completed')) {
      evts.push({
        date: a.completedAt ?? a.startedAt,
        type: 'analysis',
        icon: FileSearch,
        color:
          a.riskRating === 'high'
            ? 'text-red-400'
            : a.riskRating === 'medium'
              ? 'text-amber-400'
              : 'text-emerald-400',
        title: `Impact Analysis — ${a.riskRating?.toUpperCase()} risk`,
        detail: a.executiveSummary?.slice(0, 120) ?? undefined,
      });
    }

    for (const p of packs) {
      evts.push({
        date: p.generatedAt,
        type: 'handover',
        icon: Package,
        color: 'text-purple-400',
        title: 'Handover pack generated',
        detail: `${p.sections.filter((s) => s.included).length} of ${p.sections.length} sections included`,
      });
    }

    evts.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    return evts;
  }, [decisions, analyses, packs, item, gateLabels]);

  // Latest decision per gate
  const latestDecisionPerGate = useMemo(() => {
    const map: Partial<Record<GateId, GateDecision>> = {};
    for (const d of decisions) {
      if (!map[d.gate] || new Date(d.decidedAt) > new Date(map[d.gate]!.decidedAt)) {
        map[d.gate] = d;
      }
    }
    return map;
  }, [decisions]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={24} className="animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* ================================================================= */}
      {/* Stage pipeline — the hero visualisation                           */}
      {/* ================================================================= */}
      <div className="relative">
        {/* Background track */}
        <div className="absolute left-0 right-0 top-[23px] h-[2px] bg-border" />

        {/* Progress fill */}
        <div
          className="absolute left-0 top-[23px] h-[2px] bg-accent transition-all duration-700"
          style={{
            width:
              timelineStages.length > 1
                ? `${(currentStageIdx / (timelineStages.length - 1)) * 100}%`
                : '0%',
          }}
        />

        {/* Stage nodes + gate diamonds */}
        <div className="relative flex justify-between">
          {timelineStages.map((stage, idx) => {
            const isPast = idx < currentStageIdx;
            const isCurrent = idx === currentStageIdx;
            const gateReadiness = stage.gate ? readiness[stage.gate] : undefined;
            const gateDecision = stage.gate ? latestDecisionPerGate[stage.gate] : undefined;

            return (
              <div
                key={stage.id}
                className="flex flex-col items-center"
                style={{ width: `${100 / timelineStages.length}%` }}
              >
                {/* Stage node */}
                <div
                  className={`relative z-10 flex h-12 w-12 items-center justify-center rounded-full border-2 transition-all duration-500 ${
                    isCurrent
                      ? 'border-accent bg-accent/20 shadow-[0_0_20px_rgba(181,18,27,0.3)]'
                      : isPast
                        ? 'border-emerald-500/60 bg-emerald-500/10'
                        : 'border-border bg-bg-secondary'
                  }`}
                >
                  {isPast ? (
                    <Check size={18} className="text-emerald-400" />
                  ) : isCurrent ? (
                    <div className="h-3 w-3 rounded-full bg-accent animate-pulse" />
                  ) : (
                    <div className="h-2 w-2 rounded-full bg-text-tertiary/40" />
                  )}
                </div>

                {/* Stage label */}
                <div
                  className={`mt-2 text-center text-xs font-medium ${
                    isCurrent ? 'text-accent' : isPast ? 'text-text-primary' : 'text-text-tertiary'
                  }`}
                >
                  {stage.label}
                </div>

                {/* Gate indicator below label */}
                {stage.gate && (
                  <div className="mt-2 flex flex-col items-center gap-1">
                    {gateDecision ? (
                      <div
                        className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          gateDecision.decision === 'approved'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : gateDecision.decision === 'approved_with_conditions'
                              ? 'bg-amber-500/10 text-amber-400'
                              : gateDecision.decision === 'rejected'
                                ? 'bg-red-500/10 text-red-400'
                                : 'bg-blue-500/10 text-blue-400'
                        }`}
                      >
                        {(() => {
                          const Ic = DECISION_CONFIG[gateDecision.decision].icon;
                          return <Ic size={9} />;
                        })()}
                        {gateLabels[stage.gate]}
                      </div>
                    ) : gateReadiness ? (
                      <div
                        className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          gateReadiness.overall === 'green'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : gateReadiness.overall === 'amber'
                              ? 'bg-amber-500/10 text-amber-400'
                              : 'bg-red-500/10 text-red-400'
                        }`}
                      >
                        <Shield size={9} />
                        {gateLabels[stage.gate]}
                      </div>
                    ) : (
                      <div className="text-[10px] text-text-tertiary/50">
                        {gateLabels[stage.gate]}
                      </div>
                    )}

                    {gateDecision && (
                      <div className="text-[10px] text-text-tertiary">
                        {formatDate(gateDecision.decidedAt)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ================================================================= */}
      {/* Stats row                                                         */}
      {/* ================================================================= */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard
          label="Gates Passed"
          value={`${Object.values(latestDecisionPerGate).filter((d) => d?.decision === 'approved' || d?.decision === 'approved_with_conditions').length} / 4`}
          color="text-emerald-400"
        />
        <StatCard
          label="Impact Analyses"
          value={String(analyses.filter((a) => a.status === 'completed').length)}
          color="text-blue-400"
        />
        <StatCard
          label="Risk Level"
          value={
            analyses
              .filter((a) => a.status === 'completed')
              .at(-1)
              ?.riskRating?.toUpperCase() ?? '—'
          }
          color={
            analyses.at(-1)?.riskRating === 'high'
              ? 'text-red-400'
              : analyses.at(-1)?.riskRating === 'medium'
                ? 'text-amber-400'
                : analyses.at(-1)?.riskRating === 'low'
                  ? 'text-emerald-400'
                  : 'text-text-tertiary'
          }
        />
        <StatCard label="Handover Packs" value={String(packs.length)} color="text-purple-400" />
      </div>

      {/* ================================================================= */}
      {/* Gate readiness summary grid                                       */}
      {/* ================================================================= */}
      <div>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
          Gate Readiness
        </h3>
        <div className="grid grid-cols-2 gap-3">
          {timelineStages
            .filter((stage): stage is LifecycleStageDefinition & { gate: GateId } =>
              Boolean(stage.gate),
            )
            .map((stage) => {
              const gr = readiness[stage.gate];
              if (!gr) return null;
              const reqMet = gr.criteria.filter(
                (c) => c.criterion.required && c.status === 'met',
              ).length;
              const reqTotal = gr.criteria.filter((c) => c.criterion.required).length;
              const pct = reqTotal > 0 ? Math.round((reqMet / reqTotal) * 100) : 100;

              return (
                <div
                  key={stage.gate}
                  className="rounded-lg border border-border bg-bg-tertiary p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-text-primary">
                      {gateLabels[stage.gate]}
                    </span>
                    <span
                      className={`text-xs font-semibold ${
                        gr.overall === 'green'
                          ? 'text-emerald-400'
                          : gr.overall === 'amber'
                            ? 'text-amber-400'
                            : 'text-red-400'
                      }`}
                    >
                      {pct}%
                    </span>
                  </div>
                  {/* Progress bar */}
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-primary">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        gr.overall === 'green'
                          ? 'bg-emerald-500'
                          : gr.overall === 'amber'
                            ? 'bg-amber-500'
                            : 'bg-red-500'
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="mt-1.5 text-[10px] text-text-tertiary">
                    {reqMet} of {reqTotal} required criteria met
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      {/* ================================================================= */}
      {/* Activity timeline                                                 */}
      {/* ================================================================= */}
      {events.length > 0 && (
        <div>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
            Activity
          </h3>
          <div className="relative">
            {/* Vertical line */}
            <div className="absolute bottom-0 left-[11px] top-0 w-px bg-border" />

            <div className="space-y-0">
              {events.map((evt, i) => {
                const Icon = evt.icon;
                return (
                  <div key={i} className="group relative flex gap-3 py-2">
                    {/* Dot */}
                    <div
                      className={`relative z-10 flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full border border-border bg-bg-secondary ${evt.color}`}
                    >
                      <Icon size={11} />
                    </div>
                    {/* Content */}
                    <div className="min-w-0 flex-1 pt-0.5">
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs font-medium text-text-primary">{evt.title}</span>
                        <span className="shrink-0 text-[10px] text-text-tertiary">
                          {formatDateTime(evt.date)}
                        </span>
                      </div>
                      {evt.detail && (
                        <div className="mt-0.5 text-[11px] leading-relaxed text-text-tertiary line-clamp-2">
                          {evt.detail}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-tertiary px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
        {label}
      </div>
      <div className={`mt-1 text-lg font-bold ${color}`}>{value}</div>
    </div>
  );
}
