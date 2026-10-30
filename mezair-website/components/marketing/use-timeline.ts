"use client";

import { useEffect, useReducer, useRef } from "react";
import { useInView, usePageVisible, useReducedMotion } from "./use-reel";

export type TimelineChapter = {
  /** Seconds. */
  duration: number;
  /** The single frame that best explains the chapter: the server render and the reduced-motion view. */
  keyTime: number;
};

type State = {
  chapter: number;
  /** Seconds into the chapter, or null while resting on its key frame. */
  time: number | null;
  mode: "auto" | "hold";
  paused: boolean;
  finished: boolean;
};

type Action =
  | { type: "tick"; dt: number; durations: number[] }
  | { type: "select"; chapter: number; animate: boolean }
  | { type: "toggle" };

function reducer(state: State, action: Action): State {
  if (action.type === "select") {
    return { chapter: action.chapter, time: action.animate ? 0 : null, mode: "hold", paused: false, finished: !action.animate };
  }
  if (action.type === "toggle") {
    if (!state.paused && !state.finished) return { ...state, paused: true };
    return { ...state, paused: false, finished: false, mode: "auto", time: state.finished ? 0 : state.time };
  }
  if (state.paused || state.finished) return state;
  const duration = action.durations[state.chapter];
  const next = (state.time ?? 0) + action.dt;
  if (next < duration) return { ...state, time: next };
  if (state.mode === "auto") {
    return { ...state, chapter: (state.chapter + 1) % action.durations.length, time: 0 };
  }
  return { ...state, time: duration, finished: true };
}

/**
 * A continuous clock for authored motion graphics. It advances on
 * requestAnimationFrame only while the stage is on screen, the tab is visible
 * and reduced motion is off. Choosing a chapter plays it once and holds its
 * last frame; Play resumes the sequence. Without motion every chapter shows
 * its key frame, which is also what the server renders.
 */
export function useTimeline(chapters: TimelineChapter[]) {
  const rootRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const inView = useInView(rootRef);
  const visible = usePageVisible();
  const [state, dispatch] = useReducer(reducer, {
    chapter: 0,
    time: null,
    mode: "auto",
    paused: false,
    finished: false
  });
  const durations = chapters.map((chapter) => chapter.duration);
  const durationKey = durations.join(",");

  const running = inView && visible && !reduced && !state.paused && !state.finished;

  useEffect(() => {
    if (!running) return;
    const list = durationKey.split(",").map(Number);
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.064, (now - last) / 1000);
      last = now;
      dispatch({ type: "tick", dt, durations: list });
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [running, durationKey]);

  const current = chapters[state.chapter];
  const time = reduced || state.time === null ? current.keyTime : state.time;

  return {
    rootRef,
    chapter: state.chapter,
    time,
    progress: Math.min(1, time / current.duration),
    animating: running,
    reduced,
    playing: running,
    select: (chapter: number) => dispatch({ type: "select", chapter, animate: !reduced }),
    toggle: () => dispatch({ type: "toggle" })
  };
}
