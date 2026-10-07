import { useCallback, useEffect, useState } from 'react';
import { CheckCircle, Download, Loader2, RefreshCcw, Wrench, XCircle } from 'lucide-react';
import type { CodexRuntimeStatus } from '../../../shared/codex-runtime';

type RuntimeAction = 'idle' | 'checking' | 'installing';

export function codexRuntimeStateLabel(
  status: CodexRuntimeStatus | null,
  action: RuntimeAction,
): string {
  if (action === 'checking') return 'Checking';
  if (action === 'installing') return 'Installing';
  if (status?.ready) return 'Ready';
  if (status?.installed) return 'Needs attention';
  return 'Not installed';
}

interface CodexRuntimeSetupProps {
  compact?: boolean;
  disabled?: boolean;
}

/**
 * Shows the local coding engine separately from the model provider.
 * LLMGateway can be connected even when Codex still needs to be installed.
 */
export function CodexRuntimeSetup({ compact = false, disabled = false }: CodexRuntimeSetupProps) {
  const [status, setStatus] = useState<CodexRuntimeStatus | null>(null);
  const [action, setAction] = useState<RuntimeAction>('checking');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (disabled) {
      setAction('idle');
      return;
    }
    setAction('checking');
    setError(null);
    try {
      const next = await window.anvil.settings.getCodexRuntimeStatus();
      setStatus(next);
      if (next.error) setError(next.error);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not check the coding engine.');
    } finally {
      setAction('idle');
    }
  }, [disabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = async () => {
    setAction('installing');
    setError(null);
    try {
      const next = await window.anvil.settings.installCodexRuntime();
      setStatus(next);
      if (next.error) setError(next.error);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not install the coding engine.');
    } finally {
      setAction('idle');
    }
  };

  const ready = Boolean(status?.ready);
  const installed = Boolean(status?.installed);
  const busy = action !== 'idle' || disabled;
  const statusLabel = codexRuntimeStateLabel(status, action);

  return (
    <div
      aria-busy={busy}
      className={`space-y-3 rounded-md border border-border bg-bg-primary ${compact ? 'p-3' : 'p-4'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {action === 'checking' ? (
              <Loader2
                size={15}
                className="shrink-0 animate-spin text-text-tertiary"
                aria-hidden="true"
              />
            ) : ready ? (
              <CheckCircle size={15} className="shrink-0 text-success" aria-hidden="true" />
            ) : installed ? (
              <Wrench size={15} className="shrink-0 text-warning" aria-hidden="true" />
            ) : (
              <Download size={15} className="shrink-0 text-text-tertiary" aria-hidden="true" />
            )}
            <p className="text-sm font-medium text-text-primary">Coding engine</p>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${
                ready
                  ? 'bg-success/10 text-success'
                  : installed
                    ? 'bg-warning/10 text-warning'
                    : 'bg-bg-tertiary text-text-tertiary'
              }`}
              aria-live="polite"
            >
              {statusLabel}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">
            Codex runs locally to edit files and run commands. Models and billing come through
            LLMGateway. No ChatGPT account is required.
          </p>
          {!ready && (
            <p className="mt-1 text-xs text-text-tertiary">
              Anvil installs and manages Codex for you.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          aria-label="Refresh coding engine status"
          title="Refresh coding engine status"
          className="shrink-0 rounded-md p-1.5 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
        >
          <RefreshCcw size={14} className={action === 'checking' ? 'animate-spin' : ''} />
        </button>
      </div>

      {status?.version && (
        <p className="font-mono text-xs text-text-tertiary">
          {status.source === 'managed' ? 'Anvil-managed' : 'System installation'} · Codex{' '}
          {status.version}
        </p>
      )}

      {error && (
        <div className="flex items-start gap-2 text-xs text-error" role="alert">
          <XCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {!ready && !disabled && (
        <button
          type="button"
          onClick={() => void install()}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-xs font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {action === 'installing' && <Loader2 size={13} className="animate-spin" />}
          {action === 'installing'
            ? 'Installing coding engine…'
            : installed
              ? 'Repair coding engine'
              : 'Install coding engine'}
        </button>
      )}
    </div>
  );
}
