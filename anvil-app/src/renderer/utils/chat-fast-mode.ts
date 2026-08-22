import type { AgentProvider } from '../../shared/types';
import type { ChatModelOption } from './chat-model-options';

export interface ChatFastModeTarget {
  available: boolean;
  model: string;
  serviceTier: string | null;
}

export function resolveChatFastModeTarget(
  provider: AgentProvider,
  model: string,
  modelOptions: ChatModelOption[],
): ChatFastModeTarget {
  if (provider !== 'cursor') {
    const selected = modelOptions.find((option) => option.id === model);
    const priorityTier = selected?.serviceTiers.find((tier) => tier.id === 'priority');
    return {
      available: Boolean(priorityTier),
      model,
      serviceTier: priorityTier?.id ?? null,
    };
  }

  const baseModel = model.endsWith('-fast') ? model.slice(0, -'-fast'.length) : model;
  const fastModel = `${baseModel}-fast`;
  return {
    available: modelOptions.some((option) => option.id === fastModel),
    model: fastModel,
    serviceTier: null,
  };
}
