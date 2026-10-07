import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cloud, Code2, Loader2, Puzzle, RefreshCcw, Save } from 'lucide-react';
import type { CodexUsageSnapshot } from '../../../../shared/types';
import { Button } from '../../ui';
import { CodexUsagePanel } from '../CodexUsagePanel';
import { EditableAgentsPanel } from '../EditableAgentsPanel';
import { useSettingsContext } from '../SettingsContext';
import { SettingsPanel } from '../settings-ui';

type CodexAgentsStatus = { tone: 'success' | 'error'; message: string };

export function AgentsCategory() {
  const { draft, reportError } = useSettingsContext();
  const navigate = useNavigate();

  const [codexUsage, setCodexUsage] = useState<CodexUsageSnapshot | null>(null);
  const [codexUsageLoading, setCodexUsageLoading] = useState(false);
  const [codexAgentsContent, setCodexAgentsContent] = useState('');
  const [codexAgentsPath, setCodexAgentsPath] = useState('~/.codex/AGENTS.md');
  const [codexAgentsExists, setCodexAgentsExists] = useState(false);
  const [codexAgentsUpdatedAt, setCodexAgentsUpdatedAt] = useState<string | null>(null);
  const [codexAgentsLoading, setCodexAgentsLoading] = useState(false);
  const [codexAgentsSaving, setCodexAgentsSaving] = useState(false);
  const [codexAgentsStatus, setCodexAgentsStatus] = useState<CodexAgentsStatus | null>(null);

  const refreshCodexUsage = useCallback(async () => {
    setCodexUsageLoading(true);
    try {
      setCodexUsage(await window.anvil.codexUsage.snapshot());
    } finally {
      setCodexUsageLoading(false);
    }
  }, []);

  const refreshCodexAgentsFile = useCallback(async () => {
    setCodexAgentsLoading(true);
    setCodexAgentsStatus(null);
    try {
      const file = await window.anvil.settings.getCodexAgentsFile();
      setCodexAgentsContent(file.content);
      setCodexAgentsPath(file.path);
      setCodexAgentsExists(file.exists);
      setCodexAgentsUpdatedAt(file.updatedAt ?? null);
    } catch (err) {
      setCodexAgentsStatus({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Failed to read Codex AGENTS.md',
      });
    } finally {
      setCodexAgentsLoading(false);
    }
  }, []);

  const saveCodexAgentsFile = async () => {
    setCodexAgentsSaving(true);
    setCodexAgentsStatus(null);
    try {
      const result = await window.anvil.settings.saveCodexAgentsFile(codexAgentsContent);
      setCodexAgentsPath(result.path);
      setCodexAgentsExists(true);
      setCodexAgentsUpdatedAt(result.savedAt);
      setCodexAgentsStatus({
        tone: 'success',
        message: `Saved ${new Intl.NumberFormat().format(result.bytes)} bytes.`,
      });
    } catch (err) {
      setCodexAgentsStatus({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Failed to save Codex AGENTS.md',
      });
    } finally {
      setCodexAgentsSaving(false);
    }
  };

  const updateCloudFeatures = async (enabled: boolean) => {
    try {
      await window.anvil.settings.update({ cloudFeaturesEnabled: enabled });
      // Instant action — merge into the draft without clearing unrelated
      // pending edits (ST1).
      draft.applyPersisted({ cloudFeaturesEnabled: enabled });
      window.dispatchEvent(new CustomEvent('anvil:cloud-feature-changed', { detail: { enabled } }));
    } catch (err) {
      reportError(err instanceof Error ? err.message : 'Failed to update Anvil Cloud access');
    }
  };

  useEffect(() => {
    refreshCodexUsage().catch(console.error);
    refreshCodexAgentsFile().catch(console.error);
  }, [refreshCodexUsage, refreshCodexAgentsFile]);

  return (
    <>
      <SettingsPanel
        panelId="codex-registry"
        title="Codex Registry"
        description="Inspect registered Codex skills and MCP servers, then install new skills from skills.sh."
      >
        <Button variant="secondary" onClick={() => navigate('/settings/codex-registry')}>
          <Puzzle size={14} />
          Manage Skills & MCPs
        </Button>
      </SettingsPanel>

      <SettingsPanel
        panelId="codex-usage"
        title="Codex usage"
        description="Live account usage and quota windows from Codex app-server when the local CLI exposes them."
      >
        <CodexUsagePanel
          snapshot={codexUsage}
          loading={codexUsageLoading}
          onRefresh={refreshCodexUsage}
        />
      </SettingsPanel>

      <SettingsPanel
        panelId="codex-agents-md"
        title="Personal Codex instructions"
        description="Edit the global AGENTS.md that Codex reads from your home configuration."
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border bg-bg-primary p-3">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                <Code2 size={15} className="text-accent" />
                <span className="truncate font-mono text-xs">{codexAgentsPath}</span>
              </div>
              <p className="text-xs text-text-tertiary">
                {codexAgentsExists
                  ? codexAgentsUpdatedAt
                    ? `Last saved ${new Date(codexAgentsUpdatedAt).toLocaleString()}`
                    : 'Existing personal instructions file.'
                  : 'File does not exist yet. Saving here will create it.'}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={refreshCodexAgentsFile}
                disabled={codexAgentsLoading || codexAgentsSaving}
              >
                {codexAgentsLoading ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <RefreshCcw size={13} />
                )}
                Reload
              </Button>
              <Button
                size="sm"
                onClick={saveCodexAgentsFile}
                disabled={codexAgentsLoading || codexAgentsSaving}
              >
                {codexAgentsSaving ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Save size={13} />
                )}
                Save
              </Button>
            </div>
          </div>
          <textarea
            value={codexAgentsContent}
            onChange={(event) => {
              setCodexAgentsContent(event.target.value);
              setCodexAgentsStatus(null);
            }}
            disabled={codexAgentsLoading}
            placeholder="# Personal Codex Instructions"
            rows={12}
            className="min-h-72 w-full resize-y rounded-md border border-border bg-bg-primary px-3 py-2 font-mono text-sm leading-relaxed text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none disabled:opacity-60"
          />
          {codexAgentsStatus && (
            <p
              className={`text-sm ${
                codexAgentsStatus.tone === 'success' ? 'text-success' : 'text-error'
              }`}
            >
              {codexAgentsStatus.message}
            </p>
          )}
        </div>
      </SettingsPanel>

      <SettingsPanel
        panelId="anvil-cloud"
        title="Anvil Cloud"
        description="Expose Cell checks, local runtime inspection, and Lens from inside the app."
        saveKeys={['cloudFeaturesEnabled']}
      >
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-bg-primary p-4 transition-colors hover:bg-bg-tertiary">
          <input
            type="checkbox"
            checked={draft.settings.cloudFeaturesEnabled ?? false}
            onChange={(event) => void updateCloudFeatures(event.target.checked)}
            className="mt-1 h-4 w-4 accent-accent"
          />
          <span className="min-w-0">
            <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <Cloud size={15} className="text-accent" />
              Enable Cloud workbench
            </span>
            <span className="mt-1 block text-sm leading-relaxed text-text-secondary">
              Adds a workspace tool for Anvil Cloud CLI diagnostics, local Cell artifacts,
              workflows, services, agents, logs, and Anvil Lens. Nothing is enabled until this box
              is checked.
            </span>
          </span>
        </label>
      </SettingsPanel>

      <SettingsPanel
        panelId="custom-agents"
        title="Custom agents"
        description="User-defined agents usable anywhere personas are selected. They sync across devices when Sync & Mesh is enabled."
      >
        <EditableAgentsPanel />
      </SettingsPanel>
    </>
  );
}
