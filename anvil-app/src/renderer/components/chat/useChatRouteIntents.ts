import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Persona } from '../../../shared/types';
import type { PreviewMode } from '../browser/BrowserPanel';

/**
 * Route-intent handling for /chat — extracted from ChatView (Phase 5 split).
 * Consumes `?prompt=&persona=`, `?preview=&previewUrl=`, and `?thread=`
 * params exactly once, then strips them from the URL.
 */
export function useChatRouteIntents({
  personas,
  activePersona,
  switchPersona,
  selectThread,
  onPrefill,
  openPreview,
  threadCount,
}: {
  personas: Persona[];
  activePersona: Persona | null;
  switchPersona: (persona: Persona) => void;
  selectThread: (threadId: string) => Promise<void> | void;
  onPrefill: (text: string) => void;
  openPreview: (mode: PreviewMode, initialUrl?: string) => void;
  /** Kept in the thread effect's deps so `?thread=` retries once threads load. */
  threadCount: number;
}) {
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    const prompt = searchParams.get('prompt');
    const persona = searchParams.get('persona');
    if (!prompt && !persona) return;

    if (prompt) {
      onPrefill(prompt);
    }

    if (persona) {
      const target = personas.find((item) => item.id === persona);
      if (target && target.id !== activePersona?.id) {
        switchPersona(target);
      }
    }

    const next = new URLSearchParams(searchParams);
    next.delete('prompt');
    next.delete('persona');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, personas, activePersona, switchPersona, onPrefill]);

  useEffect(() => {
    const requestedPreview = searchParams.get('preview');
    if (requestedPreview !== 'browser' && requestedPreview !== 'simulator') return;
    openPreview(requestedPreview, searchParams.get('previewUrl') ?? '');

    const next = new URLSearchParams(searchParams);
    next.delete('preview');
    next.delete('previewUrl');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, openPreview]);

  useEffect(() => {
    const threadId = searchParams.get('thread');
    if (!threadId) return;
    void selectThread(threadId);
    const next = new URLSearchParams(searchParams);
    next.delete('thread');
    setSearchParams(next, { replace: true });
  }, [searchParams, selectThread, setSearchParams, threadCount]);
}
