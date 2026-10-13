import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  OverviewModuleInstance,
  OverviewModuleResult,
  OverviewScope,
  OverviewTimeRange,
} from '../../../shared/overview';
import { cleanIpcError } from './overview-format';

const AUTO_REFRESH_MS = 2 * 60_000;

export interface OverviewModuleData {
  result: OverviewModuleResult | null;
  /** True only while no result is available yet. */
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Loads one module instance. Previous rows stay visible while refreshing so
 * the board never flashes empty; the main process caches network sources.
 */
export function useOverviewModuleData(
  scope: OverviewScope,
  module: OverviewModuleInstance,
  timeRange: OverviewTimeRange,
  refreshToken: number,
): OverviewModuleData {
  const [result, setResult] = useState<OverviewModuleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const requestId = useRef(0);
  const requestKey = JSON.stringify({
    scope,
    type: module.type,
    rows: module.rows,
    config: module.config,
    timeRange,
  });
  const keyRef = useRef(requestKey);
  keyRef.current = requestKey;

  const load = useCallback(
    async (refresh: boolean) => {
      const id = ++requestId.current;
      setRefreshing(true);
      try {
        const next = await window.anvil.overview.loadModule({
          ...(JSON.parse(keyRef.current) as { scope: OverviewScope; timeRange: OverviewTimeRange }),
          module,
          refresh,
        });
        if (id !== requestId.current) return;
        setResult(next);
        setError(null);
      } catch (err) {
        if (id === requestId.current) setError(cleanIpcError(err));
      } finally {
        if (id === requestId.current) setRefreshing(false);
      }
    },
    // `module` identity changes with edits; requestKey captures what matters.
    [requestKey],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const previousToken = useRef(refreshToken);
  useEffect(() => {
    if (previousToken.current === refreshToken) return;
    previousToken.current = refreshToken;
    void load(true);
  }, [load, refreshToken]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(false);
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  return {
    result,
    loading: result === null && error === null,
    refreshing,
    error,
    refresh: () => void load(true),
  };
}

/** Re-render on an interval so relative times ("4 m ago") stay truthful. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(interval);
  }, [intervalMs]);
  return now;
}
