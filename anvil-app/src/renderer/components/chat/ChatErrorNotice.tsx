import { AlertTriangle, Copy, Settings, Stethoscope } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { AgentProvider } from '../../../shared/types';
import { Button, Menu, MenuItem, MenuLabel } from '../ui';
import { classifyChatError, chatErrorSupportsProviderSwitch } from './chat-errors';

export interface ChatErrorProviderOption {
  provider: AgentProvider;
  label: string;
}

/**
 * CH5 — classified error notice with recovery actions: reuse prompt, Switch
 * provider, Open diagnostics, and a link into the relevant Settings section.
 */
export function ChatErrorNotice({
  error,
  providers,
  onRetry,
  retryLabel = 'Retry',
  onSwitchProvider,
}: {
  error: string;
  providers: ChatErrorProviderOption[];
  onRetry?: () => void;
  retryLabel?: string;
  onSwitchProvider?: (provider: AgentProvider) => void;
}) {
  const navigate = useNavigate();
  const classification = classifyChatError(error);
  const otherProviders = providers.filter((option) => option.provider);

  return (
    <div role="alert" className="mt-4 rounded-xl border border-error/20 bg-error/5 px-4 py-3">
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-error" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-primary">{classification.title}</p>
          <p className="mt-0.5 text-xs leading-5 text-text-tertiary">{classification.hint}</p>
          <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-error">{error}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 pl-6">
        {onRetry && (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            <Copy size={12} />
            {retryLabel}
          </Button>
        )}
        {onSwitchProvider &&
          chatErrorSupportsProviderSwitch(classification.kind) &&
          otherProviders.length > 0 && (
            <Menu
              label="Switch provider"
              side="top"
              trigger={(props) => (
                <Button {...props} variant="secondary" size="sm">
                  Switch provider
                </Button>
              )}
            >
              <MenuLabel>Send with</MenuLabel>
              {otherProviders.map((option) => (
                <MenuItem key={option.provider} onSelect={() => onSwitchProvider(option.provider)}>
                  {option.label}
                </MenuItem>
              ))}
            </Menu>
          )}
        <Button variant="ghost" size="sm" onClick={() => navigate('/diagnostics')}>
          <Stethoscope size={12} />
          Open diagnostics
        </Button>
        <Button variant="ghost" size="sm" onClick={() => navigate(classification.settingsPath)}>
          <Settings size={12} />
          {classification.settingsLabel}
        </Button>
      </div>
    </div>
  );
}
