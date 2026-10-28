import { useCallback, useEffect, useMemo, useState } from 'react';

interface UseStoredPanelStateOptions {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  defaultCollapsed?: boolean;
}

function readStoredNumber(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback;
  const rawValue = window.localStorage.getItem(key);
  if (!rawValue) return fallback;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  const rawValue = window.localStorage.getItem(key);
  if (rawValue === null) return fallback;
  return rawValue === 'true';
}

function clamp(value: number, minWidth: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(minWidth, value));
}

export function useStoredPanelState({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  defaultCollapsed = false,
}: UseStoredPanelStateOptions) {
  const widthStorageKey = useMemo(() => `${storageKey}:width`, [storageKey]);
  const collapsedStorageKey = useMemo(() => `${storageKey}:collapsed`, [storageKey]);

  const [width, setWidthState] = useState(() =>
    clamp(readStoredNumber(widthStorageKey, defaultWidth), minWidth, maxWidth),
  );
  const [collapsed, setCollapsedState] = useState(() =>
    readStoredBoolean(collapsedStorageKey, defaultCollapsed),
  );

  const setWidth = useCallback(
    (nextWidth: number) => {
      setWidthState(clamp(nextWidth, minWidth, maxWidth));
    },
    [maxWidth, minWidth],
  );

  const setCollapsed = useCallback((nextCollapsed: boolean) => {
    setCollapsedState(nextCollapsed);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsedState((current) => !current);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(widthStorageKey, String(width));
  }, [width, widthStorageKey]);

  useEffect(() => {
    window.localStorage.setItem(collapsedStorageKey, String(collapsed));
  }, [collapsed, collapsedStorageKey]);

  return {
    width,
    setWidth,
    collapsed,
    setCollapsed,
    toggleCollapsed,
    minWidth,
    maxWidth,
  };
}
