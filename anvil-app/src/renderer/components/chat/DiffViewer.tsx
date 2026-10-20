import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { Send, X } from 'lucide-react';
import { useChatReviewFeedback } from './ChatReviewFeedbackContext';
import {
  fingerprintPatchSnapshot,
  type ChatReviewFeedbackDraft,
  type DiffReviewPosition,
} from './chat-review-feedback';

interface DiffViewerProps {
  filePath: string;
  diff: string;
  /** Supply a commit identity when the caller knows one; patch hashes remain local fingerprints. */
  revision?: { kind: 'git-commit'; sha: string };
  threadId?: string | null;
  onComposeFeedback?: (draft: ChatReviewFeedbackDraft) => void;
}

type ViewMode = 'unified' | 'split';
type DiffLineKind = 'hunk' | 'context' | 'added' | 'removed';

interface ParsedDiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

interface SplitDiffRow {
  hunk?: string;
  oldLine?: ParsedDiffLine;
  newLine?: ParsedDiffLine;
}

export function parseUnifiedDiffLines(diff: string): ParsedDiffLine[] {
  const rows: ParsedDiffLine[] = [];
  let oldLine: number | null = null;
  let newLine: number | null = null;

  diff
    .replace(/\r\n/g, '\n')
    .split('\n')
    .forEach((line, index, allLines) => {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        rows.push({ kind: 'hunk', text: line, oldLine: null, newLine: null });
        return;
      }
      if (oldLine === null || newLine === null || line.startsWith('\\')) return;
      if (
        line.startsWith('diff ') ||
        line.startsWith('index ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ')
      ) {
        return;
      }
      if (line === '' && index === allLines.length - 1) return;

      if (line.startsWith('+')) {
        rows.push({ kind: 'added', text: line.slice(1), oldLine: null, newLine });
        newLine += 1;
      } else if (line.startsWith('-')) {
        rows.push({ kind: 'removed', text: line.slice(1), oldLine, newLine: null });
        oldLine += 1;
      } else if (line.startsWith(' ') || line === '') {
        const text = line.startsWith(' ') ? line.slice(1) : '';
        rows.push({ kind: 'context', text, oldLine, newLine });
        oldLine += 1;
        newLine += 1;
      }
    });

  return rows;
}

function makeSplitRows(lines: ParsedDiffLine[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.kind === 'hunk') {
      rows.push({ hunk: line.text });
      index += 1;
      continue;
    }
    if (line.kind === 'context') {
      rows.push({ oldLine: line, newLine: line });
      index += 1;
      continue;
    }
    if (line.kind === 'removed' || line.kind === 'added') {
      const removed: ParsedDiffLine[] = [];
      const added: ParsedDiffLine[] = [];
      while (index < lines.length && lines[index].kind === 'removed') {
        removed.push(lines[index]);
        index += 1;
      }
      while (index < lines.length && lines[index].kind === 'added') {
        added.push(lines[index]);
        index += 1;
      }
      for (let row = 0; row < Math.max(removed.length, added.length); row += 1) {
        rows.push({ oldLine: removed[row], newLine: added[row] });
      }
      continue;
    }
    index += 1;
  }

  return rows;
}

