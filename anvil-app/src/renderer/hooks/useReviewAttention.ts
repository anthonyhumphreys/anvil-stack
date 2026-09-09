import { useEffect, useRef } from 'react';

/** A conservative interaction estimate, not a claim to measure a person's attention. */
export function useReviewAttention(reviewId: string | undefined) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = container.current;
    if (!reviewId || !element) return;
    const sessionId = crypto.randomUUID();
    let lastInteraction = -Infinity;
    let active = false;
    let reportedFailure = false;
    const send = (next: boolean) => {
      if (!next && !active) return;
      active = next;
      void window.anvil.changeReview
        .recordAttention(reviewId, { sessionId, active: next })
        .catch((error: unknown) => {
          if (!reportedFailure)
            console.warn('Review interaction estimate could not be recorded', error);
          reportedFailure = true;
        });
    };
    const pulse = () =>
      send(
        document.visibilityState === 'visible' &&
          document.hasFocus() &&
          performance.now() - lastInteraction < 30000,
      );
    const interact = (event: Event) => {
      if (!event.isTrusted) return;
      lastInteraction = performance.now();
      if (!active) pulse();
    };
    const pause = () => {
      lastInteraction = -Infinity;
      send(false);
    };
    const visibility = () => {
      if (document.visibilityState !== 'visible') pause();
    };
    const events = ['pointerdown', 'keydown', 'wheel'];
    events.forEach((event) => element.addEventListener(event, interact, { passive: true }));
    window.addEventListener('blur', pause);
    document.addEventListener('visibilitychange', visibility);
    const interval = window.setInterval(pulse, 5000);
    return () => {
      window.clearInterval(interval);
      events.forEach((event) => element.removeEventListener(event, interact));
      window.removeEventListener('blur', pause);
      document.removeEventListener('visibilitychange', visibility);
      pause();
    };
  }, [reviewId]);
  return container;
}
