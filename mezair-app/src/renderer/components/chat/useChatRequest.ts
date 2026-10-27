import { useRef, useState } from 'react';
import { presentChatRequestError } from './chat-errors';

/** Keep a user decision single-flight, and keep its form available after a failure. */
export function useChatRequest(failureMessage: string) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (request: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const focusTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPending(true);
    setError(null);
    try {
      await request();
    } catch (caught) {
      setError(presentChatRequestError(caught, failureMessage));
    } finally {
      inFlight.current = false;
      setPending(false);
      // Disabling a fieldset can move focus to the document. Restore it only
      // if the user has not moved elsewhere and the original control still exists.
      window.requestAnimationFrame(() => {
        if (focusTarget?.isConnected && document.activeElement === document.body)
          focusTarget.focus();
      });
    }
  };

  return { pending, error, run, clearError: () => setError(null) };
}
