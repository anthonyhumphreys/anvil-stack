import { useState, useCallback, useEffect } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2, Save } from 'lucide-react';
import type { GateCriterion, GateId, GateCriterionType } from '../../../../shared/types';
import { useWorkspace } from '../../../contexts/WorkspaceContext';
import { GATE_ORDER } from '../gate-utils';
import { getGateFallbackLabel } from '../../../../shared/types';

const CRITERION_TYPE_OPTIONS: { label: string; value: GateCriterionType }[] = [
  { label: 'Security Audit', value: 'security_audit' },
  { label: 'Code Review', value: 'code_review' },
  { label: 'ADR Exists', value: 'adr_exists' },
  { label: 'Compliance Document', value: 'compliance_doc' },
  { label: 'Confluence Page', value: 'confluence_page' },
  { label: 'Governance Document', value: 'governance_document' },
  { label: 'Impact Analysis', value: 'impact_analysis' },
  { label: 'Architecture Diagram', value: 'architecture_diagram' },
  { label: 'Handover Pack', value: 'handover_pack' },
  { label: 'Manual Approval', value: 'manual_approval' },
];

const INPUT_CLASS =
  'rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:border-accent/50 focus:outline-none';

export function GateConfigView() {
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace?.id;

  const [editedLabels, setEditedLabels] = useState<Record<GateId, string>>(
    {} as Record<GateId, string>,
  );
  const [editedCriteria, setEditedCriteria] = useState<Record<GateId, GateCriterion[]>>(
    {} as Record<GateId, GateCriterion[]>,
  );
  const [expandedGates, setExpandedGates] = useState<Set<GateId>>(new Set(GATE_ORDER));
  const [dirty, setDirty] = useState(false);

  const fetchTemplates = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const fetched = await window.anvil.lifecycle.getGateTemplates(workspaceId);
      const labelMap = {} as Record<GateId, string>;
      const criteriaMap = {} as Record<GateId, GateCriterion[]>;
      for (const gate of GATE_ORDER) {
        const tpl = fetched.find((t) => t.gate === gate);
        labelMap[gate] = tpl?.label ?? '';
        criteriaMap[gate] = tpl ? tpl.criteria.map((c) => ({ ...c })) : [];
      }
      setEditedLabels(labelMap);
      setEditedCriteria(criteriaMap);
    } catch (err) {
      console.error('Failed to fetch gate templates:', err);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const toggleExpanded = useCallback((gate: GateId) => {
    setExpandedGates((prev) => {
      const next = new Set(prev);
      if (next.has(gate)) {
        next.delete(gate);
      } else {
        next.add(gate);
      }
      return next;
    });
  }, []);

  const handleLabelChange = useCallback((gate: GateId, label: string) => {
    setEditedLabels((prev) => ({
      ...prev,
      [gate]: label,
    }));
    setDirty(true);
  }, []);

  const handleAddCriterion = useCallback((gate: GateId) => {
    const newCriterion: GateCriterion = {
      id: crypto.randomUUID(),
      type: 'manual_approval',
      label: '',
      required: true,
    };
    setEditedCriteria((prev) => ({
      ...prev,
      [gate]: [...(prev[gate] ?? []), newCriterion],
    }));
    setDirty(true);
  }, []);

  const handleDeleteCriterion = useCallback((gate: GateId, criterionId: string) => {
    setEditedCriteria((prev) => ({
      ...prev,
      [gate]: (prev[gate] ?? []).filter((c) => c.id !== criterionId),
    }));
    setDirty(true);
  }, []);

  const handleCriterionChange = useCallback(
    (gate: GateId, criterionId: string, patch: Partial<GateCriterion>) => {
      setEditedCriteria((prev) => ({
        ...prev,
        [gate]: (prev[gate] ?? []).map((c) => (c.id === criterionId ? { ...c, ...patch } : c)),
      }));
      setDirty(true);
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (!workspaceId) return;
    try {
      for (const gate of GATE_ORDER) {
        await window.anvil.lifecycle.updateGateTemplate(workspaceId, gate, {
          label: editedLabels[gate] ?? '',
          criteria: editedCriteria[gate] ?? [],
        });
      }
      await fetchTemplates();
      setDirty(false);
    } catch (err) {
      console.error('Failed to save gate templates:', err);
    }
  }, [workspaceId, editedLabels, editedCriteria, fetchTemplates]);

  const handleReset = useCallback(async () => {
    if (!workspaceId) return;
    if (!confirm('Clear all gate names and criteria? This cannot be undone.')) return;
    try {
      await window.anvil.lifecycle.resetGateTemplates(workspaceId);
      await fetchTemplates();
      setDirty(false);
    } catch (err) {
      console.error('Failed to reset gate templates:', err);
    }
  }, [workspaceId, fetchTemplates]);

  if (!workspaceId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-secondary">Select a workspace to get started.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-bg-secondary px-4 py-3">
        <h2 className="text-base font-semibold text-text-primary">Gate Templates</h2>
        <button
          onClick={handleReset}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
        >
          <Trash2 size={14} />
          Clear All
        </button>
      </div>

      {/* Gate sections */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {GATE_ORDER.map((gate) => {
          const expanded = expandedGates.has(gate);
          const criteria = editedCriteria[gate] ?? [];
          const configuredLabel = editedLabels[gate] ?? '';
          const displayLabel = configuredLabel.trim() || getGateFallbackLabel(gate);

          return (
            <div key={gate} className="rounded-lg border border-border bg-bg-secondary">
              {/* Section header */}
              <button
                onClick={() => toggleExpanded(gate)}
                className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-text-primary hover:bg-bg-tertiary rounded-lg"
              >
                {expanded ? (
                  <ChevronDown size={16} className="shrink-0 text-text-secondary" />
                ) : (
                  <ChevronRight size={16} className="shrink-0 text-text-secondary" />
                )}
                {displayLabel}
                <span className="ml-auto text-xs text-text-tertiary">
                  {criteria.length} criteria
                </span>
              </button>

              {/* Criteria list */}
              {expanded && (
                <div className="border-t border-border px-4 pb-3">
                  <div className="py-3">
                    <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-text-tertiary">
                      Gate name
                    </label>
                    <input
                      type="text"
                      value={configuredLabel}
                      onChange={(e) => handleLabelChange(gate, e.target.value)}
                      placeholder={getGateFallbackLabel(gate)}
                      className={`${INPUT_CLASS} w-full`}
                    />
                  </div>

                  {criteria.length === 0 ? (
                    <p className="py-3 text-xs text-text-tertiary">
                      No criteria defined for this gate.
                    </p>
                  ) : (
                    <div className="mt-2">
                      {criteria.map((criterion) => (
                        <div
                          key={criterion.id}
                          className="flex items-center gap-2 py-2 border-b border-border-subtle last:border-0"
                        >
                          {/* Type dropdown */}
                          <select
                            value={criterion.type}
                            onChange={(e) =>
                              handleCriterionChange(gate, criterion.id, {
                                type: e.target.value as GateCriterionType,
                              })
                            }
                            className={INPUT_CLASS}
                          >
                            {CRITERION_TYPE_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>

                          {/* Label input */}
                          <input
                            type="text"
                            value={criterion.label}
                            onChange={(e) =>
                              handleCriterionChange(gate, criterion.id, { label: e.target.value })
                            }
                            placeholder="Label"
                            className={`${INPUT_CLASS} flex-1`}
                          />

                          {/* Required / Recommended toggle */}
                          <button
                            onClick={() =>
                              handleCriterionChange(gate, criterion.id, {
                                required: !criterion.required,
                              })
                            }
                            className={
                              criterion.required
                                ? 'rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-white'
                                : 'rounded-full border border-border px-2 py-0.5 text-xs font-medium text-text-secondary'
                            }
                          >
                            {criterion.required ? 'Required' : 'Recommended'}
                          </button>

                          {/* Delete button */}
                          <button
                            onClick={() => handleDeleteCriterion(gate, criterion.id)}
                            className="rounded p-1 text-text-tertiary hover:text-red-400"
                            aria-label="Delete criterion"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add Criterion button */}
                  <button
                    onClick={() => handleAddCriterion(gate)}
                    className="mt-2 flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary"
                  >
                    <Plus size={12} />
                    Add Criterion
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Save button */}
      <div className="shrink-0 border-t border-border bg-bg-secondary px-4 py-3 flex justify-end">
        <button
          onClick={handleSave}
          disabled={!dirty}
          className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Save size={14} />
          Save Changes
        </button>
      </div>
    </div>
  );
}
