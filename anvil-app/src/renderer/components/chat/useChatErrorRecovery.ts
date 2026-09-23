import { useCallback, useMemo } from 'react';
import type { AgentProvider, ChatAttachment } from '../../../shared/types';
import type { ChatEntry } from '../../contexts/ChatContext';
import type { ChatModelOption } from '../../utils/chat-model-options';
import type { ChatErrorProviderOption } from './ChatErrorNotice';

/**
 * CH5 — recovery wiring for ChatErrorNotice, extracted from ChatView.
 * Retry resends the last user message; provider switch picks the first
 * registered model option for the chosen provider.
 */
export function useChatErrorRecovery({
  entries,
  modelOptions,
  modelProvider,
  onSend,
  onModelChange,
}: {
  entries: ChatEntry[];
  modelOptions: ChatModelOption[];
  modelProvider: AgentProvider;
  onSend: (message: string, attachments?: ChatAttachment[]) => void;
  onModelChange: (model: string, provider: AgentProvider) => void;
}) {
  const onRetry = useCallback(() => {
    const lastUser = [...entries].reverse().find((entry) => entry.kind === 'user');
    if (lastUser && lastUser.kind === 'user') {
      onSend(lastUser.content, lastUser.attachments ?? []);
    }
  }, [entries, onSend]);

  const onSwitchProvider = useCallback(
    (provider: AgentProvider) => {
      const option = modelOptions.find((item) => item.provider === provider);
      if (option) onModelChange(option.id, provider);
    },
    [modelOptions, onModelChange],
  );

  const providers = useMemo<ChatErrorProviderOption[]>(() => {
    const seen = new Set<AgentProvider>();
    const options: ChatErrorProviderOption[] = [];
    for (const option of modelOptions) {
      if (seen.has(option.provider) || option.provider === modelProvider) continue;
      seen.add(option.provider);
      options.push({ provider: option.provider, label: option.label });
    }
    return options;
  }, [modelOptions, modelProvider]);

  return { providers, onRetry, onSwitchProvider };
}
