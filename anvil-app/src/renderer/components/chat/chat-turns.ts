import type { CodexEvent } from '../../../shared/types';
import type { ChatEntry } from '../../contexts/ChatContext';

type AssistantEntry = Extract<ChatEntry, { kind: 'assistant' }> & {
  itemId?: string;
  phase?: 'progress' | 'final';
};

export type IndexedChatEntry<T extends ChatEntry = ChatEntry> = T & { sourceIndex: number };

export type ChatTurnWorkItem =
  | {
      kind: 'progress';
      content: string;
      sourceIndex: number;
    }
  | {
      kind: 'thinking';
      content: string;
      sourceIndex: number;
    }
  | {
      kind: 'event';
      event: CodexEvent;
      sourceIndex: number;
    };

export interface ComposedChatTurn {
  key: string;
  user: IndexedChatEntry<Extract<ChatEntry, { kind: 'user' }>> | null;
  work: ChatTurnWorkItem[];
  answer: IndexedChatEntry<AssistantEntry> | null;
  trailingWork: ChatTurnWorkItem[];
}

interface AssistantSegment {
  entry: IndexedChatEntry<AssistantEntry>;
  sourceIndexes: number[];
}

export function composeChatTurns(
  entries: ChatEntry[],
  options: { active?: boolean } = {},
): ComposedChatTurn[] {
  const pendingTurns: Array<Array<IndexedChatEntry>> = [];
  let pending: Array<IndexedChatEntry> = [];

  const flush = () => {
    if (pending.length > 0) pendingTurns.push(pending);
    pending = [];
  };

  for (const [sourceIndex, entry] of entries.entries()) {
    const indexed = { ...entry, sourceIndex } as IndexedChatEntry;
    if (entry.kind === 'user') flush();
    pending.push(indexed);
  }
  flush();

  return pendingTurns.map((turnEntries, turnIndex) =>
    composeTurn(turnEntries, options.active === true && turnIndex === pendingTurns.length - 1),
  );
}

function composeTurn(entries: Array<IndexedChatEntry>, active: boolean): ComposedChatTurn {
  const userEntry = entries.find((entry) => entry.kind === 'user') as
    | IndexedChatEntry<Extract<ChatEntry, { kind: 'user' }>>
    | undefined;
  const assistantSegments = coalesceAssistantSegments(entries);
  const explicitFinal = [...assistantSegments]
    .reverse()
    .find((segment) => segment.entry.phase === 'final');
  // When no provider tagged a final segment (or phases are unknown), fall back
  // to the last progress-free segment so the answer always renders as an
  // answer rather than being buried in the work log.
  const fallbackFinal = [...assistantSegments]
    .reverse()
    .find((segment) => segment.entry.phase !== 'progress');
  const answerSegment = explicitFinal ?? (active ? undefined : fallbackFinal);
  const answerSourceIndexes = new Set(answerSegment?.sourceIndexes ?? []);
  const answerEndSourceIndex =
    answerSegment && answerSegment.sourceIndexes.length > 0
      ? Math.max(...answerSegment.sourceIndexes)
      : Number.POSITIVE_INFINITY;
  const progressBySourceIndex = new Map<number, AssistantSegment>();

  for (const segment of assistantSegments) {
    if (segment === answerSegment) continue;
    progressBySourceIndex.set(segment.sourceIndexes[0], segment);
  }

  const work: ChatTurnWorkItem[] = [];
  const trailingWork: ChatTurnWorkItem[] = [];
  for (const entry of entries) {
    if (entry.kind === 'user' || answerSourceIndexes.has(entry.sourceIndex)) continue;

    const target = entry.sourceIndex > answerEndSourceIndex ? trailingWork : work;

    if (entry.kind === 'assistant') {
      const segment = progressBySourceIndex.get(entry.sourceIndex);
      if (segment) {
        target.push({
          kind: 'progress',
          content: segment.entry.content,
          sourceIndex: segment.entry.sourceIndex,
        });
      }
      continue;
    }

    if (entry.kind === 'thinking') {
      // Reasoning streams as many small fragments (providers emit COT deltas
      // without a stable item id). Coalesce consecutive fragments so the chain
      // renders as one collapsible trace regardless of provider chunking.
      const previous = target[target.length - 1];
      if (previous?.kind === 'thinking') {
        previous.content += entry.content;
        previous.sourceIndex = entry.sourceIndex;
      } else {
        target.push({ kind: 'thinking', content: entry.content, sourceIndex: entry.sourceIndex });
      }
    } else {
      target.push({ kind: 'event', event: entry.event, sourceIndex: entry.sourceIndex });
    }
  }

  return {
    key: userEntry?.id ?? answerSegment?.entry.id ?? `turn-${entries[0]?.sourceIndex ?? 0}`,
    user: userEntry ?? null,
    work,
    answer: answerSegment?.entry ?? null,
    trailingWork,
  };
}

function coalesceAssistantSegments(entries: Array<IndexedChatEntry>): AssistantSegment[] {
  const segments: AssistantSegment[] = [];

  for (const entry of entries) {
    if (entry.kind !== 'assistant') continue;
    const assistantEntry = entry as IndexedChatEntry<AssistantEntry>;
    const previous = segments[segments.length - 1];

    if (previous && shouldJoinAssistantSegments(previous.entry, assistantEntry)) {
      previous.entry = {
        ...assistantEntry,
        content: previous.entry.content + assistantEntry.content,
      };
      previous.sourceIndexes.push(entry.sourceIndex);
    } else {
      segments.push({ entry: assistantEntry, sourceIndexes: [entry.sourceIndex] });
    }
  }

  return segments;
}

export function shouldJoinAssistantSegments(
  previous: Pick<AssistantEntry, 'content' | 'itemId' | 'phase'>,
  next: Pick<AssistantEntry, 'content' | 'itemId' | 'phase'>,
): boolean {
  if (previous.itemId && next.itemId) return previous.itemId === next.itemId;
  if (previous.itemId || next.itemId) return false;
  // Providers tag phases inconsistently (some tag every item, some none). Only
  // merge fragments that plausibly belong to the same message so a final
  // answer is never glued onto a trailing progress update.
  if (previous.phase !== next.phase) return false;

  return (
    /^\s/.test(next.content) ||
    (!/[\s.!?;:)>\]}]$/.test(previous.content) && /^[a-z]/.test(next.content))
  );
}
