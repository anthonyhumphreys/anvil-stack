import type { ChatThread, CodexSession } from '../../../shared/types';

export type ChatThreadStatusFilter = 'needs-you' | 'working' | 'failed' | 'complete' | 'archived';

export const CHAT_THREAD_STATUS_FILTERS: ReadonlyArray<{
  value: ChatThreadStatusFilter;
  label: string;
}> = [
  { value: 'needs-you', label: 'Needs you' },
  { value: 'working', label: 'Working' },
  { value: 'failed', label: 'Failed' },
  { value: 'complete', label: 'Finished' },
];

/**
 * CH6 — thread rail filtering. Pure so the rail, the work-item rail, and a
 * future command-palette "Jump to thread" command can share one matcher.
 *
 * Matches text on title, summary/preview, repository, and persona; `repo:`,
 * `persona:`, and `status:` terms narrow those fields without extra UI chrome.
 */
export interface ChatThreadSearchContext {
  /** repoId → display name */
  repoNames: ReadonlyMap<string, string>;
  /** personaId → display name */
  personaNames: ReadonlyMap<string, string>;
  /** Live provider state contributes to the working and failed facets. */
  liveThreadStatuses?: Readonly<Record<string, CodexSession['status']>>;
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
  const parsed = parseSearchQuery(query);
  if (parsed.isEmpty) return threads;
  return threads.filter((thread) => {
    const haystack = chatThreadSearchText(thread, context);
    if (!parsed.textTerms.every((term) => haystack.includes(term))) return false;

    const repoNames = (thread.repoIds ?? [])
      .map((id) => context.repoNames.get(id))
      .filter((name): name is string => Boolean(name));
    const activeRepoName = thread.activeRepoId ? context.repoNames.get(thread.activeRepoId) : null;
    const matchedRepoNames = [...repoNames, ...(activeRepoName ? [activeRepoName] : [])].map(
      (name) => name.toLowerCase(),
    );
    if (!parsed.repoTerms.every((term) => matchedRepoNames.some((name) => name.includes(term)))) {
      return false;
    }

    const personaName = context.personaNames.get(thread.personaId)?.toLowerCase() ?? '';
    if (!parsed.personaTerms.every((term) => personaName.includes(term))) return false;

    return parsed.statusTerms.every((term) =>
      matchesStatusFilter(thread, term, context.liveThreadStatuses?.[thread.id]),
    );
  });
}

export function activeChatThreadStatusFilter(query: string): ChatThreadStatusFilter | null {
  const terms = parseSearchQuery(query).statusTerms;
  return terms.length === 1 ? normalizeStatusFilter(terms[0]) : null;
}

/** Toggle a quick status filter while preserving the user's text/repo/persona terms. */
export function toggleChatThreadStatusFilter(
  query: string,
  status: ChatThreadStatusFilter,
): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const active = activeChatThreadStatusFilter(query);
  const kept = tokens.filter((token) => !/^status:/i.test(token));
  if (active === status) return kept.join(' ');
  return [...kept, `status:${status}`].join(' ');
}

interface ParsedSearchQuery {
  textTerms: string[];
  repoTerms: string[];
  personaTerms: string[];
  statusTerms: string[];
  isEmpty: boolean;
}

function parseSearchQuery(query: string): ParsedSearchQuery {
  const parsed: ParsedSearchQuery = {
    textTerms: [],
    repoTerms: [],
    personaTerms: [],
    statusTerms: [],
    isEmpty: true,
  };
  for (const rawToken of query.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    const match = /^(repo|persona|status):(.+)$/.exec(rawToken);
    if (!match) {
      parsed.textTerms.push(rawToken);
      continue;
    }
    const [, field, value] = match;
    if (field === 'repo') parsed.repoTerms.push(value);
    else if (field === 'persona') parsed.personaTerms.push(value);
    else parsed.statusTerms.push(value);
  }
  parsed.isEmpty =
    parsed.textTerms.length === 0 &&
    parsed.repoTerms.length === 0 &&
    parsed.personaTerms.length === 0 &&
    parsed.statusTerms.length === 0;
  return parsed;
}

function matchesStatusFilter(
  thread: ChatThread,
  rawFilter: string,
  liveStatus: CodexSession['status'] | undefined,
): boolean {
  const filter = normalizeStatusFilter(rawFilter);
  if (!filter) return false;
  switch (filter) {
    case 'needs-you':
      return thread.attentionState === 'approval' || thread.attentionState === 'input';
    case 'working':
      return (
        liveStatus === 'starting' || liveStatus === 'busy' || thread.attentionState === 'working'
      );
    case 'failed':
      return liveStatus === 'error' || thread.attentionState === 'failed';
    case 'complete':
      return thread.attentionState === 'complete';
    case 'archived':
      return Boolean(thread.settledAt);
  }
}

function normalizeStatusFilter(value: string): ChatThreadStatusFilter | null {
  switch (value) {
    case 'needs-you':
    case 'waiting':
    case 'approval':
    case 'input':
      return 'needs-you';
    case 'working':
      return 'working';
    case 'failed':
      return 'failed';
    case 'done':
    case 'complete':
      return 'complete';
    case 'archived':
      return 'archived';
    default:
      return null;
  }
}
