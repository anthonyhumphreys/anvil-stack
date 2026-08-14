import { useCallback, useEffect, useState } from 'react';
import { Check, Mic, Plus, RefreshCcw, Trash2 } from 'lucide-react';
import type { WorkspaceNote } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { ViewHeader } from '../layout/ViewScaffold';

export function WorkspaceNotesView() {
  const { activeWorkspace } = useWorkspace();
  const [notes, setNotes] = useState<WorkspaceNote[]>([]);
  const [body, setBody] = useState('');
  const [includeReviewed, setIncludeReviewed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadNotes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setNotes(await window.anvil.workspaceNotes.list(activeWorkspace?.id, includeReviewed));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspace notes.');
    } finally {
      setLoading(false);
    }
  }, [activeWorkspace?.id, includeReviewed]);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  const createNote = async () => {
    if (!body.trim()) return;
    setError(null);
    try {
      await window.anvil.workspaceNotes.create({
        workspaceId: activeWorkspace?.id,
        body,
        source: 'desktop',
      });
      setBody('');
      await loadNotes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create note.');
    }
  };

  const updateStatus = async (noteId: string, status: 'accepted' | 'dismissed') => {
    if (status === 'accepted') {
      await window.anvil.workspaceNotes.accept(noteId);
    } else {
      await window.anvil.workspaceNotes.dismiss(noteId);
    }
    await loadNotes();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <ViewHeader
        icon={Mic}
        title="Workspace Notes"
        description="Review notes captured from desktop, Siri, mobile, and Anvil Drive before accepting or dismissing them."
        actions={
          <>
            <label className="flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={includeReviewed}
                onChange={(event) => setIncludeReviewed(event.target.checked)}
              />
              Reviewed
            </label>
            <button
              type="button"
              onClick={() => void loadNotes()}
              className="inline-flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-secondary hover:text-text-primary"
            >
              <RefreshCcw size={15} />
              Refresh
            </button>
          </>
        }
      />

      <main className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <section className="mb-6 rounded-lg border border-border bg-bg-secondary p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Mic size={16} className="text-accent" />
            Add desktop note
          </div>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Capture a follow-up for later review..."
            className="min-h-24 w-full resize-y rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-accent"
          />
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              disabled={!body.trim()}
              onClick={() => void createNote()}
              className="inline-flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/15 px-3 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus size={15} />
              Add note
            </button>
          </div>
        </section>

        {error && (
          <div className="mb-4 rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
            {error}
          </div>
        )}

        {loading ? (
          <div className="rounded-lg border border-border bg-bg-secondary p-6 text-sm text-text-secondary">
            Loading notes...
          </div>
        ) : notes.length === 0 ? (
          <div className="rounded-lg border border-border bg-bg-secondary p-6 text-sm text-text-secondary">
            No workspace notes are waiting for review.
          </div>
        ) : (
          <div className="grid gap-3">
            {notes.map((note) => (
              <article
                key={note.id}
                className="rounded-lg border border-border bg-bg-secondary p-4"
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                    <span>{note.source}</span>
                    {note.workspaceName && <span>{note.workspaceName}</span>}
                    {note.repo && <span>{note.repo}</span>}
                    <span>{new Date(note.createdAt).toLocaleString()}</span>
                  </div>
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-semibold ${
                      note.status === 'open'
                        ? 'bg-accent/15 text-accent'
                        : 'bg-bg-tertiary text-text-tertiary'
                    }`}
                  >
                    {note.status}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-6 text-text-primary">
                  {note.body}
                </p>
                {note.status === 'open' && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void updateStatus(note.id, 'accepted')}
                      className="inline-flex items-center gap-2 rounded-lg border border-success/35 bg-success/10 px-3 py-2 text-sm font-medium text-success"
                    >
                      <Check size={15} />
                      Accept
                    </button>
                    <button
                      type="button"
                      onClick={() => void updateStatus(note.id, 'dismissed')}
                      className="inline-flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-sm font-medium text-text-secondary hover:bg-bg-tertiary"
                    >
                      <Trash2 size={15} />
                      Dismiss
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
