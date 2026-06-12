import { useState, useCallback } from 'react';
import { X } from 'lucide-react';
import type { GateId, GateDecisionOutcome } from '../../../../shared/types';

interface Props {
  lifecycleItemId: string;
  gate: GateId;
  gateLabel: string;
  onRecorded: () => void;
  onClose: () => void;
}

const DECISION_LABELS: Record<GateDecisionOutcome, string> = {
  approved: 'Approved',
  approved_with_conditions: 'Approved with Conditions',
  deferred: 'Deferred',
  rejected: 'Rejected',
};

const INPUT_CLASS =
  'w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-accent/50 focus:outline-none';

export function GateDecisionModal({
  lifecycleItemId,
  gate,
  gateLabel,
  onRecorded,
  onClose,
}: Props) {
  const [decision, setDecision] = useState<GateDecisionOutcome>('approved');
  const [decidedBy, setDecidedBy] = useState('');
  const [conditions, setConditions] = useState('');
  const [rationale, setRationale] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    if (!decidedBy.trim()) {
      setError('Decided By is required.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await window.anvil.lifecycle.recordGateDecision(lifecycleItemId, {
        gate,
        decision,
        decidedBy: decidedBy.trim(),
        conditions:
          decision === 'approved_with_conditions' ? conditions.trim() || undefined : undefined,
        rationale: rationale.trim() || undefined,
      });
      onRecorded();
    } catch (err) {
      console.error('Failed to record gate decision:', err);
      setError('Failed to record decision. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [lifecycleItemId, gate, decision, decidedBy, conditions, rationale, onRecorded]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-xl border border-border bg-bg-secondary p-6 shadow-2xl">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-text-primary">Record Gate Decision</h3>
          <button
            onClick={onClose}
            className="rounded p-0.5 text-text-tertiary hover:text-text-primary"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4">
          {/* Gate (read-only) */}
          <div>
            <label className="mb-1 block text-sm text-text-secondary">Gate</label>
            <div className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary">
              {gateLabel}
            </div>
          </div>

          {/* Decision */}
          <div>
            <label className="mb-1 block text-sm text-text-secondary">
              Decision <span className="text-error">*</span>
            </label>
            <select
              value={decision}
              onChange={(e) => setDecision(e.target.value as GateDecisionOutcome)}
              className={INPUT_CLASS}
            >
              {(Object.entries(DECISION_LABELS) as [GateDecisionOutcome, string][]).map(
                ([val, label]) => (
                  <option key={val} value={val}>
                    {label}
                  </option>
                ),
              )}
            </select>
          </div>

          {/* Decided By */}
          <div>
            <label className="mb-1 block text-sm text-text-secondary">
              Decided By <span className="text-error">*</span>
            </label>
            <input
              type="text"
              value={decidedBy}
              onChange={(e) => setDecidedBy(e.target.value)}
              placeholder="Name or role"
              className={INPUT_CLASS}
            />
          </div>

          {/* Conditions — only when approved_with_conditions */}
          {decision === 'approved_with_conditions' && (
            <div>
              <label className="mb-1 block text-sm text-text-secondary">Conditions</label>
              <textarea
                value={conditions}
                onChange={(e) => setConditions(e.target.value)}
                placeholder="List any conditions that must be met..."
                rows={3}
                className={INPUT_CLASS}
              />
            </div>
          )}

          {/* Rationale */}
          <div>
            <label className="mb-1 block text-sm text-text-secondary">Rationale (optional)</label>
            <textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="Reasoning behind this decision..."
              rows={3}
              className={INPUT_CLASS}
            />
          </div>

          {error && <p className="text-sm text-error">{error}</p>}
        </div>

        {/* Actions */}
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm text-text-secondary hover:bg-bg-tertiary"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!decidedBy.trim() || submitting}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {submitting ? 'Recording...' : 'Record Decision'}
          </button>
        </div>
      </div>
    </div>
  );
}
