import { DEFAULT_CODEX_MODEL } from '../../shared/codex-models';
import type { AgentProvider, AppSettings } from '../../shared/types';

export function selectPrimaryAgentProvider(
  settings: Partial<AppSettings>,
  nextProvider: AgentProvider,
  cursorModelIds: string[] = [],
): Partial<AppSettings> {
  const currentProvider = settings.llmProvider ?? 'codex';
  const currentModel = settings.openaiModel ?? DEFAULT_CODEX_MODEL;
  const knownCursorModel = currentModel === 'auto' || cursorModelIds.includes(currentModel);
  const model =
    nextProvider === 'cursor'
      ? knownCursorModel
        ? currentModel
        : 'auto'
      : currentProvider === 'cursor' && knownCursorModel
        ? DEFAULT_CODEX_MODEL
        : currentModel;

  return {
    ...settings,
    llmProvider: nextProvider,
    enabledLlmProviders: [
      ...new Set<AgentProvider>([
        nextProvider,
        ...(settings.enabledLlmProviders ?? [currentProvider]),
      ]),
    ],
    openaiModel: model,
  };
}
