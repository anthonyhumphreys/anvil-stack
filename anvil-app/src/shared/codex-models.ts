import type { ReasoningEffort } from './types.js';

export type CodexModelTier = 'power' | 'balanced' | 'fast' | 'previous' | 'preview';

export interface CodexModelOption {
  id: string;
  label: string;
  tier: CodexModelTier;
  description: string;
  recommended: boolean;
  preview?: boolean;
  supportedReasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
}

export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
export const DEFAULT_CODEX_REASONING_EFFORT: ReasoningEffort = 'medium';

export const CODEX_REASONING_EFFORTS: ReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

export const CODEX_MODEL_OPTIONS: CodexModelOption[] = [
  {
    id: 'gpt-5.6-sol',
    label: '5.6 Sol',
    tier: 'power',
    description: 'Flagship model for complex coding, computer use, research, and security work.',
    recommended: true,
    supportedReasoningEfforts: CODEX_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.6-terra',
    label: '5.6 Terra',
    tier: 'balanced',
    description: 'Everyday Codex work with strong reasoning and lower cost than Sol.',
    recommended: true,
    supportedReasoningEfforts: CODEX_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.6-luna',
    label: '5.6 Luna',
    tier: 'fast',
    description: 'Fast, lower-cost model for lighter coding and high-volume tasks.',
    recommended: true,
    supportedReasoningEfforts: CODEX_REASONING_EFFORTS,
    defaultReasoningEffort: 'low',
  },
  {
    id: 'gpt-5.5',
    label: '5.5',
    tier: 'previous',
    description: 'Previous frontier model for coding, research, and computer-use workflows.',
    recommended: false,
    supportedReasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'medium',
  },
  {
    id: 'gpt-5.3-codex-spark',
    label: '5.3 Codex Spark',
    tier: 'preview',
    description: 'Text-only preview model for near-instant coding iteration.',
    recommended: false,
    preview: true,
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'low',
  },
];

export function getCodexModelOption(modelId: string | null | undefined): CodexModelOption | null {
  return CODEX_MODEL_OPTIONS.find((option) => option.id === modelId) ?? null;
}

export function normaliseCodexModel(modelId: string | null | undefined): string {
  const trimmed = modelId?.trim();
  return trimmed || DEFAULT_CODEX_MODEL;
}

export function normaliseReasoningEffort(
  effort: string | null | undefined,
  fallback: ReasoningEffort = DEFAULT_CODEX_REASONING_EFFORT,
): ReasoningEffort {
  return CODEX_REASONING_EFFORTS.includes(effort as ReasoningEffort)
    ? (effort as ReasoningEffort)
    : fallback;
}
