import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, MessageSquarePlus, RotateCcw, Send, Trash2, X } from 'lucide-react';
import type { ChatArtifact, ChatArtifactAnnotation } from '../../../shared/types';
import { CHAT_PREFILL_EVENT } from './AgentUIIntentSurface';
import { ConfirmDialog } from '../ui';
import { useChatReviewFeedback } from './ChatReviewFeedbackContext';
import {
  buildArtifactAnnotationBody,
  formatLineRange,
  type ChatReviewFeedbackDraft,
  type ChatReviewFeedbackSource,
  type ReviewLineRange,
} from './chat-review-feedback';

export function buildArtifactAnnotationPrompt(
  artifact: Pick<ChatArtifact, 'title' | 'relativePath'>,
  annotation: Pick<ChatArtifactAnnotation, 'body' | 'quote'>,
): string {
  const quote = annotation.quote
    ? `\n\nQuoted selection:\n> ${annotation.quote.replace(/\n/g, '\n> ')}`
    : '';
  return `Please address this annotation on “${artifact.title}” (${artifact.relativePath}):\n\n${annotation.body}${quote}`;
}

export function selectedArtifactPassage(content: string): {
  quote?: string;
  lineRange?: ReviewLineRange;
} | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const sourceRoot = closestElement(range.startContainer, '[data-artifact-review-source]');
  if (!sourceRoot || !sourceRoot.contains(range.endContainer)) return null;

  const quote = selection.toString().trim().slice(0, 5_000);
  if (!quote) return null;

  if (sourceRoot.getAttribute('data-artifact-exact-lines') !== 'true') return { quote };

  const startOffset = textOffset(sourceRoot, range.startContainer, range.startOffset);
  const endOffset = textOffset(sourceRoot, range.endContainer, range.endOffset);
  return {
    quote,
    lineRange: {
      startLine: content.slice(0, startOffset).split('\n').length,
      endLine: content.slice(0, endOffset).split('\n').length,
    },
  };
}

export function selectedAnnotationQuote(): string | undefined {
  return selectedArtifactPassage('')?.quote;
}

function closestElement(node: Node, selector: string): HTMLElement | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return element?.closest<HTMLElement>(selector) ?? null;
}

function createArtifactFeedbackSource(
  artifact: ChatArtifact,
  quote: string | undefined,
  lineRange: ReviewLineRange | undefined,
): Extract<ChatReviewFeedbackSource, { kind: 'artifact' }> {
  return {
    kind: 'artifact',
    artifactId: artifact.id,
    title: artifact.title,
    path:
      artifact.storage === 'session'
        ? artifact.relativePath
        : (artifact.filePath ?? `.anvil/artifacts/${artifact.relativePath}`),
    storage: artifact.storage,
    revision: { kind: 'artifact-version', version: artifact.version },
    ...(lineRange ? { lineRange } : {}),
    ...(quote ? { quote } : {}),
  };
}

function selectedFeedbackSource(
  artifact: ChatArtifact,
  sourceSnapshot: Extract<ChatReviewFeedbackSource, { kind: 'artifact' }> | null,
  quote: string | undefined,
  lineRange: ReviewLineRange | undefined,
): Extract<ChatReviewFeedbackSource, { kind: 'artifact' }> {
  const source = sourceSnapshot ?? createArtifactFeedbackSource(artifact, quote, lineRange);
  const selectedSource = { ...source };
  if (quote) selectedSource.quote = quote;
  else delete selectedSource.quote;
  if (lineRange) selectedSource.lineRange = lineRange;
  else delete selectedSource.lineRange;
  return selectedSource;
}

