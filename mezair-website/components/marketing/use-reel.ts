"use client";

import { useEffect, useReducer, useRef, useState, useSyncExternalStore, type RefObject } from "react";

export const REEL_TICK = 100;

type ReelState = {
  chapter: number;
  /** Milliseconds into the current chapter, or null when it rests in its finished state. */
  elapsed: number | null;
  mode: "auto" | "hold";
  paused: boolean;
};

type ReelAction =
  | { type: "tick"; durations: readonly number[] }
  | { type: "select"; chapter: number; animate: boolean }
  | { type: "toggle" };

function reelReducer(state: ReelState, action: ReelAction): ReelState {
  if (action.type === "select") {
    return { ...state, chapter: action.chapter, elapsed: action.animate ? 0 : null, mode: "hold", paused: false };
  }
  if (action.type === "toggle") {
    return !state.paused && (state.mode === "auto" || state.elapsed !== null)
      ? { ...state, paused: true }
      : { ...state, paused: false, mode: "auto" };
  }
  if (state.paused) return state;
  if (state.elapsed === null) return state.mode === "auto" ? { ...state, elapsed: 0 } : state;
  const next = state.elapsed + REEL_TICK;
  if (next < action.durations[state.chapter]) return { ...state, elapsed: next };
  if (state.mode === "auto") {
    return { ...state, chapter: (state.chapter + 1) % action.durations.length, elapsed: 0 };
  }
  return { ...state, elapsed: null };
}

function subscribeReducedMotion(onChange: () => void) {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

export function useReducedMotion() {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false
  );
}

function useInView(ref: RefObject<HTMLElement | null>) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.2 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return inView;
}

/**
 * Drives an authored scene: chapters play in order while the scene is on
 * screen, a visitor's choice plays that chapter once and holds it, and nothing
 * moves under reduced motion, offscreen or in a hidden tab. A chapter with a
 * null `elapsed` renders its finished, static state, which is also what the
 * server renders.
 */
export function useReel(durations: readonly number[]) {
  const rootRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const inView = useInView(rootRef);
  const pageVisible = useSyncExternalStore(subscribeVisibility, () => !document.hidden, () => true);
  const [state, dispatch] = useReducer(reelReducer, { chapter: 0, elapsed: null, mode: "auto", paused: false });

  const motion = inView && pageVisible && !reduced;
  const ticking = motion && !state.paused && !(state.mode === "hold" && state.elapsed === null);

  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => dispatch({ type: "tick", durations }), REEL_TICK);
    return () => window.clearInterval(timer);
  }, [ticking, durations]);

  const duration = durations[state.chapter];
  const progress = state.elapsed === null ? 1 : Math.min(1, state.elapsed / duration);
  const barProgress = state.elapsed === null && state.mode === "auto" && !reduced ? 0 : progress;

  return {
    rootRef,
    chapter: state.chapter,
    progress,
    barProgress,
    motion: ticking,
    reduced,
    playing: ticking,
    select: (chapter: number) => dispatch({ type: "select", chapter, animate: !reduced }),
    toggle: () => dispatch({ type: "toggle" })
  };
}