export function DiffViewer({
  filePath,
  diff,
  revision,
  threadId: threadIdOverride,
  onComposeFeedback: onComposeFeedbackOverride,
}: DiffViewerProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('unified');
  const [selection, setSelection] = useState<DiffReviewPosition | null>(null);
  const [feedbackBody, setFeedbackBody] = useState('');
  const [fingerprintState, setFingerprintState] = useState<{
    diff: string;
    fingerprint: string | null;
    error: string | null;
  }>({ diff: '', fingerprint: null, error: null });
  const patchFingerprint = fingerprintState.diff === diff ? fingerprintState.fingerprint : null;
  const fingerprintError = fingerprintState.diff === diff ? fingerprintState.error : null;
  const userSelectedRef = useRef(false);
  const context = useChatReviewFeedback();
  const threadId = threadIdOverride !== undefined ? threadIdOverride : (context?.threadId ?? null);
  const previousThreadIdRef = useRef(threadId);
  const onComposeFeedback = onComposeFeedbackOverride ?? context?.onComposeFeedback;
  const lines = useMemo(() => parseUnifiedDiffLines(diff), [diff]);
  const splitRows = useMemo(() => makeSplitRows(lines), [lines]);

  useEffect(() => {
    let cancelled = false;
    setFingerprintState({ diff, fingerprint: null, error: null });
    void fingerprintPatchSnapshot(diff)
      .then((fingerprint) => {
        if (!cancelled) setFingerprintState({ diff, fingerprint, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setFingerprintState({
            diff,
            fingerprint: null,
            error:
              error instanceof Error ? error.message : 'Could not fingerprint this diff snapshot.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [diff]);

  const positionKey = patchFingerprint ? `${filePath}\u0000${patchFingerprint}` : null;
  const previousSourceKeyRef = useRef(`${filePath}\u0000${diff}`);

  useEffect(() => {
    const sourceKey = `${filePath}\u0000${diff}`;
    if (previousSourceKeyRef.current === sourceKey) return;
    previousSourceKeyRef.current = sourceKey;
    userSelectedRef.current = false;
    setSelection(null);
    setFeedbackBody('');
  }, [diff, filePath]);

  useEffect(() => {
    if (previousThreadIdRef.current === threadId) return;
    previousThreadIdRef.current = threadId;
    userSelectedRef.current = false;
  }, [threadId]);

  useEffect(() => {
    if (!positionKey) return;
    if (userSelectedRef.current) {
      if (selection) context?.setDiffReviewPosition(positionKey, selection);
      return;
    }
    setSelection(context?.getDiffReviewPosition(positionKey) ?? null);
    setFeedbackBody('');
  }, [threadId, positionKey]);

  const selectLine = (side: 'old' | 'new', line: number, event: MouseEvent<HTMLButtonElement>) => {
    userSelectedRef.current = true;
    const next: DiffReviewPosition =
      event.shiftKey && selection?.side === side
        ? {
            side,
            anchorLine: selection.anchorLine,
            startLine: Math.min(selection.anchorLine, line),
            endLine: Math.max(selection.anchorLine, line),
          }
        : { side, anchorLine: line, startLine: line, endLine: line };
    setSelection(next);
    if (positionKey) context?.setDiffReviewPosition(positionKey, next);
  };

  const clearSelection = () => {
    setSelection(null);
    setFeedbackBody('');
    if (positionKey) context?.setDiffReviewPosition(positionKey, undefined);
  };

  const visibleSelectedLines = selection
    ? lines.filter((line) => {
        const number = selection.side === 'old' ? line.oldLine : line.newLine;
        return number !== null && number >= selection.startLine && number <= selection.endLine;
      })
    : [];
  const selectedQuote = visibleSelectedLines.map((line) => line.text).join('\n');
  const revisionSource =
    revision ??
    (patchFingerprint ? { kind: 'patch-snapshot' as const, sha256: patchFingerprint } : null);

  const composeFeedback = () => {
    if (!selection || !selectedQuote || !threadId || !revisionSource || !onComposeFeedback) return;
    onComposeFeedback({
      threadId,
      source: {
        kind: 'diff',
        path: filePath,
        revision: revisionSource,
        lineRange: {
          side: selection.side,
          startLine: selection.startLine,
          endLine: selection.endLine,
        },
        quote: selectedQuote,
      },
      body: feedbackBody.trim(),
    });
    setFeedbackBody('');
  };

  const selectedSideLabel = selection?.side === 'old' ? 'old side' : 'new side';

  return (
    <div className="diff-viewer overflow-auto text-xs">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle bg-bg-elevated px-3 py-1">
        <p className="min-w-0 truncate font-mono text-xs text-text-tertiary" title={filePath}>
          {filePath}
        </p>
        <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Diff layout">
          {(['unified', 'split'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setViewMode(mode)}
              aria-pressed={viewMode === mode}
              className={`rounded px-2 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                viewMode === mode
                  ? 'bg-bg-tertiary text-text-primary'
                  : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              {mode === 'unified' ? 'Unified' : 'Split'}
            </button>
          ))}
        </div>
      </div>

      {viewMode === 'unified' ? (
        <div className="min-w-max font-mono text-xs">
          {lines.map((line, index) =>
            line.kind === 'hunk' ? (
              <div
                key={`hunk-${index}`}
                className="border-y border-border/50 bg-bg-secondary/70 px-3 py-1 text-text-tertiary"
              >
                {line.text}
              </div>
            ) : (
              <UnifiedDiffLine
                key={`${line.oldLine ?? 'x'}-${line.newLine ?? 'x'}-${index}`}
                line={line}
                selection={selection}
                onSelectLine={selectLine}
              />
            ),
          )}
        </div>
      ) : (
        <div className="min-w-[720px] font-mono text-xs">
          {splitRows.map((row, index) =>
            row.hunk ? (
              <div
                key={`hunk-${index}`}
                className="border-y border-border/50 bg-bg-secondary/70 px-3 py-1 text-text-tertiary"
              >
                {row.hunk}
              </div>
            ) : (
              <SplitDiffLine
                key={`split-${index}`}
                row={row}
                selection={selection}
                onSelectLine={selectLine}
              />
            ),
          )}
        </div>
      )}

      {selection && (
        <section
          className="space-y-2 border-t border-border bg-bg-secondary px-3 py-2"
          aria-label="Diff feedback"
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-text-primary">
                {selectedSideLabel}, lines {selection.startLine}
                {selection.endLine !== selection.startLine ? `–${selection.endLine}` : ''}
              </p>
              <p className="mt-0.5 break-all font-mono text-xs text-text-tertiary">
                {revisionSource?.kind === 'git-commit'
                  ? `Git commit ${revisionSource.sha}`
                  : patchFingerprint
                    ? `Patch snapshot · SHA-256 ${patchFingerprint}`
                    : 'Fingerprinting diff snapshot…'}
              </p>
            </div>
            <button
              type="button"
              onClick={clearSelection}
              className="rounded p-1 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              aria-label="Clear selected diff lines"
              title="Clear selection"
            >
              <X size={13} />
            </button>
          </div>
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded border border-border/60 bg-bg-primary/50 px-2 py-1.5 text-xs leading-relaxed text-text-secondary">
            {selectedQuote || 'Selected lines are not present in the rendered diff.'}
          </pre>
          <textarea
            value={feedbackBody}
            onChange={(event) => setFeedbackBody(event.target.value)}
            rows={2}
            placeholder="What should change in these lines?"
            className="w-full resize-y rounded-md border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent/50 focus:ring-2 focus:ring-accent/30"
          />
          <div className="flex items-center justify-between gap-3">
            {fingerprintError ? (
              <p className="text-xs text-error">{fingerprintError}</p>
            ) : !onComposeFeedback ? (
              <p className="text-xs text-text-tertiary">
                Open this diff inside a chat thread to compose feedback.
              </p>
            ) : (
              <p className="text-xs text-text-tertiary">
                Feedback will be added to the chat composer.
              </p>
            )}
            <button
              type="button"
              onClick={composeFeedback}
              disabled={
                !feedbackBody.trim() ||
                !threadId ||
                !revisionSource ||
                !selectedQuote ||
                !onComposeFeedback
              }
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send size={12} />
              Compose in chat
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function UnifiedDiffLine({
  line,
  selection,
  onSelectLine,
}: {
  line: ParsedDiffLine;
  selection: DiffReviewPosition | null;
  onSelectLine: (side: 'old' | 'new', line: number, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const bg = line.kind === 'added' ? 'bg-success/10' : line.kind === 'removed' ? 'bg-error/10' : '';
  return (
    <div className={`flex min-h-6 border-b border-border-subtle/50 ${bg}`}>
      <LineNumberButton
        side="old"
        number={line.oldLine}
        selection={selection}
        onSelectLine={onSelectLine}
      />
      <LineNumberButton
        side="new"
        number={line.newLine}
        selection={selection}
        onSelectLine={onSelectLine}
      />
      <span className="w-6 shrink-0 select-none text-center text-text-tertiary">
        {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
      </span>
      <pre className="min-w-0 flex-1 whitespace-pre px-2 py-0.5 text-text-primary">{line.text}</pre>
    </div>
  );
}

function SplitDiffLine({
  row,
  selection,
  onSelectLine,
}: {
  row: SplitDiffRow;
  selection: DiffReviewPosition | null;
  onSelectLine: (side: 'old' | 'new', line: number, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className="grid grid-cols-2 border-b border-border-subtle/50">
      <SplitDiffCell
        side="old"
        line={row.oldLine}
        selection={selection}
        onSelectLine={onSelectLine}
      />
      <SplitDiffCell
        side="new"
        line={row.newLine}
        selection={selection}
        onSelectLine={onSelectLine}
      />
    </div>
  );
}

function SplitDiffCell({
  side,
  line,
  selection,
  onSelectLine,
}: {
  side: 'old' | 'new';
  line?: ParsedDiffLine;
  selection: DiffReviewPosition | null;
  onSelectLine: (side: 'old' | 'new', line: number, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const number = side === 'old' ? line?.oldLine : line?.newLine;
  const bg =
    line?.kind === 'added' ? 'bg-success/10' : line?.kind === 'removed' ? 'bg-error/10' : '';
  return (
    <div
      className={`flex min-h-6 min-w-0 ${side === 'new' ? 'border-l border-border-subtle' : ''} ${bg}`}
    >
      <LineNumberButton
        side={side}
        number={number ?? null}
        selection={selection}
        onSelectLine={onSelectLine}
      />
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre px-2 py-0.5 text-text-primary">
        {line?.text ?? ''}
      </pre>
    </div>
  );
}

function LineNumberButton({
  side,
  number,
  selection,
  onSelectLine,
}: {
  side: 'old' | 'new';
  number: number | null;
  selection: DiffReviewPosition | null;
  onSelectLine: (side: 'old' | 'new', line: number, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  if (number === null) {
    return <span className="w-12 shrink-0 border-r border-border-subtle/50 text-right" />;
  }
  const selected =
    selection?.side === side && number >= selection.startLine && number <= selection.endLine;
  return (
    <button
      type="button"
      onClick={(event) => onSelectLine(side, number, event)}
      aria-label={`Select ${side} diff line ${number}${eventShiftHint()}`}
      aria-pressed={selected}
      title={`Select ${side} line ${number}; shift-click to extend`}
      className={`w-12 shrink-0 border-r border-border-subtle/50 px-1 text-right tabular-nums focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70 ${
        selected
          ? 'bg-accent/20 text-accent'
          : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary'
      }`}
    >
      {number}
    </button>
  );
}

function eventShiftHint(): string {
  return '; shift-click to extend the selection';
}
