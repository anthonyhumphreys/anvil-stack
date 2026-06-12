import { useEffect, useState } from 'react';
import { CheckCircle, XCircle, Loader2, ExternalLink } from 'lucide-react';
import type { DocsProvider } from '../../../shared/types';

interface ConnectorsStepProps {
  onNext: () => void;
}

export function ConnectorsStep({ onNext }: ConnectorsStepProps) {
  const [docsProvider, setDocsProvider] = useState<DocsProvider | 'none'>('none');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.anvil.settings.get().then((s) => {
      setDocsProvider(s.docsProvider ?? 'none');
      setLoading(false);
    });
  }, []);

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.anvil.settings.testDocsProviderConnection();
      setTestResult(result);
    } catch {
      setTestResult({ ok: false, error: 'Connection test failed' });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-lg space-y-4">
        <h3 className="text-base font-semibold text-text-primary">Connectors</h3>
        <p className="text-sm text-text-secondary">Loading settings...</p>
      </div>
    );
  }

  const isConfigured = docsProvider !== 'none';

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h3 className="text-base font-semibold text-text-primary">Connectors</h3>
      <p className="text-sm text-text-secondary">
        Connect your documentation provider to enable browsing and generating docs.
      </p>

      <div className="rounded-lg border border-border bg-bg-secondary p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-medium text-text-primary">
              {docsProvider === 'confluence'
                ? 'Confluence'
                : docsProvider === 'notion'
                  ? 'Notion'
                  : 'No provider'}
            </h4>
            <p className="text-xs text-text-tertiary">
              {docsProvider === 'confluence'
                ? 'Confluence Data Center'
                : docsProvider === 'notion'
                  ? 'Notion via MCP'
                  : 'Configure in Settings'}
            </p>
          </div>
          {isConfigured && (
            <button
              onClick={testConnection}
              disabled={testing}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50"
            >
              {testing && <Loader2 size={10} className="animate-spin" />}
              Test
            </button>
          )}
        </div>

        {testResult && (
          <div
            className={`flex items-center gap-2 text-sm ${
              testResult.ok ? 'text-success' : 'text-error'
            }`}
          >
            {testResult.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}
            {testResult.ok ? 'Connected' : testResult.error}
          </div>
        )}

        {!isConfigured && (
          <p className="text-xs text-text-tertiary">
            You can configure your docs provider later in Settings.
          </p>
        )}
      </div>

      <div className="flex justify-end gap-3">
        <button
          onClick={onNext}
          className="flex items-center gap-1 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90"
        >
          Continue
          <ExternalLink size={12} className="rotate-180" />
        </button>
      </div>
    </div>
  );
}
