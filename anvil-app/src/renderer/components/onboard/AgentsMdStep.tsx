import { useCallback, useEffect, useState } from 'react';
import { FileText, Loader2, Check, AlertTriangle, Download, GitCommit } from 'lucide-react';
import type { OnboardDetection } from '../../../shared/types';

interface AgentsMdStepProps {
  repoId: string;
  detection: OnboardDetection;
  onNext: () => void;
}

export function AgentsMdStep({ repoId, detection, onNext }: AgentsMdStepProps) {
  const [content, setContent] = useState<string>('');
  const [generating, setGenerating] = useState(false);
  const [writing, setWriting] = useState(false);
  const [written, setWritten] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isUpdate = detection.agentsMdStaleness === 'stale';

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const md = await window.anvil.onboard.generateAgentsMd(repoId);
      setContent(md);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  }, [repoId]);

  // On mount: load existing file if present and not stale, otherwise generate
  useEffect(() => {
    if (detection.agentsMdExists && detection.agentsMdStaleness !== 'stale') {
      window.anvil.onboard.readArtifact(repoId, 'agents-md').then((existing) => {
        if (existing) {
          setContent(existing);
          setWritten(true);
        } else {
          handleGenerate();
        }
      });
    } else {
      handleGenerate();
    }
  }, [repoId, detection.agentsMdExists, detection.agentsMdStaleness, handleGenerate]);

  const handleWrite = useCallback(async () => {
    setWriting(true);
    setError(null);
    try {
      await window.anvil.onboard.writeArtifact(repoId, 'agents-md', content);
      setWritten(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Write failed');
    } finally {
      setWriting(false);
    }
  }, [repoId, content]);

  const handleWriteAndCommit = useCallback(async () => {
    setCommitting(true);
    setError(null);
    try {
      await window.anvil.onboard.writeAndCommit(
        repoId,
        'agents-md',
        content,
        'chore: add AGENTS.md',
      );
      setWritten(true);
      setCommitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Write & commit failed');
    } finally {
      setCommitting(false);
    }
  }, [repoId, content]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText size={16} className="text-info" />
          <h3 className="text-base font-semibold text-text-primary">
            {isUpdate ? 'Update AGENTS.md' : 'Generate AGENTS.md'}
          </h3>
        </div>

        {written && (
          <span className="flex items-center gap-1 text-xs text-success">
            <Check size={12} />
            Written to repo
          </span>
        )}
      </div>

      {isUpdate && (
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
          <p className="text-sm text-warning">
            Existing AGENTS.md appears stale. A new version has been generated below. Review and
            edit before writing.
          </p>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-error/30 bg-error/10 px-3 py-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-error" />
          <p className="text-sm text-error">{error}</p>
        </div>
      )}

      {generating ? (
        <div className="flex h-64 items-center justify-center rounded-md border border-border bg-bg-tertiary">
          <div className="text-center">
            <Loader2 size={24} className="mx-auto mb-2 animate-spin text-accent" />
            <p className="text-sm text-text-secondary">Generating AGENTS.md with AI...</p>
            <p className="text-xs text-text-tertiary">This may take a moment</p>
          </div>
        </div>
      ) : (
        <textarea
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            setWritten(false);
          }}
          className="h-96 w-full resize-y rounded-md border border-border bg-bg-primary p-3 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
          placeholder="AGENTS.md content will appear here..."
        />
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={handleWrite}
          disabled={!content || writing || generating}
          className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
        >
          {writing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {written ? 'Write Again' : 'Write to Repo'}
        </button>

        <button
          onClick={handleWriteAndCommit}
          disabled={!content || committing || generating || committed}
          className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
        >
          {committing ? (
            <Loader2 size={14} className="animate-spin" />
          ) : committed ? (
            <Check size={14} />
          ) : (
            <GitCommit size={14} />
          )}
          {committed ? 'Committed' : 'Write & Commit'}
        </button>

        <button
          onClick={handleGenerate}
          disabled={generating}
          className="rounded-md border border-border px-3 py-2 text-sm text-text-secondary hover:text-text-primary disabled:opacity-40"
        >
          Regenerate
        </button>

        <button
          onClick={onNext}
          className="ml-auto rounded-md border border-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
        >
          {written ? 'Continue' : 'Skip'}
        </button>
      </div>
    </div>
  );
}
