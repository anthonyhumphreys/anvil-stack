import { useCallback, useEffect, useRef, useState } from 'react';
import type { CodexMode } from '../../../shared/types';
import {
  isChatAccessLevel,
  markAccessLevelApplied,
  readThreadAccessStore,
  reconcileThreadAccessStore,
  resolveThreadAccessLevel,
  setThreadAccessLevel,
  writeThreadAccessStore,
  type ThreadAccessStore,
} from './thread-access';

/**
 * CH1 — per-thread access state.
 *
 * The durable per-thread field (`ChatThread.codexMode` + IPC/schema) belongs
 * to the shared/main workstream; until it lands this hook persists overrides
 * renderer-side via `thread-access.ts` (localStorage keyed per workspace)
 * and pushes the effective level into `settings.codexMode` — the transport
 * the agent session actually reads — whenever the active thread changes or
 * the user picks a new level.
 */
export function useThreadAccess(
  workspaceId: string | undefined,
  activeThreadId: string | null,
  options?: {
    /**
     * ST9/J10: the per-workspace default from Settings → Workspace
     * (`WorkspaceContext.workspaceAccessDefault`). Wins over the store's
     * `defaultLevel` for threads without an explicit override.
     */
    workspaceDefault?: CodexMode | null;
    /** Called when the chip is changed on an empty thread (no threadId). */
    onWorkspaceDefaultChange?: (level: CodexMode) => void;
  },
) {
  const workspaceDefault = options?.workspaceDefault ?? null;
  const onWorkspaceDefaultChange = options?.onWorkspaceDefaultChange;
  const [store, setStore] = useState<ThreadAccessStore | null>(null);
  const appliedForThreadRef = useRef<string | null>(null);

  // Load the workspace store, then reconcile against the live settings value
  // so an external Settings → Workspace change becomes the new default.
  useEffect(() => {
    if (!workspaceId) {
      setStore(null);
      return;
    }
    let cancelled = false;
    void window.anvil.settings
      .get()
      .then((settings) => {
        if (cancelled) return;
        const live = isChatAccessLevel(settings.codexMode) ? settings.codexMode : undefined;
        setStore((current) => {
          const base = current ?? readThreadAccessStore(workspaceId);
          const next = reconcileThreadAccessStore(base, live);
          if (next !== base) writeThreadAccessStore(workspaceId, next);
          return next;
        });
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // When the active thread changes, push its resolved level into the
  // transport so the session honours the thread's override.
  useEffect(() => {
    if (!store || !activeThreadId) return;
    if (appliedForThreadRef.current === activeThreadId) return;
    appliedForThreadRef.current = activeThreadId;
    const level = resolveThreadAccessLevel(store, activeThreadId, workspaceDefault);
    void window.anvil.settings
      .update({ codexMode: level })
      .then(() => {
        setStore((current) => (current ? markAccessLevelApplied(current, level) : current));
      })
      .catch((err) => console.error('[Chat] Failed to apply thread access level:', err));
  }, [activeThreadId, store, workspaceDefault]);

  const level = resolveThreadAccessLevel(store, activeThreadId, workspaceDefault);

  const setLevel = useCallback(
    (mode: CodexMode) => {
      setStore((current) => {
        const base: ThreadAccessStore = current ?? {
          defaultLevel: mode,
          appliedLevel: null,
          threads: {},
        };
        const next = markAccessLevelApplied(setThreadAccessLevel(base, activeThreadId, mode), mode);
        if (workspaceId) writeThreadAccessStore(workspaceId, next);
        return next;
      });
      // On an empty thread the chip is choosing this workspace's default —
      // keep Settings → Workspace in sync.
      if (!activeThreadId) onWorkspaceDefaultChange?.(mode);
      void window.anvil.settings
        .update({ codexMode: mode })
        .catch((err) => console.error('[Chat] Failed to update access mode:', err));
    },
    [activeThreadId, workspaceId, onWorkspaceDefaultChange],
  );

  return {
    /** Effective access level for the active thread. */
    level,
    setLevel,
    /** Per-thread overrides for rail badges. */
    threadLevels: store?.threads,
    defaultLevel:
      workspaceDefault && isChatAccessLevel(workspaceDefault)
        ? workspaceDefault
        : store?.defaultLevel,
  };
}
