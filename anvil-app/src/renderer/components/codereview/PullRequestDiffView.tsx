import { useEffect, useMemo, useState } from 'react';
import { FileCode2, FilePlus2, FileX2, Loader2, MessageSquareText } from 'lucide-react';
import type { PullRequestDiff, PullRequestDiffFile } from '../../../shared/types';
import { DiffViewer } from '../chat/DiffViewer';

interface PullRequestDiffViewProps {
  repoId: string;
  pullRequestId: string;
  focusFilePath?: string;
  onAskInChat?: (file: PullRequestDiffFile) => void;
}

export function PullRequestDiffView({
  repoId,
  pullRequestId,
  focusFilePath,
  onAskInChat,
}: PullRequestDiffViewProps) {
  const [diff, setDiff] = useState<PullRequestDiff | null>(null);
  const [selectedPath, setSelectedPath] = useState(focusFilePath ?? '');
  const [reviewedPaths, setReviewedPaths] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void window.anvil.codereview
      .getPullRequestDiff(repoId, pullRequestId)
      .then((nextDiff) => {
        if (cancelled) return;
        setDiff(nextDiff);
        setSelectedPath((current) =>
          nextDiff.files.some((file) => file.filePath === current)
            ? current
            : (nextDiff.files[0]?.filePath ?? ''),
        );
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pullRequestId, repoId]);

  useEffect(() => {
    if (focusFilePath) setSelectedPath(focusFilePath);
  }, [focusFilePath]);

  const selectedFile = useMemo(
    () => diff?.files.find((file) => file.filePath === selectedPath) ?? null,
    [diff?.files, selectedPath],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-text-secondary">
        <Loader2 size={16} className="animate-spin text-accent" /> Loading pull request diff…
      </div>
    );
  }

  if (error) {
    return <div className="p-6 text-sm text-error">Could not load the diff: {error}</div>;
  }

  if (!diff || diff.files.length === 0) {
    return (
      <div className="p-6 text-sm text-text-secondary">This pull request has no file diff.</div>
    );
  }

  return (
    <div className="flex h-full min-h-0 bg-bg-primary">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border-subtle bg-bg-secondary/70">
        <div className="border-b border-border-subtle px-3 py-3">
          <p className="text-sm font-semibold text-text-primary">Changed files</p>
          <p className="mt-1 text-xs tabular-nums text-text-tertiary">
            {reviewedPaths.size}/{diff.files.length} reviewed
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {diff.files.map((file) => {
            const selected = file.filePath === selectedPath;
            const reviewed = reviewedPaths.has(file.filePath);
            return (
              <button
                key={file.filePath}
                type="button"
                onClick={() => setSelectedPath(file.filePath)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
                  selected
                    ? 'bg-accent/10 text-text-primary'
                    : 'text-text-secondary hover:bg-bg-tertiary/70 hover:text-text-primary'
                }`}
              >
                <DiffFileIcon file={file} />
                <span className="min-w-0 flex-1 truncate font-mono" title={file.filePath}>
                  {file.filePath}
                </span>
                {reviewed && (
                  <span className="text-success" aria-label="Reviewed">
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {selectedFile && (
          <>
            <header className="flex min-h-12 items-center gap-3 border-b border-border-subtle bg-bg-secondary/45 px-4">
              <DiffFileIcon file={selectedFile} />
              <span
                className="min-w-0 flex-1 truncate font-mono text-xs text-text-primary"
                title={selectedFile.filePath}
              >
                {selectedFile.filePath}
              </span>
              <label className="flex items-center gap-2 text-xs text-text-secondary">
                <input
                  type="checkbox"
                  checked={reviewedPaths.has(selectedFile.filePath)}
                  onChange={(event) => {
                    setReviewedPaths((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(selectedFile.filePath);
                      else next.delete(selectedFile.filePath);
                      return next;
                    });
                  }}
                />
                Reviewed
              </label>
              {onAskInChat && (
                <button
                  type="button"
                  onClick={() => onAskInChat(selectedFile)}
                  className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                >
                  <MessageSquareText size={13} /> Ask in chat
                </button>
              )}
            </header>
            <div className="min-h-0 flex-1 overflow-auto">
              <DiffViewer filePath={selectedFile.filePath} diff={selectedFile.diff} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function DiffFileIcon({ file }: { file: PullRequestDiffFile }) {
  if (file.status === 'added') return <FilePlus2 size={14} className="shrink-0 text-success" />;
  if (file.status === 'deleted') return <FileX2 size={14} className="shrink-0 text-error" />;
  return <FileCode2 size={14} className="shrink-0 text-warning" />;
}
