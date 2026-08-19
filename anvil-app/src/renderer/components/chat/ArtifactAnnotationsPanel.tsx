import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, MessageSquarePlus, RotateCcw, Send, Trash2, X } from 'lucide-react';
import type { ChatArtifact, ChatArtifactAnnotation } from '../../../shared/types';
import { CHAT_PREFILL_EVENT } from './AgentUIIntentSurface';

export function buildArtifactAnnotationPrompt(
  artifact: Pick<ChatArtifact, 'title' | 'relativePath'>,
  annotation: Pick<ChatArtifactAnnotation, 'body' | 'quote'>,
): string {
  const quote = annotation.quote
    ? `\n\nQuoted selection:\n> ${annotation.quote.replace(/\n/g, '\n> ')}`
    : '';
  return `Please address this annotation on “${artifact.title}” (${artifact.relativePath}):\n\n${annotation.body}${quote}`;
}

export function selectedAnnotationQuote(): string | undefined {
  const selection = window.getSelection()?.toString().trim();
  return selection ? selection.slice(0, 5_000) : undefined;
}

export function ArtifactAnnotationsPanel({ artifact }: { artifact: ChatArtifact }) {
  const [annotations, setAnnotations] = useState<ChatArtifactAnnotation[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [composing, setComposing] = useState(false);
  const [body, setBody] = useState('');
  const [quote, setQuote] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await window.anvil.chat.listArtifactAnnotations(artifact.id);
      setAnnotations(next);
      if (next.some((annotation) => annotation.status === 'open')) setExpanded(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load annotations.');
    }
  }, [artifact.id]);

  useEffect(() => {
    setAnnotations([]);
    setComposing(false);
    setBody('');
    setQuote(undefined);
    setError(null);
    void load();
  }, [load]);

  const beginAnnotation = () => {
    setQuote(selectedAnnotationQuote());
    setComposing(true);
    setExpanded(true);
    setError(null);
  };

  const createAnnotation = async () => {
    if (!body.trim()) return;
    try {
      const created = await window.anvil.chat.createArtifactAnnotation({
        artifactId: artifact.id,
        body,
        quote,
      });
      setAnnotations((current) => [created, ...current]);
      setBody('');
      setQuote(undefined);
      setComposing(false);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save annotation.');
    }
  };

  const setStatus = async (annotation: ChatArtifactAnnotation) => {
    try {
      const updated = await window.anvil.chat.updateArtifactAnnotation(annotation.id, {
        status: annotation.status === 'open' ? 'resolved' : 'open',
      });
      setAnnotations((current) =>
        current
          .map((candidate) => (candidate.id === updated.id ? updated : candidate))
          .sort(
            (left, right) =>
              Number(left.status === 'resolved') - Number(right.status === 'resolved'),
          ),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update annotation.');
    }
  };

  const remove = async (annotation: ChatArtifactAnnotation) => {
    if (!window.confirm('Delete this artifact annotation?')) return;
    try {
      await window.anvil.chat.deleteArtifactAnnotation(annotation.id);
      setAnnotations((current) => current.filter((candidate) => candidate.id !== annotation.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete annotation.');
    }
  };

  const askAgent = (annotation: ChatArtifactAnnotation) => {
    window.dispatchEvent(
      new CustomEvent(CHAT_PREFILL_EVENT, {
        detail: { text: buildArtifactAnnotationPrompt(artifact, annotation) },
      }),
    );
  };

  const openCount = annotations.filter((annotation) => annotation.status === 'open').length;

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
          {annotations.length > 0 && (
            <span className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-tertiary">
              {openCount} open · {annotations.length} total
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={beginAnnotation}
          className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
          title="Add a note; selected artifact text will be quoted"
        >
          Add note
        </button>
      </div>

      {expanded && (
        <div className="max-h-72 space-y-2 overflow-auto border-t border-border/50 px-3 py-2">
          {composing && (
            <div className="space-y-2 rounded-lg border border-accent/25 bg-bg-primary/70 p-2">
              {quote && (
                <div className="relative rounded-md border-l-2 border-accent/50 bg-bg-tertiary/50 px-2 py-1.5 pr-7 font-mono text-[10px] text-text-tertiary">
                  <span className="line-clamp-3 whitespace-pre-wrap">{quote}</span>
                  <button
                    type="button"
                    onClick={() => setQuote(undefined)}
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
                placeholder="Leave a note about this artifact…"
                className="w-full resize-y rounded-md border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent/50"
              />
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setComposing(false);
                    setBody('');
                    setQuote(undefined);
                  }}
                  className="rounded-md px-2 py-1 text-[11px] text-text-tertiary hover:bg-bg-tertiary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void createAnnotation()}
                  disabled={!body.trim()}
                  className="rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Save note
                </button>
              </div>
            </div>
          )}

          {error && <p className="text-[11px] text-error">{error}</p>}
          {!composing && annotations.length === 0 && (
            <p className="py-2 text-center text-[11px] text-text-tertiary">
              Select text in the artifact, then add a note to capture it as context.
            </p>
          )}
          {annotations.map((annotation) => (
            <article
              key={annotation.id}
              className={`rounded-lg border p-2 ${
                annotation.status === 'resolved'
                  ? 'border-border/50 bg-bg-primary/30 opacity-70'
                  : 'border-border bg-bg-primary/70'
              }`}
            >
              {annotation.quote && (
                <blockquote className="mb-1.5 line-clamp-3 border-l-2 border-accent/40 pl-2 font-mono text-[10px] text-text-tertiary">
                  {annotation.quote}
                </blockquote>
              )}
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-text-secondary">
                {annotation.body}
              </p>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[10px] text-text-tertiary">
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
                    onClick={() => void remove(annotation)}
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
    </section>
  );
}
