import { useCallback, useEffect, useState } from 'react';
import { Container, Loader2, Check, AlertTriangle, Download, GitCommit } from 'lucide-react';
import type { OnboardDetection } from '../../../shared/types';

interface DevcontainerStepProps {
  repoId: string;
  detection: OnboardDetection;
  onNext: () => void;
}

export function DevcontainerStep({ repoId, detection, onNext }: DevcontainerStepProps) {
  const [content, setContent] = useState<string>('');
  const [generating, setGenerating] = useState(false);
  const [writing, setWriting] = useState(false);
  const [written, setWritten] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alreadyExists = detection.devcontainerExists;

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const json = await window.anvil.onboard.generateDevcontainer(repoId);
      setContent(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  }, [repoId]);

  // On mount: load existing file if present, otherwise generate
  useEffect(() => {
    if (alreadyExists) {
      window.anvil.onboard.readArtifact(repoId, 'devcontainer').then((existing) => {
        if (existing) {
          setContent(existing);
          setWritten(true);
        }
      });
    } else {
      handleGenerate();
    }
  }, [repoId, handleGenerate, alreadyExists]);

  const handleWrite = useCallback(async () => {
    // Validate JSON before writing
    try {
      JSON.parse(content);
    } catch {
      setError('Content is not valid JSON. Please fix before writing.');
      return;
    }

    setWriting(true);
    setError(null);
    try {
      await window.anvil.onboard.writeArtifact(repoId, 'devcontainer', content);
      setWritten(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Write failed');
    } finally {
      setWriting(false);
    }
  }, [repoId, content]);

  const handleWriteAndCommit = useCallback(async () => {
    try {
      JSON.parse(content);
    } catch {
      setError('Content is not valid JSON. Please fix before writing.');
      return;
    }

    setCommitting(true);
    setError(null);
    try {
      await window.anvil.onboard.writeAndCommit(
        repoId,
        'devcontainer',
        content,
        'chore: add devcontainer.json',
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
          <Container size={16} className="text-info" />
          <h3 className="text-base font-semibold text-text-primary">Dev Container Configuration</h3>
        </div>

        {written && (
          <span className="flex items-center gap-1 text-xs text-success">
            <Check size={12} />
            Written to repo
          </span>
        )}
      </div>

      {alreadyExists && !content && (
        <div className="rounded-md border border-success/30 bg-success/10 p-4">
          <div className="flex items-center gap-2">
            <Check size={14} className="text-success" />
            <p className="text-sm text-success">
              A devcontainer.json already exists at{' '}
              <span className="font-mono">{detection.devcontainerPath}</span>
            </p>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleGenerate}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
            >
              Generate New Anyway
            </button>
            <button
              onClick={onNext}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
            >
              Skip
            </button>
          </div>
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
            <p className="text-sm text-text-secondary">Generating devcontainer.json...</p>
          </div>
        </div>
      ) : content ? (
        <>
          <textarea
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setWritten(false);
            }}
            className="h-80 w-full resize-y rounded-md border border-border bg-bg-primary p-3 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
          />

          <div className="flex items-center gap-3">
            <button
              onClick={handleWrite}
              disabled={!content || writing}
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
        </>
      ) : null}
    </div>
  );
}