function textOffset(root: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

export function ArtifactAnnotationsPanel({
  artifact,
  mode = 'preview',
  onComposeFeedback,
}: {
  artifact: ChatArtifact;
  mode?: 'preview' | 'source';
  onComposeFeedback?: (draft: ChatReviewFeedbackDraft) => void;
}) {
  const [annotations, setAnnotations] = useState<ChatArtifactAnnotation[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [composing, setComposing] = useState(false);
  const [body, setBody] = useState('');
  const [quote, setQuote] = useState<string | undefined>();
  const [lineRange, setLineRange] = useState<ReviewLineRange | undefined>();
  const [selectionView, setSelectionView] = useState<'preview' | 'source' | null>(null);
  const [sourceSnapshot, setSourceSnapshot] = useState<Extract<
    ChatReviewFeedbackSource,
    { kind: 'artifact' }
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ChatArtifactAnnotation | null>(null);
  const artifactScope = `${artifact.threadId}:${artifact.id}`;
  const activeArtifactScopeRef = useRef(artifactScope);
  activeArtifactScopeRef.current = artifactScope;
  const reviewContext = useChatReviewFeedback();
  const composeFeedback = onComposeFeedback ?? reviewContext?.onComposeFeedback;

  useEffect(() => {
    let cancelled = false;
    setAnnotations([]);
    setComposing(false);
    setBody('');
    setQuote(undefined);
    setLineRange(undefined);
    setSelectionView(null);
    setSourceSnapshot(null);
    setDeleteTarget(null);
    setError(null);
    void window.anvil.chat
      .listArtifactAnnotations(artifact.id)
      .then((next) => {
        if (cancelled) return;
        setAnnotations(next);
        if (next.some((annotation) => annotation.status === 'open')) setExpanded(true);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Could not load annotations.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.id, artifact.threadId]);

  const beginAnnotation = () => {
    const passage = selectedArtifactPassage(artifact.content);
    setQuote(passage?.quote);
    setLineRange(passage?.lineRange);
    setSelectionView(mode);
    setSourceSnapshot(createArtifactFeedbackSource(artifact, passage?.quote, passage?.lineRange));
    setComposing(true);
    setExpanded(true);
    setError(null);
  };

  const createAnnotation = async () => {
    if (!body.trim()) return;
    const artifactId = artifact.id;
    const sourceScope = artifactScope;
    try {
      const source = selectedFeedbackSource(artifact, sourceSnapshot, quote, lineRange);
      const created = await window.anvil.chat.createArtifactAnnotation({
        artifactId,
        body: buildArtifactAnnotationBody(source, body),
        quote,
      });
      if (activeArtifactScopeRef.current !== sourceScope) return;
      setAnnotations((current) => [created, ...current]);
      setBody('');
      setQuote(undefined);
      setLineRange(undefined);
      setSelectionView(null);
      setSourceSnapshot(null);
      setComposing(false);
      setError(null);
    } catch (caught) {
      if (activeArtifactScopeRef.current === sourceScope) {
        setError(caught instanceof Error ? caught.message : 'Could not save annotation.');
      }
    }
  };

  const composeInChat = () => {
    if (!body.trim() || !composeFeedback) return;
    composeFeedback({
      threadId: artifact.threadId,
      source: selectedFeedbackSource(artifact, sourceSnapshot, quote, lineRange),
      body: body.trim(),
    });
    setComposing(false);
    setBody('');
    setQuote(undefined);
    setLineRange(undefined);
    setSelectionView(null);
    setSourceSnapshot(null);
  };

  const setStatus = async (annotation: ChatArtifactAnnotation) => {
    const sourceScope = artifactScope;
    try {
      const updated = await window.anvil.chat.updateArtifactAnnotation(annotation.id, {
        status: annotation.status === 'open' ? 'resolved' : 'open',
      });
      if (activeArtifactScopeRef.current !== sourceScope) return;
      setAnnotations((current) =>
        current
          .map((candidate) => (candidate.id === updated.id ? updated : candidate))
          .sort(
            (left, right) =>
              Number(left.status === 'resolved') - Number(right.status === 'resolved'),
          ),
      );
    } catch (caught) {
      if (activeArtifactScopeRef.current === sourceScope) {
        setError(caught instanceof Error ? caught.message : 'Could not update annotation.');
      }
    }
  };

  const remove = async (annotation: ChatArtifactAnnotation) => {
    const sourceScope = artifactScope;
    try {
      await window.anvil.chat.deleteArtifactAnnotation(annotation.id);
      if (activeArtifactScopeRef.current !== sourceScope) return;
      setAnnotations((current) => current.filter((candidate) => candidate.id !== annotation.id));
    } catch (caught) {
      if (activeArtifactScopeRef.current === sourceScope) {
        setError(caught instanceof Error ? caught.message : 'Could not delete annotation.');
      }
    }
  };

  const askAgent = (annotation: ChatArtifactAnnotation) => {
    window.dispatchEvent(
      new CustomEvent(CHAT_PREFILL_EVENT, {
        detail: { text: buildArtifactAnnotationPrompt(artifact, annotation) },
      }),
    );
  };

  const visibleAnnotations = annotations.filter(
    (annotation) => annotation.artifactId === artifact.id,
  );
  const openCount = visibleAnnotations.filter((annotation) => annotation.status === 'open').length;

  return (
    <section className="shrink-0 border-t border-border/60 bg-bg-secondary/95">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <MessageSquarePlus size={14} className="shrink-0 text-accent" />
          <span className="text-xs font-medium text-text-primary">Annotations</span>
          {visibleAnnotations.length > 0 && (
            <span className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-eyebrow text-text-tertiary">
              {openCount} open · {visibleAnnotations.length} total
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={beginAnnotation}
          className="rounded-md border border-border px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
          title="Capture feedback with the selected artifact passage"
        >
          Add feedback
        </button>
      </div>

      {expanded && (
        <div className="max-h-72 space-y-2 overflow-auto border-t border-border/50 px-3 py-2">
          {composing && (
            <div className="space-y-2 rounded-lg border border-accent/25 bg-bg-primary/70 p-2">
              <p className="text-xs text-text-tertiary">
                {(selectionView ?? mode) === 'source' ? 'Source view' : 'Artifact preview'} · v
                {sourceSnapshot?.revision.version ?? artifact.version} ·{' '}
                {sourceSnapshot?.path ?? artifact.relativePath}
                {sourceSnapshot?.storage === 'session' ? ' · session-only' : ''}
                {sourceSnapshot && sourceSnapshot.revision.version !== artifact.version
                  ? ` · current v${artifact.version}`
                  : ''}
                {lineRange && ` · ${formatLineRange(lineRange)}`}
              </p>
              {quote && (
                <div className="relative rounded-md border-l-2 border-accent/50 bg-bg-tertiary/50 px-2 py-1.5 pr-7 font-mono text-xs text-text-tertiary">
                  <span className="line-clamp-3 whitespace-pre-wrap">{quote}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setQuote(undefined);
                      setLineRange(undefined);
                    }}
                    className="absolute right-1 top-1 rounded p-1 hover:bg-bg-tertiary"
                    aria-label="Remove quoted selection"
                  >
                    <X size={11} />
                  </button>
                </div>
              )}
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                rows={3}
                autoFocus
                placeholder="Describe the feedback you want addressed…"
                className="w-full resize-y rounded-md border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent/50"
              />
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setComposing(false);
                    setBody('');
                    setQuote(undefined);
                    setLineRange(undefined);
                    setSelectionView(null);
                    setSourceSnapshot(null);
                  }}
                  className="rounded-md px-2 py-1 text-xs text-text-tertiary hover:bg-bg-tertiary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void createAnnotation()}
                  disabled={!body.trim()}
                  className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Save note
                </button>
                {composeFeedback && (
                  <button
                    type="button"
                    onClick={composeInChat}
                    disabled={!body.trim()}
                    className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Send size={11} />
                    Compose in chat
                  </button>
                )}
              </div>
            </div>
          )}

          {error && <p className="text-xs text-error">{error}</p>}
          {!composing && visibleAnnotations.length === 0 && (
            <p className="py-2 text-center text-xs text-text-tertiary">
              Select artifact text for a quote, or add feedback about the whole revision.
            </p>
          )}
          {visibleAnnotations.map((annotation) => (
            <article
              key={annotation.id}
              className={`rounded-lg border p-2 ${
                annotation.status === 'resolved'
                  ? 'border-border/50 bg-bg-primary/30 opacity-70'
                  : 'border-border bg-bg-primary/70'
              }`}
            >
              {annotation.quote && (
                <blockquote className="mb-1.5 line-clamp-3 border-l-2 border-accent/40 pl-2 font-mono text-xs text-text-tertiary">
                  {annotation.quote}
                </blockquote>
              )}
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-text-secondary">
                {annotation.body}
              </p>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-xs text-text-tertiary">
                  {annotation.status === 'resolved' ? 'Resolved' : 'Open'}
                </span>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => askAgent(annotation)}
                    className="rounded p-1 text-text-tertiary hover:bg-accent/10 hover:text-accent"
                    title="Ask agent about this annotation"
                    aria-label="Ask agent about this annotation"
                  >
                    <Send size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void setStatus(annotation)}
                    className="rounded p-1 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
                    title={
                      annotation.status === 'open' ? 'Resolve annotation' : 'Reopen annotation'
                    }
                    aria-label={
                      annotation.status === 'open' ? 'Resolve annotation' : 'Reopen annotation'
                    }
                  >
                    {annotation.status === 'open' ? (
                      <CheckCircle2 size={12} />
                    ) : (
                      <RotateCcw size={12} />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(annotation)}
                    className="rounded p-1 text-text-tertiary hover:bg-error/10 hover:text-error"
                    title="Delete annotation"
                    aria-label="Delete annotation"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this annotation?"
        description="The note is removed from the artifact. Quoted text in the artifact itself is not changed."
        confirmLabel="Delete note"
        tone="danger"
        onConfirm={() => {
          if (deleteTarget) void remove(deleteTarget);
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </section>
  );
}
