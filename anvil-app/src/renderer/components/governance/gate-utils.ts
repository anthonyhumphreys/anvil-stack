import type { GateId, GateTemplate } from '../../../shared/types';
import { GATE_IDS, getGateFallbackLabel } from '../../../shared/types';

export const GATE_ORDER: GateId[] = [...GATE_IDS];

export function getGateLabel(gate: GateId, templates: GateTemplate[]): string {
  const configuredLabel = templates.find((template) => template.gate === gate)?.label.trim();
  return configuredLabel || getGateFallbackLabel(gate);
}

export function buildGateLabelMap(templates: GateTemplate[]): Record<GateId, string> {
  return GATE_ORDER.reduce(
    (labels, gate) => ({
      ...labels,
      [gate]: getGateLabel(gate, templates),
    }),
    {} as Record<GateId, string>,
  );
}
