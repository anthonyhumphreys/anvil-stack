import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Loader2, Plug, Unplug } from 'lucide-react';
import type { AgentProvider } from '../../../shared/types';
import type {
  CloudAgentProviderStatus,
  CloudAgentSettingsSnapshot,
} from '../../../shared/cloud-agent';
import { settingsPanelDomId } from './settings-route';

const PROVIDERS: Array<{ id: AgentProvider; label: string; description: string }> = [
  {
    id: 'codex',
    label: 'Codex',
    description: 'Use your existing Codex cloud authentication options.',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    description:
      'Connect Cursor once to use it from Anvil Cloud Agents or your own cloud machines.',
  },
  {
    id: 'devin',
    label: 'Devin',
    description: 'Use the saved Devin provider connection for cloud agents.',
  },
  { id: 'openai', label: 'OpenAI API', description: 'Use the saved OpenAI API configuration.' },
  {
    id: 'azure',
    label: 'Azure AI Foundry',
    description: 'Use the saved Azure provider configuration.',
  },
  {
    id: 'llmgateway',
    label: 'LLMGateway',
    description: 'Use the saved LLMGateway provider configuration.',
  },
];

export function cloudAgentStatusLabel(status: CloudAgentProviderStatus | undefined): string {
  if (!status?.enabled) return 'Not allowed';
  switch (status.connectionState) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'locked':
      return 'Unlock saved credentials';
    case 'expired':
      return 'Connection expired';
    case 'disconnected':
      return 'Not connected';
    default:
      return 'Unavailable';
  }
}

export function CloudAgentSettingsPanel(): ReactNode {
  const [snapshot, setSnapshot] = useState<CloudAgentSettingsSnapshot | null>(null);
  const [busy, setBusy] = useState<AgentProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connectionInProgress =
    busy !== null ||
    snapshot?.providers.some((provider) => provider.connectionState === 'connecting') === true;

  const refresh = async (): Promise<void> => {
    setSnapshot(await window.anvil.cloudAgentSettings.get());
  };

  useEffect(() => {
    let mounted = true;
    const load = () => {
      void window.anvil.cloudAgentSettings
        .get()
        .then((result) => {
          if (mounted) setSnapshot(result);
        })
        .catch((cause: unknown) => {
          if (mounted) setError(cause instanceof Error ? cause.message : String(cause));
        });
    };
    load();
    const timer = connectionInProgress ? window.setInterval(load, 2000) : undefined;
    return () => {
      mounted = false;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [connectionInProgress]);

  const act = async (
    provider: AgentProvider,
    action: () => Promise<CloudAgentSettingsSnapshot | void>,
  ) => {
    setBusy(provider);
    setError(null);
    try {
      const result = await action();
      if (result) setSnapshot(result);
      else await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      id={settingsPanelDomId('cloud-agents')}
      className="space-y-3"
      aria-labelledby="cloud-agents-title"
    >
      <div>
        <h3 id="cloud-agents-title" className="text-sm font-medium text-text-primary">
          Cloud agents
        </h3>
        <p className="mt-1 text-sm text-text-secondary">
          Choose which providers Anvil Cloud Agents or your own cloud machines may use. Saved
          sign-in details use your protected credential storage.
        </p>
      </div>
      {PROVIDERS.map(({ id, label, description }) => {
        const status = snapshot?.providers.find((item) => item.provider === id);
        const connecting = busy === id || status?.connectionState === 'connecting';
        const connectionProvider = id === 'cursor' || id === 'devin';
        return (
          <div
            key={id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-bg-primary p-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                {label}
                {status?.connected && (
                  <span className="inline-flex items-center gap-1 text-xs font-normal text-success">
                    <Check size={12} /> Connected
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-text-secondary">{description}</p>
              {connectionProvider && status?.enabled && !status.connected && status.detail && (
                <p className="mt-1 text-xs text-warning">{status.detail}</p>
              )}
              {!connectionProvider && id !== 'codex' && (
                <p className="mt-1 text-xs text-text-tertiary">
                  Uses the saved provider settings from Providers.
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs text-text-secondary">{cloudAgentStatusLabel(status)}</span>
              <label className="flex items-center gap-2 text-xs text-text-secondary">
                <span className="sr-only">Allow {label} for cloud agents</span>
                <input
                  aria-label={`Allow ${label} for cloud agents`}
                  type="checkbox"
                  checked={status?.enabled ?? false}
                  disabled={snapshot === null || busy !== null}
                  onChange={(event) =>
                    void act(id, () =>
                      window.anvil.cloudAgentSettings.setEnabled(id, event.target.checked),
                    )
                  }
                  className="h-4 w-4 accent-accent"
                />
                Allowed
              </label>
              {connectionProvider &&
                (status?.connected ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(id, () => window.anvil.cloudAgentSettings.disconnect(id))
                    }
                  >
                    <Unplug size={12} /> Disconnect
                  </button>
                ) : connecting ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
                    onClick={() => {
                      setError(null);
                      void window.anvil.cloudAgentSettings
                        .cancelConnection(id)
                        .then(async () => setSnapshot(await window.anvil.cloudAgentSettings.get()))
                        .catch((cause: unknown) =>
                          setError(cause instanceof Error ? cause.message : String(cause)),
                        );
                    }}
                  >
                    <Loader2 size={12} className="animate-spin" /> Cancel connection
                  </button>
                ) : (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
                    disabled={!status?.enabled || busy !== null}
                    onClick={() =>
                      void act(id, async () => {
                        const result = await window.anvil.cloudAgentSettings.connect(id);
                        if (result.error) setError(result.error);
                        return result.snapshot;
                      })
                    }
                  >
                    <Plug size={12} />
                    {id === 'cursor' ? 'Connect Cursor' : 'Connect Devin'}
                  </button>
                ))}
            </div>
          </div>
        );
      })}
      {snapshot === null && !error && (
        <p className="text-xs text-text-tertiary">Loading provider access…</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
    </section>
  );
}
