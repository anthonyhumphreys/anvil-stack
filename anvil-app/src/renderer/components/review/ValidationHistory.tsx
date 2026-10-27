import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { WorkItemReference } from '../../../shared/change-review-types';
import type { ValidationHistoryEntry } from '../../../shared/surfaces/ipc';
import { chatItemPath } from '../../utils/sidebar-navigation';
import { validationInChatPath } from '../../utils/validation-in-chat';

export function ValidationHistory({
  workspaceId,
  repoId,
  workItemRef,
}: {
  workspaceId: string;
  repoId: string;
  workItemRef: WorkItemReference;
}) {
  const [entries, setEntries] = useState<ValidationHistoryEntry[]>([]);
  const [legacy, setLegacy] = useState<{ id: string; title: string; repoId: string }[]>([]);
  const [error, setError] = useState('');
  const { id, provider, connectionId } = workItemRef;
  useEffect(() => {
    let cancelled = false;
    setEntries([]);
    setLegacy([]);
    setError('');
    void Promise.all([
      window.anvil.surfaces.listValidations(workspaceId, { id, provider, connectionId }),
      window.anvil.changeReview.list(workspaceId),
    ])
      .then(([entries, reviews]) => {
        if (cancelled) return;
        setEntries(entries.filter((entry) => entry.repoId === repoId));
        setLegacy(
          reviews.filter(
            (review) =>
              review.repoId === repoId &&
              review.workItemRef?.id === id &&
              review.workItemRef.provider === provider &&
              review.workItemRef.connectionId === connectionId,
          ),
        );
      })
      .catch(() => {
        if (!cancelled)
          setError('Validation history could not be loaded. Reopen this work item to try again.');
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, repoId, id, provider, connectionId]);
  return (
    <section className="space-y-2" aria-label="Validation history">
      <h3 className="text-sm font-semibold">Validation history</h3>
      {error ? (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      ) : !entries.length && !legacy.length ? (
        <p className="max-w-prose text-xs text-text-tertiary">
          Use Validate in chat when you want evidence against this item's acceptance criteria.
        </p>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li key={entry.surfaceId}>
              <Link
                className="text-sm text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                to={chatItemPath(entry.threadId, { surfaceId: entry.surfaceId })}
              >
                {entry.title}
              </Link>
              <p className="text-xs text-text-tertiary">{entry.summary}</p>
            </li>
          ))}
          {legacy.map((entry) => (
            <li key={entry.id}>
              <Link
                className="text-sm text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                to={validationInChatPath(entry.repoId, entry.id)}
              >
                {entry.title} · saved evidence
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
