import { DEFAULT_CODEX_MODEL } from '../../shared/codex-models';
import { isAcpAgentProvider, type AcpAgentProvider } from '../../shared/agent-providers';
import type { AgentProvider, AppSettings } from '../../shared/types';

export function selectPrimaryAgentProvider(
  settings: Partial<AppSettings>,
  nextProvider: AgentProvider,
  acpModelIds: Partial<Record<AcpAgentProvider, string[]>> = {},
): Partial<AppSettings> {
  const currentProvider = settings.llmProvider ?? 'codex';
  const currentModel = settings.openaiModel ?? DEFAULT_CODEX_MODEL;
  const knownAcpModel = (provider: AcpAgentProvider) =>
    currentModel === 'auto' || (acpModelIds[provider] ?? []).includes(currentModel);
  const model = isAcpAgentProvider(nextProvider)
    ? knownAcpModel(nextProvider)
      ? currentModel
      : 'auto'
    : isAcpAgentProvider(currentProvider) && knownAcpModel(currentProvider)
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
