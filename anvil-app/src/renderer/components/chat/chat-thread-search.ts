import type { ChatThread } from '../../../shared/types';

/**
 * CH6 — thread rail filtering. Pure so the rail, the work-item rail, and a
 * future command-palette "Jump to thread" command can share one matcher.
 *
 * Matches on title, summary/preview, repository name, and persona name.
 */
export interface ChatThreadSearchContext {
  /** repoId → display name */
  repoNames: ReadonlyMap<string, string>;
  /** personaId → display name */
  personaNames: ReadonlyMap<string, string>;
}

export function chatThreadSearchText(thread: ChatThread, context: ChatThreadSearchContext): string {
  const repoNames = (thread.repoIds ?? [])
    .map((id) => context.repoNames.get(id))
    .filter((name): name is string => Boolean(name));
  const activeRepoName = thread.activeRepoId ? context.repoNames.get(thread.activeRepoId) : null;
  const personaName = context.personaNames.get(thread.personaId);
  return [
    thread.title,
    thread.summary,
    thread.preview,
    thread.workItemTitle,
    thread.workItemId,
    activeRepoName,
    ...repoNames,
    personaName,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .toLowerCase();
}

export function filterChatThreads(
  threads: ChatThread[],
  query: string,
  context: ChatThreadSearchContext,
): ChatThread[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return threads;
  return threads.filter((thread) => {
    const haystack = chatThreadSearchText(thread, context);
    return terms.every((term) => haystack.includes(term));
  });
}
