// src/renderer/components/layout/RunFallback.tsx

import { useState } from 'react';
import { Sparkles, Loader2, X } from 'lucide-react';
import type { RunCommand } from '../../../shared/run-types';
import type { RepoInfo } from '../../../shared/types';

interface Props {
  repos: RepoInfo[];
  onCommandSaved: (repoId: string, cmd: RunCommand) => void;
  onAiDetected: (repoId: string, cmds: RunCommand[]) => void;
  onClose: () => void;
}

export function RunFallback({ repos, onCommandSaved, onAiDetected, onClose }: Props) {
  const [customCommand, setCustomCommand] = useState('');
  const [selectedRepoId, setSelectedRepoId] = useState(repos[0]?.id ?? '');
  const [aiLoading, setAiLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAiDetect = async () => {
    if (!selectedRepoId) return;
    setAiLoading(true);
    setError(null);
    try {
      const cmds = await window.anvil.run.detectScriptsAi(selectedRepoId);
      if (cmds.length === 0) {
        setError('AI could not detect any run commands for this project.');
      } else {
        onAiDetected(selectedRepoId, cmds);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI detection failed');
    } finally {
      setAiLoading(false);
    }
  };

  const handleCustomSubmit = async () => {
    if (!customCommand.trim() || !selectedRepoId) return;
    const label = customCommand.trim().split(' ').slice(0, 3).join(' ');
    const cmd = await window.anvil.run.saveCustomCommand(
      selectedRepoId,
      label,
      customCommand.trim(),
    );
    onCommandSaved(selectedRepoId, cmd);
    setCustomCommand('');
  };

  return (
    <div className="absolute left-3 right-3 top-full z-50 mt-1 rounded-lg border border-border-subtle bg-bg-secondary p-4 shadow-lg">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-medium text-text-primary">How to run?</span>
        <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
          <X size={14} />
        </button>
      </div>

      {/* Repo selector if multiple */}
      {repos.length > 1 && (
        <select
          value={selectedRepoId}
          onChange={(e) => setSelectedRepoId(e.target.value)}
          className="mb-3 w-full rounded-md border border-border-subtle bg-bg-primary px-2 py-1.5 text-sm text-text-primary"
        >
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      )}

      {/* AI detect */}
      <button
        onClick={handleAiDetect}
        disabled={aiLoading}
        className="mb-3 flex w-full items-center justify-center gap-2 rounded-md bg-accent/15 px-3 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/25 disabled:opacity-50"
      >
        {aiLoading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
        Ask AI how to run this
      </button>

      {error && <p className="mb-3 text-xs text-error">{error}</p>}

      {/* Custom command */}
      <div className="flex gap-2">
        <input
          type="text"
          value={customCommand}
          onChange={(e) => setCustomCommand(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCustomSubmit()}
          placeholder="Or type a command..."
          className="flex-1 rounded-md border border-border-subtle bg-bg-primary px-2 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
        />
        <button
          onClick={handleCustomSubmit}
          disabled={!customCommand.trim()}
          className="rounded-md bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary transition-colors hover:bg-bg-elevated disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  );
}
