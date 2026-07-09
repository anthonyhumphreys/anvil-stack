import type { ReasoningEffort } from '../../shared/types';

export const CODEX_SELECTION_CHANGED_EVENT = 'anvil:codex-selection-changed';

export interface CodexSelectionChangedDetail {
  model: string;
  reasoningEffort: ReasoningEffort;
}

export function dispatchCodexSelectionChanged(detail: CodexSelectionChangedDetail): void {
  window.dispatchEvent(new CustomEvent(CODEX_SELECTION_CHANGED_EVENT, { detail }));
}
