import { useState, useCallback, useEffect, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import type {
  LifecycleStage,
  GateId,
  GateTemplate,
  GateReadinessResult,
  GateDecision,
  ReadinessStatus,
  OverallReadiness,
  GateDecisionOutcome,
} from '../../../../shared/types';
import { GateDecisionModal } from './GateDecisionModal';
import { buildGateLabelMap, GATE_ORDER } from '../gate-utils';

interface Props {
  lifecycleItemId: string;
  workspaceId: string;
  currentStage: LifecycleStage;
}

const STAGE_NEXT_GATE: Record<LifecycleStage, GateId> = {
  ideation: 'gate_1',
  discovery_design: 'gate_2',
  build: 'gate_3',
  run: 'gate_4',
};

const OVERALL_CONFIG: Record<OverallReadiness, { dot: string; label: string }> = {
  green: { dot: 'bg-emerald-500', label: 'Ready' },
  amber: { dot: 'bg-amber-500', label: 'Partially Ready' },
  red: { dot: 'bg-red-500', label: 'Not Ready' },
};

const STATUS_DOT: Record<ReadinessStatus, string> = {
  met: 'bg-emerald-500',
  partial: 'bg-amber-500',
  not_met: 'bg-red-500',
};

const DECISION_LABELS: Record<GateDecisionOutcome, string> = {
  approved: 'Approved',
  approved_with_conditions: 'Approved with Conditions',
  deferred: 'Deferred',
  rejected: 'Rejected',
};

const DECISION_BADGE: Record<GateDecisionOutcome, string> = {
  approved: 'bg-emerald-500/10 text-emerald-400',
  approved_with_conditions: 'bg-amber-500/10 text-amber-400',
  deferred: 'bg-blue-500/10 text-blue-400',
  rejected: 'bg-red-500/10 text-red-400',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function GateReadinessPanel({ lifecycleItemId, workspaceId, currentStage }: Props) {
  const defaultGate = STAGE_NEXT_GATE[currentStage];
  const [selectedGate, setSelectedGate] = useState<GateId>(defaultGate);
  const [templates, setTemplates] = useState<GateTemplate[]>([]);
  const [readiness, setReadiness] = useState<GateReadinessResult | null>(null);
  const [decisions, setDecisions] = useState<GateDecision[]>([]);
  const [loading, setLoading] = useState(false);
  const [showDecisionModal, setShowDecisionModal] = useState(false);
  const gateLabels = useMemo(() => buildGateLabelMap(templates), [templates]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [r, d, t] = await Promise.all([
        window.anvil.lifecycle.checkReadiness(lifecycleItemId, selectedGate),
        window.anvil.lifecycle.listGateDecisions(lifecycleItemId),
        window.anvil.lifecycle.getGateTemplates(workspaceId),
      ]);
      setReadiness(r);
      setDecisions(d);
      setTemplates(t);
    } catch (err) {
      console.error('Failed to load gate readiness:', err);
    } finally {
      setLoading(false);
    }
  }, [lifecycleItemId, selectedGate, workspaceId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Reset gate selection when item/stage changes
  useEffect(() => {
    setSelectedGate(STAGE_NEXT_GATE[currentStage]);
  }, [lifecycleItemId, currentStage]);

  const handleDecisionRecorded = useCallback(() => {
    setShowDecisionModal(false);
    loadData();
  }, [loadData]);

  const required = readiness?.criteria.filter((c) => c.criterion.required) ?? [];
  const recommended = readiness?.criteria.filter((c) => !c.criterion.required) ?? [];

  return (
    <div className="space-y-4 pt-2">
      {/* Gate selector */}
      <div className="flex items-center gap-3">
        <label className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
          Gate
        </label>
        <select
          value={selectedGate}
          onChange={(e) => setSelectedGate(e.target.value as GateId)}
          className="rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:border-accent/50 focus:outline-none"
        >
          {GATE_ORDER.map((gate) => (
            <option key={gate} value={gate}>
              {gateLabels[gate]}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="flex h-32 items-center justify-center">
          <Loader2 size={20} className="animate-spin text-accent" />
        </div>
      ) : readiness ? (
        <>
          {/* Overall RAG */}
          <div className="flex items-center gap-3 rounded-lg border border-border px-4 py-3">
            <div
              className={`h-4 w-4 shrink-0 rounded-full ${OVERALL_CONFIG[readiness.overall].dot}`}
            />
            <span className="text-sm font-medium text-text-primary">
              {OVERALL_CONFIG[readiness.overall].label}
            </span>
          </div>

          {/* Required criteria */}
          {required.length > 0 && (
            <div className="rounded-lg border border-border px-4 py-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                Required
              </div>
              <div className="space-y-2">
                {required.map((c) => (
                  <div key={c.criterion.id} className="flex items-start gap-2">
                    <div
                      className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[c.status]}`}
                    />
                    <div className="min-w-0">
                      <div className="text-sm text-text-primary">{c.criterion.label}</div>
                      {c.detail && (
                        <div className="mt-0.5 text-xs text-text-tertiary">{c.detail}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recommended criteria */}
          {recommended.length > 0 && (
            <div className="rounded-lg border border-border px-4 py-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                Recommended
              </div>
              <div className="space-y-2">
                {recommended.map((c) => (
                  <div key={c.criterion.id} className="flex items-start gap-2">
                    <div
                      className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[c.status]}`}
                    />
                    <div className="min-w-0">
                      <div className="text-sm text-text-primary">{c.criterion.label}</div>
                      {c.detail && (
                        <div className="mt-0.5 text-xs text-text-tertiary">{c.detail}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {required.length === 0 && recommended.length === 0 && (
            <p className="text-sm text-text-tertiary">No criteria defined for this gate.</p>
          )}
        </>
      ) : null}

      {/* Record Gate Decision button */}
      <div>
        <button
          onClick={() => setShowDecisionModal(true)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
        >
          Record Gate Decision
        </button>
      </div>

      {/* Gate History */}
      {decisions.length > 0 && (
        <div className="rounded-lg border border-border px-4 py-3">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
            Gate History
          </div>
          <div className="space-y-3">
            {decisions.map((d) => (
              <div key={d.id} className="flex items-start gap-3">
                <div className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-text-tertiary" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-text-primary">
                      {gateLabels[d.gate]}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${DECISION_BADGE[d.decision]}`}
                    >
                      {DECISION_LABELS[d.decision]}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-text-tertiary">
                    {d.decidedBy} &middot; {formatDate(d.decidedAt)}
                  </div>
                  {d.conditions && (
                    <div className="mt-1 text-xs text-text-secondary">
                      Conditions: {d.conditions}
                    </div>
                  )}
                  {d.rationale && (
                    <div className="mt-0.5 text-xs text-text-secondary">
                      Rationale: {d.rationale}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showDecisionModal && (
        <GateDecisionModal
          lifecycleItemId={lifecycleItemId}
          gate={selectedGate}
          gateLabel={gateLabels[selectedGate]}
          onRecorded={handleDecisionRecorded}
          onClose={() => setShowDecisionModal(false)}
        />
      )}
    </div>
  );
}
