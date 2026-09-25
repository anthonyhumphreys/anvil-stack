import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  chatScrollPositionFromMetrics,
  getSessionStorage,
  readChatScrollPosition,
  scrollTopForChatPosition,
  writeChatScrollPosition,
  type ChatScrollAnchor,
  type ChatScrollPosition,
} from './chat-scroll-position';

interface ChatScrollScopeState {
  key: string | null;
  position: ChatScrollPosition;
  restored: boolean;
}

export interface UseChatScrollOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  /** Stable workspace/thread identity. Pass null for an unsaved thread. */
  scopeKey: string | null;
  /** Pass entries (or another identity that changes with transcript content). */
  contentVersion?: unknown;
  /** Keep false until the active thread's history is hydrated. */
  contentReady: boolean;
}

export interface UseChatScrollResult {
  showJumpToLatest: boolean;
  jumpToLatest: () => void;
}

export function useChatScroll({
  containerRef,
  scopeKey,
  contentVersion,
  contentReady,
}: UseChatScrollOptions): UseChatScrollResult {
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const scopeStateRef = useRef<ChatScrollScopeState | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const forcedPinnedScrollRef = useRef(false);
  const lastScrollTopRef = useRef(0);

  const persistPosition = useCallback((state: ChatScrollScopeState) => {
    writeChatScrollPosition(getSessionStorage(), state.key, state.position);
  }, []);

  const captureCurrentPosition = useCallback(
    (container: HTMLDivElement, state: ChatScrollScopeState) => {
      if (!state.restored) return;
      const position = chatScrollPositionFromMetrics(container, getVisibleTurnAnchor(container));
      state.position = position;
      shouldStickToBottomRef.current = position.mode === 'bottom';
      setShowJumpToLatest(position.mode !== 'bottom');
      persistPosition(state);
    },
    [persistPosition],
  );

  useLayoutEffect(() => {
    const container = containerRef.current;
    let state = scopeStateRef.current;
    if (!state || state.key !== scopeKey) {
      if (state?.restored) persistPosition(state);
      const savedPosition = readChatScrollPosition(getSessionStorage(), scopeKey);
      const initialPosition = savedPosition ?? { mode: 'bottom' as const };
      state = {
        key: scopeKey,
        position: initialPosition,
        restored: false,
      };
      scopeStateRef.current = state;
      shouldStickToBottomRef.current = initialPosition.mode === 'bottom';
      forcedPinnedScrollRef.current = false;
      setShowJumpToLatest(initialPosition.mode !== 'bottom');
    }

    if (!container || !contentReady) return;

    if (!state.restored) {
      const savedAnchor = state.position.mode === 'offset' ? state.position.anchor : undefined;
      const anchorTop = savedAnchor ? findTurnTop(container, savedAnchor.turnKey) : undefined;
      container.scrollTop = scrollTopForChatPosition(container, state.position, anchorTop);
      state.restored = true;
      lastScrollTopRef.current = container.scrollTop;
      shouldStickToBottomRef.current = state.position.mode === 'bottom';
      setShowJumpToLatest(state.position.mode !== 'bottom');
      persistPosition(state);
      return;
    }

    if (shouldStickToBottomRef.current && !hasTranscriptSelection(container)) {
      container.scrollTop = container.scrollHeight;
      lastScrollTopRef.current = container.scrollTop;
    } else {
      captureCurrentPosition(container, state);
    }
  }, [
    captureCurrentPosition,
    containerRef,
    contentReady,
    contentVersion,
    persistPosition,
    scopeKey,
  ]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onScroll = () => {
      const state = scopeStateRef.current;
      if (!state?.restored) return;
      const scrollTop = container.scrollTop;
      if (forcedPinnedScrollRef.current && scrollTop < lastScrollTopRef.current - 1) {
        // A user scroll up during the explicit smooth jump cancels the forced pin.
        forcedPinnedScrollRef.current = false;
      }
      lastScrollTopRef.current = scrollTop;
      if (forcedPinnedScrollRef.current) {
        state.position = { mode: 'bottom' };
        shouldStickToBottomRef.current = true;
        setShowJumpToLatest(false);
        persistPosition(state);
        return;
      }
      captureCurrentPosition(container, state);
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      const state = scopeStateRef.current;
      if (state?.restored) persistPosition(state);
    };
  }, [captureCurrentPosition, containerRef, persistPosition]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const state = scopeStateRef.current;
        if (!state?.restored) return;
        if (shouldStickToBottomRef.current && !hasTranscriptSelection(container)) {
          container.scrollTop = container.scrollHeight;
          lastScrollTopRef.current = container.scrollTop;
          state.position = { mode: 'bottom' };
          setShowJumpToLatest(false);
          persistPosition(state);
        } else {
          captureCurrentPosition(container, state);
        }
      });
    });
    observer.observe(container);
    const content = container.querySelector('[data-chat-transcript-content]');
    if (content) observer.observe(content);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [captureCurrentPosition, containerRef, persistPosition]);

  const jumpToLatest = useCallback(() => {
    shouldStickToBottomRef.current = true;
    forcedPinnedScrollRef.current = false;
    const state = scopeStateRef.current;
    if (state) {
      state.position = { mode: 'bottom' };
      persistPosition(state);
    }
    setShowJumpToLatest(false);

    const container = containerRef.current;
    if (!container) return;
    const reducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior: ScrollBehavior = reducedMotion ? 'auto' : 'smooth';
    forcedPinnedScrollRef.current = behavior === 'smooth';
    lastScrollTopRef.current = container.scrollTop;
    container.scrollTo({ top: container.scrollHeight, behavior });
  }, [containerRef, persistPosition]);

  return { showJumpToLatest, jumpToLatest };
}

function getVisibleTurnAnchor(container: HTMLDivElement): ChatScrollAnchor | undefined {
  const viewportTop = container.getBoundingClientRect().top + container.clientTop;
  const turns = container.querySelectorAll<HTMLElement>('[data-chat-turn-key]');
  for (const turn of turns) {
    const rect = turn.getBoundingClientRect();
    const turnKey = turn.dataset.chatTurnKey;
    if (turnKey && rect.bottom > viewportTop) {
      return { turnKey, offsetFromTurnTop: viewportTop - rect.top };
    }
  }
  return undefined;
}

function findTurnTop(container: HTMLDivElement, turnKey: string): number | undefined {
  const turns = container.querySelectorAll<HTMLElement>('[data-chat-turn-key]');
  const turn = Array.from(turns).find((candidate) => candidate.dataset.chatTurnKey === turnKey);
  if (!turn) return undefined;
  const containerTop = container.getBoundingClientRect().top + container.clientTop;
  return turn.getBoundingClientRect().top - containerTop + container.scrollTop;
}

function hasTranscriptSelection(container: HTMLDivElement): boolean {
  const selection = container.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed) return false;
  return container.contains(selection.anchorNode) || container.contains(selection.focusNode);
}
