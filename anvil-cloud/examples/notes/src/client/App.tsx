import { createAnvilHooks, createClient } from "@anvil-cloud/client";
import { api } from "@anvil/generated/client";
import * as React from "react";

type SubmitState = "idle" | "saving";

const client = createClient({
  getToken: () => localStorage.getItem("anvil_notes_token"),
});
const { useMutation, useQuery } = createAnvilHooks(client, React);

export function App() {
  const [submitState, setSubmitState] = React.useState<SubmitState>("idle");
  const [token, setToken] = React.useState(
    () => localStorage.getItem("anvil_notes_token") ?? "",
  );
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const notesQuery = useQuery(api.queries.listNotes, {});
  const createNote = useMutation(api.mutations.createNote, {
    refetch: notesQuery,
  });
  const archiveNoteMutation = useMutation(api.mutations.archiveNote, {
    onSuccess: async (result) => {
      if (result.archived) {
        await notesQuery.refetch();
      }
    },
  });
  const notes = notesQuery.data ?? [];
  const visibleError = error ?? notesQuery.error?.message ?? null;

  function saveToken(nextToken: string) {
    setToken(nextToken);

    if (nextToken.trim()) {
      localStorage.setItem("anvil_notes_token", nextToken.trim());
    } else {
      localStorage.removeItem("anvil_notes_token");
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextTitle = title.trim();

    if (!nextTitle || submitState === "saving") {
      return;
    }

    setSubmitState("saving");
    setError(null);

    try {
      await createNote.mutate({
        title: nextTitle,
        body,
      });

      setTitle("");
      setBody("");
    } catch (unknownError) {
      setError(toMessage(unknownError, "Failed to create note."));
    } finally {
      setSubmitState("idle");
    }
  }

  async function archiveNote(noteId: string | undefined) {
    if (!noteId) {
      return;
    }

    setError(null);

    try {
      await archiveNoteMutation.mutate({ noteId });
    } catch (unknownError) {
      setError(toMessage(unknownError, "Failed to archive note."));
    }
  }

  return (
    <main className="shell">
      <section className="intro" aria-labelledby="app-title">
        <p>Anvil Cloud canonical Cell</p>
        <h1 id="app-title">Notes</h1>
      </section>

      <section className="toolbar" aria-label="Authentication">
        <label>
          Dev token
          <input
            spellCheck={false}
            value={token}
            onChange={(event) => saveToken(event.currentTarget.value)}
            placeholder="Paste anvil-cloud auth token output"
          />
        </label>
        <button type="button" onClick={() => void notesQuery.refetch()}>
          Refresh
        </button>
      </section>

      <section className="workspace" aria-label="Notes workspace">
        <form className="composer" onSubmit={handleSubmit}>
          <input
            aria-label="Note title"
            maxLength={120}
            placeholder="Title"
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
          <textarea
            aria-label="Note body"
            maxLength={2000}
            placeholder="Body"
            rows={5}
            value={body}
            onChange={(event) => setBody(event.currentTarget.value)}
          />
          <button type="submit" disabled={submitState === "saving"}>
            {submitState === "saving" ? "Saving" : "Save note"}
          </button>
        </form>

        <div className="notesPanel">
          <div className="panelHeader">
            <h2>Your notes</h2>
            <span>{notesQuery.status}</span>
          </div>

          {visibleError ? <p className="error">{visibleError}</p> : null}

          {notes.length > 0 ? (
            <ul className="notesList">
              {notes.map((note) => (
                <li key={note.id ?? note.title}>
                  <div>
                    <h3>{note.title}</h3>
                    {note.body ? <p>{note.body}</p> : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => void archiveNote(note.id)}
                  >
                    Archive
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">
              {notesQuery.status === "loading"
                ? "Loading notes..."
                : "No notes yet. Suspiciously clean slate."}
            </p>
          )}
        </div>
      </section>
    </main>
  );
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
