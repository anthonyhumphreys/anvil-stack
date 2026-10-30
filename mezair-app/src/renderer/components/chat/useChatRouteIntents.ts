import { useEffect, useRef } from 'react';
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
  onSend,
  openPreview,
  threadCount,
}: {
  personas: Persona[];
  activePersona: Persona | null;
  switchPersona: (persona: Persona) => void;
  selectThread: (threadId: string) => Promise<void> | void;
  onPrefill: (text: string) => void;
  onSend: (text: string, threadId?: string, personaId?: string) => void;
  openPreview: (mode: PreviewMode, initialUrl?: string) => void;
  /** Kept in the thread effect's deps so `?thread=` retries once threads load. */
  threadCount: number;
}) {
  const [searchParams, setSearchParams] = useSearchParams();

  const consumed = useRef<string | null>(null);
  useEffect(() => {
    const prompt = searchParams.get('prompt');
    const personaId = searchParams.get('persona');
    const threadId = searchParams.get('thread');
    const preview = searchParams.get('preview');
    if (!prompt && !personaId && !threadId && !preview) {
      consumed.current = null;
      return;
    }
    const key = searchParams.toString();
    if (consumed.current === key) return;
    const persona = personaId ? personas.find((item) => item.id === personaId) : undefined;
    if (personaId && !persona) return;
    consumed.current = key;

    if (persona && persona.id !== activePersona?.id) switchPersona(persona);
    if (threadId) void selectThread(threadId);
    if (prompt) {
      if (searchParams.get('send') === '1')
        onSend(prompt, threadId ?? undefined, personaId ?? undefined);
      else onPrefill(prompt);
    }
    if (preview === 'browser' || preview === 'simulator')
      openPreview(preview, searchParams.get('previewUrl') ?? '');

    const next = new URLSearchParams(searchParams);
    for (const name of ['prompt', 'send', 'persona', 'thread', 'preview', 'previewUrl'])
      next.delete(name);
    setSearchParams(next, { replace: true });
  }, [
    searchParams,
    setSearchParams,
    personas,
    activePersona,
    switchPersona,
    selectThread,
    onPrefill,
    onSend,
    openPreview,
    threadCount,
  ]);
}
