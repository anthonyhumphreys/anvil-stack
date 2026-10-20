import { isNearChatBottom, type ScrollMetrics } from './chat-view-utils';

export const CHAT_SCROLL_STORAGE_LIMIT = 50;

const CHAT_SCROLL_KEY_PREFIX = 'anvil.chat-scroll.v1:';
const CHAT_SCROLL_INDEX_KEY = 'anvil.chat-scroll-index.v1';

export type ChatScrollPosition =
  | { mode: 'bottom' }
  | { mode: 'offset'; scrollTop: number; anchor?: ChatScrollAnchor };

export interface ChatScrollAnchor {
  turnKey: string;
  offsetFromTurnTop: number;
}

interface StoredChatScrollPosition {
  version: 1;
  mode: 'bottom' | 'offset';
  scrollTop?: number;
  anchor?: ChatScrollAnchor;
}

export function chatScrollStorageKey(scopeKey: string): string {
  return `${CHAT_SCROLL_KEY_PREFIX}${encodeURIComponent(scopeKey)}`;
}

export function chatScrollPositionFromMetrics(
  metrics: ScrollMetrics,
  anchor?: ChatScrollAnchor,
): ChatScrollPosition {
  if (isNearChatBottom(metrics)) return { mode: 'bottom' };
  return {
    mode: 'offset',
    scrollTop: Math.max(0, metrics.scrollTop),
    ...(anchor ? { anchor } : {}),
  };
}

export function scrollTopForChatPosition(
  metrics: ScrollMetrics,
  position: ChatScrollPosition,
  anchorTop?: number,
): number {
  if (position.mode === 'bottom') return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  const requestedTop =
    position.anchor && anchorTop !== undefined
      ? anchorTop + position.anchor.offsetFromTurnTop
      : position.scrollTop;
  return Math.min(
    Math.max(0, metrics.scrollHeight - metrics.clientHeight),
    Math.max(0, requestedTop),
  );
}

export function readChatScrollPosition(
  storage: Storage | null,
  scopeKey: string | null,
): ChatScrollPosition | null {
  if (!storage || !scopeKey) return null;
  try {
    const serialized = storage.getItem(chatScrollStorageKey(scopeKey));
    if (!serialized) return null;
    const parsed = JSON.parse(serialized) as Partial<StoredChatScrollPosition>;
    if (parsed.version !== 1) return null;
    if (parsed.mode === 'bottom') return { mode: 'bottom' };
    if (
      parsed.mode === 'offset' &&
      typeof parsed.scrollTop === 'number' &&
      Number.isFinite(parsed.scrollTop) &&
      parsed.scrollTop >= 0
    ) {
      const anchor = isChatScrollAnchor(parsed.anchor) ? parsed.anchor : undefined;
      return { mode: 'offset', scrollTop: parsed.scrollTop, ...(anchor ? { anchor } : {}) };
    }
  } catch {
    // Storage may be unavailable or contain stale data. A fresh chat starts at the bottom.
  }
  return null;
}

export function writeChatScrollPosition(
  storage: Storage | null,
  scopeKey: string | null,
  position: ChatScrollPosition,
): void {
  if (!storage || !scopeKey) return;

  const key = chatScrollStorageKey(scopeKey);
  const record: StoredChatScrollPosition =
    position.mode === 'bottom'
      ? { version: 1, mode: 'bottom' }
      : {
          version: 1,
          mode: 'offset',
          scrollTop: Math.max(0, position.scrollTop),
          ...(position.anchor ? { anchor: position.anchor } : {}),
        };

  try {
    storage.setItem(key, JSON.stringify(record));
    const indexedKeys = readStorageIndex(storage);
    const nextKeys = [...indexedKeys.filter((indexedKey) => indexedKey !== key), key];
    const evictedKeys = nextKeys.splice(
      0,
      Math.max(0, nextKeys.length - CHAT_SCROLL_STORAGE_LIMIT),
    );
    for (const evictedKey of evictedKeys) storage.removeItem(evictedKey);
    storage.setItem(CHAT_SCROLL_INDEX_KEY, JSON.stringify(nextKeys));
  } catch {
    // Treat sessionStorage as a best-effort cache; chat scrolling must keep working without it.
  }
}

export function getSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function isChatScrollAnchor(value: unknown): value is ChatScrollAnchor {
  if (typeof value !== 'object' || value === null) return false;
  const anchor = value as Partial<ChatScrollAnchor>;
  return (
    typeof anchor.turnKey === 'string' &&
    anchor.turnKey.length > 0 &&
    typeof anchor.offsetFromTurnTop === 'number' &&
    Number.isFinite(anchor.offsetFromTurnTop)
  );
}

function readStorageIndex(storage: Storage): string[] {
  try {
    const serialized = storage.getItem(CHAT_SCROLL_INDEX_KEY);
    if (!serialized) return [];
    const parsed = JSON.parse(serialized) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((key): key is string => typeof key === 'string');
  } catch {
    return [];
  }
}
